-- Shared seat limits: classes that run at the same time and share one room.
--
-- Two workshops on a Saturday morning may each take 8, but the room holds 12
-- between them. A shared limit ties dates that overlap in time to one
-- combined number of places. Each date still keeps its own limit as well; a
-- booking needs room under both.
--
-- Seats are still never stored as a count. Everything here works them out
-- from `bookings`, as `private.seats_taken` always has.
--
-- Locks are taken in ONE fixed order everywhere seats are given out, so two
-- bookings can never wait on each other: first every shared limit involved
-- (by id), then every date involved (by id). `private.lock_seats` does this;
-- if a date joined or left a shared limit between reading it and locking it,
-- it lets go of what it took and starts again, rather than reaching back for
-- a limit while holding a date.
--
-- A paid booking is still never dropped: paid into a full shared limit, it is
-- booked and flagged oversold, like a paid booking into a full date.

create table public.session_seat_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- Places across every date that shares this limit.
  capacity int not null check (capacity between 1 and 1000),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index session_seat_groups_tenant_idx on public.session_seat_groups (tenant_id);

alter table public.session_seat_groups enable row level security;
revoke all on public.session_seat_groups from public, anon, authenticated, service_role;
grant select on public.session_seat_groups to authenticated, service_role;
create policy "members read their shared limits" on public.session_seat_groups
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));

create trigger session_seat_groups_touch_updated_at
  before update on public.session_seat_groups
  for each row execute function private.touch_updated_at();

alter table public.sessions
  add column seat_group_id uuid references public.session_seat_groups (id) on delete set null;
create index sessions_seat_group_idx on public.sessions (seat_group_id) where seat_group_id is not null;

-- A date and its shared limit always belong to the same workspace.
create function private.guard_seat_group_tenant()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.seat_group_id is not null and not exists (
    select 1 from public.session_seat_groups g
    where g.id = new.seat_group_id and g.tenant_id = new.tenant_id
  ) then
    raise exception 'Shared limit not found' using errcode = 'P0002';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_seat_group_tenant() from public;
create trigger sessions_guard_seat_group
  before insert or update of seat_group_id on public.sessions
  for each row execute function private.guard_seat_group_tenant();

-- ---------------------------------------------------------------------------
-- Counting
-- ---------------------------------------------------------------------------

-- Seats spoken for on a date, leaving one booking out (the one being
-- confirmed or moved, so it isn't counted against itself).
create function private.seats_taken_except(p_session_id uuid, p_except uuid)
returns int
language sql stable security definer set search_path = ''
as $$
  select coalesce(sum(b.seats), 0)::int
  from public.bookings b
  where b.session_id = p_session_id and b.id is distinct from p_except
    and (b.status = 'confirmed'
         or (b.status = 'pending_payment' and b.hold_expires_at > now()));
$$;
revoke all on function private.seats_taken_except(uuid, uuid) from public;

-- Seats spoken for across every date that shares a limit.
create function private.shared_seats_taken(p_group_id uuid, p_except uuid default null)
returns int
language sql stable security definer set search_path = ''
as $$
  select coalesce(sum(b.seats), 0)::int
  from public.sessions s
  join public.bookings b on b.session_id = s.id
  where s.seat_group_id = p_group_id and b.id is distinct from p_except
    and (b.status = 'confirmed'
         or (b.status = 'pending_payment' and b.hold_expires_at > now()));
$$;
revoke all on function private.shared_seats_taken(uuid, uuid) from public;

-- Whether a date has room for this many more seats: under its own limit and,
-- when it shares one, under the shared limit too.
create function private.has_room(p_session_id uuid, p_seats int, p_except uuid default null)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_session public.sessions;
  v_shared int;
begin
  select * into v_session from public.sessions s where s.id = p_session_id;
  if not found then
    return false;
  end if;
  if private.seats_taken_except(p_session_id, p_except) + p_seats > v_session.capacity then
    return false;
  end if;
  if v_session.seat_group_id is not null then
    select g.capacity into v_shared from public.session_seat_groups g
    where g.id = v_session.seat_group_id;
    if private.shared_seats_taken(v_session.seat_group_id, p_except) + p_seats > v_shared then
      return false;
    end if;
  end if;
  return true;
end;
$$;
revoke all on function private.has_room(uuid, int, uuid) from public;

-- Places still free on a date, under both limits. Never below zero.
create function private.seats_left(p_session_id uuid)
returns int
language sql stable security definer set search_path = ''
as $$
  select greatest(0, least(
    s.capacity - private.seats_taken(s.id),
    coalesce(g.capacity - private.shared_seats_taken(g.id), s.capacity)))::int
  from public.sessions s
  left join public.session_seat_groups g on g.id = s.seat_group_id
  where s.id = p_session_id;
$$;
revoke all on function private.seats_left(uuid) from public;

-- ---------------------------------------------------------------------------
-- Locking, in one order
-- ---------------------------------------------------------------------------

-- Locks the dates asked for, every shared limit they belong to, and any
-- shared limits named, in the one order: limits by id, then dates by id.
-- Whoever gives out seats on a date that shares a limit holds that limit's
-- row, so two dates sharing a room are counted one at a time.
--
-- A date can only join or leave a shared limit while its row is locked. If it
-- did so between our first read and our locks, we let go of everything taken
-- here (the block is undone) and read again, so a date's lock is never held
-- while waiting for a limit's.
create function private.lock_seats(p_session_ids uuid[], p_group_ids uuid[] default '{}')
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_groups uuid[];
  v_after uuid[];
begin
  for attempt in 1 .. 50 loop
    select coalesce(array_agg(distinct x order by x), '{}') into v_groups
    from (
      select s.seat_group_id as x from public.sessions s
      where s.id = any(coalesce(p_session_ids, '{}')) and s.seat_group_id is not null
      union
      select unnest(coalesce(p_group_ids, '{}'))
    ) found;
    begin
      perform 1 from public.session_seat_groups g
      where g.id = any(v_groups) order by g.id for update;
      perform 1 from public.sessions s
      where s.id = any(coalesce(p_session_ids, '{}')) order by s.id for update;
      select coalesce(array_agg(distinct x order by x), '{}') into v_after
      from (
        select s.seat_group_id as x from public.sessions s
        where s.id = any(coalesce(p_session_ids, '{}')) and s.seat_group_id is not null
        union
        select unnest(coalesce(p_group_ids, '{}'))
      ) found;
      if v_after = v_groups then
        return;
      end if;
      raise exception 'moved' using errcode = 'SEATS';
    exception when sqlstate 'SEATS' then
      -- Let go and look again.
      null;
    end;
  end loop;
  raise exception 'Too busy right now; please try again' using errcode = '40001';
end;
$$;
revoke all on function private.lock_seats(uuid[], uuid[]) from public;

-- ---------------------------------------------------------------------------
-- Everything that gives out seats now counts the shared limit too.
-- Each takes its locks through `private.lock_seats` before anything else.
-- ---------------------------------------------------------------------------

create or replace function public.hold_booking(
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
    perform private.lock_seats(array[p_session_id]);
    select * into v_session from public.sessions s
    where s.id = p_session_id and s.tenant_id = p_tenant_id;
    if not found then
      raise exception 'Session not found' using errcode = 'P0002';
    end if;
    select * into v_service from public.services s where s.id = v_session.service_id;
  else
    -- Locking the service makes two people racing for one slot take turns.
    -- Appointments never share a limit.
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
  if not private.has_room(v_session.id, p_seats) then
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

create or replace function public.confirm_booking(p_tenant_id uuid, p_booking_id uuid, p_payment_intent_id text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_booking public.bookings;
  v_session public.sessions;
begin
  select * into v_booking from public.bookings b
  where b.id = p_booking_id and b.tenant_id = p_tenant_id;
  if not found then
    raise exception 'Booking not found' using errcode = 'P0002';
  end if;
  perform private.lock_seats(array[v_booking.session_id]);
  select * into v_session from public.sessions s where s.id = v_booking.session_id;
  -- Re-read under the lock.
  select * into v_booking from public.bookings b where b.id = p_booking_id;
  if v_booking.status = 'confirmed' then
    return false;
  end if;

  update public.bookings b
  set status = 'confirmed', confirmed_at = now(), cancelled_at = null, hold_expires_at = null,
      stripe_payment_intent_id = p_payment_intent_id,
      oversold = not private.has_room(v_session.id, v_booking.seats, v_booking.id)
                 or v_session.cancelled_at is not null
  where b.id = v_booking.id;
  return true;
end;
$$;

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
  v_currency text;
  v_seats int := least(greatest(coalesce(p_seats, 0), 0), 50);
  v_over boolean;
begin
  perform private.lock_seats(array[p_session_id]);
  select * into v_session from public.sessions s
  where s.id = p_session_id and s.tenant_id = p_tenant_id;
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
  -- Paid: booked whatever the room, and flagged when over either limit.
  v_over := not private.has_room(v_session.id, v_seats) or v_session.cancelled_at is not null;
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

create or replace function public.add_manual_booking(
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
  perform private.lock_seats(array[p_session_id]);
  select * into v_session from public.sessions s where s.id = p_session_id;
  if not found then
    raise exception 'Session not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_session.tenant_id);
  if v_session.cancelled_at is not null then
    raise exception 'This date was cancelled' using errcode = 'P0001';
  end if;
  if not coalesce(p_allow_over, false) and not private.has_room(v_session.id, p_seats) then
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

create or replace function public.admin_move_booking(p_booking_id uuid, p_new_session_id uuid)
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
  perform private.lock_seats(array[v_booking.session_id, p_new_session_id]);
  select * into v_old from public.sessions s where s.id = v_booking.session_id;
  select * into v_new from public.sessions s
  where s.id = p_new_session_id and s.tenant_id = v_booking.tenant_id;
  if not found or v_new.id = v_old.id or v_new.service_id <> v_old.service_id
     or v_new.cancelled_at is not null then
    raise exception 'That time is not available' using errcode = 'P0001';
  end if;
  -- Leaving this booking out, so a move between two dates that share a
  -- limit isn't counted twice.
  if not private.has_room(v_new.id, v_booking.seats, v_booking.id) then
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

create or replace function public.move_booking_by_token(p_manage_token text, p_new_session_id uuid)
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
  perform private.lock_seats(array[v_booking.session_id, p_new_session_id]);
  select * into v_old from public.sessions s where s.id = v_booking.session_id;
  select * into v_new from public.sessions s
  where s.id = p_new_session_id and s.tenant_id = v_booking.tenant_id;
  if not found or v_new.id = v_old.id or v_new.service_id <> v_old.service_id
     or v_new.cancelled_at is not null
     or v_new.starts_at <= now() or v_old.starts_at <= now() then
    raise exception 'That time is not available' using errcode = 'P0001';
  end if;
  if not private.has_room(v_new.id, v_booking.seats, v_booking.id) then
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

create or replace function public.place_shop_order_line(
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
  perform private.lock_seats(array[p_session_id]);
  select * into v_session from public.sessions s where s.id = p_session_id;
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
      return jsonb_build_object('result', 'already', 'booking_id', v_booking.id,
                                'session_id', v_booking.session_id);
    end if;
  end if;

  select * into v_booking from public.bookings b
  where b.tenant_id = v_session.tenant_id and b.shop_order_id = v_order.external_id
    and b.session_id = v_session.id;
  if found then
    if v_booking.id is distinct from v_marker.booking_id then
      raise exception 'already_on_date' using errcode = 'P0001';
    end if;
    v_revive := true;
  end if;

  v_over := not private.has_room(v_session.id, v_seats, v_booking.id);
  select * into v_buyer from private.shop_order_buyer(v_order);
  if v_revive then
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

-- ---------------------------------------------------------------------------
-- Seats left, wherever they are read
-- ---------------------------------------------------------------------------

create or replace function public.session_availability(p_tenant_id uuid, p_service_id uuid)
returns table (session_id uuid, starts_at timestamptz, ends_at timestamptz, capacity int, seats_left int)
language sql stable security definer set search_path = ''
as $$
  select s.id, s.starts_at, s.ends_at, s.capacity, private.seats_left(s.id)
  from public.sessions s
  where s.tenant_id = p_tenant_id and s.service_id = p_service_id
    and s.cancelled_at is null and s.starts_at > now()
    and not s.private and not s.bookings_closed
  order by s.starts_at;
$$;

create or replace function public.shop_booking_dates(p_tenant_id uuid, p_product_id text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'service', jsonb_build_object(
      'name', sv.name, 'duration_minutes', sv.duration_minutes, 'variant_id', sv.shop_variant_id),
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

-- The figures the team's own pages show for a set of dates: taken, the
-- date's limit, the shared limit if any, and what is left under both.
create function public.session_seat_figures(p_session_ids uuid[])
returns table (
  session_id uuid, taken int, capacity int, seat_group_id uuid, shared_capacity int,
  shared_taken int, seats_left int
)
language sql stable security definer set search_path = ''
as $$
  select s.id, private.seats_taken(s.id), s.capacity, s.seat_group_id, g.capacity,
         case when g.id is not null then private.shared_seats_taken(g.id) end,
         private.seats_left(s.id)
  from public.sessions s
  left join public.session_seat_groups g on g.id = s.seat_group_id
  where s.id = any(p_session_ids[1:1000])
    and s.tenant_id in (select private.user_tenant_ids());
$$;
revoke all on function public.session_seat_figures(uuid[]) from public, anon;
grant execute on function public.session_seat_figures(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Setting it up (owners and admins)
-- ---------------------------------------------------------------------------

-- Ties two or more dates that run at the same time to one combined limit.
-- Every date must overlap every other, be a workshop date that hasn't ended
-- or been cancelled, and not already share a limit. The limit can't be set
-- below the places already taken across them. Returns the new limit's id.
create function public.share_session_seats(p_session_ids uuid[], p_capacity int)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_ids uuid[];
  v_tenant uuid;
  v_taken int;
  v_id uuid;
begin
  select coalesce(array_agg(distinct x order by x), '{}') into v_ids
  from unnest(coalesce(p_session_ids, '{}')) as x where x is not null;
  if cardinality(v_ids) < 2 or cardinality(v_ids) > 6 then
    raise exception 'pick_dates' using errcode = '22023';
  end if;
  select s.tenant_id into v_tenant from public.sessions s
  where s.id = v_ids[1] and s.tenant_id in (select private.user_tenant_ids());
  if v_tenant is null then
    raise exception 'Session not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_tenant);
  if p_capacity is null or p_capacity < 1 or p_capacity > 1000 then
    raise exception 'bad_limit' using errcode = '22023';
  end if;

  perform private.lock_seats(v_ids);

  if (select count(*) from public.sessions s join public.services sv on sv.id = s.service_id
      where s.id = any(v_ids) and s.tenant_id = v_tenant and sv.kind = 'workshop')
     <> cardinality(v_ids) then
    raise exception 'Session not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.sessions s where s.id = any(v_ids)
             and (s.cancelled_at is not null or s.ends_at <= now())) then
    raise exception 'date_over' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.sessions s where s.id = any(v_ids) and s.seat_group_id is not null) then
    raise exception 'already_shared' using errcode = 'P0001';
  end if;
  -- Overlapping, every one with every other: the latest start is before the earliest end.
  if (select max(s.starts_at) >= min(s.ends_at) from public.sessions s where s.id = any(v_ids)) then
    raise exception 'not_same_time' using errcode = 'P0001';
  end if;
  select coalesce(sum(private.seats_taken(s.id)), 0)::int into v_taken
  from public.sessions s where s.id = any(v_ids);
  if p_capacity < v_taken then
    raise exception 'below_booked:%', v_taken using errcode = 'P0001';
  end if;

  insert into public.session_seat_groups (tenant_id, capacity, created_by)
  values (v_tenant, p_capacity, auth.uid())
  returning id into v_id;
  update public.sessions s set seat_group_id = v_id where s.id = any(v_ids);
  perform private.log_audit(v_tenant, 'session.seats_shared', 'session_seat_group', v_id::text);
  return v_id;
end;
$$;

-- Changes a shared limit. Never below the places already taken across it.
create function public.set_shared_limit(p_group_id uuid, p_capacity int)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
  v_taken int;
begin
  select g.tenant_id into v_tenant from public.session_seat_groups g
  where g.id = p_group_id and g.tenant_id in (select private.user_tenant_ids());
  if v_tenant is null then
    raise exception 'Shared limit not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_tenant);
  if p_capacity is null or p_capacity < 1 or p_capacity > 1000 then
    raise exception 'bad_limit' using errcode = '22023';
  end if;
  perform private.lock_seats('{}', array[p_group_id]);
  v_taken := private.shared_seats_taken(p_group_id);
  if p_capacity < v_taken then
    raise exception 'below_booked:%', v_taken using errcode = 'P0001';
  end if;
  update public.session_seat_groups g set capacity = p_capacity where g.id = p_group_id;
end;
$$;

-- Unties the dates: each goes back to its own limit alone.
create function public.unshare_session_seats(p_group_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
  v_members uuid[];
begin
  select g.tenant_id into v_tenant from public.session_seat_groups g
  where g.id = p_group_id and g.tenant_id in (select private.user_tenant_ids());
  if v_tenant is null then
    raise exception 'Shared limit not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_tenant);
  select coalesce(array_agg(s.id), '{}') into v_members
  from public.sessions s where s.seat_group_id = p_group_id;
  perform private.lock_seats(v_members, array[p_group_id]);
  update public.sessions s set seat_group_id = null where s.seat_group_id = p_group_id;
  delete from public.session_seat_groups g where g.id = p_group_id;
  perform private.log_audit(v_tenant, 'session.seats_unshared', 'session_seat_group', p_group_id::text);
end;
$$;

revoke all on function public.share_session_seats(uuid[], int) from public, anon;
revoke all on function public.set_shared_limit(uuid, int) from public, anon;
revoke all on function public.unshare_session_seats(uuid) from public, anon;
grant execute on function public.share_session_seats(uuid[], int) to authenticated;
grant execute on function public.set_shared_limit(uuid, int) to authenticated;
grant execute on function public.unshare_session_seats(uuid) to authenticated;
