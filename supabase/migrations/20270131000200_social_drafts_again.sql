-- Social: Claude's drafts, again and from a project.
--
-- 1. `social_posts.photos_show`: the one sentence Claude returns about what a
--    draft's photos show, kept on the draft as the Content Hub keeps it (in
--    the post's notes there), so a person can check the photos were read
--    right. Shown on the project page and handed to later drafts of the same
--    project as material to read. Written only by the functions below.
--
-- 2. Slides from Claude. A drafted post can carry `slides` (the designer's
--    document) built by the app from Claude's words after every slide was
--    checked against the slide schema and the brand's kit
--    (lib/social/slide-writer.ts, `tidySlides`). The monthly run's filing
--    function takes them too. Photos pictured on slides count as used, like
--    photos on a post, so a project's carousel never shows one twice.
--
-- 3. "Draft from this project" (`file_social_project_draft`): a person's
--    press; the photos are re-checked under the project's row lock, so two
--    presses can't make two drafts of the same photos. Always a plain draft.
--
-- 4. "Write it again" (`redraft_social_post`) and "Bring this back"
--    (`restore_social_post_version`): what the draft said before (its
--    caption, its captions per account, Claude's draft it was compared with,
--    its slides and what the photos show) is kept in `social_post_versions`,
--    so nothing a person wrote is lost. `ai_draft` always becomes the draft
--    the person now sees, so the edits trigger (social_post_edits) compares
--    later changes with the right words; the earlier pair lives on in the
--    version and comes back with it.
--
-- Nothing here schedules, approves or posts (CLAUDE.md rule 6).

alter table public.social_posts
  add column photos_show text check (photos_show is null or char_length(photos_show) <= 400);

create table public.social_post_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  post_id uuid not null references public.social_posts (id) on delete cascade,
  caption text not null default '' check (char_length(caption) <= 2200),
  captions jsonb not null default '{}'::jsonb check (jsonb_typeof(captions) = 'object'),
  ai_draft text check (ai_draft is null or char_length(ai_draft) <= 2200),
  slides jsonb check (slides is null or octet_length(slides::text) <= 1000000),
  photos_show text check (photos_show is null or char_length(photos_show) <= 400),
  -- rewritten: kept when Claude wrote the draft again. replaced: kept when an
  -- earlier version was brought back in its place.
  why text not null check (why in ('rewritten', 'replaced')),
  kept_by uuid references auth.users (id) on delete set null,
  kept_at timestamptz not null default now()
);
create index social_post_versions_post_idx
  on public.social_post_versions (post_id, kept_at desc);
create index social_post_versions_tenant_idx on public.social_post_versions (tenant_id);

alter table public.social_post_versions enable row level security;
create policy "members read their social post versions" on public.social_post_versions
  for select to authenticated using (tenant_id in (select private.user_tenant_ids()));
revoke all on public.social_post_versions from public, anon, authenticated, service_role;
grant select on public.social_post_versions to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Slides as a post may keep them (the same bounds as set_social_post_slides).
create function private.social_slides_ok(p_slides jsonb)
returns boolean
language sql immutable set search_path = ''
as $$
  select p_slides is null or (
    jsonb_typeof(p_slides) = 'object'
    and jsonb_typeof(p_slides -> 'slides') = 'array'
    and jsonb_array_length(p_slides -> 'slides') between 1 and 10
    and octet_length(p_slides::text) <= 1000000);
$$;
revoke all on function private.social_slides_ok(jsonb) from public;

-- Whether any of these photos is already on a post of the workspace, or
-- pictured on one's slides (a slide pictures a photo by its stored address,
-- which ends in the photo's storage path).
create function private.social_photos_used(p_tenant_id uuid, p_assets uuid[])
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.social_posts p
    where p.tenant_id = p_tenant_id
      and (p.asset_ids && p_assets or p.asset_id = any (p_assets))
  ) or exists (
    select 1 from public.social_posts p
    join public.social_assets a on a.tenant_id = p.tenant_id and a.id = any (p_assets)
    where p.tenant_id = p_tenant_id and p.slides is not null
      and position(a.storage_path in p.slides::text) > 0
  );
$$;
revoke all on function private.social_photos_used(uuid, uuid[]) from public;

-- The photos a slides draft pictures: each the workspace's own picture, and
-- each really on the slides.
create function private.social_pictured_ok(p_tenant_id uuid, p_ids uuid[], p_slides jsonb)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select not exists (
    select 1 from unnest(coalesce(p_ids, '{}')) x
    where p_slides is null or not exists (
      select 1 from public.social_assets a
      where a.id = x and a.tenant_id = p_tenant_id and not a.hidden
        and a.mime_type like 'image/%'
        and position(a.storage_path in p_slides::text) > 0)
  );
$$;
revoke all on function private.social_pictured_ok(uuid, uuid[], jsonb) from public;

-- A post that can still be changed: a draft (or a failed post) nothing of
-- which went out, is with a network, or is waiting to be heard about.
create function private.social_post_open(p_post public.social_posts)
returns boolean
language sql stable set search_path = ''
as $$
  select p_post.status in ('draft', 'failed') and not exists (
    select 1 from jsonb_each(coalesce(p_post.results, '{}'::jsonb)) r
    where (r.value ->> 'id') is not null or (r.value ->> 'pending') is not null
       or (r.value ->> 'unsure') is not null or (r.value ->> 'sending') is not null);
$$;
revoke all on function private.social_post_open(public.social_posts) from public;

-- The places a brand has an account in use for; Instagram only with a picture.
create function private.social_draft_channels(p_tenant_id uuid, p_brand_id uuid, p_pictures boolean)
returns text[]
language sql stable security definer set search_path = ''
as $$
  select array_remove(array[
    case when exists (select 1 from public.social_accounts a
                      where a.tenant_id = p_tenant_id and a.brand_id = p_brand_id
                        and a.active and a.network = 'facebook') then 'facebook' end,
    case when p_pictures and exists (select 1 from public.social_accounts a
                      where a.tenant_id = p_tenant_id and a.brand_id = p_brand_id
                        and a.active and a.network = 'instagram') then 'instagram' end
  ], null);
$$;
revoke all on function private.social_draft_channels(uuid, uuid, boolean) from public;

-- Keeps a post's current words as a version, and keeps ten at most.
create function private.keep_social_post_version(p_post public.social_posts, p_why text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.social_post_versions
    (tenant_id, post_id, caption, captions, ai_draft, slides, photos_show, why, kept_by)
  values
    (p_post.tenant_id, p_post.id, left(coalesce(p_post.caption, ''), 2200),
     coalesce(p_post.captions, '{}'::jsonb), p_post.ai_draft, p_post.slides, p_post.photos_show,
     p_why, auth.uid());
  delete from public.social_post_versions v
  where v.post_id = p_post.id and v.id in (
    select v2.id from public.social_post_versions v2
    where v2.post_id = p_post.id
    order by v2.kept_at desc, v2.id desc
    offset 10);
end;
$$;
revoke all on function private.keep_social_post_version(public.social_posts, text) from public;

-- ---------------------------------------------------------------------------
-- The monthly run's filing function, now with slides and what the photos show
-- ---------------------------------------------------------------------------

-- As before (20270130000100), plus:
--   "slides": the checked design, or absent;
--   "pictured_ids": the photos the slides show (each must be on them);
--   "photos_show": the sentence about the photos, or absent.
-- A project's photos, on the post or pictured on its slides, are only ever
-- ones no post has used.
create or replace function public.file_social_month_draft(p_run_id uuid, p_draft jsonb)
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
  v_sees text := nullif(left(btrim(coalesce(p_draft ->> 'photos_show', '')), 400), '');
  v_slides jsonb := case when jsonb_typeof(p_draft -> 'slides') = 'object'
                         then p_draft -> 'slides' end;
  v_project uuid;
  v_assets uuid[];
  v_pictured uuid[];
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
  if not private.social_slides_ok(v_slides) then
    raise exception 'slides_not_valid' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_draft -> 'asset_ids', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_draft -> 'asset_ids', '[]'::jsonb)) > 10
     or jsonb_typeof(coalesce(p_draft -> 'pictured_ids', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_draft -> 'pictured_ids', '[]'::jsonb)) > 40 then
    raise exception 'too_many_photos' using errcode = 'P0001';
  end if;
  v_assets := array(
    select x::uuid from jsonb_array_elements_text(coalesce(p_draft -> 'asset_ids', '[]'::jsonb))
      with ordinality as a(x, n)
    group by x order by min(n));
  v_pictured := array(
    select distinct x::uuid
    from jsonb_array_elements_text(coalesce(p_draft -> 'pictured_ids', '[]'::jsonb)) as a(x));
  if v_slides is not null and cardinality(v_assets) + jsonb_array_length(v_slides -> 'slides') > 10 then
    raise exception 'too_many_photos' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from unnest(v_assets) x
    where not exists (
      select 1 from public.social_assets a
      where a.id = x and a.tenant_id = v_run.tenant_id and not a.hidden
        and a.mime_type like 'image/%')
  ) or not private.social_pictured_ok(v_run.tenant_id, v_pictured, v_slides) then
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
  if p_draft ->> 'kind' = 'project'
     and private.social_photos_used(v_run.tenant_id, v_assets || v_pictured) then
    return null;
  end if;

  v_waiting := private.social_requires_approval(v_run.tenant_id);
  insert into public.social_posts
    (tenant_id, brand_id, caption, ai_draft, asset_id, asset_ids, channels, status,
     planned_for, project_id, topic, month_run_id, review, submitted_at, slides, photos_show)
  values
    (v_run.tenant_id, v_run.brand_id, v_caption, v_caption, v_assets[1], v_assets,
     private.social_draft_channels(v_run.tenant_id, v_run.brand_id,
                                   cardinality(v_assets) > 0 or v_slides is not null),
     'draft', v_at, v_project, v_topic, v_run.id,
     case when v_waiting then 'waiting' end, case when v_waiting then now() end,
     v_slides, v_sees)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- "Draft from this project": a person's press
-- ---------------------------------------------------------------------------

-- `p_draft`: {"brand_id", "caption", "asset_ids", "pictured_ids", "slides",
-- "photos_show", "topic", "planned_for"}. The photos must be this project's,
-- and no post may have used them; that is checked under the project's lock,
-- so a second press finds them taken and returns null. A plain draft: a
-- person sends it for review or schedules it.
create function public.file_social_project_draft(
  p_tenant_id uuid, p_project_id uuid, p_draft jsonb
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_caption text := btrim(coalesce(p_draft ->> 'caption', ''));
  v_topic text := nullif(btrim(coalesce(p_draft ->> 'topic', '')), '');
  v_sees text := nullif(left(btrim(coalesce(p_draft ->> 'photos_show', '')), 400), '');
  v_slides jsonb := case when jsonb_typeof(p_draft -> 'slides') = 'object'
                         then p_draft -> 'slides' end;
  v_brand uuid;
  v_at timestamptz;
  v_assets uuid[];
  v_pictured uuid[];
  v_id uuid;
begin
  perform private.require_member(p_tenant_id);
  perform 1 from public.social_projects p
  where p.id = p_project_id and p.tenant_id = p_tenant_id and p.archived_at is null
  for update;
  if not found then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;
  if v_caption = '' or char_length(v_caption) > 2200 then
    raise exception 'bad_caption' using errcode = '22023';
  end if;
  if v_topic is not null and char_length(v_topic) > 40 then
    raise exception 'bad_topic' using errcode = '22023';
  end if;
  if not private.social_slides_ok(v_slides) then
    raise exception 'slides_not_valid' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_draft -> 'asset_ids', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_draft -> 'asset_ids', '[]'::jsonb)) > 10
     or jsonb_typeof(coalesce(p_draft -> 'pictured_ids', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_draft -> 'pictured_ids', '[]'::jsonb)) > 40 then
    raise exception 'too_many_photos' using errcode = 'P0001';
  end if;
  v_assets := array(
    select x::uuid from jsonb_array_elements_text(coalesce(p_draft -> 'asset_ids', '[]'::jsonb))
      with ordinality as a(x, n)
    group by x order by min(n));
  v_pictured := array(
    select distinct x::uuid
    from jsonb_array_elements_text(coalesce(p_draft -> 'pictured_ids', '[]'::jsonb)) as a(x));
  if cardinality(v_assets) + cardinality(v_pictured) = 0 then
    raise exception 'no_photos' using errcode = 'P0001';
  end if;
  if v_slides is not null and cardinality(v_assets) + jsonb_array_length(v_slides -> 'slides') > 10 then
    raise exception 'too_many_photos' using errcode = 'P0001';
  end if;
  -- Only this project's own pictures.
  if exists (
    select 1 from unnest(v_assets || v_pictured) x
    where not exists (
      select 1 from public.social_assets a
      where a.id = x and a.tenant_id = p_tenant_id and a.project_id = p_project_id
        and not a.hidden and a.mime_type like 'image/%' and a.role is distinct from 'artwork')
  ) or not private.social_pictured_ok(p_tenant_id, v_pictured, v_slides) then
    raise exception 'Photo not found' using errcode = 'P0002';
  end if;
  if private.social_photos_used(p_tenant_id, v_assets || v_pictured) then
    return null;
  end if;

  select b.id into v_brand from public.brands b
  where b.tenant_id = p_tenant_id and b.archived_at is null
    and (b.id::text = p_draft ->> 'brand_id'
         or (coalesce(p_draft ->> 'brand_id', '') = '' and b.is_default))
  limit 1;
  if v_brand is null then
    raise exception 'Brand not found' using errcode = 'P0002';
  end if;
  if coalesce(p_draft ->> 'planned_for', '') <> '' then
    v_at := (p_draft ->> 'planned_for')::timestamptz;
    if v_at <= now() then
      v_at := null;
    end if;
  end if;

  insert into public.social_posts
    (tenant_id, brand_id, caption, ai_draft, asset_id, asset_ids, channels, status,
     planned_for, project_id, topic, slides, photos_show)
  values
    (p_tenant_id, v_brand, v_caption, v_caption, v_assets[1], v_assets,
     private.social_draft_channels(p_tenant_id, v_brand,
                                   cardinality(v_assets) > 0 or v_slides is not null),
     'draft', v_at, p_project_id, v_topic, v_slides, v_sees)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- "Write it again" and "Bring this back"
-- ---------------------------------------------------------------------------

-- Puts Claude's new words on a draft Claude wrote, keeping what it said
-- before as a version. `p_seen` is the post's `updated_at` when the person
-- pressed: a draft changed since is left alone (`changed_meanwhile`), so an
-- edit saved in another tab is never written over. `p_draft`: {"caption",
-- "slides" (only when Claude wrote slides; the drawn pictures come off),
-- "photos_show"}.
create function public.redraft_social_post(
  p_tenant_id uuid, p_post_id uuid, p_seen timestamptz, p_draft jsonb
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_post public.social_posts;
  v_caption text := btrim(coalesce(p_draft ->> 'caption', ''));
  v_has_slides boolean := p_draft ? 'slides';
  v_slides jsonb := case when jsonb_typeof(p_draft -> 'slides') = 'object'
                         then p_draft -> 'slides' end;
  v_sees text := nullif(left(btrim(coalesce(p_draft ->> 'photos_show', '')), 400), '');
begin
  perform private.require_member(p_tenant_id);
  select * into v_post from public.social_posts p
  where p.id = p_post_id and p.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'Post not found' using errcode = 'P0002';
  end if;
  if not private.social_post_open(v_post) then
    raise exception 'locked' using errcode = 'P0001';
  end if;
  if v_post.ai_draft is null then
    raise exception 'not_drafted' using errcode = 'P0001';
  end if;
  if p_seen is distinct from v_post.updated_at then
    raise exception 'changed_meanwhile' using errcode = 'P0001';
  end if;
  if v_caption = '' or char_length(v_caption) > 2200 then
    raise exception 'bad_caption' using errcode = '22023';
  end if;
  if v_has_slides and (v_slides is null or not private.social_slides_ok(v_slides)) then
    raise exception 'slides_not_valid' using errcode = '22023';
  end if;

  perform private.keep_social_post_version(v_post, 'rewritten');
  update public.social_posts p
  set caption = v_caption,
      ai_draft = v_caption,
      captions = '{}'::jsonb,
      photos_show = coalesce(v_sees, p.photos_show),
      slides = case when v_has_slides then v_slides else p.slides end,
      asset_ids = case when v_has_slides
        then array(select x from unnest(p.asset_ids) with ordinality as t(x, n)
                   where not (x = any (p.slide_asset_ids)) order by n)
        else p.asset_ids end,
      slide_asset_ids = case when v_has_slides then '{}' else p.slide_asset_ids end,
      slides_drawn = case when v_has_slides then null else p.slides_drawn end
  where p.id = p_post_id;
  update public.social_posts p set asset_id = p.asset_ids[1]
  where p.id = p_post_id and v_has_slides;
end;
$$;

-- Brings an earlier version back. What the draft says now is kept as a
-- version in its place, so this can be undone the same way.
create function public.restore_social_post_version(p_tenant_id uuid, p_version_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_version public.social_post_versions;
  v_post public.social_posts;
  v_slides_change boolean;
begin
  perform private.require_member(p_tenant_id);
  select * into v_version from public.social_post_versions v
  where v.id = p_version_id and v.tenant_id = p_tenant_id;
  if not found then
    raise exception 'Version not found' using errcode = 'P0002';
  end if;
  select * into v_post from public.social_posts p
  where p.id = v_version.post_id and p.tenant_id = p_tenant_id
  for update;
  if not found or not private.social_post_open(v_post) then
    raise exception 'locked' using errcode = 'P0001';
  end if;
  v_slides_change := v_version.slides is distinct from v_post.slides;

  perform private.keep_social_post_version(v_post, 'replaced');
  update public.social_posts p
  set caption = v_version.caption,
      captions = v_version.captions,
      ai_draft = v_version.ai_draft,
      photos_show = v_version.photos_show,
      slides = v_version.slides,
      asset_ids = case when v_slides_change
        then array(select x from unnest(p.asset_ids) with ordinality as t(x, n)
                   where not (x = any (p.slide_asset_ids)) order by n)
        else p.asset_ids end,
      slide_asset_ids = case when v_slides_change then '{}' else p.slide_asset_ids end,
      slides_drawn = case when v_slides_change then null else p.slides_drawn end
  where p.id = v_post.id;
  update public.social_posts p set asset_id = p.asset_ids[1]
  where p.id = v_post.id and v_slides_change;
  delete from public.social_post_versions v where v.id = p_version_id;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.file_social_project_draft(uuid, uuid, jsonb)',
    'public.redraft_social_post(uuid, uuid, timestamptz, jsonb)',
    'public.restore_social_post_version(uuid, uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
