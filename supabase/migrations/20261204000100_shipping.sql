-- Shipping: what's waiting to go out, and what went.
-- `shipping_orders` holds what packing needs from each shop order (who it is
-- for and what's left to send), kept apart from the sales figures so it can
-- be blanked when a shopper asks to be forgotten. `shipments` is the
-- workspace's own record of every parcel.

create table public.shipping_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- Goes when the order does (a disconnected shop, an erased workspace).
  order_id uuid not null unique references public.orders (id) on delete cascade,
  provider text not null,
  external_id text not null,
  name text,
  placed_at timestamptz not null,
  recipient text,
  company text,
  address1 text,
  address2 text,
  city text,
  region text,
  postal_code text,
  country_code text,
  phone text,
  email text,
  shipping_method text,
  note text,
  -- [{"line_id", "title", "variant", "sku", "qty", "left"}]: left is what still has to ship.
  items jsonb not null default '[]'::jsonb,
  units_left int not null default 0,
  cancelled boolean not null default false,
  paid boolean not null default true,
  -- The workspace's own, kept across syncs.
  on_hold boolean not null default false,
  hold_reason text not null default '' check (char_length(hold_reason) <= 300),
  slip_printed_at timestamptz,
  synced_at timestamptz not null default now()
);
create index shipping_orders_queue_idx on public.shipping_orders (tenant_id, units_left, placed_at);

create table public.shipments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- Counts up per workspace.
  number int not null,
  shipping_order_id uuid references public.shipping_orders (id) on delete set null,
  order_name text,
  recipient text,
  destination text,
  carrier text not null check (char_length(carrier) between 1 and 60),
  service text not null default '' check (char_length(service) <= 80),
  tracking_number text not null default '' check (char_length(tracking_number) <= 120),
  tracking_url text check (tracking_url is null or tracking_url ~ '^https://'),
  -- What the postage cost the business, when they note it.
  cost numeric(12, 2) check (cost is null or cost >= 0),
  -- [{"line_id", "title", "qty"}]
  items jsonb not null default '[]'::jsonb,
  note text not null default '' check (char_length(note) <= 500),
  notify_customer boolean not null default false,
  shipped_at timestamptz not null default now(),
  voided_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  -- pending: waiting to be marked as sent in the shop. skipped: the workspace
  -- does that itself. failed: see shop_error.
  shop_status text not null default 'skipped'
    check (shop_status in ('pending', 'sending', 'sent', 'skipped', 'failed')),
  shop_error text,
  shop_synced_at timestamptz,
  unique (tenant_id, number)
);
create index shipments_tenant_shipped_idx on public.shipments (tenant_id, shipped_at desc);
create index shipments_pending_idx on public.shipments (shop_status, shipped_at);

do $$
declare
  t text;
begin
  foreach t in array array['shipping_orders', 'shipments']
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

-- When a shopper is forgotten their orders lose their email; whatever we
-- hold for packing those orders is blanked in the same breath.
create function private.blank_shipping_details()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.email is null and new.customer_external_id is null
     and (old.email is not null or old.customer_external_id is not null) then
    update public.shipments s set recipient = null, destination = null
    where s.shipping_order_id in (
      select so.id from public.shipping_orders so where so.order_id = new.id);
    update public.shipping_orders so
    set recipient = null, company = null, address1 = null, address2 = null, city = null,
        region = null, postal_code = null, phone = null, email = null, note = null
    where so.order_id = new.id;
  end if;
  return new;
end;
$$;
revoke all on function private.blank_shipping_details() from public;
create trigger orders_blank_shipping
  after update of email, customer_external_id on public.orders
  for each row execute function private.blank_shipping_details();

-- The same when the order itself goes (the shop was disconnected or asked us
-- to erase everything): the parcel record stays, without who it went to.
create function private.blank_orphaned_shipments()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  update public.shipments s set recipient = null, destination = null
  where s.shipping_order_id = old.id;
  return old;
end;
$$;
revoke all on function private.blank_orphaned_shipments() from public;
create trigger shipping_orders_blank_shipments
  before delete on public.shipping_orders
  for each row execute function private.blank_orphaned_shipments();

-- ---------------------------------------------------------------------------
-- Sync (service role, one named workspace)
-- ---------------------------------------------------------------------------

-- Upserts what packing needs for a page of orders that are already stored.
-- The workspace's own marks (hold, slip printed) are left alone.
create function public.upsert_shipping_orders(p_tenant_id uuid, p_provider text, p_orders jsonb)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.shipping_orders
    (tenant_id, order_id, provider, external_id, name, placed_at, recipient, company, address1,
     address2, city, region, postal_code, country_code, phone, email, shipping_method, note, items,
     units_left, cancelled, paid, synced_at)
  select p_tenant_id, o.id, p_provider, s.external_id, o.name, o.processed_at,
         nullif(btrim(s.recipient), ''), nullif(btrim(s.company), ''), nullif(btrim(s.address1), ''),
         nullif(btrim(s.address2), ''), nullif(btrim(s.city), ''), nullif(btrim(s.region), ''),
         nullif(btrim(s.postal_code), ''), nullif(upper(btrim(s.country_code)), ''),
         nullif(btrim(s.phone), ''), o.email, nullif(btrim(s.shipping_method), ''),
         nullif(left(btrim(s.note), 1000), ''), coalesce(s.items, '[]'::jsonb),
         coalesce((select sum(greatest(0, (i ->> 'left')::int))
                   from jsonb_array_elements(coalesce(s.items, '[]'::jsonb)) i), 0),
         o.cancelled_at is not null, coalesce(s.paid, true), now()
  from jsonb_to_recordset(coalesce(p_orders, '[]'::jsonb)) as s(
    external_id text, recipient text, company text, address1 text, address2 text, city text,
    region text, postal_code text, country_code text, phone text, shipping_method text, note text,
    items jsonb, paid boolean)
  join public.orders o
    on o.tenant_id = p_tenant_id and o.provider = p_provider and o.external_id = s.external_id
  on conflict (order_id) do update set
    name = excluded.name, placed_at = excluded.placed_at, recipient = excluded.recipient,
    company = excluded.company, address1 = excluded.address1, address2 = excluded.address2,
    city = excluded.city, region = excluded.region, postal_code = excluded.postal_code,
    country_code = excluded.country_code, phone = excluded.phone, email = excluded.email,
    shipping_method = excluded.shipping_method, note = excluded.note, items = excluded.items,
    units_left = excluded.units_left, cancelled = excluded.cancelled, paid = excluded.paid,
    synced_at = now();
$$;

-- Shipments waiting to be marked as sent in the shop. One worker gets each.
create function public.claim_shipments_to_send(p_limit int default 20)
returns table (
  id uuid, tenant_id uuid, number int, provider text, order_external_id text, carrier text,
  tracking_number text, tracking_url text, items jsonb, notify_customer boolean
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
         taken.tracking_number, taken.tracking_url, taken.items, taken.notify_customer
  from taken
  left join public.shipping_orders so on so.id = taken.shipping_order_id;
$$;

create function public.finish_shipment_send(p_id uuid, p_error text default null)
returns void
language sql security definer set search_path = ''
as $$
  update public.shipments s
  set shop_status = case when p_error is null then 'sent' else 'failed' end,
      shop_error = left(p_error, 500), shop_synced_at = now()
  where s.id = p_id and s.shop_status = 'sending';
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.upsert_shipping_orders(uuid, text, jsonb)',
    'public.claim_shipments_to_send(int)',
    'public.finish_shipment_send(uuid, text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- What members do. Packing and posting is everyone's job; undoing a shipment
-- is for owners and admins.
-- ---------------------------------------------------------------------------

create function private.member_shipping_order(p_id uuid)
returns public.shipping_orders
language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.shipping_orders;
begin
  select * into v_order from public.shipping_orders so
  where so.id = p_id and so.tenant_id in (select private.user_tenant_ids())
  for update;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  return v_order;
end;
$$;
revoke all on function private.member_shipping_order(uuid) from public;

create function public.set_shipping_hold(p_id uuid, p_hold boolean, p_reason text default '')
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.shipping_orders := private.member_shipping_order(p_id);
begin
  update public.shipping_orders so
  set on_hold = coalesce(p_hold, false),
      hold_reason = case when coalesce(p_hold, false) then left(btrim(coalesce(p_reason, '')), 300) else '' end
  where so.id = v_order.id;
end;
$$;

create function public.mark_slips_printed(p_tenant_id uuid, p_ids uuid[])
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  perform private.require_member(p_tenant_id);
  update public.shipping_orders so set slip_printed_at = now()
  where so.tenant_id = p_tenant_id and so.id = any (coalesce(p_ids, '{}'));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Applies (p_sign = -1) or gives back (+1) a shipment's quantities on its order.
create function private.adjust_shipping_left(p_order_id uuid, p_items jsonb, p_sign int)
returns void
language sql security definer set search_path = ''
as $$
  with next as (
    select coalesce(jsonb_agg(
             i.value || jsonb_build_object('left', greatest(0, least((i.value ->> 'qty')::int,
               (i.value ->> 'left')::int + p_sign * coalesce((
                 select sum((s ->> 'qty')::int) from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) s
                 where s ->> 'line_id' = i.value ->> 'line_id'), 0))))
             order by i.ordinality), '[]'::jsonb) as items
    from public.shipping_orders so, jsonb_array_elements(so.items) with ordinality i
    where so.id = p_order_id
  )
  update public.shipping_orders so
  set items = next.items,
      units_left = coalesce((select sum((x ->> 'left')::int) from jsonb_array_elements(next.items) x), 0)
  from next where so.id = p_order_id;
$$;
revoke all on function private.adjust_shipping_left(uuid, jsonb, int) from public;

-- Records a parcel. With an order, `p_items` says which lines and how many
-- went ([{"line_id", "qty"}]; empty means everything left). Without one it is
-- a parcel of its own (a replacement, a sample).
create function public.record_shipment(
  p_tenant_id uuid,
  p_shipping_order_id uuid,
  p_carrier text,
  p_service text,
  p_tracking_number text,
  p_tracking_url text,
  p_cost numeric,
  p_items jsonb,
  p_note text,
  p_push boolean default false,
  p_notify boolean default false,
  p_recipient text default null,
  p_destination text default null
)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.shipping_orders;
  v_items jsonb := '[]'::jsonb;
  v_number int;
begin
  perform private.require_member(p_tenant_id);
  -- Locking the workspace row keeps shipment numbers in step.
  perform 1 from public.tenants t where t.id = p_tenant_id for update;

  if p_shipping_order_id is not null then
    v_order := private.member_shipping_order(p_shipping_order_id);
    if v_order.tenant_id <> p_tenant_id then
      raise exception 'Order not found' using errcode = 'P0002';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
             'line_id', i ->> 'line_id', 'title', i ->> 'title', 'variant', i ->> 'variant',
             'qty', least((i ->> 'left')::int, coalesce(w.qty, (i ->> 'left')::int)))), '[]'::jsonb)
    into v_items
    from jsonb_array_elements(v_order.items) i
    left join (
      select s ->> 'line_id' as line_id, sum(greatest(0, (s ->> 'qty')::int))::int as qty
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) s group by 1
    ) w on w.line_id = i ->> 'line_id'
    where (i ->> 'left')::int > 0
      and (jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 or coalesce(w.qty, 0) > 0);
    if jsonb_array_length(v_items) = 0 then
      raise exception 'Nothing left to send on this order' using errcode = 'P0001';
    end if;
  end if;

  insert into public.shipments
    (tenant_id, number, shipping_order_id, order_name, recipient, destination, carrier, service,
     tracking_number, tracking_url, cost, items, note, notify_customer, created_by, shop_status)
  values
    (p_tenant_id,
     (select coalesce(max(s.number), 0) + 1 from public.shipments s where s.tenant_id = p_tenant_id),
     v_order.id, v_order.name,
     coalesce(v_order.recipient, nullif(btrim(coalesce(p_recipient, '')), '')),
     case when v_order.id is not null
          then nullif(concat_ws(', ', v_order.city, v_order.region, v_order.country_code), '')
          else nullif(btrim(coalesce(p_destination, '')), '') end,
     btrim(p_carrier), btrim(coalesce(p_service, '')), btrim(coalesce(p_tracking_number, '')),
     nullif(btrim(coalesce(p_tracking_url, '')), ''), p_cost, v_items,
     left(btrim(coalesce(p_note, '')), 500), coalesce(p_notify, false), auth.uid(),
     case when coalesce(p_push, false) and v_order.id is not null then 'pending' else 'skipped' end)
  returning number into v_number;

  if v_order.id is not null then
    perform private.adjust_shipping_left(v_order.id, v_items, -1);
    update public.shipping_orders so set on_hold = false, hold_reason = '' where so.id = v_order.id;
  end if;
  return v_number;
end;
$$;

-- Undoes a shipment that was recorded by mistake. Its items go back on the
-- order's to-send list. One already marked as sent in the shop has to be
-- undone there too; we don't reach in and cancel it.
create function public.void_shipment(p_id uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_shipment public.shipments;
begin
  select * into v_shipment from public.shipments s
  where s.id = p_id and s.tenant_id in (select private.user_tenant_ids())
  for update;
  if not found or v_shipment.voided_at is not null then
    raise exception 'Shipment not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_shipment.tenant_id);
  update public.shipments s
  set voided_at = now(),
      shop_status = case when s.shop_status in ('pending', 'sending') then 'skipped' else s.shop_status end
  where s.id = v_shipment.id;
  if v_shipment.shipping_order_id is not null then
    perform private.adjust_shipping_left(v_shipment.shipping_order_id, v_shipment.items, 1);
  end if;
  return v_shipment.shop_status;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.set_shipping_hold(uuid, boolean, text)',
    'public.mark_slips_printed(uuid, uuid[])',
    'public.record_shipment(uuid, uuid, text, text, text, text, numeric, jsonb, text, boolean, boolean, text, text)',
    'public.void_shipment(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
