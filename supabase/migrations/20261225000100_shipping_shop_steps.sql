-- Shipping: keeping the shop in step in three more places.
--
--   1. Voids. A parcel that was marked as sent in the shop and is then undone
--      here is also undone there: the worker cancels that fulfilment, so the
--      order shows as unfulfilled again. The shop's own id for the fulfilment
--      is kept when a parcel is pushed, so it can be found again.
--   2. Pickups. "Ready for pickup" and "picked up" are passed on to the shop
--      (which emails the customer to come and collect), when the workspace
--      wants that and the shop allows it.
--   3. Part shipments with a bought label. A quote remembers which items and
--      how many it was priced for, and recording uses exactly those.
--
-- Every shop step follows the same once-only queue as "mark as sent": the
-- worker claims a row, tries once and writes down what happened. A step that
-- was claimed and never finished is marked as failed, not tried again, since
-- a repeat could email a customer twice.
--
-- No new tables: everything hangs off `shipments`, `shipping_orders` and
-- `shipping_label_quotes`, which already carry tenant_id and RLS.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.shipments
  -- The shop's own id for the fulfilment this parcel became there.
  add column shop_fulfilment_id text
    check (shop_fulfilment_id is null or char_length(shop_fulfilment_id) <= 200),
  -- Undoing it in the shop after a void. none: nothing to undo. done: the
  -- order is unfulfilled there again. not_found: the shop had no fulfilment
  -- of ours to cancel. not_allowed: the shop is connected without permission
  -- to change it. failed: see shop_undo_error.
  add column shop_undo_status text not null default 'none'
    check (shop_undo_status in
      ('none', 'pending', 'sending', 'done', 'not_found', 'not_allowed', 'failed')),
  add column shop_undo_error text,
  add column shop_undo_at timestamptz;
create index shipments_undo_idx on public.shipments (shop_undo_status)
  where shop_undo_status in ('pending', 'sending');

alter table public.shipping_orders
  -- Telling the shop about each pickup step. none: the shop isn't told (the
  -- workspace's choice, or nothing to tell). not_allowed: it would have been,
  -- but the shop is connected without permission to change it.
  add column pickup_ready_shop_status text not null default 'none'
    check (pickup_ready_shop_status in
      ('none', 'pending', 'sending', 'sent', 'not_allowed', 'failed')),
  add column pickup_ready_shop_error text,
  add column picked_up_shop_status text not null default 'none'
    check (picked_up_shop_status in
      ('none', 'pending', 'sending', 'sent', 'not_allowed', 'failed')),
  add column picked_up_shop_error text,
  add column pickup_shop_synced_at timestamptz;
create index shipping_orders_pickup_shop_idx
  on public.shipping_orders (pickup_shop_synced_at)
  where pickup_ready_shop_status in ('pending', 'sending')
     or picked_up_shop_status in ('pending', 'sending');

alter table public.shipping_label_quotes
  -- [{"line_id", "qty"}]: the items this label was priced for, when it is for
  -- part of what's left on the order. Null: everything left.
  add column part_items jsonb
    check (part_items is null or jsonb_typeof(part_items) = 'array'),
  -- After a part shipment, set what's left aside until it can go.
  add column hold_rest boolean not null default true;

-- ---------------------------------------------------------------------------
-- What the shop will let us do, and what the workspace wants
-- ---------------------------------------------------------------------------

-- Whether this workspace's shop is connected with permission to change
-- fulfilments. The same test as `canSendInShopify` in the app. A shop
-- connected watch-only never passes, so nothing is ever queued for it.
create function private.shop_can_fulfil(p_tenant_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.connections c
    where c.tenant_id = p_tenant_id and c.provider = 'shopify' and c.status = 'active'
      and 'write_merchant_managed_fulfillment_orders' = any (c.scopes));
$$;
revoke all on function private.shop_can_fulfil(uuid) from public;

-- How a pickup step for this workspace starts out: 'none' when the workspace
-- has switched "Tell my shop about pickups" off (it is on unless switched
-- off), 'not_allowed' when the shop won't take it, else 'pending'.
create function private.pickup_shop_start(p_tenant_id uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select case
    when exists (
      select 1 from public.configs c
      where c.tenant_id = p_tenant_id and c.module = 'shipping' and c.key = 'settings'
        and c.body -> 'tell_shop_pickups' = 'false'::jsonb) then 'none'
    when not private.shop_can_fulfil(p_tenant_id) then 'not_allowed'
    else 'pending' end;
$$;
revoke all on function private.pickup_shop_start(uuid) from public;

-- ---------------------------------------------------------------------------
-- Pickups: the same three functions as before, now also queueing the word
-- to the shop. A step the shop has already heard (or is hearing right now)
-- is never queued a second time.
-- ---------------------------------------------------------------------------

create or replace function public.mark_pickup_ready(p_tenant_id uuid, p_ids uuid[])
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
  v_start text;
begin
  perform private.require_member(p_tenant_id);
  v_start := private.pickup_shop_start(p_tenant_id);
  update public.shipping_orders so
  set pickup_ready_at = now(),
      pickup_ready_shop_status = case
        when so.pickup_ready_shop_status in ('sent', 'sending') then so.pickup_ready_shop_status
        when so.provider = 'shopify' then v_start
        else 'none' end,
      pickup_ready_shop_error = case
        when so.pickup_ready_shop_status in ('sent', 'sending') then so.pickup_ready_shop_error
        else null end
  where so.tenant_id = p_tenant_id and so.id = any (coalesce(p_ids, '{}'))
    and so.pickup and so.pickup_ready_at is null and so.picked_up_at is null
    and not so.cancelled and so.units_left > 0;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.mark_picked_up(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.shipping_orders := private.member_shipping_order(p_id);
  v_start text;
begin
  if not v_order.pickup then
    raise exception 'This order is not for pickup' using errcode = 'P0001';
  end if;
  if v_order.cancelled then
    raise exception 'This order was cancelled' using errcode = 'P0001';
  end if;
  v_start := case when v_order.provider = 'shopify'
                  then private.pickup_shop_start(v_order.tenant_id) else 'none' end;
  update public.shipping_orders so
  set picked_up_at = coalesce(so.picked_up_at, now()),
      pickup_ready_at = coalesce(so.pickup_ready_at, now()),
      on_hold = false, hold_reason = '', hold_until = null,
      picked_up_shop_status = case
        when so.picked_up_at is not null
          or so.picked_up_shop_status in ('sent', 'sending') then so.picked_up_shop_status
        else v_start end,
      picked_up_shop_error = case
        when so.picked_up_at is not null
          or so.picked_up_shop_status in ('sent', 'sending') then so.picked_up_shop_error
        else null end,
      -- They have it in their hands: a "come and collect" email still
      -- waiting to go would only confuse.
      pickup_ready_shop_status = case
        when so.pickup_ready_shop_status = 'pending' then 'none'
        else so.pickup_ready_shop_status end
  where so.id = v_order.id;
end;
$$;

-- Steps a pickup back one, as before. A word to the shop that hasn't gone
-- yet is dropped; one that has gone can't be taken back from here (the page
-- says so), and is remembered so the step is never told twice.
create or replace function public.undo_pickup(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.shipping_orders := private.member_shipping_order(p_id);
begin
  perform private.require_manager(v_order.tenant_id);
  update public.shipping_orders so
  set picked_up_at = null,
      pickup_ready_at = case when v_order.picked_up_at is null then null else so.pickup_ready_at end,
      picked_up_shop_status = case
        when v_order.picked_up_at is not null
          and so.picked_up_shop_status not in ('sent', 'sending') then 'none'
        else so.picked_up_shop_status end,
      picked_up_shop_error = case
        when v_order.picked_up_at is not null
          and so.picked_up_shop_status not in ('sent', 'sending') then null
        else so.picked_up_shop_error end,
      pickup_ready_shop_status = case
        when v_order.picked_up_at is null
          and so.pickup_ready_shop_status not in ('sent', 'sending') then 'none'
        else so.pickup_ready_shop_status end,
      pickup_ready_shop_error = case
        when v_order.picked_up_at is null
          and so.pickup_ready_shop_status not in ('sent', 'sending') then null
        else so.pickup_ready_shop_error end
  where so.id = v_order.id;
end;
$$;

-- Pickup steps waiting to be passed on to the shop. One worker gets each,
-- once. "Picked up" waits while "ready" is still on its way.
create function public.claim_pickup_steps(p_limit int default 20)
returns table (
  id uuid, tenant_id uuid, name text, provider text, order_external_id text, step text,
  can_write boolean
)
language plpgsql security definer set search_path = ''
as $$
begin
  -- Claimed and never finished: we can't know whether the shop heard, and
  -- asking again could email the customer twice.
  update public.shipping_orders so
  set pickup_ready_shop_status = case when so.pickup_ready_shop_status = 'sending'
                                      then 'failed' else so.pickup_ready_shop_status end,
      pickup_ready_shop_error = case when so.pickup_ready_shop_status = 'sending'
        then 'We lost touch part-way through, so we can''t tell whether your shop heard'
        else so.pickup_ready_shop_error end,
      picked_up_shop_status = case when so.picked_up_shop_status = 'sending'
                                   then 'failed' else so.picked_up_shop_status end,
      picked_up_shop_error = case when so.picked_up_shop_status = 'sending'
        then 'We lost touch part-way through, so we can''t tell whether your shop heard'
        else so.picked_up_shop_error end
  where (so.pickup_ready_shop_status = 'sending' or so.picked_up_shop_status = 'sending')
    and so.pickup_shop_synced_at < now() - interval '15 minutes';

  return query
  with due as (
    select so.id,
           case when so.pickup_ready_shop_status = 'pending' then 'ready' else 'picked_up' end
             as step
    from public.shipping_orders so
    where so.pickup_ready_shop_status = 'pending'
       or (so.picked_up_shop_status = 'pending' and so.pickup_ready_shop_status <> 'sending')
    order by so.pickup_ready_at nulls last, so.id
    limit greatest(1, least(coalesce(p_limit, 20), 100))
    for update skip locked
  ), taken as (
    update public.shipping_orders so
    set pickup_ready_shop_status = case when due.step = 'ready' then 'sending'
                                        else so.pickup_ready_shop_status end,
        picked_up_shop_status = case when due.step = 'picked_up' then 'sending'
                                     else so.picked_up_shop_status end,
        pickup_shop_synced_at = now()
    from due where so.id = due.id
    returning so.id, so.tenant_id, so.name, so.provider, so.external_id, due.step
  )
  select taken.id, taken.tenant_id, taken.name, taken.provider, taken.external_id, taken.step,
         private.shop_can_fulfil(taken.tenant_id)
  from taken;
end;
$$;

create function public.finish_pickup_step(
  p_id uuid,
  p_step text,
  p_outcome text,
  p_error text default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_outcome is null or p_outcome not in ('sent', 'not_allowed', 'failed') then
    raise exception 'Unknown outcome' using errcode = '22023';
  end if;
  if p_step = 'ready' then
    update public.shipping_orders so
    set pickup_ready_shop_status = p_outcome,
        pickup_ready_shop_error = case when p_outcome = 'failed' then left(p_error, 500) end,
        pickup_shop_synced_at = now()
    where so.id = p_id and so.pickup_ready_shop_status = 'sending';
  elsif p_step = 'picked_up' then
    update public.shipping_orders so
    set picked_up_shop_status = p_outcome,
        picked_up_shop_error = case when p_outcome = 'failed' then left(p_error, 500) end,
        pickup_shop_synced_at = now()
    where so.id = p_id and so.picked_up_shop_status = 'sending';
  else
    raise exception 'Unknown step' using errcode = '22023';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Voids reach the shop
-- ---------------------------------------------------------------------------

-- "Marked as sent in the shop", with the shop's id for the fulfilment it
-- made, kept so the parcel can be undone there. A parcel that was undone
-- here while the worker was still telling the shop is caught too: the shop
-- now shows it as sent, so undoing it there is queued straight away.
create function public.finish_shipment_send_with(
  p_id uuid,
  p_error text default null,
  p_fulfilment_id text default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.shipments s
  set shop_status = case when p_error is null then 'sent' else 'failed' end,
      shop_error = left(p_error, 500), shop_synced_at = now(),
      shop_fulfilment_id = case when p_error is null then left(p_fulfilment_id, 200) end
  where s.id = p_id and s.shop_status = 'sending';
  if not found and p_error is null then
    update public.shipments s
    set shop_status = 'sent', shop_error = null, shop_synced_at = now(),
        shop_fulfilment_id = left(p_fulfilment_id, 200),
        shop_undo_status = case when private.shop_can_fulfil(s.tenant_id)
                                then 'pending' else 'not_allowed' end
    where s.id = p_id and s.voided_at is not null and s.shop_status = 'skipped'
      and s.shop_undo_status = 'none' and s.shop_synced_at is not null
      and s.shipping_order_id is not null;
  end if;
end;
$$;

-- Undoes a shipment, as before (owners and admins; a parcel that carried
-- other orders takes them with it). What is new: every order in it that the
-- shop was told about is queued to be undone there too, so the order shows
-- as unfulfilled again. A shop connected without permission to change
-- anything is never queued: the parcel is marked "not allowed" and the page
-- asks the person to undo it in the shop. Still returns 'sent' when any of
-- them was marked as sent in the shop.
create or replace function public.void_shipment(p_id uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_shipment public.shipments;
  v_rider public.shipments;
  v_status text;
  v_undo text;
begin
  select * into v_shipment from public.shipments s
  where s.id = p_id and s.tenant_id in (select private.user_tenant_ids())
  for update;
  if not found or v_shipment.voided_at is not null then
    raise exception 'Shipment not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_shipment.tenant_id);
  if v_shipment.merged_with is not null and exists (
    select 1 from public.shipments p
    where p.id = v_shipment.merged_with and p.voided_at is null) then
    raise exception 'This order was sent together with another; undo that parcel instead'
      using errcode = 'P0001';
  end if;
  v_undo := case when private.shop_can_fulfil(v_shipment.tenant_id)
                 then 'pending' else 'not_allowed' end;
  update public.shipments s
  set voided_at = now(),
      shop_status = case when s.shop_status in ('pending', 'sending') then 'skipped' else s.shop_status end,
      shop_undo_status = case when s.shop_status = 'sent' and s.shipping_order_id is not null
                              then v_undo else s.shop_undo_status end
  where s.id = v_shipment.id;
  if v_shipment.shipping_order_id is not null then
    perform private.adjust_shipping_left(v_shipment.shipping_order_id, v_shipment.items, 1);
  end if;
  v_status := v_shipment.shop_status;

  for v_rider in
    select * from public.shipments r
    where r.merged_with = v_shipment.id and r.tenant_id = v_shipment.tenant_id
      and r.voided_at is null
    order by r.number
    for update
  loop
    update public.shipments s
    set voided_at = now(),
        shop_status = case when s.shop_status in ('pending', 'sending') then 'skipped' else s.shop_status end,
        shop_undo_status = case when s.shop_status = 'sent' and s.shipping_order_id is not null
                                then v_undo else s.shop_undo_status end
    where s.id = v_rider.id;
    if v_rider.shipping_order_id is not null then
      perform private.adjust_shipping_left(v_rider.shipping_order_id, v_rider.items, 1);
    end if;
    if v_rider.shop_status = 'sent' then
      v_status := 'sent';
    end if;
  end loop;
  return v_status;
end;
$$;

-- Voided parcels waiting to be undone in the shop. One worker gets each,
-- once. An order that rode along is found by every tracking number of the
-- parcel it went in, the way it was sent.
create function public.claim_shipment_undos(p_limit int default 20)
returns table (
  id uuid, tenant_id uuid, number int, order_name text, provider text, order_external_id text,
  fulfilment_id text, tracking_numbers text[], can_write boolean
)
language plpgsql security definer set search_path = ''
as $$
begin
  -- Claimed and never finished: said plainly rather than tried again.
  update public.shipments s
  set shop_undo_status = 'failed', shop_undo_at = now(),
      shop_undo_error = 'We lost touch part-way through, so we can''t tell whether your shop heard'
  where s.shop_undo_status = 'sending' and s.shop_undo_at < now() - interval '15 minutes';

  return query
  with due as (
    select s.id from public.shipments s
    where s.shop_undo_status = 'pending' and s.voided_at is not null
    order by s.voided_at
    limit greatest(1, least(coalesce(p_limit, 20), 100))
    for update skip locked
  ), taken as (
    update public.shipments s set shop_undo_status = 'sending', shop_undo_at = now()
    from due where s.id = due.id
    returning s.*
  )
  select taken.id, taken.tenant_id, taken.number, taken.order_name, so.provider, so.external_id,
         taken.shop_fulfilment_id,
         coalesce(boxes.numbers,
                  case when taken.tracking_number <> '' then array[taken.tracking_number]
                       else '{}'::text[] end),
         private.shop_can_fulfil(taken.tenant_id)
  from taken
  left join public.shipping_orders so on so.id = taken.shipping_order_id
  left join public.shipments lead
    on lead.id = taken.merged_with and lead.tenant_id = taken.tenant_id
  left join lateral (
    select array_agg(e.b ->> 'tracking_number' order by e.n) as numbers
    from jsonb_array_elements(coalesce(taken.label_parcels, lead.label_parcels))
         with ordinality as e(b, n)
    where coalesce(e.b ->> 'tracking_number', '') <> ''
  ) boxes on true;
end;
$$;

create function public.finish_shipment_undo(p_id uuid, p_outcome text, p_error text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_outcome is null or p_outcome not in ('done', 'not_found', 'not_allowed', 'failed') then
    raise exception 'Unknown outcome' using errcode = '22023';
  end if;
  update public.shipments s
  set shop_undo_status = p_outcome,
      shop_undo_error = case when p_outcome = 'failed' then left(p_error, 500) end,
      shop_undo_at = now()
  where s.id = p_id and s.shop_undo_status = 'sending';
end;
$$;

-- ---------------------------------------------------------------------------
-- Part shipments with a bought label
-- ---------------------------------------------------------------------------

-- Stores the rates for an order (with others riding along, or none), as
-- before. Asking again always starts from "everything left": a quote that
-- was for part of the order doesn't keep its items when it is replaced.
create or replace function public.save_group_label_quote(
  p_tenant_id uuid,
  p_shipping_order_id uuid,
  p_created_by uuid,
  p_provider_shipment_id text,
  p_rates jsonb,
  p_kind text,
  p_boxes int,
  p_rider_ids uuid[]
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_kind text := coalesce(p_kind, 'shipment');
  v_boxes int := coalesce(p_boxes, 1);
  v_riders uuid[];
begin
  if not exists (
    select 1 from public.shipping_orders so
    where so.id = p_shipping_order_id and so.tenant_id = p_tenant_id) then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.tenant_id = p_tenant_id and m.user_id = p_created_by) then
    raise exception 'Workspace not found' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rates) is distinct from 'array' or jsonb_array_length(p_rates) > 80 then
    raise exception 'Rates are not a list' using errcode = '22023';
  end if;
  if v_kind not in ('shipment', 'order') or v_boxes not between 1 and 6
     or (v_kind = 'order') <> (v_boxes > 1) then
    raise exception 'Boxes are not right' using errcode = '22023';
  end if;
  select coalesce(array_agg(d.x order by d.x), '{}') into v_riders
  from (select distinct x from unnest(coalesce(p_rider_ids, '{}')) x
        where x is not null and x <> p_shipping_order_id) d;
  if cardinality(v_riders) > 9 or (
    select count(*) from public.shipping_orders so
    where so.tenant_id = p_tenant_id and so.id = any (v_riders)) <> cardinality(v_riders) then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  insert into public.shipping_label_quotes as q
    (tenant_id, shipping_order_id, created_by, provider_shipment_id, rates, label_kind, box_count,
     rider_ids)
  values
    (p_tenant_id, p_shipping_order_id, p_created_by, p_provider_shipment_id, p_rates, v_kind,
     v_boxes, v_riders)
  on conflict (shipping_order_id, created_by) where status = 'quoted' do update set
    provider_shipment_id = excluded.provider_shipment_id, rates = excluded.rates,
    label_kind = excluded.label_kind, box_count = excluded.box_count,
    rider_ids = excluded.rider_ids, created_at = now(),
    part_items = null, hold_rest = true
  returning q.id into v_id;
  return v_id;
end;
$$;

-- The same quote, for only some of what's left on one order. Written by the
-- server with the service role. The items are checked against the order
-- here: every line must be on it, with no more than is still to go. A "part"
-- that turns out to be everything left is stored as a whole-order quote.
create function public.save_part_label_quote(
  p_tenant_id uuid,
  p_shipping_order_id uuid,
  p_created_by uuid,
  p_provider text,
  p_provider_shipment_id text,
  p_rates jsonb,
  p_kind text,
  p_boxes int,
  p_request_hash text,
  p_part_items jsonb
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.shipping_orders;
  v_part jsonb;
  v_id uuid;
begin
  select * into v_order from public.shipping_orders so
  where so.id = p_shipping_order_id and so.tenant_id = p_tenant_id;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_part_items) is distinct from 'array'
     or jsonb_array_length(p_part_items) not between 1 and 250
     or exists (
       select 1 from jsonb_array_elements(p_part_items) s
       where coalesce(s ->> 'line_id', '') = '' or coalesce(s ->> 'qty', '') !~ '^[0-9]{1,6}$') then
    raise exception 'Items are not a list' using errcode = '22023';
  end if;
  -- Every line asked for must be on the order, with that many still to go.
  if exists (
    select 1
    from (select s ->> 'line_id' as line_id, sum((s ->> 'qty')::int)::int as qty
          from jsonb_array_elements(p_part_items) s group by 1) w
    left join jsonb_array_elements(v_order.items) i on i ->> 'line_id' = w.line_id
    where w.qty > 0 and (i is null or (i ->> 'left')::int < w.qty)) then
    raise exception 'Those items are not left to send on this order' using errcode = 'P0001';
  end if;
  select jsonb_agg(jsonb_build_object('line_id', w.line_id, 'qty', w.qty) order by e.n)
  into v_part
  from jsonb_array_elements(v_order.items) with ordinality as e(i, n)
  join (select s ->> 'line_id' as line_id, sum((s ->> 'qty')::int)::int as qty
        from jsonb_array_elements(p_part_items) s group by 1) w
    on w.line_id = e.i ->> 'line_id'
  where w.qty > 0;
  if v_part is null then
    raise exception 'Pick at least one item to send now' using errcode = 'P0001';
  end if;
  -- Everything that's left: an ordinary label for the whole order.
  if (select coalesce(sum((p ->> 'qty')::int), 0) from jsonb_array_elements(v_part) p)
     >= v_order.units_left then
    v_part := null;
  end if;

  v_id := public.save_label_quote_from(
    p_tenant_id, p_shipping_order_id, p_created_by, p_provider, p_provider_shipment_id, p_rates,
    p_kind, p_boxes, '{}'::uuid[], p_request_hash);
  update public.shipping_label_quotes q set part_items = v_part, hold_rest = true
  where q.id = v_id;
  return v_id;
end;
$$;

-- Whether what's left after a part shipment is set aside. The one thing
-- about a part label a person may still change after the price is in: it
-- changes nothing about what is bought or which items go.
create function public.set_label_quote_hold_rest(p_quote_id uuid, p_hold boolean)
returns void
language sql security definer set search_path = ''
as $$
  update public.shipping_label_quotes q
  set hold_rest = coalesce(p_hold, true)
  where q.id = p_quote_id and q.tenant_id in (select private.user_tenant_ids())
    and q.status in ('quoted', 'buying', 'bought') and q.part_items is not null;
$$;

-- Marks a quote as being bought, as before, and now also says which items
-- the quote was priced for, so the server can check the screen still shows
-- the same before it spends anything.
create or replace function private.start_label_purchase(
  p_quote public.shipping_label_quotes,
  p_rate_id text
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_rate jsonb := (
    select r from jsonb_array_elements(p_quote.rates) r where r ->> 'id' = p_rate_id limit 1);
  v_provider text := coalesce(nullif(v_rate ->> 'source', ''), p_quote.provider);
  -- EasyPost's own id for what it quoted, where the rate carries one.
  v_shipment text := coalesce(
    nullif(left(v_rate -> 'ref' ->> 'shipment_id', 120), ''), p_quote.provider_shipment_id);
begin
  if v_provider not in ('easypost', 'ups', 'redo') then
    raise exception 'That rate was not quoted for this order' using errcode = 'P0002';
  end if;
  update public.shipping_label_quotes q
  set status = 'buying', buying_at = now(), bought_by = auth.uid(), rate_id = p_rate_id,
      provider = v_provider, provider_shipment_id = v_shipment
  where q.id = p_quote.id;
  return jsonb_build_object(
    'quote_id', p_quote.id,
    'provider', v_provider,
    'provider_shipment_id', v_shipment,
    'kind', p_quote.label_kind,
    'boxes', p_quote.box_count,
    'request_hash', p_quote.request_hash,
    'part', p_quote.part_items,
    'rate', v_rate);
end;
$$;

-- Records the parcel for a bought label, as before (see the ship-together
-- migration for orders riding along). A label that was priced for part of
-- an order records exactly the items and amounts kept on its quote, never
-- anything said at buying time; the shop is told about just those lines.
-- What's left is then put on hold with a note saying what it's waiting on,
-- unless the person asked for it to stay in the queue.
create or replace function public.record_label_shipment(
  p_quote_id uuid,
  p_push boolean default false,
  p_notify boolean default false
)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_quote public.shipping_label_quotes;
  v_order_name text;
  v_number int;
  v_parcel uuid;
  v_rider uuid;
  v_rider_number int;
  v_rider_name text;
  v_names text[];
  v_on_order boolean := true;
begin
  select * into v_quote from public.shipping_label_quotes q
  where q.id = p_quote_id and q.tenant_id in (select private.user_tenant_ids())
  for update;
  if not found or v_quote.status <> 'bought' then
    raise exception 'Label not found' using errcode = 'P0002';
  end if;
  select so.name into v_order_name from public.shipping_orders so
  where so.id = v_quote.shipping_order_id;

  begin
    v_number := public.record_shipment(
      v_quote.tenant_id, v_quote.shipping_order_id, v_quote.carrier, v_quote.service,
      v_quote.tracking_number, v_quote.tracking_url, v_quote.price,
      coalesce(v_quote.part_items, '[]'::jsonb), '',
      p_push, p_notify);
  exception when sqlstate 'P0001' then
    v_on_order := false;
    v_number := public.record_shipment(
      v_quote.tenant_id, null, v_quote.carrier, v_quote.service,
      v_quote.tracking_number, v_quote.tracking_url, v_quote.price, '[]'::jsonb,
      'Label bought for ' || coalesce(v_order_name, 'an order') || ' after it was already marked as sent',
      false, false);
  end;

  update public.shipments s
  set label_provider = v_quote.provider, label_shipment_id = v_quote.provider_shipment_id,
      label_url = v_quote.label_url, label_mode = v_quote.label_mode,
      label_parcels = v_quote.parcels,
      order_name = coalesce(s.order_name, v_order_name)
  where s.tenant_id = v_quote.tenant_id and s.number = v_number
  returning s.id into v_parcel;

  -- Part sent: the rest waits, with a note saying what for.
  if v_on_order and v_quote.part_items is not null and v_quote.hold_rest then
    update public.shipping_orders so
    set on_hold = true, hold_until = null,
        hold_reason = left('Part sent — waiting on: ' || coalesce((
          select string_agg(
                   (e.i ->> 'left') || ' × ' || coalesce(e.i ->> 'title', 'item')
                   || case when coalesce(e.i ->> 'variant', '') <> ''
                           then ' (' || (e.i ->> 'variant') || ')' else '' end,
                   ', ' order by e.n)
          from jsonb_array_elements(so.items) with ordinality as e(i, n)
          where (e.i ->> 'left')::int > 0), 'the rest'), 300)
    where so.id = v_quote.shipping_order_id and so.units_left > 0 and not so.cancelled;
  end if;

  if cardinality(v_quote.rider_ids) > 0 then
    v_names := array[coalesce(v_order_name, 'Order')];
    -- Oldest first, the way the group reads everywhere else.
    for v_rider in
      select so.id from public.shipping_orders so
      where so.tenant_id = v_quote.tenant_id and so.id = any (v_quote.rider_ids)
      order by so.placed_at, so.id
    loop
      begin
        v_rider_number := public.record_shipment(
          v_quote.tenant_id, v_rider, v_quote.carrier, v_quote.service,
          v_quote.tracking_number, v_quote.tracking_url, null, '[]'::jsonb,
          'Sent together with ' || coalesce(v_order_name, 'another order'),
          p_push, p_notify);
        update public.shipments s set merged_with = v_parcel
        where s.tenant_id = v_quote.tenant_id and s.number = v_rider_number
        returning s.order_name into v_rider_name;
        v_names := v_names || coalesce(v_rider_name, 'Order');
      exception when sqlstate 'P0001' or sqlstate 'P0002' then
        -- Already sent another way, or no longer here: nothing to record for
        -- it. Any other trouble is passed on, which undoes the lot.
        if sqlerrm not like 'Nothing left to send%' and sqlerrm <> 'Order not found' then
          raise;
        end if;
      end;
    end loop;
    if cardinality(v_names) > 1 then
      update public.shipments s set order_name = left(array_to_string(v_names, ' + '), 200)
      where s.id = v_parcel;
    end if;
    -- They've gone: nothing is waiting to ship together any more.
    delete from public.shipping_groups g
    where g.tenant_id = v_quote.tenant_id
      and g.order_ids && (v_quote.rider_ids || v_quote.shipping_order_id);
  end if;

  update public.shipping_label_quotes q
  set status = 'recorded', shipment_id = v_parcel
  where q.id = v_quote.id;
  return v_number;
end;
$$;

-- ---------------------------------------------------------------------------
-- Who may call what
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.claim_pickup_steps(int)',
    'public.finish_pickup_step(uuid, text, text, text)',
    'public.finish_shipment_send_with(uuid, text, text)',
    'public.claim_shipment_undos(int)',
    'public.finish_shipment_undo(uuid, text, text)',
    'public.save_part_label_quote(uuid, uuid, uuid, text, text, jsonb, text, int, text, jsonb)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
revoke all on function public.set_label_quote_hold_rest(uuid, boolean) from public, anon;
grant execute on function public.set_label_quote_hold_rest(uuid, boolean) to authenticated;
