-- "Bills by email": a private address a workspace forwards its suppliers'
-- bills to. The way in that needs no permission from Google at all.
--
-- Mail to `bills-<token>@<the inbound domain>` arrives through the same
-- inbound webhook and queue as the help desk's (`private.inbound_emails`),
-- and the worker hands it to the bills reader instead of making a ticket.
-- The token is the only thing that says which workspace a message is for, so
-- it is long, random, and readable only by the workspace's owners and
-- admins. Making a new address replaces the token: the old address stops
-- working at once.

create table public.stock_bills_addresses (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  token text not null unique check (token ~ '^[0-9a-f]{32}$'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  -- When a message last arrived at the address.
  last_received_at timestamptz,
  -- Gmail asks the owner of a forwarding address to confirm it, by sending
  -- the address a code and a link. Kept here for a manager to act on; we
  -- never open the link ourselves.
  confirm_code text check (confirm_code is null or confirm_code ~ '^[0-9]{4,12}$'),
  confirm_link text check (confirm_link is null or char_length(confirm_link) <= 600),
  confirm_for text check (confirm_for is null or char_length(confirm_for) <= 200),
  confirm_at timestamptz
);
alter table public.stock_bills_addresses enable row level security;
create policy "managers read their bills address" on public.stock_bills_addresses
  for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin']::public.membership_role[]));
revoke all on public.stock_bills_addresses from public, anon, authenticated, service_role;
grant select on public.stock_bills_addresses to authenticated, service_role;

-- Switches "Bills by email" on, or makes a new address: either way the
-- workspace gets a fresh token and any earlier address stops working.
create function public.make_bills_address(p_tenant_id uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_token text := replace(gen_random_uuid()::text, '-', '');
begin
  perform private.require_manager(p_tenant_id);
  insert into public.stock_bills_addresses (tenant_id, token, created_by)
  values (p_tenant_id, v_token, auth.uid())
  on conflict (tenant_id) do update
    set token = excluded.token, created_by = excluded.created_by, created_at = now(),
        last_received_at = null, confirm_code = null, confirm_link = null,
        confirm_for = null, confirm_at = null;
  return v_token;
end;
$$;

-- Switches it off: the address stops working and is forgotten.
create function public.remove_bills_address(p_tenant_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  delete from public.stock_bills_addresses a where a.tenant_id = p_tenant_id;
end;
$$;

-- Puts a Gmail confirmation away once the person has dealt with it.
create function public.clear_bills_confirmation(p_tenant_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  update public.stock_bills_addresses a
  set confirm_code = null, confirm_link = null, confirm_for = null, confirm_at = null
  where a.tenant_id = p_tenant_id;
end;
$$;

-- Which workspace a message to a bills address is for, noting that one
-- arrived. Null for a token nobody has (never made, or replaced): such mail
-- is dropped without a word.
create function public.receive_bills_mail(p_token text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then
    return null;
  end if;
  update public.stock_bills_addresses a set last_received_at = now()
  where a.token = p_token
  returning a.tenant_id into v_tenant;
  return v_tenant;
end;
$$;

-- Notes Gmail's request to confirm the address, for a manager to see.
create function public.note_bills_confirmation(
  p_tenant_id uuid, p_code text, p_link text, p_for text
)
returns void
language sql security definer set search_path = ''
as $$
  update public.stock_bills_addresses a
  set confirm_code = case when p_code ~ '^[0-9]{4,12}$' then p_code end,
      confirm_link = left(p_link, 600), confirm_for = left(p_for, 200), confirm_at = now()
  where a.tenant_id = p_tenant_id;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.receive_bills_mail(text)',
    'public.note_bills_confirmation(uuid, text, text, text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
  foreach fn in array array[
    'public.make_bills_address(uuid)',
    'public.remove_bills_address(uuid)',
    'public.clear_bills_confirmation(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
