-- Money is for owners and admins only, once a workspace chooses tools per
-- person (`tenants.tools_per_person`). While the switch is off nothing here
-- changes what anyone reads or writes.
--
-- Held in three ways, so no route can slip past it:
--   1. Reads: a RESTRICTIVE policy on every Money table, ANDed with the
--      table's own policy (so later changes to that policy keep this one).
--   2. Writes: every write to Money goes through checked functions that
--      bypass row-level security, so a trigger on each Money table refuses a
--      signed-in person who can't use Money. The worker and the sync (no
--      signed-in person) are untouched.
--   3. Money's figures that are worked out from the shop's orders (which the
--      whole team reads) come back empty for anyone who can't use Money.
-- Money's settings (module `dashboard`) and the Money actions the assistant
-- files are held the same way.

-- Open to the signed-in person, or to no signed-in person at all (the
-- worker, the sync, webhooks: they run as the service role, and signed-out
-- visitors can't reach anything that asks).
create function private.tool_open(p_tenant_id uuid, p_tool text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select (select auth.uid()) is null or private.can_use_tool(p_tenant_id, p_tool);
$$;
revoke all on function private.tool_open(uuid, text) from public;
grant execute on function private.tool_open(uuid, text) to authenticated, service_role;

-- Which tool a setting belongs to, for the settings tables. Null: the
-- workspace's own (brand kit, look, assistant), open to everyone as before.
create function private.config_tool(p_module text)
returns text
language sql immutable set search_path = ''
as $$
  select case p_module
    when 'dashboard' then 'dashboard'
    when 'helpdesk' then 'helpdesk'
    when 'bookings' then 'bookings'
    when 'social' then 'social'
    when 'stock' then 'stock'
    when 'michaels' then 'stock'
    when 'shipping' then 'shipping'
    else null
  end;
$$;
revoke all on function private.config_tool(text) from public;
grant execute on function private.config_tool(text) to authenticated, service_role;

-- Refuses a write by a signed-in person who can't use the table's tool.
-- TG_ARGV[0] is the tool, or 'config' (the tool comes from the row's module)
-- or 'action' (the tool comes from the proposal's kind).
create function private.tool_write_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_row jsonb;
  v_tool text := tg_argv[0];
begin
  if (select auth.uid()) is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  v_row := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  if v_tool = 'config' then
    v_tool := private.config_tool(v_row ->> 'module');
  elsif v_tool = 'action' then
    v_tool := case when v_row ->> 'kind' like 'money.%' then 'dashboard' end;
  end if;
  if v_tool is not null
     and not private.can_use_tool((v_row ->> 'tenant_id')::uuid, v_tool) then
    raise exception 'That tool isn''t open to you in this workspace' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke all on function private.tool_write_guard() from public;

-- ---------------------------------------------------------------------------
-- Money's tables
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'financial_snapshots', 'book_expenses', 'book_invoices', 'money_book_accounts',
    'money_budgets', 'money_charge_decisions', 'money_line_entries', 'money_debt_imports',
    'money_debts', 'money_debt_balances', 'money_debt_plan_months', 'money_debt_scenarios',
    'action_proposals']
  loop
    execute format(
      'create policy "only people with Money read it" on public.%I as restrictive
         for select to authenticated
         using (tenant_id in (select private.tool_tenant_ids(array[''dashboard''])))',
      t);
    execute format(
      'create trigger tool_write_guard before insert or update or delete on public.%I
         for each row execute function private.tool_write_guard(%L)',
      t, case when t = 'action_proposals' then 'action' else 'dashboard' end);
  end loop;
end;
$$;

-- Money's settings, their versions and proposals. Other tools' settings are
-- read as before (they hold choices, not figures, and tools read each
-- other's); writing one needs its tool.
do $$
declare
  t text;
begin
  foreach t in array array['configs', 'config_versions', 'config_proposals']
  loop
    execute format(
      'create policy "only people with Money read its settings" on public.%I as restrictive
         for select to authenticated
         using (module <> ''dashboard'' or private.can_use_tool(tenant_id, ''dashboard''))',
      t);
    execute format(
      'create trigger tool_write_guard before insert or update or delete on public.%I
         for each row execute function private.tool_write_guard(''config'')',
      t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Money's figures from the shop's orders, and the rest of Money's reads:
-- exactly as before, wrapped so they come back empty for anyone who can't
-- use Money.
-- ---------------------------------------------------------------------------

create or replace function public.dashboard_sales_by_channel(p_tenant_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(channel text, order_count bigint, net_sales numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select gated.* from (
    select o.channel, count(*), coalesce(sum(o.net_sales), 0)
      from public.orders o
      where o.tenant_id = p_tenant_id
        and o.processed_at >= p_from and o.processed_at < p_to
        and o.cancelled_at is null and not o.is_test
      group by o.channel
      order by sum(o.net_sales) desc, o.channel
  ) as gated
  where (select private.tool_open(p_tenant_id, 'dashboard'))
$function$;

create or replace function public.dashboard_sales_by_period(p_tenant_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_grouping text, p_timezone text)
 RETURNS TABLE(period date, order_count bigint, net_sales numeric, cost numeric, costed_sales numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select gated.* from (
    with scoped as (
        select o.id, o.net_sales,
               date_trunc(
                 case when p_grouping in ('day', 'week', 'month') then p_grouping else 'month' end,
                 o.processed_at at time zone p_timezone
               )::date as period
        from public.orders o
        where o.tenant_id = p_tenant_id
          and o.processed_at >= p_from and o.processed_at < p_to
          and o.cancelled_at is null and not o.is_test
      ),
      line_totals as (
        select l.order_id,
               sum(l.quantity * l.unit_cost) filter (where l.unit_cost is not null) as cost,
               sum(l.quantity * l.unit_price) filter (where l.unit_cost is not null) as costed_sales
        from public.order_lines l
        where l.tenant_id = p_tenant_id and l.order_id in (select s.id from scoped s)
        group by l.order_id
      )
      select s.period, count(*), coalesce(sum(s.net_sales), 0),
             coalesce(sum(t.cost), 0), coalesce(sum(t.costed_sales), 0)
      from scoped s
      left join line_totals t on t.order_id = s.id
      group by s.period
      order by s.period
  ) as gated
  where (select private.tool_open(p_tenant_id, 'dashboard'))
$function$;

create or replace function public.dashboard_top_products(p_tenant_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer DEFAULT 5)
 RETURNS TABLE(title text, units bigint, revenue numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select gated.* from (
    select l.title, sum(l.quantity)::bigint, sum(l.quantity * l.unit_price)
      from public.order_lines l
      join public.orders o on o.id = l.order_id
      where l.tenant_id = p_tenant_id and o.tenant_id = p_tenant_id
        and o.processed_at >= p_from and o.processed_at < p_to
        and o.cancelled_at is null and not o.is_test
        and l.quantity > 0
      group by l.title
      order by sum(l.quantity * l.unit_price) desc, l.title
      limit greatest(1, least(coalesce(p_limit, 5), 50))
  ) as gated
  where (select private.tool_open(p_tenant_id, 'dashboard'))
$function$;

create or replace function public.money_account_totals(p_tenant_id uuid, p_from date, p_to date)
 RETURNS TABLE(month date, account text, cents bigint, expenses bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select gated.* from (
    select date_trunc('month', e.txn_date)::date, coalesce(nullif(btrim(e.account), ''), '(no account)'),
             sum(e.amount_cents)::bigint, count(*)
      from public.book_expenses e
      where e.tenant_id = p_tenant_id and e.removed_at is null and not e.is_move
        and e.sort is distinct from 'set_aside'
        and e.txn_date >= p_from and e.txn_date < p_to
      group by 1, 2
      order by 1, 2
  ) as gated
  where (select private.tool_open(p_tenant_id, 'dashboard'))
$function$;

create or replace function public.money_debt_current(p_tenant_id uuid)
 RETURNS TABLE(debt_id uuid, balance_cents bigint, as_of date, source text)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select gated.* from (
    select distinct on (b.debt_id) b.debt_id, b.balance_cents, b.as_of, b.source
      from public.money_debt_balances b
      join public.money_debts d on d.id = b.debt_id
      where b.tenant_id = p_tenant_id and (d.source = 'person' or b.source = 'books')
      order by b.debt_id, b.as_of desc, b.noted_at desc
  ) as gated
  where (select private.tool_open(p_tenant_id, 'dashboard'))
$function$;

create or replace function public.money_debt_payment_list(p_tenant_id uuid, p_limit integer)
 RETURNS TABLE(debt_id uuid, txn_date date, cents bigint, from_account text, kind text)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select gated.* from (
    select d.id, e.txn_date, e.amount_cents, e.from_account, e.kind
      from public.book_expenses e
      join public.money_debts d on d.tenant_id = e.tenant_id and d.left_out_at is null
      left join public.money_book_accounts a on a.id = coalesce(d.book_account_id, d.plan_account_id)
      where e.tenant_id = p_tenant_id and e.is_move and e.removed_at is null
        and case
              when a.books_id is not null and e.account_ref is not null then e.account_ref = a.books_id
              else coalesce(d.books_account, a.name) is not null
                   and lower(btrim(regexp_replace(coalesce(d.books_account, a.name), '\s+', ' ', 'g')))
                       = lower(btrim(regexp_replace(e.account, '\s+', ' ', 'g')))
            end
      order by e.txn_date desc, e.id
      limit least(greatest(coalesce(p_limit, 50), 1), 500)
  ) as gated
  where (select private.tool_open(p_tenant_id, 'dashboard'))
$function$;

create or replace function public.money_debt_payments(p_tenant_id uuid, p_from date, p_to date)
 RETURNS TABLE(debt_id uuid, month date, cents bigint, payments bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select gated.* from (
    select d.id, date_trunc('month', e.txn_date)::date, sum(e.amount_cents)::bigint, count(*)
      from public.book_expenses e
      join public.money_debts d on d.tenant_id = e.tenant_id and d.left_out_at is null
      left join public.money_book_accounts a on a.id = coalesce(d.book_account_id, d.plan_account_id)
      where e.tenant_id = p_tenant_id and e.is_move and e.removed_at is null
        and e.txn_date >= p_from and e.txn_date < p_to
        and case
              when a.books_id is not null and e.account_ref is not null then e.account_ref = a.books_id
              else coalesce(d.books_account, a.name) is not null
                   and lower(btrim(regexp_replace(coalesce(d.books_account, a.name), '\s+', ' ', 'g')))
                       = lower(btrim(regexp_replace(e.account, '\s+', ' ', 'g')))
            end
      group by 1, 2
      order by 2, 1
  ) as gated
  where (select private.tool_open(p_tenant_id, 'dashboard'))
$function$;

create or replace function public.money_expense_accounts(p_tenant_id uuid, p_since date)
 RETURNS TABLE(account_ref text, account text, recent bigint, recent_cents bigint, all_count bigint, to_sort bigint, by_account bigint, exceptions bigint, last_day date)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select gated.* from (
    select max(e.account_ref),
             (array_agg(e.account order by e.txn_date desc, e.read_at desc, e.id))[1],
             count(*) filter (where e.txn_date >= p_since),
             coalesce(sum(e.amount_cents) filter (where e.txn_date >= p_since), 0)::bigint,
             count(*),
             count(*) filter (where e.sort is null),
             count(*) filter (where e.sorted_by = 'account'),
             count(*) filter (where e.sorted_by in ('person', 'rule', 'vendor')),
             max(e.txn_date)
      from public.book_expenses e
      where e.tenant_id = p_tenant_id and e.removed_at is null and not e.is_move
      group by case when e.account_ref is not null then 'r:' || e.account_ref
                    else 'n:' || coalesce(e.account, '') end
      order by 4 desc, 2
  ) as gated
  where (select private.tool_open(p_tenant_id, 'dashboard'))
$function$;

create or replace function public.money_expense_months(p_tenant_id uuid)
 RETURNS TABLE(month text, to_sort bigint, to_sort_cents bigint, all_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select gated.* from (
    select to_char(e.txn_date, 'YYYY-MM'),
             count(*) filter (where e.sort is null),
             coalesce(sum(e.amount_cents) filter (where e.sort is null), 0)::bigint,
             count(*)
      from public.book_expenses e
      where e.tenant_id = p_tenant_id and e.removed_at is null and not e.is_move
      group by 1
      order by 1 desc
  ) as gated
  where (select private.tool_open(p_tenant_id, 'dashboard'))
$function$;

create or replace function public.money_expense_totals(p_tenant_id uuid, p_from date, p_to date, p_grouping text DEFAULT 'month'::text)
 RETURNS TABLE(period date, sort text, line_id text, split jsonb, cents bigint, expenses bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select gated.* from (
    select date_trunc(
               case when p_grouping in ('day', 'week', 'month') then p_grouping else 'month' end,
               e.txn_date)::date,
             e.sort, e.line_id, e.split, sum(e.amount_cents)::bigint, count(*)
      from public.book_expenses e
      where e.tenant_id = p_tenant_id and e.removed_at is null and not e.is_move
        and e.txn_date >= p_from and e.txn_date < p_to
      group by 1, 2, 3, 4
      order by 1, 2 nulls first, 3 nulls first, 4::text nulls first
  ) as gated
  where (select private.tool_open(p_tenant_id, 'dashboard'))
$function$;

create or replace function public.money_invoice_accounts(p_tenant_id uuid, p_since date)
 RETURNS TABLE(account_ref text, account text, invoices bigint, cents bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select gated.* from (
    select l ->> 'account_ref', l ->> 'account', count(distinct b.id),
             sum(case when (l ->> 'cents') ~ '^-?[0-9]{1,12}$' then (l ->> 'cents')::bigint
                      else 0 end)::bigint
      from public.book_invoices b, jsonb_array_elements(b.lines) l
      where b.tenant_id = p_tenant_id and b.removed_at is null and b.txn_date >= p_since
      group by 1, 2
      order by 4 desc, 2 nulls last, 1 nulls last
      limit 200
  ) as gated
  where (select private.tool_open(p_tenant_id, 'dashboard'))
$function$;

create or replace function public.money_invoice_counts(p_tenant_id uuid, p_today date)
 RETURNS TABLE(status text, invoices bigint, total_cents bigint, balance_cents bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select gated.* from (
    select private.invoice_status(b.balance_cents, b.due_date, p_today),
             count(*), coalesce(sum(b.total_cents), 0)::bigint,
             coalesce(sum(b.balance_cents), 0)::bigint
      from public.book_invoices b
      where b.tenant_id = p_tenant_id and b.removed_at is null
      group by 1
      order by 1
  ) as gated
  where (select private.tool_open(p_tenant_id, 'dashboard'))
$function$;

create or replace function public.money_invoice_list(p_tenant_id uuid, p_today date, p_status text DEFAULT 'all'::text, p_q text DEFAULT NULL::text, p_account_refs text[] DEFAULT NULL::text[], p_account_names text[] DEFAULT NULL::text[], p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, doc_number text, customer text, txn_date date, due_date date, total_cents bigint, balance_cents bigint, net_cents bigint, memo text, lines jsonb, status text, total_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select gated.* from (
    select b.id, b.doc_number, b.customer, b.txn_date, b.due_date, b.total_cents,
             b.balance_cents, b.net_cents, b.memo, b.lines,
             private.invoice_status(b.balance_cents, b.due_date, p_today),
             count(*) over ()
      from public.book_invoices b
      where b.tenant_id = p_tenant_id and b.removed_at is null
        and (coalesce(p_status, 'all') = 'all'
             or private.invoice_status(b.balance_cents, b.due_date, p_today) = p_status)
        and (p_q is null or p_q = '' or b.search_text like p_q escape '\')
        and (p_account_refs is null and p_account_names is null
             or exists (
               select 1 from jsonb_array_elements(b.lines) l
               where (l ->> 'account_ref') = any (coalesce(p_account_refs, '{}'::text[]))
                  or (l ->> 'account') = any (coalesce(p_account_names, '{}'::text[]))))
      order by b.txn_date desc, b.id
      limit least(greatest(coalesce(p_limit, 50), 1), 5000)
      offset greatest(coalesce(p_offset, 0), 0)
  ) as gated
  where (select private.tool_open(p_tenant_id, 'dashboard'))
$function$;

create or replace function public.money_invoice_revenue(p_tenant_id uuid, p_from date, p_to date, p_grouping text DEFAULT 'month'::text)
 RETURNS TABLE(period date, account_ref text, account text, cents bigint, invoices bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select gated.* from (
    select date_trunc(
               case when p_grouping in ('day', 'week', 'month') then p_grouping else 'month' end,
               b.txn_date)::date,
             l ->> 'account_ref', l ->> 'account',
             sum(case when (l ->> 'cents') ~ '^-?[0-9]{1,12}$' then (l ->> 'cents')::bigint
                      else 0 end)::bigint,
             count(distinct b.id)
      from public.book_invoices b, jsonb_array_elements(b.lines) l
      where b.tenant_id = p_tenant_id and b.removed_at is null and b.balance_cents <= 0
        and b.txn_date >= p_from and b.txn_date < p_to
      group by 1, 2, 3
      order by 1, 2 nulls first, 3 nulls first
  ) as gated
  where (select private.tool_open(p_tenant_id, 'dashboard'))
$function$;

create or replace function public.money_line_item_costs(p_tenant_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(order_tags text[], product_external_id text, product_tags text[], product_type text, workshop boolean, cost_cents bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select gated.* from (
    with linked as (
        select distinct sv.shop_product_id
        from public.services sv
        where sv.tenant_id = p_tenant_id and sv.shop_product_id is not null
      )
      select o.tags, l.product_external_id, pr.tags, pr.product_type,
             coalesce(l.product_external_id in (select k.shop_product_id from linked k), false),
             round(sum(l.quantity * l.unit_cost) * 100)::bigint
      from public.orders o
      join public.order_lines l on l.order_id = o.id and l.tenant_id = p_tenant_id
      left join public.products pr
        on pr.tenant_id = p_tenant_id and pr.provider = o.provider
       and pr.external_id = l.product_external_id
      where o.tenant_id = p_tenant_id
        and o.processed_at >= p_from and o.processed_at < p_to
        and o.cancelled_at is null and not o.is_test
        and l.unit_cost is not null and l.quantity > 0
      group by 1, 2, 3, 4, 5
      order by 2 nulls first, 1 nulls first, 3 nulls first, 4 nulls first, 5
  ) as gated
  where (select private.tool_open(p_tenant_id, 'dashboard'))
$function$;

create or replace function public.money_line_revenue(p_tenant_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_grouping text, p_timezone text, p_figure text DEFAULT 'net_sales'::text, p_by_class_date boolean DEFAULT false, p_dated_only boolean DEFAULT false)
 RETURNS TABLE(period date, order_tags text[], product_external_id text, product_tags text[], product_type text, workshop boolean, dated boolean, revenue_cents bigint, units bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select gated.* from (
    with linked as (
        select distinct sv.shop_product_id
        from public.services sv
        where sv.tenant_id = p_tenant_id and sv.shop_product_id is not null
      ),
      candidates as (
        select o.id, o.provider, o.external_id, o.processed_at, o.tags,
               private.money_order_cents(o.net_sales, o.total, false, false, o.financial_status,
                                         p_figure) as revenue
        from public.orders o
        where o.tenant_id = p_tenant_id
          and o.cancelled_at is null and not o.is_test
          and o.processed_at < p_to
          and (
            o.processed_at >= p_from
            -- A class bought before the window can still run inside it.
            or ((p_by_class_date or p_dated_only)
                and o.processed_at >= p_from - interval '2 years'
                and exists (
                  select 1 from public.order_lines l
                  where l.tenant_id = p_tenant_id and l.order_id = o.id
                    and (l.session_ref is not null or l.class_date is not null
                         or l.product_external_id in (select k.shop_product_id from linked k))))
          )
      ),
      items as (
        select c.id as order_id, c.provider, c.external_id as order_ext, c.processed_at, c.tags,
               c.revenue, l.external_id as line_ext, l.product_external_id, l.session_ref,
               l.class_date, greatest(round(l.quantity * l.unit_price * 100), 0)::numeric as weight,
               greatest(l.quantity, 0)::bigint as units
        from candidates c
        join public.order_lines l on l.order_id = c.id and l.tenant_id = p_tenant_id
      ),
      weights as (
        select i.order_id, sum(i.weight) as total_weight from items i group by i.order_id
      ),
      parts as (
        select i.*, w.total_weight
        from items i
        join weights w on w.order_id = i.order_id
        where w.total_weight > 0
        union all
        -- No priced items: the order's revenue stays whole, with no product.
        select c.id, c.provider, c.external_id, c.processed_at, c.tags, c.revenue, null, null, null,
               null, 1, coalesce((select sum(i.units) from items i where i.order_id = c.id), 0), 1
        from candidates c
        where not exists (select 1 from weights w where w.order_id = c.id and w.total_weight > 0)
      ),
      shares as (
        select p.*,
               div(abs(p.revenue)::numeric * p.weight, p.total_weight) as base,
               mod(abs(p.revenue)::numeric * p.weight, p.total_weight) as remainder
        from parts p
      ),
      ranked as (
        select s.*,
               abs(s.revenue) - sum(s.base) over (partition by s.order_id) as left_over,
               row_number() over (partition by s.order_id
                                  order by s.remainder desc, s.line_ext nulls last) as place
        from shares s
      ),
      allocated as (
        select r.*,
               (sign(r.revenue) * (r.base + case when r.place <= r.left_over then 1 else 0 end))::bigint
                 as cents
        from ranked r
      ),
      dated as (
        select a.*,
               case when p_by_class_date or p_dated_only then coalesce(
                 (select s.starts_at from public.sessions s
                  where s.tenant_id = p_tenant_id and s.id = a.session_ref),
                 (select min(s.starts_at)
                  from public.bookings b
                  join public.sessions s on s.id = b.session_id and s.tenant_id = p_tenant_id
                  join public.services sv on sv.id = s.service_id and sv.tenant_id = p_tenant_id
                  where b.tenant_id = p_tenant_id and b.shop_order_id = a.order_ext
                    and a.product_external_id is not null
                    and sv.shop_product_id = a.product_external_id),
                 (a.class_date::timestamp at time zone p_timezone)
               ) end as class_at
        from allocated a
      ),
      attributed as (
        select d.*, coalesce(d.class_at, d.processed_at) as counted_at from dated d
      )
      select date_trunc(
               case when p_grouping in ('day', 'week', 'month') then p_grouping else 'month' end,
               x.counted_at at time zone p_timezone
             )::date,
             x.tags, x.product_external_id, pr.tags, pr.product_type,
             coalesce(x.product_external_id in (select k.shop_product_id from linked k), false),
             x.class_at is not null,
             sum(x.cents)::bigint, sum(x.units)::bigint
      from attributed x
      left join public.products pr
        on pr.tenant_id = p_tenant_id and pr.provider = x.provider
       and pr.external_id = x.product_external_id
      where x.counted_at >= p_from and x.counted_at < p_to
        and (not p_dated_only or x.class_at is not null)
      group by 1, 2, 3, 4, 5, 6, 7
      order by 1, 3 nulls first, 2 nulls first, 4 nulls first, 5 nulls first, 6, 7
  ) as gated
  where (select private.tool_open(p_tenant_id, 'dashboard'))
$function$;

create or replace function public.money_move_accounts(p_tenant_id uuid)
 RETURNS TABLE(account text, moves bigint, last_date date)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select gated.* from (
    select e.account, count(*), max(e.txn_date)
      from public.book_expenses e
      where e.tenant_id = p_tenant_id and e.is_move and e.removed_at is null
        and e.account is not null
      group by e.account
      order by max(e.txn_date) desc
      limit 200
  ) as gated
  where (select private.tool_open(p_tenant_id, 'dashboard'))
$function$;

create or replace function public.money_order_list(p_tenant_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_status text DEFAULT NULL::text, p_q text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS TABLE(id uuid, name text, processed_at timestamp with time zone, financial_status text, tags text[], net_sales numeric, total numeric, items jsonb, total_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select gated.* from (
    with linked as (
        select distinct sv.shop_product_id
        from public.services sv
        where sv.tenant_id = p_tenant_id and sv.shop_product_id is not null
      ),
      picked as (
        select o.*
        from public.orders o
        where o.tenant_id = p_tenant_id
          and o.processed_at >= p_from and o.processed_at < p_to
          and o.cancelled_at is null and not o.is_test
          and (p_status is null or p_status = '' or upper(coalesce(o.financial_status, '')) = upper(p_status))
          and (p_q is null or p_q = ''
               or lower(coalesce(o.name, '')) like p_q escape '\'
               or exists (select 1 from unnest(coalesce(o.tags, '{}'::text[])) t
                          where lower(t) like p_q escape '\'))
      )
      select o.id, o.name, o.processed_at, o.financial_status, o.tags, o.net_sales, o.total,
             coalesce((
               select jsonb_agg(jsonb_build_object(
                        'product_tags', pr.tags,
                        'product_type', pr.product_type,
                        'workshop', coalesce(l.product_external_id in (select k.shop_product_id from linked k), false)))
               from public.order_lines l
               left join public.products pr
                 on pr.tenant_id = p_tenant_id and pr.provider = o.provider
                and pr.external_id = l.product_external_id
               where l.order_id = o.id and l.tenant_id = p_tenant_id), '[]'::jsonb),
             count(*) over ()
      from picked o
      order by o.processed_at desc, o.id
      limit least(greatest(coalesce(p_limit, 50), 1), 2000)
      offset greatest(coalesce(p_offset, 0), 0)
  ) as gated
  where (select private.tool_open(p_tenant_id, 'dashboard'))
$function$;

create or replace function public.money_recent_order_lines(p_tenant_id uuid, p_from timestamp with time zone)
 RETURNS TABLE(order_id uuid, order_tags text[], product_external_id text, product_tags text[], product_type text, workshop boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select gated.* from (
    with linked as (
        select distinct sv.shop_product_id
        from public.services sv
        where sv.tenant_id = p_tenant_id and sv.shop_product_id is not null
      )
      select o.id, o.tags, l.product_external_id, pr.tags, pr.product_type,
             coalesce(l.product_external_id in (select k.shop_product_id from linked k), false)
      from public.orders o
      left join public.order_lines l on l.order_id = o.id and l.tenant_id = p_tenant_id
      left join public.products pr
        on pr.tenant_id = p_tenant_id and pr.provider = o.provider
       and pr.external_id = l.product_external_id
      where o.tenant_id = p_tenant_id and o.processed_at >= p_from
        and o.cancelled_at is null and not o.is_test
      order by o.processed_at desc, o.id, l.external_id nulls first
  ) as gated
  where (select private.tool_open(p_tenant_id, 'dashboard'))
$function$;

create or replace function public.money_sales_by_channel(p_tenant_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_figure text)
 RETURNS TABLE(channel text, order_count bigint, revenue numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select gated.* from (
    select o.channel,
             count(*) filter (where p_figure <> 'order_totals'
                               or upper(coalesce(o.financial_status, '')) not in ('REFUNDED', 'VOIDED')),
             round(coalesce(sum(private.money_order_cents(o.net_sales, o.total, false, false,
                                                          o.financial_status, p_figure)), 0) / 100.0, 2)
      from public.orders o
      where o.tenant_id = p_tenant_id
        and o.processed_at >= p_from and o.processed_at < p_to
        and o.cancelled_at is null and not o.is_test
      group by o.channel
      order by 3 desc, o.channel
  ) as gated
  where (select private.tool_open(p_tenant_id, 'dashboard'))
$function$;

create or replace function public.money_sales_by_period(p_tenant_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_grouping text, p_timezone text, p_figure text)
 RETURNS TABLE(period date, order_count bigint, revenue numeric, cost numeric, costed_sales numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select gated.* from (
    with scoped as (
        select o.id,
               private.money_order_cents(o.net_sales, o.total, o.cancelled_at is not null, o.is_test,
                                         o.financial_status, p_figure) as cents,
               p_figure <> 'order_totals'
                 or upper(coalesce(o.financial_status, '')) not in ('REFUNDED', 'VOIDED') as counted,
               date_trunc(
                 case when p_grouping in ('day', 'week', 'month') then p_grouping else 'month' end,
                 o.processed_at at time zone p_timezone
               )::date as period
        from public.orders o
        where o.tenant_id = p_tenant_id
          and o.processed_at >= p_from and o.processed_at < p_to
          and o.cancelled_at is null and not o.is_test
      ),
      line_totals as (
        select l.order_id,
               sum(l.quantity * l.unit_cost) filter (where l.unit_cost is not null) as cost,
               sum(l.quantity * l.unit_price) filter (where l.unit_cost is not null) as costed_sales
        from public.order_lines l
        where l.tenant_id = p_tenant_id and l.order_id in (select s.id from scoped s)
        group by l.order_id
      )
      select s.period, count(*) filter (where s.counted), round(coalesce(sum(s.cents), 0) / 100.0, 2),
             coalesce(sum(t.cost), 0), coalesce(sum(t.costed_sales), 0)
      from scoped s
      left join line_totals t on t.order_id = s.id
      group by s.period
      order by s.period
  ) as gated
  where (select private.tool_open(p_tenant_id, 'dashboard'))
$function$;

create or replace function public.money_shipping_by_month(p_tenant_id uuid, p_from timestamp with time zone, p_to timestamp with time zone, p_timezone text)
 RETURNS TABLE(month date, orders bigint, collected_cents bigint, cost_cents bigint, costed bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select gated.* from (
    with per_order as (
        select so.order_id,
               min(s.shipped_at) as first_at,
               round(coalesce(sum(s.cost), 0) * 100)::bigint as cost_cents,
               count(s.cost) as costed
        from public.shipments s
        join public.shipping_orders so on so.id = s.shipping_order_id and so.tenant_id = p_tenant_id
        where s.tenant_id = p_tenant_id and s.voided_at is null
        group by so.order_id
      )
      select date_trunc('month', po.first_at at time zone p_timezone)::date,
             count(*)::bigint,
             round(coalesce(sum(o.total_shipping), 0) * 100)::bigint,
             coalesce(sum(po.cost_cents), 0)::bigint,
             count(*) filter (where po.costed > 0)
      from per_order po
      join public.orders o on o.id = po.order_id and o.tenant_id = p_tenant_id
      where po.first_at >= p_from and po.first_at < p_to
        and o.cancelled_at is null and not o.is_test
      group by 1
      order by 1
  ) as gated
  where (select private.tool_open(p_tenant_id, 'dashboard'))
$function$;
