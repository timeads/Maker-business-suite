-- Shipping labels from more than one place: a workspace's own UPS account
-- and Redo join EasyPost, and their prices are shown as one list.
--
-- Each is an ordinary optional connection. A quote's rates now each say
-- which source they came from and carry that source's own ids (`source`,
-- `ref`), so a purchase is still only ever made against a rate the server
-- stored. UPS and Redo keep nothing on their side between a quote and a
-- purchase, so the quote also keeps a fingerprint of what was priced (never
-- the address itself); the server rebuilds the request when buying and only
-- goes ahead when it matches.
--
-- UPS hands a label back as a picture rather than a link, and Redo's link may
-- not last, so a bought label's own file can be kept here too.

-- ---------------------------------------------------------------------------
-- Connections and the columns that name a label's source
-- ---------------------------------------------------------------------------

alter table public.connections drop constraint connections_provider_check;
alter table public.connections add constraint connections_provider_check
  check (provider in ('shopify', 'quickbooks', 'meta', 'google', 'stripe', 'easypost', 'ups', 'redo'));

alter table public.shipments drop constraint shipments_label_provider_check;
alter table public.shipments add constraint shipments_label_provider_check
  check (label_provider is null or label_provider in ('easypost', 'ups', 'redo'));

alter table public.shipping_label_quotes drop constraint shipping_label_quotes_provider_check;
alter table public.shipping_label_quotes add constraint shipping_label_quotes_provider_check
  check (provider in ('easypost', 'ups', 'redo'));

alter table public.shipping_label_quotes
  -- "<salt>:<sha256>" of the request that was priced. Not an address, and
  -- cleared once the label is bought or the shopper asks to be forgotten.
  add column request_hash text check (request_hash is null or char_length(request_hash) <= 200);

-- ---------------------------------------------------------------------------
-- A bought label's own file
-- ---------------------------------------------------------------------------

create table public.shipping_label_files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- Goes when the quote does, which goes when its order does.
  quote_id uuid not null references public.shipping_label_quotes (id) on delete cascade,
  -- Which box of the purchase, counting from 1.
  box int not null check (box between 1 and 6),
  content_type text not null
    check (content_type in ('image/gif', 'image/png', 'application/pdf', 'text/plain')),
  -- Base64, as the carrier sent it.
  data text not null
    check (char_length(data) between 1 and 6000000 and data ~ '^[A-Za-z0-9+/=]+$'),
  created_at timestamptz not null default now(),
  unique (quote_id, box)
);
create index shipping_label_files_tenant_idx on public.shipping_label_files (tenant_id);

alter table public.shipping_label_files enable row level security;
create policy "members read their shipping_label_files" on public.shipping_label_files
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));
revoke all on public.shipping_label_files from public, anon, authenticated, service_role;
grant select on public.shipping_label_files to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Privacy: a label's picture shows a name and address, so it goes with them
-- when a shopper asks to be forgotten, on their own order's label and on one
-- their order rode along on. The fingerprint goes too.
-- ---------------------------------------------------------------------------

create or replace function private.blank_shipping_details()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.email is null and new.customer_external_id is null
     and (old.email is not null or old.customer_external_id is not null) then
    update public.shipments s set recipient = null, destination = null
    where s.shipping_order_id in (
      select so.id from public.shipping_orders so where so.order_id = new.id);
    delete from public.shipping_label_files f
    using public.shipping_label_quotes q, public.shipping_orders so
    where f.quote_id = q.id and so.order_id = new.id
      and (q.shipping_order_id = so.id or so.id = any (q.rider_ids));
    update public.shipping_label_quotes q set request_hash = null
    from public.shipping_orders so
    where so.order_id = new.id and q.request_hash is not null
      and (q.shipping_order_id = so.id or so.id = any (q.rider_ids));
    update public.shipping_orders so
    set recipient = null, company = null, address1 = null, address2 = null, city = null,
        region = null, postal_code = null, phone = null, email = null, note = null,
        hold_reason = ''
    where so.order_id = new.id;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Quotes
-- ---------------------------------------------------------------------------

-- Stores one merged list of rates for an order (with others riding along, or
-- none). Written by the server with the service role after it has really
-- spoken to the sources. `p_provider` is only where the quote starts: the
-- rate that is bought decides it for good.
create function public.save_label_quote_from(
  p_tenant_id uuid,
  p_shipping_order_id uuid,
  p_created_by uuid,
  p_provider text,
  p_provider_shipment_id text,
  p_rates jsonb,
  p_kind text,
  p_boxes int,
  p_rider_ids uuid[],
  p_request_hash text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_provider is null or p_provider not in ('easypost', 'ups', 'redo') then
    raise exception 'Unknown label source' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(
      case when jsonb_typeof(p_rates) = 'array' then p_rates else '[]'::jsonb end) r
    where coalesce(r ->> 'source', 'easypost') not in ('easypost', 'ups', 'redo')
       or coalesce(r ->> 'id', '') !~ '^[A-Za-z0-9_]{4,120}$') then
    raise exception 'Rates are not a list' using errcode = '22023';
  end if;
  v_id := public.save_group_label_quote(
    p_tenant_id, p_shipping_order_id, p_created_by, p_provider_shipment_id, p_rates, p_kind,
    p_boxes, coalesce(p_rider_ids, '{}'::uuid[]));
  update public.shipping_label_quotes q
  set provider = p_provider, request_hash = left(p_request_hash, 200)
  where q.id = v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Claiming a purchase: as before, and the chosen rate now settles which
-- source the label is bought from. A rate with no source is EasyPost's, the
-- way every rate was stored before.
-- ---------------------------------------------------------------------------

-- Marks a quote as being bought with one of its rates, and says what the
-- server needs to buy it. Only called from the two claim functions, after
-- they have locked and checked the order (or orders).
create function private.start_label_purchase(
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
    'rate', v_rate);
end;
$$;
revoke all on function private.start_label_purchase(public.shipping_label_quotes, text) from public;

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

  return private.start_label_purchase(v_quote, p_rate_id);
end;
$$;

create or replace function public.claim_group_label_purchase(
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

  return private.start_label_purchase(v_quote, p_rate_id) || jsonb_build_object('riders', to_jsonb(v_riders));
end;
$$;

-- ---------------------------------------------------------------------------
-- A label bought from UPS or Redo is paid for: keep every box's tracking
-- number, the source's own id for it (what a void is asked for by) and the
-- label's file, before anything else is tried. EasyPost's labels go on being
-- kept by `mark_label_bought`.
--
-- `p_parcels`: [{"shipment_id", "tracking_number", "tracking_url", "label_url"}], one per box.
-- `p_files`:   [{"box", "content_type", "data"}]; a file that can't be kept is
--              left out rather than losing the label.
-- ---------------------------------------------------------------------------

create function public.mark_label_bought_from(
  p_tenant_id uuid,
  p_quote_id uuid,
  p_provider_shipment_id text,
  p_carrier text,
  p_service text,
  p_label_mode text,
  p_price numeric,
  p_parcels jsonb,
  p_files jsonb default '[]'::jsonb
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_quote public.shipping_label_quotes;
  v_parcels jsonb;
  v_file record;
  v_file_id uuid;
  v_shipment text := nullif(left(btrim(coalesce(p_provider_shipment_id, '')), 120), '');
begin
  select * into v_quote from public.shipping_label_quotes q
  where q.id = p_quote_id and q.tenant_id = p_tenant_id and q.status = 'buying'
  for update;
  if not found then
    return false;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'shipment_id', left(btrim(coalesce(e.b ->> 'shipment_id', '')), 120),
           'tracking_number', left(btrim(coalesce(e.b ->> 'tracking_number', '')), 120),
           'tracking_url', case when e.b ->> 'tracking_url' ~ '^https://' then e.b ->> 'tracking_url' end,
           'label_url', case when e.b ->> 'label_url' ~ '^https://' then e.b ->> 'label_url' end,
           'label_file', null)
         order by e.n), '[]'::jsonb)
  into v_parcels
  from jsonb_array_elements(
         case when jsonb_typeof(p_parcels) = 'array' then p_parcels else '[]'::jsonb end)
       with ordinality as e(b, n)
  where e.n <= 6 and jsonb_typeof(e.b) = 'object';
  -- Whatever arrives is kept: a paid label is never turned away for saying too little.
  if jsonb_array_length(v_parcels) = 0 then
    v_parcels := jsonb_build_array(jsonb_build_object(
      'shipment_id', coalesce(v_shipment, ''), 'tracking_number', '', 'tracking_url', null,
      'label_url', null, 'label_file', null));
  end if;

  for v_file in
    select (f.b ->> 'box')::int as box, f.b ->> 'content_type' as content_type, f.b ->> 'data' as data
    from jsonb_array_elements(
           case when jsonb_typeof(p_files) = 'array' then p_files else '[]'::jsonb end) f(b)
    where jsonb_typeof(f.b) = 'object' and f.b ->> 'box' ~ '^[1-6]$'
  loop
    continue when v_file.box > jsonb_array_length(v_parcels);
    begin
      insert into public.shipping_label_files (tenant_id, quote_id, box, content_type, data)
      values (p_tenant_id, p_quote_id, v_file.box, v_file.content_type, v_file.data)
      on conflict (quote_id, box) do update
        set content_type = excluded.content_type, data = excluded.data
      returning id into v_file_id;
      v_parcels := jsonb_set(v_parcels, array[(v_file.box - 1)::text, 'label_file'], to_jsonb(v_file_id::text));
    exception when others then
      -- Not a file we can keep (too big, not a kind we know). The label itself still is.
      null;
    end;
  end loop;

  -- The same shipment can't sit on two quotes; if this id is somehow taken, the label is still kept.
  if v_shipment is not null and exists (
    select 1 from public.shipping_label_quotes o
    where o.provider = v_quote.provider and o.provider_shipment_id = v_shipment
      and o.id <> v_quote.id) then
    v_shipment := null;
  end if;

  update public.shipping_label_quotes q
  set status = 'bought', bought_at = now(),
      provider_shipment_id = coalesce(v_shipment, q.provider_shipment_id),
      carrier = left(coalesce(nullif(btrim(coalesce(p_carrier, '')), ''), 'Carrier'), 60),
      service = left(btrim(coalesce(p_service, '')), 80),
      tracking_number = coalesce(v_parcels -> 0 ->> 'tracking_number', ''),
      tracking_url = v_parcels -> 0 ->> 'tracking_url',
      label_url = v_parcels -> 0 ->> 'label_url',
      label_mode = case when p_label_mode = 'test' then 'test' else 'live' end,
      price = case when p_price >= 0 then round(p_price, 2) end,
      parcels = v_parcels,
      request_hash = null
  where q.id = v_quote.id;
  return true;
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
    'public.save_label_quote_from(uuid, uuid, uuid, text, text, jsonb, text, int, uuid[], text)',
    'public.mark_label_bought_from(uuid, uuid, text, text, text, text, numeric, jsonb, jsonb)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
  -- Replaced in place, so these keep the grants they had; said again to be sure.
  foreach fn in array array[
    'public.claim_label_purchase(uuid, text)',
    'public.claim_group_label_purchase(uuid, uuid[], text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
