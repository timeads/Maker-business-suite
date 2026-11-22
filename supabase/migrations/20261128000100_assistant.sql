-- Phase 7: the assistant's write path.
-- Every change to a setting now leaves a version behind (config_versions),
-- so anything can be put back. The assistant never changes a setting itself:
-- it files a proposal (config_proposals), a person previews it, and an owner
-- or admin applies it.

create table public.config_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  module text not null,
  key text not null,
  version int not null,
  body jsonb not null,
  source text not null check (source in ('manual', 'assistant', 'restore')),
  note text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, module, key, version)
);

create table public.config_proposals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  module text not null,
  key text not null,
  body jsonb not null,
  summary text not null check (char_length(summary) between 1 and 500),
  status text not null default 'pending' check (status in ('pending', 'applied', 'dismissed')),
  created_by uuid references auth.users (id) on delete set null,
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index config_proposals_pending_idx on public.config_proposals (tenant_id, created_at desc)
  where status = 'pending';

alter table public.config_versions enable row level security;
alter table public.config_proposals enable row level security;

create policy "members read their config versions" on public.config_versions
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));
create policy "members read their config proposals" on public.config_proposals
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));

revoke all on public.config_versions, public.config_proposals
  from public, anon, authenticated, service_role;
grant select on public.config_versions, public.config_proposals to authenticated, service_role;

-- The one place a setting is written, whoever asked for it.
create function private.write_config(
  p_tenant_id uuid, p_module text, p_key text, p_body jsonb, p_source text, p_note text
)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_version int;
begin
  if p_module !~ '^[a-z_]{1,40}$' or p_key !~ '^[a-z0-9_-]{1,60}$' or jsonb_typeof(p_body) <> 'object' then
    raise exception 'That setting is not valid' using errcode = '22023';
  end if;

  insert into public.configs (tenant_id, module, key, body, updated_by)
  values (p_tenant_id, p_module, p_key, p_body, auth.uid())
  on conflict (tenant_id, module, key) do update
    set body = excluded.body, updated_by = excluded.updated_by;

  -- The upsert above holds the row lock, so version numbers can't collide.
  select coalesce(max(v.version), 0) + 1 into v_version
  from public.config_versions v
  where v.tenant_id = p_tenant_id and v.module = p_module and v.key = p_key;

  insert into public.config_versions (tenant_id, module, key, version, body, source, note, created_by)
  values (p_tenant_id, p_module, p_key, v_version, p_body, p_source, p_note, auth.uid());

  perform private.log_audit(p_tenant_id, 'config.saved', 'config', p_module || '/' || p_key);
  return v_version;
end;
$$;
revoke all on function private.write_config(uuid, text, text, jsonb, text, text) from public;

create or replace function public.save_config(p_tenant_id uuid, p_module text, p_key text, p_body jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  perform private.write_config(p_tenant_id, p_module, p_key, p_body, 'manual', null);
end;
$$;

-- Files a suggested change. Any member can (the assistant acts as the member
-- talking to it); nothing changes until an owner or admin applies it.
create function public.propose_config_change(
  p_tenant_id uuid, p_module text, p_key text, p_body jsonb, p_summary text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not (p_tenant_id in (select private.user_tenant_ids())) then
    raise exception 'Workspace not found' using errcode = '42501';
  end if;
  if p_module !~ '^[a-z_]{1,40}$' or p_key !~ '^[a-z0-9_-]{1,60}$' or jsonb_typeof(p_body) <> 'object' then
    raise exception 'That setting is not valid' using errcode = '22023';
  end if;
  insert into public.config_proposals (tenant_id, module, key, body, summary, created_by)
  values (p_tenant_id, p_module, p_key, p_body, left(btrim(p_summary), 500), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

-- Applies a pending proposal exactly once. Returns the new version number.
create function public.apply_config_proposal(p_proposal_id uuid)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_proposal public.config_proposals;
begin
  select * into v_proposal from public.config_proposals p where p.id = p_proposal_id for update;
  if not found or not (v_proposal.tenant_id in (select private.user_tenant_ids())) then
    raise exception 'Proposal not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_proposal.tenant_id);
  if v_proposal.status <> 'pending' then
    raise exception 'already_decided' using errcode = 'P0001';
  end if;
  update public.config_proposals p
  set status = 'applied', decided_by = auth.uid(), decided_at = now()
  where p.id = p_proposal_id;
  return private.write_config(v_proposal.tenant_id, v_proposal.module, v_proposal.key,
                              v_proposal.body, 'assistant', v_proposal.summary);
end;
$$;

create function public.dismiss_config_proposal(p_proposal_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.config_proposals p
  set status = 'dismissed', decided_by = auth.uid(), decided_at = now()
  where p.id = p_proposal_id and p.status = 'pending'
    and p.tenant_id in (select private.user_tenant_ids())
    and (p.created_by = auth.uid()
         or private.has_tenant_role(p.tenant_id, array['owner', 'admin']::public.membership_role[]));
end;
$$;

-- Puts a setting back to how an earlier version had it (as a new version).
create function public.restore_config_version(p_version_id uuid)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_old public.config_versions;
begin
  select * into v_old from public.config_versions v where v.id = p_version_id;
  if not found or not (v_old.tenant_id in (select private.user_tenant_ids())) then
    raise exception 'Version not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_old.tenant_id);
  return private.write_config(v_old.tenant_id, v_old.module, v_old.key, v_old.body, 'restore',
                              'Restored version ' || v_old.version);
end;
$$;

revoke all on function public.propose_config_change(uuid, text, text, jsonb, text) from public, anon;
revoke all on function public.apply_config_proposal(uuid) from public, anon;
revoke all on function public.dismiss_config_proposal(uuid) from public, anon;
revoke all on function public.restore_config_version(uuid) from public, anon;
grant execute on function public.propose_config_change(uuid, text, text, jsonb, text) to authenticated;
grant execute on function public.apply_config_proposal(uuid) to authenticated;
grant execute on function public.dismiss_config_proposal(uuid) to authenticated;
grant execute on function public.restore_config_version(uuid) to authenticated;
