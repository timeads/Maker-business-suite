-- Money: expenses read from the books, sorted into the business's own lines.
--
-- The QuickBooks sync (read-only, the accounting scope a workspace already
-- granted) reads purchases, bills, the debit side of journal entries,
-- transfers and card payments since the first of January last year, and
-- hands them to `file_book_expenses` for one named workspace. Each lands on
-- its own row, keyed by the books' own kind and id, so reading again changes
-- it in place; a record the books no longer hold is marked removed by
-- `close_book_expenses` after a complete read. Transfers and card payments
-- are moves between the business's own accounts: kept, marked, never sorted
-- and never counted (they matter to the later debt work).
--
-- Sorting: one line, a split across lines by whole percents, shared
-- (overhead), or set aside (not a business expense). A person's choice
-- (`sort_book_expenses`) always wins; the workspace's rules (a config,
-- `dashboard` / `expenses`, evaluated in code) only ever sort an expense
-- nobody has sorted, and never one a person put back in the inbox. AI only
-- ever suggests.
--
-- The whole team reads it, like the rest of Money (`financial_snapshots`);
-- owners and admins sort, as they are the ones who change Money.

create table public.book_expenses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  provider text not null check (provider = 'quickbooks'),
  entity text not null
    check (entity in ('Purchase', 'Bill', 'JournalEntry', 'Transfer', 'CreditCardPayment')),
  external_id text not null check (char_length(external_id) between 1 and 60),
  kind text not null check (kind in ('purchase', 'bill', 'journal', 'transfer', 'card_payment')),
  -- Money moving between the business's own accounts: never an expense.
  is_move boolean generated always as (kind in ('transfer', 'card_payment')) stored,
  payment_type text check (char_length(payment_type) <= 40),
  txn_date date not null,
  amount_cents bigint not null check (abs(amount_cents) <= 100000000000),
  account text check (char_length(account) <= 200),
  payee text check (char_length(payee) <= 200),
  memo text not null default '' check (char_length(memo) <= 300),
  from_account text check (char_length(from_account) <= 200),
  lines jsonb not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array'),
  -- Payee, accounts, memo and line descriptions in small letters, for search.
  search_text text not null default '',
  last_run uuid,
  read_at timestamptz not null default now(),
  removed_at timestamptz,

  sort text check (sort in ('line', 'split', 'shared', 'set_aside')),
  line_id text check (char_length(line_id) <= 40),
  split jsonb,
  sorted_by text check (sorted_by in ('person', 'rule', 'vendor')),
  sorted_rule text check (char_length(sorted_rule) <= 40),
  sorted_member uuid references auth.users (id) on delete set null,
  sorted_at timestamptz,
  -- A person put it back in the inbox: rules leave it alone from then on.
  rules_off boolean not null default false,
  -- What a rule, a payee default or Claude suggests; only a person applies it.
  suggested jsonb check (suggested is null or jsonb_typeof(suggested) = 'object'),

  unique (tenant_id, provider, entity, external_id),
  constraint book_expenses_sorted_by_someone check ((sort is null) = (sorted_by is null)),
  constraint book_expenses_line_when_line check ((sort = 'line') = (line_id is not null)),
  constraint book_expenses_split_when_split check ((sort = 'split') = (split is not null)),
  constraint book_expenses_moves_unsorted
    check (kind not in ('transfer', 'card_payment') or sort is null)
);

create index book_expenses_by_date_idx on public.book_expenses (tenant_id, txn_date desc)
  where removed_at is null and not is_move;
create index book_expenses_to_sort_idx on public.book_expenses (tenant_id)
  where sort is null and removed_at is null and not is_move;

alter table public.book_expenses enable row level security;
create policy "members read their book expenses" on public.book_expenses
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));
revoke all on public.book_expenses from public, anon, authenticated, service_role;
grant select on public.book_expenses to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The workspace's business lines (Settings → Money), and whether a way of
-- sorting names only those. A split is whole percents, at least two lines,
-- adding up to 100.
-- ---------------------------------------------------------------------------

create function private.money_line_ids(p_tenant_id uuid)
returns text[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(l ->> 'id'), '{}'::text[])
  from public.configs c,
       jsonb_array_elements(
         case when jsonb_typeof(c.body -> 'lines') = 'array' then c.body -> 'lines'
              else '[]'::jsonb end) l
  where c.tenant_id = p_tenant_id and c.module = 'dashboard' and c.key = 'revenue';
$$;
revoke all on function private.money_line_ids(uuid) from public;

create function private.money_sort_ok(
  p_tenant_id uuid,
  p_sort text,
  p_line text,
  p_split jsonb
)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_ids text[] := private.money_line_ids(p_tenant_id);
  v_total int := 0;
  v_count int := 0;
  e record;
begin
  if p_sort in ('shared', 'set_aside') then
    return p_line is null and p_split is null;
  elsif p_sort = 'line' then
    return p_split is null and p_line is not null and p_line = any (v_ids);
  elsif p_sort = 'split' then
    if p_line is not null or p_split is null or jsonb_typeof(p_split) <> 'object' then
      return false;
    end if;
    for e in select key, value from jsonb_each(p_split) loop
      if not (e.key = any (v_ids)) or jsonb_typeof(e.value) <> 'number'
         or (e.value #>> '{}') !~ '^[0-9]{1,3}$'
         or (e.value #>> '{}')::int not between 1 and 100 then
        return false;
      end if;
      v_total := v_total + (e.value #>> '{}')::int;
      v_count := v_count + 1;
    end loop;
    return v_count >= 2 and v_total = 100;
  end if;
  return false;
end;
$$;
revoke all on function private.money_sort_ok(uuid, text, text, jsonb) from public;

-- A suggestion as stored: a valid way of sorting, where it came from and why.
create function private.money_clean_suggestion(p_tenant_id uuid, p_suggest jsonb)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case
    when p_suggest is null or jsonb_typeof(p_suggest) <> 'object' then null
    when coalesce(p_suggest ->> 'source', '') not in ('rule', 'vendor', 'ai') then null
    when not private.money_sort_ok(p_tenant_id, p_suggest ->> 'sort',
                                   nullif(p_suggest ->> 'line', ''),
                                   case when jsonb_typeof(p_suggest -> 'split') = 'object'
                                        then p_suggest -> 'split' end) then null
    else jsonb_strip_nulls(jsonb_build_object(
      'sort', p_suggest ->> 'sort',
      'line', nullif(p_suggest ->> 'line', ''),
      'split', case when jsonb_typeof(p_suggest -> 'split') = 'object'
                    then p_suggest -> 'split' end,
      'source', p_suggest ->> 'source',
      'rule', left(nullif(p_suggest ->> 'rule', ''), 40),
      'reason', left(coalesce(p_suggest ->> 'reason', ''), 200),
      'sure', case when p_suggest ->> 'sure' in ('high', 'low') then p_suggest ->> 'sure' end,
      'at', now()))
  end;
$$;
revoke all on function private.money_clean_suggestion(uuid, jsonb) from public;

-- Sorts one unsorted expense by a rule or a payee default, or notes a
-- suggestion on it. Never touches one a person sorted; never sorts one a
-- person put back in the inbox. Returns 'sorted', 'suggested' or null.
create function private.money_rule_decision(
  p_tenant_id uuid,
  p_id uuid,
  p_auto jsonb,
  p_suggest jsonb
)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.book_expenses;
  v_suggest jsonb;
begin
  select * into v_row from public.book_expenses e
  where e.id = p_id and e.tenant_id = p_tenant_id
  for update;
  if not found or v_row.sort is not null or v_row.is_move or v_row.removed_at is not null then
    return null;
  end if;
  if p_auto is not null and jsonb_typeof(p_auto) = 'object' and not v_row.rules_off
     and p_auto ->> 'source' in ('rule', 'vendor')
     and private.money_sort_ok(p_tenant_id, p_auto ->> 'sort', nullif(p_auto ->> 'line', ''),
                               case when jsonb_typeof(p_auto -> 'split') = 'object'
                                    then p_auto -> 'split' end) then
    update public.book_expenses e
    set sort = p_auto ->> 'sort',
        line_id = nullif(p_auto ->> 'line', ''),
        split = case when jsonb_typeof(p_auto -> 'split') = 'object' then p_auto -> 'split' end,
        sorted_by = p_auto ->> 'source',
        sorted_rule = left(nullif(p_auto ->> 'rule', ''), 40),
        sorted_member = null,
        sorted_at = now(),
        suggested = null
    where e.id = p_id;
    return 'sorted';
  end if;
  v_suggest := private.money_clean_suggestion(p_tenant_id, p_suggest);
  if v_suggest is not null then
    update public.book_expenses e set suggested = v_suggest where e.id = p_id;
    return 'suggested';
  end if;
  return null;
end;
$$;
revoke all on function private.money_rule_decision(uuid, uuid, jsonb, jsonb) from public;

-- ---------------------------------------------------------------------------
-- The sync (service role, one named workspace)
-- ---------------------------------------------------------------------------

-- Files what one read of the books found, in batches:
--   [{"entity", "external_id", "kind", "payment_type", "date", "amount_cents",
--     "account", "payee", "memo", "from_account", "lines": [...],
--     "auto": {sort, line, split, source, rule}?, "suggest": {...}?}, ...]
-- Facts are written over what was stored (a changed record follows the
-- books); the sorting is not. `auto` sorts an expense nobody has sorted;
-- `suggest` replaces a rule's earlier suggestion but keeps Claude's.
create function public.file_book_expenses(
  p_tenant_id uuid,
  p_provider text,
  p_run uuid,
  p_rows jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  v_id uuid;
  v_sort text;
  v_move boolean;
  v_search text;
  v_lines jsonb;
  v_result text;
  v_read int := 0;
  v_bad int := 0;
  v_sorted int := 0;
  v_suggested int := 0;
begin
  if p_provider is distinct from 'quickbooks' then
    raise exception 'Only the books connection files expenses' using errcode = '22023';
  end if;
  if p_run is null or jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 1000 then
    raise exception 'Bad rows' using errcode = '22023';
  end if;

  for r in
    select btrim(coalesce(i.entity, '')) as entity,
           btrim(coalesce(i.external_id, '')) as external_id,
           i.kind, left(nullif(btrim(i.payment_type), ''), 40) as payment_type,
           i.date as day, i.amount_cents,
           left(nullif(btrim(i.account), ''), 200) as account,
           left(nullif(btrim(i.payee), ''), 200) as payee,
           left(btrim(coalesce(i.memo, '')), 300) as memo,
           left(nullif(btrim(i.from_account), ''), 200) as from_account,
           i.lines, i.auto, i.suggest
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as i(
      entity text, external_id text, kind text, payment_type text, date date,
      amount_cents bigint, account text, payee text, memo text, from_account text,
      lines jsonb, auto jsonb, suggest jsonb)
  loop
    v_read := v_read + 1;
    if r.entity not in ('Purchase', 'Bill', 'JournalEntry', 'Transfer', 'CreditCardPayment')
       or r.external_id = '' or char_length(r.external_id) > 60
       or r.kind is null
       or r.kind not in ('purchase', 'bill', 'journal', 'transfer', 'card_payment')
       or r.day is null or r.amount_cents is null or abs(r.amount_cents) > 100000000000 then
      v_bad := v_bad + 1;
      continue;
    end if;
    -- Each line kept small: its account, amount and description.
    select coalesce(jsonb_agg(jsonb_build_object(
             'account', left(nullif(btrim(l ->> 'account'), ''), 200),
             'amount_cents', case when (l ->> 'amount_cents') ~ '^-?[0-9]{1,12}$'
                                  then (l ->> 'amount_cents')::bigint else 0 end,
             'description', left(btrim(coalesce(l ->> 'description', '')), 300))), '[]'::jsonb)
      into v_lines
    from (select l from jsonb_array_elements(
            case when jsonb_typeof(r.lines) = 'array' then r.lines else '[]'::jsonb end) l
          where jsonb_typeof(l) = 'object' limit 50) x;
    select lower(concat_ws(' ', r.payee, r.account, nullif(r.memo, ''), r.from_account,
                           string_agg(concat_ws(' ', l ->> 'account', l ->> 'description'), ' ')))
      into v_search
    from jsonb_array_elements(v_lines) l;

    insert into public.book_expenses as e
      (tenant_id, provider, entity, external_id, kind, payment_type, txn_date, amount_cents,
       account, payee, memo, from_account, lines, search_text, last_run, read_at)
    values
      (p_tenant_id, p_provider, r.entity, r.external_id, r.kind, r.payment_type, r.day,
       r.amount_cents, r.account, r.payee, r.memo, r.from_account, v_lines,
       left(coalesce(v_search, ''), 4000), p_run, now())
    on conflict (tenant_id, provider, entity, external_id) do update
      set kind = excluded.kind, payment_type = excluded.payment_type,
          txn_date = excluded.txn_date, amount_cents = excluded.amount_cents,
          account = excluded.account, payee = excluded.payee, memo = excluded.memo,
          from_account = excluded.from_account, lines = excluded.lines,
          search_text = excluded.search_text, last_run = excluded.last_run,
          read_at = excluded.read_at, removed_at = null
    returning e.id, e.sort, e.is_move into v_id, v_sort, v_move;

    if v_sort is null and not v_move then
      if r.auto is null and r.suggest is null then
        -- Nothing matches any more: drop a rule's old suggestion, keep Claude's.
        update public.book_expenses e set suggested = null
        where e.id = v_id and e.suggested is not null
          and coalesce(e.suggested ->> 'source', '') <> 'ai';
      else
        v_result := private.money_rule_decision(p_tenant_id, v_id, r.auto, r.suggest);
        if v_result = 'sorted' then v_sorted := v_sorted + 1;
        elsif v_result = 'suggested' then v_suggested := v_suggested + 1;
        end if;
      end if;
    end if;
  end loop;
  return jsonb_build_object('read', v_read, 'bad', v_bad, 'sorted', v_sorted,
                            'suggested', v_suggested);
end;
$$;

-- After a complete read of these kinds since a day: whatever of them dated
-- from that day on that this read didn't see is gone from the books. Its
-- row stays (with whatever a person chose) but no longer counts anywhere.
create function public.close_book_expenses(
  p_tenant_id uuid,
  p_provider text,
  p_run uuid,
  p_since date,
  p_entities text[]
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  if p_run is null or p_since is null then
    raise exception 'Bad read' using errcode = '22023';
  end if;
  update public.book_expenses e
  set removed_at = now()
  where e.tenant_id = p_tenant_id and e.provider = p_provider
    and e.entity = any (coalesce(p_entities, '{}'::text[]))
    and e.txn_date >= p_since
    and e.last_run is distinct from p_run
    and e.removed_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Only the sync calls these. It reads expenses only for a workspace whose
-- plan has Money (`moduleOpen()` in the worker).
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.file_book_expenses(uuid, text, uuid, jsonb)',
    'public.close_book_expenses(uuid, text, uuid, date, text[])'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- What owners and admins do
-- ---------------------------------------------------------------------------

-- Sorts the ticked expenses one way (or puts them back in the inbox with
-- 'none'). A person's choice: no rule or later sync changes it. Moves and
-- records gone from the books are left alone. Returns how many changed.
create function public.sort_book_expenses(
  p_tenant_id uuid,
  p_ids uuid[],
  p_sort text,
  p_line text default null,
  p_split jsonb default null
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  perform private.require_manager(p_tenant_id);
  if p_ids is null or cardinality(p_ids) = 0 or cardinality(p_ids) > 500 then
    raise exception 'Choose between 1 and 500 expenses' using errcode = '22023';
  end if;
  if p_sort = 'none' then
    update public.book_expenses e
    set sort = null, line_id = null, split = null, sorted_by = null, sorted_rule = null,
        sorted_member = null, sorted_at = null, rules_off = true
    where e.tenant_id = p_tenant_id and e.id = any (p_ids)
      and not e.is_move and e.removed_at is null and e.sort is not null;
  else
    if not private.money_sort_ok(p_tenant_id, p_sort, p_line, p_split) then
      raise exception 'That isn''t a way these can be sorted' using errcode = '22023';
    end if;
    update public.book_expenses e
    set sort = p_sort, line_id = p_line, split = p_split, sorted_by = 'person',
        sorted_rule = null, sorted_member = (select auth.uid()), sorted_at = now(),
        suggested = null
    where e.tenant_id = p_tenant_id and e.id = any (p_ids)
      and not e.is_move and e.removed_at is null;
  end if;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- "Apply my rules to what's waiting" and "Suggest lines for these": the
-- decisions worked out in code, for expenses by id:
--   [{"id", "auto": {...}?, "suggest": {...}?}, ...]
-- The same rules as the sync: only unsorted expenses, never one a person put
-- back; Claude's answers only ever arrive as suggestions.
create function public.note_expense_decisions(p_tenant_id uuid, p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  v_result text;
  v_sorted int := 0;
  v_suggested int := 0;
begin
  perform private.require_manager(p_tenant_id);
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 1000 then
    raise exception 'Bad rows' using errcode = '22023';
  end if;
  for r in
    select i.id, i.auto, i.suggest
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as i(id uuid, auto jsonb, suggest jsonb)
    where i.id is not null
  loop
    v_result := private.money_rule_decision(
      p_tenant_id, r.id,
      case when r.auto ->> 'source' in ('rule', 'vendor') then r.auto end,
      r.suggest);
    if v_result = 'sorted' then v_sorted := v_sorted + 1;
    elsif v_result = 'suggested' then v_suggested := v_suggested + 1;
    end if;
  end loop;
  return jsonb_build_object('sorted', v_sorted, 'suggested', v_suggested);
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.sort_book_expenses(uuid, uuid[], text, text, jsonb)',
    'public.note_expense_decisions(uuid, jsonb)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reading, as the member (row-level security decides what is seen)
-- ---------------------------------------------------------------------------

-- Each month with expenses: how many are still to sort, their total, and
-- how many there are in all. For the inbox's month picker.
create function public.money_expense_months(p_tenant_id uuid)
returns table (month text, to_sort bigint, to_sort_cents bigint, all_count bigint)
language sql stable set search_path = ''
as $$
  select to_char(e.txn_date, 'YYYY-MM'),
         count(*) filter (where e.sort is null),
         coalesce(sum(e.amount_cents) filter (where e.sort is null), 0)::bigint,
         count(*)
  from public.book_expenses e
  where e.tenant_id = p_tenant_id and e.removed_at is null and not e.is_move
  group by 1
  order by 1 desc;
$$;

-- Expenses between two days (`p_to` not included), added up per period and
-- per way of sorting. The split itself is decided in code, to the cent.
create function public.money_expense_totals(
  p_tenant_id uuid,
  p_from date,
  p_to date,
  p_grouping text default 'month'
)
returns table (period date, sort text, line_id text, split jsonb, cents bigint, expenses bigint)
language sql stable set search_path = ''
as $$
  select date_trunc(
           case when p_grouping in ('day', 'week', 'month') then p_grouping else 'month' end,
           e.txn_date)::date,
         e.sort, e.line_id, e.split, sum(e.amount_cents)::bigint, count(*)
  from public.book_expenses e
  where e.tenant_id = p_tenant_id and e.removed_at is null and not e.is_move
    and e.txn_date >= p_from and e.txn_date < p_to
  group by 1, 2, 3, 4
  order by 1, 2 nulls first, 3 nulls first, 4::text nulls first;
$$;

-- Cost of goods from the shop's item costs, for every set of facts a line
-- rule reads, by when the order was placed. Only items with a cost count;
-- cancelled and test orders never do.
create function public.money_line_item_costs(
  p_tenant_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  order_tags text[],
  product_external_id text,
  product_tags text[],
  product_type text,
  workshop boolean,
  cost_cents bigint
)
language sql stable set search_path = ''
as $$
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
  order by 2 nulls first, 1 nulls first, 3 nulls first, 4 nulls first, 5;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.money_expense_months(uuid)',
    'public.money_expense_totals(uuid, date, date, text)',
    'public.money_line_item_costs(uuid, timestamptz, timestamptz)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- A disconnected provider's data goes, expenses included.
-- ---------------------------------------------------------------------------

create or replace function public.purge_provider_data(p_tenant_id uuid, p_provider text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.orders o where o.tenant_id = p_tenant_id and o.provider = p_provider;
  delete from public.customers c where c.tenant_id = p_tenant_id and c.provider = p_provider;
  delete from public.products p where p.tenant_id = p_tenant_id and p.provider = p_provider;
  delete from public.financial_snapshots f where f.tenant_id = p_tenant_id and f.provider = p_provider;
  delete from public.book_expenses b where b.tenant_id = p_tenant_id and b.provider = p_provider;
  insert into public.audit_log (tenant_id, action, target_type, target_id)
  values (p_tenant_id, 'privacy.provider_data_erased', 'provider', p_provider);
end;
$$;
