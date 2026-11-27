-- "Pause messages to customers": one switch for a whole workspace.
--
-- `paused` in the bookings / emails config (owners and admins, Settings ->
-- Bookings -> Emails & questions, and a setting the assistant can propose).
-- The database reads it in the claims for emails AND texts, so while it is
-- on nothing is handed out to send, and so nothing is stamped either. The
-- worker needs no change: an older one claims through these same functions.
--
-- What happens to messages that came due while paused, once it comes off:
--   * A reminder or day-of reminder (email or text) goes only while its
--     class is still ahead and inside its usual lead time: the rule it always
--     had. One whose class is still coming goes straight away, once; one
--     whose class has started is never sent.
--   * A thank-you (email or text) that fell due while paused is skipped,
--     never sent late. One that falls due after the pause goes as usual.
--   * A message something set off while paused (a shop refund's notice, a
--     text for a booking made, cancelled or moved) is never sent: it is
--     written down as held, with words saying why, when the pause ends.
--   * Failed sends waiting for another try simply wait, and are tried again
--     afterwards while they still make sense.
-- "Fell due while paused" is read from the setting's own history
-- (`config_versions`, which every config write leaves), so no timestamp
-- needs keeping beside the switch.
-- "You're booked" emails are sent by the app, which reads the same switch
-- and holds them (never sent later); a person can press "Send the
-- confirmation again".

-- Is the workspace's switch on now?
create function private.booking_messages_paused(p_tenant_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.booking_email_switch(p_tenant_id, 'paused', false);
$$;
revoke all on function private.booking_messages_paused(uuid) from public;

-- Was it on at that moment? The emails setting as it stood then.
create function private.booking_messages_paused_at(p_tenant_id uuid, p_at timestamptz)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select v.body -> 'paused' = 'true'::jsonb
    from public.config_versions v
    where v.tenant_id = p_tenant_id and v.module = 'bookings' and v.key = 'emails'
      and v.created_at <= p_at
    order by v.created_at desc, v.version desc
    limit 1), false);
$$;
revoke all on function private.booking_messages_paused_at(uuid, timestamptz) from public;

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

  -- Set off while messages were paused: never sent late. Written down as
  -- held, once the pause is over (nothing is touched while it lasts).
  update public.booking_emails e
  set status = 'failed', finished_at = now(), next_try_at = null,
      detail = 'Not sent: messages to customers were paused when this came up.'
  where e.status = 'queued'
    and not private.booking_messages_paused(e.tenant_id)
    and private.booking_messages_paused_at(e.tenant_id, e.created_at);

  return query
    with due as (
      -- The reminder, at the lead time the workspace chose.
      (select b.id as booking_id, b.tenant_id, b.session_id, 'reminder'::text as kind,
              s.starts_at as at
       from public.bookings b
       join public.sessions s on s.id = b.session_id
       where b.status = 'confirmed' and b.reminder_sent_at is null and b.email_opt_in
         and not b.history_only
         and not private.booking_messages_paused(b.tenant_id)
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
         and not private.booking_messages_paused(b.tenant_id)
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
         and not private.booking_messages_paused(b.tenant_id)
         and b.customer_email <> ''
         and b.attendance is distinct from 'no_show'
         and s.cancelled_at is null
         and private.booking_email_switch(b.tenant_id, 'followup_on', false)
         and s.ends_at <= now() - make_interval(
           hours => private.booking_email_setting(b.tenant_id, 'followup_hours', 24))
         -- Never reach back further than two weeks, e.g. when first switched on.
         and s.ends_at > now() - interval '15 days'
         -- Not one that fell due while messages were paused.
         and not private.booking_messages_paused_at(b.tenant_id, s.ends_at + make_interval(
           hours => private.booking_email_setting(b.tenant_id, 'followup_hours', 24)))
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
        and not private.booking_messages_paused(e2.tenant_id)
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

  -- Set off while messages were paused: never sent late, written down as held.
  update public.booking_texts t
  set status = 'failed', finished_at = now(), next_try_at = null,
      detail = 'Not sent: messages to customers were paused when this came up.'
  where t.status = 'queued'
    and not private.booking_messages_paused(t.tenant_id)
    and private.booking_messages_paused_at(t.tenant_id, t.created_at);

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
         and not private.booking_messages_paused(b.tenant_id)
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
         and not private.booking_messages_paused(b.tenant_id)
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
         and not private.booking_messages_paused(b.tenant_id)
         and b.attendance is distinct from 'no_show'
         and s.cancelled_at is null
         and private.booking_text_on(b.tenant_id, 'followup')
         and s.ends_at <= now() - make_interval(
           hours => private.booking_text_hours(b.tenant_id, 'followup_hours', 24))
         and s.ends_at > now() - interval '15 days'
         -- Not one that fell due while messages were paused.
         and not private.booking_messages_paused_at(b.tenant_id, s.ends_at + make_interval(
           hours => private.booking_text_hours(b.tenant_id, 'followup_hours', 24)))
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
        and not private.booking_messages_paused(t2.tenant_id)
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
