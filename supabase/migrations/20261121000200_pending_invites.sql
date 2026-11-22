-- Lets a signed-in person see and accept invites sent to their email address
-- without needing the original link.

-- Shared by both ways of accepting. Expects the invite row to be locked.
create function private.accept_invite_row(p_invite public.invites)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_user_email text;
  v_slug text;
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

  update public.invites i set accepted_at = now(), accepted_by = v_uid where i.id = p_invite.id;

  perform private.log_audit(p_invite.tenant_id, 'invite.accepted', 'invite', p_invite.id::text,
    jsonb_build_object('email', p_invite.email, 'role', p_invite.role));

  select t.slug into v_slug from public.tenants t where t.id = p_invite.tenant_id;
  return v_slug;
end;
$$;

revoke all on function private.accept_invite_row(public.invites) from public;

create or replace function public.accept_invite(p_token text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_invite public.invites;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  select * into v_invite from public.invites i
  where i.token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex')
  for update;
  if not found then
    raise exception 'This invite link is not valid' using errcode = 'P0002';
  end if;
  return private.accept_invite_row(v_invite);
end;
$$;

-- Open invites addressed to the signed-in person's own email.
create function public.my_pending_invites()
returns table (invite_id uuid, tenant_name text, role public.membership_role, expires_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select i.id, t.name, i.role, i.expires_at
  from public.invites i
  join public.tenants t on t.id = i.tenant_id
  join auth.users u on u.id = (select auth.uid())
  where i.email = lower(u.email)
    and i.accepted_at is null
    and i.revoked_at is null
    and i.expires_at > now()
  order by i.created_at;
$$;

-- Accepts one of those invites. The email check is what authorises it, so an
-- invite id for someone else's address is treated as not found.
create function public.accept_invite_by_id(p_invite_id uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_invite public.invites;
  v_user_email text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  select lower(u.email) into v_user_email from auth.users u where u.id = auth.uid();
  select * into v_invite from public.invites i
  where i.id = p_invite_id and i.email = v_user_email
  for update;
  if not found then
    raise exception 'This invite is not valid' using errcode = 'P0002';
  end if;
  return private.accept_invite_row(v_invite);
end;
$$;

revoke all on function public.my_pending_invites() from public, anon;
revoke all on function public.accept_invite_by_id(uuid) from public, anon;
grant execute on function public.my_pending_invites() to authenticated;
grant execute on function public.accept_invite_by_id(uuid) to authenticated;
