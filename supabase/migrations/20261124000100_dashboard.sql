-- Phase 4: the money view.
-- Normalised commerce data (customers, products, orders, order_lines), cached
-- accounting reports (financial_snapshots), and `configs`, where dashboards
-- (and later forms, templates and automations) live as validated JSON.
-- Members read; only the worker writes synced data.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  provider text not null,
  external_id text not null,
  email text,
  first_name text,
  last_name text,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  unique (tenant_id, provider, external_id)
);
create index customers_tenant_email_idx on public.customers (tenant_id, lower(email));

create table public.products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  provider text not null,
  external_id text not null,
  title text not null,
  vendor text,
  product_type text,
  status text,
  source_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  unique (tenant_id, provider, external_id)
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  provider text not null,
  external_id text not null,
  name text,
  customer_external_id text,
  email text,
  processed_at timestamptz not null,
  currency text,
  -- Items after discounts and refunds, before shipping and tax.
  net_sales numeric(14, 2) not null default 0,
  total_tax numeric(14, 2) not null default 0,
  total_shipping numeric(14, 2) not null default 0,
  total numeric(14, 2) not null default 0,
  financial_status text,
  fulfillment_status text,
  -- Where the sale happened: online store, point of sale, wholesale, ...
  channel text not null default 'Other',
  cancelled_at timestamptz,
  is_test boolean not null default false,
  source_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  unique (tenant_id, provider, external_id)
);
create index orders_tenant_processed_idx on public.orders (tenant_id, processed_at desc);
create index orders_tenant_customer_idx on public.orders (tenant_id, customer_external_id);

create table public.order_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete cascade,
  external_id text not null,
  product_external_id text,
  title text not null,
  variant_title text,
  sku text,
  -- Quantity still sold after refunds.
  quantity int not null default 0,
  -- Per unit, after discounts.
  unit_price numeric(14, 2) not null default 0,
  -- What one unit cost to make or buy, when the store records it.
  unit_cost numeric(14, 2),
  unique (order_id, external_id)
);
create index order_lines_tenant_order_idx on public.order_lines (tenant_id, order_id);

create table public.financial_snapshots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  provider text not null,
  kind text not null check (kind in ('profit_and_loss', 'balance_sheet', 'ar_aging')),
  -- A month for profit and loss; the as-of day for the others.
  period_start date not null,
  period_end date not null,
  data jsonb not null,
  fetched_at timestamptz not null default now(),
  unique (tenant_id, provider, kind, period_start)
);

create table public.configs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  module text not null,
  key text not null,
  body jsonb not null,
  schema_version int not null default 1,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, module, key)
);

-- ---------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['customers', 'products', 'orders', 'order_lines', 'financial_snapshots', 'configs']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy "members read their %s" on public.%I for select to authenticated
         using (tenant_id in (select private.user_tenant_ids()))', t, t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant select on public.%I to service_role', t);
  end loop;
end;
$$;

create trigger configs_touch_updated_at
  before update on public.configs
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Configs: owners and admins save, through one audited door
-- ---------------------------------------------------------------------------

-- The app validates `p_body` against the config's schema before calling this.
create function public.save_config(p_tenant_id uuid, p_module text, p_key text, p_body jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.has_tenant_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]) then
    raise exception 'Only owners and admins can change this' using errcode = '42501';
  end if;
  if p_module !~ '^[a-z_]{1,40}$' or p_key !~ '^[a-z0-9_-]{1,60}$' or jsonb_typeof(p_body) <> 'object' then
    raise exception 'That setting is not valid' using errcode = '22023';
  end if;

  insert into public.configs (tenant_id, module, key, body, updated_by)
  values (p_tenant_id, p_module, p_key, p_body, auth.uid())
  on conflict (tenant_id, module, key) do update
    set body = excluded.body, updated_by = excluded.updated_by;

  perform private.log_audit(p_tenant_id, 'config.saved', 'config', p_module || '/' || p_key);
end;
$$;

revoke all on function public.save_config(uuid, text, text, jsonb) from public, anon;
grant execute on function public.save_config(uuid, text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Sync writes (service role only, always for one explicit tenant)
-- ---------------------------------------------------------------------------

-- Upserts one page of synced commerce data. Each order carries its lines,
-- which replace whatever lines the order had.
create function public.upsert_commerce_batch(
  p_tenant_id uuid,
  p_provider text,
  p_customers jsonb default '[]'::jsonb,
  p_products jsonb default '[]'::jsonb,
  p_orders jsonb default '[]'::jsonb
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_order jsonb;
  v_order_id uuid;
begin
  insert into public.customers
    (tenant_id, provider, external_id, email, first_name, last_name, source_created_at, source_updated_at, synced_at)
  select p_tenant_id, p_provider, c.external_id, lower(c.email), c.first_name, c.last_name,
         c.source_created_at, c.source_updated_at, now()
  from jsonb_to_recordset(coalesce(p_customers, '[]'::jsonb)) as c(
    external_id text, email text, first_name text, last_name text,
    source_created_at timestamptz, source_updated_at timestamptz)
  on conflict (tenant_id, provider, external_id) do update set
    email = excluded.email, first_name = excluded.first_name, last_name = excluded.last_name,
    source_created_at = excluded.source_created_at, source_updated_at = excluded.source_updated_at,
    synced_at = now();

  insert into public.products
    (tenant_id, provider, external_id, title, vendor, product_type, status, source_updated_at, synced_at)
  select p_tenant_id, p_provider, p.external_id, p.title, p.vendor, p.product_type, p.status,
         p.source_updated_at, now()
  from jsonb_to_recordset(coalesce(p_products, '[]'::jsonb)) as p(
    external_id text, title text, vendor text, product_type text, status text,
    source_updated_at timestamptz)
  on conflict (tenant_id, provider, external_id) do update set
    title = excluded.title, vendor = excluded.vendor, product_type = excluded.product_type,
    status = excluded.status, source_updated_at = excluded.source_updated_at, synced_at = now();

  for v_order in select * from jsonb_array_elements(coalesce(p_orders, '[]'::jsonb))
  loop
    insert into public.orders
      (tenant_id, provider, external_id, name, customer_external_id, email, processed_at, currency,
       net_sales, total_tax, total_shipping, total, financial_status, fulfillment_status, channel,
       cancelled_at, is_test, source_updated_at, synced_at)
    select p_tenant_id, p_provider, o.external_id, o.name, o.customer_external_id, lower(o.email),
           o.processed_at, o.currency, coalesce(o.net_sales, 0), coalesce(o.total_tax, 0),
           coalesce(o.total_shipping, 0), coalesce(o.total, 0), o.financial_status,
           o.fulfillment_status, coalesce(nullif(o.channel, ''), 'Other'), o.cancelled_at,
           coalesce(o.is_test, false), o.source_updated_at, now()
    from jsonb_to_record(v_order) as o(
      external_id text, name text, customer_external_id text, email text, processed_at timestamptz,
      currency text, net_sales numeric, total_tax numeric, total_shipping numeric, total numeric,
      financial_status text, fulfillment_status text, channel text, cancelled_at timestamptz,
      is_test boolean, source_updated_at timestamptz)
    on conflict (tenant_id, provider, external_id) do update set
      name = excluded.name, customer_external_id = excluded.customer_external_id,
      email = excluded.email, processed_at = excluded.processed_at, currency = excluded.currency,
      net_sales = excluded.net_sales, total_tax = excluded.total_tax,
      total_shipping = excluded.total_shipping, total = excluded.total,
      financial_status = excluded.financial_status,
      fulfillment_status = excluded.fulfillment_status, channel = excluded.channel,
      cancelled_at = excluded.cancelled_at, is_test = excluded.is_test,
      source_updated_at = excluded.source_updated_at, synced_at = now()
    returning id into v_order_id;

    delete from public.order_lines l where l.order_id = v_order_id;
    insert into public.order_lines
      (tenant_id, order_id, external_id, product_external_id, title, variant_title, sku, quantity,
       unit_price, unit_cost)
    select p_tenant_id, v_order_id, l.external_id, l.product_external_id,
           coalesce(l.title, 'Item'), l.variant_title, l.sku, coalesce(l.quantity, 0),
           coalesce(l.unit_price, 0), l.unit_cost
    from jsonb_to_recordset(coalesce(v_order -> 'lines', '[]'::jsonb)) as l(
      external_id text, product_external_id text, title text, variant_title text, sku text,
      quantity int, unit_price numeric, unit_cost numeric);
  end loop;
end;
$$;

-- Replaces cached reports for the periods given.
create function public.save_financial_snapshots(p_tenant_id uuid, p_provider text, p_snapshots jsonb)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.financial_snapshots (tenant_id, provider, kind, period_start, period_end, data, fetched_at)
  select p_tenant_id, p_provider, s.kind, s.period_start, s.period_end, s.data, now()
  from jsonb_to_recordset(coalesce(p_snapshots, '[]'::jsonb)) as s(
    kind text, period_start date, period_end date, data jsonb)
  on conflict (tenant_id, provider, kind, period_start) do update set
    period_end = excluded.period_end, data = excluded.data, fetched_at = now();
$$;

-- Erases one shopper's personal details: the customer row goes, and their
-- orders keep their numbers but lose the name and email link.
create function public.redact_customer(
  p_tenant_id uuid,
  p_provider text,
  p_customer_external_id text,
  p_email text default null
)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_orders int;
begin
  delete from public.customers c
  where c.tenant_id = p_tenant_id and c.provider = p_provider
    and (c.external_id = p_customer_external_id or (p_email is not null and c.email = lower(p_email)));

  update public.orders o
  set customer_external_id = null, email = null
  where o.tenant_id = p_tenant_id and o.provider = p_provider
    and (o.customer_external_id = p_customer_external_id
         or (p_email is not null and o.email = lower(p_email)));
  get diagnostics v_orders = row_count;

  insert into public.audit_log (tenant_id, action, target_type, target_id, metadata)
  values (p_tenant_id, 'privacy.customer_redacted', 'customer', p_customer_external_id,
          jsonb_build_object('provider', p_provider, 'orders_anonymised', v_orders));
  return v_orders;
end;
$$;

-- Deletes everything synced from one provider for a workspace.
create function public.purge_provider_data(p_tenant_id uuid, p_provider text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.orders o where o.tenant_id = p_tenant_id and o.provider = p_provider;
  delete from public.customers c where c.tenant_id = p_tenant_id and c.provider = p_provider;
  delete from public.products p where p.tenant_id = p_tenant_id and p.provider = p_provider;
  delete from public.financial_snapshots f where f.tenant_id = p_tenant_id and f.provider = p_provider;
  insert into public.audit_log (tenant_id, action, target_type, target_id)
  values (p_tenant_id, 'privacy.provider_data_erased', 'provider', p_provider);
end;
$$;

create function public.record_usage(p_tenant_id uuid, p_type text, p_quantity bigint)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.usage_events (tenant_id, type, quantity) values (p_tenant_id, p_type, p_quantity);
$$;

-- Puts a running job back on the queue to carry on from `p_cursor`: long
-- first syncs run as a chain of short jobs.
create function public.requeue_sync_job(p_id bigint, p_cursor jsonb)
returns void
language sql security definer set search_path = ''
as $$
  update public.sync_jobs j
  set status = 'queued', cursor = p_cursor, attempts = 0, locked_at = null, run_after = now(), error = null
  where j.id = p_id and j.status = 'running';
$$;

-- Privacy webhooks can arrive after a store has disconnected (Shopify sends
-- shop/redact 48 hours after uninstall), so those reach every workspace that
-- ever connected the account. Everything else still needs a live connection.
create or replace function public.enqueue_provider_webhook(
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
  v_conn record;
  v_privacy boolean := p_topic in ('customers/data_request', 'customers/redact', 'shop/redact');
  v_rows int;
  v_seen boolean := false;
  v_queued boolean := false;
begin
  for v_conn in
    select c.id, c.tenant_id from public.connections c
    where c.provider = p_provider and c.external_account_id = p_external_account_id
      and (v_privacy or c.status <> 'disconnected')
  loop
    v_seen := true;
    insert into public.sync_jobs (tenant_id, connection_id, provider, type, topic, payload, dedupe_key)
    values (v_conn.tenant_id, v_conn.id, p_provider, 'webhook', p_topic, p_payload,
            p_provider || ':' || p_dedupe_key || ':' || v_conn.id::text)
    on conflict (dedupe_key) do nothing;
    get diagnostics v_rows = row_count;
    v_queued := v_queued or v_rows = 1;
  end loop;

  if not v_seen then
    return 'unknown_account';
  end if;
  return case when v_queued then 'queued' else 'duplicate' end;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.upsert_commerce_batch(uuid, text, jsonb, jsonb, jsonb)',
    'public.save_financial_snapshots(uuid, text, jsonb)',
    'public.redact_customer(uuid, text, text, text)',
    'public.purge_provider_data(uuid, text)',
    'public.record_usage(uuid, text, bigint)',
    'public.requeue_sync_job(bigint, jsonb)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Dashboard queries. These run as the signed-in member, so row-level
-- security decides what they can see; `p_tenant_id` only narrows it.
-- ---------------------------------------------------------------------------

-- Sales per day, week or month in the workspace's own timezone. `cost` and
-- `costed_sales` cover only items whose cost is known, so margin can be
-- worked out honestly from the part we can see.
create function public.dashboard_sales_by_period(
  p_tenant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_grouping text,
  p_timezone text
)
returns table (period date, order_count bigint, net_sales numeric, cost numeric, costed_sales numeric)
language sql stable set search_path = ''
as $$
  with scoped as (
    select o.id, o.net_sales,
           date_trunc(
             case when p_grouping in ('day', 'week', 'month') then p_grouping else 'month' end,
             o.processed_at at time zone p_timezone
           )::date as period
    from public.orders o
    where o.tenant_id = p_tenant_id
      and o.processed_at >= p_from and o.processed_at < p_to
      and o.cancelled_at is null and not o.is_test
  ),
  line_totals as (
    select l.order_id,
           sum(l.quantity * l.unit_cost) filter (where l.unit_cost is not null) as cost,
           sum(l.quantity * l.unit_price) filter (where l.unit_cost is not null) as costed_sales
    from public.order_lines l
    where l.tenant_id = p_tenant_id and l.order_id in (select s.id from scoped s)
    group by l.order_id
  )
  select s.period, count(*), coalesce(sum(s.net_sales), 0),
         coalesce(sum(t.cost), 0), coalesce(sum(t.costed_sales), 0)
  from scoped s
  left join line_totals t on t.order_id = s.id
  group by s.period
  order by s.period;
$$;

create function public.dashboard_top_products(
  p_tenant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_limit int default 5
)
returns table (title text, units bigint, revenue numeric)
language sql stable set search_path = ''
as $$
  select l.title, sum(l.quantity)::bigint, sum(l.quantity * l.unit_price)
  from public.order_lines l
  join public.orders o on o.id = l.order_id
  where l.tenant_id = p_tenant_id and o.tenant_id = p_tenant_id
    and o.processed_at >= p_from and o.processed_at < p_to
    and o.cancelled_at is null and not o.is_test
    and l.quantity > 0
  group by l.title
  order by sum(l.quantity * l.unit_price) desc, l.title
  limit greatest(1, least(coalesce(p_limit, 5), 50));
$$;

create function public.dashboard_sales_by_channel(p_tenant_id uuid, p_from timestamptz, p_to timestamptz)
returns table (channel text, order_count bigint, net_sales numeric)
language sql stable set search_path = ''
as $$
  select o.channel, count(*), coalesce(sum(o.net_sales), 0)
  from public.orders o
  where o.tenant_id = p_tenant_id
    and o.processed_at >= p_from and o.processed_at < p_to
    and o.cancelled_at is null and not o.is_test
  group by o.channel
  order by sum(o.net_sales) desc, o.channel;
$$;

revoke all on function public.dashboard_sales_by_period(uuid, timestamptz, timestamptz, text, text) from public, anon;
revoke all on function public.dashboard_top_products(uuid, timestamptz, timestamptz, int) from public, anon;
revoke all on function public.dashboard_sales_by_channel(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.dashboard_sales_by_period(uuid, timestamptz, timestamptz, text, text) to authenticated;
grant execute on function public.dashboard_top_products(uuid, timestamptz, timestamptz, int) to authenticated;
grant execute on function public.dashboard_sales_by_channel(uuid, timestamptz, timestamptz) to authenticated;
