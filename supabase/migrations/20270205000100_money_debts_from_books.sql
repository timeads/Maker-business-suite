-- Money: the debts come from the books. OWNERS AND ADMINS ONLY, as before.
--
-- Until now a debt was typed in by hand and the sync kept a balance only for
-- a debt a person had linked to an account of that name. Now every
-- liability account on the balance sheet is kept here, as the books have it
-- (`money_book_accounts`), and every one that is a debt becomes a debt by
-- itself:
--
-- * which liabilities are debts is decided by the sync from the books' own
--   account types (the chart of accounts) or, failing that, the balance
--   sheet's own sections, against the `books_debt_types` list in the debt
--   plan's setting; never from an account, bank or lender name. A person can
--   count any other liability ("Count this as a debt") or leave one out
--   ("Not a debt"), and that choice sticks across syncs;
-- * a debt from the books follows its account by the books' id (else its
--   exact name), so a renamed account keeps its debt, and its balance is the
--   books' alone: a dated entry on every sync, never typed over;
-- * what the books can't say (rate, minimum, usual payment, due day, plan,
--   priority, note) stays a person's, and a sync never touches it;
-- * a debt typed in earlier and linked to an account of the same name is
--   joined to that account, not made twice;
-- * an account at zero stays, paid off; an account a complete read no longer
--   finds is marked closed, never deleted, with its history kept.
--
-- A worker on earlier code still calls `note_debt_balances_from_books`,
-- which keeps working unchanged (it notes balances by name and makes
-- nothing).

-- ---------------------------------------------------------------------------
-- The books' liability accounts
-- ---------------------------------------------------------------------------

-- Names compared as the books spell them, capitals and spacing ignored.
create function private.account_key(p_name text)
returns text
language sql immutable set search_path = ''
as $$ select lower(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'))) $$;
revoke all on function private.account_key(text) from public;
grant execute on function private.account_key(text) to authenticated, service_role;

create table public.money_book_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  provider text not null default 'quickbooks' check (provider = 'quickbooks'),
  -- The books' own id for the account, where the books gave one.
  books_id text check (char_length(books_id) between 1 and 60),
  name text not null check (char_length(name) between 1 and 200),
  name_key text not null check (char_length(name_key) between 1 and 200),
  -- As the books have them (the chart of accounts' type and detail type),
  -- and the balance sheet section the line sat in.
  account_type text check (char_length(account_type) <= 60),
  account_subtype text check (char_length(account_subtype) <= 60),
  section text check (char_length(section) <= 60),
  -- What kind of debt it would be, worked out by the sync from the type.
  debt_kind text not null default 'other'
    check (debt_kind in ('card', 'loan', 'line_of_credit', 'other')),
  -- The workspace's rule said it is a debt, at the latest read.
  automatic boolean not null default false,
  -- A person's word, which beats the rule: counted, or not a debt.
  choice text check (choice in ('debt', 'not_debt')),
  chosen_by uuid references auth.users (id) on delete set null,
  chosen_at timestamptz,
  -- The latest balance, signed as the books show it (owed is positive).
  balance_cents bigint not null default 0 check (abs(balance_cents) <= 100000000000),
  as_of date,
  seen_at timestamptz not null default now(),
  -- A complete read no longer found it (deleted or merged in the books).
  gone_at timestamptz
);
create unique index money_book_accounts_books_id_idx
  on public.money_book_accounts (tenant_id, provider, books_id) where books_id is not null;
create unique index money_book_accounts_name_idx
  on public.money_book_accounts (tenant_id, provider, name_key) where books_id is null;
create index money_book_accounts_by_tenant_idx on public.money_book_accounts (tenant_id);

alter table public.money_book_accounts enable row level security;
create policy "owners and admins read their money_book_accounts" on public.money_book_accounts
  for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin']::public.membership_role[]));
revoke all on public.money_book_accounts from public, anon, authenticated, service_role;
grant select on public.money_book_accounts to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Debts: where each came from
-- ---------------------------------------------------------------------------

alter table public.money_debts
  add column source text not null default 'person' check (source in ('person', 'books')),
  add column book_account_id uuid references public.money_book_accounts (id) on delete set null,
  -- "Not a debt": out of every list and figure, kept so a change of mind
  -- brings back what a person had filled in.
  add column left_out_at timestamptz;
create unique index money_debts_book_account_idx
  on public.money_debts (book_account_id) where book_account_id is not null;

-- A rate nobody has given yet is unknown, not 0%: the pages say "needs a rate".
alter table public.money_debts alter column rate_bp drop not null;

-- ---------------------------------------------------------------------------
-- One account's debt, kept in step (the sync and a person's choice share it)
-- ---------------------------------------------------------------------------

-- Makes, joins or updates the debt for one account. Only the books' facts
-- are ever written to an existing debt (its name, its account's name,
-- whether it is counted, closed or open again, today's balance); what a
-- person fills in is never touched. `p_back`: the account had gone from the
-- books and is back. Returns what happened: made, joined, kept or none.
create function private.book_debt_apply(p_account_id uuid, p_back boolean)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  a public.money_book_accounts%rowtype;
  v_debt uuid;
  v_result text := 'kept';
  v_counted boolean;
begin
  select * into a from public.money_book_accounts where id = p_account_id for update;
  if not found then
    return 'none';
  end if;

  select d.id into v_debt from public.money_debts d where d.book_account_id = a.id for update;
  if v_debt is null then
    -- A debt typed in earlier and linked to an account of this name: join it.
    select d.id into v_debt
    from public.money_debts d
    where d.tenant_id = a.tenant_id and d.book_account_id is null and d.books_account is not null
      and private.account_key(d.books_account) = a.name_key
    order by d.created_at, d.id
    limit 1
    for update;
    if v_debt is not null then
      update public.money_debts set book_account_id = a.id, source = 'books' where id = v_debt;
      v_result := 'joined';
      -- A person linked it to this account: that is their word that it's a debt.
      if a.choice is null and not a.automatic then
        update public.money_book_accounts set choice = 'debt', chosen_at = now() where id = a.id;
        a.choice := 'debt';
      end if;
    end if;
  end if;

  v_counted := a.choice is not distinct from 'debt' or (a.choice is null and a.automatic);

  if v_debt is null then
    -- A new debt only for an account that is counted, still in the books, and
    -- owes something (or a person asked for it).
    if not v_counted or a.gone_at is not null or a.as_of is null
       or (a.balance_cents <= 0 and a.choice is distinct from 'debt') then
      return 'none';
    end if;
    insert into public.money_debts
      (tenant_id, name, kind, plan, status, rate_bp, minimum_cents, opening_cents,
       books_account, source, book_account_id)
    values
      (a.tenant_id, left(a.name, 80), a.debt_kind, 'pool', 'active', null, 0,
       greatest(a.balance_cents, 0), a.name, 'books', a.id)
    returning id into v_debt;
    v_result := 'made';
  else
    update public.money_debts d
    set name = left(a.name, 80),
        books_account = a.name,
        left_out_at = case when v_counted then null else coalesce(d.left_out_at, now()) end,
        status = case
                   when a.gone_at is not null then 'closed'
                   when p_back and d.status = 'closed' then 'active'
                   else d.status
                 end
    where d.id = v_debt;
  end if;

  if a.gone_at is null and a.as_of is not null then
    insert into public.money_debt_balances
      (tenant_id, debt_id, as_of, balance_cents, source, noted_at)
    values (a.tenant_id, v_debt, a.as_of, greatest(a.balance_cents, 0), 'books', now())
    on conflict (debt_id, as_of, source) do update
      set balance_cents = excluded.balance_cents, noted_at = now();
  end if;
  return v_result;
end;
$$;
revoke all on function private.book_debt_apply(uuid, boolean) from public;

-- ---------------------------------------------------------------------------
-- The sync (service role only)
-- ---------------------------------------------------------------------------

-- Every liability account on the balance sheet as of a day:
-- [{"id": "…" | null, "name": "…", "cents": 123, "type": "…" | null,
--   "subtype": "…" | null, "section": "…" | null,
--   "kind": "card" | "loan" | "line_of_credit" | "other", "automatic": true}].
-- `type` null means the books' type wasn't read this time: the type and the
-- rule's answer from an earlier read stand. `p_complete`: this is every
-- liability account the books have, so one not in it is gone from them.
-- Returns counts.
create function public.file_debts_from_books(
  p_tenant_id uuid, p_provider text, p_as_of date, p_accounts jsonb, p_complete boolean
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  v_name text;
  v_key text;
  v_bid text;
  v_id uuid;
  v_gone timestamptz;
  v_had_type boolean;
  v_result text;
  v_accounts int := 0;
  v_made int := 0;
  v_joined int := 0;
  v_closed int := 0;
begin
  if p_provider is distinct from 'quickbooks' then
    raise exception 'Debts come from the books' using errcode = '22023';
  end if;
  if p_tenant_id is null or p_as_of is null or p_accounts is null
     or jsonb_typeof(p_accounts) <> 'array' or jsonb_array_length(p_accounts) > 1000 then
    raise exception 'Send the day and the accounts' using errcode = '22023';
  end if;

  for r in
    select x.id, x.name, x.cents, x.type, x.subtype, x.section, x.kind, x.automatic
    from jsonb_to_recordset(p_accounts) as x(
      id text, name text, cents bigint, type text, subtype text, section text, kind text,
      automatic boolean)
  loop
    v_name := left(btrim(regexp_replace(coalesce(r.name, ''), '\s+', ' ', 'g')), 200);
    v_bid := nullif(btrim(coalesce(r.id, '')), '');
    if v_name = '' or r.cents is null or abs(r.cents) > 100000000000
       or (v_bid is not null and char_length(v_bid) > 60) then
      continue;
    end if;
    v_key := private.account_key(v_name);
    v_id := null;

    -- Find it: by the books' id, else (an account first read without one,
    -- or this read has none) by its name.
    if v_bid is not null then
      select a.id, a.gone_at, a.account_type is not null into v_id, v_gone, v_had_type
      from public.money_book_accounts a
      where a.tenant_id = p_tenant_id and a.provider = p_provider and a.books_id = v_bid;
    end if;
    if v_id is null then
      select a.id, a.gone_at, a.account_type is not null into v_id, v_gone, v_had_type
      from public.money_book_accounts a
      where a.tenant_id = p_tenant_id and a.provider = p_provider and a.name_key = v_key
        and (a.books_id is null or v_bid is null)
      order by (a.books_id is null) desc, (a.gone_at is null) desc, a.seen_at desc
      limit 1;
    end if;

    if v_id is null then
      insert into public.money_book_accounts
        (tenant_id, provider, books_id, name, name_key, account_type, account_subtype, section,
         debt_kind, automatic, balance_cents, as_of, seen_at)
      values
        (p_tenant_id, p_provider, v_bid, v_name, v_key, left(nullif(btrim(r.type), ''), 60),
         left(nullif(btrim(r.subtype), ''), 60), left(nullif(btrim(r.section), ''), 60),
         case when r.kind in ('card', 'loan', 'line_of_credit') then r.kind else 'other' end,
         coalesce(r.automatic, false), r.cents, p_as_of, now())
      returning id into v_id;
      v_gone := null;
    else
      update public.money_book_accounts a
      set books_id = coalesce(v_bid, a.books_id),
          name = v_name,
          name_key = v_key,
          section = coalesce(left(nullif(btrim(r.section), ''), 60), a.section),
          -- Without the books' type this time, what an earlier read knew stands.
          account_type = coalesce(left(nullif(btrim(r.type), ''), 60), a.account_type),
          account_subtype = case when nullif(btrim(r.type), '') is null then a.account_subtype
                                 else left(nullif(btrim(r.subtype), ''), 60) end,
          debt_kind = case when nullif(btrim(r.type), '') is null and v_had_type then a.debt_kind
                           when r.kind in ('card', 'loan', 'line_of_credit') then r.kind
                           else 'other' end,
          automatic = case when nullif(btrim(r.type), '') is null and v_had_type then a.automatic
                           else coalesce(r.automatic, false) end,
          balance_cents = r.cents,
          as_of = p_as_of,
          seen_at = now(),
          gone_at = null
      where a.id = v_id;
    end if;

    v_accounts := v_accounts + 1;
    v_result := private.book_debt_apply(v_id, v_gone is not null);
    if v_result = 'made' then v_made := v_made + 1;
    elsif v_result = 'joined' then v_joined := v_joined + 1;
    end if;
  end loop;

  -- Gone from the books: only a complete read can say so. Closed, never deleted.
  if p_complete then
    for v_id in
      update public.money_book_accounts a set gone_at = now()
      where a.tenant_id = p_tenant_id and a.provider = p_provider and a.gone_at is null
        and a.seen_at < now()
      returning a.id
    loop
      update public.money_debts d set status = 'closed'
      where d.book_account_id = v_id and d.status <> 'closed';
      if found then
        v_closed := v_closed + 1;
      end if;
    end loop;
  end if;

  return jsonb_build_object('accounts', v_accounts, 'made', v_made, 'joined', v_joined,
                            'closed', v_closed);
end;
$$;
revoke all on function public.file_debts_from_books(uuid, text, date, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.file_debts_from_books(uuid, text, date, jsonb, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- A person's word, owners and admins only
-- ---------------------------------------------------------------------------

-- "Count this as a debt" ('debt'), "Not a debt" ('not_debt'), or back to
-- what the workspace's rule says ('rule'). Takes effect at once and sticks
-- across syncs.
create function public.choose_book_liability(p_tenant_id uuid, p_account_id uuid, p_choice text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  if p_choice is null or p_choice not in ('debt', 'not_debt', 'rule') then
    raise exception 'Choose debt, not a debt, or the rule' using errcode = '22023';
  end if;
  update public.money_book_accounts a
  set choice = nullif(p_choice, 'rule'), chosen_by = auth.uid(), chosen_at = now()
  where a.id = p_account_id and a.tenant_id = p_tenant_id;
  if not found then
    raise exception 'That account isn''t here' using errcode = 'P0002';
  end if;
  perform private.book_debt_apply(p_account_id, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- What a person may change on a debt from the books
-- ---------------------------------------------------------------------------

-- As before, except: a rate left out is "not given yet" (null), and a debt
-- from the books keeps the books' name and account (the sync owns those).
create or replace function public.save_money_debt(p_tenant_id uuid, p_debt_id uuid, p_fields jsonb)
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

  if p_debt_id is null then
    if v_name = '' or char_length(v_name) > 80 then
      raise exception 'Give the debt a name' using errcode = '22023';
    end if;
    insert into public.money_debts
      (tenant_id, name, kind, plan, status, rate_bp, minimum_cents, payment_cents, revolving_bp,
       due_day, priority, opening_cents, books_account, note, updated_by)
    values
      (p_tenant_id, v_name, coalesce(f.kind, 'card'), coalesce(f.plan, 'pool'),
       coalesce(f.status, 'active'), f.rate_bp, coalesce(f.minimum_cents, 0),
       f.payment_cents, f.revolving_bp, f.due_day, f.priority, f.opening_cents, v_account,
       nullif(left(btrim(coalesce(f.note, '')), 500), ''), auth.uid())
    returning id into v_id;
    return v_id;
  end if;

  update public.money_debts d
  set name = case when d.source = 'books' then d.name else v_name end,
      kind = coalesce(f.kind, d.kind), plan = coalesce(f.plan, d.plan),
      status = coalesce(f.status, d.status), rate_bp = f.rate_bp,
      minimum_cents = coalesce(f.minimum_cents, 0), payment_cents = f.payment_cents,
      revolving_bp = f.revolving_bp, due_day = f.due_day, priority = f.priority,
      opening_cents = f.opening_cents,
      books_account = case when d.source = 'books' then d.books_account else v_account end,
      note = nullif(left(btrim(coalesce(f.note, '')), 500), ''),
      updated_by = auth.uid(), updated_at = now()
  where d.id = p_debt_id and d.tenant_id = p_tenant_id
    and (d.source = 'books' or (v_name <> '' and char_length(v_name) <= 80))
  returning d.id into v_id;
  if v_id is null then
    if exists (select 1 from public.money_debts d where d.id = p_debt_id and d.tenant_id = p_tenant_id) then
      raise exception 'Give the debt a name' using errcode = '22023';
    end if;
    raise exception 'That debt isn''t here' using errcode = 'P0002';
  end if;
  return v_id;
end;
$$;

-- As before; a debt from the books is "Not a debt" instead (its account is
-- still in the books, and would only bring it back).
create or replace function public.remove_money_debt(p_tenant_id uuid, p_debt_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  if exists (select 1 from public.money_debts d
             where d.id = p_debt_id and d.tenant_id = p_tenant_id and d.source = 'books') then
    raise exception 'This debt comes from your books: mark it “Not a debt” instead'
      using errcode = '22023';
  end if;
  delete from public.money_debts d where d.id = p_debt_id and d.tenant_id = p_tenant_id;
  if not found then
    raise exception 'That debt isn''t here' using errcode = 'P0002';
  end if;
end;
$$;

-- As before; a debt from the books takes its balance from the books only.
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
  insert into public.money_debt_balances
    (tenant_id, debt_id, as_of, balance_cents, source, noted_by, noted_at)
  values (p_tenant_id, p_debt_id, p_as_of, p_balance_cents, 'person', auth.uid(), now())
  on conflict (debt_id, as_of, source) do update
    set balance_cents = excluded.balance_cents, noted_by = excluded.noted_by, noted_at = now();
end;
$$;

-- Each debt's latest balance: the latest day, then the latest written. For
-- a debt from the books, only the books' balances count (one a person gave
-- before it was joined stays in its history).
create or replace function public.money_debt_current(p_tenant_id uuid)
returns table (debt_id uuid, balance_cents bigint, as_of date, source text)
language sql stable set search_path = ''
as $$
  select distinct on (b.debt_id) b.debt_id, b.balance_cents, b.as_of, b.source
  from public.money_debt_balances b
  join public.money_debts d on d.id = b.debt_id
  where b.tenant_id = p_tenant_id and (d.source = 'person' or b.source = 'books')
  order by b.debt_id, b.as_of desc, b.noted_at desc;
$$;

revoke all on function public.choose_book_liability(uuid, uuid, text) from public, anon;
grant execute on function public.choose_book_liability(uuid, uuid, text) to authenticated;
