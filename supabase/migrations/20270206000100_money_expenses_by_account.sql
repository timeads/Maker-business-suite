-- Money: expenses sorted by the books' own accounts.
--
-- The books already file every expense under an account. Now the ACCOUNT is
-- what gets sorted: one choice per account (a line, a split, shared, set
-- aside, or "decide each one") sorts every expense in it, past and future.
-- The choices are part of the `dashboard` / `expenses` config (`accounts`,
-- Zod-checked in `lib/dashboard/expenses.ts`), keyed by the books' account id
-- where the expense has one, else the exact account name; never an account
-- name in code.
--
-- The order of decision (`decideExpense` in code, this file's twin for the
-- last step): a person's own choice on an expense, then firm rules, then the
-- payee default, then the other rules, then the account's choice. An account
-- with no choice yet counts as SHARED: it counts in the business's totals
-- exactly as the books have it, and in profit by line through the shared
-- split, and it never waits in the inbox. Only accounts set to "decide each
-- one" fill the inbox (with what a person put back, and what a rule only
-- suggests).
--
-- An expense sorted by its account is marked `sorted_by = 'account'` and
-- always follows the account: a sync, a changed choice or a rule that now
-- matches re-decides it. A person's choice, a rule's and a payee default's
-- are never touched by the account. The account step runs here, in the
-- database, so a worker on earlier code (which sends only rule decisions)
-- gets it too, and thousands of rows change in one statement.
--
-- Also kept now, from the answers the sync already reads (no new question):
-- the books' id for every expense's account (`account_ref`, until now only
-- for moves), each line's class and the record's location, for rules.

alter table public.book_expenses
  add column location text check (char_length(location) <= 200);

alter table public.book_expenses drop constraint book_expenses_sorted_by_check;
alter table public.book_expenses add constraint book_expenses_sorted_by_check
  check (sorted_by in ('person', 'rule', 'vendor', 'account'));

create index book_expenses_by_account_idx
  on public.book_expenses (tenant_id, account_ref, account)
  where removed_at is null and not is_move;

-- ---------------------------------------------------------------------------
-- The workspace's choices per account, as stored, and only usable ones: a
-- choice naming a line the workspace no longer has is passed over (that
-- account counts as shared again, as with no choice).
-- ---------------------------------------------------------------------------

create function private.money_account_choices(p_tenant_id uuid)
returns table (ref text, name text, sort text, line text, split jsonb)
language sql stable security definer set search_path = ''
as $$
  select nullif(btrim(coalesce(a ->> 'ref', '')), ''),
         btrim(a ->> 'name'),
         a -> 'action' ->> 'sort',
         nullif(a -> 'action' ->> 'line', ''),
         case when jsonb_typeof(a -> 'action' -> 'split') = 'object' then a -> 'action' -> 'split' end
  from public.configs c,
       jsonb_array_elements(
         case when jsonb_typeof(c.body -> 'accounts') = 'array' then c.body -> 'accounts'
              else '[]'::jsonb end) a
  where c.tenant_id = p_tenant_id and c.module = 'dashboard' and c.key = 'expenses'
    and jsonb_typeof(a) = 'object' and jsonb_typeof(a -> 'action') = 'object'
    and coalesce(btrim(a ->> 'name'), '') <> ''
    and (a -> 'action' ->> 'sort' = 'each'
         or private.money_sort_ok(
              p_tenant_id, a -> 'action' ->> 'sort', nullif(a -> 'action' ->> 'line', ''),
              case when jsonb_typeof(a -> 'action' -> 'split') = 'object'
                   then a -> 'action' -> 'split' end));
$$;
revoke all on function private.money_account_choices(uuid) from public;

-- Brings expenses in line with their account's choice: those no person, rule
-- or payee default has sorted (and nobody put back in the inbox, and no rule
-- only suggests), and those already sorted by their account. `p_ids` null
-- means every such expense in the workspace. One statement, whatever the
-- count. Returns how many were sorted and how many went to the inbox.
create function private.money_follow_accounts(p_tenant_id uuid, p_ids uuid[])
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_sorted int := 0;
  v_inbox int := 0;
begin
  with choices as materialized (
    select * from private.money_account_choices(p_tenant_id)
  ), wanted as (
    select e.id,
           coalesce((
             select jsonb_build_object('sort', c.sort, 'line', c.line, 'split', c.split)
             from choices c
             -- By the books' id where both have one, else by the exact name.
             where (c.ref is not null and c.ref = e.account_ref)
                or ((c.ref is null or e.account_ref is null) and c.name = e.account)
             order by coalesce(c.ref = e.account_ref, false) desc
             limit 1),
             '{"sort": "shared"}'::jsonb) as want
    from public.book_expenses e
    where e.tenant_id = p_tenant_id
      and (p_ids is null or e.id = any (p_ids))
      and not e.is_move and e.removed_at is null and not e.rules_off
      and ((e.sort is null and e.suggested is null) or e.sorted_by = 'account')
  ), changed as (
    update public.book_expenses e
    set sort = nullif(w.want ->> 'sort', 'each'),
        line_id = case when w.want ->> 'sort' = 'line' then w.want ->> 'line' end,
        split = case when w.want ->> 'sort' = 'split' then w.want -> 'split' end,
        sorted_by = case when w.want ->> 'sort' = 'each' then null else 'account' end,
        sorted_rule = null,
        sorted_member = null,
        sorted_at = case when w.want ->> 'sort' = 'each' then null else now() end
    from wanted w
    where e.id = w.id
      and (e.sort is distinct from nullif(w.want ->> 'sort', 'each')
           or e.line_id is distinct from
              (case when w.want ->> 'sort' = 'line' then w.want ->> 'line' end)
           or e.split is distinct from
              (case when w.want ->> 'sort' = 'split' then w.want -> 'split' end))
    returning e.sort
  )
  select count(*) filter (where c.sort is not null)::int,
         count(*) filter (where c.sort is null)::int
    into v_sorted, v_inbox
  from changed c;
  return jsonb_build_object('sorted', v_sorted, 'inbox', v_inbox);
end;
$$;
revoke all on function private.money_follow_accounts(uuid, uuid[]) from public;

-- As before, except an expense sorted by its account counts as unsorted by
-- anyone: a rule or payee default that matches now sorts it, and one that
-- only suggests takes it back to the inbox with the suggestion. Claude's
-- suggestions are still only ever noted on an expense waiting in the inbox.
create or replace function private.money_rule_decision(
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
  v_by_account boolean;
begin
  select * into v_row from public.book_expenses e
  where e.id = p_id and e.tenant_id = p_tenant_id
  for update;
  if not found or v_row.is_move or v_row.removed_at is not null then
    return null;
  end if;
  v_by_account := v_row.sorted_by is not distinct from 'account';
  if v_row.sort is not null and not v_by_account then
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
  if v_suggest is null then
    return null;
  end if;
  if v_by_account then
    -- Only a rule's or a payee default's suggestion speaks before the account.
    if v_suggest ->> 'source' not in ('rule', 'vendor') or v_row.rules_off then
      return null;
    end if;
    update public.book_expenses e
    set sort = null, line_id = null, split = null, sorted_by = null, sorted_rule = null,
        sorted_member = null, sorted_at = null, suggested = v_suggest
    where e.id = p_id;
    return 'suggested';
  end if;
  update public.book_expenses e set suggested = v_suggest where e.id = p_id;
  return 'suggested';
end;
$$;
revoke all on function private.money_rule_decision(uuid, uuid, jsonb, jsonb) from public;

-- ---------------------------------------------------------------------------
-- The sync: as before (`20270205000200`), and now each line's class, the
-- record's location and every expense's account id are kept; once a batch
-- is filed, its expenses follow their account's choice where nothing else
-- decided. A worker on earlier code sends no class or location: none is kept.
-- ---------------------------------------------------------------------------

create or replace function public.file_book_expenses(
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
  v_by text;
  v_move boolean;
  v_search text;
  v_lines jsonb;
  v_result text;
  v_ids uuid[] := '{}'::uuid[];
  v_follow jsonb;
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
           case when btrim(coalesce(i.account_ref, '')) ~ '^[A-Za-z0-9_-]{1,60}$'
                then btrim(i.account_ref) end as account_ref,
           left(nullif(btrim(i.location), ''), 200) as location,
           i.lines, i.auto, i.suggest
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as i(
      entity text, external_id text, kind text, payment_type text, date date,
      amount_cents bigint, account text, payee text, memo text, from_account text,
      account_ref text, location text, lines jsonb, auto jsonb, suggest jsonb)
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
    -- Each line kept small: its account, amount, description and class.
    select coalesce(jsonb_agg(
             jsonb_build_object(
               'account', left(nullif(btrim(l ->> 'account'), ''), 200),
               'amount_cents', case when (l ->> 'amount_cents') ~ '^-?[0-9]{1,12}$'
                                    then (l ->> 'amount_cents')::bigint else 0 end,
               'description', left(btrim(coalesce(l ->> 'description', '')), 300))
             || case when nullif(btrim(coalesce(l ->> 'class', '')), '') is not null
                     then jsonb_build_object('class', left(btrim(l ->> 'class'), 200))
                     else '{}'::jsonb end),
           '[]'::jsonb)
      into v_lines
    from (select l from jsonb_array_elements(
            case when jsonb_typeof(r.lines) = 'array' then r.lines else '[]'::jsonb end) l
          where jsonb_typeof(l) = 'object' limit 50) x;
    select lower(concat_ws(' ', r.payee, r.account, nullif(r.memo, ''), r.from_account, r.location,
                           string_agg(concat_ws(' ', l ->> 'account', l ->> 'description',
                                                l ->> 'class'), ' ')))
      into v_search
    from jsonb_array_elements(v_lines) l;

    insert into public.book_expenses as e
      (tenant_id, provider, entity, external_id, kind, payment_type, txn_date, amount_cents,
       account, payee, memo, from_account, account_ref, location, lines, search_text, last_run,
       read_at)
    values
      (p_tenant_id, p_provider, r.entity, r.external_id, r.kind, r.payment_type, r.day,
       r.amount_cents, r.account, r.payee, r.memo, r.from_account, r.account_ref, r.location,
       v_lines, left(coalesce(v_search, ''), 4000), p_run, now())
    on conflict (tenant_id, provider, entity, external_id) do update
      set kind = excluded.kind, payment_type = excluded.payment_type,
          txn_date = excluded.txn_date, amount_cents = excluded.amount_cents,
          account = excluded.account, payee = excluded.payee, memo = excluded.memo,
          from_account = excluded.from_account,
          account_ref = coalesce(excluded.account_ref, e.account_ref),
          location = excluded.location,
          lines = excluded.lines,
          search_text = excluded.search_text, last_run = excluded.last_run,
          read_at = excluded.read_at, removed_at = null
    returning e.id, e.sort, e.sorted_by, e.is_move into v_id, v_sort, v_by, v_move;

    if not v_move and (v_sort is null or v_by = 'account') then
      v_ids := v_ids || v_id;
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

  -- Whatever nothing else decided follows its account.
  v_follow := private.money_follow_accounts(p_tenant_id, v_ids);
  return jsonb_build_object('read', v_read, 'bad', v_bad, 'sorted', v_sorted,
                            'suggested', v_suggested,
                            'by_account', (v_follow ->> 'sorted')::int);
end;
$$;

-- "Apply my rules to what's waiting": now also over expenses sorted by their
-- account (a rule speaks before the account). As before otherwise.
-- (`note_expense_decisions` calls `money_rule_decision`, replaced above.)

-- ---------------------------------------------------------------------------
-- Owners and admins: after changing the account choices, everything follows
-- at once, in one checked statement.
-- ---------------------------------------------------------------------------

create function public.apply_expense_accounts(p_tenant_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  return private.money_follow_accounts(p_tenant_id, null);
end;
$$;
revoke all on function public.apply_expense_accounts(uuid) from public, anon;
grant execute on function public.apply_expense_accounts(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Reading, as the member: every expense account seen in the books, with its
-- count and total since a day (the last twelve months) and in all, how many
-- wait in the inbox, and how many a person, rule or payee default sorted
-- some other way. Grouped by the books' id where an expense has one, else by
-- its name; the name shown is the latest the books used.
-- ---------------------------------------------------------------------------

create function public.money_expense_accounts(p_tenant_id uuid, p_since date)
returns table (
  account_ref text,
  account text,
  recent bigint,
  recent_cents bigint,
  all_count bigint,
  to_sort bigint,
  by_account bigint,
  exceptions bigint,
  last_day date
)
language sql stable set search_path = ''
as $$
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
  order by 4 desc, 2;
$$;
revoke all on function public.money_expense_accounts(uuid, date) from public, anon;
grant execute on function public.money_expense_accounts(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Existing workspaces: what a person, a rule or a payee default sorted keeps
-- its sorting; everything still waiting follows its account now (no choices
-- yet: shared), with no step by hand. What a person put back in the inbox,
-- and what a rule or Claude only suggested, stays there.
-- ---------------------------------------------------------------------------

do $$
declare
  t uuid;
begin
  for t in
    select distinct e.tenant_id from public.book_expenses e
    where e.sort is null and not e.is_move and e.removed_at is null
  loop
    perform private.money_follow_accounts(t, null);
  end loop;
end;
$$;
