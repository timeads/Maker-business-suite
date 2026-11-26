-- Money: payments into a debt follow its account by the books' own id.
--
-- A move (a transfer or card payment) now keeps the books' id of the
-- account it paid into (`book_expenses.account_ref`), and a debt from the
-- books knows its account's id (`money_book_accounts.books_id`), so a
-- renamed account keeps its payments. Where either side has no id (a move
-- read by earlier code, a debt typed in and linked by name) the account's
-- name is compared as before, capitals and spacing ignored. A debt a person
-- marked "Not a debt" has no payments listed. OWNERS AND ADMINS ONLY, as
-- before: these read as the member, under the same row-level security.

alter table public.book_expenses
  add column account_ref text check (char_length(account_ref) between 1 and 60);

-- As before, and the account's id for a move (`account_ref`, optional: a
-- worker on earlier code sends none and the name is used).
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
           case when btrim(coalesce(i.account_ref, '')) ~ '^[A-Za-z0-9_-]{1,60}$'
                then btrim(i.account_ref) end as account_ref,
           i.lines, i.auto, i.suggest
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as i(
      entity text, external_id text, kind text, payment_type text, date date,
      amount_cents bigint, account text, payee text, memo text, from_account text,
      account_ref text, lines jsonb, auto jsonb, suggest jsonb)
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
       account, payee, memo, from_account, account_ref, lines, search_text, last_run, read_at)
    values
      (p_tenant_id, p_provider, r.entity, r.external_id, r.kind, r.payment_type, r.day,
       r.amount_cents, r.account, r.payee, r.memo, r.from_account, r.account_ref, v_lines,
       left(coalesce(v_search, ''), 4000), p_run, now())
    on conflict (tenant_id, provider, entity, external_id) do update
      set kind = excluded.kind, payment_type = excluded.payment_type,
          txn_date = excluded.txn_date, amount_cents = excluded.amount_cents,
          account = excluded.account, payee = excluded.payee, memo = excluded.memo,
          from_account = excluded.from_account,
          account_ref = coalesce(excluded.account_ref, e.account_ref),
          lines = excluded.lines,
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

-- What the books show paid into each debt's own account, per month.
create or replace function public.money_debt_payments(p_tenant_id uuid, p_from date, p_to date)
returns table (debt_id uuid, month date, cents bigint, payments bigint)
language sql stable set search_path = ''
as $$
  select d.id, date_trunc('month', e.txn_date)::date, sum(e.amount_cents)::bigint, count(*)
  from public.book_expenses e
  join public.money_debts d on d.tenant_id = e.tenant_id and d.left_out_at is null
  left join public.money_book_accounts a on a.id = d.book_account_id
  where e.tenant_id = p_tenant_id and e.is_move and e.removed_at is null
    and e.txn_date >= p_from and e.txn_date < p_to
    and case
          when a.books_id is not null and e.account_ref is not null then e.account_ref = a.books_id
          else d.books_account is not null
               and lower(btrim(regexp_replace(d.books_account, '\s+', ' ', 'g')))
                   = lower(btrim(regexp_replace(e.account, '\s+', ' ', 'g')))
        end
  group by 1, 2
  order by 2, 1;
$$;

-- The latest payments into debts, one per move, newest first.
create or replace function public.money_debt_payment_list(p_tenant_id uuid, p_limit integer)
returns table (debt_id uuid, txn_date date, cents bigint, from_account text, kind text)
language sql stable set search_path = ''
as $$
  select d.id, e.txn_date, e.amount_cents, e.from_account, e.kind
  from public.book_expenses e
  join public.money_debts d on d.tenant_id = e.tenant_id and d.left_out_at is null
  left join public.money_book_accounts a on a.id = d.book_account_id
  where e.tenant_id = p_tenant_id and e.is_move and e.removed_at is null
    and case
          when a.books_id is not null and e.account_ref is not null then e.account_ref = a.books_id
          else d.books_account is not null
               and lower(btrim(regexp_replace(d.books_account, '\s+', ' ', 'g')))
                   = lower(btrim(regexp_replace(e.account, '\s+', ' ', 'g')))
        end
  order by e.txn_date desc, e.id
  limit least(greatest(coalesce(p_limit, 50), 1), 500);
$$;
