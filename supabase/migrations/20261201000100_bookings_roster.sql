-- Bookings, second pass: the day-of roster and what the business does by hand.
-- Attendance, notes and tags, manual bookings, moving and cancelling for a
-- customer, private and closed dates, repeat-weekly scheduling, a follow-up.

alter table public.bookings
  add column attendance text check (attendance in ('attended', 'no_show')),
  add column notes text not null default '' check (char_length(notes) <= 2000),
  add column tags text[] not null default '{}',
  add column source text not null default 'online' check (source in ('online', 'manual')),
  add column email_opt_in boolean not null default true,
  add column followup_sent_at timestamptz;

alter table public.sessions
  add column bookings_closed boolean not null default false,
  -- Hidden from the public page; only the business can add people.
  add column private boolean not null default false,
  add column notes text not null default '' check (char_length(notes) <= 2000);

grant select (attendance, notes, tags, source, email_opt_in, followup_sent_at)
  on public.bookings to authenticated;

-- A closed or private date takes no bookings from the public page, whatever
-- route they arrive by. Bookings the business adds itself are not affected.
create function private.guard_online_booking()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.source = 'online' and exists (
    select 1 from public.sessions s
    where s.id = new.session_id and (s.bookings_closed or s.private)
  ) then
    raise exception 'This time is no longer available' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_online_booking() from public;

create trigger bookings_guard_online
  before insert on public.bookings
  for each row execute function private.guard_online_booking();

-- The public page lists only dates people can actually book.
create or replace function public.session_availability(p_tenant_id uuid, p_service_id uuid)
returns table (session_id uuid, starts_at timestamptz, ends_at timestamptz, capacity int, seats_left int)
language sql stable security definer set search_path = ''
as $$
  select s.id, s.starts_at, s.ends_at, s.capacity,
         greatest(0, s.capacity - private.seats_taken(s.id))
  from public.sessions s
  where s.tenant_id = p_tenant_id and s.service_id = p_service_id
    and s.cancelled_at is null and s.starts_at > now()
    and not s.private and not s.bookings_closed
  order by s.starts_at;
$$;

-- ---------------------------------------------------------------------------
-- Scheduling
-- ---------------------------------------------------------------------------

-- Schedules a workshop date, optionally repeated weekly. Weeks are counted on
-- the workspace's own clock, so 10:00 stays 10:00 across a clock change.
-- Dates that already exist are skipped. Returns how many were added.
create function public.add_sessions(
  p_service_id uuid,
  p_starts_at timestamptz,
  p_capacity int default null,
  p_repeat_weeks int default 1,
  p_private boolean default false
)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_service public.services;
  v_zone text;
  v_local timestamp;
  v_start timestamptz;
  v_added int := 0;
  v_rows int;
begin
  select * into v_service from public.services s where s.id = p_service_id;
  if not found then
    raise exception 'Service not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_service.tenant_id);
  if v_service.kind <> 'workshop' then
    raise exception 'Only workshops have scheduled sessions' using errcode = '22023';
  end if;
  select t.timezone into v_zone from public.tenants t where t.id = v_service.tenant_id;
  v_local := p_starts_at at time zone v_zone;

  for i in 0 .. greatest(1, least(coalesce(p_repeat_weeks, 1), 52)) - 1 loop
    v_start := (v_local + make_interval(weeks => i)) at time zone v_zone;
    insert into public.sessions (tenant_id, service_id, starts_at, ends_at, capacity, private)
    values (v_service.tenant_id, v_service.id, v_start,
            v_start + make_interval(mins => v_service.duration_minutes),
            coalesce(p_capacity, v_service.capacity), coalesce(p_private, false))
    on conflict (service_id, starts_at) do nothing;
    get diagnostics v_rows = row_count;
    v_added := v_added + v_rows;
  end loop;
  return v_added;
end;
$$;

create function public.update_session(
  p_session_id uuid,
  p_capacity int,
  p_bookings_closed boolean,
  p_private boolean,
  p_notes text
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select s.tenant_id into v_tenant from public.sessions s where s.id = p_session_id for update;
  if v_tenant is null then
    raise exception 'Session not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_tenant);
  update public.sessions s
  set capacity = p_capacity, bookings_closed = coalesce(p_bookings_closed, false),
      private = coalesce(p_private, false), notes = left(coalesce(p_notes, ''), 2000)
  where s.id = p_session_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Bookings the business makes or changes itself
-- ---------------------------------------------------------------------------

create function private.manager_booking(p_booking_id uuid)
returns public.bookings
language plpgsql security definer set search_path = ''
as $$
declare
  v_booking public.bookings;
begin
  select * into v_booking from public.bookings b where b.id = p_booking_id;
  if not found or not (v_booking.tenant_id in (select private.user_tenant_ids())) then
    raise exception 'Booking not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_booking.tenant_id);
  return v_booking;
end;
$$;
revoke all on function private.manager_booking(uuid) from public;

-- Adds someone by hand (a phone booking, a friend, a comp). Confirmed at
-- once and never charged. Goes over capacity only if the owner says so.
create function public.add_manual_booking(
  p_session_id uuid,
  p_name text,
  p_email text,
  p_seats int,
  p_notes text,
  p_manage_token text,
  p_allow_over boolean default false
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_session public.sessions;
  v_currency text;
  v_id uuid;
begin
  select * into v_session from public.sessions s where s.id = p_session_id for update;
  if not found then
    raise exception 'Session not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_session.tenant_id);
  if v_session.cancelled_at is not null then
    raise exception 'This date was cancelled' using errcode = 'P0001';
  end if;
  if not coalesce(p_allow_over, false)
     and private.seats_taken(v_session.id) + p_seats > v_session.capacity then
    raise exception 'full' using errcode = 'P0001';
  end if;
  select t.currency into v_currency from public.tenants t where t.id = v_session.tenant_id;
  insert into public.bookings
    (tenant_id, session_id, customer_name, customer_email, seats, status, amount_cents, currency,
     manage_token_hash, confirmed_at, source, notes)
  values
    (v_session.tenant_id, v_session.id, btrim(p_name), lower(btrim(p_email)), p_seats, 'confirmed',
     0, v_currency, private.hash_token(p_manage_token), now(), 'manual',
     left(coalesce(p_notes, ''), 2000))
  returning id into v_id;
  return v_id;
end;
$$;

-- Moves a booking to another date of the same workshop. Returns the people
-- waiting for the date it left, marked as told.
create function public.admin_move_booking(p_booking_id uuid, p_new_session_id uuid)
returns setof public.waitlist
language plpgsql security definer set search_path = ''
as $$
declare
  v_booking public.bookings := private.manager_booking(p_booking_id);
  v_old public.sessions;
  v_new public.sessions;
begin
  if v_booking.status <> 'confirmed' then
    raise exception 'Booking not found' using errcode = 'P0002';
  end if;
  select * into v_old from public.sessions s where s.id = v_booking.session_id;
  perform 1 from public.sessions s
  where s.id in (v_booking.session_id, p_new_session_id) order by s.id for update;
  select * into v_new from public.sessions s
  where s.id = p_new_session_id and s.tenant_id = v_booking.tenant_id;
  if not found or v_new.id = v_old.id or v_new.service_id <> v_old.service_id
     or v_new.cancelled_at is not null then
    raise exception 'That time is not available' using errcode = 'P0001';
  end if;
  if private.seats_taken(v_new.id) + v_booking.seats > v_new.capacity then
    raise exception 'full' using errcode = 'P0001';
  end if;
  update public.bookings b
  set session_id = v_new.id, reminder_sent_at = null, followup_sent_at = null, oversold = false,
      attendance = null
  where b.id = v_booking.id;
  return query
    update public.waitlist w set notified_at = now()
    where w.session_id = v_old.id and w.notified_at is null
    returning w.*;
end;
$$;

create function public.admin_cancel_booking(p_booking_id uuid)
returns setof public.waitlist
language plpgsql security definer set search_path = ''
as $$
declare
  v_booking public.bookings := private.manager_booking(p_booking_id);
begin
  update public.bookings b set status = 'cancelled', cancelled_at = now(), hold_expires_at = null
  where b.id = v_booking.id and b.status <> 'cancelled';
  if not found then
    return;
  end if;
  return query
    update public.waitlist w set notified_at = now()
    where w.session_id = v_booking.session_id and w.notified_at is null
    returning w.*;
end;
$$;

create function public.update_booking_contact(p_booking_id uuid, p_name text, p_email text, p_email_opt_in boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_booking public.bookings := private.manager_booking(p_booking_id);
begin
  update public.bookings b
  set customer_name = btrim(p_name), customer_email = lower(btrim(p_email)),
      email_opt_in = coalesce(p_email_opt_in, true)
  where b.id = v_booking.id;
end;
$$;

-- Anyone on the team can check people in and keep notes: that's front-desk work.
create function public.set_booking_attendance(p_booking_id uuid, p_attendance text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.bookings b set attendance = p_attendance
  where b.id = p_booking_id and b.status = 'confirmed'
    and b.tenant_id in (select private.user_tenant_ids());
  if not found then
    raise exception 'Booking not found' using errcode = 'P0002';
  end if;
end;
$$;

create function public.set_booking_notes(p_booking_id uuid, p_notes text, p_tags text[])
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.bookings b
  set notes = left(coalesce(p_notes, ''), 2000),
      tags = coalesce((
        select array_agg(distinct t) from (
          select lower(btrim(x)) as t from unnest(coalesce(p_tags, '{}')) as x
        ) cleaned where t ~ '^[a-z0-9][a-z0-9 _-]{0,29}$'), '{}')
  where b.id = p_booking_id and b.tenant_id in (select private.user_tenant_ids());
  if not found then
    raise exception 'Booking not found' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.add_sessions(uuid, timestamptz, int, int, boolean) from public, anon;
revoke all on function public.update_session(uuid, int, boolean, boolean, text) from public, anon;
revoke all on function public.add_manual_booking(uuid, text, text, int, text, text, boolean) from public, anon;
revoke all on function public.admin_move_booking(uuid, uuid) from public, anon;
revoke all on function public.admin_cancel_booking(uuid) from public, anon;
revoke all on function public.update_booking_contact(uuid, text, text, boolean) from public, anon;
revoke all on function public.set_booking_attendance(uuid, text) from public, anon;
revoke all on function public.set_booking_notes(uuid, text, text[]) from public, anon;
grant execute on function public.add_sessions(uuid, timestamptz, int, int, boolean) to authenticated;
grant execute on function public.update_session(uuid, int, boolean, boolean, text) to authenticated;
grant execute on function public.add_manual_booking(uuid, text, text, int, text, text, boolean) to authenticated;
grant execute on function public.admin_move_booking(uuid, uuid) to authenticated;
grant execute on function public.admin_cancel_booking(uuid) to authenticated;
grant execute on function public.update_booking_contact(uuid, text, text, boolean) to authenticated;
grant execute on function public.set_booking_attendance(uuid, text) to authenticated;
grant execute on function public.set_booking_notes(uuid, text, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Emails on a timer (service role): a reminder at the lead time the workspace
-- chose, and a thank-you after the date if it switched one on. Both settings
-- live in `configs` (bookings / emails). People who turned emails off are
-- skipped.
-- ---------------------------------------------------------------------------

create function private.booking_email_setting(p_tenant_id uuid, p_name text, p_default int)
returns int
language sql stable security definer set search_path = ''
as $$
  select greatest(1, least(336, coalesce((
    select case when jsonb_typeof(c.body -> p_name) = 'number'
                then (c.body ->> p_name)::numeric::int end
    from public.configs c
    where c.tenant_id = p_tenant_id and c.module = 'bookings' and c.key = 'emails'), p_default)));
$$;
revoke all on function private.booking_email_setting(uuid, text, int) from public;

create function public.claim_booking_emails(p_kind text, p_limit int default 50)
returns setof public.bookings
language plpgsql security definer set search_path = ''
as $$
begin
  if p_kind = 'reminder' then
    return query
      update public.bookings b set reminder_sent_at = now()
      where b.id in (
        select b2.id from public.bookings b2
        join public.sessions s on s.id = b2.session_id
        where b2.status = 'confirmed' and b2.reminder_sent_at is null and b2.email_opt_in
          and s.cancelled_at is null and s.starts_at > now()
          and s.starts_at <= now() + make_interval(
            hours => private.booking_email_setting(b2.tenant_id, 'reminder_hours', 24))
        order by s.starts_at
        limit greatest(1, least(coalesce(p_limit, 50), 200))
        for update of b2 skip locked)
      returning b.*;
  elsif p_kind = 'followup' then
    return query
      update public.bookings b set followup_sent_at = now()
      where b.id in (
        select b2.id from public.bookings b2
        join public.sessions s on s.id = b2.session_id
        where b2.status = 'confirmed' and b2.followup_sent_at is null and b2.email_opt_in
          and b2.attendance is distinct from 'no_show'
          and s.cancelled_at is null
          and exists (
            select 1 from public.configs c
            where c.tenant_id = b2.tenant_id and c.module = 'bookings' and c.key = 'emails'
              and c.body -> 'followup_on' = 'true'::jsonb)
          and s.ends_at <= now() - make_interval(
            hours => private.booking_email_setting(b2.tenant_id, 'followup_hours', 24))
          -- Never reach back further than two weeks, e.g. when first switched on.
          and s.ends_at > now() - interval '15 days'
        order by s.ends_at
        limit greatest(1, least(coalesce(p_limit, 50), 200))
        for update of b2 skip locked)
      returning b.*;
  else
    raise exception 'Unknown email kind' using errcode = '22023';
  end if;
end;
$$;
revoke all on function public.claim_booking_emails(text, int) from public, anon, authenticated;
grant execute on function public.claim_booking_emails(text, int) to service_role;

-- ---------------------------------------------------------------------------
-- A record of messages the business sent to everyone on a date.
-- ---------------------------------------------------------------------------

create table public.booking_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  session_id uuid not null references public.sessions (id) on delete cascade,
  subject text not null check (char_length(subject) between 1 and 200),
  body text not null check (char_length(body) between 1 and 5000),
  recipients int not null check (recipients >= 0),
  sent_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index booking_messages_session_idx on public.booking_messages (session_id, created_at desc);
alter table public.booking_messages enable row level security;
revoke all on public.booking_messages from anon, authenticated;
grant select on public.booking_messages to authenticated;
create policy booking_messages_select on public.booking_messages
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));

create function public.log_booking_message(p_session_id uuid, p_subject text, p_body text, p_recipients int)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select s.tenant_id into v_tenant from public.sessions s where s.id = p_session_id;
  if v_tenant is null or not (v_tenant in (select private.user_tenant_ids())) then
    raise exception 'Session not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_tenant);
  insert into public.booking_messages (tenant_id, session_id, subject, body, recipients, sent_by)
  values (v_tenant, p_session_id, left(btrim(p_subject), 200), left(btrim(p_body), 5000),
          greatest(0, p_recipients), auth.uid());
end;
$$;
revoke all on function public.log_booking_message(uuid, text, text, int) from public, anon;
grant execute on function public.log_booking_message(uuid, text, text, int) to authenticated;
