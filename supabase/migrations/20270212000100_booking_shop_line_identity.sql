-- A shop booking is known by the order's lines, not by the date it sits on.
--
-- Before this, `book_from_shop` found an order's booking by order and date.
-- A booking moved to another date (by a manager here, or in the earlier app
-- before it was brought across) no longer sat on the date the cart named, so
-- the next time the shop mentioned the order (fulfilled, edited, refunded in
-- part, or read again in full) the line was booked a second time on its
-- original date and a new confirmation went out.
--
-- Now each booking made from a shop order remembers the shop's own ids for
-- the lines it came from (`shop_line_ids`) and the date their cart named
-- (`shop_cart_session_id`), neither of which a move changes. A line that
-- already has a booking anywhere in the workspace, confirmed or cancelled,
-- moved or not, is never booked again; the sync keeps that booking in step
-- with the order (fewer places, cancelled on a refund) wherever it now sits.
--
-- Bookings from before this know only the order and the date they sit on.
-- They are matched, in this order:
--   1. by line: a booking that already carries one of the line's ids;
--   2. by the date the cart named;
--   3. a booking of the order on that date that hasn't been placed yet;
--   4. one that was moved before lines were kept: a booking of the same
--      order and workshop on a date none of the order's lines names, given
--      to the order's not-yet-placed dates of that workshop oldest line
--      first. A booking a manager put on a date from "Needs a date" is never
--      taken this way (it belongs to its own line).
-- Whatever is matched is then marked with the line and the cart's date, so
-- it is known by its line from then on.
--
-- The lines of an order come from what the sync stored just before
-- (`order_lines`, by the shop's own ids, `session_ref` being the cart's
-- date), so a worker from before this change gets the same answer.
--
-- A new line naming a date where the order's moved booking already sits
-- can't be a second booking there (one per order and date): it is answered
-- `clash` for a person to sort out, never dropped silently.

alter table public.bookings
  add column shop_line_ids text[],
  add column shop_cart_session_id uuid;

-- The dates an order's lines carried, each with the shop's ids for its lines
-- (smallest first, as the shop gives them out in order).
create function private.shop_order_cart(p_tenant_id uuid, p_order_id text)
returns table (session_id uuid, line_ids text[])
language sql stable security definer set search_path = ''
as $$
  select l.session_ref,
         array_agg(distinct l.external_id order by l.external_id)
  from public.orders o
  join public.order_lines l on l.order_id = o.id
  where o.tenant_id = p_tenant_id and o.external_id = p_order_id
    and l.session_ref is not null
  group by l.session_ref;
$$;
revoke all on function private.shop_order_cart(uuid, text) from public;

-- Orders a list of line ids by the number they are ("9" before "10").
create function private.shop_line_rank(p_line_ids text[])
returns text
language sql immutable set search_path = ''
as $$
  select coalesce((select lpad(x, 40, '0') from unnest(p_line_ids) x
                   order by lpad(x, 40, '0') limit 1), '~');
$$;
revoke all on function private.shop_line_rank(text[]) from public;

-- The booking that already stands for an order's lines on a date the cart
-- named, wherever it sits now, or null. See the top of this file.
create function private.shop_booking_for(p_tenant_id uuid, p_order_id text, p_session_id uuid)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_lines text[];
  v_id uuid;
  v_service uuid;
begin
  select c.line_ids into v_lines
  from private.shop_order_cart(p_tenant_id, p_order_id) c where c.session_id = p_session_id;

  -- 1. By line.
  if coalesce(cardinality(v_lines), 0) > 0 then
    select b.id into v_id from public.bookings b
    where b.tenant_id = p_tenant_id and b.shop_order_id = p_order_id
      and b.shop_line_ids && v_lines
    order by (b.status = 'confirmed') desc, b.created_at, b.id
    limit 1;
    if v_id is not null then
      return v_id;
    end if;
  end if;

  -- 2. By the date the cart named.
  select b.id into v_id from public.bookings b
  where b.tenant_id = p_tenant_id and b.shop_order_id = p_order_id
    and b.shop_cart_session_id = p_session_id
  order by (b.status = 'confirmed') desc, b.created_at, b.id
  limit 1;
  if v_id is not null then
    return v_id;
  end if;

  -- 3. On that date, not placed yet.
  select b.id into v_id from public.bookings b
  where b.tenant_id = p_tenant_id and b.shop_order_id = p_order_id
    and b.session_id = p_session_id and b.shop_cart_session_id is null;
  if v_id is not null then
    return v_id;
  end if;

  -- 4. Moved before lines were kept.
  select s.service_id into v_service from public.sessions s
  where s.id = p_session_id and s.tenant_id = p_tenant_id;
  if v_service is null then
    return null;
  end if;
  with cart as (
    select c.session_id, c.line_ids from private.shop_order_cart(p_tenant_id, p_order_id) c
    union all
    select p_session_id, coalesce(v_lines, '{}')
    where v_lines is null
  ),
  open_dates as (
    select c.session_id,
           row_number() over (order by private.shop_line_rank(c.line_ids), c.session_id) as rn
    from cart c
    join public.sessions s on s.id = c.session_id
    where s.service_id = v_service
      and not exists (
        select 1 from public.bookings b
        where b.tenant_id = p_tenant_id and b.shop_order_id = p_order_id
          and (b.shop_cart_session_id = c.session_id
               or (b.shop_cart_session_id is null and b.session_id = c.session_id)
               or (cardinality(c.line_ids) > 0 and b.shop_line_ids && c.line_ids)))
  ),
  orphans as (
    select b.id, row_number() over (order by b.created_at, b.id) as rn
    from public.bookings b
    join public.sessions s on s.id = b.session_id
    where b.tenant_id = p_tenant_id and b.shop_order_id = p_order_id
      and b.shop_cart_session_id is null and b.shop_line_ids is null
      and s.service_id = v_service
      and b.session_id not in (select c.session_id from cart c)
      and not exists (select 1 from public.shop_undated_lines u where u.booking_id = b.id)
  )
  select o.id into v_id
  from orphans o join open_dates d on d.rn = o.rn
  where d.session_id = p_session_id;
  return v_id;
end;
$$;
revoke all on function private.shop_booking_for(uuid, text, uuid) from public;

-- Books (or keeps in step) the places an order paid for on one date its
-- lines named. Safe to repeat. Returns
--   {result: booked | resized | cancelled | unchanged | nothing | no_session
--            | clash, booking_id, oversold, date_cancelled}
create or replace function public.book_from_shop(
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
  v_match uuid;
  v_where uuid;
  v_lines text[];
  v_currency text;
  v_seats int := least(greatest(coalesce(p_seats, 0), 0), 50);
  v_over boolean;
begin
  -- Find the booking first, so the date it sits on now is locked with the
  -- cart's date, in the one order; then look again under the locks.
  v_match := private.shop_booking_for(p_tenant_id, p_order_id, p_session_id);
  select b.session_id into v_where from public.bookings b where b.id = v_match;
  perform private.lock_seats(array_remove(array[p_session_id, v_where], null));
  v_match := private.shop_booking_for(p_tenant_id, p_order_id, p_session_id);
  select c.line_ids into v_lines
  from private.shop_order_cart(p_tenant_id, p_order_id) c where c.session_id = p_session_id;

  select * into v_session from public.sessions s
  where s.id = p_session_id and s.tenant_id = p_tenant_id;
  if not found and v_match is null then
    return jsonb_build_object('result', 'no_session');
  end if;

  if v_match is not null then
    -- Known by its line and the cart's date from now on.
    update public.bookings b
    set shop_cart_session_id = coalesce(b.shop_cart_session_id, p_session_id),
        shop_line_ids = (select array_agg(distinct x order by x)
                         from unnest(coalesce(b.shop_line_ids, '{}') || coalesce(v_lines, '{}')) x)
    where b.id = v_match
      and (b.shop_cart_session_id is null
           or not (coalesce(v_lines, '{}') <@ coalesce(b.shop_line_ids, '{}')));
    select * into v_booking from public.bookings b where b.id = v_match;
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
  -- One booking per order and date: a booking of this order moved onto this
  -- date from another line is already here. A person sorts that out.
  select * into v_booking from public.bookings b
  where b.tenant_id = p_tenant_id and b.shop_order_id = p_order_id
    and b.session_id = v_session.id;
  if found then
    return jsonb_build_object('result', 'clash', 'booking_id', v_booking.id);
  end if;
  -- Paid: booked whatever the room, and flagged when over either limit.
  v_over := not private.has_room(v_session.id, v_seats) or v_session.cancelled_at is not null;
  select t.currency into v_currency from public.tenants t where t.id = p_tenant_id;
  insert into public.bookings
    (tenant_id, session_id, customer_name, customer_email, seats, status, amount_cents, currency,
     manage_token_hash, confirmed_at, source, oversold, shop_order_id, shop_order_name,
     shop_line_ids, shop_cart_session_id)
  values
    (p_tenant_id, v_session.id,
     left(coalesce(nullif(btrim(p_name), ''), nullif(btrim(p_email), ''), 'Guest'), 120),
     lower(btrim(coalesce(p_email, ''))), v_seats, 'confirmed',
     greatest(coalesce(p_amount_cents, 0), 0), v_currency,
     private.hash_token(p_manage_token), now(), 'online', v_over,
     p_order_id, left(coalesce(p_order_name, ''), 40),
     nullif(v_lines, '{}'), v_session.id)
  returning * into v_booking;
  return jsonb_build_object(
    'result', 'booked', 'booking_id', v_booking.id, 'oversold', v_over,
    'date_cancelled', v_session.cancelled_at is not null);
end;
$$;
