-- Shipping, round two: a fuller to-ship queue (what the shopper chose and
-- paid, weight, pickup), holds that end on a date, in-store pickup kept
-- here, and a small report. No new tables: everything hangs off
-- `shipping_orders` and `shipments`, which already carry tenant_id and RLS.

alter table public.shipping_orders
  -- What the shopper paid for shipping, in the order's currency.
  add column shipping_paid numeric(12, 2) check (shipping_paid is null or shipping_paid >= 0),
  add column weight_grams bigint check (weight_grams is null or weight_grams >= 0),
  -- The shopper is collecting it; nothing to post.
  add column pickup boolean not null default false,
  -- The workspace's own, kept across syncs like the hold itself.
  -- A hold with a date is over once that day arrives where the workspace is;
  -- that is worked out when the queue is read, so nothing has to wake up.
  add column hold_until date,
  add column pickup_ready_at timestamptz,
  add column picked_up_at timestamptz;

-- ---------------------------------------------------------------------------
-- Sync (service role, one named workspace)
-- ---------------------------------------------------------------------------

-- As before, plus what the shopper chose and paid, the weight and whether it
-- is a pickup. The workspace's own marks (hold, slip printed, pickup steps)
-- are still left alone.
create or replace function public.upsert_shipping_orders(p_tenant_id uuid, p_provider text, p_orders jsonb)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.shipping_orders
    (tenant_id, order_id, provider, external_id, name, placed_at, recipient, company, address1,
     address2, city, region, postal_code, country_code, phone, email, shipping_method, note, items,
     units_left, cancelled, paid, shipping_paid, weight_grams, pickup, synced_at)
  select p_tenant_id, o.id, p_provider, s.external_id, o.name, o.processed_at,
         nullif(btrim(s.recipient), ''), nullif(btrim(s.company), ''), nullif(btrim(s.address1), ''),
         nullif(btrim(s.address2), ''), nullif(btrim(s.city), ''), nullif(btrim(s.region), ''),
         nullif(btrim(s.postal_code), ''), nullif(upper(btrim(s.country_code)), ''),
         nullif(btrim(s.phone), ''), o.email, nullif(left(btrim(s.shipping_method), 200), ''),
         nullif(left(btrim(s.note), 1000), ''), coalesce(s.items, '[]'::jsonb),
         coalesce((select sum(greatest(0, (i ->> 'left')::int))
                   from jsonb_array_elements(coalesce(s.items, '[]'::jsonb)) i), 0),
         o.cancelled_at is not null, coalesce(s.paid, true),
         case when s.shipping_paid >= 0 then round(s.shipping_paid, 2) end,
         case when s.weight_grams >= 0 then s.weight_grams end,
         coalesce(s.pickup, false), now()
  from jsonb_to_recordset(coalesce(p_orders, '[]'::jsonb)) as s(
    external_id text, recipient text, company text, address1 text, address2 text, city text,
    region text, postal_code text, country_code text, phone text, shipping_method text, note text,
    items jsonb, paid boolean, shipping_paid numeric, weight_grams bigint, pickup boolean)
  join public.orders o
    on o.tenant_id = p_tenant_id and o.provider = p_provider and o.external_id = s.external_id
  on conflict (order_id) do update set
    name = excluded.name, placed_at = excluded.placed_at, recipient = excluded.recipient,
    company = excluded.company, address1 = excluded.address1, address2 = excluded.address2,
    city = excluded.city, region = excluded.region, postal_code = excluded.postal_code,
    country_code = excluded.country_code, phone = excluded.phone, email = excluded.email,
    shipping_method = excluded.shipping_method, note = excluded.note, items = excluded.items,
    units_left = excluded.units_left, cancelled = excluded.cancelled, paid = excluded.paid,
    shipping_paid = excluded.shipping_paid, weight_grams = excluded.weight_grams,
    pickup = excluded.pickup, synced_at = now();
$$;

-- ---------------------------------------------------------------------------
-- Privacy: a hold note is typed by staff and could name the shopper, so it
-- goes with the address when they ask to be forgotten.
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
-- What members do. Holding, releasing, pickup and packing are everyone's
-- job; undoing a pickup is for owners and admins.
-- ---------------------------------------------------------------------------

create function private.tenant_today(p_tenant_id uuid)
returns date
language sql stable security definer set search_path = ''
as $$
  select (now() at time zone t.timezone)::date from public.tenants t where t.id = p_tenant_id;
$$;
revoke all on function private.tenant_today(uuid) from public;

-- The one-order hold from before, now also clearing any end date.
create or replace function public.set_shipping_hold(p_id uuid, p_hold boolean, p_reason text default '')
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.shipping_orders := private.member_shipping_order(p_id);
begin
  update public.shipping_orders so
  set on_hold = coalesce(p_hold, false),
      hold_reason = case when coalesce(p_hold, false) then left(btrim(coalesce(p_reason, '')), 300) else '' end,
      hold_until = null
  where so.id = v_order.id;
end;
$$;

-- Sets orders aside, with a note and, if wanted, the day they come back.
create function public.hold_shipping_orders(
  p_tenant_id uuid,
  p_ids uuid[],
  p_note text default '',
  p_until date default null
)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  perform private.require_member(p_tenant_id);
  if p_until is not null and p_until <= private.tenant_today(p_tenant_id) then
    raise exception 'Pick a day after today' using errcode = 'P0001';
  end if;
  update public.shipping_orders so
  set on_hold = true, hold_reason = left(btrim(coalesce(p_note, '')), 300), hold_until = p_until
  where so.tenant_id = p_tenant_id and so.id = any (coalesce(p_ids, '{}'))
    and not so.cancelled and so.units_left > 0 and so.picked_up_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function public.release_shipping_orders(p_tenant_id uuid, p_ids uuid[])
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  perform private.require_member(p_tenant_id);
  update public.shipping_orders so
  set on_hold = false, hold_reason = '', hold_until = null
  where so.tenant_id = p_tenant_id and so.id = any (coalesce(p_ids, '{}')) and so.on_hold;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- A hold whose day has come stays marked ("Back from hold") until someone
-- opens the order. This is that opening. Does nothing to a hold still running.
create function public.clear_ended_shipping_hold(p_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.shipping_orders := private.member_shipping_order(p_id);
begin
  if not v_order.on_hold or v_order.hold_until is null
     or v_order.hold_until > private.tenant_today(v_order.tenant_id) then
    return false;
  end if;
  update public.shipping_orders so
  set on_hold = false, hold_reason = '', hold_until = null
  where so.id = v_order.id;
  return true;
end;
$$;

-- In-store pickup, kept here: packed and waiting, then collected.
create function public.mark_pickup_ready(p_tenant_id uuid, p_ids uuid[])
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  perform private.require_member(p_tenant_id);
  update public.shipping_orders so set pickup_ready_at = now()
  where so.tenant_id = p_tenant_id and so.id = any (coalesce(p_ids, '{}'))
    and so.pickup and so.pickup_ready_at is null and so.picked_up_at is null
    and not so.cancelled and so.units_left > 0;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function public.mark_picked_up(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.shipping_orders := private.member_shipping_order(p_id);
begin
  if not v_order.pickup then
    raise exception 'This order is not for pickup' using errcode = 'P0001';
  end if;
  if v_order.cancelled then
    raise exception 'This order was cancelled' using errcode = 'P0001';
  end if;
  update public.shipping_orders so
  set picked_up_at = coalesce(so.picked_up_at, now()),
      pickup_ready_at = coalesce(so.pickup_ready_at, now()),
      on_hold = false, hold_reason = '', hold_until = null
  where so.id = v_order.id;
end;
$$;

-- Steps a pickup back one: collected -> ready, or ready -> not ready.
create function public.undo_pickup(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.shipping_orders := private.member_shipping_order(p_id);
begin
  perform private.require_manager(v_order.tenant_id);
  update public.shipping_orders so
  set picked_up_at = null,
      pickup_ready_at = case when v_order.picked_up_at is null then null else so.pickup_ready_at end
  where so.id = v_order.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Report: postage against what shoppers paid for shipping, over the last
-- p_days. Sums are done here, in numeric. An order's shipping is counted once,
-- in the window its first parcel went out, however many boxes it took.
-- ---------------------------------------------------------------------------

create function public.shipping_report(p_tenant_id uuid, p_days int default 30)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 366)));
  v_report jsonb;
begin
  perform private.require_member(p_tenant_id);
  with live as (
    select s.id, s.cost, s.shipped_at, s.shipping_order_id
    from public.shipments s
    where s.tenant_id = p_tenant_id and s.voided_at is null
  ), sent as (
    select * from live where live.shipped_at >= v_since
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

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.hold_shipping_orders(uuid, uuid[], text, date)',
    'public.release_shipping_orders(uuid, uuid[])',
    'public.clear_ended_shipping_hold(uuid)',
    'public.mark_pickup_ready(uuid, uuid[])',
    'public.mark_picked_up(uuid)',
    'public.undo_pickup(uuid)',
    'public.shipping_report(uuid, int)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
