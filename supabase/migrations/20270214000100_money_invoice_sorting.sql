-- Money: sorting the books' invoices into the business's own lines, one
-- invoice at a time.
--
-- Until now an invoice's revenue reached a line only through its income
-- ACCOUNT's choice (the revenue setting's `books.accounts`). That stays the
-- default, as with expenses; a person's own choice for one invoice now wins
-- over it and sticks across syncs:
--   line      the whole invoice (before tax) goes to one line;
--   split     shared across lines by whole percents (at least two lines,
--             adding up to 100), to the cent, in code (`splitByPercent`);
--   shop      the shop already counted it: left out, never counted twice;
--   left_out  left out for another reason;
--   (none)    back to its customer's default, else its account's choice.
-- Between the two sits an optional default per CUSTOMER, kept in the same
-- revenue setting (`books.customers`, keyed by the books' customer id, else
-- the exact name), so the customer's id is kept here too.
--
-- Where it is stored: on `book_invoices` itself, beside the books' facts,
-- as with `book_expenses`. The sync's one write (`file_book_invoices`)
-- names every column it sets, so it never touches these; a removed invoice
-- is only marked (`close_book_invoices`), so a choice is still there when it
-- comes back; and disconnecting the books erases the invoices and their
-- sorting together (`purge_provider_data`), as it should. A side table would
-- need its own policy, guard and clean-up for nothing more.
--
-- Which line an invoice counts in is decided in code (`decideInvoice` in
-- `lib/dashboard/book-revenue.ts`). The list's filters need the same answer
-- in the database for paging, so `private.money_invoice_in_line` and
-- `private.money_invoice_waiting` are its twins, handed the setting as data
-- (`p_sorting`, built by `invoiceSorting()`), and a test holds them equal.
--
-- During the deploy: an earlier build keeps calling `money_invoice_revenue`
-- and `money_invoice_list`, unchanged, and its sync's `file_book_invoices`
-- (same arguments) keeps a customer id it doesn't send. A later build
-- against the earlier database falls back to those two when the new
-- functions aren't there yet.

alter table public.book_invoices
  add column customer_ref text check (customer_ref ~ '^[A-Za-z0-9_-]{1,60}$'),
  add column sort text check (sort in ('line', 'split', 'shop', 'left_out')),
  add column line_id text check (char_length(line_id) <= 40),
  add column split jsonb,
  add column sorted_member uuid references auth.users (id) on delete set null,
  add column sorted_at timestamptz,
  add constraint book_invoices_line_when_line check ((sort = 'line') = (line_id is not null)),
  add constraint book_invoices_split_when_split check ((sort = 'split') = (split is not null)),
  add constraint book_invoices_sorted_when_sorted check ((sort is null) = (sorted_at is null));

-- ---------------------------------------------------------------------------
-- The sync, as before, now keeping the customer's id in the books. A row
-- without one (an earlier worker) keeps the one already stored. Nothing a
-- person chose is ever written here.
-- ---------------------------------------------------------------------------

create or replace function public.file_book_invoices(
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
           case when btrim(i.customer_ref) ~ '^[A-Za-z0-9_-]{1,60}$'
                then btrim(i.customer_ref) end as customer_ref,
           i.date as day, i.due_date, i.total_cents, i.balance_cents,
           coalesce(i.net_cents, i.total_cents) as net_cents,
           left(btrim(coalesce(i.memo, '')), 300) as memo,
           i.lines
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as i(
      external_id text, doc_number text, customer text, customer_ref text, date date,
      due_date date, total_cents bigint, balance_cents bigint, net_cents bigint, memo text,
      lines jsonb)
  loop
    v_read := v_read + 1;
    if r.external_id = '' or char_length(r.external_id) > 60
       or r.day is null or r.total_cents is null or r.balance_cents is null
       or abs(r.total_cents) > 100000000000 or abs(r.balance_cents) > 100000000000
       or abs(r.net_cents) > 100000000000 then
      v_bad := v_bad + 1;
      continue;
    end if;
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
      (tenant_id, provider, external_id, doc_number, customer, customer_ref, txn_date, due_date,
       total_cents, balance_cents, net_cents, memo, lines, search_text, last_run, read_at)
    values
      (p_tenant_id, p_provider, r.external_id, r.doc_number, r.customer, r.customer_ref, r.day,
       r.due_date, r.total_cents, r.balance_cents, r.net_cents, r.memo, v_lines,
       left(coalesce(v_search, ''), 4000), p_run, now())
    on conflict (tenant_id, provider, external_id) do update
      set doc_number = excluded.doc_number, customer = excluded.customer,
          customer_ref = coalesce(excluded.customer_ref, b.customer_ref),
          txn_date = excluded.txn_date, due_date = excluded.due_date,
          total_cents = excluded.total_cents, balance_cents = excluded.balance_cents,
          net_cents = excluded.net_cents, memo = excluded.memo, lines = excluded.lines,
          search_text = excluded.search_text, last_run = excluded.last_run,
          read_at = excluded.read_at, removed_at = null;
  end loop;
  return jsonb_build_object('read', v_read, 'bad', v_bad);
end;
$$;

-- ---------------------------------------------------------------------------
-- A person's choice, for several invoices at once (owners and admins)
-- ---------------------------------------------------------------------------

-- p_sort: line (p_line), split (p_split: {line id: whole percent}), shop,
-- left_out, or none to hand them back to their customer or account. Lines
-- and splits are checked against the workspace's lines as for expenses
-- (`private.money_sort_ok`). Invoices gone from the books are left alone.
create function public.sort_book_invoices(
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
    raise exception 'Choose between 1 and 500 invoices' using errcode = '22023';
  end if;
  if p_sort = 'none' then
    update public.book_invoices b
    set sort = null, line_id = null, split = null, sorted_member = null, sorted_at = null
    where b.tenant_id = p_tenant_id and b.id = any (p_ids)
      and b.removed_at is null and b.sort is not null;
  else
    if p_sort in ('shop', 'left_out') then
      if p_line is not null or p_split is not null then
        raise exception 'That isn''t a way these can be sorted' using errcode = '22023';
      end if;
    elsif p_sort not in ('line', 'split')
       or not private.money_sort_ok(p_tenant_id, p_sort, p_line, p_split) then
      raise exception 'That isn''t a way these can be sorted' using errcode = '22023';
    end if;
    update public.book_invoices b
    set sort = p_sort, line_id = p_line, split = p_split,
        sorted_member = (select auth.uid()), sorted_at = now()
    where b.tenant_id = p_tenant_id and b.id = any (p_ids) and b.removed_at is null;
  end if;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.sort_book_invoices(uuid, uuid[], text, text, jsonb)
  from public, anon;
grant execute on function public.sort_book_invoices(uuid, uuid[], text, text, jsonb)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Where an invoice counts: the database's twin of `decideInvoice`, for the
-- list's filters and counts. `p_sorting` is the setting as data:
--   {"lines": [line ids],
--    "accounts":  [{"ref", "name", "place"}],
--    "customers": [{"ref", "name", "place"}]}
-- where a place is "line:<id>", "skip:shop" or "skip:other" (a choice for a
-- line no longer there keeps its "line:<id>" and so counts nowhere).
-- ---------------------------------------------------------------------------

-- A choice in a list: by the books' id first, then by the exact name on a
-- choice made without an id, then (for something the books gave no id) by
-- the name alone. The twin of `choiceIn()`.
create function private.money_choice_place(p_list jsonb, p_ref text, p_name text)
returns text
language sql immutable set search_path = ''
as $$
  with list as (
    select e, n from jsonb_array_elements(
      case when jsonb_typeof(p_list) = 'array' then p_list else '[]'::jsonb end
    ) with ordinality as x(e, n)
  )
  select coalesce(
    (select e ->> 'place' from list where p_ref is not null and e ->> 'ref' = p_ref
     order by n limit 1),
    (select e ->> 'place' from list
     where p_name is not null and e ->> 'ref' is null and e ->> 'name' = p_name
     order by n limit 1),
    (select e ->> 'place' from list where p_ref is null and p_name is not null
       and e ->> 'name' = p_name order by n limit 1));
$$;

-- A place that still counts somewhere: left out, or a line that's there.
create function private.money_place_fits(p_place text, p_lines jsonb)
returns boolean
language sql immutable set search_path = ''
as $$
  select case
    when p_place in ('skip:shop', 'skip:other') then true
    when p_place like 'line:%' then
      coalesce(jsonb_typeof(p_lines) = 'array' and p_lines ? substr(p_place, 6), false)
    else false
  end;
$$;

-- The invoice's own choice, while every line it names is still there.
create function private.money_invoice_own_fits(
  p_sort text, p_line text, p_split jsonb, p_lines jsonb
)
returns boolean
language sql immutable set search_path = ''
as $$
  select case
    when p_sort in ('shop', 'left_out') then true
    when p_sort = 'line' then private.money_place_fits('line:' || p_line, p_lines)
    when p_sort = 'split' then
      case when jsonb_typeof(p_split) = 'object' then
        not exists (select 1 from jsonb_object_keys(p_split) k
                    where not private.money_place_fits('line:' || k, p_lines))
      else false end
    else false
  end;
$$;

-- The customer's default, when there is one that still counts somewhere.
create function private.money_customer_place(p_sorting jsonb, p_ref text, p_name text)
returns text
language sql immutable set search_path = ''
as $$
  select case when private.money_place_fits(x.place, p_sorting -> 'lines') then x.place end
  from (select private.money_choice_place(p_sorting -> 'customers', p_ref, p_name) as place) x;
$$;

-- Does any of the invoice count in this line?
create function private.money_invoice_in_line(
  p_sort text, p_line text, p_split jsonb, p_customer_ref text, p_customer text,
  p_lines jsonb, p_sorting jsonb, p_want text
)
returns boolean
language sql immutable set search_path = ''
as $$
  select case
    when private.money_invoice_own_fits(p_sort, p_line, p_split, p_sorting -> 'lines') then
      coalesce((p_sort = 'line' and p_line = p_want) or (p_sort = 'split' and p_split ? p_want),
               false)
    when private.money_customer_place(p_sorting, p_customer_ref, p_customer) is not null then
      private.money_customer_place(p_sorting, p_customer_ref, p_customer) = 'line:' || p_want
    else exists (
      select 1 from jsonb_array_elements(
        case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end) l
      where private.money_choice_place(p_sorting -> 'accounts', l ->> 'account_ref',
                                       l ->> 'account') = 'line:' || p_want
        and private.money_place_fits('line:' || p_want, p_sorting -> 'lines'))
  end;
$$;

-- Is any of the invoice still waiting for a choice (counted nowhere)?
create function private.money_invoice_waiting(
  p_sort text, p_line text, p_split jsonb, p_customer_ref text, p_customer text,
  p_lines jsonb, p_sorting jsonb
)
returns boolean
language sql immutable set search_path = ''
as $$
  select not private.money_invoice_own_fits(p_sort, p_line, p_split, p_sorting -> 'lines')
    and private.money_customer_place(p_sorting, p_customer_ref, p_customer) is null
    and exists (
      select 1 from jsonb_array_elements(
        case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end) l
      where not private.money_place_fits(
        coalesce(private.money_choice_place(p_sorting -> 'accounts', l ->> 'account_ref',
                                            l ->> 'account'), ''),
        p_sorting -> 'lines'));
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'private.money_choice_place(jsonb, text, text)',
    'private.money_place_fits(text, jsonb)',
    'private.money_invoice_own_fits(text, text, jsonb, jsonb)',
    'private.money_customer_place(jsonb, text, text)',
    'private.money_invoice_in_line(text, text, jsonb, text, text, jsonb, jsonb, text)',
    'private.money_invoice_waiting(text, text, jsonb, text, text, jsonb, jsonb)'
  ]
  loop
    execute format('revoke all on function %s from public', fn);
    execute format('grant execute on function %s to authenticated, service_role', fn);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reading, as the member (row-level security decides what is seen; nothing
-- at all for someone who can't use Money)
-- ---------------------------------------------------------------------------

-- The invoice list as before, with each invoice's customer id and its own
-- choice, filtered to a line (where any of it counts) or to those still
-- waiting for a choice.
create function public.money_invoice_sorted_list(
  p_tenant_id uuid,
  p_today date,
  p_status text default 'all',
  p_q text default null,
  p_sorting jsonb default null,
  p_line text default null,
  p_waiting boolean default false,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  id uuid, doc_number text, customer_ref text, customer text, txn_date date, due_date date,
  total_cents bigint, balance_cents bigint, net_cents bigint, memo text, lines jsonb,
  sort text, line_id text, split jsonb, sorted_at timestamptz, status text, total_count bigint
)
language sql stable set search_path = ''
as $$
  select gated.* from (
    select b.id, b.doc_number, b.customer_ref, b.customer, b.txn_date, b.due_date,
           b.total_cents, b.balance_cents, b.net_cents, b.memo, b.lines, b.sort, b.line_id,
           b.split, b.sorted_at,
           private.invoice_status(b.balance_cents, b.due_date, p_today),
           count(*) over ()
    from public.book_invoices b
    where b.tenant_id = p_tenant_id and b.removed_at is null
      and (coalesce(p_status, 'all') = 'all'
           or private.invoice_status(b.balance_cents, b.due_date, p_today) = p_status)
      and (p_q is null or p_q = '' or b.search_text like p_q escape '\')
      and (p_line is null
           or private.money_invoice_in_line(b.sort, b.line_id, b.split, b.customer_ref,
                b.customer, b.lines, coalesce(p_sorting, '{}'::jsonb), p_line))
      and (not coalesce(p_waiting, false)
           or private.money_invoice_waiting(b.sort, b.line_id, b.split, b.customer_ref,
                b.customer, b.lines, coalesce(p_sorting, '{}'::jsonb)))
    order by b.txn_date desc, b.id
    limit least(greatest(coalesce(p_limit, 50), 1), 5000)
    offset greatest(coalesce(p_offset, 0), 0)
  ) as gated
  where (select private.tool_open(p_tenant_id, 'dashboard'))
$$;

-- How many invoices are still waiting for a choice (and what they come
-- to before tax), and how many a person sorted by hand, since a day (null:
-- all of them).
create function public.money_invoice_sorting_counts(
  p_tenant_id uuid,
  p_sorting jsonb,
  p_since date default null
)
returns table (waiting bigint, waiting_cents bigint, by_hand bigint)
language sql stable set search_path = ''
as $$
  select gated.* from (
    select count(*) filter (where w.waiting),
           coalesce(sum(w.net_cents) filter (where w.waiting), 0)::bigint,
           count(*) filter (where w.sort is not null)
    from (
      select b.net_cents, b.sort,
             private.money_invoice_waiting(b.sort, b.line_id, b.split, b.customer_ref,
               b.customer, b.lines, coalesce(p_sorting, '{}'::jsonb)) as waiting
      from public.book_invoices b
      where b.tenant_id = p_tenant_id and b.removed_at is null
        and (p_since is null or b.txn_date >= p_since)
    ) w
  ) as gated
  where (select private.tool_open(p_tenant_id, 'dashboard'))
$$;

-- Paid invoices' revenue before tax, as `money_invoice_revenue`, grouped
-- also by what decides an invoice's line: its customer and its own choice.
-- A split invoice comes back on its own (`invoice_id`), so its split is
-- worked out on its whole before-tax total, to the cent, in code.
create function public.money_invoice_sorted_revenue(
  p_tenant_id uuid,
  p_from date,
  p_to date,
  p_grouping text default 'month'
)
returns table (
  period date, account_ref text, account text, customer_ref text, customer text,
  sort text, line_id text, split jsonb, invoice_id uuid, cents bigint, invoices bigint
)
language sql stable set search_path = ''
as $$
  select gated.* from (
    select date_trunc(
             case when p_grouping in ('day', 'week', 'month') then p_grouping else 'month' end,
             b.txn_date)::date as period,
           l ->> 'account_ref' as account_ref, l ->> 'account' as account,
           b.customer_ref, b.customer, b.sort, b.line_id, b.split,
           case when b.sort = 'split' then b.id end as invoice_id,
           sum(case when (l ->> 'cents') ~ '^-?[0-9]{1,12}$' then (l ->> 'cents')::bigint
                    else 0 end)::bigint,
           count(distinct b.id)
    from public.book_invoices b, jsonb_array_elements(b.lines) l
    where b.tenant_id = p_tenant_id and b.removed_at is null and b.balance_cents <= 0
      and b.txn_date >= p_from and b.txn_date < p_to
    group by 1, 2, 3, 4, 5, 6, 7, 8, 9
    order by 1, 2 nulls first, 3 nulls first, 4 nulls first, 5 nulls first, 6 nulls first,
             7 nulls first, b.split::text nulls first, 9 nulls first
  ) as gated
  where (select private.tool_open(p_tenant_id, 'dashboard'))
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.money_invoice_sorted_list(uuid, date, text, text, jsonb, text, boolean, integer, integer)',
    'public.money_invoice_sorting_counts(uuid, jsonb, date)',
    'public.money_invoice_sorted_revenue(uuid, date, date, text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated, service_role', fn);
  end loop;
end;
$$;
