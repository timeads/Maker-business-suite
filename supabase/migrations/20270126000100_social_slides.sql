-- Social: a carousel kept as one design on the post. A post can carry
-- `slides`, the designer's own document (words over a colour or one of the
-- workspace's photos, in the brand kit's layouts), tidied and bounded by the
-- server before it gets here. The slides stay editable while the post is a
-- draft. When it is approved (or scheduled where no approval is needed) the
-- pictures are drawn in that person's browser, uploaded through the same
-- checked upload path as any file, and attached here in order, ahead of any
-- other photos. A post with slides can only be scheduled once its pictures
-- were drawn from the slides as they are now.

alter table public.social_posts
  add column slides jsonb,
  -- Which version of the slides this is, worked out by the database.
  add column slides_key text generated always as (md5(slides::text)) stored,
  -- The pictures drawn from the slides, in order, and the version they were drawn from.
  add column slide_asset_ids uuid[] not null default '{}' check (cardinality(slide_asset_ids) <= 10),
  add column slides_drawn text,
  add constraint social_posts_slides_check check (
    slides is null
    or (
      jsonb_typeof(slides) = 'object'
      and jsonb_typeof(slides -> 'slides') = 'array'
      and jsonb_array_length(slides -> 'slides') between 1 and 10
      and octet_length(slides::text) <= 1000000
    )
  );

-- A post with slides becomes scheduled only with pictures drawn from those
-- very slides. As with approval, a worker's retry is left alone.
create function private.social_post_slides_check()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status = 'scheduled'
     and (tg_op = 'INSERT' or old.status <> 'publishing')
     and new.slides is not null
     and new.slides_drawn is distinct from md5(new.slides::text)
  then
    raise exception 'slides_not_drawn' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function private.social_post_slides_check() from public;
create trigger social_posts_slides_check
  before insert or update on public.social_posts
  for each row execute function private.social_post_slides_check();

-- Keeps (or, with null, takes off) the slides on a draft. Returns their key.
-- Taking them off also takes their pictures off the post.
create function public.set_social_post_slides(p_tenant_id uuid, p_post_id uuid, p_slides jsonb)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_key text;
begin
  perform private.require_member(p_tenant_id);
  if p_slides is not null and (
    jsonb_typeof(p_slides) <> 'object'
    or jsonb_typeof(p_slides -> 'slides') <> 'array'
    or jsonb_array_length(p_slides -> 'slides') not between 1 and 10
    or octet_length(p_slides::text) > 1000000
  ) then
    raise exception 'slides_not_valid' using errcode = '22023';
  end if;
  update public.social_posts p
  set slides = p_slides,
      asset_ids = case when p_slides is null
        then array(select x from unnest(p.asset_ids) as x where not (x = any (p.slide_asset_ids)))
        else p.asset_ids end,
      slide_asset_ids = case when p_slides is null then '{}' else p.slide_asset_ids end,
      slides_drawn = case when p_slides is null then null else p.slides_drawn end
  where p.id = p_post_id and p.tenant_id = p_tenant_id
    and p.status in ('draft', 'failed')
    and not exists (select 1 from jsonb_each(p.results) r where r.value ->> 'id' is not null)
  returning p.slides_key into v_key;
  if not found then
    raise exception 'locked' using errcode = 'P0001';
  end if;
  -- A post that lost its photos keeps its first one in step.
  update public.social_posts p set asset_id = p.asset_ids[1]
  where p.id = p_post_id and p_slides is null;
  return v_key;
end;
$$;

-- Puts the pictures drawn from the slides on the post, in order, ahead of
-- its other photos. `p_key` is the version of the slides they were drawn
-- from; if the slides changed meanwhile nothing is attached. One picture per
-- slide, each a picture in this workspace's own assets, ten photos at most.
create function public.attach_social_slide_pictures(
  p_tenant_id uuid, p_post_id uuid, p_key text, p_asset_ids uuid[]
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_post public.social_posts;
  v_pictures uuid[] := coalesce(p_asset_ids, '{}');
  v_others uuid[];
begin
  perform private.require_member(p_tenant_id);
  select * into v_post from public.social_posts p
  where p.id = p_post_id and p.tenant_id = p_tenant_id
  for update;
  if not found or v_post.status not in ('draft', 'failed')
     or exists (select 1 from jsonb_each(v_post.results) r where r.value ->> 'id' is not null) then
    raise exception 'locked' using errcode = 'P0001';
  end if;
  if v_post.slides is null or v_post.slides_key is distinct from p_key then
    raise exception 'slides_changed' using errcode = 'P0001';
  end if;
  if cardinality(v_pictures) <> jsonb_array_length(v_post.slides -> 'slides')
     or (select count(distinct x) from unnest(v_pictures) as x) <> cardinality(v_pictures) then
    raise exception 'slides_count' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from unnest(v_pictures) as wanted
    where not exists (
      select 1 from public.social_assets a
      where a.id = wanted and a.tenant_id = p_tenant_id and a.mime_type like 'image/%')
  ) then
    raise exception 'Picture not found' using errcode = 'P0002';
  end if;
  v_others := array(
    select x from unnest(v_post.asset_ids) with ordinality as t(x, n)
    where not (x = any (v_post.slide_asset_ids)) and not (x = any (v_pictures))
    order by n);
  if cardinality(v_pictures) + cardinality(v_others) > 10 then
    raise exception 'too_many_photos' using errcode = 'P0001';
  end if;
  update public.social_posts p
  set asset_ids = v_pictures || v_others, asset_id = v_pictures[1],
      slide_asset_ids = v_pictures, slides_drawn = p_key
  where p.id = p_post_id;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.set_social_post_slides(uuid, uuid, jsonb)',
    'public.attach_social_slide_pictures(uuid, uuid, text, uuid[])'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
