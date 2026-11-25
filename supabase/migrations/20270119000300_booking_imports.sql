-- Bringing a business's workshops, dates and bookings across from the
-- booking app it used before, from spreadsheets. Owners and admins only.
-- The same design as Stock's imports (20261229000200_stock_imports.sql):
--  1. A look first. Each function can be run for a look (p_confirm false): it
--     does the whole import inside a block that is then undone, and hands
--     back the counts, so what a person is shown is the import's own answer.
--  2. Once. A confirmed import carries a request key; a second press with the
--     same key finds the first one's result. Each file is matched against
--     what is already here, so the same file again changes nothing.
--  3. Nothing is sent. An imported booking never gets a confirmation, and it
--     carries the reminders and thank-yous the earlier app already sent, so
--     nobody is emailed twice.
--
-- The app has read and tidied each file (lib/bookings/import); each row
-- carries its line in the file, and a row the database can't use is handed
-- back in "refused" with that line and our own words, never left to stop the
-- rest.

-- ---------------------------------------------------------------------------
-- What each row was called in the earlier app, and a phone number
-- ---------------------------------------------------------------------------

alter table public.services
  add column import_ref text check (char_length(import_ref) between 1 and 100);
create unique index services_import_ref_idx
  on public.services (tenant_id, import_ref) where import_ref is not null;

alter table public.sessions
  add column import_ref text check (char_length(import_ref) between 1 and 100);
create unique index sessions_import_ref_idx
  on public.sessions (tenant_id, import_ref) where import_ref is not null;

alter table public.bookings
  add column import_ref text check (char_length(import_ref) between 1 and 100),
  -- Kept for the team (and for text reminders, which aren't built yet).
  add column customer_phone text not null default '' check (char_length(customer_phone) <= 40),
  -- Whether the person agreed to text messages in the earlier app. Nothing
  -- sends a text yet; this only keeps their answer.
  add column text_opt_in boolean not null default false;
create unique index bookings_import_ref_idx
  on public.bookings (tenant_id, import_ref) where import_ref is not null;
grant select (import_ref, customer_phone, text_opt_in) on public.bookings to authenticated;

-- One row per confirmed import. The file itself is never kept.
create table public.booking_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  kind text not null check (kind in ('workshops', 'dates', 'bookings')),
  request_key uuid not null,
  file_name text not null default '' check (char_length(file_name) <= 200),
  counts jsonb not null check (jsonb_typeof(counts) = 'object'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, request_key)
);
create index booking_imports_tenant_idx on public.booking_imports (tenant_id, created_at desc);
alter table public.booking_imports enable row level security;
create policy "managers read their booking imports" on public.booking_imports
  for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin']::public.membership_role[]));
revoke all on public.booking_imports from public, anon, authenticated, service_role;
grant select on public.booking_imports to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Shared steps
-- ---------------------------------------------------------------------------

create function private.booking_import_begin(
  p_tenant_id uuid, p_request_key uuid, p_rows jsonb, p_confirm boolean
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_counts jsonb;
begin
  perform private.require_manager(p_tenant_id);
  if jsonb_typeof(coalesce(p_rows, 'null'::jsonb)) <> 'array'
     or jsonb_array_length(p_rows) > 10000 then
    raise exception 'That file is too big to bring in at once' using errcode = '22023';
  end if;
  if not coalesce(p_confirm, false) then
    return null;
  end if;
  if p_request_key is null then
    raise exception 'A request key is needed' using errcode = '22023';
  end if;
  -- Waits for an earlier press to finish, then sees what it wrote.
  perform 1 from public.tenants t where t.id = p_tenant_id for update;
  select i.counts || jsonb_build_object('repeated', true) into v_counts
  from public.booking_imports i
  where i.tenant_id = p_tenant_id and i.request_key = p_request_key;
  return v_counts;
end;
$$;
revoke all on function private.booking_import_begin(uuid, uuid, jsonb, boolean) from public;

create function private.booking_import_end(
  p_tenant_id uuid, p_request_key uuid, p_kind text, p_file_name text, p_counts jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.booking_imports (tenant_id, kind, request_key, file_name, counts, created_by)
  values (p_tenant_id, p_kind, p_request_key, left(btrim(coalesce(p_file_name, '')), 200),
          p_counts, auth.uid());
  return p_counts || jsonb_build_object('repeated', false);
end;
$$;
revoke all on function private.booking_import_end(uuid, uuid, text, text, jsonb) from public;

create function private.import_refusal(p_line jsonb, p_reason text)
returns jsonb
language sql immutable set search_path = ''
as $$ select jsonb_build_object('line', coalesce((p_line)::int, 0), 'reason', p_reason) $$;
revoke all on function private.import_refusal(jsonb, text) from public;

-- ---------------------------------------------------------------------------
-- 1. Workshops
-- ---------------------------------------------------------------------------

-- [{"line", "ref", "name", "description", "duration_minutes", "capacity",
--   "price_cents", "location", "shop_product_id", "shop_variant_id", "active"}]
-- Matched by the earlier app's id (`ref`), else by the shop product, else by
-- name (capitals don't matter). A key that isn't in a row is left alone.
create function public.import_booking_workshops(
  p_tenant_id uuid, p_request_key uuid, p_rows jsonb, p_file_name text default '',
  p_confirm boolean default false
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_done jsonb := private.booking_import_begin(p_tenant_id, p_request_key, p_rows, p_confirm);
  v_new int := 0;
  v_changed int := 0;
  v_same int := 0;
  v_refused jsonb := '[]'::jsonb;
  v_counts jsonb;
  e jsonb;
  v_id uuid;
  v_before public.services;
  v_after public.services;
  v_product text;
begin
  if v_done is not null then
    return v_done;
  end if;
  begin
    for e in select * from jsonb_array_elements(p_rows)
    loop
      v_id := null;
      v_product := nullif(e ->> 'shop_product_id', '');
      if nullif(e ->> 'ref', '') is not null then
        select s.id into v_id from public.services s
        where s.tenant_id = p_tenant_id and s.import_ref = e ->> 'ref';
      end if;
      if v_id is null and v_product is not null then
        select s.id into v_id from public.services s
        where s.tenant_id = p_tenant_id and s.shop_product_id = v_product;
      end if;
      if v_id is null then
        select s.id into v_id from public.services s
        where s.tenant_id = p_tenant_id and s.kind = 'workshop'
          and lower(s.name) = lower(btrim(e ->> 'name'))
        order by s.created_at limit 1;
      end if;
      if v_id is not null and exists (
        select 1 from public.services s where s.id = v_id and s.kind <> 'workshop'
      ) then
        v_refused := v_refused || private.import_refusal(e -> 'line',
          'That shop product sells an appointment here, not a workshop.');
        continue;
      end if;
      if v_id is not null and nullif(e ->> 'ref', '') is not null and exists (
        select 1 from public.services s
        where s.id = v_id and s.import_ref is not null and s.import_ref <> e ->> 'ref'
      ) then
        v_refused := v_refused || private.import_refusal(e -> 'line',
          'A different workshop from your earlier app already matched this one.');
        continue;
      end if;
      if v_product is not null and exists (
        select 1 from public.services s
        where s.tenant_id = p_tenant_id and s.shop_product_id = v_product
          and s.id is distinct from v_id
      ) then
        v_refused := v_refused || private.import_refusal(e -> 'line',
          'Another workshop here is already sold by that shop product.');
        continue;
      end if;

      if v_id is null then
        v_id := public.save_service(
          p_tenant_id, null, 'workshop', left(btrim(e ->> 'name'), 80),
          coalesce(e ->> 'description', ''),
          coalesce((e ->> 'duration_minutes')::int, 120),
          coalesce((e ->> 'price_cents')::int, 0),
          coalesce((e ->> 'capacity')::int, 8),
          coalesce((e ->> 'active')::boolean, true));
        v_new := v_new + 1;
        select * into v_before from public.services s where s.id = v_id;
        v_before.id := null; -- new: never counted as changed below
      else
        select * into v_before from public.services s where s.id = v_id;
      end if;

      update public.services s
      set import_ref = coalesce(nullif(e ->> 'ref', ''), s.import_ref),
          name = case when e ? 'name' then left(btrim(e ->> 'name'), 80) else s.name end,
          description = case when e ? 'description' then left(coalesce(e ->> 'description', ''), 2000)
                             else s.description end,
          duration_minutes = coalesce((e ->> 'duration_minutes')::int, s.duration_minutes),
          capacity = coalesce((e ->> 'capacity')::int, s.capacity),
          price_cents = coalesce((e ->> 'price_cents')::int, s.price_cents),
          location = case when e ? 'location' then left(coalesce(e ->> 'location', ''), 200)
                          else s.location end,
          active = coalesce((e ->> 'active')::boolean, s.active),
          shop_product_id = coalesce(v_product, s.shop_product_id),
          shop_variant_id = case when v_product is not null
                                 then coalesce(nullif(e ->> 'shop_variant_id', ''), s.shop_variant_id)
                                 else s.shop_variant_id end
      where s.id = v_id
      returning * into v_after;

      if v_before.id is not null then
        if (v_before.name, v_before.description, v_before.duration_minutes, v_before.capacity,
            v_before.price_cents, v_before.location, v_before.active, v_before.shop_product_id,
            v_before.shop_variant_id, v_before.import_ref)
           is distinct from
           (v_after.name, v_after.description, v_after.duration_minutes, v_after.capacity,
            v_after.price_cents, v_after.location, v_after.active, v_after.shop_product_id,
            v_after.shop_variant_id, v_after.import_ref) then
          v_changed := v_changed + 1;
        else
          v_same := v_same + 1;
        end if;
      end if;
    end loop;
    v_counts := jsonb_build_object('new', v_new, 'changed', v_changed, 'same', v_same,
                                   'refused', v_refused);
    if not coalesce(p_confirm, false) then
      raise exception 'look' using errcode = 'IMPLK';
    end if;
  exception when sqlstate 'IMPLK' then
    return v_counts || jsonb_build_object('repeated', false);
  end;
  return private.booking_import_end(p_tenant_id, p_request_key, 'workshops', p_file_name, v_counts);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Dates
-- ---------------------------------------------------------------------------

-- [{"line", "ref", "keep_id", "workshop_ref", "workshop_name", "starts_at",
--   "ends_at", "capacity", "cancelled", "bookings_closed", "private", "notes",
--   "shared_group", "shared_capacity"}]
-- A date keeps the earlier app's id (`keep_id`) when it has one: that id is
-- the "Session ID" already sitting in carts and on orders in the shop. It
-- stays unique and belongs to this workspace only; an id that is in use
-- anywhere else is refused with the same words as any other unusable id.
-- Matched by that id, else by the earlier app's id (`ref`), else by the
-- workshop and start. Rows sharing a `shared_group` share one room's places
-- (they must run at the same time).
create function public.import_booking_dates(
  p_tenant_id uuid, p_request_key uuid, p_rows jsonb, p_file_name text default '',
  p_confirm boolean default false
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_done jsonb := private.booking_import_begin(p_tenant_id, p_request_key, p_rows, p_confirm);
  v_new int := 0;
  v_changed int := 0;
  v_same int := 0;
  v_ids_not_kept int := 0;
  v_shared int := 0;
  v_refused jsonb := '[]'::jsonb;
  v_counts jsonb;
  e jsonb;
  v_service public.services;
  v_id uuid;
  v_keep uuid;
  v_owner uuid;
  v_starts timestamptz;
  v_ends timestamptz;
  v_before public.sessions;
  v_after public.sessions;
  v_placed jsonb := '[]'::jsonb;
  g record;
  v_group uuid;
begin
  if v_done is not null then
    return v_done;
  end if;
  begin
    -- Lock every date this file could touch, in the one order, before
    -- touching any (see private.lock_seats).
    perform private.lock_seats(array(
      select s.id from public.sessions s
      where s.tenant_id = p_tenant_id
        and (s.id::text in (select x ->> 'keep_id' from jsonb_array_elements(p_rows) x)
             or s.import_ref in (select x ->> 'ref' from jsonb_array_elements(p_rows) x)
             or s.starts_at in (select (x ->> 'starts_at')::timestamptz
                                from jsonb_array_elements(p_rows) x))));

    for e in select * from jsonb_array_elements(p_rows)
    loop
      v_service := null;
      if nullif(e ->> 'workshop_ref', '') is not null then
        select * into v_service from public.services s
        where s.tenant_id = p_tenant_id and s.kind = 'workshop'
          and (s.import_ref = e ->> 'workshop_ref' or s.id::text = e ->> 'workshop_ref');
      end if;
      if v_service.id is null and nullif(e ->> 'workshop_name', '') is not null then
        select * into v_service from public.services s
        where s.tenant_id = p_tenant_id and s.kind = 'workshop'
          and lower(s.name) = lower(btrim(e ->> 'workshop_name'))
        order by s.created_at limit 1;
      end if;
      if v_service.id is null then
        v_refused := v_refused || private.import_refusal(e -> 'line',
          'No workshop here matches this date. Bring the workshops file in first.');
        continue;
      end if;
      v_starts := (e ->> 'starts_at')::timestamptz;
      v_ends := coalesce((e ->> 'ends_at')::timestamptz,
                         v_starts + make_interval(mins => v_service.duration_minutes));
      v_keep := nullif(e ->> 'keep_id', '')::uuid;
      v_id := null;

      if v_keep is not null then
        select s.tenant_id into v_owner from public.sessions s where s.id = v_keep;
        if v_owner is not null and v_owner <> p_tenant_id then
          -- Says nothing about where, or whose.
          v_refused := v_refused || private.import_refusal(e -> 'line',
            'This date''s id can''t be used here, so the date was left out.');
          continue;
        end if;
        if v_owner is not null then
          v_id := v_keep;
        end if;
      end if;
      if v_id is null and nullif(e ->> 'ref', '') is not null then
        select s.id into v_id from public.sessions s
        where s.tenant_id = p_tenant_id and s.import_ref = e ->> 'ref';
      end if;
      if v_id is null then
        select s.id into v_id from public.sessions s
        where s.service_id = v_service.id and s.starts_at = v_starts;
        if v_id is not null and v_keep is not null then
          -- Already here under its own id: carts carrying the earlier id
          -- won't find it, so say so.
          v_ids_not_kept := v_ids_not_kept + 1;
        end if;
      end if;

      if v_id is not null then
        select * into v_before from public.sessions s where s.id = v_id;
        if v_before.service_id <> v_service.id then
          v_refused := v_refused || private.import_refusal(e -> 'line',
            'This date is already here under a different workshop.');
          continue;
        end if;
        if v_before.import_ref is not null and nullif(e ->> 'ref', '') is not null
           and v_before.import_ref <> e ->> 'ref' then
          v_refused := v_refused || private.import_refusal(e -> 'line',
            'Another date from your earlier app is already at this time.');
          continue;
        end if;
        if exists (select 1 from public.sessions s
                   where s.service_id = v_service.id and s.starts_at = v_starts and s.id <> v_id) then
          v_refused := v_refused || private.import_refusal(e -> 'line',
            'This workshop already has another date at that time.');
          continue;
        end if;
        update public.sessions s
        set import_ref = coalesce(nullif(e ->> 'ref', ''), s.import_ref),
            starts_at = v_starts, ends_at = v_ends,
            capacity = coalesce((e ->> 'capacity')::int, s.capacity),
            bookings_closed = coalesce((e ->> 'bookings_closed')::boolean, s.bookings_closed),
            private = coalesce((e ->> 'private')::boolean, s.private),
            notes = case when e ? 'notes' then left(coalesce(e ->> 'notes', ''), 2000) else s.notes end,
            cancelled_at = case
              when not (e ? 'cancelled') then s.cancelled_at
              when (e ->> 'cancelled')::boolean then coalesce(s.cancelled_at,
                     nullif(e ->> 'cancelled_at', '')::timestamptz, now())
              else null end
        where s.id = v_id
        returning * into v_after;
        if (v_before.import_ref, v_before.starts_at, v_before.ends_at, v_before.capacity,
            v_before.bookings_closed, v_before.private, v_before.notes,
            v_before.cancelled_at is null)
           is distinct from
           (v_after.import_ref, v_after.starts_at, v_after.ends_at, v_after.capacity,
            v_after.bookings_closed, v_after.private, v_after.notes,
            v_after.cancelled_at is null) then
          v_changed := v_changed + 1;
        else
          v_same := v_same + 1;
        end if;
      else
        insert into public.sessions
          (id, tenant_id, service_id, starts_at, ends_at, capacity, bookings_closed, private,
           notes, cancelled_at, import_ref)
        values
          (coalesce(v_keep, gen_random_uuid()), p_tenant_id, v_service.id, v_starts, v_ends,
           coalesce((e ->> 'capacity')::int, v_service.capacity),
           coalesce((e ->> 'bookings_closed')::boolean, false),
           coalesce((e ->> 'private')::boolean, false),
           left(coalesce(e ->> 'notes', ''), 2000),
           case when coalesce((e ->> 'cancelled')::boolean, false)
                then coalesce(nullif(e ->> 'cancelled_at', '')::timestamptz, now()) end,
           nullif(e ->> 'ref', ''))
        returning id into v_id;
        v_new := v_new + 1;
      end if;
      if nullif(e ->> 'shared_group', '') is not null then
        v_placed := v_placed || jsonb_build_object(
          'group', e ->> 'shared_group', 'id', v_id, 'line', e -> 'line',
          'capacity', e -> 'shared_capacity');
      end if;
    end loop;

    -- Rooms shared between dates that run at the same time.
    for g in
      select p ->> 'group' as label,
             array_agg(distinct (p ->> 'id')::uuid) as ids,
             max((p ->> 'capacity')::int) as capacity,
             min((p ->> 'line')::int) as line
      from jsonb_array_elements(v_placed) p
      group by p ->> 'group'
    loop
      if cardinality(g.ids) < 2 then
        continue;
      end if;
      if (select count(distinct s.seat_group_id) = 1 and bool_and(s.seat_group_id is not null)
          from public.sessions s where s.id = any(g.ids)) then
        continue; -- already sharing, as the file says
      end if;
      if exists (select 1 from public.sessions s where s.id = any(g.ids) and s.seat_group_id is not null) then
        v_refused := v_refused || private.import_refusal(to_jsonb(g.line),
          'These dates already share their places some other way, so the shared room was left as it is.');
        continue;
      end if;
      if (select max(s.starts_at) >= min(s.ends_at) from public.sessions s where s.id = any(g.ids)) then
        v_refused := v_refused || private.import_refusal(to_jsonb(g.line),
          'The dates in this shared room don''t run at the same time, so they weren''t tied together.');
        continue;
      end if;
      insert into public.session_seat_groups (tenant_id, capacity, created_by)
      values (p_tenant_id,
              greatest(coalesce(g.capacity, 1),
                       (select coalesce(sum(private.seats_taken(s.id)), 0)::int
                        from public.sessions s where s.id = any(g.ids)), 1),
              auth.uid())
      returning id into v_group;
      update public.sessions s set seat_group_id = v_group where s.id = any(g.ids);
      v_shared := v_shared + 1;
    end loop;

    v_counts := jsonb_build_object('new', v_new, 'changed', v_changed, 'same', v_same,
                                   'refused', v_refused, 'ids_not_kept', v_ids_not_kept,
                                   'shared_rooms', v_shared);
    if not coalesce(p_confirm, false) then
      raise exception 'look' using errcode = 'IMPLK';
    end if;
  exception when sqlstate 'IMPLK' then
    return v_counts || jsonb_build_object('repeated', false);
  end;
  return private.booking_import_end(p_tenant_id, p_request_key, 'dates', p_file_name, v_counts);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Bookings
-- ---------------------------------------------------------------------------

-- [{"line", "ref", "session_ref", "name", "email", "phone", "text_opt_in",
--   "seats", "status", "attendance", "source", "tags", "shop_order_id",
--   "shop_order_name", "notes", "email_opt_in", "created_at", "cancelled_at",
--   "reminder_sent_at", "day_of_sent_at", "followup_sent_at", "amount_cents"}]
-- Never sends anything. Each booking is written down with what the earlier
-- app already sent, and a class that has already finished is never sent a
-- thank-you from here for a booking brought in. A booking with a shop order
-- keeps the order's id, so a later order sync finds it (`book_from_shop` is
-- once per order and date) instead of making a second one. A paid booking
-- is never refused for room: over a limit, it is kept and flagged.
create function public.import_bookings(
  p_tenant_id uuid, p_request_key uuid, p_rows jsonb, p_file_name text default '',
  p_confirm boolean default false
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_done jsonb := private.booking_import_begin(p_tenant_id, p_request_key, p_rows, p_confirm);
  v_new int := 0;
  v_changed int := 0;
  v_same int := 0;
  v_over int := 0;
  v_marked int := 0;
  v_refused jsonb := '[]'::jsonb;
  v_counts jsonb;
  e jsonb;
  v_session public.sessions;
  v_booking public.bookings;
  v_before public.bookings;
  v_currency text;
  v_status public.booking_status;
  v_tags text[];
  v_email text;
  v_rows int;
  v_touched boolean;
  v_note text := 'Brought across from your earlier booking app; not sent from here.';
  k record;
begin
  if v_done is not null then
    return v_done;
  end if;
  select t.currency into v_currency from public.tenants t where t.id = p_tenant_id;
  begin
    -- Every date this file books onto, locked in the one order first.
    perform private.lock_seats(array(
      select s.id from public.sessions s
      where s.tenant_id = p_tenant_id
        and (s.import_ref in (select x ->> 'session_ref' from jsonb_array_elements(p_rows) x)
             or s.id::text in (select x ->> 'session_ref' from jsonb_array_elements(p_rows) x))));

    for e in select * from jsonb_array_elements(p_rows)
    loop
      select s.* into v_session from public.sessions s
      where s.tenant_id = p_tenant_id
        and (s.id::text = e ->> 'session_ref' or s.import_ref = e ->> 'session_ref')
      order by (s.id::text = e ->> 'session_ref') desc
      limit 1;
      if not found then
        -- The same words whether or not the id exists anywhere else.
        v_refused := v_refused || private.import_refusal(e -> 'line',
          'No date here has this id. Bring the dates file in first.');
        continue;
      end if;
      v_status := (e ->> 'status')::public.booking_status;
      v_email := lower(btrim(coalesce(e ->> 'email', '')));
      select coalesce(array_agg(distinct t), '{}') into v_tags
      from (select lower(btrim(x)) as t
            from jsonb_array_elements_text(coalesce(e -> 'tags', '[]'::jsonb)) as x) cleaned
      where t ~ '^[a-z0-9][a-z0-9 _-]{0,29}$';

      v_before := null;
      if nullif(e ->> 'ref', '') is not null then
        select * into v_before from public.bookings b
        where b.tenant_id = p_tenant_id and b.import_ref = e ->> 'ref';
      end if;
      if v_before.id is null and nullif(e ->> 'shop_order_id', '') is not null then
        select * into v_before from public.bookings b
        where b.tenant_id = p_tenant_id and b.shop_order_id = e ->> 'shop_order_id'
          and b.session_id = v_session.id;
      end if;
      if v_before.id is not null and v_before.session_id <> v_session.id then
        v_refused := v_refused || private.import_refusal(e -> 'line',
          'This booking is already here on another date. Move it from that date''s page instead.');
        continue;
      end if;

      if v_before.id is null then
        insert into public.bookings
          (tenant_id, session_id, customer_name, customer_email, customer_phone, text_opt_in,
           seats, status, amount_cents, currency, manage_token_hash, confirmed_at, cancelled_at,
           source, oversold, shop_order_id, shop_order_name, notes, tags, email_opt_in,
           attendance, created_at, import_ref)
        values
          (p_tenant_id, v_session.id,
           left(coalesce(nullif(btrim(e ->> 'name'), ''), nullif(v_email, ''), 'Guest'), 120),
           v_email, left(coalesce(e ->> 'phone', ''), 40),
           coalesce((e ->> 'text_opt_in')::boolean, false),
           (e ->> 'seats')::int, v_status, greatest(coalesce((e ->> 'amount_cents')::int, 0), 0),
           v_currency,
           -- A fresh secret nobody holds: "Send the confirmation again" gives a link.
           private.hash_token(gen_random_uuid()::text || gen_random_uuid()::text),
           case when v_status = 'confirmed'
                then coalesce(nullif(e ->> 'created_at', '')::timestamptz, now()) end,
           case when v_status = 'cancelled'
                then coalesce(nullif(e ->> 'cancelled_at', '')::timestamptz,
                              nullif(e ->> 'created_at', '')::timestamptz, now()) end,
           case when nullif(e ->> 'shop_order_id', '') is not null then 'online' else 'manual' end,
           v_status = 'confirmed' and not private.has_room(v_session.id, (e ->> 'seats')::int),
           nullif(e ->> 'shop_order_id', ''), nullif(left(coalesce(e ->> 'shop_order_name', ''), 40), ''),
           left(coalesce(e ->> 'notes', ''), 2000), v_tags,
           coalesce((e ->> 'email_opt_in')::boolean, true),
           case when v_status = 'confirmed' then nullif(e ->> 'attendance', '') end,
           coalesce(nullif(e ->> 'created_at', '')::timestamptz, now()),
           nullif(e ->> 'ref', ''))
        returning * into v_booking;
        v_new := v_new + 1;
        if v_booking.oversold then
          v_over := v_over + 1;
        end if;
        v_touched := false;
      elsif v_before.import_ref is not null then
        -- Brought in before: follow what the file says now.
        update public.bookings b
        set customer_name = left(coalesce(nullif(btrim(e ->> 'name'), ''), nullif(v_email, ''), 'Guest'), 120),
            customer_email = v_email,
            customer_phone = left(coalesce(e ->> 'phone', ''), 40),
            text_opt_in = coalesce((e ->> 'text_opt_in')::boolean, false),
            seats = (e ->> 'seats')::int,
            status = v_status,
            cancelled_at = case when v_status = 'cancelled'
                                then coalesce(b.cancelled_at, nullif(e ->> 'cancelled_at', '')::timestamptz, now())
                                end,
            confirmed_at = case when v_status = 'confirmed' then coalesce(b.confirmed_at, now())
                                else b.confirmed_at end,
            notes = left(coalesce(e ->> 'notes', ''), 2000),
            tags = v_tags,
            email_opt_in = coalesce((e ->> 'email_opt_in')::boolean, true),
            attendance = case when v_status = 'confirmed' then nullif(e ->> 'attendance', '') end,
            shop_order_id = coalesce(nullif(e ->> 'shop_order_id', ''), b.shop_order_id),
            shop_order_name = coalesce(nullif(left(coalesce(e ->> 'shop_order_name', ''), 40), ''),
                                       b.shop_order_name),
            amount_cents = coalesce((e ->> 'amount_cents')::int, b.amount_cents)
        where b.id = v_before.id
        returning * into v_booking;
        v_touched := (v_before.customer_name, v_before.customer_email, v_before.customer_phone,
                      v_before.text_opt_in, v_before.seats, v_before.status, v_before.notes,
                      v_before.tags, v_before.email_opt_in, v_before.attendance,
                      v_before.shop_order_id, v_before.shop_order_name, v_before.amount_cents)
                     is distinct from
                     (v_booking.customer_name, v_booking.customer_email, v_booking.customer_phone,
                      v_booking.text_opt_in, v_booking.seats, v_booking.status, v_booking.notes,
                      v_booking.tags, v_booking.email_opt_in, v_booking.attendance,
                      v_booking.shop_order_id, v_booking.shop_order_name, v_booking.amount_cents);
        if v_touched and v_booking.status = 'confirmed' then
          update public.bookings b
          set oversold = not private.has_room(v_session.id, b.seats, b.id)
          where b.id = v_booking.id;
        end if;
      else
        -- Already here from the shop sync (same order, same date): the shop
        -- is the word on seats and status. Only what the sync can't know is
        -- added: the earlier app's id, a phone number, what was sent.
        update public.bookings b
        set import_ref = nullif(e ->> 'ref', ''),
            customer_phone = case when b.customer_phone = ''
                                  then left(coalesce(e ->> 'phone', ''), 40) else b.customer_phone end,
            text_opt_in = b.text_opt_in or coalesce((e ->> 'text_opt_in')::boolean, false)
        where b.id = v_before.id
        returning * into v_booking;
        v_touched := (v_before.customer_phone, v_before.text_opt_in, v_before.import_ref)
                     is distinct from
                     (v_booking.customer_phone, v_booking.text_opt_in, v_booking.import_ref);
      end if;

      -- What the earlier app already sent, so it isn't sent again from here.
      -- A class already over never gets a thank-you for a booking brought in.
      for k in
        select x.kind, x.at from (values
          ('reminder', nullif(e ->> 'reminder_sent_at', '')::timestamptz),
          ('day_of', nullif(e ->> 'day_of_sent_at', '')::timestamptz),
          ('followup', coalesce(nullif(e ->> 'followup_sent_at', '')::timestamptz,
                                case when v_session.ends_at <= now() then now() end))
        ) as x(kind, at)
        where x.at is not null
      loop
        insert into public.booking_emails
          (tenant_id, booking_id, session_id, kind, status, tries, detail, claimed_at, finished_at)
        values (p_tenant_id, v_booking.id, v_session.id, k.kind, 'sent', 0, v_note, k.at, k.at)
        on conflict on constraint booking_emails_booking_id_kind_session_id_key do nothing;
        get diagnostics v_rows = row_count;
        if v_rows > 0 then
          v_marked := v_marked + 1;
          v_touched := v_touched or v_before.id is not null;
        end if;
      end loop;
      update public.bookings b
      set reminder_sent_at = coalesce(b.reminder_sent_at, nullif(e ->> 'reminder_sent_at', '')::timestamptz),
          followup_sent_at = coalesce(b.followup_sent_at, nullif(e ->> 'followup_sent_at', '')::timestamptz)
      where b.id = v_booking.id
        and ((b.reminder_sent_at is null and nullif(e ->> 'reminder_sent_at', '') is not null)
             or (b.followup_sent_at is null and nullif(e ->> 'followup_sent_at', '') is not null));

      if v_before.id is not null then
        if v_touched then v_changed := v_changed + 1; else v_same := v_same + 1; end if;
      end if;
    end loop;
    v_counts := jsonb_build_object('new', v_new, 'changed', v_changed, 'same', v_same,
                                   'refused', v_refused, 'oversold', v_over,
                                   'emails_marked', v_marked);
    if not coalesce(p_confirm, false) then
      raise exception 'look' using errcode = 'IMPLK';
    end if;
  exception when sqlstate 'IMPLK' then
    return v_counts || jsonb_build_object('repeated', false);
  end;
  return private.booking_import_end(p_tenant_id, p_request_key, 'bookings', p_file_name, v_counts);
end;
$$;

revoke all on function public.import_booking_workshops(uuid, uuid, jsonb, text, boolean) from public, anon;
revoke all on function public.import_booking_dates(uuid, uuid, jsonb, text, boolean) from public, anon;
revoke all on function public.import_bookings(uuid, uuid, jsonb, text, boolean) from public, anon;
grant execute on function public.import_booking_workshops(uuid, uuid, jsonb, text, boolean) to authenticated;
grant execute on function public.import_booking_dates(uuid, uuid, jsonb, text, boolean) to authenticated;
grant execute on function public.import_bookings(uuid, uuid, jsonb, text, boolean) to authenticated;
