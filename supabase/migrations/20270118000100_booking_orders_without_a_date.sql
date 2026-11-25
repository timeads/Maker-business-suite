-- Shop orders for a workshop that arrive with no usable date on them.
--
-- The date picker on the product page puts the date on the cart line. Some
-- roads into the cart skip it ("Buy again" in the shop's customer accounts,
-- a quick-add button, an invoice made by hand), and then a paid place has
-- nowhere to go. Nothing paid is dropped: the line is written down here, the
-- team is told, and a manager puts it onto a date. After that the booking
-- follows the order like any other: a refund frees the place.
--
-- Only markers live here. Who bought, what and how many is read from what
-- the shop sync already stored (`orders`, `order_lines`, `customers`), so a
-- shopper who is forgotten there is forgotten here too.

create table public.shop_undated_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  provider text not null,
  -- The shop's own ids for the order and the line (the sync rewrites its
  -- `order_lines` rows, so those rows' ids can't be pointed at).
  shop_order_id text not null check (char_length(shop_order_id) between 1 and 40),
  line_id text not null check (char_length(line_id) between 1 and 40),
  -- The order number as the shopper sees it, e.g. #1042.
  shop_order_name text not null default '' check (char_length(shop_order_name) <= 40),
  -- The workshop the line's product sells; empty when a manager added an
  -- order to a roster by its number for some other product.
  service_id uuid references public.services (id) on delete set null,
  -- What the order holds now, kept in step by the sync: 0 once refunded.
  seats int not null default 0 check (seats between 0 and 100000),
  order_cancelled boolean not null default false,
  -- The booking a manager made from it.
  booking_id uuid references public.bookings (id) on delete set null,
  placed_at timestamptz,
  placed_by uuid references auth.users (id) on delete set null,
  -- Set aside by a manager: dealt with some other way.
  dismissed_at timestamptz,
  dismissed_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Once per order line, however often the shop tells us about it.
  unique (tenant_id, provider, shop_order_id, line_id)
);
create index shop_undated_lines_waiting_idx on public.shop_undated_lines (tenant_id)
  where booking_id is null and dismissed_at is null and seats > 0 and not order_cancelled;
create index shop_undated_lines_booking_idx on public.shop_undated_lines (booking_id)
  where booking_id is not null;

alter table public.shop_undated_lines enable row level security;
revoke all on public.shop_undated_lines from anon, authenticated;
grant select on public.shop_undated_lines to authenticated;
create policy shop_undated_lines_select on public.shop_undated_lines
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));

-- The sync hands over every line of an order with the date it carries, if
-- any. This keeps the ones with no usable date: none at all, or one that
-- names no date of this workspace (`had_date`).
create function private.undated_lines_in(p_tenant_id uuid, p_orders jsonb)
returns table (
  order_id text, name text, cancelled boolean, line_id text, product_id text, seats int,
  had_date boolean
)
language sql stable security definer set search_path = ''
as $$
  with lines as (
    select left(o ->> 'order_id', 40) as order_id, left(coalesce(o ->> 'name', ''), 40) as name,
           coalesce(o -> 'cancelled' = 'true'::jsonb, false) as cancelled,
           left(l ->> 'line_id', 40) as line_id, l ->> 'product_id' as product_id,
           case when jsonb_typeof(l -> 'seats') = 'number'
                then least(greatest((l ->> 'seats')::numeric, 0), 100000)::int else 0 end as seats,
           case when (l ->> 'session_id')
                     ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                then (l ->> 'session_id')::uuid end as session_id
    from jsonb_array_elements(
      case when jsonb_typeof(p_orders) = 'array' then p_orders else '[]'::jsonb end) o
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(o -> 'lines') = 'array' then o -> 'lines' else '[]'::jsonb end) l
    where coalesce(o ->> 'order_id', '') <> '' and coalesce(l ->> 'line_id', '') <> ''
  )
  select x.order_id, x.name, x.cancelled, x.line_id, x.product_id, x.seats,
         x.session_id is not null
  from lines x
  where x.session_id is null
     or not exists (
       select 1 from public.sessions s
       where s.id = x.session_id and s.tenant_id = p_tenant_id);
$$;
revoke all on function private.undated_lines_in(uuid, jsonb) from public;

-- Called by the shop sync (service role) with the lines of each order:
--   [{ "order_id": "5001", "name": "#1042", "cancelled": false,
--      "lines": [{ "line_id": "77", "product_id": "9001", "seats": 2,
--                  "session_id": null }] }]
-- It does two jobs, both safe to repeat:
--   1. A line already written down is brought up to date, and the booking a
--      manager made from it follows the order: fewer places, or cancelled
--      when the line is refunded or the order cancelled.
--   2. A line with no usable date that isn't written down yet is, when it is
--      for a workshop sold through the shop or carried a date we can't find,
--      and is handed back once so the team can be told.
-- Returns { "new": [...], "cancelled": [booking ids], "known": n }.
create function public.note_shop_undated_lines(p_tenant_id uuid, p_provider text, p_orders jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_new jsonb;
  v_cancelled jsonb;
  v_known int;
begin
  -- Nothing to do for a workspace with no workshops and nothing written
  -- down: most shops, on every page of orders.
  if not exists (select 1 from public.services sv where sv.tenant_id = p_tenant_id)
     and not exists (select 1 from public.shop_undated_lines u where u.tenant_id = p_tenant_id) then
    return jsonb_build_object('new', '[]'::jsonb, 'cancelled', '[]'::jsonb, 'known', 0);
  end if;

  -- 1. Lines we already know.
  select count(*)::int into v_known
  from public.shop_undated_lines u
  join private.undated_lines_in(p_tenant_id, p_orders) i on i.order_id = u.shop_order_id and i.line_id = u.line_id
  where u.tenant_id = p_tenant_id and u.provider = p_provider;

  update public.shop_undated_lines u
  set seats = i.seats, order_cancelled = i.cancelled,
      shop_order_name = case when i.name <> '' then i.name else u.shop_order_name end,
      updated_at = now()
  from private.undated_lines_in(p_tenant_id, p_orders) i
  where u.tenant_id = p_tenant_id and u.provider = p_provider
    and u.shop_order_id = i.order_id and u.line_id = i.line_id
    and (u.seats, u.order_cancelled) is distinct from (i.seats, i.cancelled);

  with gone as (
    update public.bookings b
    set status = 'cancelled', cancelled_at = now()
    from public.shop_undated_lines u
    join private.undated_lines_in(p_tenant_id, p_orders) i on i.order_id = u.shop_order_id and i.line_id = u.line_id
    where u.tenant_id = p_tenant_id and u.provider = p_provider
      and b.id = u.booking_id and b.tenant_id = p_tenant_id and b.status = 'confirmed'
      and (i.cancelled or i.seats = 0)
    returning b.id
  )
  select coalesce(jsonb_agg(g.id), '[]'::jsonb) into v_cancelled from gone g;

  update public.bookings b
  set seats = least(i.seats, 50)
  from public.shop_undated_lines u
  join private.undated_lines_in(p_tenant_id, p_orders) i on i.order_id = u.shop_order_id and i.line_id = u.line_id
  where u.tenant_id = p_tenant_id and u.provider = p_provider
    and b.id = u.booking_id and b.tenant_id = p_tenant_id and b.status = 'confirmed'
    and not i.cancelled and i.seats > 0 and b.seats <> least(i.seats, 50);

  -- 2. New lines: for a workshop this workspace sells through its shop, or
  --    carrying a date that isn't one of ours.
  with added as (
    insert into public.shop_undated_lines
      (tenant_id, provider, shop_order_id, line_id, shop_order_name, service_id, seats)
    select p_tenant_id, p_provider, i.order_id, i.line_id, i.name, sv.id, i.seats
    from private.undated_lines_in(p_tenant_id, p_orders) i
    left join public.services sv
      on sv.tenant_id = p_tenant_id and sv.shop_product_id = i.product_id and sv.kind = 'workshop'
    where not i.cancelled and i.seats > 0 and (sv.id is not null or i.had_date)
    on conflict (tenant_id, provider, shop_order_id, line_id) do nothing
    returning id, shop_order_id, shop_order_name, service_id, seats
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'order_id', a.shop_order_id, 'order_name', a.shop_order_name,
           'service_name', sv.name, 'seats', a.seats)), '[]'::jsonb)
  into v_new
  from added a left join public.services sv on sv.id = a.service_id;

  return jsonb_build_object('new', v_new, 'cancelled', v_cancelled, 'known', v_known);
end;
$$;
revoke all on function public.note_shop_undated_lines(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.note_shop_undated_lines(uuid, text, jsonb) to service_role;

-- Who bought an order, from what the sync stored.
create function private.shop_order_buyer(p_order public.orders)
returns table (customer_name text, customer_email text)
language sql stable security definer set search_path = ''
as $$
  select left(coalesce(
           nullif(btrim(concat_ws(' ', c.first_name, c.last_name)), ''),
           nullif(btrim(coalesce(p_order.email, '')), ''), 'Guest'), 120),
         lower(btrim(coalesce(p_order.email, c.email, '')))
  from (select 1) one
  left join public.customers c
    on c.tenant_id = p_order.tenant_id and c.provider = p_order.provider
   and c.external_id = p_order.customer_external_id;
$$;
revoke all on function private.shop_order_buyer(public.orders) from public;

-- Finds a stored shop order by the number a person typed ("#1042", "1042")
-- and says what each of its lines could do on this date. Nothing is asked of
-- the shop: only what the sync already brought in. Owners and admins only.
create function public.find_shop_order_for_session(p_session_id uuid, p_number text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_session public.sessions;
  v_order public.orders;
  v_typed text := lower(btrim(coalesce(p_number, '')));
  v_digits text := regexp_replace(coalesce(p_number, ''), '\D', '', 'g');
  v_buyer record;
  v_lines jsonb;
begin
  select * into v_session from public.sessions s where s.id = p_session_id;
  if not found or not (v_session.tenant_id in (select private.user_tenant_ids())) then
    raise exception 'Session not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_session.tenant_id);
  if v_typed = '' or char_length(v_typed) > 40 then
    return null;
  end if;

  -- The name exactly as typed (with or without the #) first; then, for a
  -- plain number, the order whose number it is whatever the shop puts
  -- around it. The newest wins if a shop ever reused a number.
  select o.* into v_order
  from public.orders o
  where o.tenant_id = v_session.tenant_id and o.name is not null
    and (ltrim(lower(o.name), '#') = ltrim(v_typed, '#')
         or (v_digits <> '' and ltrim(v_typed, '#') = v_digits
             and regexp_replace(o.name, '\D', '', 'g') = v_digits))
  order by (ltrim(lower(o.name), '#') = ltrim(v_typed, '#')) desc, o.processed_at desc
  limit 1;
  if not found then
    return null;
  end if;
  select * into v_buyer from private.shop_order_buyer(v_order);

  select coalesce(jsonb_agg(jsonb_build_object(
    'line_id', l.external_id,
    'title', concat_ws(' · ', l.title, nullif(l.variant_title, '')),
    'seats', l.quantity,
    'amount_cents', round(l.unit_price * 100)::int * l.quantity,
    -- placed: a manager already put this line on a date.
    -- booked: the order already has a booking for the workshop this line
    --         sells, made from the date the shopper picked; move that one.
    -- refunded: nothing left on the line.
    'state', case
      when l.quantity <= 0 then 'refunded'
      when placed.id is not null then 'placed'
      when dated.id is not null then 'booked'
      else 'open' end,
    'on_session', coalesce(placed.session_id, dated.session_id)
  ) order by l.external_id), '[]'::jsonb)
  into v_lines
  from public.order_lines l
  left join lateral (
    select b.id, b.session_id
    from public.shop_undated_lines u
    join public.bookings b on b.id = u.booking_id and b.status = 'confirmed'
    where u.tenant_id = v_order.tenant_id and u.provider = v_order.provider
      and u.shop_order_id = v_order.external_id and u.line_id = l.external_id
    limit 1) placed on true
  left join lateral (
    select b.id, b.session_id
    from public.bookings b
    join public.sessions s on s.id = b.session_id
    join public.services sv on sv.id = s.service_id
    where b.tenant_id = v_order.tenant_id and b.shop_order_id = v_order.external_id
      and b.status = 'confirmed' and sv.shop_product_id = l.product_external_id
      and not exists (
        select 1 from public.shop_undated_lines u2 where u2.booking_id = b.id)
    limit 1) dated on true
  where l.order_id = v_order.id;

  return jsonb_build_object(
    'order_id', v_order.external_id,
    'provider', v_order.provider,
    'name', v_order.name,
    'cancelled', v_order.cancelled_at is not null,
    'customer_name', v_buyer.customer_name,
    'customer_email', v_buyer.customer_email,
    'lines', v_lines);
end;
$$;
revoke all on function public.find_shop_order_for_session(uuid, text) from public, anon;
grant execute on function public.find_shop_order_for_session(uuid, text) to authenticated;

-- Puts one line of a stored shop order onto a date: from the "needs a date"
-- list, or from a roster by the order's number. Owners and admins only.
--
-- Seats are worked out under the date's row lock, as everywhere. A paid
-- place is never turned away for being full: it is booked and flagged
-- oversold. One line makes one booking; a second press finds the first.
create function public.place_shop_order_line(
  p_session_id uuid,
  p_provider text,
  p_order_id text,
  p_line_id text,
  p_manage_token text
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_session public.sessions;
  v_service public.services;
  v_order public.orders;
  v_line public.order_lines;
  v_marker public.shop_undated_lines;
  v_booking public.bookings;
  v_buyer record;
  v_currency text;
  v_seats int;
  v_over boolean;
  v_revive boolean := false;
begin
  select * into v_session from public.sessions s where s.id = p_session_id for update;
  if not found or not (v_session.tenant_id in (select private.user_tenant_ids())) then
    raise exception 'Session not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_session.tenant_id);
  if v_session.cancelled_at is not null then
    raise exception 'date_cancelled' using errcode = 'P0001';
  end if;
  select * into v_service from public.services sv where sv.id = v_session.service_id;

  select * into v_order from public.orders o
  where o.tenant_id = v_session.tenant_id and o.provider = p_provider and o.external_id = p_order_id;
  if not found then
    raise exception 'order_missing' using errcode = 'P0001';
  end if;
  select * into v_line from public.order_lines l
  where l.order_id = v_order.id and l.external_id = p_line_id;
  if not found then
    raise exception 'order_missing' using errcode = 'P0001';
  end if;
  if v_order.cancelled_at is not null then
    raise exception 'order_cancelled' using errcode = 'P0001';
  end if;
  if v_line.quantity <= 0 then
    raise exception 'line_refunded' using errcode = 'P0001';
  end if;
  v_seats := least(v_line.quantity, 50);

  -- The marker is the "once per order line": made here if the sync didn't
  -- write one (an order added by its number), then locked.
  insert into public.shop_undated_lines
    (tenant_id, provider, shop_order_id, line_id, shop_order_name, service_id, seats)
  values (v_session.tenant_id, p_provider, v_order.external_id, v_line.external_id,
          left(coalesce(v_order.name, ''), 40),
          (select sv.id from public.services sv
           where sv.tenant_id = v_session.tenant_id
             and sv.shop_product_id = v_line.product_external_id and sv.kind = 'workshop'),
          v_line.quantity)
  on conflict (tenant_id, provider, shop_order_id, line_id) do nothing;
  select * into v_marker from public.shop_undated_lines u
  where u.tenant_id = v_session.tenant_id and u.provider = p_provider
    and u.shop_order_id = v_order.external_id and u.line_id = v_line.external_id
  for update;

  if v_marker.booking_id is not null then
    select * into v_booking from public.bookings b where b.id = v_marker.booking_id;
    if v_booking.status = 'confirmed' then
      -- A second press, or two people at once: the first one's booking stands.
      return jsonb_build_object('result', 'already', 'booking_id', v_booking.id,
                                'session_id', v_booking.session_id);
    end if;
  end if;

  -- One booking per order and date. If the order already has one here that
  -- isn't this line's, it came from the date the shopper picked.
  select * into v_booking from public.bookings b
  where b.tenant_id = v_session.tenant_id and b.shop_order_id = v_order.external_id
    and b.session_id = v_session.id;
  if found then
    if v_booking.id is distinct from v_marker.booking_id then
      raise exception 'already_on_date' using errcode = 'P0001';
    end if;
    v_revive := true;
  end if;

  v_over := private.seats_taken(v_session.id) + v_seats > v_session.capacity;
  select * into v_buyer from private.shop_order_buyer(v_order);
  if v_revive then
    -- This line was on this date before and was cancelled by hand: back on.
    update public.bookings b
    set status = 'confirmed', cancelled_at = null, seats = v_seats, oversold = v_over,
        confirmed_at = now(), manage_token_hash = private.hash_token(p_manage_token)
    where b.id = v_booking.id
    returning * into v_booking;
  else
    select t.currency into v_currency from public.tenants t where t.id = v_session.tenant_id;
    insert into public.bookings
      (tenant_id, session_id, customer_name, customer_email, seats, status, amount_cents,
       currency, manage_token_hash, confirmed_at, source, oversold, shop_order_id,
       shop_order_name)
    values
      (v_session.tenant_id, v_session.id, v_buyer.customer_name, v_buyer.customer_email, v_seats,
       'confirmed', greatest(round(v_line.unit_price * 100)::int * v_seats, 0), v_currency,
       private.hash_token(p_manage_token), now(), 'online', v_over,
       v_order.external_id, left(coalesce(v_order.name, ''), 40))
    returning * into v_booking;
  end if;

  update public.shop_undated_lines u
  set booking_id = v_booking.id, placed_at = now(), placed_by = auth.uid(),
      dismissed_at = null, dismissed_by = null, seats = v_line.quantity, updated_at = now()
  where u.id = v_marker.id;

  return jsonb_build_object('result', 'booked', 'booking_id', v_booking.id,
                            'session_id', v_session.id, 'oversold', v_over,
                            'has_email', v_buyer.customer_email <> '');
end;
$$;
revoke all on function public.place_shop_order_line(uuid, text, text, text, text)
  from public, anon;
grant execute on function public.place_shop_order_line(uuid, text, text, text, text)
  to authenticated;

-- Sets a waiting line aside (dealt with some other way), or brings it back.
create function public.set_shop_undated_line_aside(p_line uuid, p_aside boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select u.tenant_id into v_tenant from public.shop_undated_lines u where u.id = p_line for update;
  if v_tenant is null or not (v_tenant in (select private.user_tenant_ids())) then
    raise exception 'Not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_tenant);
  update public.shop_undated_lines u
  set dismissed_at = case when coalesce(p_aside, true) then now() end,
      dismissed_by = case when coalesce(p_aside, true) then auth.uid() end,
      updated_at = now()
  where u.id = p_line and u.booking_id is null;
end;
$$;
revoke all on function public.set_shop_undated_line_aside(uuid, boolean) from public, anon;
grant execute on function public.set_shop_undated_line_aside(uuid, boolean) to authenticated;
