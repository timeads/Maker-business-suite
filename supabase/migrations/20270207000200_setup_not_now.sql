-- "Finish setting up": a tool's checklist is worked out on read from what
-- the workspace already has (lib/setup, lib/dashboard/setup.ts for Money).
-- The ONLY thing kept is a person's "Not now" on one item, with a
-- fingerprint of the facts it was about (a short hash, never the facts
-- themselves): when the facts change (a new debt needs a rate) the
-- fingerprint no longer matches and the item comes back by itself.
--
-- Items can be about debts, which are for OWNERS AND ADMINS ONLY, so the
-- whole table is theirs: only they read it and only they say "Not now".
-- Everyone else is shown the checklist without it (and never a debt item).

create table public.setup_not_now (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  tool text not null check (tool ~ '^[a-z][a-z0-9_]{0,30}$'),
  item text not null check (item ~ '^[a-z][a-z0-9_.-]{0,60}$'),
  fingerprint text not null check (fingerprint ~ '^[a-z0-9]{1,32}$'),
  said_by uuid references auth.users (id) on delete set null,
  said_at timestamptz not null default now(),
  unique (tenant_id, tool, item)
);

alter table public.setup_not_now enable row level security;
create policy "owners and admins read their setup choices" on public.setup_not_now
  for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin']::public.membership_role[]));
revoke all on public.setup_not_now from public, anon, authenticated, service_role;
grant select on public.setup_not_now to authenticated, service_role;

-- "Not now" on one item, for the facts it shows now. Saying it again
-- (the facts changed and it came back) replaces the fingerprint.
create function public.say_setup_not_now(
  p_tenant_id uuid, p_tool text, p_item text, p_fingerprint text
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  if p_tool is null or p_tool !~ '^[a-z][a-z0-9_]{0,30}$'
     or p_item is null or p_item !~ '^[a-z][a-z0-9_.-]{0,60}$'
     or p_fingerprint is null or p_fingerprint !~ '^[a-z0-9]{1,32}$' then
    raise exception 'Which item is this?' using errcode = '22023';
  end if;
  insert into public.setup_not_now (tenant_id, tool, item, fingerprint, said_by)
  values (p_tenant_id, p_tool, p_item, p_fingerprint, auth.uid())
  on conflict (tenant_id, tool, item) do update
    set fingerprint = excluded.fingerprint, said_by = excluded.said_by, said_at = now();
end;
$$;

-- "Show it again": the item is open as soon as its facts say so.
create function public.bring_back_setup_item(p_tenant_id uuid, p_tool text, p_item text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  delete from public.setup_not_now n
  where n.tenant_id = p_tenant_id and n.tool = p_tool and n.item = p_item;
end;
$$;

revoke all on function public.say_setup_not_now(uuid, text, text, text) from public, anon;
grant execute on function public.say_setup_not_now(uuid, text, text, text) to authenticated;
revoke all on function public.bring_back_setup_item(uuid, text, text) from public, anon;
grant execute on function public.bring_back_setup_item(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Pointed at Money → Set up once
-- ---------------------------------------------------------------------------

-- A workspace whose books are read for the first time gets one heads-up in
-- Messages pointing at Money → Set up. This table is only "it was sent":
-- the worker claims it once per workspace, and nothing else reads it.
create table private.money_setup_nudges (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  nudged_at timestamptz not null default now()
);
revoke all on private.money_setup_nudges from public, anon, authenticated;

create function public.claim_money_setup_nudge(p_tenant_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  insert into private.money_setup_nudges (tenant_id) values (p_tenant_id)
  on conflict (tenant_id) do nothing;
  return found;
end;
$$;
revoke all on function public.claim_money_setup_nudge(uuid) from public, anon, authenticated;
grant execute on function public.claim_money_setup_nudge(uuid) to service_role;
