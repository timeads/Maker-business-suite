-- Video posts. A post can now carry a video, on its own: one video, no
-- photos beside it (that is what both networks take). The trigger that kept
-- videos off posts altogether now only enforces that.
create or replace function private.social_post_photos_only()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_assets uuid[] := array(
    select distinct x from unnest(new.asset_ids || new.asset_id) as x where x is not null);
begin
  if cardinality(v_assets) > 1 and exists (
    select 1 from public.social_assets a
    where a.id = any (v_assets) and a.mime_type like 'video/%'
  ) then
    raise exception 'video_alone' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
