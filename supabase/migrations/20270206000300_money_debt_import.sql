-- Money: "Bring your debt details across" (Settings → Money → Debt payoff).
-- OWNERS AND ADMINS ONLY, as everything about debts.
--
-- A spreadsheet from an earlier app is read in the browser and matched to
-- the debts (from the books, or typed in) in code (`lib/dashboard/debt/
-- import.ts`: by account name exactly, then ignoring capitals and spaces,
-- never a guess between two). This one checked function writes it: under
-- each debt's row lock it fills ONLY the fields a person hasn't set (a rate
-- not given, a minimum of 0, no usual payment, no place, no due day, no
-- note; how it's paid only on a debt nobody has saved by hand), and never a
-- name, an account or a balance. Every press carries a request key: the
-- same key again returns the first answer and changes nothing, and the same
-- file again fills nothing, as everything in it is set by then.

create table public.money_debt_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  request_key uuid not null,
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  imported_by uuid references auth.users (id) on delete set null,
  imported_at timestamptz not null default now(),
  unique (tenant_id, request_key)
);
alter table public.money_debt_imports enable row level security;
create policy "owners and admins read their money_debt_imports" on public.money_debt_imports
  for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin']::public.membership_role[]));
revoke all on public.money_debt_imports from public, anon, authenticated, service_role;
grant select on public.money_debt_imports to authenticated, service_role;

-- p_rows: [{"debt_id", "rate_bp"?, "minimum_cents"?, "payment_cents"?, "plan"?,
--           "priority"?, "due_day"?, "note"?}], at most 200.
-- Returns {"debts": how many changed, "fields": how many fields were filled,
-- "kept": fields left as a person had them, "missing": rows naming no debt here}.
create function public.import_money_debt_details(
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

  -- Claim the key first: the same press again (even at the same moment)
  -- finds the first one's answer and changes nothing.
  insert into public.money_debt_imports (tenant_id, request_key, result, imported_by)
  values (p_tenant_id, p_request_key, '{}'::jsonb, auth.uid())
  on conflict (tenant_id, request_key) do nothing
  returning id into v_claim;
  if v_claim is null then
    select i.result into v_prior from public.money_debt_imports i
    where i.tenant_id = p_tenant_id and i.request_key = p_request_key;
    return coalesce(v_prior, '{}'::jsonb) || jsonb_build_object('again', true);
  end if;

  for r in
    select x.debt_id, x.rate_bp, x.minimum_cents, x.payment_cents, x.plan, x.priority,
           x.due_day, left(nullif(btrim(coalesce(x.note, '')), ''), 500) as note
    from jsonb_to_recordset(p_rows) as x(
      debt_id uuid, rate_bp integer, minimum_cents bigint, payment_cents bigint, plan text,
      priority integer, due_day integer, note text)
  loop
    -- What can't be right is refused whole, before anything is written.
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
      if d.priority is null then v_fields := v_fields + 1; else v_kept := v_kept + 1; end if;
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
        priority = coalesce(m.priority, r.priority::smallint),
        due_day = coalesce(m.due_day, r.due_day::smallint),
        note = coalesce(m.note, r.note),
        updated_by = auth.uid(),
        updated_at = now()
    where m.id = d.id;
    v_debts := v_debts + 1;
    v_filled := v_filled + v_fields;
  end loop;

  v_result := jsonb_build_object('debts', v_debts, 'fields', v_filled, 'kept', v_kept,
                                 'missing', v_missing);
  update public.money_debt_imports set result = v_result where id = v_claim;
  return v_result;
end;
$$;
revoke all on function public.import_money_debt_details(uuid, uuid, jsonb) from public, anon;
grant execute on function public.import_money_debt_details(uuid, uuid, jsonb) to authenticated;
