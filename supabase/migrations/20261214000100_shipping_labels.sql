-- Shipping, round three: buying postage labels through EasyPost.
-- A workspace connects its own EasyPost API key (kept in Vault like every
-- other connection), keeps a short list of the boxes it packs in, asks for
-- rates for an order and buys a label. A bought label is recorded as a parcel
-- through `record_shipment`, exactly as one typed in by hand would be.
--
-- Nothing here stores an address: a quote keeps EasyPost's own ids and the
-- prices it offered, and a label is a link and a tracking number.

-- ---------------------------------------------------------------------------
-- Connections: EasyPost joins the list of providers.
-- ---------------------------------------------------------------------------

alter table public.connections drop constraint connections_provider_check;
alter table public.connections add constraint connections_provider_check
  check (provider in ('shopify', 'quickbooks', 'meta', 'google', 'stripe', 'easypost'));

-- ---------------------------------------------------------------------------
-- Saved boxes
-- ---------------------------------------------------------------------------

create table public.shipping_boxes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  kind text not null default 'box' check (kind in ('box', 'envelope', 'soft')),
  -- Inches. Nothing a carrier takes is longer than nine feet.
  length_in numeric(6, 2) not null check (length_in > 0 and length_in <= 108),
  width_in numeric(6, 2) not null check (width_in > 0 and width_in <= 108),
  -- A flat envelope still has a little height.
  height_in numeric(6, 2) not null check (height_in > 0 and height_in <= 108),
  -- What the box itself weighs, in ounces, added to what goes in it.
  empty_weight_oz numeric(7, 2) not null default 0
    check (empty_weight_oz >= 0 and empty_weight_oz <= 2400),
  is_default boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create index shipping_boxes_tenant_idx on public.shipping_boxes (tenant_id, created_at);
-- One box is the usual one.
create unique index shipping_boxes_one_default
  on public.shipping_boxes (tenant_id) where is_default and archived_at is null;

-- ---------------------------------------------------------------------------
-- Labels on parcels
-- ---------------------------------------------------------------------------

alter table public.shipments
  add column label_provider text check (label_provider is null or label_provider in ('easypost')),
  -- The provider's own id for the label, which a refund is asked for by.
  add column label_shipment_id text
    check (label_shipment_id is null or char_length(label_shipment_id) between 1 and 120),
  add column label_url text check (label_url is null or label_url ~ '^https://'),
  -- test: bought with a test key, so it isn't real postage.
  add column label_mode text check (label_mode is null or label_mode in ('test', 'live')),
  add column label_refund_status text
    check (label_refund_status is null or label_refund_status in ('requested', 'refunded', 'rejected')),
  add column label_refund_at timestamptz;
-- A label belongs to one parcel, ever.
create unique index shipments_one_parcel_per_label
  on public.shipments (label_provider, label_shipment_id) where label_shipment_id is not null;

-- ---------------------------------------------------------------------------
-- Quotes: the rates EasyPost offered for an order, and what became of them.
-- A label can only be bought against a quote the server stored for that
-- order, and a label that was paid for is written here before the parcel is
-- recorded, so it can't be lost if recording fails.
--   quoted   -> rates are on offer (one open quote per order and person)
--   buying   -> someone pressed Buy; EasyPost is being asked
--   bought   -> paid for; tracking and label link are stored here
--   recorded -> the parcel exists (shipment_id)
--   released -> EasyPost said no, nothing was charged
-- ---------------------------------------------------------------------------

create table public.shipping_label_quotes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  shipping_order_id uuid not null references public.shipping_orders (id) on delete cascade,
  provider text not null default 'easypost' check (provider in ('easypost')),
  provider_shipment_id text not null check (char_length(provider_shipment_id) between 1 and 120),
  -- [{"id", "carrier", "service", "name", "price", "currency", "days"}]; prices are text.
  rates jsonb not null default '[]'::jsonb check (jsonb_typeof(rates) = 'array'),
  status text not null default 'quoted'
    check (status in ('quoted', 'buying', 'bought', 'recorded', 'released')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  -- The purchase.
  rate_id text,
  buying_at timestamptz,
  bought_by uuid references auth.users (id) on delete set null,
  bought_at timestamptz,
  carrier text,
  service text,
  tracking_number text,
  tracking_url text check (tracking_url is null or tracking_url ~ '^https://'),
  label_url text check (label_url is null or label_url ~ '^https://'),
  label_mode text check (label_mode is null or label_mode in ('test', 'live')),
  price numeric(12, 2) check (price is null or price >= 0),
  shipment_id uuid references public.shipments (id) on delete set null,
  unique (provider, provider_shipment_id)
);
create index shipping_label_quotes_order_idx
  on public.shipping_label_quotes (shipping_order_id, created_at desc);
-- Asking for rates again replaces the open quote rather than piling up rows.
create unique index shipping_label_quotes_one_open
  on public.shipping_label_quotes (shipping_order_id, created_by) where status = 'quoted';

do $$
declare
  t text;
begin
  foreach t in array array['shipping_boxes', 'shipping_label_quotes']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy "members read their %s" on public.%I for select to authenticated
         using (tenant_id in (select private.user_tenant_ids()))', t, t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to authenticated, service_role', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Boxes (owners and admins)
-- ---------------------------------------------------------------------------

-- Adds a box, or changes one. The first box is the usual one; asking for a
-- box to be the usual one takes that from whichever was.
create function public.save_shipping_box(
  p_tenant_id uuid,
  p_box_id uuid,
  p_name text,
  p_kind text,
  p_length_in numeric,
  p_width_in numeric,
  p_height_in numeric,
  p_empty_weight_oz numeric,
  p_default boolean default false
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_default boolean;
begin
  perform private.require_manager(p_tenant_id);
  -- One at a time per workspace, so two saves can't both become the usual box.
  perform 1 from public.tenants t where t.id = p_tenant_id for update;

  if p_box_id is null and (
    select count(*) from public.shipping_boxes b
    where b.tenant_id = p_tenant_id and b.archived_at is null) >= 50 then
    raise exception 'Too many boxes' using errcode = 'P0001';
  end if;

  v_default := coalesce(p_default, false) or not exists (
    select 1 from public.shipping_boxes b
    where b.tenant_id = p_tenant_id and b.archived_at is null and b.is_default
      and b.id is distinct from p_box_id);
  if v_default then
    update public.shipping_boxes b set is_default = false
    where b.tenant_id = p_tenant_id and b.is_default and b.id is distinct from p_box_id;
  end if;

  if p_box_id is null then
    insert into public.shipping_boxes
      (tenant_id, name, kind, length_in, width_in, height_in, empty_weight_oz, is_default)
    values
      (p_tenant_id, btrim(coalesce(p_name, '')), coalesce(p_kind, 'box'), p_length_in, p_width_in,
       p_height_in, coalesce(p_empty_weight_oz, 0), v_default)
    returning id into v_id;
  else
    update public.shipping_boxes b
    set name = btrim(coalesce(p_name, '')), kind = coalesce(p_kind, 'box'),
        length_in = p_length_in, width_in = p_width_in, height_in = p_height_in,
        empty_weight_oz = coalesce(p_empty_weight_oz, 0),
        is_default = v_default or b.is_default
    where b.id = p_box_id and b.tenant_id = p_tenant_id and b.archived_at is null
    returning b.id into v_id;
    if v_id is null then
      raise exception 'Box not found' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
end;
$$;

-- Takes a box off the list. Parcels already sent don't refer to it. If it
-- was the usual box, the oldest one left becomes that.
create function public.archive_shipping_box(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_box public.shipping_boxes;
begin
  select * into v_box from public.shipping_boxes b
  where b.id = p_id and b.tenant_id in (select private.user_tenant_ids()) and b.archived_at is null;
  if not found then
    raise exception 'Box not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_box.tenant_id);
  perform 1 from public.tenants t where t.id = v_box.tenant_id for update;

  update public.shipping_boxes b set archived_at = now(), is_default = false where b.id = v_box.id;
  if v_box.is_default then
    update public.shipping_boxes b set is_default = true
    where b.id = (
      select n.id from public.shipping_boxes n
      where n.tenant_id = v_box.tenant_id and n.archived_at is null
      order by n.created_at, n.id limit 1);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Quotes and purchases.
-- The server writes these with the service role after it has really spoken
-- to EasyPost, naming the workspace; a browser session can't make one up.
-- ---------------------------------------------------------------------------

-- Stores the rates EasyPost just offered for an order.
create function public.save_label_quote(
  p_tenant_id uuid,
  p_shipping_order_id uuid,
  p_created_by uuid,
  p_provider_shipment_id text,
  p_rates jsonb
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
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

  insert into public.shipping_label_quotes as q
    (tenant_id, shipping_order_id, created_by, provider_shipment_id, rates)
  values (p_tenant_id, p_shipping_order_id, p_created_by, p_provider_shipment_id, p_rates)
  on conflict (shipping_order_id, created_by) where status = 'quoted' do update set
    provider_shipment_id = excluded.provider_shipment_id, rates = excluded.rates,
    created_at = now()
  returning q.id into v_id;
  return v_id;
end;
$$;

-- "I'm buying this rate." Run as the member, under a lock on the order, so
-- two presses can't both go ahead. Refuses a rate that wasn't quoted for this
-- order in the last twenty minutes, an order with a label still unfinished,
-- and an order that had a label bought in the last thirty seconds.
create function public.claim_label_purchase(p_shipping_order_id uuid, p_rate_id text)
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
    'rate', (select r from jsonb_array_elements(v_quote.rates) r where r ->> 'id' = p_rate_id limit 1));
end;
$$;

-- EasyPost said no (or the label turned out not to exist): nothing was charged.
create function public.release_label_purchase(p_tenant_id uuid, p_quote_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_rows int;
begin
  update public.shipping_label_quotes q set status = 'released'
  where q.id = p_quote_id and q.tenant_id = p_tenant_id and q.status = 'buying';
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

-- The label is paid for: keep its tracking number and link before anything
-- else is tried.
create function public.mark_label_bought(
  p_tenant_id uuid,
  p_quote_id uuid,
  p_carrier text,
  p_service text,
  p_tracking_number text,
  p_tracking_url text,
  p_label_url text,
  p_label_mode text,
  p_price numeric
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_rows int;
begin
  update public.shipping_label_quotes q
  set status = 'bought', bought_at = now(),
      carrier = left(coalesce(nullif(btrim(coalesce(p_carrier, '')), ''), 'Carrier'), 60),
      service = left(btrim(coalesce(p_service, '')), 80),
      tracking_number = left(btrim(coalesce(p_tracking_number, '')), 120),
      tracking_url = case when p_tracking_url ~ '^https://' then p_tracking_url end,
      label_url = case when p_label_url ~ '^https://' then p_label_url end,
      label_mode = case when p_label_mode = 'test' then 'test' else 'live' end,
      price = case when p_price >= 0 then round(p_price, 2) end
  where q.id = p_quote_id and q.tenant_id = p_tenant_id and q.status = 'buying';
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

-- Records the parcel for a bought label, through `record_shipment`, with
-- everything still to send on the order. If the order was marked as sent in
-- the meantime, the label is still kept: as a parcel on its own, carrying the
-- order's number but no name or address.
create function public.record_label_shipment(
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

-- Undoes a parcel whose label EasyPost has just been asked to refund. The
-- undo itself is `void_shipment` (owners and admins; items go back on the
-- to-send list).
create function public.void_label_shipment(p_id uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_status text := public.void_shipment(p_id);
begin
  update public.shipments s
  set label_refund_status = 'requested', label_refund_at = now()
  where s.id = p_id and s.label_provider is not null;
  return v_status;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.save_shipping_box(uuid, uuid, text, text, numeric, numeric, numeric, numeric, boolean)',
    'public.archive_shipping_box(uuid)',
    'public.claim_label_purchase(uuid, text)',
    'public.record_label_shipment(uuid, boolean, boolean)',
    'public.void_label_shipment(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
  foreach fn in array array[
    'public.save_label_quote(uuid, uuid, uuid, text, jsonb)',
    'public.release_label_purchase(uuid, uuid)',
    'public.mark_label_bought(uuid, uuid, text, text, text, text, text, text, numeric)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
