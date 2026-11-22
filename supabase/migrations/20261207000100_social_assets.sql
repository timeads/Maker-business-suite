-- The photo library becomes an asset library: folders to keep things in, and
-- short videos beside the photos. Files now go straight from the browser to
-- storage through a one-time upload link the server hands out, so a video
-- never has to squeeze through a form post.

-- Photos up to 8 MB as before; the bucket's ceiling is the video limit.
update storage.buckets
set file_size_limit = 52428800,
    allowed_mime_types = array['image/jpeg', 'image/png', 'video/mp4', 'video/quicktime']
where id = 'social';

create table public.social_folders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index social_folders_tenant_idx on public.social_folders (tenant_id, name);
alter table public.social_folders enable row level security;
create policy "members read their social folders" on public.social_folders
  for select to authenticated using (tenant_id in (select private.user_tenant_ids()));
revoke all on public.social_folders from public, anon, authenticated, service_role;
grant select on public.social_folders to authenticated, service_role;

alter table public.social_assets
  add column folder_id uuid references public.social_folders (id) on delete set null,
  drop constraint social_assets_mime_type_check,
  add constraint social_assets_mime_type_check
    check (mime_type in ('image/jpeg', 'image/png', 'video/mp4', 'video/quicktime'));
create index social_assets_folder_idx on public.social_assets (folder_id);

-- Posting a video needs its own route to each network, which isn't built
-- yet. Until it is, a post can only carry photos, whichever way it is saved.
create function private.social_post_photos_only()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (
    select 1 from public.social_assets a
    where (a.id = new.asset_id or a.id = any (new.asset_ids)) and a.mime_type like 'video/%'
  ) then
    raise exception 'video_not_yet' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function private.social_post_photos_only() from public;
create trigger social_posts_photos_only
  before insert or update of asset_id, asset_ids on public.social_posts
  for each row execute function private.social_post_photos_only();

-- Records an uploaded file. As before, but it can go straight into a folder.
create function public.register_social_asset(
  p_tenant_id uuid, p_storage_path text, p_mime_type text, p_bytes int, p_created_by uuid,
  p_folder_id uuid, p_title text default ''
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_storage_path not like p_tenant_id::text || '/%' then
    raise exception 'Bad path' using errcode = '22023';
  end if;
  if p_folder_id is not null and not exists (
    select 1 from public.social_folders f where f.id = p_folder_id and f.tenant_id = p_tenant_id
  ) then
    raise exception 'Folder not found' using errcode = 'P0002';
  end if;
  insert into public.social_assets
    (tenant_id, storage_path, mime_type, bytes, created_by, folder_id, title)
  values (p_tenant_id, p_storage_path, p_mime_type, p_bytes, p_created_by, p_folder_id,
          left(btrim(coalesce(p_title, '')), 120))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.register_social_asset(uuid, text, text, int, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.register_social_asset(uuid, text, text, int, uuid, uuid, text)
  to service_role;

-- Makes a folder, or renames one.
create function public.save_social_folder(p_tenant_id uuid, p_folder_id uuid, p_name text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_member(p_tenant_id);
  if p_folder_id is null then
    if (select count(*) from public.social_folders f where f.tenant_id = p_tenant_id) >= 200 then
      raise exception 'too_many_folders' using errcode = 'P0001';
    end if;
    insert into public.social_folders (tenant_id, name, created_by)
    values (p_tenant_id, btrim(p_name), auth.uid())
    returning id into v_id;
    return v_id;
  end if;
  update public.social_folders f set name = btrim(p_name)
  where f.id = p_folder_id and f.tenant_id = p_tenant_id
  returning f.id into v_id;
  if v_id is null then
    raise exception 'Folder not found' using errcode = 'P0002';
  end if;
  return v_id;
end;
$$;

-- Removes a folder. What was in it stays in the library, outside any folder.
create function public.remove_social_folder(p_tenant_id uuid, p_folder_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_member(p_tenant_id);
  delete from public.social_folders f where f.id = p_folder_id and f.tenant_id = p_tenant_id;
  if not found then
    raise exception 'Folder not found' using errcode = 'P0002';
  end if;
end;
$$;

-- Moves files into a folder (or out of every folder), adds tags, or puts
-- them away, several at a time. Null leaves that part alone.
create function public.sort_social_assets(
  p_tenant_id uuid, p_asset_ids uuid[], p_move boolean, p_folder_id uuid,
  p_add_tags text[] default '{}', p_hidden boolean default null
)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  perform private.require_member(p_tenant_id);
  if coalesce(p_move, false) and p_folder_id is not null and not exists (
    select 1 from public.social_folders f where f.id = p_folder_id and f.tenant_id = p_tenant_id
  ) then
    raise exception 'Folder not found' using errcode = 'P0002';
  end if;
  update public.social_assets a
  set folder_id = case when coalesce(p_move, false) then p_folder_id else a.folder_id end,
      tags = private.tidy_tags(a.tags || coalesce(p_add_tags, '{}')),
      hidden = coalesce(p_hidden, a.hidden)
  where a.tenant_id = p_tenant_id and a.id = any (coalesce(p_asset_ids, '{}'));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.save_social_folder(uuid, uuid, text)',
    'public.remove_social_folder(uuid, uuid)',
    'public.sort_social_assets(uuid, uuid[], boolean, uuid, text[], boolean)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
