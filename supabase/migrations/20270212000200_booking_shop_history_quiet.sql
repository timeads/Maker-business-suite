-- Orders read again from the shop's history are written down quietly.
--
-- Reconnecting a shop, or the one-off read of its history
-- (`queue_commerce_detail_reads` and the full sync), hands the sync every
-- order of the last months again. Before this, an order whose date had no
-- matching booking here was booked and emailed "you're booked", even for a
-- class long over.
--
-- Now `book_from_shop` still writes such an order down (the roster and the
-- money figures want it), but marks it `history_only` and answers
-- `recorded` instead of `booked`, so no worker, older or newer, sends a
-- confirmation for it. An order is history when:
--   * its class has already started, or
--   * it was placed before the workshop was linked to its shop product here
--     (`services.shop_linked_at`, the idea the undated lines already use),
--     or before its date existed here (a date brought across with its id).
-- Nothing is ever sent to a history_only booking by itself: no reminder,
-- day-of reminder or thank-you (email or text), no "a refund cancelled your
-- booking" notice, no text set off by something happening. A person can
-- still press "Send the confirmation again".
--
-- The bookings file takes such a booking over: when the import matches one,
-- the mark is lifted, the file's "already sent" columns are written down as
-- usual, and a reminder it says wasn't sent goes at the usual time.

alter table public.bookings
  add column history_only boolean not null default false;

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
  v_placed timestamptz;
  v_linked timestamptz;
  v_quiet boolean;
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
  -- From the shop's history: a class already started, or an order placed
  -- before this workshop was sold through the shop here or before this
  -- date existed here. Written down for the roster; nothing is sent.
  select min(o.processed_at) into v_placed from public.orders o
  where o.tenant_id = p_tenant_id and o.external_id = p_order_id;
  select sv.shop_linked_at into v_linked from public.services sv where sv.id = v_session.service_id;
  v_quiet := v_session.starts_at <= now()
             or (v_placed is not null
                 and (v_placed < v_session.created_at or v_placed < v_linked));
  select t.currency into v_currency from public.tenants t where t.id = p_tenant_id;
  insert into public.bookings
    (tenant_id, session_id, customer_name, customer_email, seats, status, amount_cents, currency,
     manage_token_hash, confirmed_at, source, oversold, shop_order_id, shop_order_name,
     shop_line_ids, shop_cart_session_id, history_only)
  values
    (p_tenant_id, v_session.id,
     left(coalesce(nullif(btrim(p_name), ''), nullif(btrim(p_email), ''), 'Guest'), 120),
     lower(btrim(coalesce(p_email, ''))), v_seats, 'confirmed',
     greatest(coalesce(p_amount_cents, 0), 0), v_currency,
     private.hash_token(p_manage_token), now(), 'online', v_over,
     p_order_id, left(coalesce(p_order_name, ''), 40),
     nullif(v_lines, '{}'), v_session.id, v_quiet)
  returning * into v_booking;
  return jsonb_build_object(
    'result', case when v_quiet then 'recorded' else 'booked' end, 'booking_id', v_booking.id, 'oversold', v_over,
    'date_cancelled', v_session.cancelled_at is not null);
end;
$$;

create or replace function public.queue_booking_cancel_email(p_tenant_id uuid, p_booking_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_rows int;
begin
  insert into public.booking_emails (tenant_id, booking_id, session_id, kind, status)
  select b.tenant_id, b.id, b.session_id, 'cancelled', 'queued'
  from public.bookings b
  join public.sessions s on s.id = b.session_id
  where b.id = p_booking_id and b.tenant_id = p_tenant_id
    and b.status = 'cancelled' and b.shop_order_id is not null
    and b.email_opt_in and b.customer_email <> '' and not b.history_only
    -- Cancelling a booking on a class that already happened is bookkeeping, not news.
    and s.starts_at > now()
    and private.booking_email_switch(b.tenant_id, 'shop_cancel_email', true)
  on conflict on constraint booking_emails_booking_id_kind_session_id_key do nothing;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

create or replace function public.queue_booking_text(p_tenant_id uuid, p_booking_id uuid, p_kind text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_booking public.bookings;
  v_id uuid;
begin
  if p_kind is null or p_kind not in ('confirmation', 'cancelled', 'moved') then
    raise exception 'Unknown text' using errcode = '22023';
  end if;
  select * into v_booking from public.bookings b
  where b.id = p_booking_id and b.tenant_id = p_tenant_id;
  if not found or not v_booking.text_opt_in or btrim(v_booking.customer_phone) = ''
     or v_booking.history_only then
    return 'skipped';
  end if;
  if not private.booking_text_on(p_tenant_id, p_kind) then
    return 'off';
  end if;
  insert into public.booking_texts (tenant_id, booking_id, session_id, kind, status)
  values (p_tenant_id, v_booking.id, v_booking.session_id, p_kind, 'queued')
  on conflict (booking_id, kind, session_id) do nothing
  returning id into v_id;
  return case when v_id is null then 'already' else 'queued' end;
end;
$$;

create or replace function public.claim_booking_email_sends(p_limit int default 50)
returns table (send_id uuid, booking_id uuid, tenant_id uuid, kind text, tries int)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_limit int := greatest(1, least(coalesce(p_limit, 50), 200));
begin
  update public.booking_emails e
  set status = 'unsure', finished_at = now(), next_try_at = null,
      detail = 'We never heard whether this one went.'
  where e.status = 'sending' and e.claimed_at < now() - interval '15 minutes';

  return query
    with due as (
      -- The reminder, at the lead time the workspace chose.
      (select b.id as booking_id, b.tenant_id, b.session_id, 'reminder'::text as kind,
              s.starts_at as at
       from public.bookings b
       join public.sessions s on s.id = b.session_id
       where b.status = 'confirmed' and b.reminder_sent_at is null and b.email_opt_in
         and not b.history_only
         and b.customer_email <> ''
         and s.cancelled_at is null and s.starts_at > now()
         and s.starts_at <= now() + make_interval(
           hours => private.booking_email_setting(b.tenant_id, 'reminder_hours', 24))
       order by s.starts_at limit v_limit * 4)
      union all
      -- A second reminder on the day, only where it was switched on, only
      -- when it comes after the first one, and not for someone who booked
      -- inside that last stretch (they have just had their confirmation).
      (select b.id, b.tenant_id, b.session_id, 'day_of', s.starts_at
       from public.bookings b
       join public.sessions s on s.id = b.session_id
       where b.status = 'confirmed' and b.email_opt_in and b.customer_email <> ''
         and not b.history_only
         and s.cancelled_at is null and s.starts_at > now()
         and private.booking_email_switch(b.tenant_id, 'day_of_on', false)
         and private.booking_email_setting(b.tenant_id, 'day_of_hours', 2)
             < private.booking_email_setting(b.tenant_id, 'reminder_hours', 24)
         and s.starts_at <= now() + make_interval(
           hours => private.booking_email_setting(b.tenant_id, 'day_of_hours', 2))
         and coalesce(b.confirmed_at, b.created_at) < s.starts_at - make_interval(
           hours => private.booking_email_setting(b.tenant_id, 'day_of_hours', 2))
       order by s.starts_at limit v_limit * 4)
      union all
      -- The thank-you afterwards, where it was switched on.
      (select b.id, b.tenant_id, b.session_id, 'followup', s.ends_at
       from public.bookings b
       join public.sessions s on s.id = b.session_id
       where b.status = 'confirmed' and b.followup_sent_at is null and b.email_opt_in
         and not b.history_only
         and b.customer_email <> ''
         and b.attendance is distinct from 'no_show'
         and s.cancelled_at is null
         and private.booking_email_switch(b.tenant_id, 'followup_on', false)
         and s.ends_at <= now() - make_interval(
           hours => private.booking_email_setting(b.tenant_id, 'followup_hours', 24))
         -- Never reach back further than two weeks, e.g. when first switched on.
         and s.ends_at > now() - interval '15 days'
       order by s.ends_at limit v_limit * 4)
    ),
    fresh as (
      insert into public.booking_emails
        (tenant_id, booking_id, session_id, kind, status, tries, claimed_at)
      select d.tenant_id, d.booking_id, d.session_id, d.kind, 'sending', 1, now()
      from due d
      where not exists (
        select 1 from public.booking_emails e
        where e.booking_id = d.booking_id and e.kind = d.kind and e.session_id = d.session_id)
      order by d.at
      limit v_limit
      on conflict on constraint booking_emails_booking_id_kind_session_id_key do nothing
      returning id, booking_emails.booking_id, booking_emails.tenant_id, booking_emails.kind,
                booking_emails.tries
    )
    select f.id, f.booking_id, f.tenant_id, f.kind, f.tries from fresh f;

  return query
    update public.booking_emails e
    set status = 'sending', tries = e.tries + 1, claimed_at = now(), next_try_at = null
    where e.id in (
      select e2.id
      from public.booking_emails e2
      join public.bookings b on b.id = e2.booking_id
      join public.sessions s on s.id = e2.session_id
      where (e2.status = 'queued'
             or (e2.status = 'failed' and e2.next_try_at is not null and e2.next_try_at <= now()
                 and e2.tries < private.booking_email_max_tries()))
        and b.email_opt_in and b.customer_email <> '' and not b.history_only
        -- A reminder for a date that has started, a booking since cancelled
        -- or moved, is no longer worth sending.
        and case e2.kind
              when 'cancelled' then b.status = 'cancelled' and s.starts_at > now()
              when 'followup' then b.status = 'confirmed' and b.session_id = e2.session_id
              else b.status = 'confirmed' and b.session_id = e2.session_id
                   and s.cancelled_at is null and s.starts_at > now()
            end
      order by e2.created_at
      limit v_limit
      for update of e2 skip locked)
    returning e.id, e.booking_id, e.tenant_id, e.kind, e.tries;
end;
$$;

create or replace function public.claim_booking_text_sends(p_limit int default 50)
returns table (send_id uuid, booking_id uuid, tenant_id uuid, kind text, tries int)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_limit int := greatest(1, least(coalesce(p_limit, 50), 200));
begin
  update public.booking_texts t
  set status = 'unsure', finished_at = now(), next_try_at = null,
      detail = 'We never heard whether this one went.'
  where t.status = 'sending' and t.claimed_at < now() - interval '15 minutes';

  return query
    with due as (
      -- The reminder, at the lead time the workspace chose for texts. Not for
      -- someone who booked inside that stretch: they have just been told.
      (select b.id as booking_id, b.tenant_id, b.session_id, 'reminder'::text as kind,
              s.starts_at as at
       from public.bookings b
       join public.sessions s on s.id = b.session_id
       where b.status = 'confirmed' and b.text_opt_in and btrim(b.customer_phone) <> ''
         and not b.history_only
         and s.cancelled_at is null and s.starts_at > now()
         and private.booking_text_on(b.tenant_id, 'reminder')
         and s.starts_at <= now() + make_interval(
           hours => private.booking_text_hours(b.tenant_id, 'reminder_hours', 48))
         and coalesce(b.confirmed_at, b.created_at) < s.starts_at - make_interval(
           hours => private.booking_text_hours(b.tenant_id, 'reminder_hours', 48))
       order by s.starts_at limit v_limit * 4)
      union all
      -- On the day, only when it comes after the first reminder.
      (select b.id, b.tenant_id, b.session_id, 'day_of', s.starts_at
       from public.bookings b
       join public.sessions s on s.id = b.session_id
       where b.status = 'confirmed' and b.text_opt_in and btrim(b.customer_phone) <> ''
         and not b.history_only
         and s.cancelled_at is null and s.starts_at > now()
         and private.booking_text_on(b.tenant_id, 'day_of')
         and private.booking_text_hours(b.tenant_id, 'day_of_hours', 2)
             < private.booking_text_hours(b.tenant_id, 'reminder_hours', 48)
         and s.starts_at <= now() + make_interval(
           hours => private.booking_text_hours(b.tenant_id, 'day_of_hours', 2))
         and coalesce(b.confirmed_at, b.created_at) < s.starts_at - make_interval(
           hours => private.booking_text_hours(b.tenant_id, 'day_of_hours', 2))
       order by s.starts_at limit v_limit * 4)
      union all
      -- The thank-you afterwards, never reaching back more than two weeks.
      (select b.id, b.tenant_id, b.session_id, 'followup', s.ends_at
       from public.bookings b
       join public.sessions s on s.id = b.session_id
       where b.status = 'confirmed' and b.text_opt_in and btrim(b.customer_phone) <> ''
         and not b.history_only
         and b.attendance is distinct from 'no_show'
         and s.cancelled_at is null
         and private.booking_text_on(b.tenant_id, 'followup')
         and s.ends_at <= now() - make_interval(
           hours => private.booking_text_hours(b.tenant_id, 'followup_hours', 24))
         and s.ends_at > now() - interval '15 days'
       order by s.ends_at limit v_limit * 4)
    ),
    fresh as (
      insert into public.booking_texts
        (tenant_id, booking_id, session_id, kind, status, tries, claimed_at)
      select d.tenant_id, d.booking_id, d.session_id, d.kind, 'sending', 1, now()
      from due d
      where not exists (
        select 1 from public.booking_texts t
        where t.booking_id = d.booking_id and t.kind = d.kind and t.session_id = d.session_id)
      order by d.at
      limit v_limit
      on conflict on constraint booking_texts_booking_id_kind_session_id_key do nothing
      returning id, booking_texts.booking_id, booking_texts.tenant_id, booking_texts.kind,
                booking_texts.tries
    )
    select f.id, f.booking_id, f.tenant_id, f.kind, f.tries from fresh f;

  return query
    update public.booking_texts t
    set status = 'sending', tries = t.tries + 1, claimed_at = now(), next_try_at = null
    where t.id in (
      select t2.id
      from public.booking_texts t2
      join public.bookings b on b.id = t2.booking_id
      join public.sessions s on s.id = t2.session_id
      where (t2.status = 'queued'
             or (t2.status = 'failed' and t2.next_try_at is not null and t2.next_try_at <= now()
                 and t2.tries < private.booking_text_max_tries()))
        and b.text_opt_in and btrim(b.customer_phone) <> '' and not b.history_only
        and private.booking_text_on(t2.tenant_id, t2.kind)
        and case t2.kind
              when 'cancelled' then b.status = 'cancelled' and s.starts_at > now()
              when 'followup' then b.status = 'confirmed' and b.session_id = t2.session_id
              else b.status = 'confirmed' and b.session_id = t2.session_id
                   and s.cancelled_at is null and s.starts_at > now()
            end
      order by t2.created_at
      limit v_limit
      for update of t2 skip locked)
    returning t.id, t.booking_id, t.tenant_id, t.kind, t.tries;
end;
$$;

create or replace function public.import_bookings(
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

      -- A booking the shop sync wrote down quietly from the shop's history
      -- is the earlier app's: from here the file says what was sent, and
      -- what it doesn't say was sent goes as usual.
      update public.bookings b set history_only = false
      where b.id = v_booking.id and b.history_only;
      get diagnostics v_rows = row_count;
      v_touched := v_touched or (v_rows > 0 and v_before.id is not null);

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
