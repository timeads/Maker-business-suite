-- Booking emails that go out by themselves (the reminder, the day-of
-- reminder, the thank-you, the notice that a shop refund cancelled a booking)
-- now follow the once-only pattern the rest of the suite uses: claim, try,
-- write down what happened.
--
-- Before this, `claim_booking_emails` stamped a booking as reminded BEFORE the
-- email was tried, so one that the mail service refused was lost for good.
--
-- Now every send is a row here. A refusal is kept as failed and tried again a
-- bounded number of times; a send that never heard back is "unsure" and is
-- never sent again by itself. `bookings.reminder_sent_at` and
-- `followup_sent_at` are stamped only once the email really went.

create table public.booking_emails (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  booking_id uuid not null references public.bookings (id) on delete cascade,
  -- The date the email is about: a booking moved to another date is reminded
  -- again for the new one.
  session_id uuid not null references public.sessions (id) on delete cascade,
  kind text not null check (kind in ('reminder', 'day_of', 'followup', 'cancelled')),
  status text not null check (status in ('queued', 'sending', 'sent', 'failed', 'unsure')),
  tries int not null default 0 check (tries between 0 and 10),
  -- Our own short words for what went wrong; never the email's text.
  detail text not null default '' check (char_length(detail) <= 300),
  -- Set while a failed send still has a try left.
  next_try_at timestamptz,
  claimed_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (booking_id, kind, session_id)
);
create index booking_emails_session_idx on public.booking_emails (session_id);
create index booking_emails_open_idx on public.booking_emails (status, next_try_at)
  where status in ('queued', 'sending', 'failed');

alter table public.booking_emails enable row level security;
revoke all on public.booking_emails from anon, authenticated;
grant select on public.booking_emails to authenticated;
create policy booking_emails_select on public.booking_emails
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));

-- A yes/no setting from the workspace's bookings / emails config.
create function private.booking_email_switch(p_tenant_id uuid, p_name text, p_default boolean)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select case when jsonb_typeof(c.body -> p_name) = 'boolean'
                then (c.body ->> p_name)::boolean end
    from public.configs c
    where c.tenant_id = p_tenant_id and c.module = 'bookings' and c.key = 'emails'), p_default);
$$;
revoke all on function private.booking_email_switch(uuid, text, boolean) from public;

-- How many times one email is tried before it is left for a person.
create function private.booking_email_max_tries()
returns int language sql immutable set search_path = '' as $$ select 3 $$;
revoke all on function private.booking_email_max_tries() from public;

-- Hands the worker the emails to send now, each claimed for it alone.
--   1. A claim nobody finished in 15 minutes becomes "unsure": the worker
--      died somewhere between asking the mail service and writing it down,
--      so the email may have gone. It is never sent again by itself.
--   2. Emails newly due, from each workspace's own timing.
--   3. Emails queued by something that happened (a shop refund), and failed
--      ones whose next try has come, while the email still makes sense.
create function public.claim_booking_email_sends(p_limit int default 50)
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
        and b.email_opt_in and b.customer_email <> ''
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

-- Writes down how a claimed send went.
--   sent     it went; the booking is stamped.
--   refused  the mail service said no; tried again later while tries remain.
--   rejected the mail service said no for good (a dead address); not retried.
--   unsure   we asked and never heard back; never sent again by itself.
-- Returns the row's status and whether that is the end of it, so the worker
-- can tell the team about one that needs a person.
create function public.finish_booking_email_send(
  p_send_id uuid, p_outcome text, p_detail text default ''
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.booking_emails;
  v_again boolean;
begin
  if p_outcome not in ('sent', 'refused', 'rejected', 'unsure') then
    raise exception 'Unknown outcome' using errcode = '22023';
  end if;
  select * into v_row from public.booking_emails e where e.id = p_send_id for update;
  if not found then
    raise exception 'Email not found' using errcode = 'P0002';
  end if;
  -- Only a claimed send can be finished: a late answer never overwrites one
  -- already written down.
  if v_row.status <> 'sending' then
    return jsonb_build_object('status', v_row.status, 'final', true, 'changed', false);
  end if;

  if p_outcome = 'sent' then
    update public.booking_emails e
    set status = 'sent', finished_at = now(), next_try_at = null, detail = ''
    where e.id = v_row.id;
    if v_row.kind = 'reminder' then
      update public.bookings b set reminder_sent_at = now()
      where b.id = v_row.booking_id and b.session_id = v_row.session_id;
    elsif v_row.kind = 'followup' then
      update public.bookings b set followup_sent_at = now()
      where b.id = v_row.booking_id and b.session_id = v_row.session_id;
    end if;
    return jsonb_build_object('status', 'sent', 'final', true, 'changed', true);
  end if;

  if p_outcome = 'unsure' then
    update public.booking_emails e
    set status = 'unsure', finished_at = now(), next_try_at = null,
        detail = left(coalesce(nullif(btrim(p_detail), ''), 'We never heard whether this one went.'), 300)
    where e.id = v_row.id;
    return jsonb_build_object('status', 'unsure', 'final', true, 'changed', true);
  end if;

  v_again := p_outcome = 'refused' and v_row.tries < private.booking_email_max_tries();
  update public.booking_emails e
  set status = 'failed', finished_at = now(),
      -- A little longer each time: 15 minutes, then 30.
      next_try_at = case when v_again then now() + make_interval(mins => 15 * v_row.tries) end,
      detail = left(coalesce(nullif(btrim(p_detail), ''), 'The email was refused.'), 300)
  where e.id = v_row.id;
  return jsonb_build_object('status', 'failed', 'final', not v_again, 'changed', true);
end;
$$;

revoke all on function public.claim_booking_email_sends(int) from public, anon, authenticated;
grant execute on function public.claim_booking_email_sends(int) to service_role;
revoke all on function public.finish_booking_email_send(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.finish_booking_email_send(uuid, text, text) to service_role;

-- The two older claims stamped a booking before its email was tried. They
-- stay (nothing is dropped) but hand nothing out any more, so a worker from
-- before this change can't stamp a reminder that the new path then skips.
create or replace function public.claim_booking_emails(p_kind text, p_limit int default 50)
returns setof public.bookings
language plpgsql security definer set search_path = ''
as $$
begin
  if p_kind not in ('reminder', 'followup') then
    raise exception 'Unknown email kind' using errcode = '22023';
  end if;
  return;
end;
$$;

create or replace function public.claim_booking_reminders(p_limit int default 50)
returns setof public.bookings
language sql security definer set search_path = ''
as $$
  select b.* from public.bookings b where false;
$$;
