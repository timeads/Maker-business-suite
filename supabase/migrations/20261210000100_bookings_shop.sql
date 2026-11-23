-- Bookings sold through the business's own shop. The shopper picks a date on
-- the product page, pays at the shop's checkout, and the order arrives here
-- as a booking: the cart line carries the date's id. The shop owns the price
-- and the payment; this app owns the dates, the seats and the emails.

alter table public.services
  -- The shop's product (and the variant to put in the cart) that sells this.
  add column shop_product_id text check (shop_product_id ~ '^[0-9]{1,20}$'),
  add column shop_variant_id text check (shop_variant_id ~ '^[0-9]{1,20}$');
create unique index services_shop_product_idx
  on public.services (tenant_id, shop_product_id) where shop_product_id is not null;

alter table public.bookings
  add column shop_order_id text check (char_length(shop_order_id) <= 40),
  -- The order's number as the shopper sees it, e.g. #1042.
  add column shop_order_name text check (char_length(shop_order_name) <= 40);
-- One booking per order and date, however often the shop tells us about it.
create unique index bookings_shop_order_idx
  on public.bookings (tenant_id, shop_order_id, session_id) where shop_order_id is not null;
grant select (shop_order_id, shop_order_name) on public.bookings to authenticated;

-- A paid order is never turned away, even for a date that has since been
-- closed or made private: the guard is for the public booking page only.
create or replace function private.guard_online_booking()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.source = 'online' and new.shop_order_id is null and exists (
    select 1 from public.sessions s
    where s.id = new.session_id and (s.bookings_closed or s.private)
  ) then
    raise exception 'This time is no longer available' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Ties a workshop to the shop product that sells it (or unties it).
create function public.set_service_shop_product(
  p_service_id uuid, p_product_id text, p_variant_id text
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select s.tenant_id into v_tenant from public.services s where s.id = p_service_id;
  if v_tenant is null then
    raise exception 'Service not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_tenant);
  if nullif(btrim(coalesce(p_product_id, '')), '') is not null and exists (
    select 1 from public.services s
    where s.tenant_id = v_tenant and s.id <> p_service_id
      and s.shop_product_id = btrim(p_product_id)
  ) then
    raise exception 'product_taken' using errcode = 'P0001';
  end if;
  update public.services s
  set shop_product_id = nullif(btrim(coalesce(p_product_id, '')), ''),
      shop_variant_id = case when nullif(btrim(coalesce(p_product_id, '')), '') is null then null
                             else nullif(btrim(coalesce(p_variant_id, '')), '') end,
      updated_at = now()
  where s.id = p_service_id;
end;
$$;
revoke all on function public.set_service_shop_product(uuid, text, text) from public, anon;
grant execute on function public.set_service_shop_product(uuid, text, text) to authenticated;

-- What the product page's date picker shows: the workshop and its coming
-- dates with the seats left. Nothing about who has booked.
create function public.shop_booking_dates(p_tenant_id uuid, p_product_id text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'service', jsonb_build_object(
      'name', sv.name, 'duration_minutes', sv.duration_minutes, 'variant_id', sv.shop_variant_id),
    'sessions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'starts_at', s.starts_at,
        'seats_left', greatest(0, s.capacity - private.seats_taken(s.id))) order by s.starts_at)
      from public.sessions s
      where s.service_id = sv.id and s.cancelled_at is null and not s.private
        and not s.bookings_closed and s.starts_at > now()
        and s.starts_at < now() + interval '400 days'), '[]'::jsonb))
  from public.services sv
  where sv.tenant_id = p_tenant_id and sv.shop_product_id = p_product_id and sv.active
    and sv.kind = 'workshop';
$$;
revoke all on function public.shop_booking_dates(uuid, text) from public, anon, authenticated;
grant execute on function public.shop_booking_dates(uuid, text) to service_role;

-- Turns one line of a shop order into a booking, or brings an existing one
-- up to date. Safe to call again and again for the same order: the seats
-- follow what the order now says, and none left means the booking is
-- cancelled. A paid order that finds the date full is booked all the same
-- and flagged, never dropped.
create function public.book_from_shop(
  p_tenant_id uuid,
  p_session_id uuid,
  p_order_id text,
  p_order_name text,
  p_name text,
  p_email text,
  p_seats int,
  p_amount_cents int,
  p_manage_token text
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_session public.sessions;
  v_booking public.bookings;
  v_currency text;
  v_seats int := least(greatest(coalesce(p_seats, 0), 0), 50);
  v_over boolean;
begin
  select * into v_session from public.sessions s
  where s.id = p_session_id and s.tenant_id = p_tenant_id for update;
  if not found then
    return jsonb_build_object('result', 'no_session');
  end if;
  select * into v_booking from public.bookings b
  where b.tenant_id = p_tenant_id and b.shop_order_id = p_order_id and b.session_id = p_session_id;

  if found then
    if v_seats = 0 and v_booking.status = 'confirmed' then
      update public.bookings b set status = 'cancelled', cancelled_at = now()
      where b.id = v_booking.id;
      return jsonb_build_object('result', 'cancelled', 'booking_id', v_booking.id);
    end if;
    if v_seats > 0 and v_booking.status = 'confirmed' and v_booking.seats <> v_seats then
      update public.bookings b set seats = v_seats where b.id = v_booking.id;
      return jsonb_build_object('result', 'resized', 'booking_id', v_booking.id);
    end if;
    return jsonb_build_object('result', 'unchanged', 'booking_id', v_booking.id);
  end if;

  if v_seats = 0 then
    return jsonb_build_object('result', 'nothing');
  end if;
  v_over := private.seats_taken(v_session.id) + v_seats > v_session.capacity
    or v_session.cancelled_at is not null;
  select t.currency into v_currency from public.tenants t where t.id = p_tenant_id;
  insert into public.bookings
    (tenant_id, session_id, customer_name, customer_email, seats, status, amount_cents, currency,
     manage_token_hash, confirmed_at, source, oversold, shop_order_id, shop_order_name)
  values
    (p_tenant_id, v_session.id,
     left(coalesce(nullif(btrim(p_name), ''), nullif(btrim(p_email), ''), 'Guest'), 120),
     lower(btrim(coalesce(p_email, ''))), v_seats, 'confirmed',
     greatest(coalesce(p_amount_cents, 0), 0), v_currency,
     private.hash_token(p_manage_token), now(), 'online', v_over,
     p_order_id, left(coalesce(p_order_name, ''), 40))
  returning * into v_booking;
  return jsonb_build_object(
    'result', 'booked', 'booking_id', v_booking.id, 'oversold', v_over,
    'date_cancelled', v_session.cancelled_at is not null);
end;
$$;

-- The whole order was cancelled in the shop: its bookings go too.
create function public.cancel_shop_order(p_tenant_id uuid, p_order_id text)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  update public.bookings b set status = 'cancelled', cancelled_at = now()
  where b.tenant_id = p_tenant_id and b.shop_order_id = p_order_id and b.status = 'confirmed';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.book_from_shop(uuid, uuid, text, text, text, text, int, int, text)
  from public, anon, authenticated;
grant execute on function public.book_from_shop(uuid, uuid, text, text, text, text, int, int, text)
  to service_role;
revoke all on function public.cancel_shop_order(uuid, text) from public, anon, authenticated;
grant execute on function public.cancel_shop_order(uuid, text) to service_role;
