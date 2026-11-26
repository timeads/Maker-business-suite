-- Money: debts paid through a plan ("consolidated" debts). OWNERS AND
-- ADMINS ONLY, as everything about debts.
--
-- Some businesses pay one monthly amount to a company that pays several of
-- their cards for them. The books still carry the debt on the cards (their
-- balances fall as the company pays them), and the company's own account,
-- if the books have one, passes the money through at zero. Here that is ONE
-- debt: a consolidated debt with its own rate, one fixed monthly payment and
-- a due day, which "covers" the cards. Covered debts are never counted on
-- their own (`lib/dashboard/debt/plans.ts` folds them into the plan before
-- anything is worked out); what a person filled in on them is kept as it is
-- and comes back untouched when they're no longer covered.
--
-- Why columns on `money_debts` and not a table of their own: a consolidated
-- debt IS a debt. It has dated balances (`money_debt_balances`), payments,
-- a place in the order, what-ifs that name it, and every page and function
-- already reads debts from this one table under the owners-and-admins rule.
-- One nullable pointer (`covered_by`) also makes "covered by at most one
-- plan" true by construction.
--
-- * `consolidated`: this debt is a plan that pays other debts. It is always
--   paid a fixed amount (`plan = 'fixed'`), is typed in (never the books'
--   own debt) and is never covered itself.
-- * `balance_from`: where its balance comes from: `covered` (the covered
--   debts' balances added up, on read, so it follows the books on every
--   sync), `account` (one account in the books, `plan_account_id`, for
--   books that carry the plan as a loan) or `typed` (dated entries a person
--   gives, as for any typed-in debt).
-- * `plan_account_id`: the plan's own account in the books, if it has one:
--   payments are the moves into it, and that account no longer counts as a
--   debt by itself (folded under the plan on read; nothing about the
--   account is changed, so taking the plan away puts it back as it was).
-- * `covered_by`: on a covered debt, the plan that pays it.
--
-- A sync never writes any of these: `book_debt_apply` only ever touches the
-- books' own debts, by `book_account_id`, and a plan has none. A covered
-- account that leaves the books is closed as before and drops out of the sum.

alter table public.money_debts
  add column consolidated boolean not null default false,
  add column balance_from text check (balance_from in ('covered', 'account', 'typed')),
  add column plan_account_id uuid references public.money_book_accounts (id) on delete set null,
  add column covered_by uuid references public.money_debts (id) on delete set null;

alter table public.money_debts
  add constraint money_debts_plan_shape check (
    (consolidated and balance_from is not null and plan = 'fixed' and source = 'person'
     and book_account_id is null and books_account is null and covered_by is null)
    or (not consolidated and balance_from is null and plan_account_id is null)
  ),
  add constraint money_debts_not_own_cover check (covered_by is null or covered_by <> id);

create index money_debts_covered_by_idx on public.money_debts (covered_by)
  where covered_by is not null;
-- One plan per account in the books.
create unique index money_debts_plan_account_idx on public.money_debts (plan_account_id)
  where plan_account_id is not null;

-- Whatever writes a row, a debt is covered only by a plan of its own
-- workspace, and a plan stays a plan while it covers anything.
create function private.money_debt_cover_check()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.covered_by is not null
     and (tg_op = 'INSERT' or new.covered_by is distinct from old.covered_by) then
    if not exists (select 1 from public.money_debts p
                   where p.id = new.covered_by and p.tenant_id = new.tenant_id and p.consolidated) then
      raise exception 'A debt can only be paid through a plan in the same workspace'
        using errcode = '22023';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.consolidated and not new.consolidated
     and exists (select 1 from public.money_debts c where c.covered_by = new.id) then
    raise exception 'This plan still pays other debts' using errcode = '22023';
  end if;
  if new.plan_account_id is not null
     and (tg_op = 'INSERT' or new.plan_account_id is distinct from old.plan_account_id)
     and not exists (select 1 from public.money_book_accounts a
                     where a.id = new.plan_account_id and a.tenant_id = new.tenant_id) then
    raise exception 'That account isn''t here' using errcode = 'P0002';
  end if;
  return new;
end;
$$;
revoke all on function private.money_debt_cover_check() from public;

create trigger money_debts_cover_check
  before insert or update of covered_by, consolidated, plan_account_id on public.money_debts
  for each row execute function private.money_debt_cover_check();

-- ---------------------------------------------------------------------------
-- Writing, owners and admins only
-- ---------------------------------------------------------------------------

-- Makes a plan (p_debt_id null) or changes one. p_fields: name, rate_bp
-- (null: not given yet), payment_cents, due_day, priority, note, status,
-- opening_cents, balance_from ('covered', 'account' or 'typed'),
-- plan_account_id (an account in `money_book_accounts`, or null) and covers
-- (the debts it pays, every one: a debt left off is no longer covered).
-- Nothing on a covered debt is changed but `covered_by`. Returns the id.
create function public.save_money_debt_plan(p_tenant_id uuid, p_debt_id uuid, p_fields jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  f record;
  v_id uuid;
  v_name text;
  v_covers uuid[];
  v_bad text;
begin
  perform private.require_manager(p_tenant_id);
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'Send the plan''s details' using errcode = '22023';
  end if;
  select * into f from jsonb_to_record(p_fields) as x(
    name text, rate_bp integer, payment_cents bigint, due_day smallint, priority smallint,
    note text, status text, opening_cents bigint, balance_from text, plan_account_id uuid);
  v_name := btrim(regexp_replace(coalesce(f.name, ''), '\s+', ' ', 'g'));
  if v_name = '' or char_length(v_name) > 80 then
    raise exception 'Give the plan a name' using errcode = '22023';
  end if;
  if f.balance_from is null or f.balance_from not in ('covered', 'account', 'typed') then
    raise exception 'Say where its balance comes from' using errcode = '22023';
  end if;
  if f.balance_from = 'account' and f.plan_account_id is null then
    raise exception 'Pick the account in your books its balance comes from' using errcode = '22023';
  end if;
  if f.payment_cents is null or f.payment_cents < 0 or f.payment_cents > 100000000000 then
    raise exception 'Give the plan''s monthly payment' using errcode = '22023';
  end if;
  if f.status is not null and f.status not in ('active', 'paused', 'closed') then
    raise exception 'That isn''t a status a debt can have' using errcode = '22023';
  end if;
  if p_fields ? 'covers' and jsonb_typeof(p_fields -> 'covers') <> 'array' then
    raise exception 'Say which debts it pays' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct value::uuid), '{}') into v_covers
  from jsonb_array_elements_text(coalesce(p_fields -> 'covers', '[]'::jsonb));
  if cardinality(v_covers) > 50 then
    raise exception 'A plan can pay up to 50 debts' using errcode = '22023';
  end if;

  if p_debt_id is null then
    insert into public.money_debts
      (tenant_id, name, kind, plan, status, rate_bp, minimum_cents, payment_cents, due_day,
       priority, opening_cents, note, source, consolidated, balance_from, plan_account_id,
       updated_by)
    values
      (p_tenant_id, v_name, 'other', 'fixed', coalesce(f.status, 'active'), f.rate_bp, 0,
       f.payment_cents, f.due_day, f.priority, f.opening_cents,
       nullif(left(btrim(coalesce(f.note, '')), 500), ''), 'person', true, f.balance_from,
       f.plan_account_id, auth.uid())
    returning id into v_id;
  else
    select d.id into v_id from public.money_debts d
    where d.id = p_debt_id and d.tenant_id = p_tenant_id and d.consolidated
    for update;
    if v_id is null then
      raise exception 'That plan isn''t here' using errcode = 'P0002';
    end if;
    update public.money_debts d
    set name = v_name, status = coalesce(f.status, d.status), rate_bp = f.rate_bp,
        minimum_cents = 0, payment_cents = f.payment_cents, due_day = f.due_day,
        priority = f.priority, opening_cents = f.opening_cents,
        note = nullif(left(btrim(coalesce(f.note, '')), 500), ''),
        balance_from = f.balance_from, plan_account_id = f.plan_account_id,
        updated_by = auth.uid(), updated_at = now()
    where d.id = v_id;
  end if;

  -- Every debt it pays, and every one it paid, locked in one order.
  perform 1 from public.money_debts d
  where d.tenant_id = p_tenant_id and (d.id = any (v_covers) or d.covered_by = v_id)
  order by d.id
  for update;

  select string_agg(d.name, ', ' order by d.name) into v_bad
  from public.money_debts d
  where d.id = any (v_covers) and d.tenant_id = p_tenant_id
    and d.covered_by is not null and d.covered_by <> v_id;
  if v_bad is not null then
    raise exception '% already paid through another plan', v_bad using errcode = '22023';
  end if;
  if exists (select 1 from public.money_debts d
             where d.id = any (v_covers) and d.tenant_id = p_tenant_id and d.consolidated) then
    raise exception 'A plan can''t pay another plan' using errcode = '22023';
  end if;
  if (select count(*) from public.money_debts d
      where d.id = any (v_covers) and d.tenant_id = p_tenant_id and d.left_out_at is null)
     <> cardinality(v_covers) then
    raise exception 'One of those debts isn''t here' using errcode = 'P0002';
  end if;

  update public.money_debts d set covered_by = null
  where d.covered_by = v_id and not (d.id = any (v_covers));
  update public.money_debts d set covered_by = v_id
  where d.id = any (v_covers) and d.covered_by is distinct from v_id;
  return v_id;
end;
$$;

-- Covers one debt by a plan, or (p_plan_id null) stops covering it. The
-- debt itself is untouched otherwise, so it comes back exactly as it was.
create function public.cover_money_debt(p_tenant_id uuid, p_debt_id uuid, p_plan_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  d public.money_debts%rowtype;
begin
  perform private.require_manager(p_tenant_id);
  if p_plan_id is not null then
    perform 1 from public.money_debts p
    where p.id = p_plan_id and p.tenant_id = p_tenant_id and p.consolidated
    for update;
    if not found then
      raise exception 'That plan isn''t here' using errcode = 'P0002';
    end if;
  end if;
  select * into d from public.money_debts m
  where m.id = p_debt_id and m.tenant_id = p_tenant_id and m.left_out_at is null
  for update;
  if not found then
    raise exception 'That debt isn''t here' using errcode = 'P0002';
  end if;
  if p_plan_id is null then
    update public.money_debts set covered_by = null where id = d.id;
    return;
  end if;
  if d.consolidated then
    raise exception 'A plan can''t pay another plan' using errcode = '22023';
  end if;
  if d.covered_by is not null and d.covered_by <> p_plan_id then
    raise exception '% is already paid through another plan', d.name using errcode = '22023';
  end if;
  update public.money_debts set covered_by = p_plan_id where id = d.id;
end;
$$;

-- As before; a plan whose balance is worked out (the covered debts added
-- up, or its account in the books) takes no typed balance.
create or replace function public.note_money_debt_balance(
  p_tenant_id uuid, p_debt_id uuid, p_as_of date, p_balance_cents bigint
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  if p_as_of is null or p_as_of > current_date + 1 or p_as_of < date '2000-01-01' then
    raise exception 'Give the day the balance was' using errcode = '22023';
  end if;
  if p_balance_cents is null or p_balance_cents < 0 or p_balance_cents > 100000000000 then
    raise exception 'A balance is a whole number of cents, nothing below zero' using errcode = '22023';
  end if;
  if not exists (select 1 from public.money_debts d where d.id = p_debt_id and d.tenant_id = p_tenant_id) then
    raise exception 'That debt isn''t here' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.money_debts d where d.id = p_debt_id and d.source = 'books') then
    raise exception 'Its balance comes from your books' using errcode = '22023';
  end if;
  if exists (select 1 from public.money_debts d
             where d.id = p_debt_id and d.consolidated and d.balance_from <> 'typed') then
    raise exception 'Its balance is worked out: change where it comes from to type one in'
      using errcode = '22023';
  end if;
  insert into public.money_debt_balances
    (tenant_id, debt_id, as_of, balance_cents, source, noted_by, noted_at)
  values (p_tenant_id, p_debt_id, p_as_of, p_balance_cents, 'person', auth.uid(), now())
  on conflict (debt_id, as_of, source) do update
    set balance_cents = excluded.balance_cents, noted_by = excluded.noted_by, noted_at = now();
end;
$$;

-- ---------------------------------------------------------------------------
-- Payments into a plan: the moves into its own account in the books
-- ---------------------------------------------------------------------------

-- As before, and a plan with an account in the books is matched by that
-- account (its id where both sides have one, else its name). A plan with
-- no account has no rows of its own: the page adds up its covered debts'.
create or replace function public.money_debt_payments(p_tenant_id uuid, p_from date, p_to date)
returns table (debt_id uuid, month date, cents bigint, payments bigint)
language sql stable set search_path = ''
as $$
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
  order by 2, 1;
$$;

create or replace function public.money_debt_payment_list(p_tenant_id uuid, p_limit integer)
returns table (debt_id uuid, txn_date date, cents bigint, from_account text, kind text)
language sql stable set search_path = ''
as $$
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
  limit least(greatest(coalesce(p_limit, 50), 1), 500);
$$;

-- ---------------------------------------------------------------------------
-- Bringing plans across from a spreadsheet (Settings → Money → Debt payoff)
-- ---------------------------------------------------------------------------

-- p_plans: [{"name", "rate_bp"?, "payment_cents"?, "due_day"?, "note"?,
--            "plan_account_id"?}]: plans to make, each only if no plan of
-- that name is here yet (one that is, is used as it is).
-- p_covers: [{"debt_id", "plan_name"}]: a debt is covered only when nobody
-- has put it under a plan yet. At most 50 plans and 200 covers.
-- Under a request key like the details import: the same key again returns
-- the first answer, and the same file again makes and covers nothing.
create function public.import_money_debt_plans(
  p_tenant_id uuid,
  p_request_key uuid,
  p_plans jsonb,
  p_covers jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  v_claim uuid;
  v_prior jsonb;
  v_plan uuid;
  v_name text;
  v_made int := 0;
  v_covered int := 0;
  v_kept int := 0;
  v_missing int := 0;
  v_result jsonb;
  d public.money_debts%rowtype;
begin
  perform private.require_manager(p_tenant_id);
  if p_request_key is null then
    raise exception 'Send a request key' using errcode = '22023';
  end if;
  if p_plans is null or jsonb_typeof(p_plans) <> 'array' or jsonb_array_length(p_plans) > 50
     or p_covers is null or jsonb_typeof(p_covers) <> 'array'
     or jsonb_array_length(p_covers) > 200 then
    raise exception 'Send up to 50 plans and 200 debts' using errcode = '22023';
  end if;

  insert into public.money_debt_imports (tenant_id, request_key, result, imported_by)
  values (p_tenant_id, p_request_key, '{}'::jsonb, auth.uid())
  on conflict (tenant_id, request_key) do nothing
  returning id into v_claim;
  if v_claim is null then
    select i.result into v_prior from public.money_debt_imports i
    where i.tenant_id = p_tenant_id and i.request_key = p_request_key;
    return coalesce(v_prior, '{}'::jsonb) || jsonb_build_object('again', true);
  end if;

  -- One at a time per workspace, so two presses can't make the same plan twice.
  perform pg_advisory_xact_lock(hashtextextended('money_debt_plans:' || p_tenant_id::text, 0));

  for r in
    select x.name, x.rate_bp, x.payment_cents, x.due_day, x.note, x.plan_account_id
    from jsonb_to_recordset(p_plans) as x(
      name text, rate_bp integer, payment_cents bigint, due_day integer, note text,
      plan_account_id uuid)
  loop
    v_name := btrim(regexp_replace(coalesce(r.name, ''), '\s+', ' ', 'g'));
    if v_name = '' or char_length(v_name) > 80
       or (r.rate_bp is not null and r.rate_bp not between 0 and 100000)
       or (r.payment_cents is not null and r.payment_cents not between 0 and 100000000000)
       or (r.due_day is not null and r.due_day not between 1 and 31) then
      raise exception 'A figure in that file isn''t one a debt can have' using errcode = '22023';
    end if;
    if exists (select 1 from public.money_debts p
               where p.tenant_id = p_tenant_id and p.consolidated
                 and private.account_key(p.name) = private.account_key(v_name)) then
      continue;
    end if;
    insert into public.money_debts
      (tenant_id, name, kind, plan, status, rate_bp, minimum_cents, payment_cents, due_day,
       note, source, consolidated, balance_from, plan_account_id, updated_by)
    select p_tenant_id, v_name, 'other', 'fixed', 'active', r.rate_bp, 0,
           coalesce(r.payment_cents, 0), r.due_day::smallint,
           left(nullif(btrim(coalesce(r.note, '')), ''), 500), 'person', true, 'covered',
           -- Only an account of this workspace that no other plan has.
           (select a.id from public.money_book_accounts a
            where a.id = r.plan_account_id and a.tenant_id = p_tenant_id
              and not exists (select 1 from public.money_debts o where o.plan_account_id = a.id)),
           auth.uid();
    v_made := v_made + 1;
  end loop;

  for r in
    select x.debt_id, x.plan_name
    from jsonb_to_recordset(p_covers) as x(debt_id uuid, plan_name text)
  loop
    select p.id into v_plan from public.money_debts p
    where p.tenant_id = p_tenant_id and p.consolidated
      and private.account_key(p.name) = private.account_key(r.plan_name)
    order by p.created_at, p.id
    limit 1
    for update;
    select * into d from public.money_debts m
    where m.id = r.debt_id and m.tenant_id = p_tenant_id and m.left_out_at is null
    for update;
    if v_plan is null or not found or d.consolidated then
      v_missing := v_missing + 1;
      continue;
    end if;
    if d.covered_by is not null then
      v_kept := v_kept + 1;
      continue;
    end if;
    update public.money_debts set covered_by = v_plan where id = d.id;
    v_covered := v_covered + 1;
  end loop;

  v_result := jsonb_build_object('plans', v_made, 'covered', v_covered, 'kept', v_kept,
                                 'missing', v_missing);
  update public.money_debt_imports set result = v_result where id = v_claim;
  return v_result;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.save_money_debt_plan(uuid, uuid, jsonb)',
    'public.cover_money_debt(uuid, uuid, uuid)',
    'public.import_money_debt_plans(uuid, uuid, jsonb, jsonb)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
