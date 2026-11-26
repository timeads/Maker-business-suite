-- Social: a project's photos in the order they were taken, and what each one is.
--
-- `taken_at` is when a photo was taken, read by the server from the photo's
-- own bytes as it arrives (JPEG EXIF, lib/social/taken-at.ts); never from
-- anything the browser says. Null when the photo doesn't say (a PNG, a video,
-- a camera with no clock): such a photo is ordered by when it was added
-- (`coalesce(taken_at, created_at)`), so existing rows need nothing done.
--
-- `role` is what a person says a photo is, as in the Content Hub: a process
-- shot, a finished photo, or artwork (a design, a sketch, a mock-up). Null is
-- unmarked and counts as a process shot. Finished photos close a project's
-- carousel; artwork stays out of carousels. Only a person sets it.

alter table public.social_assets
  add column taken_at timestamptz,
  add column role text check (role in ('process', 'finished', 'artwork'));
create index social_assets_project_taken_idx
  on public.social_assets (project_id, (coalesce(taken_at, created_at)))
  where project_id is not null;

-- The server, after reading a stored photo's bytes. Service role only.
create function public.set_social_asset_taken_at(
  p_tenant_id uuid, p_asset_id uuid, p_taken_at timestamptz
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_taken_at is not null
     and (p_taken_at < '2000-01-01'::timestamptz or p_taken_at > now() + interval '1 day') then
    raise exception 'bad_time' using errcode = '22023';
  end if;
  update public.social_assets a set taken_at = p_taken_at
  where a.id = p_asset_id and a.tenant_id = p_tenant_id and a.mime_type like 'image/%';
  if not found then
    raise exception 'Picture not found' using errcode = 'P0002';
  end if;
end;
$$;

-- A person marks photos as process shots, finished photos or artwork (null
-- clears the mark). A video can only be a process shot. Returns how many
-- changed.
create function public.set_social_asset_role(
  p_tenant_id uuid, p_asset_ids uuid[], p_role text
)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  perform private.require_member(p_tenant_id);
  if p_role is not null and p_role not in ('process', 'finished', 'artwork') then
    raise exception 'bad_role' using errcode = '22023';
  end if;
  if cardinality(coalesce(p_asset_ids, '{}')) > 100 then
    raise exception 'too_many' using errcode = '22023';
  end if;
  update public.social_assets a set role = p_role
  where a.tenant_id = p_tenant_id and a.id = any (coalesce(p_asset_ids, '{}'))
    and (p_role is null or p_role = 'process' or a.mime_type like 'image/%');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

do $$
begin
  execute 'revoke all on function public.set_social_asset_taken_at(uuid, uuid, timestamptz) from public, anon, authenticated';
  execute 'grant execute on function public.set_social_asset_taken_at(uuid, uuid, timestamptz) to service_role';
  execute 'revoke all on function public.set_social_asset_role(uuid, uuid[], text) from public, anon';
  execute 'grant execute on function public.set_social_asset_role(uuid, uuid[], text) to authenticated';
end;
$$;
