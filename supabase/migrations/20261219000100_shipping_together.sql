-- Shipping: several orders going to the same person and address, sent as
-- one parcel on one label ("Ship together").
--
-- The label is bought on the oldest order (the "primary"); the others ride
-- along. Its quote remembers them (`rider_ids`), the purchase is claimed under
-- a lock on every order, and once it is paid for each order gets its own
-- `shipments` row in one transaction: the primary's carries the label and
-- what it cost, each rider's points at it (`merged_with`) and carries the
-- same tracking. The queue that tells the shop a parcel went already sends
-- one fulfilment per row, so every order is marked as sent on its own.
--
-- `shipping_groups` is only what people decided before buying: saved for
-- later, "not now", or "yes, these are the same place". It holds order ids
-- and nothing about who or where.

-- ---------------------------------------------------------------------------
-- The same address? Kept in step with `addressKey` in
-- src/lib/shipping/merge.ts (tests/db/shipping-merge.test.ts compares them).
-- ---------------------------------------------------------------------------

-- Letters and digits only, with street words shortened and "apt" and
-- friends dropped, so "12 Oak Street, Apt 3" and "12 OAK ST #3" read the same.
create function private.shipping_squash(p_text text)
returns text
language plpgsql immutable set search_path = ''
as $$
declare
  v text := lower(regexp_replace(normalize(coalesce(p_text, ''), NFKD), '[̀-ͯ]', '', 'g'));
  w text[];
begin
  v := regexp_replace(v, '[.,#''’/-]', ' ', 'g');
  foreach w slice 1 in array array[
    ['street', 'st'], ['avenue', 'ave'], ['road', 'rd'], ['drive', 'dr'], ['boulevard', 'blvd'],
    ['lane', 'ln'], ['court', 'ct'], ['place', 'pl'], ['circle', 'cir'], ['highway', 'hwy'],
    ['parkway', 'pkwy'], ['terrace', 'ter'], ['square', 'sq'], ['trail', 'trl'], ['way', 'wy'],
    ['north', 'n'], ['south', 's'], ['east', 'e'], ['west', 'w']]
  loop
    v := regexp_replace(v, '(?<![a-z0-9_])' || w[1] || '(?![a-z0-9_])', w[2], 'g');
  end loop;
  v := regexp_replace(
    v, '(?<![a-z0-9_])(apartment|apt|unit|suite|ste|floor|fl|number|no)(?![a-z0-9_])', ' ', 'g');
  return regexp_replace(v, '[^a-z0-9]', '', 'g');
end;
$$;
revoke all on function private.shipping_squash(text) from public;

-- Same person, same street address, same postcode and country. Null without
-- a street address. Email is never compared.
create function private.shipping_address_key(
  p_recipient text,
  p_address1 text,
  p_address2 text,
  p_postal_code text,
  p_country_code text
)
returns text
language sql immutable set search_path = ''
as $$
  select case when btrim(coalesce(p_address1, '')) = '' then null else
    private.shipping_squash(p_recipient) || '|'
    || private.shipping_squash(p_address1 || ' ' || coalesce(p_address2, '')) || '|'
    || case when upper(btrim(coalesce(p_country_code, ''))) in ('US', '')
            then left(upper(regexp_replace(coalesce(p_postal_code, ''), '\s+', '', 'g')), 5)
            else upper(regexp_replace(coalesce(p_postal_code, ''), '\s+', '', 'g')) end || '|'
    || upper(btrim(coalesce(p_country_code, '')))
  end;
$$;
revoke all on function private.shipping_address_key(text, text, text, text, text) from public;

-- ---------------------------------------------------------------------------
-- Groups people have acted on
-- ---------------------------------------------------------------------------

create table public.shipping_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- Sorted, so the same orders are always the same group.
  order_ids uuid[] not null check (cardinality(order_ids) between 2 and 10),
  -- The ids joined with commas. A suggestion someone said "not now" to comes
  -- back when another order joins that address, because that is a new key.
  order_key text not null,
  -- Packed or part-way there; the label is still to buy.
  saved_at timestamptz,
  saved_by uuid references auth.users (id) on delete set null,
  dismissed_at timestamptz,
  -- Someone looked at addresses that read differently and said they are one place.
  approved_at timestamptz,
  approved_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, order_key)
);

alter table public.shipping_groups enable row level security;
create policy "members read their shipping_groups" on public.shipping_groups
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));
revoke all on public.shipping_groups from public, anon, authenticated, service_role;
grant select on public.shipping_groups to authenticated, service_role;

-- A group goes when any order in it does.
create function private.drop_shipping_groups_of_order()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.shipping_groups g
  where g.tenant_id = old.tenant_id and old.id = any (g.order_ids);
  return old;
end;
$$;
revoke all on function private.drop_shipping_groups_of_order() from public;
create trigger shipping_orders_drop_groups
  after delete on public.shipping_orders
  for each row execute function private.drop_shipping_groups_of_order();

-- What a person decides about a set of orders, open to the whole team like
-- holds are: 'save' (finish later), 'dismiss' (not now), 'approve' (these
-- are the same place) or 'separate' (each goes on its own after all).
-- None of this spends anything: buying checks the orders again itself.
create function public.set_shipping_group(p_tenant_id uuid, p_order_ids uuid[], p_action text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ids uuid[];
  v_key text;
begin
  perform private.require_member(p_tenant_id);
  select coalesce(array_agg(d.x order by d.x), '{}') into v_ids
  from (select distinct x from unnest(coalesce(p_order_ids, '{}')) x where x is not null) d;
  if cardinality(v_ids) not between 2 and 10 then
    raise exception 'Pick two to ten orders' using errcode = 'P0001';
  end if;
  if (select count(*) from public.shipping_orders so
      where so.tenant_id = p_tenant_id and so.id = any (v_ids)) <> cardinality(v_ids) then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  v_key := array_to_string(v_ids, ',');

  if p_action = 'separate' then
    update public.shipping_groups g set saved_at = null, saved_by = null
    where g.tenant_id = p_tenant_id and g.order_ids && v_ids and g.saved_at is not null;
    update public.shipping_groups g set approved_at = null, approved_by = null
    where g.tenant_id = p_tenant_id and g.order_key = v_key;
    return;
  end if;
  if p_action is null or p_action not in ('save', 'dismiss', 'approve') then
    raise exception 'Unknown action' using errcode = '22023';
  end if;

  if p_action = 'save' then
    -- An order waits in one saved group at a time.
    update public.shipping_groups g set saved_at = null, saved_by = null
    where g.tenant_id = p_tenant_id and g.order_ids && v_ids and g.order_key <> v_key
      and g.saved_at is not null;
  end if;

  insert into public.shipping_groups as g
    (tenant_id, order_ids, order_key, saved_at, saved_by, dismissed_at, approved_at, approved_by)
  values
    (p_tenant_id, v_ids, v_key,
     case when p_action = 'save' then now() end,
     case when p_action = 'save' then auth.uid() end,
     case when p_action = 'dismiss' then now() end,
     case when p_action = 'approve' then now() end,
     case when p_action = 'approve' then auth.uid() end)
  on conflict (tenant_id, order_key) do update set
    saved_at = case when p_action = 'save' then now() else g.saved_at end,
    saved_by = case when p_action = 'save' then auth.uid() else g.saved_by end,
    -- Saving a group someone once waved away brings it back.
    dismissed_at = case when p_action = 'dismiss' then now()
                        when p_action = 'save' then null else g.dismissed_at end,
    approved_at = case when p_action = 'approve' then now() else g.approved_at end,
    approved_by = case when p_action = 'approve' then auth.uid() else g.approved_by end;

  -- Old decisions about orders long gone don't pile up.
  delete from public.shipping_groups g
  where g.tenant_id = p_tenant_id and g.saved_at is null
    and g.created_at < now() - interval '120 days';
end;
$$;

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.shipping_label_quotes
  -- The other orders this label covers, sorted. Empty for a label for one order.
  add column rider_ids uuid[] not null default '{}' check (cardinality(rider_ids) <= 9);

alter table public.shipments
  -- On an order that rode along: the parcel that carries the label.
  add column merged_with uuid references public.shipments (id) on delete set null;
create index shipments_merged_with_idx on public.shipments (merged_with)
  where merged_with is not null;

-- ---------------------------------------------------------------------------
-- Quotes
-- ---------------------------------------------------------------------------

-- Stores the rates EasyPost just offered for an order, or for an order with
-- others riding along. Written by the server with the service role after it
-- has really spoken to EasyPost.
create function public.save_group_label_quote(
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
    rider_ids = excluded.rider_ids, created_at = now()
  returning q.id into v_id;
  return v_id;
end;
$$;

-- The quote for one order, as before. Asking again for the order alone
-- replaces an open quote that had others riding along.
create or replace function public.save_label_quote(
  p_tenant_id uuid,
  p_shipping_order_id uuid,
  p_created_by uuid,
  p_provider_shipment_id text,
  p_rates jsonb,
  p_kind text default 'shipment',
  p_boxes int default 1
)
returns uuid
language sql security definer set search_path = ''
as $$
  select public.save_group_label_quote(
    p_tenant_id, p_shipping_order_id, p_created_by, p_provider_shipment_id, p_rates, p_kind,
    p_boxes, '{}'::uuid[]);
$$;

-- ---------------------------------------------------------------------------
-- Claiming a purchase
-- ---------------------------------------------------------------------------

-- What every order under a label must pass, whether it is the only one or
-- one of several: still there to send, and no other label on it mid-purchase
-- or just bought, on its own or riding along on another order's.
create function private.assert_label_free(p_order public.shipping_orders)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_order.cancelled then
    raise exception 'This order was cancelled' using errcode = 'P0001';
  end if;
  if p_order.units_left <= 0 then
    raise exception 'Nothing left to send on this order' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.shipping_label_quotes q
    where q.tenant_id = p_order.tenant_id and q.status in ('buying', 'bought')
      and (q.shipping_order_id = p_order.id or p_order.id = any (q.rider_ids))) then
    raise exception 'A label for this order is still being finished' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.shipments s
    where s.shipping_order_id = p_order.id
      and (s.label_provider is not null or s.merged_with is not null)
      and s.voided_at is null and s.shipped_at > now() - interval '30 seconds') then
    raise exception 'A label for this order was bought moments ago' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function private.assert_label_free(public.shipping_orders) from public;

-- "I'm buying this rate" for one order. As before, and it now also refuses
-- an order that is riding along on another order's unfinished label, and
-- never picks up a quote that was priced for several orders.
create or replace function public.claim_label_purchase(p_shipping_order_id uuid, p_rate_id text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.shipping_orders := private.member_shipping_order(p_shipping_order_id);
  v_quote public.shipping_label_quotes;
begin
  perform private.assert_label_free(v_order);

  select * into v_quote from public.shipping_label_quotes q
  where q.shipping_order_id = v_order.id and q.tenant_id = v_order.tenant_id
    and q.status = 'quoted' and q.created_at > now() - interval '20 minutes'
    and q.rider_ids = '{}'
    and exists (
      select 1 from jsonb_array_elements(q.rates) r where r ->> 'id' = p_rate_id)
  order by q.created_at desc
  limit 1
  for update;
  if not found then
    raise exception 'That rate was not quoted for this order' using errcode = 'P0002';
  end if;

  update public.shipping_label_quotes q
  set status = 'buying', buying_at = now(), bought_by = auth.uid(), rate_id = p_rate_id
  where q.id = v_quote.id;

  return jsonb_build_object(
    'quote_id', v_quote.id,
    'provider_shipment_id', v_quote.provider_shipment_id,
    'kind', v_quote.label_kind,
    'boxes', v_quote.box_count,
    'rate', (select r from jsonb_array_elements(v_quote.rates) r where r ->> 'id' = p_rate_id limit 1));
end;
$$;

-- "I'm buying this rate" for several orders going together. Run as the
-- member. Every order is locked (always in the same order, so two purchases
-- can't block each other) and checked: still there to send, not on hold, not
-- a pickup, with an address, and free of any other label mid-purchase. The
-- label goes on the oldest order. The orders must still read as the same
-- place, unless someone approved this exact set. Only a quote the server
-- stored for this exact set of orders can be bought.
create function public.claim_group_label_purchase(
  p_shipping_order_id uuid,
  p_rider_ids uuid[],
  p_rate_id text
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_riders uuid[];
  v_ids uuid[];
  v_order public.shipping_orders;
  v_tenant uuid;
  v_found int := 0;
  v_quote public.shipping_label_quotes;
begin
  select coalesce(array_agg(d.x order by d.x), '{}') into v_riders
  from (select distinct x from unnest(coalesce(p_rider_ids, '{}')) x
        where x is not null and x <> p_shipping_order_id) d;
  if p_shipping_order_id is null or cardinality(v_riders) not between 1 and 9 then
    raise exception 'Pick two to ten orders to ship together' using errcode = 'P0001';
  end if;
  select array_agg(x order by x) into v_ids from unnest(v_riders || p_shipping_order_id) x;

  for v_order in
    select * from public.shipping_orders so
    where so.id = any (v_ids) and so.tenant_id in (select private.user_tenant_ids())
    order by so.id
    for update
  loop
    v_found := v_found + 1;
    if v_tenant is null then
      v_tenant := v_order.tenant_id;
    elsif v_tenant <> v_order.tenant_id then
      raise exception 'Order not found' using errcode = 'P0002';
    end if;
    perform private.assert_label_free(v_order);
    if v_order.on_hold and (v_order.hold_until is null
       or v_order.hold_until > private.tenant_today(v_order.tenant_id)) then
      raise exception 'One of these orders is on hold' using errcode = 'P0001';
    end if;
    if v_order.pickup or v_order.picked_up_at is not null then
      raise exception 'One of these orders is an in-store pickup' using errcode = 'P0001';
    end if;
    if private.shipping_address_key(v_order.recipient, v_order.address1, v_order.address2,
         v_order.postal_code, v_order.country_code) is null then
      raise exception 'One of these orders has no shipping address' using errcode = 'P0001';
    end if;
  end loop;
  if v_found <> cardinality(v_ids) then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  if p_shipping_order_id is distinct from (
    select so.id from public.shipping_orders so where so.id = any (v_ids)
    order by so.placed_at, so.id limit 1) then
    raise exception 'The label goes on the oldest of these orders' using errcode = 'P0001';
  end if;

  if (select count(distinct private.shipping_address_key(
        so.recipient, so.address1, so.address2, so.postal_code, so.country_code))
      from public.shipping_orders so where so.id = any (v_ids)) > 1
     and not exists (
       select 1 from public.shipping_groups g
       where g.tenant_id = v_tenant and g.order_key = array_to_string(v_ids, ',')
         and g.approved_at is not null) then
    raise exception 'ADDRESS_MISMATCH These orders no longer go to the same address'
      using errcode = 'P0001';
  end if;

  select * into v_quote from public.shipping_label_quotes q
  where q.shipping_order_id = p_shipping_order_id and q.tenant_id = v_tenant
    and q.status = 'quoted' and q.created_at > now() - interval '20 minutes'
    and q.rider_ids = v_riders
    and exists (
      select 1 from jsonb_array_elements(q.rates) r where r ->> 'id' = p_rate_id)
  order by q.created_at desc
  limit 1
  for update;
  if not found then
    raise exception 'That rate was not quoted for these orders' using errcode = 'P0002';
  end if;

  update public.shipping_label_quotes q
  set status = 'buying', buying_at = now(), bought_by = auth.uid(), rate_id = p_rate_id
  where q.id = v_quote.id;

  return jsonb_build_object(
    'quote_id', v_quote.id,
    'provider_shipment_id', v_quote.provider_shipment_id,
    'kind', v_quote.label_kind,
    'boxes', v_quote.box_count,
    'riders', to_jsonb(v_riders),
    'rate', (select r from jsonb_array_elements(v_quote.rates) r where r ->> 'id' = p_rate_id limit 1));
end;
$$;

-- ---------------------------------------------------------------------------
-- Recording
-- ---------------------------------------------------------------------------

-- Records the parcel for a bought label, as before. When other orders rode
-- along, each gets its own parcel row in the same transaction: the same
-- carrier and tracking, no cost (the postage is counted once, on the first),
-- and a pointer to the parcel that carries the label. Each row goes to the
-- shop on its own, so every order is marked as sent and its shopper told.
-- An order that was sent some other way in the meantime, or is gone, is left
-- out rather than stopping the rest. Anything else that goes wrong undoes
-- the whole recording and leaves the label as bought (kept on its quote), to
-- be finished again from the order's page.
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
      v_quote.tracking_number, v_quote.tracking_url, v_quote.price, '[]'::jsonb, '',
      p_push, p_notify);
  exception when sqlstate 'P0001' then
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
-- Undoing
-- ---------------------------------------------------------------------------

-- Undoes a shipment, as before. A parcel that carried other orders takes
-- them with it: every order's items go back on its to-send list, and each
-- one's shop step is undone the same way a single parcel's is. An order that
-- rode along can't be undone on its own while its parcel stands. Returns
-- 'sent' when any of them is already marked as sent in the shop.
create or replace function public.void_shipment(p_id uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_shipment public.shipments;
  v_rider public.shipments;
  v_status text;
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
  update public.shipments s
  set voided_at = now(),
      shop_status = case when s.shop_status in ('pending', 'sending') then 'skipped' else s.shop_status end
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
        shop_status = case when s.shop_status in ('pending', 'sending') then 'skipped' else s.shop_status end
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

-- ---------------------------------------------------------------------------
-- Telling the shop: an order that rode along is sent with every tracking
-- number of the parcel it went in.
-- ---------------------------------------------------------------------------

create or replace function public.claim_shipments_to_send(p_limit int default 20)
returns table (
  id uuid, tenant_id uuid, number int, provider text, order_external_id text, carrier text,
  tracking_number text, tracking_url text, items jsonb, notify_customer boolean,
  tracking_numbers text[], tracking_urls text[]
)
language sql security definer set search_path = ''
as $$
  with due as (
    select s.id from public.shipments s
    where s.voided_at is null
      and (s.shop_status = 'pending'
        or (s.shop_status = 'sending' and s.shop_synced_at < now() - interval '15 minutes'))
    order by s.shipped_at
    limit greatest(1, least(coalesce(p_limit, 20), 100))
    for update skip locked
  ), taken as (
    update public.shipments s set shop_status = 'sending', shop_synced_at = now()
    from due where s.id = due.id
    returning s.*
  )
  select taken.id, taken.tenant_id, taken.number, so.provider, so.external_id, taken.carrier,
         taken.tracking_number, taken.tracking_url, taken.items, taken.notify_customer,
         coalesce(boxes.numbers,
                  case when taken.tracking_number <> '' then array[taken.tracking_number]
                       else '{}'::text[] end),
         case when boxes.numbers is not null then boxes.urls
              when taken.tracking_number <> '' then array[taken.tracking_url]
              else '{}'::text[] end
  from taken
  left join public.shipping_orders so on so.id = taken.shipping_order_id
  left join public.shipments lead
    on lead.id = taken.merged_with and lead.tenant_id = taken.tenant_id
  left join lateral (
    select array_agg(e.b ->> 'tracking_number' order by e.n) as numbers,
           array_agg(e.b ->> 'tracking_url' order by e.n) as urls
    from jsonb_array_elements(coalesce(taken.label_parcels, lead.label_parcels))
         with ordinality as e(b, n)
    where coalesce(e.b ->> 'tracking_number', '') <> ''
  ) boxes on true;
$$;

-- ---------------------------------------------------------------------------
-- Report: a parcel that carried several orders is one parcel and one
-- postage, while every order in it still counts as sent, with what its
-- shopper paid for shipping.
-- ---------------------------------------------------------------------------

create or replace function public.shipping_report(p_tenant_id uuid, p_days int default 30)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 366)));
  v_report jsonb;
begin
  perform private.require_member(p_tenant_id);
  with live as (
    select s.id, s.cost, s.shipped_at, s.shipping_order_id, s.merged_with
    from public.shipments s
    where s.tenant_id = p_tenant_id and s.voided_at is null
  ), sent as (
    select * from live where live.shipped_at >= v_since and live.merged_with is null
  ), first_parcels as (
    select so.id, so.shipping_paid, so.placed_at, min(live.shipped_at) as first_sent
    from live join public.shipping_orders so on so.id = live.shipping_order_id
    group by so.id
  ), orders_sent as (
    select * from first_parcels fp where fp.first_sent >= v_since
  ), totals as (
    select (select count(*) from sent) as parcels,
           (select count(*) from sent where sent.cost is not null) as priced,
           (select coalesce(sum(sent.cost), 0) from sent) as postage,
           (select count(*) from orders_sent) as orders,
           (select coalesce(sum(os.shipping_paid), 0) from orders_sent os) as collected,
           (select round(avg(extract(epoch from (os.first_sent - os.placed_at)) / 86400.0)::numeric, 1)
            from orders_sent os where os.first_sent >= os.placed_at) as avg_days
  ), places as (
    select so.country_code as country, so.region, count(*) as parcels
    from sent join public.shipping_orders so on so.id = sent.shipping_order_id
    where so.country_code is not null
    group by so.country_code, so.region
    order by count(*) desc, so.country_code, so.region
    limit 8
  )
  select jsonb_build_object(
    'days', greatest(1, least(coalesce(p_days, 30), 366)),
    'parcels', t.parcels, 'priced', t.priced, 'orders', t.orders,
    'postage', t.postage, 'collected', t.collected, 'margin', t.collected - t.postage,
    'avg_days', t.avg_days,
    'destinations', coalesce((select jsonb_agg(jsonb_build_object(
        'country', p.country, 'region', p.region, 'parcels', p.parcels)
        order by p.parcels desc, p.country, p.region) from places p), '[]'::jsonb))
  into v_report
  from totals t;
  return v_report;
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
    'public.set_shipping_group(uuid, uuid[], text)',
    'public.claim_group_label_purchase(uuid, uuid[], text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
  foreach fn in array array[
    'public.save_group_label_quote(uuid, uuid, uuid, text, jsonb, text, int, uuid[])',
    'public.save_label_quote(uuid, uuid, uuid, text, jsonb, text, int)',
    'public.claim_shipments_to_send(int)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
  -- Replaced in place, so these keep the grants they had; said again to be sure.
  foreach fn in array array[
    'public.claim_label_purchase(uuid, text)',
    'public.record_label_shipment(uuid, boolean, boolean)',
    'public.void_shipment(uuid)',
    'public.shipping_report(uuid, int)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
