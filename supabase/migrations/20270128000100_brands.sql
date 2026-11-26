-- Brands: a workspace can have several, each with its own look and voice
-- (and, in the next migration, its own social accounts).
--
-- Why a small table AND the kit in `configs`, rather than one or the other:
--
--  * The kit itself (name, colours, voice, feel, logos) stays exactly what it
--    was: Zod-validated JSON in `configs` (module `brand`), written only
--    through `private.write_config`, so every change leaves a
--    `config_versions` row and the assistant's propose -> preview -> apply
--    path works on it unchanged (rule 4 and rule 5). The workspace's first
--    brand keeps the key `kit`, so every reader of `brand` / `kit` still
--    reads the same thing; each further brand's kit is `kit-<brand id>`.
--  * A brand also needs an identity other rows can point at and that can't
--    vanish underneath them: social accounts and posts name a brand. A list
--    inside a config can't be referenced, so the identity (id, name, slug,
--    which is the default, archived or not, which kit key) is this table,
--    with a foreign key that refuses to delete a brand anything points at.
--    No function deletes a brand at all; archiving puts one away.
--
-- Owners and admins add, rename, set the default and archive (the functions
-- below check that themselves). Members read. How many brands a plan allows
-- is decided in `lib/entitlements.ts` and checked by the server before it
-- calls `add_brand`; the database only holds a ceiling so nothing runs away.

create table public.brands (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'),
  -- Which `configs` row (module 'brand') holds this brand's kit.
  kit_key text not null check (kit_key = 'kit' or kit_key ~ '^kit-[0-9a-f-]{36}$'),
  is_default boolean not null default false,
  archived_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, slug),
  unique (tenant_id, kit_key),
  check (not (is_default and archived_at is not null))
);
-- One default per workspace.
create unique index brands_one_default_idx on public.brands (tenant_id) where is_default;
create index brands_tenant_idx on public.brands (tenant_id, created_at);

alter table public.brands enable row level security;
create policy "members read their brands" on public.brands
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));
revoke all on public.brands from public, anon, authenticated, service_role;
grant select on public.brands to authenticated, service_role;

create trigger brands_touch_updated_at
  before update on public.brands
  for each row execute function private.touch_updated_at();

-- A name as a slug: "Price Your Craft!" -> "price-your-craft".
create function private.brand_slug(p_name text)
returns text
language sql immutable set search_path = ''
as $$
  select coalesce(nullif(left(btrim(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g'), '-'), 40), ''), 'brand');
$$;
revoke all on function private.brand_slug(text) from public;

-- A slug of the workspace's own that no other brand there has.
create function private.free_brand_slug(p_tenant_id uuid, p_name text, p_except uuid default null)
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_base text := btrim(left(private.brand_slug(p_name), 34), '-');
  v_slug text := v_base;
  v_n int := 1;
begin
  if v_base = '' then
    v_base := 'brand';
    v_slug := v_base;
  end if;
  while exists (
    select 1 from public.brands b
    where b.tenant_id = p_tenant_id and b.slug = v_slug and b.id is distinct from p_except
  ) loop
    v_n := v_n + 1;
    v_slug := v_base || '-' || v_n;
  end loop;
  return v_slug;
end;
$$;
revoke all on function private.free_brand_slug(uuid, text, uuid) from public;

-- The workspace's default brand, made from its kit (or its own name) if it
-- has none yet. Every workspace has exactly one.
create function private.ensure_default_brand(p_tenant_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_name text;
begin
  select b.id into v_id from public.brands b where b.tenant_id = p_tenant_id and b.is_default;
  if v_id is not null then
    return v_id;
  end if;
  -- A workspace whose default was never set but which has brands: the oldest live one.
  select b.id into v_id from public.brands b
  where b.tenant_id = p_tenant_id and b.archived_at is null
  order by (b.kit_key = 'kit') desc, b.created_at
  limit 1;
  if v_id is not null then
    update public.brands b set is_default = true where b.id = v_id;
    return v_id;
  end if;
  select coalesce(nullif(btrim(c.body ->> 'name'), ''), t.name) into v_name
  from public.tenants t
  left join public.configs c on c.tenant_id = t.id and c.module = 'brand' and c.key = 'kit'
  where t.id = p_tenant_id;
  if v_name is null then
    return null;
  end if;
  insert into public.brands (tenant_id, name, slug, kit_key, is_default)
  values (p_tenant_id, left(btrim(v_name), 80), private.free_brand_slug(p_tenant_id, v_name), 'kit', true)
  on conflict (tenant_id, kit_key) do update set is_default = true
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function private.ensure_default_brand(uuid) from public;

-- Every new workspace starts with its one brand.
create function private.tenant_default_brand()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.ensure_default_brand(new.id);
  return new;
end;
$$;
revoke all on function private.tenant_default_brand() from public;
create trigger tenants_default_brand
  after insert on public.tenants
  for each row execute function private.tenant_default_brand();

-- Every workspace there is today gets its default brand, named after its kit.
do $$
declare
  v_tenant uuid;
begin
  for v_tenant in select t.id from public.tenants t loop
    perform private.ensure_default_brand(v_tenant);
  end loop;
end;
$$;

-- The kit key for a brand of this workspace (the default's when none is named).
create function private.brand_kit_key(p_tenant_id uuid, p_brand_id uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select b.kit_key from public.brands b
  where b.tenant_id = p_tenant_id
    and (b.id = p_brand_id or (p_brand_id is null and b.is_default));
$$;
revoke all on function private.brand_kit_key(uuid, uuid) from public;

-- ---------------------------------------------------------------------------
-- What owners and admins do
-- ---------------------------------------------------------------------------

-- Adds a brand. Its kit starts as `p_kit` (already checked by the server
-- against the kit schema) and is written like every other setting.
create function public.add_brand(p_tenant_id uuid, p_name text, p_kit jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_name text := left(btrim(coalesce(p_name, '')), 80);
begin
  perform private.require_manager(p_tenant_id);
  if v_name = '' then
    raise exception 'needs_name' using errcode = 'P0001';
  end if;
  if p_kit is null or jsonb_typeof(p_kit) <> 'object' then
    raise exception 'That setting is not valid' using errcode = '22023';
  end if;
  perform 1 from public.tenants t where t.id = p_tenant_id for update;
  perform private.ensure_default_brand(p_tenant_id);
  -- A ceiling well above any plan's allowance; the plan's own limit is the server's to check.
  if (select count(*) from public.brands b where b.tenant_id = p_tenant_id) >= 50 then
    raise exception 'too_many_brands' using errcode = 'P0001';
  end if;
  insert into public.brands (id, tenant_id, name, slug, kit_key, created_by)
  values (v_id, p_tenant_id, v_name, private.free_brand_slug(p_tenant_id, v_name),
          'kit-' || v_id::text, auth.uid());
  perform private.write_config(p_tenant_id, 'brand', 'kit-' || v_id::text,
    jsonb_set(p_kit, '{name}', to_jsonb(v_name)), 'manual', 'New brand');
  perform private.log_audit(p_tenant_id, 'brand.added', 'brand', v_id::text);
  return v_id;
end;
$$;

-- Renames a brand. The kit carries the name its designs are drawn with, so
-- it is renamed too, leaving a version row like any other change.
create function public.rename_brand(p_tenant_id uuid, p_brand_id uuid, p_name text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_brand public.brands;
  v_name text := left(btrim(coalesce(p_name, '')), 80);
  v_kit jsonb;
begin
  perform private.require_manager(p_tenant_id);
  if v_name = '' then
    raise exception 'needs_name' using errcode = 'P0001';
  end if;
  select * into v_brand from public.brands b
  where b.id = p_brand_id and b.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'Brand not found' using errcode = 'P0002';
  end if;
  update public.brands b
  set name = v_name, slug = private.free_brand_slug(p_tenant_id, v_name, b.id)
  where b.id = v_brand.id;
  select c.body into v_kit from public.configs c
  where c.tenant_id = p_tenant_id and c.module = 'brand' and c.key = v_brand.kit_key;
  if v_kit is not null and v_kit ->> 'name' is distinct from v_name then
    perform private.write_config(p_tenant_id, 'brand', v_brand.kit_key,
      jsonb_set(v_kit, '{name}', to_jsonb(v_name)), 'manual', 'Renamed');
  end if;
end;
$$;

-- Saves one brand's kit (the default's when no brand is named). The body has
-- been checked by the server against the kit schema.
create function public.save_brand_kit(p_tenant_id uuid, p_brand_id uuid, p_body jsonb)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_key text;
begin
  perform private.require_manager(p_tenant_id);
  perform private.ensure_default_brand(p_tenant_id);
  v_key := private.brand_kit_key(p_tenant_id, p_brand_id);
  if v_key is null then
    raise exception 'Brand not found' using errcode = 'P0002';
  end if;
  if p_body is null or jsonb_typeof(p_body) <> 'object'
     or btrim(coalesce(p_body ->> 'name', '')) = '' then
    raise exception 'That setting is not valid' using errcode = '22023';
  end if;
  -- The brand is called what its kit says.
  update public.brands b
  set name = left(btrim(p_body ->> 'name'), 80),
      slug = case when b.name = left(btrim(p_body ->> 'name'), 80) then b.slug
                  else private.free_brand_slug(p_tenant_id, p_body ->> 'name', b.id) end
  where b.tenant_id = p_tenant_id and b.kit_key = v_key;
  return private.write_config(p_tenant_id, 'brand', v_key, p_body, 'manual', null);
end;
$$;

create function public.set_default_brand(p_tenant_id uuid, p_brand_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  if not exists (
    select 1 from public.brands b
    where b.id = p_brand_id and b.tenant_id = p_tenant_id and b.archived_at is null
  ) then
    raise exception 'Brand not found' using errcode = 'P0002';
  end if;
  update public.brands b set is_default = false
  where b.tenant_id = p_tenant_id and b.is_default and b.id <> p_brand_id;
  update public.brands b set is_default = true where b.id = p_brand_id;
  perform private.log_audit(p_tenant_id, 'brand.default', 'brand', p_brand_id::text);
end;
$$;

-- Puts a brand away, or brings it back. The default can't be put away, and
-- nothing is ever deleted: posts and accounts that name it keep pointing at it.
create function public.archive_brand(p_tenant_id uuid, p_brand_id uuid, p_archived boolean default true)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_brand public.brands;
begin
  perform private.require_manager(p_tenant_id);
  select * into v_brand from public.brands b
  where b.id = p_brand_id and b.tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'Brand not found' using errcode = 'P0002';
  end if;
  if p_archived and v_brand.is_default then
    raise exception 'default_brand' using errcode = 'P0001';
  end if;
  update public.brands b
  set archived_at = case when p_archived then coalesce(b.archived_at, now()) end
  where b.id = v_brand.id;
  perform private.log_audit(p_tenant_id, case when p_archived then 'brand.archived' else 'brand.restored' end,
    'brand', p_brand_id::text);
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.add_brand(uuid, text, jsonb)',
    'public.rename_brand(uuid, uuid, text)',
    'public.save_brand_kit(uuid, uuid, jsonb)',
    'public.set_default_brand(uuid, uuid)',
    'public.archive_brand(uuid, uuid, boolean)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
