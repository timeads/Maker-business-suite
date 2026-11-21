-- Phase 1: tenancy foundation.
-- tenants, memberships, invites, audit_log, each with RLS limiting rows to
-- members of the tenant. All writes that cross a trust boundary go through
-- SECURITY DEFINER functions; clients get no direct insert/delete grants.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

create type public.membership_role as enum ('owner', 'admin', 'member');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  slug text not null unique
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 2 and 48),
  timezone text not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The source of truth for RLS: who belongs to which tenant, and as what.
create table public.memberships (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.membership_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index memberships_user_id_idx on public.memberships (user_id);

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  email text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role public.membership_role not null default 'member' check (role <> 'owner'),
  -- sha256 of the emailed token; the raw token is never stored.
  token_hash text not null unique,
  invited_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index invites_tenant_id_idx on public.invites (tenant_id);
-- One open invite per email per tenant.
create unique index invites_one_open_per_email
  on public.invites (tenant_id, email)
  where accepted_at is null and revoked_at is null;

-- Append-only. Written only by the functions below.
create table public.audit_log (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  actor_id uuid references auth.users (id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_tenant_created_idx on public.audit_log (tenant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS helpers (SECURITY DEFINER so policies on memberships don't recurse)
-- ---------------------------------------------------------------------------

create function private.user_tenant_ids()
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select m.tenant_id from public.memberships m where m.user_id = (select auth.uid());
$$;

create function private.has_tenant_role(p_tenant_id uuid, p_roles public.membership_role[])
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.tenant_id = p_tenant_id
      and m.user_id = (select auth.uid())
      and m.role = any (p_roles)
  );
$$;

create function private.log_audit(
  p_tenant_id uuid,
  p_action text,
  p_target_type text default null,
  p_target_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
  values (p_tenant_id, (select auth.uid()), p_action, p_target_type, p_target_id, coalesce(p_metadata, '{}'::jsonb));
$$;

revoke all on function private.user_tenant_ids() from public;
revoke all on function private.has_tenant_role(uuid, public.membership_role[]) from public;
revoke all on function private.log_audit(uuid, text, text, text, jsonb) from public;
grant execute on function private.user_tenant_ids() to authenticated, service_role;
grant execute on function private.has_tenant_role(uuid, public.membership_role[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Tenant validation + audit trigger
-- ---------------------------------------------------------------------------

create function private.tenants_before_write()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.name := btrim(new.name);
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'Unknown timezone: %', new.timezone using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger tenants_before_write
  before insert or update on public.tenants
  for each row execute function private.tenants_before_write();

create function private.tenants_after_update()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if (new.name, new.timezone, new.currency) is distinct from (old.name, old.timezone, old.currency) then
    perform private.log_audit(
      new.id, 'tenant.updated', 'tenant', new.id::text,
      jsonb_build_object(
        'before', jsonb_build_object('name', old.name, 'timezone', old.timezone, 'currency', old.currency),
        'after', jsonb_build_object('name', new.name, 'timezone', new.timezone, 'currency', new.currency)
      )
    );
  end if;
  return null;
end;
$$;

create trigger tenants_after_update
  after update on public.tenants
  for each row execute function private.tenants_after_update();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.tenants enable row level security;
alter table public.memberships enable row level security;
alter table public.invites enable row level security;
alter table public.audit_log enable row level security;

create policy "members read their tenants" on public.tenants
  for select to authenticated
  using (id in (select private.user_tenant_ids()));

create policy "owners and admins update their tenant" on public.tenants
  for update to authenticated
  using (private.has_tenant_role(id, array['owner', 'admin']::public.membership_role[]))
  with check (private.has_tenant_role(id, array['owner', 'admin']::public.membership_role[]));

create policy "members read memberships of their tenants" on public.memberships
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));

create policy "owners and admins read invites" on public.invites
  for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin']::public.membership_role[]));

create policy "owners and admins read audit log" on public.audit_log
  for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin']::public.membership_role[]));

-- ---------------------------------------------------------------------------
-- Grants: least privilege. Start from nothing, then add what the app needs.
-- ---------------------------------------------------------------------------

revoke all on public.tenants, public.memberships, public.invites, public.audit_log
  from public, anon, authenticated, service_role;

grant select on public.tenants to authenticated;
grant update (name, timezone, currency) on public.tenants to authenticated;
grant select on public.memberships to authenticated;
-- token_hash is deliberately not readable.
grant select (id, tenant_id, email, role, invited_by, expires_at, accepted_at, accepted_by, revoked_at, created_at)
  on public.invites to authenticated;
grant select on public.audit_log to authenticated;

grant all on public.tenants, public.memberships, public.invites to service_role;
-- Append-only, even for the service role.
grant select, insert on public.audit_log to service_role;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Create a workspace and make the caller its owner.
create function public.create_tenant(p_name text, p_timezone text, p_currency text)
returns public.tenants
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_base text;
  v_slug text;
  v_tenant public.tenants;
  v_attempt int := 0;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;

  v_base := btrim(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g'), '-');
  v_base := btrim(left(v_base, 40), '-');
  if char_length(v_base) < 2 then
    v_base := 'workspace';
  end if;
  v_slug := v_base;

  loop
    begin
      insert into public.tenants (name, slug, timezone, currency, created_by)
      values (p_name, v_slug, p_timezone, upper(p_currency), v_uid)
      returning * into v_tenant;
      exit;
    exception when unique_violation then
      v_attempt := v_attempt + 1;
      if v_attempt > 10 then
        raise exception 'Could not find a free address for this workspace';
      end if;
      v_slug := v_base || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 5);
    end;
  end loop;

  insert into public.memberships (tenant_id, user_id, role) values (v_tenant.id, v_uid, 'owner');
  perform private.log_audit(v_tenant.id, 'tenant.created', 'tenant', v_tenant.id::text,
    jsonb_build_object('name', v_tenant.name));
  return v_tenant;
end;
$$;

-- Invite someone by email. Returns the raw token exactly once.
create function public.create_invite(p_tenant_id uuid, p_email text, p_role public.membership_role default 'member')
returns table (invite_id uuid, token text, expires_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_token text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_invite public.invites;
begin
  if not private.has_tenant_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]) then
    raise exception 'Only owners and admins can invite people' using errcode = '42501';
  end if;
  if p_role = 'owner' then
    raise exception 'Invites cannot grant the owner role' using errcode = '22023';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'That email address does not look right' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.memberships m
    join auth.users u on u.id = m.user_id
    where m.tenant_id = p_tenant_id and lower(u.email) = v_email
  ) then
    raise exception 'That person is already on the team' using errcode = '23505';
  end if;

  -- A fresh invite replaces any open one for the same address.
  update public.invites i set revoked_at = now()
  where i.tenant_id = p_tenant_id and i.email = v_email
    and i.accepted_at is null and i.revoked_at is null;

  insert into public.invites (tenant_id, email, role, token_hash, invited_by)
  values (p_tenant_id, v_email, p_role, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), auth.uid())
  returning * into v_invite;

  perform private.log_audit(p_tenant_id, 'invite.created', 'invite', v_invite.id::text,
    jsonb_build_object('email', v_email, 'role', p_role));

  return query select v_invite.id, v_token, v_invite.expires_at;
end;
$$;

create function public.revoke_invite(p_invite_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_invite public.invites;
begin
  select * into v_invite from public.invites i where i.id = p_invite_id for update;
  if not found
     or not private.has_tenant_role(v_invite.tenant_id, array['owner', 'admin']::public.membership_role[]) then
    -- Same error either way, so invite ids in other tenants can't be probed.
    raise exception 'Invite not found' using errcode = 'P0002';
  end if;
  if v_invite.accepted_at is not null or v_invite.revoked_at is not null then
    return;
  end if;
  update public.invites i set revoked_at = now() where i.id = p_invite_id;
  perform private.log_audit(v_invite.tenant_id, 'invite.revoked', 'invite', v_invite.id::text,
    jsonb_build_object('email', v_invite.email));
end;
$$;

-- What an invite link points at, for the signed-in person holding the token.
create function public.get_invite(p_token text)
returns table (tenant_name text, tenant_slug text, email text, role public.membership_role, status text)
language sql stable security definer set search_path = ''
as $$
  select t.name, t.slug, i.email, i.role,
    case
      when i.accepted_at is not null then 'accepted'
      when i.revoked_at is not null then 'revoked'
      when i.expires_at <= now() then 'expired'
      else 'open'
    end
  from public.invites i
  join public.tenants t on t.id = i.tenant_id
  where (select auth.uid()) is not null
    and i.token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
$$;

-- Join a workspace. The signed-in user's email must match the invite.
create function public.accept_invite(p_token text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_user_email text;
  v_invite public.invites;
  v_slug text;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;

  select * into v_invite from public.invites i
  where i.token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
  for update;

  if not found then
    raise exception 'This invite link is not valid' using errcode = 'P0002';
  end if;
  if v_invite.revoked_at is not null then
    raise exception 'This invite was withdrawn' using errcode = '22023';
  end if;
  if v_invite.accepted_at is not null then
    raise exception 'This invite has already been used' using errcode = '22023';
  end if;
  if v_invite.expires_at <= now() then
    raise exception 'This invite has expired' using errcode = '22023';
  end if;

  select lower(u.email) into v_user_email from auth.users u where u.id = v_uid;
  if v_user_email is distinct from v_invite.email then
    raise exception 'This invite was sent to a different email address' using errcode = '42501';
  end if;

  insert into public.memberships (tenant_id, user_id, role)
  values (v_invite.tenant_id, v_uid, v_invite.role)
  on conflict (tenant_id, user_id) do nothing;

  update public.invites i set accepted_at = now(), accepted_by = v_uid where i.id = v_invite.id;

  perform private.log_audit(v_invite.tenant_id, 'invite.accepted', 'invite', v_invite.id::text,
    jsonb_build_object('email', v_invite.email, 'role', v_invite.role));

  select t.slug into v_slug from public.tenants t where t.id = v_invite.tenant_id;
  return v_slug;
end;
$$;

-- Team roster with emails (auth.users is not readable by clients).
create function public.list_members(p_tenant_id uuid)
returns table (user_id uuid, email text, role public.membership_role, joined_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select m.user_id, u.email::text, m.role, m.created_at
  from public.memberships m
  join auth.users u on u.id = m.user_id
  where m.tenant_id = p_tenant_id
    and p_tenant_id in (select private.user_tenant_ids())
  order by m.created_at;
$$;

revoke all on function public.create_tenant(text, text, text) from public, anon;
revoke all on function public.create_invite(uuid, text, public.membership_role) from public, anon;
revoke all on function public.revoke_invite(uuid) from public, anon;
revoke all on function public.get_invite(text) from public, anon;
revoke all on function public.accept_invite(text) from public, anon;
revoke all on function public.list_members(uuid) from public, anon;

grant execute on function public.create_tenant(text, text, text) to authenticated;
grant execute on function public.create_invite(uuid, text, public.membership_role) to authenticated;
grant execute on function public.revoke_invite(uuid) to authenticated;
grant execute on function public.get_invite(text) to authenticated;
grant execute on function public.accept_invite(text) to authenticated;
grant execute on function public.list_members(uuid) to authenticated;
