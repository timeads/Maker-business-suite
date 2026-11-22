-- Phase 6 (part two): social.
-- social_assets (uploaded photos) and social_posts (drafts, scheduled and
-- published posts). Members write through functions; the worker claims posts
-- that are due and records what each channel answered.

-- Photos live in a public bucket because Instagram fetches the image by URL.
-- Paths are <workspace id>/<random id>, written only by the server.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('social', 'social', true, 8388608, array['image/jpeg', 'image/png'])
on conflict (id) do nothing;

create type public.social_post_status as enum
  ('draft', 'scheduled', 'publishing', 'published', 'failed');

create table public.social_assets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  storage_path text not null unique,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png')),
  bytes int not null check (bytes > 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index social_assets_tenant_idx on public.social_assets (tenant_id, created_at desc);

create table public.social_posts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  caption text not null default '' check (char_length(caption) <= 2200),
  asset_id uuid references public.social_assets (id) on delete set null,
  channels text[] not null default '{}'
    check (channels <@ array['facebook', 'instagram']::text[]),
  status public.social_post_status not null default 'draft',
  scheduled_for timestamptz,
  published_at timestamptz,
  -- What each channel answered: {"facebook": {"id": "..."}, "instagram": {"error": "..."}}
  results jsonb not null default '{}'::jsonb,
  error text,
  attempts int not null default 0,
  locked_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status = 'draft' or scheduled_for is not null)
);
create index social_posts_tenant_when_idx on public.social_posts (tenant_id, scheduled_for);
create index social_posts_due_idx on public.social_posts (scheduled_for)
  where status in ('scheduled', 'publishing');

alter table public.social_assets enable row level security;
alter table public.social_posts enable row level security;

create policy "members read their social assets" on public.social_assets
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));
create policy "members read their social posts" on public.social_posts
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));

revoke all on public.social_assets, public.social_posts
  from public, anon, authenticated, service_role;
grant select on public.social_assets, public.social_posts to authenticated, service_role;

create trigger social_posts_touch_updated_at
  before update on public.social_posts
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- What members do
-- ---------------------------------------------------------------------------

-- Creates or edits a post. With a time it is scheduled; without, it's a draft.
-- Posts that are going out or already out can't be changed.
create function public.save_social_post(
  p_tenant_id uuid,
  p_post_id uuid,
  p_caption text,
  p_asset_id uuid,
  p_channels text[],
  p_scheduled_for timestamptz
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_channels text[] := coalesce(p_channels, '{}');
  v_caption text := btrim(coalesce(p_caption, ''));
begin
  if not (p_tenant_id in (select private.user_tenant_ids())) then
    raise exception 'Workspace not found' using errcode = '42501';
  end if;
  if p_asset_id is not null and not exists (
    select 1 from public.social_assets a where a.id = p_asset_id and a.tenant_id = p_tenant_id
  ) then
    raise exception 'Photo not found' using errcode = 'P0002';
  end if;

  if p_scheduled_for is not null then
    if cardinality(v_channels) = 0 then
      raise exception 'no_channel' using errcode = 'P0001';
    end if;
    if v_caption = '' and p_asset_id is null then
      raise exception 'empty' using errcode = 'P0001';
    end if;
    if 'instagram' = any (v_channels) and p_asset_id is null then
      raise exception 'instagram_needs_photo' using errcode = 'P0001';
    end if;
    if p_scheduled_for < now() - interval '5 minutes' then
      raise exception 'past' using errcode = 'P0001';
    end if;
  end if;

  if p_post_id is null then
    insert into public.social_posts
      (tenant_id, caption, asset_id, channels, status, scheduled_for, created_by)
    values
      (p_tenant_id, v_caption, p_asset_id, v_channels,
       case when p_scheduled_for is null then 'draft' else 'scheduled' end::public.social_post_status,
       p_scheduled_for, auth.uid())
    returning id into v_id;
    return v_id;
  end if;

  update public.social_posts p
  set caption = v_caption, asset_id = p_asset_id, channels = v_channels,
      status = case when p_scheduled_for is null then 'draft' else 'scheduled' end::public.social_post_status,
      scheduled_for = p_scheduled_for,
      -- A fresh start: forget earlier failures, but never what already went out.
      error = null, attempts = 0, locked_at = null, results = '{}'::jsonb
  where p.id = p_post_id and p.tenant_id = p_tenant_id
    and p.status in ('draft', 'scheduled', 'failed')
    and not exists (select 1 from jsonb_each(p.results) r where r.value ->> 'id' is not null)
  returning p.id into v_id;
  if v_id is null then
    raise exception 'locked' using errcode = 'P0001';
  end if;
  return v_id;
end;
$$;

create function public.delete_social_post(p_post_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.social_posts p
  where p.id = p_post_id
    and p.tenant_id in (select private.user_tenant_ids())
    and p.status in ('draft', 'scheduled', 'failed');
  if not found then
    raise exception 'locked' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.save_social_post(uuid, uuid, text, uuid, text[], timestamptz) from public, anon;
revoke all on function public.delete_social_post(uuid) from public, anon;
grant execute on function public.save_social_post(uuid, uuid, text, uuid, text[], timestamptz) to authenticated;
grant execute on function public.delete_social_post(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Service role: uploads and the publishing queue
-- ---------------------------------------------------------------------------

create function public.register_social_asset(
  p_tenant_id uuid, p_storage_path text, p_mime_type text, p_bytes int, p_created_by uuid
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  -- The file must sit in the workspace's own folder.
  if p_storage_path not like p_tenant_id::text || '/%' then
    raise exception 'Bad path' using errcode = '22023';
  end if;
  insert into public.social_assets (tenant_id, storage_path, mime_type, bytes, created_by)
  values (p_tenant_id, p_storage_path, p_mime_type, p_bytes, p_created_by)
  returning id into v_id;
  return v_id;
end;
$$;

-- Hands out posts whose time has come. A claimed post is hidden for ten
-- minutes, which is also the wait before a retry.
create function public.claim_due_social_posts(p_limit int default 10)
returns setof public.social_posts
language sql security definer set search_path = ''
as $$
  update public.social_posts p
  set status = 'publishing', locked_at = now(), attempts = p.attempts + 1
  where p.id in (
    select d.id from public.social_posts d
    where d.status in ('scheduled', 'publishing')
      and d.scheduled_for <= now()
      and (d.locked_at is null or d.locked_at < now() - interval '10 minutes')
    order by d.scheduled_for
    limit greatest(1, least(coalesce(p_limit, 10), 50))
    for update skip locked
  )
  returning p.*;
$$;

-- Records what happened. `p_results` holds only the channels tried this time
-- and is merged in, so a channel that went out is never sent twice. The post
-- is published once every channel has an id; otherwise it waits for another
-- try, or fails after three.
create function public.finish_social_post(p_post_id uuid, p_results jsonb, p_retry boolean default true)
returns public.social_post_status
language plpgsql security definer set search_path = ''
as $$
declare
  v_post public.social_posts;
  v_results jsonb;
  v_missing text[];
  v_status public.social_post_status;
begin
  select * into v_post from public.social_posts p where p.id = p_post_id for update;
  if not found or v_post.status <> 'publishing' then
    return v_post.status;
  end if;
  v_results := v_post.results || coalesce(p_results, '{}'::jsonb);
  select coalesce(array_agg(c), '{}') into v_missing
  from unnest(v_post.channels) as c
  where v_results -> c ->> 'id' is null;

  v_status := case
    when cardinality(v_missing) = 0 then 'published'
    when p_retry and v_post.attempts < 3 then 'scheduled'
    else 'failed'
  end;
  update public.social_posts p
  set status = v_status, results = v_results,
      published_at = case when v_status = 'published' then now() else null end,
      error = case when v_status = 'published' then null
                   else (select string_agg(c || ': ' || coalesce(v_results -> c ->> 'error', 'not sent'), '; ')
                         from unnest(v_missing) as c) end
  where p.id = p_post_id;
  return v_status;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.register_social_asset(uuid, text, text, int, uuid)',
    'public.claim_due_social_posts(int)',
    'public.finish_social_post(uuid, jsonb, boolean)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
