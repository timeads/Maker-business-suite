-- Day-to-day changes to dates and workshops, all for owners and admins:
--   1. A place on each workshop ("Studio 2, 4th floor"), shown to customers.
--   2. Change a date's day or time. Everyone booked keeps their place.
--   3. Delete a date made by mistake, only while nobody has ever booked it.
--   4. One press to raise an oversold date's limit (and its shared room's)
--      so everyone booked fits.

-- ---------------------------------------------------------------------------
-- 1. Where a workshop happens
-- ---------------------------------------------------------------------------

alter table public.services
  add column location text not null default '' check (char_length(location) <= 200);

create function public.set_service_location(p_service_id uuid, p_location text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select s.tenant_id into v_tenant from public.services s
  where s.id = p_service_id and s.tenant_id in (select private.user_tenant_ids());
  if v_tenant is null then
    raise exception 'Service not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_tenant);
  update public.services s
  set location = left(regexp_replace(btrim(coalesce(p_location, '')), '\s+', ' ', 'g'), 200)
  where s.id = p_service_id;
end;
$$;
revoke all on function public.set_service_location(uuid, text) from public, anon;
grant execute on function public.set_service_location(uuid, text) to authenticated;

-- The shop's date picker shows the place under the workshop's name.
create or replace function public.shop_booking_dates(p_tenant_id uuid, p_product_id text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'service', jsonb_build_object(
      'name', sv.name, 'duration_minutes', sv.duration_minutes, 'variant_id', sv.shop_variant_id,
      'location', sv.location),
    'sessions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'starts_at', s.starts_at,
        'seats_left', private.seats_left(s.id)) order by s.starts_at)
      from public.sessions s
      where s.service_id = sv.id and s.cancelled_at is null and not s.private
        and not s.bookings_closed and s.starts_at > now()
        and s.starts_at < now() + interval '400 days'), '[]'::jsonb))
  from public.services sv
  where sv.tenant_id = p_tenant_id and sv.shop_product_id = p_product_id and sv.active
    and sv.kind = 'workshop';
$$;

-- ---------------------------------------------------------------------------
-- 2. A new day or time for a date
-- ---------------------------------------------------------------------------

-- Moves a workshop date to a new start, keeping its length. Everyone booked
-- stays booked. Reminders work as they did in the business's earlier booking
-- app: a reminder or day-of email already sent for this date is not sent
-- again for the new time (it is recorded against the booking and the date,
-- which haven't changed); one not sent yet goes out at the right lead time
-- before the new start. Whether to email people about the change is the
-- person's choice on the page; the app sends that, not this.
-- Returns how many confirmed bookings the date has.
create function public.move_session(p_session_id uuid, p_starts_at timestamptz)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_session public.sessions;
  v_kind text;
  v_ends timestamptz;
  v_people int;
begin
  select s.* into v_session from public.sessions s
  where s.id = p_session_id and s.tenant_id in (select private.user_tenant_ids());
  if not found then
    raise exception 'Session not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_session.tenant_id);
  perform private.lock_seats(array[p_session_id]);
  select * into v_session from public.sessions s where s.id = p_session_id;
  select sv.kind into v_kind from public.services sv where sv.id = v_session.service_id;

  if v_kind <> 'workshop' then
    raise exception 'not_a_workshop' using errcode = 'P0001';
  end if;
  if v_session.cancelled_at is not null then
    raise exception 'date_cancelled' using errcode = 'P0001';
  end if;
  if v_session.starts_at <= now() then
    raise exception 'already_started' using errcode = 'P0001';
  end if;
  if p_starts_at is null or p_starts_at <= now() then
    raise exception 'in_the_past' using errcode = 'P0001';
  end if;
  if p_starts_at = v_session.starts_at then
    return jsonb_build_object('moved', false, 'people', 0);
  end if;
  v_ends := p_starts_at + (v_session.ends_at - v_session.starts_at);
  if exists (select 1 from public.sessions s
             where s.service_id = v_session.service_id and s.starts_at = p_starts_at
               and s.id <> p_session_id) then
    raise exception 'date_taken' using errcode = 'P0001';
  end if;
  -- A date sharing a room must still run at the same time as the others.
  if v_session.seat_group_id is not null and exists (
    select 1 from public.sessions s
    where s.seat_group_id = v_session.seat_group_id and s.id <> p_session_id
      and not (s.starts_at < v_ends and s.ends_at > p_starts_at)
  ) then
    raise exception 'shared_apart' using errcode = 'P0001';
  end if;

  update public.sessions s set starts_at = p_starts_at, ends_at = v_ends
  where s.id = p_session_id;
  select count(*)::int into v_people from public.bookings b
  where b.session_id = p_session_id and b.status = 'confirmed';
  perform private.log_audit(v_session.tenant_id, 'session.moved', 'session', p_session_id::text);
  return jsonb_build_object('moved', true, 'people', v_people);
end;
$$;
revoke all on function public.move_session(uuid, timestamptz) from public, anon;
grant execute on function public.move_session(uuid, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Delete a date nobody is booked on
-- ---------------------------------------------------------------------------

-- Only a date that has never had a booking of any kind (not even a
-- cancelled one, whose history should stay). A shared room left with one
-- date is untied. A cart still carrying the deleted date's id arrives as an
-- order with no usable date, and is listed under "Needs a date".
create function public.delete_session(p_session_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_session public.sessions;
begin
  select s.* into v_session from public.sessions s
  where s.id = p_session_id and s.tenant_id in (select private.user_tenant_ids());
  if not found then
    raise exception 'Session not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_session.tenant_id);
  -- This date and any it shares a room with, in the usual order.
  perform private.lock_seats(array(
    select s.id from public.sessions s
    where s.id = p_session_id
       or (v_session.seat_group_id is not null and s.seat_group_id = v_session.seat_group_id)));
  select * into v_session from public.sessions s where s.id = p_session_id;
  if exists (select 1 from public.bookings b where b.session_id = p_session_id) then
    raise exception 'has_bookings' using errcode = 'P0001';
  end if;
  delete from public.sessions s where s.id = p_session_id;
  if v_session.seat_group_id is not null
     and (select count(*) from public.sessions s where s.seat_group_id = v_session.seat_group_id) < 2 then
    update public.sessions s set seat_group_id = null where s.seat_group_id = v_session.seat_group_id;
    delete from public.session_seat_groups g where g.id = v_session.seat_group_id;
  end if;
  perform private.log_audit(v_session.tenant_id, 'session.deleted', 'session', p_session_id::text);
end;
$$;
revoke all on function public.delete_session(uuid) from public, anon;
grant execute on function public.delete_session(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Raise the limit to fit everyone booked
-- ---------------------------------------------------------------------------

-- Raises the date's own limit to what is booked, and its shared room's limit
-- when that is over too. Never lowers anything. The people on it are no
-- longer marked as over the limit. Returns the limits after.
create function public.raise_limit_to_fit(p_session_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_session public.sessions;
  v_taken int;
  v_shared int;
  v_shared_cap int;
begin
  select s.* into v_session from public.sessions s
  where s.id = p_session_id and s.tenant_id in (select private.user_tenant_ids());
  if not found then
    raise exception 'Session not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_session.tenant_id);
  perform private.lock_seats(array[p_session_id]);
  select * into v_session from public.sessions s where s.id = p_session_id;

  v_taken := private.seats_taken(p_session_id);
  if v_taken > 500 then
    raise exception 'too_many' using errcode = 'P0001';
  end if;
  update public.sessions s set capacity = greatest(s.capacity, v_taken)
  where s.id = p_session_id
  returning s.capacity into v_session.capacity;

  if v_session.seat_group_id is not null then
    v_shared := private.shared_seats_taken(v_session.seat_group_id);
    update public.session_seat_groups g set capacity = greatest(g.capacity, least(v_shared, 1000))
    where g.id = v_session.seat_group_id
    returning g.capacity into v_shared_cap;
    update public.bookings b set oversold = false
    from public.sessions s
    where b.session_id = s.id and s.seat_group_id = v_session.seat_group_id
      and b.status = 'confirmed' and b.oversold
      and s.cancelled_at is null and private.seats_taken(s.id) <= s.capacity;
  end if;
  update public.bookings b set oversold = false
  where b.session_id = p_session_id and b.status = 'confirmed' and b.oversold
    and v_session.cancelled_at is null;
  return jsonb_build_object('capacity', v_session.capacity, 'shared_capacity', v_shared_cap);
end;
$$;
revoke all on function public.raise_limit_to_fit(uuid) from public, anon;
grant execute on function public.raise_limit_to_fit(uuid) to authenticated;
