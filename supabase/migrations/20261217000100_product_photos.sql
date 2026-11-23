-- Product photos from the shop. The sync notes each product's main photo and
-- its page in the shop on the items it mirrors; a person can then copy those
-- photos into the workspace's Assets, where posts and emails pick them up by
-- tag. Each product's photo is copied once: the asset remembers where it
-- came from.

alter table public.stock_items
  add column image_url text check (image_url is null or image_url ~ '^https://'),
  -- The product's page in the shop, for linking to it from an email.
  add column product_url text check (product_url is null or product_url ~ '^https://');

alter table public.social_assets
  -- e.g. shopify:product:8123456789012. Null for anything a person added.
  add column source_ref text check (source_ref is null or char_length(source_ref) <= 120);
create unique index social_assets_source_ref_idx
  on public.social_assets (tenant_id, source_ref) where source_ref is not null;

-- Sync (service role, one named workspace): what each product looks like and
-- where it lives. Touches nothing else on the items.
create function public.set_product_photos(p_tenant_id uuid, p_provider text, p_products jsonb)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  update public.stock_items si
  set image_url = case when p.image_url ~ '^https://' then left(p.image_url, 1000) end,
      product_url = case when p.product_url ~ '^https://' then left(p.product_url, 1000) end
  from jsonb_to_recordset(coalesce(p_products, '[]'::jsonb)) as p(
    product_external_id text, image_url text, product_url text)
  where si.tenant_id = p_tenant_id and si.provider = p_provider
    and si.product_external_id = p.product_external_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.set_product_photos(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.set_product_photos(uuid, text, jsonb) to service_role;

-- Records a product photo the server has just copied into the workspace's
-- folder. Returns null when that product's photo is already in the library,
-- so the same photo is never added twice.
create function public.register_product_photo(
  p_tenant_id uuid, p_storage_path text, p_mime_type text, p_bytes int, p_created_by uuid,
  p_title text, p_tags text[], p_source_ref text
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
  if nullif(btrim(coalesce(p_source_ref, '')), '') is null then
    raise exception 'A source is needed' using errcode = '22023';
  end if;
  insert into public.social_assets
    (tenant_id, storage_path, mime_type, bytes, created_by, title, tags, source_ref)
  values (p_tenant_id, p_storage_path, p_mime_type, p_bytes, p_created_by,
          left(btrim(coalesce(p_title, '')), 120), private.tidy_tags(p_tags), btrim(p_source_ref))
  on conflict (tenant_id, source_ref) where source_ref is not null do nothing
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.register_product_photo(uuid, text, text, int, uuid, text, text[], text)
  from public, anon, authenticated;
grant execute on function public.register_product_photo(uuid, text, text, int, uuid, text, text[], text)
  to service_role;
