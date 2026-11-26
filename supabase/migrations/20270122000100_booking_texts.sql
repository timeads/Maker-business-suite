-- Bookings: text reminders, through the business's own Twilio account.
--
--   * A `twilio` connection: the business pastes its Account SID, auth token
--     and sending number; the token lives in Vault like every other one.
--   * Texts follow the once-only pattern of booking emails, in a table of
--     their own (`booking_texts`): one row per booking, message and date,
--     claimed by one worker, tried once, written down. A clear refusal is
--     tried again a bounded number of times; a send we never heard back
--     about is "unsure" and never sent again by itself. Nothing is stamped
--     before it is sent.
--   * Only to a booking whose person ticked the box (`text_opt_in`) and gave
--     a number, and only for the messages the workspace switched on
--     (config `bookings` / `texts`, all off by default).
--   * Replies of STOP reach us through Twilio's webhook, are queued here and
--     taken off by the worker: the person's bookings in that workspace stop
--     getting texts (`text_opt_in` cleared), and the number is noted
--     (`booking_text_opt_outs`) so nothing from before is texted again.
--   * "Send me a test text" is limited per person and per workspace.

alter table public.connections drop constraint connections_provider_check;
alter table public.connections add constraint connections_provider_check
  check (provider in ('shopify', 'quickbooks', 'meta', 'google', 'stripe', 'easypost', 'ups',
                      'redo', 'google_mail', 'michaels', 'twilio'));

-- ---------------------------------------------------------------------------
-- Settings, as the database reads them
-- ---------------------------------------------------------------------------

-- Whether a message goes as a text for this workspace: texts are switched
-- on, this message is switched on, and Twilio is connected.
create function private.booking_text_on(p_tenant_id uuid, p_kind text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.configs c
    where c.tenant_id = p_tenant_id and c.module = 'bookings' and c.key = 'texts'
      and c.body -> 'on' = 'true'::jsonb
      and c.body -> 'messages' -> p_kind -> 'on' = 'true'::jsonb)
  and exists (
    select 1 from public.connections cn
    where cn.tenant_id = p_tenant_id and cn.provider = 'twilio' and cn.status = 'active');
$$;
revoke all on function private.booking_text_on(uuid, text) from public;

-- An hour count from the texts config, kept between 1 and 336.
create function private.booking_text_hours(p_tenant_id uuid, p_name text, p_default int)
returns int
language sql stable security definer set search_path = ''
as $$
  select greatest(1, least(336, coalesce((
    select case when jsonb_typeof(c.body -> p_name) = 'number'
                then (c.body ->> p_name)::numeric::int end
    from public.configs c
    where c.tenant_id = p_tenant_id and c.module = 'bookings' and c.key = 'texts'), p_default)));
$$;
revoke all on function private.booking_text_hours(uuid, text, int) from public;

create function private.booking_text_max_tries()
returns int language sql immutable set search_path = '' as $$ select 3 $$;
revoke all on function private.booking_text_max_tries() from public;

-- ---------------------------------------------------------------------------
-- The record of every text
-- ---------------------------------------------------------------------------

create table public.booking_texts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  booking_id uuid not null references public.bookings (id) on delete cascade,
  -- The date the text is about: a booking moved to another date is reminded
  -- again for the new one.
  session_id uuid not null references public.sessions (id) on delete cascade,
  kind text not null
    check (kind in ('confirmation', 'reminder', 'day_of', 'followup', 'cancelled', 'moved')),
  status text not null check (status in ('queued', 'sending', 'sent', 'failed', 'unsure')),
  tries int not null default 0 check (tries between 0 and 10),
  -- Our words, or Twilio's, for what went wrong; never the text itself.
  detail text not null default '' check (char_length(detail) <= 300),
  -- Twilio's id for the message once it took it.
  provider_id text check (provider_id is null or provider_id ~ '^(SM|MM)[0-9a-f]{32}$'),
  next_try_at timestamptz,
  claimed_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  -- The same message for the same booking and date never goes twice.
  unique (booking_id, kind, session_id)
);
create index booking_texts_session_idx on public.booking_texts (session_id);
create index booking_texts_tenant_idx on public.booking_texts (tenant_id, created_at desc);
create index booking_texts_open_idx on public.booking_texts (status, next_try_at)
  where status in ('queued', 'sending', 'failed');

alter table public.booking_texts enable row level security;
revoke all on public.booking_texts from anon, authenticated;
grant select on public.booking_texts to authenticated;
create policy booking_texts_select on public.booking_texts
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));

-- Numbers that replied STOP to a workspace's Twilio number.
create table public.booking_text_opt_outs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  phone text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  opted_out_at timestamptz not null default now(),
  unique (tenant_id, phone)
);
alter table public.booking_text_opt_outs enable row level security;
revoke all on public.booking_text_opt_outs from anon, authenticated;
grant select on public.booking_text_opt_outs to authenticated;
create policy booking_text_opt_outs_select on public.booking_text_opt_outs
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));

-- What Twilio told us, waiting for the worker. Only what the opt-out needs:
-- who wrote, to which number, and what kind of word it was. The words of a
-- message are never kept.
create table private.twilio_inbound (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  message_sid text not null check (message_sid ~ '^(SM|MM)[0-9a-f]{32}$'),
  from_phone text not null check (from_phone ~ '^\+[1-9][0-9]{7,14}$'),
  to_phone text not null default '' check (char_length(to_phone) <= 40),
  -- stop: a word that means "no more texts". Only these are queued.
  word text not null check (word in ('stop')),
  received_at timestamptz not null default now(),
  claimed_at timestamptz,
  done_at timestamptz,
  -- Twilio may deliver the same message more than once.
  unique (tenant_id, message_sid)
);
create index twilio_inbound_open_idx on private.twilio_inbound (received_at) where done_at is null;
revoke all on private.twilio_inbound from public, anon, authenticated;

-- One row per test text, for the limit.
create table private.booking_text_tests (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  sent_at timestamptz not null default now()
);
create index booking_text_tests_idx on private.booking_text_tests (tenant_id, sent_at);
revoke all on private.booking_text_tests from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Consent, as it arrives with a booking
-- ---------------------------------------------------------------------------

-- The number and the tick from the picker or our own booking page, put on
-- the booking that was just made. Called by the server with the service
-- role; a booking of another workspace is never touched.
create function public.set_booking_text_consent(
  p_tenant_id uuid, p_booking_id uuid, p_phone text, p_opt_in boolean
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_phone text := left(btrim(coalesce(p_phone, '')), 40);
begin
  if v_phone = '' then
    return false;
  end if;
  update public.bookings b
  set customer_phone = v_phone,
      text_opt_in = coalesce(p_opt_in, false)
  where b.id = p_booking_id and b.tenant_id = p_tenant_id;
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- Queueing, claiming and finishing
-- ---------------------------------------------------------------------------

-- A text that something happening sets off (a booking made, cancelled by a
-- shop refund, moved to another date), queued for the worker. Only where the
-- workspace wants that text and the person asked for texts. Returns queued,
-- already, off or skipped.
create function public.queue_booking_text(p_tenant_id uuid, p_booking_id uuid, p_kind text)
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
  if not found or not v_booking.text_opt_in or btrim(v_booking.customer_phone) = '' then
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

-- Hands the worker the texts to send now, each claimed for it alone.
--   1. A claim nobody finished in 15 minutes becomes "unsure": it may have
--      gone, so it is never sent again by itself.
--   2. Texts newly due from each workspace's own timing: the reminder, the
--      day-of reminder and the thank-you.
--   3. Texts queued by something that happened, and failed ones whose next
--      try has come, while they still make sense.
create function public.claim_booking_text_sends(p_limit int default 50)
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
        and b.text_opt_in and btrim(b.customer_phone) <> ''
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

-- Writes down how a claimed text went.
--   sent     Twilio took it (its id is kept).
--   refused  Twilio said no; tried again later while tries remain.
--   rejected Twilio said no for good (a number that can't take texts, or one
--            that replied STOP), or we wouldn't send it; never tried again.
--   unsure   we asked and never heard back; never sent again by itself.
create function public.finish_booking_text_send(
  p_send_id uuid, p_outcome text, p_detail text default '', p_provider_id text default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.booking_texts;
  v_again boolean;
begin
  if p_outcome is null or p_outcome not in ('sent', 'refused', 'rejected', 'unsure') then
    raise exception 'Unknown outcome' using errcode = '22023';
  end if;
  select * into v_row from public.booking_texts t where t.id = p_send_id for update;
  if not found then
    raise exception 'Text not found' using errcode = 'P0002';
  end if;
  if v_row.status <> 'sending' then
    return jsonb_build_object('status', v_row.status, 'final', true, 'changed', false);
  end if;

  if p_outcome = 'sent' then
    update public.booking_texts t
    set status = 'sent', finished_at = now(), next_try_at = null, detail = '',
        provider_id = case when p_provider_id ~ '^(SM|MM)[0-9a-f]{32}$' then p_provider_id end
    where t.id = v_row.id;
    return jsonb_build_object('status', 'sent', 'final', true, 'changed', true);
  end if;

  if p_outcome = 'unsure' then
    update public.booking_texts t
    set status = 'unsure', finished_at = now(), next_try_at = null,
        detail = left(coalesce(nullif(btrim(p_detail), ''), 'We never heard whether this one went.'), 300)
    where t.id = v_row.id;
    return jsonb_build_object('status', 'unsure', 'final', true, 'changed', true);
  end if;

  v_again := p_outcome = 'refused' and v_row.tries < private.booking_text_max_tries();
  update public.booking_texts t
  set status = 'failed', finished_at = now(),
      next_try_at = case when v_again then now() + make_interval(mins => 15 * v_row.tries) end,
      detail = left(coalesce(nullif(btrim(p_detail), ''), 'The text was refused.'), 300)
  where t.id = v_row.id;
  return jsonb_build_object('status', 'failed', 'final', not v_again, 'changed', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- STOP
-- ---------------------------------------------------------------------------

-- The workspace a Twilio account belongs to, so the webhook can check the
-- signature with that workspace's own auth token. One live connection per
-- account (`connections_one_live_per_account`).
create function public.twilio_workspace_for(p_account_sid text)
returns uuid
language sql stable security definer set search_path = ''
as $$
  select c.tenant_id from public.connections c
  where c.provider = 'twilio' and c.status = 'active'
    and c.external_account_id = p_account_sid
  limit 1;
$$;

-- A signed STOP from Twilio, queued for the worker. The same message twice
-- is kept once.
create function public.enqueue_twilio_inbound(
  p_tenant_id uuid, p_message_sid text, p_from text, p_to text
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into private.twilio_inbound (tenant_id, message_sid, from_phone, to_phone, word)
  values (p_tenant_id, p_message_sid, p_from, left(coalesce(p_to, ''), 40), 'stop')
  on conflict (tenant_id, message_sid) do nothing
  returning id into v_id;
  return v_id is not null;
end;
$$;

-- STOPs to take off. One not finished in 15 minutes is handed out again:
-- taking someone off twice changes nothing.
create function public.claim_twilio_inbound(p_limit int default 50)
returns table (id uuid, tenant_id uuid, from_phone text)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
    update private.twilio_inbound i
    set claimed_at = now()
    where i.id in (
      select i2.id from private.twilio_inbound i2
      where i2.done_at is null
        and (i2.claimed_at is null or i2.claimed_at < now() - interval '15 minutes')
      order by i2.received_at
      limit greatest(1, least(coalesce(p_limit, 50), 200))
      for update skip locked)
    returning i.id, i.tenant_id, i.from_phone;
end;
$$;

-- Takes a number off: the bookings the worker matched to it (in this
-- workspace only) stop getting texts, and the number is noted so a text
-- already waiting isn't sent. Safe to repeat. Returns how many bookings.
create function public.apply_text_opt_out(p_inbound_id uuid, p_booking_ids uuid[])
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_in private.twilio_inbound;
  v_count int;
begin
  select * into v_in from private.twilio_inbound i where i.id = p_inbound_id for update;
  if not found then
    raise exception 'Not found' using errcode = 'P0002';
  end if;
  insert into public.booking_text_opt_outs (tenant_id, phone, opted_out_at)
  values (v_in.tenant_id, v_in.from_phone, v_in.received_at)
  on conflict (tenant_id, phone)
    do update set opted_out_at = greatest(public.booking_text_opt_outs.opted_out_at,
                                          excluded.opted_out_at);
  update public.bookings b set text_opt_in = false
  where b.tenant_id = v_in.tenant_id and b.id = any (coalesce(p_booking_ids, '{}'))
    and b.text_opt_in;
  get diagnostics v_count = row_count;
  update private.twilio_inbound i set done_at = now() where i.id = v_in.id;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- A test text, a few at a time
-- ---------------------------------------------------------------------------

-- An owner or admin may send three test texts an hour, and a workspace ten
-- a day. Writes down the one about to go and says whether it may.
create function public.claim_test_text(p_tenant_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  perform private.require_manager(p_tenant_id);
  -- One at a time per workspace, so two presses can't both slip under the limit.
  perform 1 from public.tenants t where t.id = p_tenant_id for update;
  if (select count(*) from private.booking_text_tests t
      where t.tenant_id = p_tenant_id and t.user_id = v_user
        and t.sent_at > now() - interval '1 hour') >= 3
     or (select count(*) from private.booking_text_tests t
         where t.tenant_id = p_tenant_id and t.sent_at > now() - interval '1 day') >= 10 then
    return false;
  end if;
  insert into private.booking_text_tests (tenant_id, user_id) values (p_tenant_id, v_user);
  return true;
end;
$$;
revoke all on function public.claim_test_text(uuid) from public, anon;
grant execute on function public.claim_test_text(uuid) to authenticated;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.set_booking_text_consent(uuid, uuid, text, boolean)',
    'public.queue_booking_text(uuid, uuid, text)',
    'public.claim_booking_text_sends(int)',
    'public.finish_booking_text_send(uuid, text, text, text)',
    'public.twilio_workspace_for(text)',
    'public.enqueue_twilio_inbound(uuid, text, text, text)',
    'public.claim_twilio_inbound(int)',
    'public.apply_text_opt_out(uuid, uuid[])'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
