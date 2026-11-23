-- Designed pictures. A picture made in the designer (an email banner, a slide
-- for a post) is an ordinary asset: a JPEG or PNG in the workspace's folder.
-- What makes it special is that the design it was drawn from is kept beside
-- it, so the picture can be opened again and changed. The design is the
-- editor's own JSON (text, colours, which of the workspace's photos); the
-- server tidies and bounds it before it gets here, and this caps its size.

alter table public.social_assets
  add column design jsonb,
  add constraint social_assets_design_check check (
    design is null
    or (
      jsonb_typeof(design) = 'object'
      and mime_type like 'image/%'
      and octet_length(design::text) <= 200000
    )
  );

-- Keeps (or clears, with null) the design a picture was made from. Any member
-- of the workspace can, as with naming and tagging; the asset must be a
-- picture in the caller's own workspace. A designed picture is tagged so it
-- is easy to find.
create function public.set_social_asset_design(
  p_tenant_id uuid, p_asset_id uuid, p_design jsonb
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_member(p_tenant_id);
  if p_design is not null and (
    jsonb_typeof(p_design) <> 'object' or octet_length(p_design::text) > 200000
  ) then
    raise exception 'design_not_valid' using errcode = '22023';
  end if;
  update public.social_assets a
  set design = p_design,
      tags = case
        when p_design is null then a.tags
        else private.tidy_tags(a.tags || array['designed'])
      end
  where a.id = p_asset_id and a.tenant_id = p_tenant_id and a.mime_type like 'image/%';
  if not found then
    raise exception 'Picture not found' using errcode = 'P0002';
  end if;
end;
$$;
revoke all on function public.set_social_asset_design(uuid, uuid, jsonb) from public, anon;
grant execute on function public.set_social_asset_design(uuid, uuid, jsonb) to authenticated;
