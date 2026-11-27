-- Tools per person.
--
-- A workspace can choose which tools each member opens. Owners and admins
-- always have every tool the plan includes; a member has only the tools an
-- owner or admin ticked for them; Money is never a member's, whatever is
-- ticked. Home and Messages stay open to everyone.
--
-- Nothing changes until an owner or admin switches it on
-- (`tenants.tools_per_person`, off for every workspace, old and new). While
-- it is off every member keeps every tool, exactly as before.
--
-- This file holds the storage, the one predicate and the checked functions
-- that write. The next migrations put the predicate on the tools' tables.

-- ---------------------------------------------------------------------------
-- The switch
-- ---------------------------------------------------------------------------

-- Readable by members (the table grant is whole-table); changed only by
-- `set_tools_per_person`, since clients may update just name, timezone and
-- currency.
alter table public.tenants
  add column tools_per_person boolean not null default false;

-- ---------------------------------------------------------------------------
-- A member's tools
-- ---------------------------------------------------------------------------

-- One row per member whose list has been chosen (by an owner or admin, or by
-- the invite they accepted). No row means "never chosen": while the switch is
-- on that member has no tools, and switching it on gives them the plan's
-- tools so nobody is locked out mid-day.
create table public.member_tools (
  tenant_id uuid not null,
  user_id uuid not null,
  tools text[] not null default '{}',
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id),
  foreign key (tenant_id, user_id)
    references public.memberships (tenant_id, user_id) on delete cascade,
  constraint member_tools_known check (
    tools <@ array['helpdesk', 'bookings', 'social', 'stock', 'shipping']::text[]
  )
);

alter table public.member_tools enable row level security;

-- A person reads their own list; owners and admins read everyone's.
create policy "people read their own tools, managers everyone's" on public.member_tools
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or private.has_tenant_role(tenant_id, array['owner', 'admin']::public.membership_role[])
  );

revoke all on public.member_tools from public, anon, authenticated, service_role;
grant select on public.member_tools to authenticated;
grant all on public.member_tools to service_role;

-- An invite carries the tools ticked on it. Null: nothing was chosen (made
-- before this, or while the switch was off), so accepting writes no list.
alter table public.invites add column tools text[];
alter table public.invites add constraint invites_tools_known check (
  tools is null or tools <@ array['helpdesk', 'bookings', 'social', 'stock', 'shipping']::text[]
);
grant select (tools) on public.invites to authenticated;

-- ---------------------------------------------------------------------------
-- The predicate
-- ---------------------------------------------------------------------------

-- The whole rule, as a pure function of its facts. Its TypeScript twin is
-- `toolAllowed` in src/lib/team/tools.ts; tests/db/member-tools.test.ts holds
-- the two equal over every combination.
--   p_tools null: no list has been chosen for this person.
create function private.tool_allowed(
  p_role public.membership_role, p_on boolean, p_tools text[], p_tool text
)
returns boolean
language sql immutable set search_path = ''
as $$
  select case
    when p_role is null then false
    -- Home and Messages are everyone's.
    when p_tool = 'messages' then true
    when p_role in ('owner', 'admin') then true
    when not coalesce(p_on, false) then true
    -- Money is for owners and admins only, whatever is ticked.
    when p_tool = 'dashboard' then false
    else coalesce(p_tool = any (p_tools), false)
  end;
$$;

-- Whether the signed-in person may use a tool in a workspace. False for
-- anyone who isn't a member, and for no signed-in person at all.
create function private.can_use_tool(p_tenant_id uuid, p_tool text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select private.tool_allowed(m.role, t.tools_per_person, mt.tools, p_tool)
    from public.memberships m
    join public.tenants t on t.id = m.tenant_id
    left join public.member_tools mt on mt.tenant_id = m.tenant_id and mt.user_id = m.user_id
    where m.tenant_id = p_tenant_id and m.user_id = (select auth.uid())
  ), false);
$$;

-- The workspaces where the signed-in person may use any of these tools: for
-- row-level security, the same shape as `private.user_tenant_ids()` so the
-- planner reads it once per query.
create function private.tool_tenant_ids(p_tools text[])
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select m.tenant_id
  from public.memberships m
  join public.tenants t on t.id = m.tenant_id
  left join public.member_tools mt on mt.tenant_id = m.tenant_id and mt.user_id = m.user_id
  where m.user_id = (select auth.uid())
    and exists (
      select 1 from unnest(p_tools) as wanted (tool)
      where private.tool_allowed(m.role, t.tools_per_person, mt.tools, wanted.tool)
    );
$$;

-- What the business pays and what it earns in margin: owners and admins
-- always; members only while the switch is off.
create function private.can_see_costs(p_tenant_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select m.role in ('owner', 'admin') or not t.tools_per_person
    from public.memberships m
    join public.tenants t on t.id = m.tenant_id
    where m.tenant_id = p_tenant_id and m.user_id = (select auth.uid())
  ), false);
$$;

-- For checked functions: refuse a person who can't use the tool.
create function private.require_tool(p_tenant_id uuid, p_tool text)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if p_tenant_id is null or not private.can_use_tool(p_tenant_id, p_tool) then
    raise exception 'That tool isn''t open to you in this workspace' using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.tool_allowed(public.membership_role, boolean, text[], text) from public;
revoke all on function private.can_use_tool(uuid, text) from public;
revoke all on function private.tool_tenant_ids(text[]) from public;
revoke all on function private.can_see_costs(uuid) from public;
revoke all on function private.require_tool(uuid, text) from public;
grant execute on function private.tool_allowed(public.membership_role, boolean, text[], text)
  to authenticated, service_role;
grant execute on function private.can_use_tool(uuid, text) to authenticated, service_role;
grant execute on function private.tool_tenant_ids(text[]) to authenticated, service_role;
grant execute on function private.can_see_costs(uuid) to authenticated, service_role;
grant execute on function private.require_tool(uuid, text) to authenticated, service_role;

-- Cleans a list a person ticked: known tools only, once each, in a steady
-- order. Money is refused rather than dropped, so nobody thinks it was given.
create function private.clean_member_tools(p_tools text[])
returns text[]
language plpgsql immutable set search_path = ''
as $$
declare
  v_known constant text[] := array['helpdesk', 'bookings', 'social', 'stock', 'shipping'];
begin
  if p_tools is null then
    return null;
  end if;
  if 'dashboard' = any (p_tools) then
    raise exception 'Money is for owners and admins only. Make this person an admin instead.'
      using errcode = '22023';
  end if;
  if exists (select 1 from unnest(p_tools) as t (tool) where not (t.tool = any (v_known))) then
    raise exception 'That isn''t a tool we know' using errcode = '22023';
  end if;
  return array(select k from unnest(v_known) with ordinality as k (k, n)
               where k = any (p_tools) order by n);
end;
$$;
revoke all on function private.clean_member_tools(text[]) from public;

-- ---------------------------------------------------------------------------
-- Writing, owners and admins only
-- ---------------------------------------------------------------------------

-- Switches "choose which tools each person can open" on or off. Switching on
-- gives every member with no chosen list `p_tools` (the plan's tools, which
-- the app works out): they keep what they could open a moment ago.
create function public.set_tools_per_person(p_tenant_id uuid, p_on boolean, p_tools text[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_was boolean;
  v_seed text[] := coalesce(private.clean_member_tools(p_tools), '{}');
  v_seeded int := 0;
begin
  perform private.require_manager(p_tenant_id);
  if p_on is null then
    raise exception 'Say whether it is on or off' using errcode = '22023';
  end if;
  select t.tools_per_person into v_was from public.tenants t where t.id = p_tenant_id for update;
  if v_was is not distinct from p_on then
    return;
  end if;
  if p_on then
    insert into public.member_tools (tenant_id, user_id, tools, updated_by)
    select m.tenant_id, m.user_id, v_seed, auth.uid()
    from public.memberships m
    where m.tenant_id = p_tenant_id and m.role = 'member'
    on conflict (tenant_id, user_id) do nothing;
    get diagnostics v_seeded = row_count;
  end if;
  update public.tenants t set tools_per_person = p_on where t.id = p_tenant_id;
  perform private.log_audit(p_tenant_id, 'team.tools_per_person', 'tenant', p_tenant_id::text,
    jsonb_build_object('on', p_on, 'given_tools', v_seeded, 'tools', to_jsonb(v_seed)));
end;
$$;

-- Chooses one member's tools. Owners and admins always have every tool, so
-- their list can't be set; nor can anyone set their own.
create function public.set_member_tools(p_tenant_id uuid, p_user_id uuid, p_tools text[])
returns text[]
language plpgsql security definer set search_path = ''
as $$
declare
  v_role public.membership_role;
  v_tools text[] := private.clean_member_tools(coalesce(p_tools, '{}'));
  v_before text[];
begin
  perform private.require_manager(p_tenant_id);
  if p_user_id = auth.uid() then
    raise exception 'Someone else on the team chooses your tools' using errcode = '42501';
  end if;
  select m.role into v_role from public.memberships m
  where m.tenant_id = p_tenant_id and m.user_id = p_user_id
  for update;
  if not found then
    raise exception 'That person isn''t on the team' using errcode = 'P0002';
  end if;
  if v_role <> 'member' then
    raise exception 'Owners and admins always have every tool' using errcode = '22023';
  end if;
  select mt.tools into v_before from public.member_tools mt
  where mt.tenant_id = p_tenant_id and mt.user_id = p_user_id;
  insert into public.member_tools (tenant_id, user_id, tools, updated_by, updated_at)
  values (p_tenant_id, p_user_id, v_tools, auth.uid(), now())
  on conflict (tenant_id, user_id) do update
    set tools = excluded.tools, updated_by = excluded.updated_by, updated_at = now();
  if v_before is distinct from v_tools then
    perform private.log_audit(p_tenant_id, 'team.member_tools', 'user', p_user_id::text,
      jsonb_build_object('before', to_jsonb(v_before), 'after', to_jsonb(v_tools)));
  end if;
  return v_tools;
end;
$$;

-- An invite with the tools ticked on it. `p_tools` null means nothing was
-- chosen (the switch is off); an admin's invite carries none, since admins
-- have every tool.
create function public.create_team_invite(
  p_tenant_id uuid, p_email text, p_role public.membership_role, p_tools text[]
)
returns table (invite_id uuid, token text, expires_at timestamptz)
language plpgsql security definer set search_path = ''
as $$
declare
  v_tools text[] := private.clean_member_tools(p_tools);
  v_id uuid;
  v_token text;
  v_expires timestamptz;
begin
  select i.invite_id, i.token, i.expires_at into v_id, v_token, v_expires
  from public.create_invite(p_tenant_id, p_email, coalesce(p_role, 'member')) i;
  if coalesce(p_role, 'member') = 'member' and v_tools is not null then
    update public.invites i set tools = v_tools where i.id = v_id;
  end if;
  return query select v_id, v_token, v_expires;
end;
$$;

-- What the app needs to decide this person's tools: their role, the switch,
-- and their list (null when never chosen).
create function public.my_tool_access(p_tenant_id uuid)
returns table (role public.membership_role, tools_on boolean, tools text[])
language sql stable security definer set search_path = ''
as $$
  select m.role, t.tools_per_person, mt.tools
  from public.memberships m
  join public.tenants t on t.id = m.tenant_id
  left join public.member_tools mt on mt.tenant_id = m.tenant_id and mt.user_id = m.user_id
  where m.tenant_id = p_tenant_id and m.user_id = (select auth.uid());
$$;

revoke all on function public.set_tools_per_person(uuid, boolean, text[]) from public, anon;
revoke all on function public.set_member_tools(uuid, uuid, text[]) from public, anon;
revoke all on function public.create_team_invite(uuid, text, public.membership_role, text[])
  from public, anon;
revoke all on function public.my_tool_access(uuid) from public, anon;
grant execute on function public.set_tools_per_person(uuid, boolean, text[]) to authenticated;
grant execute on function public.set_member_tools(uuid, uuid, text[]) to authenticated;
grant execute on function public.create_team_invite(uuid, text, public.membership_role, text[])
  to authenticated;
grant execute on function public.my_tool_access(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Accepting an invite applies its tools
-- ---------------------------------------------------------------------------

-- As before, and a member's invite that carries tools writes their list.
create or replace function private.accept_invite_row(p_invite public.invites)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_user_email text;
  v_slug text;
  v_joined boolean;
begin
  if v_uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  if p_invite.revoked_at is not null then
    raise exception 'This invite was withdrawn' using errcode = '22023';
  end if;
  if p_invite.accepted_at is not null then
    raise exception 'This invite has already been used' using errcode = '22023';
  end if;
  if p_invite.expires_at <= now() then
    raise exception 'This invite has expired' using errcode = '22023';
  end if;

  select lower(u.email) into v_user_email from auth.users u where u.id = v_uid;
  if v_user_email is distinct from p_invite.email then
    raise exception 'This invite was sent to a different email address' using errcode = '42501';
  end if;

  insert into public.memberships (tenant_id, user_id, role)
  values (p_invite.tenant_id, v_uid, p_invite.role)
  on conflict (tenant_id, user_id) do nothing;
  v_joined := found;

  -- Only for someone who joined just now as a member: an invite never
  -- changes the tools of a person already on the team.
  if v_joined and p_invite.role = 'member' and p_invite.tools is not null then
    insert into public.member_tools (tenant_id, user_id, tools, updated_by)
    values (p_invite.tenant_id, v_uid, p_invite.tools, p_invite.invited_by)
    on conflict (tenant_id, user_id) do nothing;
  end if;

  update public.invites i set accepted_at = now(), accepted_by = v_uid where i.id = p_invite.id;

  perform private.log_audit(p_invite.tenant_id, 'invite.accepted', 'invite', p_invite.id::text,
    jsonb_build_object('email', p_invite.email, 'role', p_invite.role,
                       'tools', to_jsonb(p_invite.tools)));

  select t.slug into v_slug from public.tenants t where t.id = p_invite.tenant_id;
  return v_slug;
end;
$$;

revoke all on function private.accept_invite_row(public.invites) from public;
