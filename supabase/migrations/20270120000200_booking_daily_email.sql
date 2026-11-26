-- The owner's daily email: once a day, at a local hour the workspace chose,
-- a short note to the members an owner or admin picked: today's and
-- tomorrow's classes and how full they are, the bookings made since the last
-- one, and anything that needs a person (over its limit, a shop order with no
-- date). Off unless switched on (config bookings / daily_email).
--
-- It follows the suite's once-only pattern: the database decides what is due
-- and hands each (workspace, person, day) out once; the worker tries it and
-- writes down how it went. A refusal is tried again a couple of times that
-- same day; one we never heard back about is "unsure" and never sent again.
-- The day is the workspace's own calendar day, so it goes once a day whatever
-- the clocks do.

create table public.booking_daily_emails (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The workspace's own calendar day the email is for.
  day date not null,
  status text not null check (status in ('sending', 'sent', 'failed', 'unsure', 'skipped')),
  tries int not null default 1 check (tries between 1 and 10),
  -- Our own short words for what went wrong; never the email's text.
  detail text not null default '' check (char_length(detail) <= 300),
  next_try_at timestamptz,
  claimed_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id, day)
);
create index booking_daily_emails_open_idx on public.booking_daily_emails (status, next_try_at)
  where status in ('sending', 'failed');

alter table public.booking_daily_emails enable row level security;
revoke all on public.booking_daily_emails from anon, authenticated;
grant select on public.booking_daily_emails to authenticated;
create policy booking_daily_emails_select on public.booking_daily_emails
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));

-- Hands the worker the daily emails to send now, each claimed for it alone.
--   1. A claim nobody finished in 15 minutes becomes "unsure".
--   2. For every workspace that switched it on and whose clocks have reached
--      the chosen hour today, one per chosen person who is still a member
--      and has an address, unless that day's is already recorded.
--   3. Failed ones whose next try has come, while it is still that day.
-- `p_now` is for tests; the worker leaves it to the database's clock.
create function public.claim_booking_daily_emails(
  p_now timestamptz default null, p_limit int default 50
)
returns table (send_id uuid, tenant_id uuid, user_id uuid, email text, day date, tries int)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_now timestamptz := coalesce(p_now, now());
  v_limit int := greatest(1, least(coalesce(p_limit, 50), 200));
begin
  update public.booking_daily_emails e
  set status = 'unsure', finished_at = v_now, next_try_at = null,
      detail = 'We never heard whether this one went.'
  where e.status = 'sending' and e.claimed_at < v_now - interval '15 minutes';

  return query
    with settings as (
      select c.tenant_id, t.timezone,
             (c.body ->> 'hour')::int as hour,
             case when jsonb_typeof(c.body -> 'recipients') = 'array'
                  then c.body -> 'recipients' else '[]'::jsonb end as recipients
      from public.configs c
      join public.tenants t on t.id = c.tenant_id
      where c.module = 'bookings' and c.key = 'daily_email'
        and jsonb_typeof(c.body -> 'on') = 'boolean' and (c.body ->> 'on')::boolean
        and jsonb_typeof(c.body -> 'hour') = 'number'
        and (c.body ->> 'hour') ~ '^([0-9]|1[0-9]|2[0-3])$'
    ),
    due as (
      select distinct s.tenant_id, m.user_id, u.email::text as email,
             (v_now at time zone s.timezone)::date as day
      from settings s
      cross join lateral jsonb_array_elements_text(s.recipients) r(id)
      join public.memberships m on m.tenant_id = s.tenant_id and m.user_id::text = r.id
      join auth.users u on u.id = m.user_id and u.email is not null and u.email <> ''
      where extract(hour from (v_now at time zone s.timezone)) >= s.hour
    ),
    fresh as (
      insert into public.booking_daily_emails
        (tenant_id, user_id, day, status, tries, claimed_at)
      select d.tenant_id, d.user_id, d.day, 'sending', 1, v_now
      from due d
      where not exists (
        select 1 from public.booking_daily_emails e
        where e.tenant_id = d.tenant_id and e.user_id = d.user_id and e.day = d.day)
      limit v_limit
      on conflict (tenant_id, user_id, day) do nothing
      returning id, booking_daily_emails.tenant_id, booking_daily_emails.user_id,
                booking_daily_emails.day, booking_daily_emails.tries
    )
    select f.id, f.tenant_id, f.user_id, d.email, f.day, f.tries
    from fresh f
    join due d on d.tenant_id = f.tenant_id and d.user_id = f.user_id;

  return query
    with again as (
      update public.booking_daily_emails e
      set status = 'sending', tries = e.tries + 1, claimed_at = v_now, next_try_at = null
      where e.id in (
        select e2.id
        from public.booking_daily_emails e2
        join public.tenants t on t.id = e2.tenant_id
        where e2.status = 'failed' and e2.next_try_at is not null and e2.next_try_at <= v_now
          and e2.tries < 3
          and e2.day = (v_now at time zone t.timezone)::date
          -- Still chosen, still a member, still switched on.
          and exists (
            select 1 from public.configs c
            join public.memberships m on m.tenant_id = c.tenant_id and m.user_id = e2.user_id
            where c.tenant_id = e2.tenant_id and c.module = 'bookings' and c.key = 'daily_email'
              and jsonb_typeof(c.body -> 'on') = 'boolean' and (c.body ->> 'on')::boolean
              and jsonb_typeof(c.body -> 'recipients') = 'array'
              and (c.body -> 'recipients') ? e2.user_id::text)
        order by e2.created_at
        limit v_limit
        for update of e2 skip locked)
      returning e.id, e.tenant_id, e.user_id, e.day, e.tries
    )
    select a.id, a.tenant_id, a.user_id, u.email::text, a.day, a.tries
    from again a
    join auth.users u on u.id = a.user_id;
end;
$$;

-- Writes down how a claimed daily email went: sent, refused (tried again
-- later that day while tries remain), rejected (not again), unsure (never
-- again) or skipped (nothing to send it for: bookings no longer on the plan).
create function public.finish_booking_daily_email(
  p_send_id uuid, p_outcome text, p_detail text default ''
)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.booking_daily_emails;
  v_again boolean;
begin
  if p_outcome not in ('sent', 'refused', 'rejected', 'unsure', 'skipped') then
    raise exception 'Unknown outcome' using errcode = '22023';
  end if;
  select * into v_row from public.booking_daily_emails e where e.id = p_send_id for update;
  if not found then
    raise exception 'Email not found' using errcode = 'P0002';
  end if;
  if v_row.status <> 'sending' then
    return v_row.status;
  end if;
  if p_outcome in ('sent', 'unsure', 'skipped') then
    update public.booking_daily_emails e
    set status = p_outcome, finished_at = now(), next_try_at = null,
        detail = case when p_outcome = 'sent' then ''
                      else left(coalesce(nullif(btrim(p_detail), ''), 'Not sent.'), 300) end
    where e.id = v_row.id;
    return p_outcome;
  end if;
  v_again := p_outcome = 'refused' and v_row.tries < 3;
  update public.booking_daily_emails e
  set status = 'failed', finished_at = now(),
      next_try_at = case when v_again then now() + make_interval(mins => 20 * v_row.tries) end,
      detail = left(coalesce(nullif(btrim(p_detail), ''), 'The email was refused.'), 300)
  where e.id = v_row.id;
  return 'failed';
end;
$$;

revoke all on function public.claim_booking_daily_emails(timestamptz, int)
  from public, anon, authenticated;
grant execute on function public.claim_booking_daily_emails(timestamptz, int) to service_role;
revoke all on function public.finish_booking_daily_email(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.finish_booking_daily_email(uuid, text, text) to service_role;
