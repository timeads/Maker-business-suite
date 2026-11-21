-- Phase 3: connections hub.
-- connections (one per provider per tenant), sync_jobs (the worker's queue),
-- and OAuth tokens kept only in Supabase Vault. Clients can read connection
-- status; everything else is service-role only.

-- Relies on Supabase Vault (the `vault` schema), which is on by default.

create type public.connection_status as enum ('active', 'needs_reconnect', 'disconnected');
create type public.sync_job_status as enum ('queued', 'running', 'succeeded', 'failed');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  provider text not null check (provider in ('shopify', 'quickbooks', 'meta', 'google')),
  -- The account on the provider's side: shop domain, QuickBooks realm id, ...
  external_account_id text not null,
  display_name text,
  scopes text[] not null default '{}',
  status public.connection_status not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz,
  last_error text,
  -- Held briefly by whoever is refreshing the token, so rotating refresh
  -- tokens are never used twice.
  refresh_locked_until timestamptz,
  connected_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, provider)
);
-- One workspace per outside account: webhooks are routed by this.
create unique index connections_one_live_per_account
  on public.connections (provider, external_account_id)
  where status <> 'disconnected';

create table public.sync_jobs (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  connection_id uuid not null references public.connections (id) on delete cascade,
  provider text not null,
  -- full: first sync after connecting. incremental: scheduled or "sync now".
  -- webhook: one delivery from the provider.
  type text not null check (type in ('full', 'incremental', 'webhook')),
  topic text,
  payload jsonb,
  cursor jsonb,
  -- Provider's delivery id, so a redelivered webhook is queued once.
  dedupe_key text unique,
  status public.sync_job_status not null default 'queued',
  attempts int not null default 0,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create index sync_jobs_queue_idx on public.sync_jobs (run_after) where status = 'queued';
create index sync_jobs_connection_idx on public.sync_jobs (connection_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------

alter table public.connections enable row level security;
alter table public.sync_jobs enable row level security;

create policy "members read their connections" on public.connections
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));

create policy "owners and admins read sync jobs" on public.sync_jobs
  for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin']::public.membership_role[]));

revoke all on public.connections, public.sync_jobs from public, anon, authenticated, service_role;

grant select (id, tenant_id, provider, external_account_id, display_name, scopes, status,
              last_synced_at, last_error, created_at, updated_at)
  on public.connections to authenticated;
-- Payloads can hold customer data from webhooks; status is enough for the UI.
grant select (id, tenant_id, connection_id, provider, type, topic, status, attempts, error,
              started_at, finished_at, created_at)
  on public.sync_jobs to authenticated;

grant select on public.connections, public.sync_jobs to service_role;

create trigger connections_touch_updated_at
  before update on public.connections
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Tokens (Vault). Service role only, always by tenant + provider.
-- ---------------------------------------------------------------------------

create function private.token_secret_name(p_connection_id uuid)
returns text
language sql immutable set search_path = ''
as $$ select 'connection_token:' || p_connection_id::text $$;

create function private.write_token(p_connection_id uuid, p_token jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_name text := private.token_secret_name(p_connection_id);
  v_id uuid;
begin
  select s.id into v_id from vault.secrets s where s.name = v_name;
  if v_id is null then
    perform vault.create_secret(p_token::text, v_name, 'OAuth tokens for a connection');
  else
    perform vault.update_secret(v_id, p_token::text);
  end if;
end;
$$;

create function private.delete_token(p_connection_id uuid)
returns void
language sql security definer set search_path = ''
as $$
  delete from vault.secrets s where s.name = private.token_secret_name(p_connection_id);
$$;

revoke all on function private.token_secret_name(uuid) from public;
revoke all on function private.write_token(uuid, jsonb) from public;
revoke all on function private.delete_token(uuid) from public;

-- Records a successful OAuth connection: upserts the connection, stores its
-- tokens in Vault, and queues the first full sync.
create function public.save_connection(
  p_tenant_id uuid,
  p_provider text,
  p_external_account_id text,
  p_display_name text,
  p_scopes text[],
  p_token jsonb,
  p_connected_by uuid,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.connections as c
    (tenant_id, provider, external_account_id, display_name, scopes, status, metadata, connected_by,
     last_error, refresh_locked_until)
  values
    (p_tenant_id, p_provider, p_external_account_id, p_display_name, coalesce(p_scopes, '{}'),
     'active', coalesce(p_metadata, '{}'::jsonb), p_connected_by, null, null)
  on conflict (tenant_id, provider) do update set
    external_account_id = excluded.external_account_id,
    display_name = excluded.display_name,
    scopes = excluded.scopes,
    status = 'active',
    metadata = excluded.metadata,
    connected_by = excluded.connected_by,
    last_error = null,
    refresh_locked_until = null
  returning c.id into v_id;

  perform private.write_token(v_id, p_token);

  insert into public.sync_jobs (tenant_id, connection_id, provider, type)
  values (p_tenant_id, v_id, p_provider, 'full');

  insert into public.audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
  values (p_tenant_id, p_connected_by, 'connection.connected', 'connection', v_id::text,
          jsonb_build_object('provider', p_provider, 'account', p_external_account_id));
  return v_id;
end;
$$;

-- The stored tokens for a tenant's live connection, or no row.
create function public.get_provider_token(p_tenant_id uuid, p_provider text)
returns table (connection_id uuid, external_account_id text, status public.connection_status, token jsonb)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.external_account_id, c.status, s.decrypted_secret::jsonb
  from public.connections c
  join vault.decrypted_secrets s on s.name = private.token_secret_name(c.id)
  where c.tenant_id = p_tenant_id and c.provider = p_provider and c.status <> 'disconnected';
$$;

-- Claims the right to refresh a connection's token for 30 seconds.
create function public.lock_connection_refresh(p_connection_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_rows int;
begin
  update public.connections c
  set refresh_locked_until = now() + interval '30 seconds'
  where c.id = p_connection_id
    and c.status <> 'disconnected'
    and (c.refresh_locked_until is null or c.refresh_locked_until < now());
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

-- Stores refreshed tokens and releases the refresh lock.
create function public.store_provider_token(p_connection_id uuid, p_token jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.write_token(p_connection_id, p_token);
  update public.connections c
  set refresh_locked_until = null,
      status = case when c.status = 'needs_reconnect' then 'active' else c.status end,
      last_error = null
  where c.id = p_connection_id and c.status <> 'disconnected';
end;
$$;

-- Changes a connection's status. Disconnecting deletes its tokens and drops
-- any work still queued for it.
create function public.mark_connection(
  p_connection_id uuid,
  p_status public.connection_status,
  p_error text default null,
  p_actor uuid default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_conn public.connections;
begin
  update public.connections c
  set status = p_status, last_error = p_error, refresh_locked_until = null
  where c.id = p_connection_id and c.status is distinct from p_status
  returning * into v_conn;
  if not found then
    return;
  end if;

  if p_status = 'disconnected' then
    perform private.delete_token(p_connection_id);
    update public.sync_jobs j
    set status = 'failed', error = 'Connection was disconnected', finished_at = now()
    where j.connection_id = p_connection_id and j.status in ('queued', 'running');
  end if;

  insert into public.audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
  values (v_conn.tenant_id, p_actor, 'connection.' || p_status::text, 'connection', v_conn.id::text,
          jsonb_build_object('provider', v_conn.provider, 'reason', p_error));
end;
$$;

-- Lets a sync update what we show about the connected account.
create function public.update_connection_details(
  p_connection_id uuid,
  p_display_name text,
  p_metadata jsonb
)
returns void
language sql security definer set search_path = ''
as $$
  update public.connections c
  set display_name = coalesce(p_display_name, c.display_name),
      metadata = c.metadata || coalesce(p_metadata, '{}'::jsonb)
  where c.id = p_connection_id;
$$;

-- ---------------------------------------------------------------------------
-- Sync queue
-- ---------------------------------------------------------------------------

-- Queues a sync unless one is already waiting or running for the connection.
create function public.enqueue_sync(p_connection_id uuid, p_type text default 'incremental')
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_conn public.connections;
begin
  select * into v_conn from public.connections c where c.id = p_connection_id and c.status = 'active';
  if not found then
    return false;
  end if;
  if exists (
    select 1 from public.sync_jobs j
    where j.connection_id = p_connection_id and j.type in ('full', 'incremental')
      and j.status in ('queued', 'running')
  ) then
    return false;
  end if;
  insert into public.sync_jobs (tenant_id, connection_id, provider, type)
  values (v_conn.tenant_id, v_conn.id, v_conn.provider, p_type);
  return true;
end;
$$;

-- Queues a verified webhook for the workspace connected to that account.
-- Returns 'queued', 'duplicate', or 'unknown_account'.
create function public.enqueue_provider_webhook(
  p_provider text,
  p_external_account_id text,
  p_topic text,
  p_dedupe_key text,
  p_payload jsonb
)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_conn public.connections;
  v_rows int;
begin
  select * into v_conn from public.connections c
  where c.provider = p_provider and c.external_account_id = p_external_account_id
    and c.status <> 'disconnected';
  if not found then
    return 'unknown_account';
  end if;

  insert into public.sync_jobs (tenant_id, connection_id, provider, type, topic, payload, dedupe_key)
  values (v_conn.tenant_id, v_conn.id, p_provider, 'webhook', p_topic, p_payload,
          p_provider || ':' || p_dedupe_key)
  on conflict (dedupe_key) do nothing;
  get diagnostics v_rows = row_count;
  return case when v_rows = 1 then 'queued' else 'duplicate' end;
end;
$$;

-- Queues an incremental sync for connections that pull on a schedule and
-- haven't synced within the interval. Returns how many were queued.
create function public.enqueue_scheduled_syncs(p_provider text, p_every interval)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_conn record;
  v_count int := 0;
begin
  for v_conn in
    select c.id from public.connections c
    where c.provider = p_provider and c.status = 'active'
      and (c.last_synced_at is null or c.last_synced_at < now() - p_every)
  loop
    if public.enqueue_sync(v_conn.id, 'incremental') then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

-- Hands out due jobs, oldest first. A job whose worker died is offered again
-- after ten minutes.
create function public.claim_sync_jobs(p_limit int default 5)
returns setof public.sync_jobs
language sql security definer set search_path = ''
as $$
  update public.sync_jobs j
  set status = 'running', locked_at = now(), started_at = now(), attempts = j.attempts + 1
  where j.id in (
    select q.id from public.sync_jobs q
    where (q.status = 'queued' and q.run_after <= now())
       or (q.status = 'running' and q.locked_at < now() - interval '10 minutes')
    order by q.run_after
    limit greatest(1, least(coalesce(p_limit, 5), 50))
    for update skip locked
  )
  returning j.*;
$$;

-- Finishes a job. A failure is retried with backoff (1, 2, 4, 8 minutes) and
-- given up on after five attempts; `p_retry` false fails it at once.
create function public.finish_sync_job(
  p_id bigint,
  p_error text default null,
  p_cursor jsonb default null,
  p_retry boolean default true
)
returns public.sync_job_status
language plpgsql security definer set search_path = ''
as $$
declare
  v_job public.sync_jobs;
  v_status public.sync_job_status;
begin
  select * into v_job from public.sync_jobs j where j.id = p_id for update;
  if not found or v_job.status <> 'running' then
    return v_job.status;
  end if;

  if p_error is null then
    v_status := 'succeeded';
    update public.sync_jobs j
    set status = v_status, error = null, cursor = coalesce(p_cursor, j.cursor),
        finished_at = now(), locked_at = null, payload = null
    where j.id = p_id;
    update public.connections c
    set last_synced_at = now(), last_error = null
    where c.id = v_job.connection_id;
  elsif p_retry and v_job.attempts < 5 then
    v_status := 'queued';
    update public.sync_jobs j
    set status = v_status, error = p_error, locked_at = null,
        run_after = now() + make_interval(mins => power(2, v_job.attempts - 1)::int)
    where j.id = p_id;
  else
    v_status := 'failed';
    update public.sync_jobs j
    set status = v_status, error = p_error, finished_at = now(), locked_at = null
    where j.id = p_id;
    update public.connections c set last_error = p_error where c.id = v_job.connection_id;
  end if;
  return v_status;
end;
$$;

-- Who to email when a connection needs attention.
create function public.tenant_owner_emails(p_tenant_id uuid)
returns table (email text)
language sql stable security definer set search_path = ''
as $$
  select u.email::text
  from public.memberships m
  join auth.users u on u.id = m.user_id
  where m.tenant_id = p_tenant_id and m.role = 'owner' and u.email is not null;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.save_connection(uuid, text, text, text, text[], jsonb, uuid, jsonb)',
    'public.get_provider_token(uuid, text)',
    'public.lock_connection_refresh(uuid)',
    'public.store_provider_token(uuid, jsonb)',
    'public.mark_connection(uuid, public.connection_status, text, uuid)',
    'public.update_connection_details(uuid, text, jsonb)',
    'public.enqueue_sync(uuid, text)',
    'public.enqueue_provider_webhook(text, text, text, text, jsonb)',
    'public.enqueue_scheduled_syncs(text, interval)',
    'public.claim_sync_jobs(int)',
    'public.finish_sync_job(bigint, text, jsonb, boolean)',
    'public.tenant_owner_emails(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
