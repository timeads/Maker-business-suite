-- Phase 2: billing.
-- subscriptions (one per tenant, written only by the Stripe worker),
-- usage_events (metering), and a private queue of verified Stripe events so
-- webhooks are acknowledged fast, processed on the worker, and never applied
-- twice.

create type public.plan_key as enum ('starter', 'growth', 'studio');

create type public.subscription_status as enum (
  'trialing', 'active', 'past_due', 'unpaid', 'paused',
  'incomplete', 'incomplete_expired', 'canceled'
);

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.subscriptions (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  stripe_customer_id text not null unique,
  stripe_subscription_id text not null unique,
  plan public.plan_key not null,
  status public.subscription_status not null,
  trial_end timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  ended_at timestamptz,
  -- Set when a subscription ends: the workspace is read-only until this
  -- moment, then its data is deleted.
  purge_after timestamptz,
  -- Modules picked on plans that include a choice of modules.
  selected_modules text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.usage_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  type text not null check (type in ('ai_tokens', 'sync_calls')),
  quantity bigint not null check (quantity >= 0),
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index usage_events_tenant_type_time_idx
  on public.usage_events (tenant_id, type, occurred_at desc);

-- Not tenant data and not exposed through the API: Stripe events arrive
-- before we know which tenant they belong to.
create table private.stripe_events (
  id text primary key,
  type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  locked_at timestamptz,
  processed_at timestamptz,
  attempts int not null default 0,
  last_error text
);
create index stripe_events_pending_idx
  on private.stripe_events (received_at)
  where processed_at is null;

-- ---------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------

alter table public.subscriptions enable row level security;
alter table public.usage_events enable row level security;
alter table private.stripe_events enable row level security;

create policy "members read their subscription" on public.subscriptions
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));

create policy "members read their usage" on public.usage_events
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));

revoke all on public.subscriptions, public.usage_events
  from public, anon, authenticated, service_role;
revoke all on private.stripe_events from public, anon, authenticated, service_role;

-- Stripe identifiers stay server-side.
grant select (tenant_id, plan, status, trial_end, current_period_end, cancel_at_period_end,
              ended_at, purge_after, selected_modules, updated_at)
  on public.subscriptions to authenticated;
grant select on public.usage_events to authenticated;

grant select, insert, update on public.subscriptions to service_role;
grant select, insert on public.usage_events to service_role;

create function private.touch_updated_at()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger subscriptions_touch_updated_at
  before update on public.subscriptions
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Stripe event queue (service role only)
-- ---------------------------------------------------------------------------

-- Returns true the first time an event id is seen, false for a replay.
create function public.enqueue_stripe_event(p_id text, p_type text, p_payload jsonb)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_inserted int;
begin
  insert into private.stripe_events (id, type, payload)
  values (p_id, p_type, p_payload)
  on conflict (id) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted = 1;
end;
$$;

-- Hands out unprocessed events, oldest first. A claimed event is hidden from
-- other workers for five minutes, which is also the retry delay after a failure.
create function public.claim_stripe_events(p_limit int default 10)
returns table (id text, type text, payload jsonb, attempts int)
language sql security definer set search_path = ''
as $$
  update private.stripe_events e
  set locked_at = now(), attempts = e.attempts + 1
  where e.id in (
    select s.id from private.stripe_events s
    where s.processed_at is null
      and s.attempts < 8
      and (s.locked_at is null or s.locked_at < now() - interval '5 minutes')
    order by s.received_at
    limit greatest(1, least(coalesce(p_limit, 10), 100))
    for update skip locked
  )
  returning e.id, e.type, e.payload, e.attempts;
$$;

create function public.complete_stripe_event(p_id text, p_error text default null)
returns void
language sql security definer set search_path = ''
as $$
  update private.stripe_events e
  set processed_at = case when p_error is null then now() else null end,
      locked_at = case when p_error is null then null else e.locked_at end,
      last_error = p_error
  where e.id = p_id;
$$;

-- Deletes workspaces whose subscription ended and whose retention window has
-- passed. Returns how many were deleted.
create function public.purge_expired_tenants()
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  delete from public.tenants t
  using public.subscriptions s
  where s.tenant_id = t.id
    and s.status in ('canceled', 'incomplete_expired')
    and s.purge_after is not null
    and s.purge_after < now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.enqueue_stripe_event(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.claim_stripe_events(int) from public, anon, authenticated;
revoke all on function public.complete_stripe_event(text, text) from public, anon, authenticated;
revoke all on function public.purge_expired_tenants() from public, anon, authenticated;

grant execute on function public.enqueue_stripe_event(text, text, jsonb) to service_role;
grant execute on function public.claim_stripe_events(int) to service_role;
grant execute on function public.complete_stripe_event(text, text) to service_role;
grant execute on function public.purge_expired_tenants() to service_role;
