-- Money: a budget per account (or business line) per month, and the cost
-- cutter's decisions on recurring charges.
--
-- Only what a person says is stored. Actuals come from `book_expenses` and
-- the books' profit and loss already kept; variance, averages, break-even,
-- which charges recur and what they cost are all worked out on read
-- (`lib/dashboard/budget.ts`, `lib/dashboard/recurring.ts`), never stored.
--
-- The whole team reads both, like the rest of Money; owners and admins
-- write them, only through the functions below, each checking the caller's
-- role itself. A decision on a charge is a note for the team: it cancels
-- nothing anywhere.

-- ---------------------------------------------------------------------------
-- Budgets
-- ---------------------------------------------------------------------------

create table public.money_budgets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- An account in the books (by its name), or one of the workspace's lines (by its id).
  subject text not null check (subject in ('account', 'line')),
  subject_key text not null check (char_length(subject_key) between 1 and 200),
  -- The first of the month the budget is for.
  month date not null check (extract(day from month) = 1),
  amount_cents bigint not null check (amount_cents between 0 and 100000000000),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (tenant_id, subject, subject_key, month)
);
create index money_budgets_by_month_idx on public.money_budgets (tenant_id, month);

alter table public.money_budgets enable row level security;
create policy "members read their budgets" on public.money_budgets
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));
revoke all on public.money_budgets from public, anon, authenticated, service_role;
grant select on public.money_budgets to authenticated, service_role;

-- A budget's key, checked: a line must be one of the workspace's lines now;
-- an account is the books' name, trimmed. Null when it isn't usable.
create function private.money_budget_key(p_tenant_id uuid, p_subject text, p_key text)
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_key text := btrim(regexp_replace(coalesce(p_key, ''), '\s+', ' ', 'g'));
begin
  if v_key = '' or char_length(v_key) > 200 then
    return null;
  end if;
  if p_subject = 'line' then
    return case when v_key = any (private.money_line_ids(p_tenant_id)) then v_key end;
  elsif p_subject = 'account' then
    return v_key;
  end if;
  return null;
end;
$$;
revoke all on function private.money_budget_key(uuid, text, text) from public;

-- Sets one month's budgets: [{"subject", "key", "amount_cents"}, ...]. An
-- amount of null clears that budget. Returns how many changed.
create function public.set_money_budgets(p_tenant_id uuid, p_month date, p_rows jsonb)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  v_key text;
  v_count int := 0;
  v_amount bigint;
begin
  perform private.require_manager(p_tenant_id);
  if p_month is null or extract(day from p_month) <> 1 then
    raise exception 'A budget is for a whole month' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'Send between 0 and 500 budgets' using errcode = '22023';
  end if;
  for r in
    select x.subject, x.key, x.amount_cents
    from jsonb_to_recordset(p_rows) as x(subject text, key text, amount_cents jsonb)
  loop
    v_key := private.money_budget_key(p_tenant_id, r.subject, r.key);
    if v_key is null then
      raise exception 'That isn''t one of your accounts or lines' using errcode = '22023';
    end if;
    if r.amount_cents is null or jsonb_typeof(r.amount_cents) = 'null' then
      delete from public.money_budgets b
      where b.tenant_id = p_tenant_id and b.subject = r.subject and b.subject_key = v_key
        and b.month = p_month;
    else
      if jsonb_typeof(r.amount_cents) <> 'number' or (r.amount_cents #>> '{}') !~ '^[0-9]{1,12}$' then
        raise exception 'A budget is a whole number of cents, nothing below zero'
          using errcode = '22023';
      end if;
      v_amount := (r.amount_cents #>> '{}')::bigint;
      insert into public.money_budgets
        (tenant_id, subject, subject_key, month, amount_cents, updated_by, updated_at)
      values (p_tenant_id, r.subject, v_key, p_month, v_amount, auth.uid(), now())
      on conflict (tenant_id, subject, subject_key, month) do update
        set amount_cents = excluded.amount_cents, updated_by = excluded.updated_by,
            updated_at = now()
        where public.money_budgets.amount_cents is distinct from excluded.amount_cents;
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- "Copy last month's": every budget of the month before, onto this month,
-- replacing this month's for the same account or line (as the earlier
-- dashboard does). Lines no longer set up are skipped. Returns how many.
create function public.copy_money_budget_month(p_tenant_id uuid, p_month date)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  perform private.require_manager(p_tenant_id);
  if p_month is null or extract(day from p_month) <> 1 then
    raise exception 'A budget is for a whole month' using errcode = '22023';
  end if;
  insert into public.money_budgets
    (tenant_id, subject, subject_key, month, amount_cents, updated_by, updated_at)
  select p_tenant_id, b.subject, b.subject_key, p_month, b.amount_cents, auth.uid(), now()
  from public.money_budgets b
  where b.tenant_id = p_tenant_id
    and b.month = (p_month - interval '1 month')::date
    and private.money_budget_key(p_tenant_id, b.subject, b.subject_key) is not null
  on conflict (tenant_id, subject, subject_key, month) do update
    set amount_cents = excluded.amount_cents, updated_by = excluded.updated_by,
        updated_at = now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- "Fill the rest of the year": this month's budgets onto every later month
-- of the same calendar year, only where that month has none for the same
-- account or line. Never overwrites. Returns how many were added.
create function public.fill_money_budget_year(p_tenant_id uuid, p_month date)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  perform private.require_manager(p_tenant_id);
  if p_month is null or extract(day from p_month) <> 1 then
    raise exception 'A budget is for a whole month' using errcode = '22023';
  end if;
  insert into public.money_budgets
    (tenant_id, subject, subject_key, month, amount_cents, updated_by, updated_at)
  select p_tenant_id, b.subject, b.subject_key, m.month::date, b.amount_cents, auth.uid(), now()
  from public.money_budgets b
  cross join generate_series(
    p_month + interval '1 month',
    date_trunc('year', p_month) + interval '11 months',
    interval '1 month') as m(month)
  where b.tenant_id = p_tenant_id and b.month = p_month
    and private.money_budget_key(p_tenant_id, b.subject, b.subject_key) is not null
  on conflict (tenant_id, subject, subject_key, month) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- What the books spent per account per month, for budget against actual.
-- Runs as the member under row-level security. Moves between the
-- business's own accounts, records gone from the books and expenses set
-- aside as not the business's never count.
create function public.money_account_totals(p_tenant_id uuid, p_from date, p_to date)
returns table (month date, account text, cents bigint, expenses bigint)
language sql stable set search_path = ''
as $$
  select date_trunc('month', e.txn_date)::date, coalesce(nullif(btrim(e.account), ''), '(no account)'),
         sum(e.amount_cents)::bigint, count(*)
  from public.book_expenses e
  where e.tenant_id = p_tenant_id and e.removed_at is null and not e.is_move
    and e.sort is distinct from 'set_aside'
    and e.txn_date >= p_from and e.txn_date < p_to
  group by 1, 2
  order by 1, 2;
$$;

-- ---------------------------------------------------------------------------
-- The cost cutter's decisions
-- ---------------------------------------------------------------------------

create table public.money_charge_decisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- The payee's folded name (`foldPayee`), which is what the finder groups by.
  charge_key text not null check (char_length(charge_key) between 1 and 200),
  decision text not null check (decision in ('keep', 'review', 'cancel', 'cancelled')),
  note text check (char_length(note) <= 500),
  -- As shown when decided, so the list still reads if the payee stops charging.
  payee text check (char_length(payee) <= 200),
  monthly_cents bigint check (monthly_cents between 0 and 100000000000),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz not null default now(),
  unique (tenant_id, charge_key)
);

alter table public.money_charge_decisions enable row level security;
create policy "members read their charge decisions" on public.money_charge_decisions
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));
revoke all on public.money_charge_decisions from public, anon, authenticated, service_role;
grant select on public.money_charge_decisions to authenticated, service_role;

-- Keep, look into, cancel or cancelled for one recurring charge, with a
-- note; a null decision clears it. A note for the team only.
create function public.decide_money_charge(
  p_tenant_id uuid,
  p_key text,
  p_decision text,
  p_note text default null,
  p_payee text default null,
  p_monthly_cents bigint default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_key text := btrim(coalesce(p_key, ''));
begin
  perform private.require_manager(p_tenant_id);
  if v_key = '' or char_length(v_key) > 200 then
    raise exception 'Which charge is this?' using errcode = '22023';
  end if;
  if p_decision is null then
    delete from public.money_charge_decisions d
    where d.tenant_id = p_tenant_id and d.charge_key = v_key;
    return;
  end if;
  if p_decision not in ('keep', 'review', 'cancel', 'cancelled') then
    raise exception 'That isn''t a decision' using errcode = '22023';
  end if;
  if p_monthly_cents is not null and (p_monthly_cents < 0 or p_monthly_cents > 100000000000) then
    raise exception 'That amount doesn''t look right' using errcode = '22023';
  end if;
  insert into public.money_charge_decisions
    (tenant_id, charge_key, decision, note, payee, monthly_cents, decided_by, decided_at)
  values (
    p_tenant_id, v_key, p_decision, nullif(left(btrim(coalesce(p_note, '')), 500), ''),
    nullif(left(btrim(coalesce(p_payee, '')), 200), ''), p_monthly_cents, auth.uid(), now())
  on conflict (tenant_id, charge_key) do update
    set decision = excluded.decision, note = excluded.note, payee = excluded.payee,
        monthly_cents = excluded.monthly_cents, decided_by = excluded.decided_by,
        decided_at = now();
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.set_money_budgets(uuid, date, jsonb)',
    'public.copy_money_budget_month(uuid, date)',
    'public.fill_money_budget_year(uuid, date)',
    'public.money_account_totals(uuid, date, date)',
    'public.decide_money_charge(uuid, text, text, text, text, bigint)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
