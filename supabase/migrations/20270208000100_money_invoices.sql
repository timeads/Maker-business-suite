-- Money: invoices from the books.
--
-- The QuickBooks sync (read-only, the accounting scope a workspace already
-- granted) reads invoices from the first of January three years back and
-- hands them to `file_book_invoices` for one named workspace, keyed by the
-- books' own id, so reading again changes a row in place; one the books no
-- longer hold is marked removed by `close_book_invoices` after a complete
-- read. Nothing is ever written to the books.
--
-- Each invoice keeps its number, customer, dates, total and what is still
-- owed, and its sales lines with the income account each is booked to and
-- its share of the invoice before tax, in whole cents (worked out in code).
-- Whether an invoice is paid, open or overdue is worked out on read against
-- the workspace's own today; nothing about it is stored.
--
-- Customer names are the workspace's own data: kept here under row-level
-- security and never logged. The whole team reads Money, so the whole team
-- reads invoices, as it already reads what customers owe.

create table public.book_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  provider text not null check (provider = 'quickbooks'),
  external_id text not null check (char_length(external_id) between 1 and 60),
  doc_number text check (char_length(doc_number) <= 40),
  customer text check (char_length(customer) <= 200),
  txn_date date not null,
  due_date date,
  total_cents bigint not null check (abs(total_cents) <= 100000000000),
  balance_cents bigint not null check (abs(balance_cents) <= 100000000000),
  -- The invoice before tax, shared among `lines` to the cent.
  net_cents bigint not null default 0 check (abs(net_cents) <= 100000000000),
  memo text not null default '' check (char_length(memo) <= 300),
  -- [{account_ref, account, item, cents, description}]
  lines jsonb not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array'),
  -- Number, customer, memo, items and descriptions in small letters, for search.
  search_text text not null default '',
  last_run uuid,
  read_at timestamptz not null default now(),
  removed_at timestamptz,
  unique (tenant_id, provider, external_id)
);

create index book_invoices_by_date_idx on public.book_invoices (tenant_id, txn_date desc)
  where removed_at is null;

alter table public.book_invoices enable row level security;
create policy "members read their book invoices" on public.book_invoices
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));
revoke all on public.book_invoices from public, anon, authenticated, service_role;
grant select on public.book_invoices to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The sync (service role, one named workspace)
-- ---------------------------------------------------------------------------

-- Files what one read of the books found, in batches of up to 1,000:
--   [{"external_id", "doc_number", "customer", "date", "due_date",
--     "total_cents", "balance_cents", "net_cents", "memo",
--     "lines": [{"account_ref", "account", "item", "cents", "description"}]}]
-- Facts follow the books; a row a later read sees again comes back.
create function public.file_book_invoices(
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
  v_lines jsonb;
  v_search text;
  v_read int := 0;
  v_bad int := 0;
begin
  if p_provider is distinct from 'quickbooks' then
    raise exception 'Only the books connection files invoices' using errcode = '22023';
  end if;
  if p_run is null or jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 1000 then
    raise exception 'Bad rows' using errcode = '22023';
  end if;

  for r in
    select btrim(coalesce(i.external_id, '')) as external_id,
           left(nullif(btrim(i.doc_number), ''), 40) as doc_number,
           left(nullif(btrim(i.customer), ''), 200) as customer,
           i.date as day, i.due_date, i.total_cents, i.balance_cents,
           coalesce(i.net_cents, i.total_cents) as net_cents,
           left(btrim(coalesce(i.memo, '')), 300) as memo,
           i.lines
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as i(
      external_id text, doc_number text, customer text, date date, due_date date,
      total_cents bigint, balance_cents bigint, net_cents bigint, memo text, lines jsonb)
  loop
    v_read := v_read + 1;
    if r.external_id = '' or char_length(r.external_id) > 60
       or r.day is null or r.total_cents is null or r.balance_cents is null
       or abs(r.total_cents) > 100000000000 or abs(r.balance_cents) > 100000000000
       or abs(r.net_cents) > 100000000000 then
      v_bad := v_bad + 1;
      continue;
    end if;
    -- Each line kept small: the account it is booked to, the item, its share.
    select coalesce(jsonb_agg(jsonb_build_object(
             'account_ref', case when (l ->> 'account_ref') ~ '^[A-Za-z0-9_-]{1,60}$'
                                 then l ->> 'account_ref' end,
             'account', left(nullif(btrim(l ->> 'account'), ''), 200),
             'item', left(nullif(btrim(l ->> 'item'), ''), 200),
             'cents', case when (l ->> 'cents') ~ '^-?[0-9]{1,12}$'
                           then (l ->> 'cents')::bigint else 0 end,
             'description', left(btrim(coalesce(l ->> 'description', '')), 200))), '[]'::jsonb)
      into v_lines
    from (select l from jsonb_array_elements(
            case when jsonb_typeof(r.lines) = 'array' then r.lines else '[]'::jsonb end) l
          where jsonb_typeof(l) = 'object' limit 50) x;
    select lower(concat_ws(' ', r.doc_number, r.customer, nullif(r.memo, ''),
                           string_agg(concat_ws(' ', l ->> 'item', l ->> 'description'), ' ')))
      into v_search
    from jsonb_array_elements(v_lines) l;

    insert into public.book_invoices as b
      (tenant_id, provider, external_id, doc_number, customer, txn_date, due_date, total_cents,
       balance_cents, net_cents, memo, lines, search_text, last_run, read_at)
    values
      (p_tenant_id, p_provider, r.external_id, r.doc_number, r.customer, r.day, r.due_date,
       r.total_cents, r.balance_cents, r.net_cents, r.memo, v_lines,
       left(coalesce(v_search, ''), 4000), p_run, now())
    on conflict (tenant_id, provider, external_id) do update
      set doc_number = excluded.doc_number, customer = excluded.customer,
          txn_date = excluded.txn_date, due_date = excluded.due_date,
          total_cents = excluded.total_cents, balance_cents = excluded.balance_cents,
          net_cents = excluded.net_cents, memo = excluded.memo, lines = excluded.lines,
          search_text = excluded.search_text, last_run = excluded.last_run,
          read_at = excluded.read_at, removed_at = null;
  end loop;
  return jsonb_build_object('read', v_read, 'bad', v_bad);
end;
$$;

-- After a complete read since a day: whatever this read didn't see, dated
-- from that day on, is gone from the books. The row stays, marked.
create function public.close_book_invoices(
  p_tenant_id uuid,
  p_provider text,
  p_run uuid,
  p_since date
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
  update public.book_invoices b
  set removed_at = now()
  where b.tenant_id = p_tenant_id and b.provider = p_provider
    and b.txn_date >= p_since
    and b.last_run is distinct from p_run
    and b.removed_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.file_book_invoices(uuid, text, uuid, jsonb)',
    'public.close_book_invoices(uuid, text, uuid, date)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reading, as the member (row-level security decides what is seen)
-- ---------------------------------------------------------------------------

-- An invoice's standing on a day: paid when nothing is owed, overdue once
-- its due day has gone by, else open. The app's twin is `invoiceStatus()`.
create function private.invoice_status(p_balance bigint, p_due date, p_today date)
returns text
language sql immutable set search_path = ''
as $$
  select case when p_balance <= 0 then 'paid'
              when p_due is not null and p_due < p_today then 'overdue'
              else 'open' end;
$$;
revoke all on function private.invoice_status(bigint, date, date) from public;
grant execute on function private.invoice_status(bigint, date, date) to authenticated, service_role;

-- The invoice list: a status (or 'all'), words to look for, and which of
-- the books' income accounts a line takes (by id, or by exact name for a
-- choice made by name) when
-- the list is filtered to one line. Newest first, a page at a time, with
-- how many match in all.
create function public.money_invoice_list(
  p_tenant_id uuid,
  p_today date,
  p_status text default 'all',
  p_q text default null,
  p_account_refs text[] default null,
  p_account_names text[] default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  id uuid, doc_number text, customer text, txn_date date, due_date date,
  total_cents bigint, balance_cents bigint, net_cents bigint, memo text, lines jsonb,
  status text, total_count bigint
)
language sql stable set search_path = ''
as $$
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
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- How many invoices are in each standing, and what is still owed on them.
create function public.money_invoice_counts(p_tenant_id uuid, p_today date)
returns table (status text, invoices bigint, total_cents bigint, balance_cents bigint)
language sql stable set search_path = ''
as $$
  select private.invoice_status(b.balance_cents, b.due_date, p_today),
         count(*), coalesce(sum(b.total_cents), 0)::bigint,
         coalesce(sum(b.balance_cents), 0)::bigint
  from public.book_invoices b
  where b.tenant_id = p_tenant_id and b.removed_at is null
  group by 1
  order by 1;
$$;

-- Paid invoices' revenue before tax, per period and per income account, by
-- the invoice's own day, between two days (`p_to` not included). Which line
-- an account belongs to is the revenue setting, decided in code.
create function public.money_invoice_revenue(
  p_tenant_id uuid,
  p_from date,
  p_to date,
  p_grouping text default 'month'
)
returns table (period date, account_ref text, account text, cents bigint, invoices bigint)
language sql stable set search_path = ''
as $$
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
  order by 1, 2 nulls first, 3 nulls first;
$$;

-- The income accounts invoices are booked to since a day, biggest first,
-- for Settings → Money → Revenue and business lines.
create function public.money_invoice_accounts(p_tenant_id uuid, p_since date)
returns table (account_ref text, account text, invoices bigint, cents bigint)
language sql stable set search_path = ''
as $$
  select l ->> 'account_ref', l ->> 'account', count(distinct b.id),
         sum(case when (l ->> 'cents') ~ '^-?[0-9]{1,12}$' then (l ->> 'cents')::bigint
                  else 0 end)::bigint
  from public.book_invoices b, jsonb_array_elements(b.lines) l
  where b.tenant_id = p_tenant_id and b.removed_at is null and b.txn_date >= p_since
  group by 1, 2
  order by 4 desc, 2 nulls last, 1 nulls last
  limit 200;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.money_invoice_list(uuid, date, text, text, text[], text[], integer, integer)',
    'public.money_invoice_counts(uuid, date)',
    'public.money_invoice_revenue(uuid, date, date, text)',
    'public.money_invoice_accounts(uuid, date)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated, service_role', fn);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- A disconnected provider's data goes, invoices included.
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
  delete from public.book_invoices b where b.tenant_id = p_tenant_id and b.provider = p_provider;
  insert into public.audit_log (tenant_id, action, target_type, target_id)
  values (p_tenant_id, 'privacy.provider_data_erased', 'provider', p_provider);
end;
$$;
