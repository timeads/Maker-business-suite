-- Social, second pass: a photo library with tags, projects that gather the
-- photos and posts of one piece of work, posts with several photos, and a
-- caption of its own for each channel when the same words don't suit both.

create table public.social_projects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  -- What it is and anything worth saying about it; Claude reads this when drafting.
  note text not null default '' check (char_length(note) <= 2000),
  topic text check (topic is null or char_length(topic) <= 40),
  archived_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index social_projects_tenant_idx on public.social_projects (tenant_id, created_at desc);
alter table public.social_projects enable row level security;
create policy "members read their social projects" on public.social_projects
  for select to authenticated using (tenant_id in (select private.user_tenant_ids()));
revoke all on public.social_projects from public, anon, authenticated, service_role;
grant select on public.social_projects to authenticated, service_role;

alter table public.social_assets
  add column title text not null default '' check (char_length(title) <= 120),
  add column tags text[] not null default '{}',
  add column project_id uuid references public.social_projects (id) on delete set null,
  -- Out of the library's way without breaking posts that used it.
  add column hidden boolean not null default false;
create index social_assets_project_idx on public.social_assets (project_id);

alter table public.social_posts
  -- Every photo on the post, in order. The first is also `asset_id`.
  add column asset_ids uuid[] not null default '{}' check (cardinality(asset_ids) <= 10),
  -- {"instagram": "..."}: a caption for one channel when it differs from `caption`.
  add column captions jsonb not null default '{}'::jsonb,
  add column project_id uuid references public.social_projects (id) on delete set null,
  add column topic text check (topic is null or char_length(topic) <= 40),
  -- When a draft is meant for. Only a note: nothing goes out until a person schedules it.
  add column planned_for timestamptz,
  -- What Claude first wrote, kept beside what was posted so the house voice can be learned.
  add column ai_draft text check (ai_draft is null or char_length(ai_draft) <= 2200);
create index social_posts_project_idx on public.social_posts (project_id);

-- ---------------------------------------------------------------------------
-- What members do
-- ---------------------------------------------------------------------------

create function public.save_social_project(
  p_tenant_id uuid, p_project_id uuid, p_name text, p_note text, p_topic text,
  p_archived boolean default false
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_member(p_tenant_id);
  if p_project_id is null then
    insert into public.social_projects (tenant_id, name, note, topic, created_by)
    values (p_tenant_id, btrim(p_name), left(btrim(coalesce(p_note, '')), 2000),
            nullif(btrim(coalesce(p_topic, '')), ''), auth.uid())
    returning id into v_id;
    return v_id;
  end if;
  update public.social_projects p
  set name = btrim(p_name), note = left(btrim(coalesce(p_note, '')), 2000),
      topic = nullif(btrim(coalesce(p_topic, '')), ''),
      archived_at = case when coalesce(p_archived, false) then coalesce(p.archived_at, now()) end
  where p.id = p_project_id and p.tenant_id = p_tenant_id
  returning p.id into v_id;
  if v_id is null then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;
  return v_id;
end;
$$;

create function private.tidy_tags(p_tags text[])
returns text[]
language sql immutable set search_path = ''
as $$
  select coalesce((
    select array_agg(distinct t) from (
      select lower(btrim(x)) as t from unnest(coalesce(p_tags, '{}')) as x
    ) cleaned where t ~ '^[a-z0-9][a-z0-9 _-]{0,29}$'), '{}');
$$;
revoke all on function private.tidy_tags(text[]) from public;

-- Names, tags, files a photo under a project, or tucks it away.
create function public.update_social_asset(
  p_asset_id uuid, p_title text, p_tags text[], p_project_id uuid, p_hidden boolean default false
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select a.tenant_id into v_tenant from public.social_assets a
  where a.id = p_asset_id and a.tenant_id in (select private.user_tenant_ids());
  if v_tenant is null then
    raise exception 'Photo not found' using errcode = 'P0002';
  end if;
  if p_project_id is not null and not exists (
    select 1 from public.social_projects p where p.id = p_project_id and p.tenant_id = v_tenant
  ) then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;
  update public.social_assets a
  set title = left(btrim(coalesce(p_title, '')), 120), tags = private.tidy_tags(p_tags),
      project_id = p_project_id, hidden = coalesce(p_hidden, false)
  where a.id = p_asset_id;
end;
$$;

-- Files several photos under a project (or none) and adds tags to them at once.
create function public.file_social_assets(
  p_tenant_id uuid, p_asset_ids uuid[], p_project_id uuid, p_add_tags text[] default '{}'
)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  perform private.require_member(p_tenant_id);
  if p_project_id is not null and not exists (
    select 1 from public.social_projects p where p.id = p_project_id and p.tenant_id = p_tenant_id
  ) then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;
  update public.social_assets a
  set project_id = p_project_id, tags = private.tidy_tags(a.tags || coalesce(p_add_tags, '{}'))
  where a.tenant_id = p_tenant_id and a.id = any (coalesce(p_asset_ids, '{}'));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Saves a whole post in one go: the words, up to ten photos in order, a
-- caption per channel where wanted, and what it belongs to. The rules about
-- what can be scheduled, and what can no longer be changed, are the ones in
-- save_social_post.
create function public.save_social_post_full(
  p_tenant_id uuid,
  p_post_id uuid,
  p_caption text,
  p_asset_ids uuid[],
  p_channels text[],
  p_scheduled_for timestamptz,
  p_captions jsonb default '{}'::jsonb,
  p_project_id uuid default null,
  p_topic text default null,
  p_ai_draft text default null,
  p_planned_for timestamptz default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_assets uuid[] := coalesce(p_asset_ids, '{}');
  v_captions jsonb := '{}'::jsonb;
  v_key text;
  v_value text;
begin
  if cardinality(v_assets) > 10 then
    raise exception 'too_many_photos' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from unnest(v_assets) as wanted
    where not exists (
      select 1 from public.social_assets a where a.id = wanted and a.tenant_id = p_tenant_id)
  ) then
    raise exception 'Photo not found' using errcode = 'P0002';
  end if;
  if p_project_id is not null and not exists (
    select 1 from public.social_projects p where p.id = p_project_id and p.tenant_id = p_tenant_id
  ) then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;
  -- Only channels the post goes to, and only when the words really differ.
  for v_key, v_value in select * from jsonb_each_text(coalesce(p_captions, '{}'::jsonb))
  loop
    v_value := btrim(coalesce(v_value, ''));
    continue when v_value = '' or v_value = btrim(coalesce(p_caption, ''))
      or not (v_key = any (coalesce(p_channels, '{}')));
    if char_length(v_value) > 2200 then
      raise exception 'caption_too_long' using errcode = 'P0001';
    end if;
    v_captions := v_captions || jsonb_build_object(v_key, v_value);
  end loop;

  v_id := public.save_social_post(
    p_tenant_id, p_post_id, p_caption, v_assets[1], p_channels, p_scheduled_for);
  update public.social_posts p
  set asset_ids = v_assets, captions = v_captions, project_id = p_project_id,
      topic = nullif(btrim(coalesce(p_topic, '')), ''),
      planned_for = case when p_scheduled_for is null then p_planned_for end,
      ai_draft = coalesce(nullif(left(btrim(coalesce(p_ai_draft, '')), 2200), ''), p.ai_draft)
  where p.id = v_id;
  return v_id;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.save_social_project(uuid, uuid, text, text, text, boolean)',
    'public.update_social_asset(uuid, text, text[], uuid, boolean)',
    'public.file_social_assets(uuid, uuid[], uuid, text[])',
    'public.save_social_post_full(uuid, uuid, text, uuid[], text[], timestamptz, jsonb, uuid, text, text, timestamptz)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
