-- Social: the monthly run.
--
-- Each brand can have a review day in the content plan (config social / plan,
-- `review_days`: the nth weekday of the month, how many days ahead of it the
-- drafts are written, and whether the run happens by itself; off unless an
-- owner or admin switches it on). The month a run drafts runs from one review
-- day to the day before the next, on the workspace's clock.
--
-- The once-only pattern used elsewhere: `claim_social_month_runs` queues a
-- run for each workspace + brand + month that is due (once: a month that has
-- any run, finished or failed, is never queued again by itself), hands each
-- queued run to one worker, and marks one that never finished as failed
-- rather than running it again. An owner or admin's "Run it now"
-- (`request_social_month_run`) goes through the same table and the same
-- unique index, so it can't double a run that is queued, running or done.
--
-- What a run writes goes through `file_social_month_draft`, the ONLY writer
-- of its drafts: always a draft (never scheduled, never posted), waiting for
-- review where the workspace requires approval, else a plain draft. Approval
-- and scheduling stay a person's press (CLAUDE.md rule 6).

create table public.social_month_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  brand_id uuid not null references public.brands (id) on delete cascade,
  -- The month drafted: from the review day to the day before the next one.
  window_start date not null,
  window_end date not null check (window_end >= window_start),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  -- schedule: by itself on the review day's lead time. manual: "Run it now".
  source text not null default 'schedule' check (source in ('schedule', 'manual')),
  requested_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  -- {"drafted", "projects", "topics", "empty", "failed", "stopped"}
  counts jsonb not null default '{}'::jsonb check (jsonb_typeof(counts) = 'object'),
  error text check (error is null or char_length(error) <= 500)
);
-- Once per workspace + brand + month. A failed run doesn't hold the month, so
-- a person can press "Run it now" again; the schedule never re-queues it.
create unique index social_month_runs_once
  on public.social_month_runs (tenant_id, brand_id, window_start) where status <> 'failed';
create index social_month_runs_tenant_idx
  on public.social_month_runs (tenant_id, created_at desc);

alter table public.social_month_runs enable row level security;
create policy "members read their social month runs" on public.social_month_runs
  for select to authenticated using (tenant_id in (select private.user_tenant_ids()));
revoke all on public.social_month_runs from public, anon, authenticated, service_role;
grant select on public.social_month_runs to authenticated, service_role;

-- Which run drafted a post, so its drafts can be counted and found.
alter table public.social_posts
  add column month_run_id uuid references public.social_month_runs (id) on delete set null;
create index social_posts_month_run_idx on public.social_posts (month_run_id)
  where month_run_id is not null;

-- ---------------------------------------------------------------------------
-- Review days, worked out on the workspace's calendar (twin of
-- lib/social/month.ts; tests/db/social-month-run.test.ts keeps them equal)
-- ---------------------------------------------------------------------------

-- The nth (1 to 4) weekday (0 is Sunday) of the month `p_month` falls in.
create function private.social_nth_weekday(p_month date, p_week int, p_weekday int)
returns date
language sql immutable set search_path = ''
as $$
  select (date_trunc('month', p_month)::date
          + ((p_weekday - extract(dow from date_trunc('month', p_month))::int + 7) % 7)
          + (p_week - 1) * 7)::date;
$$;
revoke all on function private.social_nth_weekday(date, int, int) from public;

-- The review day on or after `p_today`.
create function private.social_coming_review_day(p_today date, p_week int, p_weekday int)
returns date
language sql immutable set search_path = ''
as $$
  select case
    when private.social_nth_weekday(p_today, p_week, p_weekday) >= p_today
      then private.social_nth_weekday(p_today, p_week, p_weekday)
    else private.social_nth_weekday((date_trunc('month', p_today) + interval '1 month')::date,
                                    p_week, p_weekday)
  end;
$$;
revoke all on function private.social_coming_review_day(date, int, int) from public;

-- The last day of the month that starts on review day `p_start`.
create function private.social_month_end(p_start date, p_week int, p_weekday int)
returns date
language sql immutable set search_path = ''
as $$
  select private.social_nth_weekday((date_trunc('month', p_start) + interval '1 month')::date,
                                    p_week, p_weekday) - 1;
$$;
revoke all on function private.social_month_end(date, int, int) from public;

-- The month a run made today would draft by itself: the coming review day,
-- once it is `p_lead` days away or nearer; null before then.
create function private.social_month_due(p_today date, p_week int, p_weekday int, p_lead int)
returns date
language sql immutable set search_path = ''
as $$
  select case
    when private.social_coming_review_day(p_today, p_week, p_weekday) - p_today <= greatest(p_lead, 0)
      then private.social_coming_review_day(p_today, p_week, p_weekday)
  end;
$$;
revoke all on function private.social_month_due(date, int, int, int) from public;

-- Every review day the plans hold, one row per entry that reads cleanly, with
-- the brand it is for (the main brand when the entry names none) and the
-- workspace's time zone. Anything malformed is left out, never guessed.
create function private.social_review_day_rows()
returns table (tenant_id uuid, brand_id uuid, week int, weekday int, lead_days int, auto boolean, tz text)
language sql stable security definer set search_path = ''
as $$
  select c.tenant_id,
         coalesce(
           (select b.id from public.brands b
            where b.tenant_id = c.tenant_id and b.archived_at is null
              and b.id::text = e ->> 'brand_id'),
           case when coalesce(e ->> 'brand_id', '') = '' then
             (select b.id from public.brands b
              where b.tenant_id = c.tenant_id and b.is_default and b.archived_at is null limit 1)
           end) as brand_id,
         (e ->> 'week')::int, (e ->> 'weekday')::int,
         coalesce((e ->> 'lead_days')::int, 0),
         coalesce(e -> 'auto' = 'true'::jsonb, false),
         t.timezone
  from public.configs c
  join public.tenants t on t.id = c.tenant_id
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(c.body -> 'review_days') = 'array' then c.body -> 'review_days'
         else '[]'::jsonb end) as e
  where c.module = 'social' and c.key = 'plan'
    and jsonb_typeof(e) = 'object'
    and coalesce(e ->> 'week', '') ~ '^[1-4]$'
    and coalesce(e ->> 'weekday', '') ~ '^[0-6]$'
    and coalesce(e ->> 'lead_days', '0') ~ '^([0-9]|1[0-9]|2[0-1])$';
$$;
revoke all on function private.social_review_day_rows() from public;

-- ---------------------------------------------------------------------------
-- "Run it now": an owner or admin, for one brand's coming month
-- ---------------------------------------------------------------------------

create function public.request_social_month_run(p_tenant_id uuid, p_brand_id uuid default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_brand uuid;
  v_day record;
  v_today date;
  v_start date;
  v_id uuid;
  v_status text;
begin
  perform private.require_manager(p_tenant_id);
  select b.id into v_brand from public.brands b
  where b.tenant_id = p_tenant_id and b.archived_at is null
    and (b.id = p_brand_id or (p_brand_id is null and b.is_default))
  limit 1;
  if v_brand is null then
    raise exception 'Brand not found' using errcode = 'P0002';
  end if;
  select * into v_day from private.social_review_day_rows() d
  where d.tenant_id = p_tenant_id and d.brand_id = v_brand
  limit 1;
  if not found then
    raise exception 'no_review_day' using errcode = 'P0001';
  end if;
  v_today := (now() at time zone v_day.tz)::date;
  v_start := private.social_coming_review_day(v_today, v_day.week, v_day.weekday);

  select r.id, r.status into v_id, v_status from public.social_month_runs r
  where r.tenant_id = p_tenant_id and r.brand_id = v_brand and r.window_start = v_start
    and r.status <> 'failed';
  if v_status = 'done' then
    raise exception 'already_drafted' using errcode = 'P0001';
  elsif v_id is not null then
    return v_id;
  end if;
  if exists (
    select 1 from public.social_month_runs r
    where r.tenant_id = p_tenant_id and r.source = 'manual'
      and r.created_at > now() - interval '10 minutes'
  ) then
    raise exception 'too_soon' using errcode = 'P0001';
  end if;
  begin
    insert into public.social_month_runs
      (tenant_id, brand_id, window_start, window_end, source, requested_by)
    values
      (p_tenant_id, v_brand, v_start,
       private.social_month_end(v_start, v_day.week, v_day.weekday), 'manual', auth.uid())
    returning id into v_id;
  exception when unique_violation then
    select r.id into v_id from public.social_month_runs r
    where r.tenant_id = p_tenant_id and r.brand_id = v_brand and r.window_start = v_start
      and r.status <> 'failed';
  end;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- What the worker does
-- ---------------------------------------------------------------------------

create function public.claim_social_month_runs(p_limit int default 2)
returns table (id uuid, tenant_id uuid, brand_id uuid, window_start date, window_end date, source text)
language plpgsql security definer set search_path = ''
as $$
begin
  update public.social_month_runs r
  set status = 'failed', finished_at = now(), error = 'This run never finished.'
  where r.status = 'running' and r.started_at < now() - interval '45 minutes';

  -- By itself: each brand whose review day is switched on, once its lead time
  -- has begun, once per month.
  insert into public.social_month_runs (tenant_id, brand_id, window_start, window_end, source)
  select d.tenant_id, d.brand_id, d.due,
         private.social_month_end(d.due, d.week, d.weekday), 'schedule'
  from (
    select rd.*, private.social_month_due((now() at time zone rd.tz)::date,
                                          rd.week, rd.weekday, rd.lead_days) as due
    from private.social_review_day_rows() rd
    where rd.auto and rd.brand_id is not null
  ) d
  where d.due is not null
    and not exists (
      select 1 from public.social_month_runs r
      where r.tenant_id = d.tenant_id and r.brand_id = d.brand_id and r.window_start = d.due)
  on conflict do nothing;

  return query
  with due as (
    select r.id from public.social_month_runs r
    where r.status = 'queued'
    order by r.created_at
    limit greatest(1, least(coalesce(p_limit, 2), 10))
    for update skip locked
  )
  update public.social_month_runs r set status = 'running', started_at = now()
  from due where r.id = due.id
  returning r.id, r.tenant_id, r.brand_id, r.window_start, r.window_end, r.source;
end;
$$;

create function public.finish_social_month_run(
  p_id uuid, p_status text, p_counts jsonb, p_error text default null)
returns void
language sql security definer set search_path = ''
as $$
  update public.social_month_runs r
  set status = case when p_status = 'done' then 'done' else 'failed' end,
      finished_at = now(), counts = coalesce(p_counts, '{}'::jsonb), error = left(p_error, 500)
  where r.id = p_id and r.status = 'running';
$$;

-- The ONLY way a run's draft is saved. `p_draft` is what the code decided
-- (lib/social/month.ts, `planMonth`):
--   {"kind": "project" | "topic", "planned_for", "caption", "asset_ids",
--    "project_id", "topic"}
-- Everything is checked again here. A time the brand already has a post for,
-- or (for a project) a photo already on a post, is skipped: returns null.
-- The post is a draft with the places the brand has accounts for; nothing
-- here schedules or posts it.
create function public.file_social_month_draft(p_run_id uuid, p_draft jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_run public.social_month_runs;
  v_tz text;
  v_at timestamptz;
  v_day date;
  v_caption text := btrim(coalesce(p_draft ->> 'caption', ''));
  v_topic text := nullif(btrim(coalesce(p_draft ->> 'topic', '')), '');
  v_project uuid;
  v_assets uuid[];
  v_channels text[] := '{}';
  v_waiting boolean;
  v_id uuid;
begin
  select * into v_run from public.social_month_runs r where r.id = p_run_id for update;
  if not found or v_run.status <> 'running' then
    raise exception 'run_not_running' using errcode = 'P0001';
  end if;
  select t.timezone into v_tz from public.tenants t where t.id = v_run.tenant_id;

  if coalesce(p_draft ->> 'planned_for', '') = '' then
    raise exception 'bad_time' using errcode = '22023';
  end if;
  v_at := (p_draft ->> 'planned_for')::timestamptz;
  v_day := (v_at at time zone v_tz)::date;
  if v_at <= now() or v_day < v_run.window_start or v_day > v_run.window_end then
    raise exception 'bad_time' using errcode = '22023';
  end if;
  if v_caption = '' or char_length(v_caption) > 2200 then
    raise exception 'bad_caption' using errcode = '22023';
  end if;
  if v_topic is not null and char_length(v_topic) > 40 then
    raise exception 'bad_topic' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_draft -> 'asset_ids', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_draft -> 'asset_ids', '[]'::jsonb)) > 10 then
    raise exception 'too_many_photos' using errcode = 'P0001';
  end if;
  v_assets := array(
    select x::uuid from jsonb_array_elements_text(coalesce(p_draft -> 'asset_ids', '[]'::jsonb))
      with ordinality as a(x, n)
    group by x order by min(n));
  if exists (
    select 1 from unnest(v_assets) x
    where not exists (
      select 1 from public.social_assets a
      where a.id = x and a.tenant_id = v_run.tenant_id and not a.hidden
        and a.mime_type like 'image/%')
  ) then
    raise exception 'Photo not found' using errcode = 'P0002';
  end if;
  if coalesce(p_draft ->> 'project_id', '') <> '' then
    select p.id into v_project from public.social_projects p
    where p.id = (p_draft ->> 'project_id')::uuid and p.tenant_id = v_run.tenant_id
      and p.archived_at is null;
    if v_project is null then
      raise exception 'Project not found' using errcode = 'P0002';
    end if;
  end if;

  -- Something already lined up for the brand at that time: leave it be.
  if exists (
    select 1 from public.social_posts p
    where p.tenant_id = v_run.tenant_id and p.brand_id = v_run.brand_id
      and p.status <> 'failed' and coalesce(p.scheduled_for, p.planned_for) = v_at
  ) then
    return null;
  end if;
  -- A project's carousel is only ever made of photos no post has used.
  if p_draft ->> 'kind' = 'project' and exists (
    select 1 from public.social_posts p
    where p.tenant_id = v_run.tenant_id
      and (p.asset_ids && v_assets or p.asset_id = any (v_assets))
  ) then
    return null;
  end if;

  -- The places the brand has an account in use for; Instagram only with a photo.
  if exists (select 1 from public.social_accounts a
             where a.tenant_id = v_run.tenant_id and a.brand_id = v_run.brand_id
               and a.active and a.network = 'facebook') then
    v_channels := v_channels || 'facebook'::text;
  end if;
  if cardinality(v_assets) > 0 and exists (
    select 1 from public.social_accounts a
    where a.tenant_id = v_run.tenant_id and a.brand_id = v_run.brand_id
      and a.active and a.network = 'instagram') then
    v_channels := v_channels || 'instagram'::text;
  end if;

  v_waiting := private.social_requires_approval(v_run.tenant_id);
  insert into public.social_posts
    (tenant_id, brand_id, caption, ai_draft, asset_id, asset_ids, channels, status,
     planned_for, project_id, topic, month_run_id, review, submitted_at)
  values
    (v_run.tenant_id, v_run.brand_id, v_caption, v_caption, v_assets[1], v_assets, v_channels,
     'draft', v_at, v_project, v_topic, v_run.id,
     case when v_waiting then 'waiting' end, case when v_waiting then now() end)
  returning id into v_id;
  return v_id;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.claim_social_month_runs(int)',
    'public.finish_social_month_run(uuid, text, jsonb, text)',
    'public.file_social_month_draft(uuid, jsonb)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
  execute 'revoke all on function public.request_social_month_run(uuid, uuid) from public, anon';
  execute 'grant execute on function public.request_social_month_run(uuid, uuid) to authenticated';
end;
$$;
