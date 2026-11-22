-- Fixes from the first end-to-end bookings test.

-- 1. Moving a booking frees a place on the date it left, so the people
--    waiting for that date are told, the same as when someone cancels.
drop function public.move_booking_by_token(text, uuid);

create function public.move_booking_by_token(p_manage_token text, p_new_session_id uuid)
returns setof public.waitlist
language plpgsql security definer set search_path = ''
as $$
declare
  v_booking public.bookings;
  v_old public.sessions;
  v_new public.sessions;
begin
  select * into v_booking from public.bookings b
  where b.manage_token_hash = private.hash_token(p_manage_token);
  if not found or v_booking.status <> 'confirmed' then
    raise exception 'Booking not found' using errcode = 'P0002';
  end if;
  select * into v_old from public.sessions s where s.id = v_booking.session_id;
  -- Lock in id order so two moves crossing over can't deadlock.
  perform 1 from public.sessions s
  where s.id in (v_booking.session_id, p_new_session_id) order by s.id for update;
  select * into v_new from public.sessions s
  where s.id = p_new_session_id and s.tenant_id = v_booking.tenant_id;
  if not found or v_new.id = v_old.id or v_new.service_id <> v_old.service_id
     or v_new.cancelled_at is not null
     or v_new.starts_at <= now() or v_old.starts_at <= now() then
    raise exception 'That time is not available' using errcode = 'P0001';
  end if;
  if private.seats_taken(v_new.id) + v_booking.seats > v_new.capacity then
    raise exception 'full' using errcode = 'P0001';
  end if;
  update public.bookings b set session_id = v_new.id, reminder_sent_at = null, oversold = false
  where b.id = v_booking.id;
  return query
    update public.waitlist w set notified_at = now()
    where w.session_id = v_old.id and w.notified_at is null
    returning w.*;
end;
$$;

revoke all on function public.move_booking_by_token(text, uuid) from public, anon, authenticated;
grant execute on function public.move_booking_by_token(text, uuid) to service_role;

-- 2. A workspace has one calendar: an appointment can't be offered while a
--    workshop is running, whether or not anyone has booked the workshop yet.
create or replace function public.busy_appointment_times(p_tenant_id uuid, p_from timestamptz, p_to timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select s.starts_at, s.ends_at
  from public.sessions s
  join public.services sv on sv.id = s.service_id
  where s.tenant_id = p_tenant_id and s.cancelled_at is null
    and s.starts_at < p_to and s.ends_at > p_from
    and (sv.kind = 'workshop' or private.seats_taken(s.id) > 0);
$$;
