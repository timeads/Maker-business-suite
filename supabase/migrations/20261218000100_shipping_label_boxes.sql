-- Shipping labels: one purchase for an order packed in several boxes.
-- EasyPost holds one box as a "shipment" and several boxes going together as
-- an "order" of shipments, priced and bought as one. A quote now says which
-- it is and how many boxes; a bought label and the parcel recorded from it
-- keep every box's tracking number and label link. The single
-- `tracking_number` and `label_url` columns stay, filled with the first box's.
--
-- Still no address anywhere here: a box is EasyPost's id, a tracking number
-- and two links.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.shipping_label_quotes
  -- What `provider_shipment_id` names at EasyPost.
  add column label_kind text not null default 'shipment'
    check (label_kind in ('shipment', 'order')),
  add column box_count int not null default 1 check (box_count between 1 and 6),
  -- Once bought: [{"shipment_id", "tracking_number", "tracking_url", "label_url"}], one per box.
  add column parcels jsonb
    check (parcels is null or (
      jsonb_typeof(parcels) = 'array'
      and jsonb_array_length(parcels) <= 6
      and not jsonb_path_exists(parcels,
        '$[*].label_url ? (@.type() != "null" && (@.type() != "string" || !(@ starts with "https://")))')
      and not jsonb_path_exists(parcels,
        '$[*].tracking_url ? (@.type() != "null" && (@.type() != "string" || !(@ starts with "https://")))'))),
  -- Several boxes are always an order; one box never is.
  add constraint shipping_label_quotes_kind_matches_boxes
    check ((label_kind = 'order') = (box_count > 1));

alter table public.shipments
  -- Every box of a bought label, in the same shape. Null on a parcel typed in by hand.
  add column label_parcels jsonb
    check (label_parcels is null or (
      jsonb_typeof(label_parcels) = 'array'
      and jsonb_array_length(label_parcels) <= 6
      and not jsonb_path_exists(label_parcels,
        '$[*].label_url ? (@.type() != "null" && (@.type() != "string" || !(@ starts with "https://")))')
      and not jsonb_path_exists(label_parcels,
        '$[*].tracking_url ? (@.type() != "null" && (@.type() != "string" || !(@ starts with "https://")))')));

-- ---------------------------------------------------------------------------
-- Quotes
-- ---------------------------------------------------------------------------

-- Stores the rates EasyPost just offered for an order, and whether they are
-- for one box (a shipment) or several (an order).
drop function public.save_label_quote(uuid, uuid, uuid, text, jsonb);
create function public.save_label_quote(
  p_tenant_id uuid,
  p_shipping_order_id uuid,
  p_created_by uuid,
  p_provider_shipment_id text,
  p_rates jsonb,
  p_kind text default 'shipment',
  p_boxes int default 1
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_kind text := coalesce(p_kind, 'shipment');
  v_boxes int := coalesce(p_boxes, 1);
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

  insert into public.shipping_label_quotes as q
    (tenant_id, shipping_order_id, created_by, provider_shipment_id, rates, label_kind, box_count)
  values
    (p_tenant_id, p_shipping_order_id, p_created_by, p_provider_shipment_id, p_rates, v_kind, v_boxes)
  on conflict (shipping_order_id, created_by) where status = 'quoted' do update set
    provider_shipment_id = excluded.provider_shipment_id, rates = excluded.rates,
    label_kind = excluded.label_kind, box_count = excluded.box_count,
    created_at = now()
  returning q.id into v_id;
  return v_id;
end;
$$;

-- "I'm buying this rate." Exactly as before, and it now also says what kind
-- of thing is being bought and how many boxes it covers.
create or replace function public.claim_label_purchase(p_shipping_order_id uuid, p_rate_id text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.shipping_orders := private.member_shipping_order(p_shipping_order_id);
  v_quote public.shipping_label_quotes;
begin
  if v_order.cancelled then
    raise exception 'This order was cancelled' using errcode = 'P0001';
  end if;
  if v_order.units_left <= 0 then
    raise exception 'Nothing left to send on this order' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.shipping_label_quotes q
    where q.shipping_order_id = v_order.id and q.status in ('buying', 'bought')) then
    raise exception 'A label for this order is still being finished' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.shipments s
    where s.shipping_order_id = v_order.id and s.label_provider is not null
      and s.voided_at is null and s.shipped_at > now() - interval '30 seconds') then
    raise exception 'A label for this order was bought moments ago' using errcode = 'P0001';
  end if;

  select * into v_quote from public.shipping_label_quotes q
  where q.shipping_order_id = v_order.id and q.tenant_id = v_order.tenant_id
    and q.status = 'quoted' and q.created_at > now() - interval '20 minutes'
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

-- The label is paid for: keep every box's tracking number and link before
-- anything else is tried. `p_parcels` is one entry per box; left out, the one
-- tracking number and link given are the only box. Whatever arrives is kept:
-- a paid label is never turned away for being fewer boxes than were quoted.
drop function public.mark_label_bought(uuid, uuid, text, text, text, text, text, text, numeric);
create function public.mark_label_bought(
  p_tenant_id uuid,
  p_quote_id uuid,
  p_carrier text,
  p_service text,
  p_tracking_number text,
  p_tracking_url text,
  p_label_url text,
  p_label_mode text,
  p_price numeric,
  p_parcels jsonb default null
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_rows int;
  v_parcels jsonb;
begin
  select jsonb_agg(jsonb_build_object(
           'shipment_id', left(btrim(coalesce(e.b ->> 'shipment_id', '')), 120),
           'tracking_number', left(btrim(coalesce(e.b ->> 'tracking_number', '')), 120),
           'tracking_url', case when e.b ->> 'tracking_url' ~ '^https://' then e.b ->> 'tracking_url' end,
           'label_url', case when e.b ->> 'label_url' ~ '^https://' then e.b ->> 'label_url' end)
         order by e.n)
  into v_parcels
  from jsonb_array_elements(
         case when jsonb_typeof(p_parcels) = 'array' then p_parcels else '[]'::jsonb end)
       with ordinality as e(b, n)
  where e.n <= 6 and jsonb_typeof(e.b) = 'object';

  update public.shipping_label_quotes q
  set status = 'bought', bought_at = now(),
      carrier = left(coalesce(nullif(btrim(coalesce(p_carrier, '')), ''), 'Carrier'), 60),
      service = left(btrim(coalesce(p_service, '')), 80),
      tracking_number = left(btrim(coalesce(
        nullif(btrim(coalesce(p_tracking_number, '')), ''), v_parcels -> 0 ->> 'tracking_number', '')), 120),
      tracking_url = case when p_tracking_url ~ '^https://' then p_tracking_url
                          else v_parcels -> 0 ->> 'tracking_url' end,
      label_url = case when p_label_url ~ '^https://' then p_label_url
                       else v_parcels -> 0 ->> 'label_url' end,
      label_mode = case when p_label_mode = 'test' then 'test' else 'live' end,
      price = case when p_price >= 0 then round(p_price, 2) end,
      parcels = coalesce(v_parcels, jsonb_build_array(jsonb_build_object(
        'shipment_id', case when q.label_kind = 'shipment' then q.provider_shipment_id else '' end,
        'tracking_number', left(btrim(coalesce(p_tracking_number, '')), 120),
        'tracking_url', case when p_tracking_url ~ '^https://' then p_tracking_url end,
        'label_url', case when p_label_url ~ '^https://' then p_label_url end)))
  where q.id = p_quote_id and q.tenant_id = p_tenant_id and q.status = 'buying';
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

-- Records the parcel for a bought label, as before: one parcel, whatever the
-- number of boxes, carrying every box's tracking number and label link.
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
  where s.tenant_id = v_quote.tenant_id and s.number = v_number;

  update public.shipping_label_quotes q
  set status = 'recorded',
      shipment_id = (select s.id from public.shipments s
                     where s.tenant_id = v_quote.tenant_id and s.number = v_number)
  where q.id = v_quote.id;
  return v_number;
end;
$$;

-- ---------------------------------------------------------------------------
-- Telling the shop: every box's tracking number goes on the one fulfilment.
-- ---------------------------------------------------------------------------

drop function public.claim_shipments_to_send(int);
create function public.claim_shipments_to_send(p_limit int default 20)
returns table (
  id uuid, tenant_id uuid, number int, provider text, order_external_id text, carrier text,
  tracking_number text, tracking_url text, items jsonb, notify_customer boolean,
  -- Every box that has a tracking number, and each one's link (null where there is none).
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
  left join lateral (
    select array_agg(e.b ->> 'tracking_number' order by e.n) as numbers,
           array_agg(e.b ->> 'tracking_url' order by e.n) as urls
    from jsonb_array_elements(taken.label_parcels) with ordinality as e(b, n)
    where coalesce(e.b ->> 'tracking_number', '') <> ''
  ) boxes on true;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.save_label_quote(uuid, uuid, uuid, text, jsonb, text, int)',
    'public.mark_label_bought(uuid, uuid, text, text, text, text, text, text, numeric, jsonb)',
    'public.claim_shipments_to_send(int)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
  -- Replaced in place, so these keep the grants they had; said again to be sure.
  foreach fn in array array[
    'public.claim_label_purchase(uuid, text)',
    'public.record_label_shipment(uuid, boolean, boolean)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
