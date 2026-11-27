-- Money: "your own order" for the debts is always a clean 1, 2, 3 …
-- OWNERS AND ADMINS ONLY, as everything about debts.
--
-- A debt's place (`money_debts.priority`) was a number a person typed, so
-- two debts could both be first and a gap could open when one was paid off.
-- From here the places of the debts that TAKE a place are always 1..N with
-- no repeats and no gaps, kept so in the database whoever writes:
--
-- * Which debts take a place: those the engine orders
--   (`lib/dashboard/debt/engine.ts`: only the snowball pool's debts are put
--   in an order), as the pages see them after `foldDebts`: counted (not
--   "Not a debt"), active (not paused or closed), paid from the pool, not a
--   plan that pays other debts, and not folded into an open plan (covered by
--   it, or the plan's own account in the books). A debt that doesn't take a
--   place keeps whatever number it had, untouched: a covered debt comes back
--   just as it was when it's no longer covered, near where it stood.
-- * Moving one (`move_money_debt`) is an insert, not a swap: the others
--   shift down or up around it. A position past either end is clamped.
-- * Anything that changes which debts take a place (a status, how it's
--   paid, a plan covering it, a new debt from the books, one removed) is
--   followed by a renumber (a trigger), in the current order then by name:
--   a debt new to the order goes to the end.
-- * Saving a debt with a place (`save_money_debt`) or importing one where
--   nobody chose it (`import_money_debt_details`) moves it there the same
--   way; saving with the place left blank keeps it where it is.
--
-- Every renumber holds the row locks of all the workspace's debts, taken in
-- one order (by id), so two at once wait for each other. Existing repeats
-- are put right once, here, by the current place then name.

-- ---------------------------------------------------------------------------
-- The lock and the renumber
-- ---------------------------------------------------------------------------

create function private.lock_money_debts(p_tenant_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform 1 from public.money_debts d where d.tenant_id = p_tenant_id order by d.id for update;
end;
$$;
revoke all on function private.lock_money_debts(uuid) from public;

-- Puts the workspace's places right: the debts that take a place become
-- 1..N in their current order (no place last, then by name, then id). With
-- a debt and a position: that debt is moved there first (clamped to 1..N)
-- and the others shift around it. Returns the debt's place, or null when it
-- doesn't take one.
create function private.money_debt_renumber(
  p_tenant_id uuid, p_debt_id uuid default null, p_position integer default null
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_at integer;
begin
  -- A workspace being deleted takes its debts with it: nothing to number.
  if p_tenant_id is null or not exists (select 1 from public.tenants t where t.id = p_tenant_id) then
    return null;
  end if;
  perform set_config('mbs.money_debt_order', 'on', true);
  perform private.lock_money_debts(p_tenant_id);

  with ordered as (
    select d.id, d.priority, d.name
    from public.money_debts d
    where d.tenant_id = p_tenant_id
      and d.left_out_at is null
      and d.status = 'active'
      and d.plan = 'pool'
      and not d.consolidated
      and not exists (
        select 1 from public.money_debts p
        where p.tenant_id = d.tenant_id and p.consolidated and p.status <> 'closed'
          and p.left_out_at is null
          and (p.id = d.covered_by
               or (d.book_account_id is not null and p.plan_account_id = d.book_account_id))
      )
  ),
  mover as (
    select o.id from ordered o where o.id = p_debt_id and p_position is not null
  ),
  others as (
    select o.id, row_number() over (order by o.priority asc nulls last, o.name, o.id) as r
    from ordered o
    where not exists (select 1 from mover m where m.id = o.id)
  ),
  target as (
    select case when exists (select 1 from mover)
                then least(greatest(p_position, 1), (select count(*) from ordered))::integer
           end as k
  ),
  placed as (
    select o.id, (case when t.k is not null and o.r >= t.k then o.r + 1 else o.r end)::integer as pos
    from others o cross join target t
    union all
    select m.id, t.k from mover m cross join target t
  )
  update public.money_debts d
  set priority = p.pos
  from placed p
  where d.id = p.id and d.priority is distinct from p.pos;

  select d.priority into v_at
  from public.money_debts d
  where d.id = p_debt_id and d.tenant_id = p_tenant_id
    and d.left_out_at is null and d.status = 'active' and d.plan = 'pool' and not d.consolidated
    and not exists (
      select 1 from public.money_debts p
      where p.tenant_id = d.tenant_id and p.consolidated and p.status <> 'closed'
        and p.left_out_at is null
        and (p.id = d.covered_by
             or (d.book_account_id is not null and p.plan_account_id = d.book_account_id))
    );
  perform set_config('mbs.money_debt_order', '', true);
  return v_at;
end;
$$;
revoke all on function private.money_debt_renumber(uuid, uuid, integer) from public;

-- Whatever changes which debts take a place, the places follow. The
-- renumber's own writes don't start another one.
create function private.money_debt_order_follow()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if coalesce(current_setting('mbs.money_debt_order', true), '') = 'on' then
    return null;
  end if;
  perform private.money_debt_renumber(
    case when tg_op = 'DELETE' then old.tenant_id else new.tenant_id end);
  return null;
end;
$$;
revoke all on function private.money_debt_order_follow() from public;

create trigger money_debts_order_added
  after insert or delete on public.money_debts
  for each row execute function private.money_debt_order_follow();

create trigger money_debts_order_changed
  after update of priority, status, plan, consolidated, covered_by, left_out_at,
                  book_account_id, plan_account_id
  on public.money_debts
  for each row
  when (old.priority is distinct from new.priority
        or old.status is distinct from new.status
        or old.plan is distinct from new.plan
        or old.consolidated is distinct from new.consolidated
        or old.covered_by is distinct from new.covered_by
        or old.left_out_at is distinct from new.left_out_at
        or old.book_account_id is distinct from new.book_account_id
        or old.plan_account_id is distinct from new.plan_account_id)
  execute function private.money_debt_order_follow();

-- ---------------------------------------------------------------------------
-- Moving a debt, owners and admins only
-- ---------------------------------------------------------------------------

-- Moves one debt to a place in "your own order" (1 is first); the others
-- shift around it. A place past the end puts it last. Returns where it
-- landed.
create function public.move_money_debt(p_tenant_id uuid, p_debt_id uuid, p_position integer)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_at integer;
begin
  perform private.require_manager(p_tenant_id);
  if p_debt_id is null or p_position is null then
    raise exception 'Say which debt and where it goes' using errcode = '22023';
  end if;
  perform private.lock_money_debts(p_tenant_id);
  if not exists (select 1 from public.money_debts d
                 where d.id = p_debt_id and d.tenant_id = p_tenant_id and d.left_out_at is null) then
    raise exception 'That debt isn''t here' using errcode = 'P0002';
  end if;
  v_at := private.money_debt_renumber(p_tenant_id, p_debt_id, p_position);
  if v_at is null then
    raise exception 'Only debts paid from the plan''s pool take a place in your own order'
      using errcode = '22023';
  end if;
  update public.money_debts d set updated_by = auth.uid(), updated_at = now()
  where d.id = p_debt_id;
  return v_at;
end;
$$;
revoke all on function public.move_money_debt(uuid, uuid, integer) from public, anon;
grant execute on function public.move_money_debt(uuid, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Saving a debt: a place given is a move; blank keeps it where it is
-- ---------------------------------------------------------------------------

create or replace function public.save_money_debt(p_tenant_id uuid, p_debt_id uuid, p_fields jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  f record;
  v_id uuid;
  v_name text;
  v_account text;
  v_was smallint;
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
  if f.priority is not null and f.priority not between 1 and 999 then
    raise exception 'A place is a number from 1' using errcode = '22023';
  end if;
  perform private.lock_money_debts(p_tenant_id);

  if p_debt_id is null then
    if v_name = '' or char_length(v_name) > 80 then
      raise exception 'Give the debt a name' using errcode = '22023';
    end if;
    -- In at the end; a place given moves it there.
    insert into public.money_debts
      (tenant_id, name, kind, plan, status, rate_bp, minimum_cents, payment_cents, revolving_bp,
       due_day, priority, opening_cents, books_account, note, updated_by)
    values
      (p_tenant_id, v_name, coalesce(f.kind, 'card'), coalesce(f.plan, 'pool'),
       coalesce(f.status, 'active'), f.rate_bp, coalesce(f.minimum_cents, 0),
       f.payment_cents, f.revolving_bp, f.due_day, null, f.opening_cents, v_account,
       nullif(left(btrim(coalesce(f.note, '')), 500), ''), auth.uid())
    returning id into v_id;
    if f.priority is not null then
      if private.money_debt_renumber(p_tenant_id, v_id, f.priority) is null then
        -- Not in the order (paused, or paid another way): keep the number as given.
        update public.money_debts set priority = f.priority where id = v_id;
      end if;
    end if;
    return v_id;
  end if;

  select d.priority into v_was from public.money_debts d
  where d.id = p_debt_id and d.tenant_id = p_tenant_id;

  update public.money_debts d
  set name = case when d.source = 'books' then d.name else v_name end,
      kind = coalesce(f.kind, d.kind), plan = coalesce(f.plan, d.plan),
      status = coalesce(f.status, d.status), rate_bp = f.rate_bp,
      minimum_cents = coalesce(f.minimum_cents, 0), payment_cents = f.payment_cents,
      revolving_bp = f.revolving_bp, due_day = f.due_day,
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

  -- A place given and changed is a move (the others shift around it). The
  -- same place as before, or none, keeps it where it is.
  if f.priority is not null and f.priority is distinct from v_was then
    if private.money_debt_renumber(p_tenant_id, v_id, f.priority) is null then
      update public.money_debts set priority = f.priority where id = v_id;
    end if;
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Importing details: a place nobody chose is filled by moving the debt there
-- ---------------------------------------------------------------------------

-- As before, except a place counts as "not set" while nobody has saved the
-- debt by hand (a debt new from the books is given the last place by
-- itself), and filling it is a move, so the order stays 1..N.
create or replace function public.import_money_debt_details(
  p_tenant_id uuid,
  p_request_key uuid,
  p_rows jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  d public.money_debts%rowtype;
  v_prior jsonb;
  v_claim uuid;
  v_fields int;
  v_place boolean;
  v_debts int := 0;
  v_filled int := 0;
  v_kept int := 0;
  v_missing int := 0;
  v_result jsonb;
begin
  perform private.require_manager(p_tenant_id);
  if p_request_key is null then
    raise exception 'Send a request key' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 200 then
    raise exception 'Send up to 200 rows' using errcode = '22023';
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
  perform private.lock_money_debts(p_tenant_id);

  for r in
    select x.debt_id, x.rate_bp, x.minimum_cents, x.payment_cents, x.plan, x.priority,
           x.due_day, left(nullif(btrim(coalesce(x.note, '')), ''), 500) as note
    from jsonb_to_recordset(p_rows) as x(
      debt_id uuid, rate_bp integer, minimum_cents bigint, payment_cents bigint, plan text,
      priority integer, due_day integer, note text)
  loop
    if (r.rate_bp is not null and r.rate_bp not between 0 and 100000)
       or (r.minimum_cents is not null and r.minimum_cents not between 0 and 100000000000)
       or (r.payment_cents is not null and r.payment_cents not between 0 and 100000000000)
       or (r.plan is not null and r.plan not in ('pool', 'fixed', 'revenue_share'))
       or (r.priority is not null and r.priority not between 1 and 999)
       or (r.due_day is not null and r.due_day not between 1 and 31) then
      raise exception 'A figure in that file isn''t one a debt can have' using errcode = '22023';
    end if;

    select * into d from public.money_debts m
    where m.id = r.debt_id and m.tenant_id = p_tenant_id
    for update;
    if not found then
      v_missing := v_missing + 1;
      continue;
    end if;

    v_fields := 0;
    v_place := false;
    if r.rate_bp is not null then
      if d.rate_bp is null then v_fields := v_fields + 1; else v_kept := v_kept + 1; end if;
    end if;
    if r.minimum_cents is not null then
      if d.minimum_cents = 0 then v_fields := v_fields + 1; else v_kept := v_kept + 1; end if;
    end if;
    if r.payment_cents is not null then
      if d.payment_cents is null then v_fields := v_fields + 1; else v_kept := v_kept + 1; end if;
    end if;
    if r.plan is not null then
      if d.updated_by is null then v_fields := v_fields + 1; else v_kept := v_kept + 1; end if;
    end if;
    if r.priority is not null then
      if d.priority is null or d.updated_by is null then
        v_fields := v_fields + 1;
        v_place := true;
      else
        v_kept := v_kept + 1;
      end if;
    end if;
    if r.due_day is not null then
      if d.due_day is null then v_fields := v_fields + 1; else v_kept := v_kept + 1; end if;
    end if;
    if r.note is not null then
      if d.note is null then v_fields := v_fields + 1; else v_kept := v_kept + 1; end if;
    end if;
    if v_fields = 0 then
      continue;
    end if;

    update public.money_debts m
    set rate_bp = case when m.rate_bp is null then coalesce(r.rate_bp, m.rate_bp) else m.rate_bp end,
        minimum_cents = case when m.minimum_cents = 0 then coalesce(r.minimum_cents, 0)
                             else m.minimum_cents end,
        payment_cents = coalesce(m.payment_cents, r.payment_cents),
        plan = case when m.updated_by is null then coalesce(r.plan, m.plan) else m.plan end,
        due_day = coalesce(m.due_day, r.due_day::smallint),
        note = coalesce(m.note, r.note),
        updated_by = auth.uid(),
        updated_at = now()
    where m.id = d.id;
    if v_place then
      if private.money_debt_renumber(p_tenant_id, d.id, r.priority) is null then
        update public.money_debts set priority = r.priority::smallint where id = d.id;
      end if;
    end if;
    v_debts := v_debts + 1;
    v_filled := v_filled + v_fields;
  end loop;

  v_result := jsonb_build_object('debts', v_debts, 'fields', v_filled, 'kept', v_kept,
                                 'missing', v_missing);
  update public.money_debt_imports set result = v_result where id = v_claim;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Put existing repeats and gaps right, once
-- ---------------------------------------------------------------------------

do $$
declare
  t uuid;
begin
  for t in select distinct d.tenant_id from public.money_debts d
  loop
    perform private.money_debt_renumber(t);
  end loop;
end;
$$;
