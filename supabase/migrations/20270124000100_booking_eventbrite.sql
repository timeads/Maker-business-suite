-- Bookings: Eventbrite as a second place to sell (docs/eventbrite.md).
--
-- What the business's earlier booking app did with Eventbrite, made to work
-- for every workspace:
--
--   * A date is linked to an event the business already made on Eventbrite
--     (and to one of its ticket types). Which workshops may be linked at all
--     is the business's choice per workshop (`services.eventbrite_on`, off
--     by default).
--   * Seats left are pushed to that ticket type: the tickets Eventbrite may
--     sell become what it has sold plus what is still free here, counting
--     bookings from every place and any shared room (`private.seats_left`).
--     A full date shows "Sold out" there; a full date that Eventbrite never
--     sold for has its ticket hidden instead (Eventbrite won't take 0), and
--     shown again when places free up. A push is an outside write, so it
--     follows the once-only pattern: claimed, tried once, written down. A
--     clear "no" from Eventbrite (nothing changed) is tried again a few
--     times, then waits for a manager's press; a change we never heard back
--     about is "unsure" and is never asked again without a person. Every
--     push starts by reading the ticket type afresh, so a manager's "try
--     again" sets it from what Eventbrite really shows.
--   * Orders come back through Eventbrite's webhook. Eventbrite doesn't sign
--     its webhooks, so the address carries a secret of the workspace's
--     (`private.eventbrite_hooks` keeps only its hash), and what arrives is
--     only a nudge: the order's number, which the worker reads afresh from
--     Eventbrite's own API. Each order becomes one booking through
--     `book_from_eventbrite`, under the same locks and seat rules as every
--     other booking; a full date is still booked, and flagged oversold.
--     Refunds and cancelled tickets give the places back.

alter table public.connections drop constraint connections_provider_check;
alter table public.connections add constraint connections_provider_check
  check (provider in ('shopify', 'quickbooks', 'meta', 'google', 'stripe', 'easypost', 'ups',
                      'redo', 'google_mail', 'michaels', 'twilio', 'eventbrite'));

alter table public.bookings drop constraint bookings_source_check;
alter table public.bookings add constraint bookings_source_check
  check (source in ('online', 'manual', 'eventbrite'));

alter table public.bookings
  -- The Eventbrite order that made this booking.
  add column eventbrite_order_id text check (eventbrite_order_id ~ '^[0-9]{1,30}$');
-- One booking per order and date, however often Eventbrite tells us about it.
create unique index bookings_eventbrite_order_idx
  on public.bookings (tenant_id, eventbrite_order_id, session_id)
  where eventbrite_order_id is not null;
grant select (eventbrite_order_id) on public.bookings to authenticated;

alter table public.services
  -- May this workshop's dates be linked to Eventbrite events? Off by default.
  add column eventbrite_on boolean not null default false;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- One date and the Eventbrite event (and ticket type) that sells it too.
create table public.eventbrite_listings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  session_id uuid not null unique references public.sessions (id) on delete cascade,
  event_id text not null check (event_id ~ '^[0-9]{1,30}$'),
  -- The ticket type whose number of tickets we keep in step. Without one the
  -- date still takes the event's orders, but nothing is pushed.
  ticket_class_id text check (ticket_class_id is null or ticket_class_id ~ '^[0-9]{1,30}$'),
  -- Eventbrite's name for the event when it was linked, for the screens.
  event_name text not null default '' check (char_length(event_name) <= 200),
  -- waiting: due a look. sending: the worker has it. done: Eventbrite was
  -- set as of checked_at. failed: Eventbrite said no, so nothing changed
  -- (tried again a few times, then a manager's press). unsure: we asked for
  -- a change and never heard back; never asked again without a person.
  status text not null default 'waiting'
    check (status in ('waiting', 'sending', 'done', 'failed', 'unsure')),
  -- Our words, or Eventbrite's, for what went wrong.
  detail text not null default '' check (char_length(detail) <= 300),
  tries int not null default 0 check (tries between 0 and 20),
  -- When the next look is due: every few minutes, and at once after any
  -- booking, limit or shared-room change on the date.
  check_due_at timestamptz not null default now(),
  next_try_at timestamptz,
  claimed_at timestamptz,
  checked_at timestamptz,
  -- What Eventbrite showed after our last look: tickets for sale, sold, hidden.
  eb_total int,
  eb_sold int,
  eb_hidden boolean,
  -- Places free here when we last looked.
  seats_left int,
  linked_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- An event sells one date.
  unique (tenant_id, event_id)
);
create index eventbrite_listings_due_idx on public.eventbrite_listings (status, check_due_at);

alter table public.eventbrite_listings enable row level security;
revoke all on public.eventbrite_listings from public, anon, authenticated, service_role;
grant select on public.eventbrite_listings to authenticated, service_role;
create policy "members read their eventbrite listings" on public.eventbrite_listings
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));

create trigger eventbrite_listings_touch_updated_at
  before update on public.eventbrite_listings
  for each row execute function private.touch_updated_at();

-- The secret in each workspace's webhook address, as a hash only. The
-- address itself goes to Eventbrite once, when a manager switches order
-- updates on, and is never kept or shown again.
create table private.eventbrite_hooks (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  -- Eventbrite's id for the webhook, once it took it.
  webhook_id text check (webhook_id is null or webhook_id ~ '^[0-9]{1,30}$'),
  registered_at timestamptz,
  registered_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
revoke all on private.eventbrite_hooks from public, anon, authenticated;

-- Orders Eventbrite told us about, waiting for the worker to read them.
-- Only the order's number: everything else is read from Eventbrite's API.
create table private.eventbrite_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  order_id text not null check (order_id ~ '^[0-9]{1,30}$'),
  -- Eventbrite said "refunded" at least once for this nudge.
  refunded boolean not null default false,
  received_at timestamptz not null default now(),
  tries int not null default 0 check (tries between 0 and 20),
  next_try_at timestamptz not null default now(),
  claimed_at timestamptz,
  done_at timestamptz,
  -- booked, resized, cancelled, unchanged, nothing, no_listing, gone, failed
  outcome text check (outcome is null or char_length(outcome) <= 40),
  detail text not null default '' check (char_length(detail) <= 300)
);
-- Several nudges about one order before the worker gets to it are one read.
create unique index eventbrite_events_open_idx
  on private.eventbrite_events (tenant_id, order_id) where done_at is null;
create index eventbrite_events_due_idx on private.eventbrite_events (next_try_at)
  where done_at is null;
revoke all on private.eventbrite_events from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function private.eventbrite_connected(p_tenant_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.connections c
    where c.tenant_id = p_tenant_id and c.provider = 'eventbrite' and c.status = 'active');
$$;
revoke all on function private.eventbrite_connected(uuid) from public;

-- Brings forward the next look for these dates and every date sharing a
-- room with them: their seats left may just have changed.
create function private.eventbrite_mark_due(p_session_ids uuid[], p_group_ids uuid[] default '{}')
returns void
language sql security definer set search_path = ''
as $$
  update public.eventbrite_listings l
  set check_due_at = now()
  where l.check_due_at > now()
    and l.session_id in (
      select s.id from public.sessions s where s.id = any(coalesce(p_session_ids, '{}'))
      union
      select s2.id from public.sessions s
      join public.sessions s2 on s2.seat_group_id = s.seat_group_id
      where s.id = any(coalesce(p_session_ids, '{}')) and s.seat_group_id is not null
      union
      select s.id from public.sessions s where s.seat_group_id = any(coalesce(p_group_ids, '{}')));
$$;
revoke all on function private.eventbrite_mark_due(uuid[], uuid[]) from public;

create function private.eventbrite_booking_changed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid := case when tg_op = 'DELETE' then old.tenant_id else new.tenant_id end;
begin
  -- Most workspaces link nothing: one indexed look and out.
  if not exists (select 1 from public.eventbrite_listings l where l.tenant_id = v_tenant) then
    return null;
  end if;
  perform private.eventbrite_mark_due(array_remove(array[
    case when tg_op = 'DELETE' then null else new.session_id end,
    case when tg_op = 'INSERT' then null else old.session_id end], null));
  return null;
end;
$$;
revoke all on function private.eventbrite_booking_changed() from public;
create trigger bookings_eventbrite_due
  after insert or delete or update of status, seats, session_id, hold_expires_at on public.bookings
  for each row execute function private.eventbrite_booking_changed();

create function private.eventbrite_session_changed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.eventbrite_listings l where l.tenant_id = new.tenant_id) then
    return null;
  end if;
  perform private.eventbrite_mark_due(array[new.id],
    array_remove(array[old.seat_group_id, new.seat_group_id], null));
  return null;
end;
$$;
revoke all on function private.eventbrite_session_changed() from public;
create trigger sessions_eventbrite_due
  after update of capacity, seat_group_id, cancelled_at, starts_at on public.sessions
  for each row execute function private.eventbrite_session_changed();

create function private.eventbrite_room_changed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.eventbrite_mark_due('{}', array[new.id]);
  return null;
end;
$$;
revoke all on function private.eventbrite_room_changed() from public;
create trigger session_seat_groups_eventbrite_due
  after update of capacity on public.session_seat_groups
  for each row execute function private.eventbrite_room_changed();

-- ---------------------------------------------------------------------------
-- What owners and admins do
-- ---------------------------------------------------------------------------

-- Lets a workshop's dates be linked to Eventbrite (or stops it). Switched
-- off, nothing more is pushed for its dates; their links and the bookings
-- already made stay, and orders on a linked event still arrive (a paid
-- booking is never dropped).
create function public.set_service_eventbrite(p_service_id uuid, p_on boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_service public.services;
begin
  select * into v_service from public.services s where s.id = p_service_id;
  if not found then
    raise exception 'Workshop not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_service.tenant_id);
  if v_service.kind <> 'workshop' then
    raise exception 'Only workshops can be sold on Eventbrite' using errcode = '22023';
  end if;
  update public.services s set eventbrite_on = coalesce(p_on, false) where s.id = p_service_id;
  if coalesce(p_on, false) then
    update public.eventbrite_listings l
    set check_due_at = now()
    where l.session_id in (select s.id from public.sessions s where s.service_id = p_service_id)
      and l.check_due_at > now();
  end if;
  perform private.log_audit(v_service.tenant_id,
    case when coalesce(p_on, false) then 'service.eventbrite_on' else 'service.eventbrite_off' end,
    'service', p_service_id::text);
end;
$$;

-- Links a date to an Eventbrite event and ticket type, or unlinks it when
-- the event is left empty. Returns the link's id (null once unlinked).
create function public.link_session_eventbrite(
  p_session_id uuid,
  p_event_id text,
  p_ticket_class_id text,
  p_event_name text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_session public.sessions;
  v_service public.services;
  v_event text := nullif(btrim(coalesce(p_event_id, '')), '');
  v_class text := nullif(btrim(coalesce(p_ticket_class_id, '')), '');
  v_id uuid;
begin
  select * into v_session from public.sessions s where s.id = p_session_id;
  if not found then
    raise exception 'Date not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_session.tenant_id);
  if v_event is null then
    delete from public.eventbrite_listings l where l.session_id = p_session_id;
    perform private.log_audit(v_session.tenant_id, 'session.eventbrite_unlinked', 'session',
      p_session_id::text);
    return null;
  end if;
  select * into v_service from public.services s where s.id = v_session.service_id;
  if v_service.kind <> 'workshop' or not v_service.eventbrite_on then
    raise exception 'This workshop isn''t switched on for Eventbrite' using errcode = 'P0001';
  end if;
  if not private.eventbrite_connected(v_session.tenant_id) then
    raise exception 'Eventbrite isn''t connected' using errcode = 'P0001';
  end if;
  if v_event !~ '^[0-9]{1,30}$' or (v_class is not null and v_class !~ '^[0-9]{1,30}$') then
    raise exception 'That isn''t an Eventbrite event' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.eventbrite_listings l
    where l.tenant_id = v_session.tenant_id and l.event_id = v_event
      and l.session_id <> p_session_id) then
    raise exception 'event_taken' using errcode = 'P0001';
  end if;
  insert into public.eventbrite_listings
    (tenant_id, session_id, event_id, ticket_class_id, event_name, linked_by)
  values
    (v_session.tenant_id, p_session_id, v_event, v_class,
     left(btrim(coalesce(p_event_name, '')), 200), (select auth.uid()))
  on conflict (session_id) do update
    set event_id = excluded.event_id, ticket_class_id = excluded.ticket_class_id,
        event_name = excluded.event_name, linked_by = excluded.linked_by,
        status = 'waiting', detail = '', tries = 0, next_try_at = null,
        check_due_at = now(), eb_total = null, eb_sold = null, eb_hidden = null
  returning id into v_id;
  perform private.log_audit(v_session.tenant_id, 'session.eventbrite_linked', 'session',
    p_session_id::text, jsonb_build_object('event_id', v_event));
  return v_id;
end;
$$;

-- A manager's "try again" for a push that failed or that we're unsure of.
-- The next push reads the ticket type from Eventbrite first, so it is set
-- from what Eventbrite really shows, never from a guess.
create function public.retry_eventbrite_listing(p_listing_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_listing public.eventbrite_listings;
begin
  select * into v_listing from public.eventbrite_listings l
  where l.id = p_listing_id and l.tenant_id in (select private.user_tenant_ids());
  if not found then
    raise exception 'Link not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_listing.tenant_id);
  update public.eventbrite_listings l
  set status = 'waiting', detail = '', tries = 0, next_try_at = null, check_due_at = now()
  where l.id = p_listing_id and l.status in ('failed', 'unsure');
  if not found then
    raise exception 'There is nothing to try again' using errcode = 'P0001';
  end if;
  perform private.log_audit(v_listing.tenant_id, 'session.eventbrite_retry', 'session',
    v_listing.session_id::text);
end;
$$;

-- Order updates: a manager switches them on from Settings. The app makes a
-- fresh secret, keeps its hash here, then gives Eventbrite the address.
create function public.begin_eventbrite_hook(p_tenant_id uuid, p_token_hash text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Bad secret' using errcode = '22023';
  end if;
  insert into private.eventbrite_hooks (tenant_id, token_hash)
  values (p_tenant_id, p_token_hash)
  on conflict (tenant_id) do update
    set token_hash = excluded.token_hash, webhook_id = null, registered_at = null,
        registered_by = null, created_at = now();
end;
$$;

-- Eventbrite took the address: written down with its id for the webhook.
create function public.finish_eventbrite_hook(p_tenant_id uuid, p_webhook_id text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  update private.eventbrite_hooks h
  set webhook_id = case when coalesce(p_webhook_id, '') ~ '^[0-9]{1,30}$' then p_webhook_id end,
      registered_at = now(), registered_by = (select auth.uid())
  where h.tenant_id = p_tenant_id;
  if not found then
    raise exception 'Start again' using errcode = 'P0002';
  end if;
  perform private.log_audit(p_tenant_id, 'eventbrite.order_updates_on', 'connection', 'eventbrite');
end;
$$;

-- Whether one of Eventbrite's webhook addresses is this workspace's current
-- one (the app hashes the secret part of each address Eventbrite lists).
create function public.eventbrite_hook_matches(p_tenant_id uuid, p_token_hashes text[])
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  return exists (
    select 1 from private.eventbrite_hooks h
    where h.tenant_id = p_tenant_id and h.token_hash = any(coalesce(p_token_hashes, '{}')));
end;
$$;

-- For the screens: whether order updates are on, and since when. Never the secret.
create function public.eventbrite_order_updates(p_tenant_id uuid)
returns table (registered_at timestamptz, webhook_id text)
language sql stable security definer set search_path = ''
as $$
  select h.registered_at, h.webhook_id from private.eventbrite_hooks h
  where h.tenant_id = p_tenant_id and h.tenant_id in (select private.user_tenant_ids())
    and h.registered_at is not null;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.set_service_eventbrite(uuid, boolean)',
    'public.link_session_eventbrite(uuid, text, text, text)',
    'public.retry_eventbrite_listing(uuid)',
    'public.begin_eventbrite_hook(uuid, text)',
    'public.finish_eventbrite_hook(uuid, text)',
    'public.eventbrite_hook_matches(uuid, text[])',
    'public.eventbrite_order_updates(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Pushing seats left (the worker)
-- ---------------------------------------------------------------------------

-- Hands the worker the dates due a push, each to one worker. Only for a
-- workshop switched on, a date still to come with a ticket type, and a
-- workspace whose Eventbrite is connected: nothing is pushed otherwise. A
-- claim nobody finished in 15 minutes is "unsure": the worker may have
-- asked Eventbrite for a change, and we can't tell whether it did.
create function public.claim_eventbrite_pushes(p_limit int default 20)
returns table (
  id uuid, tenant_id uuid, session_id uuid, event_id text, ticket_class_id text, seats_left int
)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  update public.eventbrite_listings l
  set status = 'unsure', claimed_at = null,
      detail = 'We lost touch part-way through, so we can''t tell whether Eventbrite changed the tickets.'
  where l.status = 'sending' and l.claimed_at < now() - interval '15 minutes';

  return query
  with due as (
    select l.id from public.eventbrite_listings l
    join public.sessions s on s.id = l.session_id
    join public.services sv on sv.id = s.service_id
    where l.ticket_class_id is not null and sv.eventbrite_on and s.starts_at > now()
      and private.eventbrite_connected(l.tenant_id)
      and ((l.status in ('waiting', 'done') and l.check_due_at <= now())
           or (l.status = 'failed' and l.tries < 3 and l.next_try_at <= now()))
    order by l.check_due_at, l.id
    limit greatest(1, least(coalesce(p_limit, 20), 100))
    for update of l skip locked
  ), taken as (
    update public.eventbrite_listings l
    set status = 'sending', claimed_at = now(), tries = l.tries + 1,
        -- Provisional: a booking made while this push is out brings it back to now.
        check_due_at = now() + interval '5 minutes'
    from due where l.id = due.id
    returning l.id, l.tenant_id, l.session_id, l.event_id, l.ticket_class_id
  )
  select t.id, t.tenant_id, t.session_id, t.event_id, t.ticket_class_id,
         -- A date called off sells nothing more.
         case when s.cancelled_at is not null then 0 else private.seats_left(s.id) end
  from taken t join public.sessions s on s.id = t.session_id;
end;
$$;

-- What happened to one push:
--   done     Eventbrite matches (changed, or nothing needed changing).
--   refused  Eventbrite said no, or couldn't be read: nothing changed.
--   unsure   we asked for a change and got no clear answer.
create function public.finish_eventbrite_push(
  p_id uuid,
  p_outcome text,
  p_detail text default null,
  p_total int default null,
  p_sold int default null,
  p_hidden boolean default null,
  p_seats_left int default null
)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_status text;
begin
  if p_outcome is null or p_outcome not in ('done', 'refused', 'unsure') then
    raise exception 'Unknown outcome' using errcode = '22023';
  end if;
  update public.eventbrite_listings l
  set status = case p_outcome when 'done' then 'done' when 'refused' then 'failed' else 'unsure' end,
      detail = case when p_outcome = 'done' then ''
                    else left(coalesce(nullif(btrim(p_detail), ''),
                      case when p_outcome = 'refused' then 'Eventbrite said no.'
                           else 'We didn''t hear back from Eventbrite.' end), 300) end,
      tries = case when p_outcome = 'done' then 0 else l.tries end,
      next_try_at = case when p_outcome = 'refused'
                         then now() + make_interval(mins => 5 * (2 ^ greatest(l.tries - 1, 0))::int)
                    end,
      claimed_at = null, checked_at = now(),
      eb_total = coalesce(p_total, l.eb_total),
      eb_sold = coalesce(p_sold, l.eb_sold),
      eb_hidden = coalesce(p_hidden, l.eb_hidden),
      seats_left = coalesce(p_seats_left, l.seats_left),
      check_due_at = case when l.check_due_at <= now() then l.check_due_at
                          else now() + interval '5 minutes' end
  where l.id = p_id and l.status = 'sending'
  returning l.status into v_status;
  return v_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- Orders coming in (the webhook and the worker)
-- ---------------------------------------------------------------------------

-- The webhook's one call. Finds the workspace by the hash of the secret in
-- the address; only a workspace with Eventbrite connected and order
-- updates switched on is listened to. Returns queued or unknown; several
-- nudges about one order before the worker reads it are kept as one.
create function public.enqueue_eventbrite_event(
  p_token_hash text,
  p_order_id text,
  p_refunded boolean default false,
  p_webhook_id text default null
)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_hook private.eventbrite_hooks;
begin
  select * into v_hook from private.eventbrite_hooks h
  where h.token_hash = coalesce(p_token_hash, '') and h.registered_at is not null;
  if not found or not private.eventbrite_connected(v_hook.tenant_id) then
    return 'unknown';
  end if;
  -- Eventbrite names the webhook it is calling for; it must be ours.
  if v_hook.webhook_id is not null and nullif(p_webhook_id, '') is not null
     and p_webhook_id <> v_hook.webhook_id then
    return 'unknown';
  end if;
  if coalesce(p_order_id, '') !~ '^[0-9]{1,30}$' then
    return 'unknown';
  end if;
  insert into private.eventbrite_events (tenant_id, order_id, refunded)
  values (v_hook.tenant_id, p_order_id, coalesce(p_refunded, false))
  on conflict (tenant_id, order_id) where done_at is null
    do update set refunded = private.eventbrite_events.refunded or excluded.refunded,
                  next_try_at = least(private.eventbrite_events.next_try_at, now());
  return 'queued';
end;
$$;

-- Hands the worker orders to read, each to one worker. Reading an order and
-- booking it is safe to repeat, so a claim that was never finished is
-- simply handed out again. `tries` counts the claims: past six the worker
-- gives up on the order and tells the team.
create function public.claim_eventbrite_events(p_limit int default 20)
returns table (id uuid, tenant_id uuid, order_id text, refunded boolean, tries int)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  update private.eventbrite_events e
  set claimed_at = null
  where e.done_at is null and e.claimed_at < now() - interval '15 minutes';

  return query
  with due as (
    select e.id from private.eventbrite_events e
    where e.done_at is null and e.claimed_at is null and e.next_try_at <= now()
    order by e.next_try_at, e.id
    limit greatest(1, least(coalesce(p_limit, 20), 100))
    for update skip locked
  )
  update private.eventbrite_events e
  set claimed_at = now(), tries = least(e.tries + 1, 20)
  from due where e.id = due.id
  returning e.id, e.tenant_id, e.order_id, e.refunded, e.tries;
end;
$$;

-- done: the order was read and booked (or there was nothing to do); the
-- detail is the booking's result. retry: something went wrong on the way;
-- looked at again a little later. failed: given up on.
create function public.finish_eventbrite_event(p_id uuid, p_outcome text, p_detail text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_outcome is null or p_outcome not in ('done', 'retry', 'failed') then
    raise exception 'Unknown outcome' using errcode = '22023';
  end if;
  update private.eventbrite_events e
  set claimed_at = null,
      done_at = case when p_outcome <> 'retry' then now() end,
      outcome = case when p_outcome = 'done' then coalesce(left(p_detail, 40), 'done')
                     when p_outcome = 'failed' then 'failed' end,
      detail = case when p_outcome = 'done' then '' else left(coalesce(p_detail, ''), 300) end,
      next_try_at = now() + make_interval(mins => least(60, 2 ^ e.tries)::int)
  where e.id = p_id and e.done_at is null;
end;
$$;

-- One Eventbrite order, read afresh from Eventbrite, made into a booking on
-- the date its event is linked to. Safe to repeat: once per order.
--   p_seats: the order's tickets still live (cancelled and refunded ones
--   left out); 0 gives every place of the order back.
-- A paid order is never turned away: a full, closed or cancelled date is
-- still booked, and flagged oversold. Returns
--   {result: booked | resized | cancelled | unchanged | nothing | no_listing,
--    booking_id, oversold, date_cancelled, cancelled: [booking ids]}
create function public.book_from_eventbrite(
  p_tenant_id uuid,
  p_event_id text,
  p_order_id text,
  p_name text,
  p_email text,
  p_phone text,
  p_seats int,
  p_manage_token text
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_seats int := least(greatest(coalesce(p_seats, 0), 0), 50);
  v_dates uuid[];
  v_linked uuid;
  v_session public.sessions;
  v_booking public.bookings;
  v_currency text;
  v_over boolean;
  v_cancelled uuid[];
begin
  if coalesce(p_order_id, '') !~ '^[0-9]{1,30}$' then
    raise exception 'Bad order' using errcode = '22023';
  end if;
  -- The dates this order already sits on (it may have been moved), and the
  -- date its event is linked to now. Locked together, in the one order.
  select coalesce(array_agg(distinct b.session_id), '{}') into v_dates
  from public.bookings b
  where b.tenant_id = p_tenant_id and b.eventbrite_order_id = p_order_id;
  select l.session_id into v_linked from public.eventbrite_listings l
  where l.tenant_id = p_tenant_id and l.event_id = coalesce(p_event_id, '');
  perform private.lock_seats(
    case when v_linked is null then v_dates else array_append(v_dates, v_linked) end);

  -- Re-read under the locks.
  select * into v_booking from public.bookings b
  where b.tenant_id = p_tenant_id and b.eventbrite_order_id = p_order_id
  order by (b.status = 'confirmed') desc, b.created_at
  limit 1;

  if found then
    if v_seats = 0 then
      with gone as (
        update public.bookings b
        set status = 'cancelled', cancelled_at = now(), hold_expires_at = null
        where b.tenant_id = p_tenant_id and b.eventbrite_order_id = p_order_id
          and b.status = 'confirmed'
        returning b.id
      )
      select coalesce(array_agg(gone.id), '{}') into v_cancelled from gone;
      if cardinality(v_cancelled) = 0 then
        return jsonb_build_object('result', 'unchanged', 'booking_id', v_booking.id);
      end if;
      return jsonb_build_object('result', 'cancelled', 'booking_id', v_booking.id,
                                'cancelled', to_jsonb(v_cancelled));
    end if;
    if v_booking.status = 'confirmed' and v_booking.seats <> v_seats then
      select * into v_session from public.sessions s where s.id = v_booking.session_id;
      v_over := not private.has_room(v_session.id, v_seats, v_booking.id)
                or v_session.cancelled_at is not null;
      update public.bookings b set seats = v_seats, oversold = v_over where b.id = v_booking.id;
      return jsonb_build_object('result', 'resized', 'booking_id', v_booking.id,
                                'oversold', v_over);
    end if;
    return jsonb_build_object('result', 'unchanged', 'booking_id', v_booking.id);
  end if;

  if v_seats = 0 then
    return jsonb_build_object('result', 'nothing');
  end if;
  if v_linked is null then
    return jsonb_build_object('result', 'no_listing');
  end if;
  select * into v_session from public.sessions s
  where s.id = v_linked and s.tenant_id = p_tenant_id;
  v_over := not private.has_room(v_session.id, v_seats) or v_session.cancelled_at is not null;
  select t.currency into v_currency from public.tenants t where t.id = p_tenant_id;
  insert into public.bookings
    (tenant_id, session_id, customer_name, customer_email, customer_phone, text_opt_in, seats,
     status, amount_cents, currency, manage_token_hash, confirmed_at, source, oversold,
     eventbrite_order_id)
  values
    (p_tenant_id, v_session.id,
     left(coalesce(nullif(btrim(p_name), ''), nullif(btrim(p_email), ''), 'Guest'), 120),
     lower(btrim(coalesce(p_email, ''))),
     -- Kept for the team's reference only: Eventbrite buyers never ticked our
     -- box for texts, so none are sent to them.
     left(btrim(coalesce(p_phone, '')), 40), false,
     v_seats, 'confirmed', 0, v_currency, private.hash_token(p_manage_token), now(),
     'eventbrite', v_over, p_order_id)
  returning * into v_booking;
  return jsonb_build_object(
    'result', 'booked', 'booking_id', v_booking.id, 'oversold', v_over,
    'date_cancelled', v_session.cancelled_at is not null);
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.claim_eventbrite_pushes(int)',
    'public.finish_eventbrite_push(uuid, text, text, int, int, boolean, int)',
    'public.enqueue_eventbrite_event(text, text, boolean, text)',
    'public.claim_eventbrite_events(int)',
    'public.finish_eventbrite_event(uuid, text, text)',
    'public.book_from_eventbrite(uuid, text, text, text, text, text, int, text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
