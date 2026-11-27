-- Re-importing the bookings file never doubles an Eventbrite booking.
--
-- Eventbrite bookings came across without their order number. Bringing the
-- file in again the next morning (as the switch-day list says to) then added
-- a second copy of any Eventbrite order the suite had booked itself in the
-- meantime, and `book_from_eventbrite` couldn't find an imported booking, so
-- a later change on Eventbrite booked it again.
--
-- Now the file may carry `eventbrite_order_id` (the earlier app keeps it on
-- each booking). A booking brought in with one keeps it and comes in as an
-- Eventbrite booking, so `book_from_eventbrite` (once per order) finds it.
-- The import matches by the earlier app's id first, then by Eventbrite order
-- (whichever date it sits on: a different date is refused with the same
-- words as before, never added), then by shop order and date. A booking
-- brought in before without the number picks it up when the file has it,
-- unless another booking here already has it. A file without the earlier
-- app's ids still matches its Eventbrite rows by order number, so the same
-- file again changes nothing.
--
-- Also: a shop order the sync booked on the date its cart named, which the
-- earlier app had moved to the date the file says, was added a second time.
-- Now it is matched as that order's booking on another date and refused,
-- like any booking already here on another date.

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
  v_texts int := 0;
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
  v_eventbrite text;
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
      v_eventbrite := case when coalesce(e ->> 'eventbrite_order_id', '') ~ '^[0-9]{1,30}$'
                           then e ->> 'eventbrite_order_id' end;
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
      -- An Eventbrite order is one booking, whichever date it sits on now:
      -- one brought in before, or one the suite booked from Eventbrite itself.
      if v_before.id is null and v_eventbrite is not null then
        select * into v_before from public.bookings b
        where b.tenant_id = p_tenant_id and b.eventbrite_order_id = v_eventbrite
        order by (b.session_id = v_session.id) desc, (b.status = 'confirmed') desc, b.created_at
        limit 1;
      end if;
      if v_before.id is null and nullif(e ->> 'shop_order_id', '') is not null then
        select * into v_before from public.bookings b
        where b.tenant_id = p_tenant_id and b.shop_order_id = e ->> 'shop_order_id'
          and b.session_id = v_session.id;
        -- The shop sync booked this order on the date its cart named, and
        -- the earlier app had moved it to the date the file says: the same
        -- booking, on another date. Never added a second time.
        if v_before.id is null then
          select b.* into v_before from public.bookings b
          join public.sessions s on s.id = b.session_id
          where b.tenant_id = p_tenant_id and b.shop_order_id = e ->> 'shop_order_id'
            and b.import_ref is null
            and s.service_id = v_session.service_id
            and not exists (select 1 from public.shop_undated_lines u where u.booking_id = b.id)
            and b.session_id not in (
              select s2.id from jsonb_array_elements(p_rows) x
              join public.sessions s2
                on s2.tenant_id = p_tenant_id
               and (s2.id::text = x ->> 'session_ref' or s2.import_ref = x ->> 'session_ref')
              where x ->> 'shop_order_id' = e ->> 'shop_order_id')
          order by b.created_at, b.id
          limit 1;
        end if;
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
           attendance, created_at, import_ref, eventbrite_order_id)
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
           case when nullif(e ->> 'shop_order_id', '') is not null then 'online'
                when v_eventbrite is not null then 'eventbrite'
                else 'manual' end,
           v_status = 'confirmed' and not private.has_room(v_session.id, (e ->> 'seats')::int),
           nullif(e ->> 'shop_order_id', ''), nullif(left(coalesce(e ->> 'shop_order_name', ''), 40), ''),
           left(coalesce(e ->> 'notes', ''), 2000), v_tags,
           coalesce((e ->> 'email_opt_in')::boolean, true),
           case when v_status = 'confirmed' then nullif(e ->> 'attendance', '') end,
           coalesce(nullif(e ->> 'created_at', '')::timestamptz, now()),
           nullif(e ->> 'ref', ''), v_eventbrite)
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
            amount_cents = coalesce((e ->> 'amount_cents')::int, b.amount_cents),
            -- The Eventbrite order's number, once the file carries it and no
            -- other booking here has it already.
            eventbrite_order_id = coalesce(b.eventbrite_order_id, case
              when v_eventbrite is not null and not exists (
                select 1 from public.bookings o
                where o.tenant_id = p_tenant_id and o.eventbrite_order_id = v_eventbrite)
              then v_eventbrite end)
        where b.id = v_before.id
        returning * into v_booking;
        v_touched := (v_before.customer_name, v_before.customer_email, v_before.customer_phone,
                      v_before.text_opt_in, v_before.seats, v_before.status, v_before.notes,
                      v_before.tags, v_before.email_opt_in, v_before.attendance,
                      v_before.shop_order_id, v_before.shop_order_name, v_before.amount_cents,
                      v_before.eventbrite_order_id)
                     is distinct from
                     (v_booking.customer_name, v_booking.customer_email, v_booking.customer_phone,
                      v_booking.text_opt_in, v_booking.seats, v_booking.status, v_booking.notes,
                      v_booking.tags, v_booking.email_opt_in, v_booking.attendance,
                      v_booking.shop_order_id, v_booking.shop_order_name, v_booking.amount_cents,
                      v_booking.eventbrite_order_id);
        if v_touched and v_booking.status = 'confirmed' then
          update public.bookings b
          set oversold = not private.has_room(v_session.id, b.seats, b.id)
          where b.id = v_booking.id;
        end if;
      else
        -- Already here from the shop sync (same order, same date) or booked
        -- from Eventbrite by the suite itself (same order): the shop or
        -- Eventbrite is the word on seats and status. Only what the sync can't know is
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
      -- The same for texts. The file may say which texts went
      -- (`*_text_sent_at`); where it says nothing about a text, a message
      -- whose email went counts as gone for its text too, and a class
      -- already over never gets a thank-you text. Only for a booking with a
      -- number to text.
      if btrim(coalesce(v_booking.customer_phone, '')) <> '' then
        for k in
          select x.kind, x.at from (values
            ('reminder', coalesce(nullif(e ->> 'reminder_text_sent_at', '')::timestamptz,
                                  nullif(e ->> 'reminder_sent_at', '')::timestamptz)),
            ('day_of', coalesce(nullif(e ->> 'day_of_text_sent_at', '')::timestamptz,
                                nullif(e ->> 'day_of_sent_at', '')::timestamptz)),
            ('followup', coalesce(nullif(e ->> 'followup_text_sent_at', '')::timestamptz,
                                  nullif(e ->> 'followup_sent_at', '')::timestamptz,
                                  case when v_session.ends_at <= now() then now() end))
          ) as x(kind, at)
          where x.at is not null
        loop
          insert into public.booking_texts
            (tenant_id, booking_id, session_id, kind, status, tries, detail, claimed_at, finished_at)
          values (p_tenant_id, v_booking.id, v_session.id, k.kind, 'sent', 0, v_note, k.at, k.at)
          on conflict on constraint booking_texts_booking_id_kind_session_id_key do nothing;
          get diagnostics v_rows = row_count;
          if v_rows > 0 then
            v_texts := v_texts + 1;
            v_touched := v_touched or v_before.id is not null;
          end if;
        end loop;
      end if;

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
                                   'emails_marked', v_marked, 'texts_marked', v_texts);
    if not coalesce(p_confirm, false) then
      raise exception 'look' using errcode = 'IMPLK';
    end if;
  exception when sqlstate 'IMPLK' then
    return v_counts || jsonb_build_object('repeated', false);
  end;
  return private.booking_import_end(p_tenant_id, p_request_key, 'bookings', p_file_name, v_counts);
end;
$$;
