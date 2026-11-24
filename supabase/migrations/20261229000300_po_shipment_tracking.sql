-- Incoming orders, followed by UPS. Until now a tracking number's status was
-- only what a person recorded. Where the workspace has connected its own UPS
-- account, the worker now asks UPS about UPS numbers (1Z...) every few hours
-- and writes down what it was told: where the parcel has got to, when UPS
-- expects to deliver it, where and when it was last scanned, and when we
-- asked. Those are observed facts with the time they were observed; nothing
-- is worked out from them here ("late", "arrived", which date to show are all
-- decided on read).
--
-- What a person records (expected_on, arrived_on) is kept apart from what the
-- carrier said, so neither can overwrite the other.
--
-- Also here: which of an order's items, and how many, are in each parcel, as
-- TuftStock records them.

alter table public.purchase_order_shipments
  -- label: UPS has the details but not the parcel. not_found: UPS doesn't
  -- know the number (yet).
  add column carrier_status text
    check (carrier_status is null or carrier_status in
      ('label', 'on_the_way', 'out_for_delivery', 'delivered', 'problem', 'not_found')),
  -- UPS's own words for the latest scan.
  add column carrier_detail text check (carrier_detail is null or char_length(carrier_detail) <= 200),
  add column carrier_expected_on date,
  add column carrier_delivered_on date,
  add column carrier_scan_place text
    check (carrier_scan_place is null or char_length(carrier_scan_place) <= 120),
  add column carrier_scan_at timestamptz,
  -- When UPS was last asked, and what went wrong if it did.
  add column carrier_checked_at timestamptz,
  add column carrier_error text check (carrier_error is null or char_length(carrier_error) <= 300),
  -- A manager pressed "Check now".
  add column carrier_check_requested_at timestamptz,
  -- The worker has it in hand.
  add column carrier_claimed_at timestamptz;

-- What the worker looks through: parcels UPS hasn't delivered.
create index purchase_order_shipments_checks_idx
  on public.purchase_order_shipments (carrier_checked_at)
  where removed_at is null and tracking like '1Z%';

-- Which lines of the order are in a parcel, and how many of each.
create table public.purchase_order_shipment_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  shipment_id uuid not null references public.purchase_order_shipments (id) on delete cascade,
  po_line_id uuid not null references public.purchase_order_lines (id) on delete cascade,
  quantity int not null check (quantity between 1 and 1000000),
  unique (shipment_id, po_line_id)
);
create index purchase_order_shipment_items_tenant_idx
  on public.purchase_order_shipment_items (tenant_id, shipment_id);
alter table public.purchase_order_shipment_items enable row level security;
create policy "members read their purchase_order_shipment_items"
  on public.purchase_order_shipment_items
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));
revoke all on public.purchase_order_shipment_items from public, anon, authenticated, service_role;
grant select on public.purchase_order_shipment_items to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- What managers do
-- ---------------------------------------------------------------------------

-- Says what is in a parcel: [{"line_id", "quantity"}, ...]. The list replaces
-- whatever was there; an empty list means "not said". Every line must be on
-- the parcel's own order.
create function public.set_po_shipment_items(p_shipment_id uuid, p_items jsonb)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_shipment public.purchase_order_shipments;
  v_count int;
begin
  select * into v_shipment from public.purchase_order_shipments s
  where s.id = p_shipment_id and s.removed_at is null
    and s.tenant_id in (select private.user_tenant_ids());
  if not found then
    raise exception 'Tracking number not found' using errcode = 'P0002';
  end if;
  perform private.manager_po(v_shipment.po_id);
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' then
    raise exception 'How many are in it?' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as i(line_id uuid, quantity int)
    where i.line_id is null or i.quantity is null or i.quantity < 1 or i.quantity > 1000000
       or not exists (
         select 1 from public.purchase_order_lines l
         where l.id = i.line_id and l.po_id = v_shipment.po_id)
  ) then
    raise exception 'How many are in it?' using errcode = '22023';
  end if;
  delete from public.purchase_order_shipment_items i where i.shipment_id = v_shipment.id;
  insert into public.purchase_order_shipment_items (tenant_id, shipment_id, po_line_id, quantity)
  select v_shipment.tenant_id, v_shipment.id, i.line_id, least(sum(i.quantity), 1000000)::int
  from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as i(line_id uuid, quantity int)
  group by i.line_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- True when a workspace has its own UPS account connected for real (not the
-- practice system, whose tracking answers are made up).
create function private.ups_can_track(p_tenant_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.connections c
    where c.tenant_id = p_tenant_id and c.provider = 'ups' and c.status = 'active'
      and coalesce(c.metadata ->> 'mode', 'production') <> 'test');
$$;
revoke all on function private.ups_can_track(uuid) from public;

-- "Check now": asks for one parcel to be looked up at the worker's next
-- turn. Not more than once every ten minutes for a parcel, so a row of
-- presses can't turn into a row of calls to UPS.
create function public.request_po_shipment_check(p_shipment_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_shipment public.purchase_order_shipments;
begin
  select * into v_shipment from public.purchase_order_shipments s
  where s.id = p_shipment_id and s.removed_at is null
    and s.tenant_id in (select private.user_tenant_ids())
  for update;
  if not found then
    raise exception 'Tracking number not found' using errcode = 'P0002';
  end if;
  perform private.manager_po(v_shipment.po_id);
  if v_shipment.tracking !~ '^1Z[0-9A-Z]{16}$' then
    raise exception 'not_ups' using errcode = 'P0001';
  end if;
  if not private.ups_can_track(v_shipment.tenant_id) then
    raise exception 'no_ups' using errcode = 'P0001';
  end if;
  if greatest(v_shipment.carrier_checked_at, v_shipment.carrier_check_requested_at)
       > now() - interval '10 minutes' then
    raise exception 'too_soon' using errcode = 'P0001';
  end if;
  update public.purchase_order_shipments s set carrier_check_requested_at = now()
  where s.id = v_shipment.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- The worker (service role)
-- ---------------------------------------------------------------------------

-- UPS parcels due a look, one worker each. Due means: someone pressed "Check
-- now"; or it hasn't been delivered or marked as arrived, its order is still
-- open, it was added in the last 45 days, and it hasn't been asked about for
-- four hours. Only for workspaces with their own UPS account connected.
create function public.claim_po_shipment_checks(p_limit int default 20)
returns table (id uuid, tenant_id uuid, tracking text)
language sql security definer set search_path = ''
as $$
  with due as (
    select s.id from public.purchase_order_shipments s
    join public.purchase_orders po on po.id = s.po_id
    where s.removed_at is null and s.tracking ~ '^1Z[0-9A-Z]{16}$'
      and (s.carrier_claimed_at is null or s.carrier_claimed_at < now() - interval '15 minutes')
      and private.ups_can_track(s.tenant_id)
      and (
        s.carrier_check_requested_at is not null
        or (
          s.arrived_on is null
          and s.carrier_status is distinct from 'delivered'
          and po.status in ('ordered', 'partial')
          and s.created_at > now() - interval '45 days'
          and (s.carrier_checked_at is null or s.carrier_checked_at < now() - interval '4 hours')
        )
      )
    order by s.carrier_check_requested_at nulls last, s.carrier_checked_at nulls first
    limit greatest(1, least(coalesce(p_limit, 20), 50))
    for update of s skip locked
  )
  update public.purchase_order_shipments s set carrier_claimed_at = now()
  from due where s.id = due.id
  returning s.id, s.tenant_id, s.tracking;
$$;

-- Writes down what UPS said:
--   {"status", "detail", "expected_on", "delivered_on", "scan_place", "scan_at"}
-- or, when the look-up didn't work, {"error": "..."}: what was known before is
-- kept, and the time is still noted so the next try waits its turn.
-- A "not found" never replaces something UPS told us earlier.
create function public.finish_po_shipment_check(p_id uuid, p_result jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_status text := p_result ->> 'status';
begin
  if p_result ? 'error' or v_status is null then
    update public.purchase_order_shipments s
    set carrier_error = left(coalesce(p_result ->> 'error', 'UPS gave no answer'), 300),
        carrier_checked_at = now(), carrier_check_requested_at = null, carrier_claimed_at = null
    where s.id = p_id;
    return;
  end if;
  if v_status not in ('label', 'on_the_way', 'out_for_delivery', 'delivered', 'problem', 'not_found') then
    raise exception 'Unknown status' using errcode = '22023';
  end if;
  update public.purchase_order_shipments s
  set carrier_status = case
        when v_status = 'not_found' and s.carrier_status is not null then s.carrier_status
        else v_status end,
      carrier_detail = case when v_status = 'not_found' then s.carrier_detail
        else left(nullif(btrim(p_result ->> 'detail'), ''), 200) end,
      -- UPS drops its estimate once a parcel is delivered; keep the last one it gave.
      carrier_expected_on = coalesce((p_result ->> 'expected_on')::date, s.carrier_expected_on),
      carrier_delivered_on = case when v_status = 'not_found' then s.carrier_delivered_on
        else (p_result ->> 'delivered_on')::date end,
      carrier_scan_place = case when v_status = 'not_found' then s.carrier_scan_place
        else left(nullif(btrim(p_result ->> 'scan_place'), ''), 120) end,
      carrier_scan_at = case when v_status = 'not_found' then s.carrier_scan_at
        else (p_result ->> 'scan_at')::timestamptz end,
      carrier_error = null, carrier_checked_at = now(), carrier_check_requested_at = null,
      carrier_claimed_at = null
  where s.id = p_id;
end;
$$;

revoke all on function public.set_po_shipment_items(uuid, jsonb) from public, anon;
grant execute on function public.set_po_shipment_items(uuid, jsonb) to authenticated;
revoke all on function public.request_po_shipment_check(uuid) from public, anon;
grant execute on function public.request_po_shipment_check(uuid) to authenticated;
revoke all on function public.claim_po_shipment_checks(int) from public, anon, authenticated;
grant execute on function public.claim_po_shipment_checks(int) to service_role;
revoke all on function public.finish_po_shipment_check(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.finish_po_shipment_check(uuid, jsonb) to service_role;

-- A different number is a different parcel: what UPS said about the old one
-- doesn't carry over.
create function private.purchase_order_shipments_new_number()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.tracking is distinct from old.tracking then
    new.carrier_status := null;
    new.carrier_detail := null;
    new.carrier_expected_on := null;
    new.carrier_delivered_on := null;
    new.carrier_scan_place := null;
    new.carrier_scan_at := null;
    new.carrier_checked_at := null;
    new.carrier_error := null;
  end if;
  return new;
end;
$$;
revoke all on function private.purchase_order_shipments_new_number() from public;
create trigger purchase_order_shipments_new_number
  before update on public.purchase_order_shipments
  for each row execute function private.purchase_order_shipments_new_number();
