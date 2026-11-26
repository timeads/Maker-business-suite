-- Social: Instagram Stories, and photos sized for where they go.
--
-- A post can now go to Instagram as a Story ('instagram_story') beside the
-- feed (or a Reel, for a video) and Facebook. Each place's answer is kept
-- under its own name in `results`, so finish_social_post still never sends a
-- place twice.
--
-- Instagram refuses a feed photo taller than 4:5 or wider than 1.91:1, and a
-- Story is 9:16. The suite has no image library on the server, so a photo
-- that doesn't fit gets a copy drawn in the browser of the person scheduling
-- or approving it (cropped from the middle, as the earlier app did), sent
-- through the same checked upload path, and measured again by the server.
-- The original asset is never changed. Every photo's size is read by the
-- server from the file's own bytes (`width`, `height`), and a post can't be
-- scheduled for Instagram with a photo whose stored size doesn't fit.

alter table public.social_assets
  add column width int check (width is null or width > 0),
  add column height int check (height is null or height > 0),
  -- A copy sized for one place, made from another of the workspace's photos.
  add column fitted_from uuid references public.social_assets (id) on delete cascade,
  add column fitted_for text check (fitted_for in ('instagram', 'instagram_story')),
  add constraint social_assets_fitted_check check ((fitted_from is null) = (fitted_for is null));
create index social_assets_fitted_idx on public.social_assets (fitted_from)
  where fitted_from is not null;

alter table public.social_posts
  drop constraint social_posts_channels_check,
  add constraint social_posts_channels_check
    check (channels <@ array['facebook', 'instagram', 'instagram_story']::text[]),
  -- {"instagram": [ids], "instagram_story": [id]}: what each place gets instead of the
  -- post's photos, one entry per photo in the same order (the photo itself, or its copy).
  add column channel_media jsonb not null default '{}'::jsonb
    check (jsonb_typeof(channel_media) = 'object');

-- The same arithmetic as `fits` in src/lib/social/fit.ts: width over height,
-- with a pixel or two of rounding either way.
create function private.social_photo_fits(p_place text, p_width int, p_height int)
returns boolean
language sql immutable set search_path = ''
as $$
  select coalesce(p_width > 0 and p_height > 0 and case p_place
    when 'instagram' then
      p_width::numeric / p_height between (4.0 / 5) * 0.99 and 1.91 * 1.01
    when 'instagram_story' then
      p_width::numeric / p_height between (9.0 / 16) * 0.99 and (9.0 / 16) * 1.01
    else true end, false);
$$;
revoke all on function private.social_photo_fits(text, int, int) from public;

-- What a place gets for a post's photos, in order: each photo's copy for that
-- place where one is set (and really is that photo's copy), else the photo.
create function private.social_media_for(p_asset_ids uuid[], p_media jsonb, p_place text)
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(coalesce(c.id, t.x) order by t.n), '{}')
  from unnest(coalesce(p_asset_ids, '{}')) with ordinality as t(x, n)
  left join public.social_assets c
    on c.id::text = (coalesce(p_media, '{}'::jsonb) -> p_place ->> (t.n::int - 1))
   and c.fitted_from = t.x and c.fitted_for = p_place;
$$;
revoke all on function private.social_media_for(uuid[], jsonb, text) from public;

-- What can be scheduled, now that a Story needs a photo or a video too.
create or replace function private.check_social_schedule(
  p_channels text[], p_caption text, p_has_photo boolean, p_at timestamptz
)
returns void
language plpgsql immutable set search_path = ''
as $$
begin
  if p_at is null then
    raise exception 'no_time' using errcode = 'P0001';
  end if;
  if cardinality(coalesce(p_channels, '{}')) = 0 then
    raise exception 'no_channel' using errcode = 'P0001';
  end if;
  if btrim(coalesce(p_caption, '')) = '' and not p_has_photo then
    raise exception 'empty' using errcode = 'P0001';
  end if;
  if 'instagram' = any (p_channels) and not p_has_photo then
    raise exception 'instagram_needs_photo' using errcode = 'P0001';
  end if;
  if 'instagram_story' = any (p_channels) and not p_has_photo then
    raise exception 'story_needs_media' using errcode = 'P0001';
  end if;
end;
$$;

-- A post becomes scheduled for Instagram only with photos Instagram takes:
-- JPEGs of a known size that fits, the post's own or their copies. A Story is
-- one photo or one video. As with approval, a worker's retry is left alone.
create function private.social_post_sizes_check()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_photos uuid[];
  v_media uuid[];
begin
  if new.status <> 'scheduled' or (tg_op = 'UPDATE' and old.status = 'publishing') then
    return new;
  end if;
  v_photos := case when cardinality(new.asset_ids) > 0 then new.asset_ids
                   when new.asset_id is not null then array[new.asset_id]
                   else '{}'::uuid[] end;
  if 'instagram' = any (new.channels) then
    v_media := private.social_media_for(v_photos, new.channel_media, 'instagram');
    if exists (
      select 1 from public.social_assets a
      where a.id = any (v_media) and a.mime_type like 'image/%'
        and (a.mime_type <> 'image/jpeg'
             or not private.social_photo_fits('instagram', a.width, a.height))
    ) then
      raise exception 'photo_size' using errcode = 'P0001';
    end if;
  end if;
  if 'instagram_story' = any (new.channels) then
    if cardinality(v_photos) <> 1 then
      raise exception 'story_one' using errcode = 'P0001';
    end if;
    v_media := private.social_media_for(v_photos, new.channel_media, 'instagram_story');
    if exists (
      select 1 from public.social_assets a
      where a.id = any (v_media) and a.mime_type like 'image/%'
        and (a.mime_type <> 'image/jpeg'
             or not private.social_photo_fits('instagram_story', a.width, a.height))
    ) then
      raise exception 'story_size' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.social_post_sizes_check() from public;
create trigger social_posts_sizes_check
  before insert or update on public.social_posts
  for each row execute function private.social_post_sizes_check();

-- ---------------------------------------------------------------------------
-- Service role: what the server measured
-- ---------------------------------------------------------------------------

-- The size the server read from a photo's own bytes.
create function public.set_social_asset_size(
  p_tenant_id uuid, p_asset_id uuid, p_width int, p_height int
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.social_assets a set width = p_width, height = p_height
  where a.id = p_asset_id and a.tenant_id = p_tenant_id and a.mime_type like 'image/%';
  if not found then
    raise exception 'Picture not found' using errcode = 'P0002';
  end if;
end;
$$;

-- Marks an uploaded picture as one photo's copy for one place. The copy must
-- be a JPEG of a measured size that fits; it is put away out of the library.
create function public.mark_social_fitted_copy(
  p_tenant_id uuid, p_copy_id uuid, p_original_id uuid, p_place text
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_place not in ('instagram', 'instagram_story') or p_copy_id = p_original_id then
    raise exception 'bad_place' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.social_assets o
    where o.id = p_original_id and o.tenant_id = p_tenant_id and o.mime_type like 'image/%'
  ) then
    raise exception 'Photo not found' using errcode = 'P0002';
  end if;
  update public.social_assets a
  set fitted_from = p_original_id, fitted_for = p_place, hidden = true,
      tags = private.tidy_tags(a.tags || array['sized'])
  where a.id = p_copy_id and a.tenant_id = p_tenant_id and a.mime_type = 'image/jpeg'
    and private.social_photo_fits(p_place, a.width, a.height);
  if not found then
    raise exception 'photo_size' using errcode = 'P0001';
  end if;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.set_social_asset_size(uuid, uuid, int, int)',
    'public.mark_social_fitted_copy(uuid, uuid, uuid, text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- What members do: say which copies a post's places get
-- ---------------------------------------------------------------------------

-- `p_fits` is {"instagram": [...], "instagram_story": [...]}: for each place,
-- one entry per photo on the post, in order, each the photo itself or its copy
-- for that place. Only while the post can still be changed.
create function public.set_social_post_fits(p_tenant_id uuid, p_post_id uuid, p_fits jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_post public.social_posts;
  v_photos uuid[];
  v_place text;
  v_list jsonb;
  v_kept jsonb := '{}'::jsonb;
  v_i int;
  v_entry text;
begin
  perform private.require_member(p_tenant_id);
  select * into v_post from public.social_posts p
  where p.id = p_post_id and p.tenant_id = p_tenant_id
  for update;
  if not found or v_post.status not in ('draft', 'failed')
     or exists (select 1 from jsonb_each(v_post.results) r where r.value ->> 'id' is not null) then
    raise exception 'locked' using errcode = 'P0001';
  end if;
  if jsonb_typeof(coalesce(p_fits, '{}'::jsonb)) <> 'object' then
    raise exception 'fits_not_valid' using errcode = '22023';
  end if;
  v_photos := case when cardinality(v_post.asset_ids) > 0 then v_post.asset_ids
                   when v_post.asset_id is not null then array[v_post.asset_id]
                   else '{}'::uuid[] end;
  for v_place, v_list in select * from jsonb_each(coalesce(p_fits, '{}'::jsonb)) loop
    if v_place not in ('instagram', 'instagram_story') or jsonb_typeof(v_list) <> 'array'
       or jsonb_array_length(v_list) <> cardinality(v_photos) then
      raise exception 'fits_not_valid' using errcode = '22023';
    end if;
    for v_i in 1 .. cardinality(v_photos) loop
      v_entry := v_list ->> (v_i - 1);
      if v_entry is distinct from v_photos[v_i]::text and not exists (
        select 1 from public.social_assets c
        where c.id::text = v_entry and c.tenant_id = p_tenant_id
          and c.fitted_from = v_photos[v_i] and c.fitted_for = v_place
      ) then
        raise exception 'fits_not_valid' using errcode = '22023';
      end if;
    end loop;
    v_kept := v_kept || jsonb_build_object(v_place, v_list);
  end loop;
  update public.social_posts p set channel_media = v_kept where p.id = p_post_id;
end;
$$;
revoke all on function public.set_social_post_fits(uuid, uuid, jsonb) from public, anon;
grant execute on function public.set_social_post_fits(uuid, uuid, jsonb) to authenticated;
