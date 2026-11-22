-- Phase 6 (part one): bookings.
-- services, sessions, availability_rules, bookings and waitlist. Members read
-- and manage their own; the public booking page has no database access of its
-- own and goes through service-role functions that name the workspace.
--
-- Seats are never stored as a running count. A session's taken seats are
-- always worked out from its bookings under a row lock, so they cannot drift
-- and two people cannot take the last seat.

alter table public.connections drop constraint connections_provider_check;
alter table public.connections add constraint connections_provider_check
  check (provider in ('shopify', 'quickbooks', 'meta', 'google', 'stripe'));

create type public.booking_status as enum ('pending_payment', 'confirmed', 'cancelled');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.services (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- workshop: scheduled sessions with several seats. appointment: one-to-one
  -- slots offered from the availability rules.
  kind text not null check (kind in ('workshop', 'appointment')),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 60),
  description text not null default '',
  duration_minutes int not null check (duration_minutes between 5 and 1440),
  price_cents int not null default 0 check (price_cents >= 0),
  -- Default seats for a new workshop session.
  capacity int not null default 1 check (capacity between 1 and 500),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, slug)
);

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  capacity int not null check (capacity between 1 and 500),
  cancelled_at timestamptz,
  -- The matching event in the business's Google Calendar, once synced.
  calendar_event_id text,
  created_at timestamptz not null default now(),
  unique (service_id, starts_at)
);
create index sessions_tenant_starts_idx on public.sessions (tenant_id, starts_at);

-- Weekly opening hours for appointments, in the workspace's own timezone.
create table public.availability_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  -- 0 = Sunday ... 6 = Saturday
  weekday int not null check (weekday between 0 and 6),
  start_minute int not null check (start_minute between 0 and 1439),
  end_minute int not null check (end_minute between 1 and 1440),
  check (end_minute > start_minute),
  created_at timestamptz not null default now()
);
create index availability_rules_service_idx on public.availability_rules (service_id);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  session_id uuid not null references public.sessions (id) on delete cascade,
  customer_name text not null check (char_length(btrim(customer_name)) between 1 and 120),
  customer_email text not null check (customer_email = lower(customer_email)),
  seats int not null default 1 check (seats between 1 and 50),
  status public.booking_status not null,
  amount_cents int not null default 0 check (amount_cents >= 0),
  currency text not null,
  -- Answers to the workspace's own booking-form questions.
  answers jsonb not null default '{}'::jsonb,
  -- While payment is in progress the seats are held until this moment.
  hold_expires_at timestamptz,
  -- Paid for after its hold had lapsed and the session had filled: kept, and
  -- flagged for the business to sort out. A paid booking is never dropped.
  oversold boolean not null default false,
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  -- sha256 of the token in the customer's manage link.
  manage_token_hash text not null unique,
  reminder_sent_at timestamptz,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now()
);
create index bookings_session_idx on public.bookings (session_id);
create index bookings_tenant_email_idx on public.bookings (tenant_id, customer_email);

create table public.waitlist (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  session_id uuid not null references public.sessions (id) on delete cascade,
  customer_name text not null,
  customer_email text not null check (customer_email = lower(customer_email)),
  seats int not null default 1 check (seats between 1 and 50),
  notified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (session_id, customer_email)
);

-- ---------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['services', 'sessions', 'availability_rules', 'bookings', 'waitlist']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy "members read their %s" on public.%I for select to authenticated
         using (tenant_id in (select private.user_tenant_ids()))', t, t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to service_role', t);
  end loop;
end;
$$;

grant select on public.services, public.sessions, public.availability_rules, public.waitlist
  to authenticated;
-- The manage-link hash stays server-side.
grant select (id, tenant_id, session_id, customer_name, customer_email, seats, status, amount_cents,
              currency, answers, hold_expires_at, oversold, reminder_sent_at, confirmed_at,
              cancelled_at, created_at)
  on public.bookings to authenticated;

create trigger services_touch_updated_at
  before update on public.services
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

-- Seats spoken for in a session: confirmed bookings plus holds still in time.
create function private.seats_taken(p_session_id uuid)
returns int
language sql stable security definer set search_path = ''
as $$
  select coalesce(sum(b.seats), 0)::int
  from public.bookings b
  where b.session_id = p_session_id
    and (b.status = 'confirmed'
         or (b.status = 'pending_payment' and b.hold_expires_at > now()));
$$;
revoke all on function private.seats_taken(uuid) from public;

create function private.hash_token(p_token text)
returns text
language sql immutable set search_path = ''
as $$ select encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex') $$;
revoke all on function private.hash_token(text) from public;

create function private.require_manager(p_tenant_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.has_tenant_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]) then
    raise exception 'Only owners and admins can change this' using errcode = '42501';
  end if;
end;
$$;
revoke all on function private.require_manager(uuid) from public;

-- ---------------------------------------------------------------------------
-- What owners and admins do
-- ---------------------------------------------------------------------------

-- Creates or updates a service. Returns its id.
create function public.save_service(
  p_tenant_id uuid,
  p_service_id uuid,
  p_kind text,
  p_name text,
  p_description text,
  p_duration_minutes int,
  p_price_cents int,
  p_capacity int,
  p_active boolean
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_base text;
  v_slug text;
begin
  perform private.require_manager(p_tenant_id);
  if p_service_id is not null then
    update public.services s
    set name = btrim(p_name), description = coalesce(p_description, ''),
        duration_minutes = p_duration_minutes, price_cents = p_price_cents,
        capacity = p_capacity, active = coalesce(p_active, true)
    where s.id = p_service_id and s.tenant_id = p_tenant_id
    returning s.id into v_id;
    if v_id is null then
      raise exception 'Service not found' using errcode = 'P0002';
    end if;
    return v_id;
  end if;

  v_base := btrim(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g'), '-');
  v_base := btrim(left(v_base, 50), '-');
  if v_base = '' then v_base := 'service'; end if;
  v_slug := v_base;
  if exists (select 1 from public.services s where s.tenant_id = p_tenant_id and s.slug = v_slug) then
    v_slug := v_base || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 5);
  end if;

  insert into public.services
    (tenant_id, kind, name, slug, description, duration_minutes, price_cents, capacity, active)
  values
    (p_tenant_id, p_kind, btrim(p_name), v_slug, coalesce(p_description, ''), p_duration_minutes,
     p_price_cents, p_capacity, coalesce(p_active, true))
  returning id into v_id;
  perform private.log_audit(p_tenant_id, 'service.created', 'service', v_id::text);
  return v_id;
end;
$$;

-- Schedules one workshop session.
create function public.add_session(p_service_id uuid, p_starts_at timestamptz, p_capacity int default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_service public.services;
  v_id uuid;
begin
  select * into v_service from public.services s where s.id = p_service_id;
  if not found then
    raise exception 'Service not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_service.tenant_id);
  if v_service.kind <> 'workshop' then
    raise exception 'Only workshops have scheduled sessions' using errcode = '22023';
  end if;
  insert into public.sessions (tenant_id, service_id, starts_at, ends_at, capacity)
  values (v_service.tenant_id, v_service.id, p_starts_at,
          p_starts_at + make_interval(mins => v_service.duration_minutes),
          coalesce(p_capacity, v_service.capacity))
  returning id into v_id;
  return v_id;
end;
$$;

-- Calls a session off. Its bookings are cancelled; the app emails the people.
create function public.cancel_session(p_session_id uuid)
returns setof public.bookings
language plpgsql security definer set search_path = ''
as $$
declare
  v_session public.sessions;
begin
  select * into v_session from public.sessions s where s.id = p_session_id for update;
  if not found then
    raise exception 'Session not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_session.tenant_id);
  update public.sessions s set cancelled_at = now() where s.id = p_session_id and s.cancelled_at is null;
  perform private.log_audit(v_session.tenant_id, 'session.cancelled', 'session', p_session_id::text);
  return query
    update public.bookings b
    set status = 'cancelled', cancelled_at = now()
    where b.session_id = p_session_id and b.status <> 'cancelled'
    returning b.*;
end;
$$;

-- Replaces a service's weekly opening hours.
-- p_rules: [{"weekday": 1, "start_minute": 540, "end_minute": 1020}, ...]
create function public.set_availability(p_service_id uuid, p_rules jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_service public.services;
begin
  select * into v_service from public.services s where s.id = p_service_id;
  if not found then
    raise exception 'Service not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_service.tenant_id);
  delete from public.availability_rules r where r.service_id = p_service_id;
  insert into public.availability_rules (tenant_id, service_id, weekday, start_minute, end_minute)
  select v_service.tenant_id, p_service_id, r.weekday, r.start_minute, r.end_minute
  from jsonb_to_recordset(coalesce(p_rules, '[]'::jsonb)) as r(weekday int, start_minute int, end_minute int);
end;
$$;

revoke all on function public.save_service(uuid, uuid, text, text, text, int, int, int, boolean) from public, anon;
revoke all on function public.add_session(uuid, timestamptz, int) from public, anon;
revoke all on function public.cancel_session(uuid) from public, anon;
revoke all on function public.set_availability(uuid, jsonb) from public, anon;
grant execute on function public.save_service(uuid, uuid, text, text, text, int, int, int, boolean) to authenticated;
grant execute on function public.add_session(uuid, timestamptz, int) to authenticated;
grant execute on function public.cancel_session(uuid) to authenticated;
grant execute on function public.set_availability(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- The public booking flow (service role only; the app server calls these for
-- an anonymous visitor, always naming the workspace)
-- ---------------------------------------------------------------------------

-- Holds seats for someone who is about to pay, or confirms at once when the
-- booking is free. For an appointment, pass p_session_id null with the
-- service and start time: the slot's session is created here if it is still
-- open. Returns the booking; raises 'full' or 'taken' when there is no room.
create function public.hold_booking(
  p_tenant_id uuid,
  p_session_id uuid,
  p_service_id uuid,
  p_starts_at timestamptz,
  p_name text,
  p_email text,
  p_seats int,
  p_answers jsonb,
  p_manage_token text,
  p_hold_minutes int default 30
)
returns public.bookings
language plpgsql security definer set search_path = ''
as $$
declare
  v_service public.services;
  v_session public.sessions;
  v_booking public.bookings;
  v_amount int;
  v_currency text;
begin
  if p_session_id is not null then
    select * into v_session from public.sessions s
    where s.id = p_session_id and s.tenant_id = p_tenant_id
    for update;
    if not found then
      raise exception 'Session not found' using errcode = 'P0002';
    end if;
    select * into v_service from public.services s where s.id = v_session.service_id;
  else
    -- Locking the service makes two people racing for one slot take turns.
    select * into v_service from public.services s
    where s.id = p_service_id and s.tenant_id = p_tenant_id
    for update;
    if not found or v_service.kind <> 'appointment' then
      raise exception 'Service not found' using errcode = 'P0002';
    end if;
    select * into v_session from public.sessions s
    where s.service_id = v_service.id and s.starts_at = p_starts_at
    for update;
    if not found then
      -- One person can't be in two appointments at once, whatever the service.
      if exists (
        select 1 from public.sessions s
        join public.services sv on sv.id = s.service_id
        where s.tenant_id = p_tenant_id and sv.kind = 'appointment' and s.cancelled_at is null
          and s.starts_at < p_starts_at + make_interval(mins => v_service.duration_minutes)
          and s.ends_at > p_starts_at
          and private.seats_taken(s.id) > 0
      ) then
        raise exception 'taken' using errcode = 'P0001';
      end if;
      insert into public.sessions (tenant_id, service_id, starts_at, ends_at, capacity)
      values (p_tenant_id, v_service.id, p_starts_at,
              p_starts_at + make_interval(mins => v_service.duration_minutes), 1)
      returning * into v_session;
    end if;
  end if;

  if not v_service.active or v_session.cancelled_at is not null or v_session.starts_at <= now() then
    raise exception 'This time is no longer available' using errcode = 'P0001';
  end if;
  if private.seats_taken(v_session.id) + p_seats > v_session.capacity then
    raise exception 'full' using errcode = 'P0001';
  end if;

  v_amount := v_service.price_cents * p_seats;
  select t.currency into v_currency from public.tenants t where t.id = p_tenant_id;

  insert into public.bookings
    (tenant_id, session_id, customer_name, customer_email, seats, status, amount_cents, currency,
     answers, hold_expires_at, manage_token_hash, confirmed_at)
  values
    (p_tenant_id, v_session.id, btrim(p_name), lower(btrim(p_email)), p_seats,
     case when v_amount = 0 then 'confirmed' else 'pending_payment' end::public.booking_status,
     v_amount, v_currency, coalesce(p_answers, '{}'::jsonb),
     case when v_amount = 0 then null else now() + make_interval(mins => p_hold_minutes) end,
     private.hash_token(p_manage_token),
     case when v_amount = 0 then now() else null end)
  returning * into v_booking;
  return v_booking;
end;
$$;

create function public.attach_checkout(p_tenant_id uuid, p_booking_id uuid, p_checkout_session_id text)
returns void
language sql security definer set search_path = ''
as $$
  update public.bookings b set stripe_checkout_session_id = p_checkout_session_id
  where b.id = p_booking_id and b.tenant_id = p_tenant_id;
$$;

-- Marks a booking paid. Returns true only the first time, so the confirmation
-- email is sent exactly once however many times Stripe (or the customer's
-- browser) tells us. A booking paid after its hold lapsed is still confirmed,
-- and flagged if that takes the session over capacity.
create function public.confirm_booking(p_tenant_id uuid, p_booking_id uuid, p_payment_intent_id text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_booking public.bookings;
  v_session public.sessions;
  v_others int;
begin
  select * into v_booking from public.bookings b
  where b.id = p_booking_id and b.tenant_id = p_tenant_id;
  if not found then
    raise exception 'Booking not found' using errcode = 'P0002';
  end if;
  select * into v_session from public.sessions s where s.id = v_booking.session_id for update;
  -- Re-read under the session lock.
  select * into v_booking from public.bookings b where b.id = p_booking_id;
  if v_booking.status = 'confirmed' then
    return false;
  end if;

  select coalesce(sum(b.seats), 0)::int into v_others from public.bookings b
  where b.session_id = v_session.id and b.id <> v_booking.id
    and (b.status = 'confirmed' or (b.status = 'pending_payment' and b.hold_expires_at > now()));

  update public.bookings b
  set status = 'confirmed', confirmed_at = now(), cancelled_at = null, hold_expires_at = null,
      stripe_payment_intent_id = p_payment_intent_id,
      oversold = (v_others + v_booking.seats > v_session.capacity) or v_session.cancelled_at is not null
  where b.id = v_booking.id;
  return true;
end;
$$;

-- Lets go of seats when a checkout is abandoned.
create function public.release_booking(p_tenant_id uuid, p_booking_id uuid)
returns void
language sql security definer set search_path = ''
as $$
  update public.bookings b set status = 'cancelled', cancelled_at = now(), hold_expires_at = null
  where b.id = p_booking_id and b.tenant_id = p_tenant_id and b.status = 'pending_payment';
$$;

-- Everything the manage page and the emails need about one booking.
create function public.booking_details(p_tenant_id uuid, p_booking_id uuid, p_manage_token text)
returns table (
  booking_id uuid, tenant_id uuid, status public.booking_status, seats int, amount_cents int,
  currency text, customer_name text, customer_email text, oversold boolean,
  session_id uuid, starts_at timestamptz, ends_at timestamptz, session_cancelled boolean,
  service_id uuid, service_name text, service_kind text,
  workspace_name text, workspace_slug text, timezone text
)
language sql stable security definer set search_path = ''
as $$
  select b.id, b.tenant_id, b.status, b.seats, b.amount_cents, b.currency, b.customer_name,
         b.customer_email, b.oversold, s.id, s.starts_at, s.ends_at, s.cancelled_at is not null,
         sv.id, sv.name, sv.kind, t.name, t.slug, t.timezone
  from public.bookings b
  join public.sessions s on s.id = b.session_id
  join public.services sv on sv.id = s.service_id
  join public.tenants t on t.id = b.tenant_id
  where (p_booking_id is not null and b.id = p_booking_id and b.tenant_id = p_tenant_id)
     or (p_manage_token is not null and b.manage_token_hash = private.hash_token(p_manage_token));
$$;

-- The customer cancels from their manage link. Returns the waitlist entries
-- to tell about the freed seats (marked as told).
create function public.cancel_booking_by_token(p_manage_token text)
returns setof public.waitlist
language plpgsql security definer set search_path = ''
as $$
declare
  v_booking public.bookings;
  v_session public.sessions;
begin
  select * into v_booking from public.bookings b
  where b.manage_token_hash = private.hash_token(p_manage_token);
  if not found then
    raise exception 'Booking not found' using errcode = 'P0002';
  end if;
  select * into v_session from public.sessions s where s.id = v_booking.session_id for update;
  if v_session.starts_at <= now() then
    raise exception 'This booking has already started' using errcode = 'P0001';
  end if;
  update public.bookings b set status = 'cancelled', cancelled_at = now(), hold_expires_at = null
  where b.id = v_booking.id and b.status <> 'cancelled';
  if not found then
    return;
  end if;
  return query
    update public.waitlist w set notified_at = now()
    where w.session_id = v_session.id and w.notified_at is null
    returning w.*;
end;
$$;

-- The customer moves a confirmed booking to another session of the same
-- service that still has room.
create function public.move_booking_by_token(p_manage_token text, p_new_session_id uuid)
returns void
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
  if not found or v_new.service_id <> v_old.service_id or v_new.cancelled_at is not null
     or v_new.starts_at <= now() or v_old.starts_at <= now() then
    raise exception 'That time is not available' using errcode = 'P0001';
  end if;
  if private.seats_taken(v_new.id) + v_booking.seats > v_new.capacity then
    raise exception 'full' using errcode = 'P0001';
  end if;
  update public.bookings b set session_id = v_new.id, reminder_sent_at = null, oversold = false
  where b.id = v_booking.id;
end;
$$;

create function public.join_waitlist(
  p_tenant_id uuid, p_session_id uuid, p_name text, p_email text, p_seats int
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.sessions s
    where s.id = p_session_id and s.tenant_id = p_tenant_id and s.cancelled_at is null
      and s.starts_at > now()
  ) then
    raise exception 'Session not found' using errcode = 'P0002';
  end if;
  insert into public.waitlist (tenant_id, session_id, customer_name, customer_email, seats)
  values (p_tenant_id, p_session_id, btrim(p_name), lower(btrim(p_email)), p_seats)
  on conflict (session_id, customer_email) do update
    set seats = excluded.seats, customer_name = excluded.customer_name, notified_at = null;
end;
$$;

-- Seats left per upcoming session of a service, for the public page.
create function public.session_availability(p_tenant_id uuid, p_service_id uuid)
returns table (session_id uuid, starts_at timestamptz, ends_at timestamptz, capacity int, seats_left int)
language sql stable security definer set search_path = ''
as $$
  select s.id, s.starts_at, s.ends_at, s.capacity,
         greatest(0, s.capacity - private.seats_taken(s.id))
  from public.sessions s
  where s.tenant_id = p_tenant_id and s.service_id = p_service_id
    and s.cancelled_at is null and s.starts_at > now()
  order by s.starts_at;
$$;

-- Times already spoken for across every appointment service, so the public
-- page can leave them out.
create function public.busy_appointment_times(p_tenant_id uuid, p_from timestamptz, p_to timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select s.starts_at, s.ends_at
  from public.sessions s
  join public.services sv on sv.id = s.service_id
  where s.tenant_id = p_tenant_id and sv.kind = 'appointment' and s.cancelled_at is null
    and s.starts_at < p_to and s.ends_at > p_from
    and private.seats_taken(s.id) > 0;
$$;

-- Hands out reminders that are due (session starts within a day), each once.
create function public.claim_booking_reminders(p_limit int default 50)
returns setof public.bookings
language sql security definer set search_path = ''
as $$
  update public.bookings b
  set reminder_sent_at = now()
  where b.id in (
    select b2.id from public.bookings b2
    join public.sessions s on s.id = b2.session_id
    where b2.status = 'confirmed' and b2.reminder_sent_at is null
      and s.cancelled_at is null
      and s.starts_at > now() and s.starts_at <= now() + interval '24 hours'
    order by s.starts_at
    limit greatest(1, least(coalesce(p_limit, 50), 200))
    for update of b2 skip locked
  )
  returning b.*;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.hold_booking(uuid, uuid, uuid, timestamptz, text, text, int, jsonb, text, int)',
    'public.attach_checkout(uuid, uuid, text)',
    'public.confirm_booking(uuid, uuid, text)',
    'public.release_booking(uuid, uuid)',
    'public.booking_details(uuid, uuid, text)',
    'public.cancel_booking_by_token(text)',
    'public.move_booking_by_token(text, uuid)',
    'public.join_waitlist(uuid, uuid, text, text, int)',
    'public.session_availability(uuid, uuid)',
    'public.busy_appointment_times(uuid, timestamptz, timestamptz)',
    'public.claim_booking_reminders(int)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
