-- Money: debt payoff and the emergency fund. OWNERS AND ADMINS ONLY.
--
-- The owner decided this whole area is for the workspace's owners and
-- admins: nobody else may see a debt, a balance, a payment into a debt, the
-- plan's settings or a saved what-if, anywhere. That is held here, in the
-- database, not only by the pages:
--
-- * every new table is readable only by owners and admins of its workspace,
--   and written only through the functions below, each checking the role;
-- * moves between the business's own accounts in `book_expenses`
--   (transfers and card payments: the payments into a card or a loan) are
--   now readable only by owners and admins (they were never listed or
--   counted for anyone);
-- * the debt plan's setting (`configs` dashboard / debt), its versions and
--   any proposal for it are readable only by owners and admins
--   (`private.config_owners_only`), and only they may propose a change to it.
--
-- What a person types is stored: the debts, the balances they give, the
-- months they set by hand, the what-ifs they keep. The books' balance for a
-- debt linked to one of their accounts is written by the sync. Everything
-- else (the current balance, payments per month, the plan, the emergency
-- fund) is worked out on read (`lib/dashboard/debt`).

-- ---------------------------------------------------------------------------
-- Debts
-- ---------------------------------------------------------------------------

create table public.money_debts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  kind text not null default 'card' check (kind in ('card', 'loan', 'line_of_credit', 'other')),
  -- How the plan pays it: from the snowball pool, a fixed payment from the
  -- business, or a share of sales (never joins the pool).
  plan text not null default 'pool' check (plan in ('pool', 'fixed', 'revenue_share')),
  status text not null default 'active' check (status in ('active', 'paused', 'closed')),
  -- Annual rate in basis points (2299 = 22.99%).
  rate_bp integer not null default 0 check (rate_bp between 0 and 100000),
  minimum_cents bigint not null default 0 check (minimum_cents between 0 and 100000000000),
  -- The usual monthly payment; null uses the minimum.
  payment_cents bigint check (payment_cents between 0 and 100000000000),
  -- A revolving line's least payment as a share of its balance, basis points.
  revolving_bp integer check (revolving_bp between 1 and 10000),
  due_day smallint check (due_day between 1 and 31),
  -- Lower goes first in the plan and in "your own order".
  priority smallint check (priority between 1 and 999),
  -- What it started at, for "paid off so far".
  opening_cents bigint check (opening_cents between 0 and 100000000000),
  -- The books' account its payments go to and its balance is read from.
  books_account text check (char_length(books_account) between 1 and 200),
  note text check (char_length(note) <= 500),
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);
create index money_debts_by_tenant_idx on public.money_debts (tenant_id);

-- Balances as dated entries: given by a person, or read from the books'
-- balance sheet for a debt linked to an account. The current balance is
-- the latest (`money_debt_current`).
create table public.money_debt_balances (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  debt_id uuid not null references public.money_debts (id) on delete cascade,
  as_of date not null,
  balance_cents bigint not null check (balance_cents between 0 and 100000000000),
  source text not null check (source in ('person', 'books')),
  noted_by uuid references auth.users (id) on delete set null,
  noted_at timestamptz not null default now(),
  unique (debt_id, as_of, source)
);
create index money_debt_balances_latest_idx
  on public.money_debt_balances (tenant_id, debt_id, as_of desc, noted_at desc);

-- A month's pool or emergency amount set by hand (null = worked out).
create table public.money_debt_plan_months (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  pool_cents bigint check (pool_cents between 0 and 100000000000),
  emergency_cents bigint check (emergency_cents between 0 and 100000000000),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (tenant_id, month),
  check (pool_cents is not null or emergency_cents is not null)
);

-- A what-if a person chose to keep: their question, what was changed, and
-- the engine's figures at the time. Nothing a model wrote is kept.
create table public.money_debt_scenarios (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  question text not null check (char_length(question) between 1 and 500),
  changes jsonb not null check (jsonb_typeof(changes) = 'object'),
  figures jsonb not null check (jsonb_typeof(figures) = 'object'),
  saved_by uuid references auth.users (id) on delete set null,
  saved_at timestamptz not null default now()
);
create index money_debt_scenarios_by_tenant_idx on public.money_debt_scenarios (tenant_id, saved_at desc);

do $$
declare
  t text;
begin
  foreach t in array array['money_debts', 'money_debt_balances', 'money_debt_plan_months',
                           'money_debt_scenarios']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy "owners and admins read their %s" on public.%I for select to authenticated
         using (private.has_tenant_role(tenant_id, array[''owner'', ''admin'']::public.membership_role[]))',
      t, t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to authenticated, service_role', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Nobody else sees what is paid into a debt, or the plan's setting
-- ---------------------------------------------------------------------------

alter policy "members read their book expenses" on public.book_expenses
  using (
    tenant_id in (select private.user_tenant_ids())
    and (not is_move
         or private.has_tenant_role(tenant_id, array['owner', 'admin']::public.membership_role[]))
  );

-- Settings only owners and admins may read or propose.
create function private.config_owners_only(p_module text, p_key text)
returns boolean
language sql immutable set search_path = ''
as $$ select p_module = 'dashboard' and p_key = 'debt' $$;
revoke all on function private.config_owners_only(text, text) from public;
grant execute on function private.config_owners_only(text, text) to authenticated, service_role;

alter policy "members read their configs" on public.configs
  using (
    tenant_id in (select private.user_tenant_ids())
    and (not private.config_owners_only(module, key)
         or private.has_tenant_role(tenant_id, array['owner', 'admin']::public.membership_role[]))
  );
alter policy "members read their config versions" on public.config_versions
  using (
    tenant_id in (select private.user_tenant_ids())
    and (not private.config_owners_only(module, key)
         or private.has_tenant_role(tenant_id, array['owner', 'admin']::public.membership_role[]))
  );
alter policy "members read their config proposals" on public.config_proposals
  using (
    tenant_id in (select private.user_tenant_ids())
    and (not private.config_owners_only(module, key)
         or private.has_tenant_role(tenant_id, array['owner', 'admin']::public.membership_role[]))
  );

-- As before, and a setting only owners and admins may read can only be
-- proposed by them.
create or replace function public.propose_config_change(
  p_tenant_id uuid, p_module text, p_key text, p_body jsonb, p_summary text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not (p_tenant_id in (select private.user_tenant_ids())) then
    raise exception 'Workspace not found' using errcode = '42501';
  end if;
  if p_module !~ '^[a-z_]{1,40}$' or p_key !~ '^[a-z0-9_-]{1,60}$' or jsonb_typeof(p_body) <> 'object' then
    raise exception 'That setting is not valid' using errcode = '22023';
  end if;
  if private.config_owners_only(p_module, p_key)
     and not private.has_tenant_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]) then
    raise exception 'Only owners and admins can see this setting' using errcode = '42501';
  end if;
  insert into public.config_proposals (tenant_id, module, key, body, summary, created_by)
  values (p_tenant_id, p_module, p_key, p_body, left(btrim(p_summary), 500), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Writing, owners and admins only
-- ---------------------------------------------------------------------------

-- Adds a debt (p_debt_id null) or changes one. p_fields holds every field:
-- name, kind, plan, status, rate_bp, minimum_cents, payment_cents,
-- revolving_bp, due_day, priority, opening_cents, books_account, note.
-- Returns the debt's id.
create function public.save_money_debt(p_tenant_id uuid, p_debt_id uuid, p_fields jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  f record;
  v_id uuid;
  v_name text;
  v_account text;
begin
  perform private.require_manager(p_tenant_id);
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'Send the debt''s details' using errcode = '22023';
  end if;
  select * into f from jsonb_to_record(p_fields) as x(
    name text, kind text, plan text, status text, rate_bp integer, minimum_cents bigint,
    payment_cents bigint, revolving_bp integer, due_day smallint, priority smallint,
    opening_cents bigint, books_account text, note text);
  v_name := btrim(regexp_replace(coalesce(f.name, ''), '\s+', ' ', 'g'));
  v_account := nullif(btrim(regexp_replace(coalesce(f.books_account, ''), '\s+', ' ', 'g')), '');
  if v_name = '' or char_length(v_name) > 80 then
    raise exception 'Give the debt a name' using errcode = '22023';
  end if;

  if p_debt_id is null then
    insert into public.money_debts
      (tenant_id, name, kind, plan, status, rate_bp, minimum_cents, payment_cents, revolving_bp,
       due_day, priority, opening_cents, books_account, note, updated_by)
    values
      (p_tenant_id, v_name, coalesce(f.kind, 'card'), coalesce(f.plan, 'pool'),
       coalesce(f.status, 'active'), coalesce(f.rate_bp, 0), coalesce(f.minimum_cents, 0),
       f.payment_cents, f.revolving_bp, f.due_day, f.priority, f.opening_cents, v_account,
       nullif(left(btrim(coalesce(f.note, '')), 500), ''), auth.uid())
    returning id into v_id;
    return v_id;
  end if;

  update public.money_debts d
  set name = v_name, kind = coalesce(f.kind, d.kind), plan = coalesce(f.plan, d.plan),
      status = coalesce(f.status, d.status), rate_bp = coalesce(f.rate_bp, 0),
      minimum_cents = coalesce(f.minimum_cents, 0), payment_cents = f.payment_cents,
      revolving_bp = f.revolving_bp, due_day = f.due_day, priority = f.priority,
      opening_cents = f.opening_cents, books_account = v_account,
      note = nullif(left(btrim(coalesce(f.note, '')), 500), ''),
      updated_by = auth.uid(), updated_at = now()
  where d.id = p_debt_id and d.tenant_id = p_tenant_id
  returning d.id into v_id;
  if v_id is null then
    raise exception 'That debt isn''t here' using errcode = 'P0002';
  end if;
  return v_id;
end;
$$;

-- Removes a debt typed in by mistake, with its balances. (A debt that's
-- paid off is better closed: its history stays.)
create function public.remove_money_debt(p_tenant_id uuid, p_debt_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  delete from public.money_debts d where d.id = p_debt_id and d.tenant_id = p_tenant_id;
  if not found then
    raise exception 'That debt isn''t here' using errcode = 'P0002';
  end if;
end;
$$;

-- A balance a person gives for a day; the same day again replaces it.
create function public.note_money_debt_balance(
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
  insert into public.money_debt_balances
    (tenant_id, debt_id, as_of, balance_cents, source, noted_by, noted_at)
  values (p_tenant_id, p_debt_id, p_as_of, p_balance_cents, 'person', auth.uid(), now())
  on conflict (debt_id, as_of, source) do update
    set balance_cents = excluded.balance_cents, noted_by = excluded.noted_by, noted_at = now();
end;
$$;

-- Takes back a balance a person gave (one the books gave comes back with the next sync).
create function public.remove_money_debt_balance(p_tenant_id uuid, p_balance_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  delete from public.money_debt_balances b
  where b.id = p_balance_id and b.tenant_id = p_tenant_id and b.source = 'person';
  if not found then
    raise exception 'That balance isn''t one you can take back' using errcode = 'P0002';
  end if;
end;
$$;

-- Sets months' pool and emergency amounts by hand:
-- [{"month": "2026-11-01", "pool_cents": 1000 | null, "emergency_cents": … | null}].
-- Both null puts the month back to worked out. Returns how many.
create function public.set_money_debt_plan_months(p_tenant_id uuid, p_rows jsonb)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  v_count int := 0;
begin
  perform private.require_manager(p_tenant_id);
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 120 then
    raise exception 'Send between 0 and 120 months' using errcode = '22023';
  end if;
  for r in
    select x.month, x.pool_cents, x.emergency_cents
    from jsonb_to_recordset(p_rows) as x(month date, pool_cents bigint, emergency_cents bigint)
  loop
    if r.month is null or extract(day from r.month) <> 1 then
      raise exception 'Each amount is for a whole month' using errcode = '22023';
    end if;
    if (r.pool_cents is not null and (r.pool_cents < 0 or r.pool_cents > 100000000000))
       or (r.emergency_cents is not null and (r.emergency_cents < 0 or r.emergency_cents > 100000000000)) then
      raise exception 'An amount is a whole number of cents, nothing below zero' using errcode = '22023';
    end if;
    if r.pool_cents is null and r.emergency_cents is null then
      delete from public.money_debt_plan_months m
      where m.tenant_id = p_tenant_id and m.month = r.month;
    else
      insert into public.money_debt_plan_months
        (tenant_id, month, pool_cents, emergency_cents, updated_by, updated_at)
      values (p_tenant_id, r.month, r.pool_cents, r.emergency_cents, auth.uid(), now())
      on conflict (tenant_id, month) do update
        set pool_cents = excluded.pool_cents, emergency_cents = excluded.emergency_cents,
            updated_by = excluded.updated_by, updated_at = now();
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Keeps a what-if a person chose to save. Returns its id.
create function public.save_money_debt_scenario(
  p_tenant_id uuid, p_question text, p_changes jsonb, p_figures jsonb
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_question text := left(btrim(coalesce(p_question, '')), 500);
begin
  perform private.require_manager(p_tenant_id);
  if v_question = '' then
    raise exception 'What was the question?' using errcode = '22023';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or octet_length(p_changes::text) > 8000
     or p_figures is null or jsonb_typeof(p_figures) <> 'object' or octet_length(p_figures::text) > 16000 then
    raise exception 'That what-if can''t be kept' using errcode = '22023';
  end if;
  if (select count(*) from public.money_debt_scenarios s where s.tenant_id = p_tenant_id) >= 200 then
    raise exception 'You have 200 saved what-ifs: remove some first' using errcode = '22023';
  end if;
  insert into public.money_debt_scenarios (tenant_id, question, changes, figures, saved_by)
  values (p_tenant_id, v_question, p_changes, p_figures, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

create function public.remove_money_debt_scenario(p_tenant_id uuid, p_scenario_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  delete from public.money_debt_scenarios s
  where s.id = p_scenario_id and s.tenant_id = p_tenant_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- The books' balances, from the sync (service role only)
-- ---------------------------------------------------------------------------

-- The balance sheet's liability accounts as of a day:
-- [{"name": "…", "cents": 123}]. Writes a balance for each debt linked to an
-- account of that name (capitals and spacing ignored), as a positive amount;
-- names no debt is linked to are not kept. Returns how many were written.
create function public.note_debt_balances_from_books(
  p_tenant_id uuid, p_provider text, p_as_of date, p_rows jsonb
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  if p_provider is distinct from 'quickbooks' then
    raise exception 'Balances come from the books' using errcode = '22023';
  end if;
  if p_as_of is null or p_rows is null or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) > 500 then
    raise exception 'Send the day and the accounts' using errcode = '22023';
  end if;
  with accounts as (
    select lower(btrim(regexp_replace(x.name, '\s+', ' ', 'g'))) as key,
           sum(abs(x.cents))::bigint as cents
    from jsonb_to_recordset(p_rows) as x(name text, cents bigint)
    where x.name is not null and x.cents is not null and abs(x.cents) <= 100000000000
    group by 1
  )
  insert into public.money_debt_balances
    (tenant_id, debt_id, as_of, balance_cents, source, noted_at)
  select d.tenant_id, d.id, p_as_of, a.cents, 'books', now()
  from public.money_debts d
  join accounts a on a.key = lower(btrim(regexp_replace(d.books_account, '\s+', ' ', 'g')))
  where d.tenant_id = p_tenant_id and d.books_account is not null and d.status <> 'closed'
    and a.cents <= 100000000000
  on conflict (debt_id, as_of, source) do update
    set balance_cents = excluded.balance_cents, noted_at = now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reading, as the member (row-level security decides: owners and admins
-- get their workspace's figures, everyone else gets nothing)
-- ---------------------------------------------------------------------------

-- Each debt's latest balance: the latest day, then the latest written.
create function public.money_debt_current(p_tenant_id uuid)
returns table (debt_id uuid, balance_cents bigint, as_of date, source text)
language sql stable set search_path = ''
as $$
  select distinct on (b.debt_id) b.debt_id, b.balance_cents, b.as_of, b.source
  from public.money_debt_balances b
  where b.tenant_id = p_tenant_id
  order by b.debt_id, b.as_of desc, b.noted_at desc;
$$;

-- What the books show paid into each debt's own account, per month: the
-- moves (transfers and card payments) whose account is the debt's linked
-- one, capitals and spacing ignored. Records gone from the books don't count.
create function public.money_debt_payments(p_tenant_id uuid, p_from date, p_to date)
returns table (debt_id uuid, month date, cents bigint, payments bigint)
language sql stable set search_path = ''
as $$
  select d.id, date_trunc('month', e.txn_date)::date, sum(e.amount_cents)::bigint, count(*)
  from public.book_expenses e
  join public.money_debts d
    on d.tenant_id = e.tenant_id and d.books_account is not null
   and lower(btrim(regexp_replace(d.books_account, '\s+', ' ', 'g')))
       = lower(btrim(regexp_replace(e.account, '\s+', ' ', 'g')))
  where e.tenant_id = p_tenant_id and e.is_move and e.removed_at is null
    and e.txn_date >= p_from and e.txn_date < p_to
  group by 1, 2
  order by 2, 1;
$$;

-- The latest payments into debts, one per move, newest first.
create function public.money_debt_payment_list(p_tenant_id uuid, p_limit integer)
returns table (debt_id uuid, txn_date date, cents bigint, from_account text, kind text)
language sql stable set search_path = ''
as $$
  select d.id, e.txn_date, e.amount_cents, e.from_account, e.kind
  from public.book_expenses e
  join public.money_debts d
    on d.tenant_id = e.tenant_id and d.books_account is not null
   and lower(btrim(regexp_replace(d.books_account, '\s+', ' ', 'g')))
       = lower(btrim(regexp_replace(e.account, '\s+', ' ', 'g')))
  where e.tenant_id = p_tenant_id and e.is_move and e.removed_at is null
  order by e.txn_date desc, e.id
  limit least(greatest(coalesce(p_limit, 50), 1), 500);
$$;

-- The accounts money has moved into, for linking a debt to one.
create function public.money_move_accounts(p_tenant_id uuid)
returns table (account text, moves bigint, last_date date)
language sql stable set search_path = ''
as $$
  select e.account, count(*), max(e.txn_date)
  from public.book_expenses e
  where e.tenant_id = p_tenant_id and e.is_move and e.removed_at is null
    and e.account is not null
  group by e.account
  order by max(e.txn_date) desc
  limit 200;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.save_money_debt(uuid, uuid, jsonb)',
    'public.remove_money_debt(uuid, uuid)',
    'public.note_money_debt_balance(uuid, uuid, date, bigint)',
    'public.remove_money_debt_balance(uuid, uuid)',
    'public.set_money_debt_plan_months(uuid, jsonb)',
    'public.save_money_debt_scenario(uuid, text, jsonb, jsonb)',
    'public.remove_money_debt_scenario(uuid, uuid)',
    'public.money_debt_current(uuid)',
    'public.money_debt_payments(uuid, date, date)',
    'public.money_debt_payment_list(uuid, integer)',
    'public.money_move_accounts(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;

revoke all on function public.note_debt_balances_from_books(uuid, text, date, jsonb)
  from public, anon, authenticated;
grant execute on function public.note_debt_balances_from_books(uuid, text, date, jsonb) to service_role;
