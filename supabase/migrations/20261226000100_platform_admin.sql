-- Platform admin: a private area for the people who run the suite, apart
-- from any workspace role.
--
-- Who is one is a hand-kept list (private.platform_admins). Everything the
-- area reads or does is a SECURITY DEFINER function here that checks that
-- list itself, so the database is the gate: the app calls these with the
-- signed-in admin's own session, never the service role.
--
-- The read functions return operational facts only (who, which plan, which
-- services, how the background work is going, how many rows). They never
-- return what a workspace's customers wrote or bought: no order contents,
-- shopper names, addresses, ticket or message text, and no tokens.

-- ---------------------------------------------------------------------------
-- Who is a platform admin
-- ---------------------------------------------------------------------------

-- No tenant_id: this is not tenant data, it is the operator's own list.
-- Rows are added by hand in SQL (see docs/admin.md); nothing in the app
-- writes here.
create table private.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now(),
  note text
);
alter table private.platform_admins enable row level security;
revoke all on private.platform_admins from public, anon, authenticated, service_role;

create function private.is_platform_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from private.platform_admins a where a.user_id = (select auth.uid())
  );
$$;

create function private.require_platform_admin()
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_platform_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.is_platform_admin() from public;
revoke all on function private.require_platform_admin() from public;
grant execute on function private.is_platform_admin() to authenticated;
grant execute on function private.require_platform_admin() to authenticated;

-- The app's way to ask "is the signed-in person one?". Answers only about
-- the caller.
create function public.is_platform_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_platform_admin();
$$;

-- ---------------------------------------------------------------------------
-- Internal plan grants
-- ---------------------------------------------------------------------------

-- A plan given to a workspace without Stripe (our own business, a comp).
-- While it runs, the workspace behaves as that plan whatever its Stripe
-- subscription says; when it ends, Stripe's answer applies again. A grant
-- never touches `subscriptions`: Stripe stays the source of truth for real
-- subscriptions.
create table public.plan_grants (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  plan public.plan_key not null,
  -- Null: until someone ends it.
  ends_at timestamptz,
  note text not null check (char_length(btrim(note)) between 1 and 500),
  -- The workspace's own pick on plans that include a choice of tools.
  selected_modules text[] not null default '{}',
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- No policies: clients can't read or write this table at all. Members learn
-- their workspace's grant from workspace_plan_grant() below (without the
-- note); the worker and public pages read it with the service role.
alter table public.plan_grants enable row level security;
revoke all on public.plan_grants from public, anon, authenticated, service_role;
grant select on public.plan_grants to service_role;

create trigger plan_grants_touch_updated_at
  before update on public.plan_grants
  for each row execute function private.touch_updated_at();

-- What the entitlement resolver needs to know about a member's own
-- workspace: the running grant, if there is one.
create function public.workspace_plan_grant(p_tenant_id uuid)
returns table (plan text, ends_at timestamptz, selected_modules text[])
language sql stable security definer set search_path = ''
as $$
  select g.plan::text, g.ends_at, g.selected_modules
  from public.plan_grants g
  where g.tenant_id = p_tenant_id
    and g.tenant_id in (select private.user_tenant_ids())
    and (g.ends_at is null or g.ends_at > now());
$$;

-- A workspace on a running grant is never purged, even if an old Stripe
-- subscription ended long ago.
create or replace function public.purge_expired_tenants()
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
    and s.purge_after < now()
    and not exists (
      select 1 from public.plan_grants g
      where g.tenant_id = t.id and (g.ends_at is null or g.ends_at > now())
    );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- On a granted plan with a choice of tools, the workspace's pick is kept on
-- the grant as well, since there may be no subscription to keep it on.
create or replace function public.choose_modules(p_tenant_id uuid, p_modules text[])
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.has_tenant_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]) then
    raise exception 'Only owners and admins can change this' using errcode = '42501';
  end if;
  if not coalesce(p_modules, '{}') <@ array['helpdesk', 'bookings', 'social'] then
    raise exception 'That tool is not one you can choose' using errcode = '22023';
  end if;
  update public.subscriptions s set selected_modules = coalesce(p_modules, '{}')
  where s.tenant_id = p_tenant_id;
  update public.plan_grants g set selected_modules = coalesce(p_modules, '{}')
  where g.tenant_id = p_tenant_id and (g.ends_at is null or g.ends_at > now());
  perform private.log_audit(p_tenant_id, 'plan.modules_chosen', 'subscription', p_tenant_id::text,
    jsonb_build_object('modules', p_modules));
end;
$$;

-- ---------------------------------------------------------------------------
-- Audit trail of admin actions
-- ---------------------------------------------------------------------------

-- The operator's own record, not tenant data: it outlives the workspace it
-- is about (tenant_id is cleared, the row stays). Read only through
-- admin_workspace().
create table private.admin_audit (
  id bigint generated always as identity primary key,
  admin_id uuid references auth.users (id) on delete set null,
  -- Kept as it was at the time, so the trail still reads if the admin goes.
  admin_email text,
  tenant_id uuid references public.tenants (id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  note text,
  created_at timestamptz not null default now()
);
create index admin_audit_tenant_idx on private.admin_audit (tenant_id, created_at desc);
alter table private.admin_audit enable row level security;
revoke all on private.admin_audit from public, anon, authenticated, service_role;

create function private.log_admin_action(
  p_tenant_id uuid,
  p_action text,
  p_details jsonb,
  p_note text
)
returns void
language sql security definer set search_path = ''
as $$
  insert into private.admin_audit (admin_id, admin_email, tenant_id, action, details, note)
  values (
    (select auth.uid()),
    (select u.email::text from auth.users u where u.id = (select auth.uid())),
    p_tenant_id, p_action, coalesce(p_details, '{}'::jsonb), nullif(btrim(p_note), '')
  );
$$;
revoke all on function private.log_admin_action(uuid, text, jsonb, text) from public;

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------

create function private.connection_health(p_status public.connection_status, p_last_error text)
returns text
language sql immutable set search_path = ''
as $$
  select case
    when p_status = 'needs_reconnect' then 'needs reconnect'
    when p_status = 'disconnected' then 'disconnected'
    when p_last_error is not null then 'last sync failed'
    else 'active'
  end;
$$;
revoke all on function private.connection_health(public.connection_status, text) from public;

-- Start of the calendar month in UTC, which is how the app counts the
-- month's AI allowance.
create function private.usage_month_start()
returns timestamptz
language sql stable set search_path = ''
as $$
  select date_trunc('month', now() at time zone 'utc') at time zone 'utc';
$$;
revoke all on function private.usage_month_start() from public;

-- One row per workspace, for the list.
create function public.admin_list_workspaces()
returns table (
  tenant_id uuid,
  name text,
  slug text,
  created_at timestamptz,
  owner_email text,
  member_count int,
  plan text,
  status text,
  trial_end timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean,
  grant_plan text,
  grant_ends_at timestamptz,
  connections jsonb,
  last_synced_at timestamptz,
  failed_jobs_7d int,
  ai_tokens_month bigint
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.require_platform_admin();
  return query
  select
    t.id,
    t.name,
    t.slug,
    t.created_at,
    (select u.email::text
       from public.memberships m join auth.users u on u.id = m.user_id
      where m.tenant_id = t.id and m.role = 'owner'
      order by m.created_at, u.email
      limit 1),
    (select count(*)::int from public.memberships m where m.tenant_id = t.id),
    s.plan::text,
    s.status::text,
    s.trial_end,
    s.current_period_end,
    s.cancel_at_period_end,
    g.plan::text,
    g.ends_at,
    coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'provider', c.provider,
                 'health', private.connection_health(c.status, c.last_error))
               order by c.provider)
        from public.connections c
       where c.tenant_id = t.id and c.status <> 'disconnected'
    ), '[]'::jsonb),
    (select max(c.last_synced_at) from public.connections c where c.tenant_id = t.id),
    (select count(*)::int from public.sync_jobs j
      where j.tenant_id = t.id and j.status = 'failed'
        and j.finished_at > now() - interval '7 days'),
    (select coalesce(sum(e.quantity), 0)::bigint from public.usage_events e
      where e.tenant_id = t.id and e.type = 'ai_tokens'
        and e.occurred_at >= private.usage_month_start())
  from public.tenants t
  left join public.subscriptions s on s.tenant_id = t.id
  left join public.plan_grants g on g.tenant_id = t.id
  order by t.created_at desc;
end;
$$;

-- Everything the workspace page shows, as one document. Null when there is
-- no such workspace.
create function public.admin_workspace(p_tenant_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_tenant public.tenants;
begin
  perform private.require_platform_admin();
  select * into v_tenant from public.tenants t where t.id = p_tenant_id;
  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'workspace', jsonb_build_object(
      'id', v_tenant.id, 'name', v_tenant.name, 'slug', v_tenant.slug,
      'timezone', v_tenant.timezone, 'currency', v_tenant.currency,
      'created_at', v_tenant.created_at),
    'members', coalesce((
      select jsonb_agg(
               jsonb_build_object('email', u.email::text, 'role', m.role, 'joined_at', m.created_at)
               order by m.created_at, u.email)
        from public.memberships m join auth.users u on u.id = m.user_id
       where m.tenant_id = p_tenant_id
    ), '[]'::jsonb),
    'subscription', (
      select jsonb_build_object(
               'plan', s.plan, 'status', s.status,
               'stripe_customer_id', s.stripe_customer_id,
               'stripe_subscription_id', s.stripe_subscription_id,
               'trial_end', s.trial_end, 'current_period_end', s.current_period_end,
               'cancel_at_period_end', s.cancel_at_period_end,
               'ended_at', s.ended_at, 'purge_after', s.purge_after,
               'selected_modules', s.selected_modules)
        from public.subscriptions s where s.tenant_id = p_tenant_id
    ),
    'grant', (
      select jsonb_build_object(
               'plan', g.plan, 'ends_at', g.ends_at, 'note', g.note,
               'selected_modules', g.selected_modules, 'granted_at', g.updated_at,
               'granted_by', (select u.email::text from auth.users u where u.id = g.granted_by))
        from public.plan_grants g where g.tenant_id = p_tenant_id
    ),
    'connections', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id', c.id, 'provider', c.provider, 'status', c.status,
                 'health', private.connection_health(c.status, c.last_error),
                 'last_synced_at', c.last_synced_at, 'last_error', c.last_error,
                 'connected_at', c.created_at)
               order by c.provider)
        from public.connections c where c.tenant_id = p_tenant_id
    ), '[]'::jsonb),
    -- Never the payload or cursor: those can hold what a customer bought.
    'jobs', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id', j.id, 'provider', j.provider, 'type', j.type, 'topic', j.topic,
                 'status', j.status, 'attempts', j.attempts, 'error', j.error,
                 'created_at', j.created_at, 'finished_at', j.finished_at)
               order by j.created_at desc, j.id desc)
        from (
          select * from public.sync_jobs q
           where q.tenant_id = p_tenant_id
           order by q.created_at desc, q.id desc
           limit 30
        ) j
    ), '[]'::jsonb),
    'failed_jobs_7d', (
      select count(*)::int from public.sync_jobs j
       where j.tenant_id = p_tenant_id and j.status = 'failed'
         and j.finished_at > now() - interval '7 days'),
    'counts', jsonb_build_object(
      'orders', (select count(*) from public.orders x where x.tenant_id = p_tenant_id),
      'tickets', (select count(*) from public.tickets x where x.tenant_id = p_tenant_id),
      'bookings', (select count(*) from public.bookings x where x.tenant_id = p_tenant_id),
      'posts', (select count(*) from public.social_posts x where x.tenant_id = p_tenant_id),
      'stock_items', (select count(*) from public.stock_items x where x.tenant_id = p_tenant_id),
      'parcels', (select count(*) from public.shipments x where x.tenant_id = p_tenant_id)),
    'ai_tokens_month', (
      select coalesce(sum(e.quantity), 0)::bigint from public.usage_events e
       where e.tenant_id = p_tenant_id and e.type = 'ai_tokens'
         and e.occurred_at >= private.usage_month_start()),
    'audit', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id', a.id, 'admin_email', a.admin_email, 'action', a.action,
                 'details', a.details, 'note', a.note, 'created_at', a.created_at)
               order by a.created_at desc, a.id desc)
        from (
          select * from private.admin_audit q
           where q.tenant_id = p_tenant_id
           order by q.created_at desc, q.id desc
           limit 100
        ) a
    ), '[]'::jsonb)
  );
end;
$$;

-- The totals across the top of the list.
create function public.admin_health()
returns table (
  workspaces int,
  trialing int,
  paying int,
  past_due int,
  internal int,
  failed_jobs_24h int,
  needs_reconnect int,
  stuck_jobs int,
  stripe_events_waiting int,
  inbound_emails_waiting int
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.require_platform_admin();
  return query
  select
    (select count(*)::int from public.tenants),
    (select count(*)::int from public.subscriptions s where s.status = 'trialing'),
    (select count(*)::int from public.subscriptions s where s.status = 'active'),
    (select count(*)::int from public.subscriptions s where s.status in ('past_due', 'unpaid')),
    (select count(*)::int from public.plan_grants g where g.ends_at is null or g.ends_at > now()),
    (select count(*)::int from public.sync_jobs j
      where j.status = 'failed' and j.finished_at > now() - interval '24 hours'),
    (select count(*)::int from public.connections c where c.status = 'needs_reconnect'),
    -- Due for over an hour and still not picked up. A job waiting out a
    -- retry delay has a later run_after and isn't counted.
    (select count(*)::int from public.sync_jobs j
      where j.status = 'queued' and j.run_after < now() - interval '1 hour'),
    (select count(*)::int from private.stripe_events e
      where e.processed_at is null and e.received_at < now() - interval '10 minutes'),
    (select count(*)::int from private.inbound_emails e
      where e.processed_at is null and e.received_at < now() - interval '10 minutes');
end;
$$;

-- ---------------------------------------------------------------------------
-- Writes: few, and each one leaves an audit row
-- ---------------------------------------------------------------------------

-- Gives a workspace a plan without Stripe, or changes the one it has.
create function public.admin_set_plan_grant(
  p_tenant_id uuid,
  p_plan text,
  p_ends_at timestamptz,
  p_note text
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_before jsonb;
begin
  perform private.require_platform_admin();
  if not exists (select 1 from public.tenants t where t.id = p_tenant_id) then
    raise exception 'No such workspace' using errcode = '22023';
  end if;
  if p_plan is null or p_plan not in ('starter', 'growth', 'studio') then
    raise exception 'Unknown plan' using errcode = '22023';
  end if;
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'A note is needed' using errcode = '22023';
  end if;
  if char_length(btrim(p_note)) > 500 then
    raise exception 'The note is too long' using errcode = '22023';
  end if;
  if p_ends_at is not null and p_ends_at <= now() then
    raise exception 'The end date must be in the future' using errcode = '22023';
  end if;

  select jsonb_build_object('plan', g.plan, 'ends_at', g.ends_at) into v_before
  from public.plan_grants g where g.tenant_id = p_tenant_id;

  insert into public.plan_grants (tenant_id, plan, ends_at, note, granted_by)
  values (p_tenant_id, p_plan::public.plan_key, p_ends_at, btrim(p_note), (select auth.uid()))
  on conflict (tenant_id) do update
    set plan = excluded.plan, ends_at = excluded.ends_at, note = excluded.note,
        granted_by = excluded.granted_by;

  perform private.log_admin_action(
    p_tenant_id, 'plan_grant.set',
    jsonb_build_object('plan', p_plan, 'ends_at', p_ends_at, 'before', v_before),
    p_note);
end;
$$;

-- Ends a grant now. The workspace goes back to whatever Stripe says.
create function public.admin_end_plan_grant(p_tenant_id uuid, p_note text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_before jsonb;
begin
  perform private.require_platform_admin();
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'A note is needed' using errcode = '22023';
  end if;
  delete from public.plan_grants g where g.tenant_id = p_tenant_id
  returning jsonb_build_object('plan', g.plan, 'ends_at', g.ends_at) into v_before;
  if v_before is null then
    return false;
  end if;
  perform private.log_admin_action(
    p_tenant_id, 'plan_grant.ended', jsonb_build_object('before', v_before), p_note);
  return true;
end;
$$;

-- Queues a fresh sync for one connection, through the same door the app
-- uses. False when nothing was queued: the connection isn't active, or a
-- sync is already waiting or running.
create function public.admin_requeue_sync(p_connection_id uuid, p_note text default null)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_conn public.connections;
  v_queued boolean;
begin
  perform private.require_platform_admin();
  select * into v_conn from public.connections c where c.id = p_connection_id;
  if not found then
    raise exception 'No such connection' using errcode = '22023';
  end if;
  v_queued := public.enqueue_sync(p_connection_id, 'incremental');
  perform private.log_admin_action(
    v_conn.tenant_id, 'sync.requeued',
    jsonb_build_object('provider', v_conn.provider, 'queued', v_queued),
    p_note);
  return v_queued;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: signed-in people may call these; each checks the caller itself.
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.is_platform_admin()',
    'public.workspace_plan_grant(uuid)',
    'public.admin_list_workspaces()',
    'public.admin_workspace(uuid)',
    'public.admin_health()',
    'public.admin_set_plan_grant(uuid, text, timestamptz, text)',
    'public.admin_end_plan_grant(uuid, text)',
    'public.admin_requeue_sync(uuid, text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
