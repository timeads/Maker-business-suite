-- The assistant's proposals for things that are NOT settings: a debt's
-- rate or payment, whether a liability in the books is a debt, which plan
-- pays a debt, hiding a liability from the list. They follow the same road
-- as `config_proposals` (CLAUDE.md rule 5): the assistant only files a row,
-- a person sees a preview, and an owner or admin applies it. Applying is
-- done by the app AS THAT PERSON through the existing checked function
-- (`save_money_debt`, `choose_book_liability`, `cover_money_debt`,
-- `hide_book_liability`); nothing here writes a debt.
--
-- Every kind so far is about debts, which are for OWNERS AND ADMINS ONLY:
-- only they can file, read, apply or dismiss one. `private.action_owners_only`
-- says which kinds are theirs; a later kind for the whole team reads by
-- membership instead.

create function private.action_owners_only(p_kind text)
returns boolean
language sql immutable set search_path = ''
as $$
  select p_kind like 'money.debt%' or p_kind like 'money.liability%';
$$;
revoke all on function private.action_owners_only(text) from public;
grant execute on function private.action_owners_only(text) to authenticated, service_role;

create table public.action_proposals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  kind text not null check (kind in (
    'money.debt_details', 'money.debt_cover', 'money.liability_choice', 'money.liability_hide')),
  -- The debt or the books' account it is about.
  target uuid not null,
  body jsonb not null check (jsonb_typeof(body) = 'object' and pg_column_size(body) < 4000),
  summary text not null check (char_length(summary) between 1 and 500),
  status text not null default 'pending' check (status in ('pending', 'applied', 'dismissed')),
  created_by uuid references auth.users (id) on delete set null,
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index action_proposals_pending_idx on public.action_proposals (tenant_id, created_at desc)
  where status = 'pending';

alter table public.action_proposals enable row level security;
create policy "members read the proposals they may see" on public.action_proposals
  for select to authenticated
  using (
    case when private.action_owners_only(kind)
      then private.has_tenant_role(tenant_id, array['owner', 'admin']::public.membership_role[])
      else tenant_id in (select private.user_tenant_ids())
    end
  );
revoke all on public.action_proposals from public, anon, authenticated, service_role;
grant select on public.action_proposals to authenticated, service_role;

-- Files a proposal. The target must be this workspace's.
create function public.propose_action(
  p_tenant_id uuid, p_kind text, p_target uuid, p_body jsonb, p_summary text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_kind is null or p_kind not in (
    'money.debt_details', 'money.debt_cover', 'money.liability_choice', 'money.liability_hide') then
    raise exception 'There is no such proposal' using errcode = '22023';
  end if;
  if private.action_owners_only(p_kind) then
    perform private.require_manager(p_tenant_id);
  elsif p_tenant_id not in (select private.user_tenant_ids()) then
    raise exception 'Not a member of this workspace' using errcode = '42501';
  end if;
  if p_body is null or jsonb_typeof(p_body) <> 'object' then
    raise exception 'Send what would change' using errcode = '22023';
  end if;
  if p_summary is null or btrim(p_summary) = '' then
    raise exception 'Say what would change' using errcode = '22023';
  end if;
  if p_kind in ('money.debt_details', 'money.debt_cover') then
    if not exists (select 1 from public.money_debts d
                   where d.id = p_target and d.tenant_id = p_tenant_id) then
      raise exception 'That debt isn''t here' using errcode = 'P0002';
    end if;
  elsif not exists (select 1 from public.money_book_accounts a
                    where a.id = p_target and a.tenant_id = p_tenant_id) then
    raise exception 'That account isn''t here' using errcode = 'P0002';
  end if;
  insert into public.action_proposals (tenant_id, kind, target, body, summary, created_by)
  values (p_tenant_id, p_kind, p_target, p_body, left(btrim(p_summary), 500), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

-- Takes a pending proposal to apply it: marks it applied and hands back
-- what it says, once (a second press gets nothing). The app then calls the
-- checked function as the person; if that refuses, `reopen_action_proposal`
-- puts it back.
create function public.claim_action_proposal(p_id uuid)
returns table (tenant_id uuid, kind text, target uuid, body jsonb)
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
  v_kind text;
begin
  select p.tenant_id, p.kind into v_tenant, v_kind from public.action_proposals p where p.id = p_id;
  if v_tenant is null then
    raise exception 'That suggestion isn''t here' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_tenant);
  return query
    with taken as (
      update public.action_proposals p
      set status = 'applied', decided_by = auth.uid(), decided_at = now()
      where p.id = p_id and p.status = 'pending'
      returning p.tenant_id, p.kind, p.target, p.body
    )
    select t.tenant_id, t.kind, t.target, t.body from taken t;
  if not found then
    raise exception 'already_decided' using errcode = '22023';
  end if;
end;
$$;

-- Only the person who just took it, within a few minutes.
create function public.reopen_action_proposal(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.action_proposals p
  set status = 'pending', decided_by = null, decided_at = null
  where p.id = p_id and p.status = 'applied' and p.decided_by = auth.uid()
    and p.decided_at > now() - interval '5 minutes'
    and private.has_tenant_role(p.tenant_id, array['owner', 'admin']::public.membership_role[]);
end;
$$;

create function public.dismiss_action_proposal(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
  v_kind text;
  v_by uuid;
begin
  select p.tenant_id, p.kind, p.created_by into v_tenant, v_kind, v_by
  from public.action_proposals p where p.id = p_id;
  if v_tenant is null then
    raise exception 'That suggestion isn''t here' using errcode = 'P0002';
  end if;
  if private.action_owners_only(v_kind) or v_by is distinct from auth.uid() then
    perform private.require_manager(v_tenant);
  end if;
  update public.action_proposals p
  set status = 'dismissed', decided_by = auth.uid(), decided_at = now()
  where p.id = p_id and p.status = 'pending';
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.propose_action(uuid, text, uuid, jsonb, text)',
    'public.claim_action_proposal(uuid)',
    'public.reopen_action_proposal(uuid)',
    'public.dismiss_action_proposal(uuid)']
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
