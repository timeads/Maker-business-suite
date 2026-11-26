-- Money: what the split into business lines needs from the shop.
--
-- The order's tags, the product's tags, and on each item the date it is for
-- (the Bookings date's id the product page put on the cart line, or a date
-- written on the line by another booking app). All read-only from the shop,
-- with the permissions the sync already has.
--
-- Every new column may be empty: orders synced before this simply don't have
-- them until the backfill below reads them again. A worker still on earlier
-- code sends none of them, and the sync function then keeps what is stored
-- rather than wiping it.

alter table public.orders add column tags text[];
alter table public.products add column tags text[];
alter table public.order_lines
  add column session_ref uuid,
  add column class_date date check (class_date between '2000-01-01' and '2100-12-31');

-- ---------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------

-- How a tag or type is compared: capitals, outer spaces and hyphen,
-- underscore or space between words don't matter. The twin of `sameWord()`
-- in src/lib/dashboard/lines.ts.
create function private.money_word(p_value text)
returns text
language sql immutable set search_path = ''
as $$ select regexp_replace(lower(btrim(coalesce(p_value, ''))), '[-_[:space:]]+', ' ', 'g') $$;

-- A list of tags as the shop gave them, tidied: trimmed, no empties, eighty
-- characters each, fifty at most. Null when the list wasn't sent at all.
create function private.tidy_tags(p_tags jsonb)
returns text[]
language sql immutable set search_path = ''
as $$
  select case
    when p_tags is null or jsonb_typeof(p_tags) <> 'array' then null
    else coalesce((
      select array_agg(left(btrim(picked.t), 80) order by picked.n)
      from (
        select e.t, e.n
        from jsonb_array_elements_text(p_tags) with ordinality as e(t, n)
        where btrim(e.t) <> ''
        order by e.n
        limit 50
      ) picked
    ), '{}')
  end
$$;

-- A date's id from a cart line, only when it has the shape of one.
create function private.uuid_or_null(p_value text)
returns uuid
language sql immutable set search_path = ''
as $$
  select case
    when btrim(coalesce(p_value, '')) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then btrim(p_value)::uuid
  end
$$;

-- A calendar date written as YYYY-MM-DD (anything after it ignored), or null.
create function private.date_or_null(p_value text)
returns date
language plpgsql immutable set search_path = ''
as $$
declare
  v date;
begin
  if coalesce(p_value, '') !~ '^\s*\d{4}-\d{2}-\d{2}' then
    return null;
  end if;
  v := substring(btrim(p_value) from 1 for 10)::date;
  return case when v between date '2000-01-01' and date '2100-12-31' then v end;
exception when others then
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Sync (service role, one named workspace)
-- ---------------------------------------------------------------------------

-- As before, plus the order's tags, each product's tags, and on each item the
-- Bookings date's id and a date written on the cart line.
--
-- What a sender left out is kept as it is: a worker on earlier code sends no
-- `tags` and no item dates, and an order it rewrites keeps the ones already
-- read. An empty list from a current sender does clear them.
create or replace function public.upsert_commerce_batch(
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
  v_kept jsonb;
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
    (tenant_id, provider, external_id, title, vendor, product_type, status, source_updated_at,
     tags, synced_at)
  select p_tenant_id, p_provider, p.external_id, p.title, p.vendor, p.product_type, p.status,
         p.source_updated_at, private.tidy_tags(e -> 'tags'), now()
  from jsonb_array_elements(coalesce(p_products, '[]'::jsonb)) as e,
       jsonb_to_record(e) as p(
         external_id text, title text, vendor text, product_type text, status text,
         source_updated_at timestamptz)
  on conflict (tenant_id, provider, external_id) do update set
    title = excluded.title, vendor = excluded.vendor, product_type = excluded.product_type,
    status = excluded.status, source_updated_at = excluded.source_updated_at,
    tags = coalesce(excluded.tags, public.products.tags), synced_at = now();

  for v_order in select * from jsonb_array_elements(coalesce(p_orders, '[]'::jsonb))
  loop
    insert into public.orders
      (tenant_id, provider, external_id, name, customer_external_id, email, processed_at, currency,
       net_sales, total_tax, total_shipping, total, financial_status, fulfillment_status, channel,
       cancelled_at, is_test, source_updated_at, gross_sales, total_discounts, tags, synced_at)
    select p_tenant_id, p_provider, o.external_id, o.name, o.customer_external_id, lower(o.email),
           o.processed_at, o.currency, coalesce(o.net_sales, 0), coalesce(o.total_tax, 0),
           coalesce(o.total_shipping, 0), coalesce(o.total, 0), o.financial_status,
           o.fulfillment_status, coalesce(nullif(o.channel, ''), 'Other'), o.cancelled_at,
           coalesce(o.is_test, false), o.source_updated_at,
           case when o.gross_sales >= 0 then round(o.gross_sales, 2) end,
           case when o.total_discounts >= 0 then round(o.total_discounts, 2) end,
           private.tidy_tags(v_order -> 'tags'), now()
    from jsonb_to_record(v_order) as o(
      external_id text, name text, customer_external_id text, email text, processed_at timestamptz,
      currency text, net_sales numeric, total_tax numeric, total_shipping numeric, total numeric,
      financial_status text, fulfillment_status text, channel text, cancelled_at timestamptz,
      is_test boolean, source_updated_at timestamptz, gross_sales numeric,
      total_discounts numeric)
    on conflict (tenant_id, provider, external_id) do update set
      name = excluded.name, customer_external_id = excluded.customer_external_id,
      email = excluded.email, processed_at = excluded.processed_at, currency = excluded.currency,
      net_sales = excluded.net_sales, total_tax = excluded.total_tax,
      total_shipping = excluded.total_shipping, total = excluded.total,
      financial_status = excluded.financial_status,
      fulfillment_status = excluded.fulfillment_status, channel = excluded.channel,
      cancelled_at = excluded.cancelled_at, is_test = excluded.is_test,
      source_updated_at = excluded.source_updated_at, gross_sales = excluded.gross_sales,
      total_discounts = excluded.total_discounts,
      tags = coalesce(excluded.tags, public.orders.tags), synced_at = now()
    returning id into v_order_id;

    -- The items' dates already read, for a sender that doesn't send them.
    select coalesce(jsonb_object_agg(l.external_id,
             jsonb_build_object('s', l.session_ref, 'd', l.class_date)), '{}'::jsonb)
    into v_kept
    from public.order_lines l
    where l.order_id = v_order_id and (l.session_ref is not null or l.class_date is not null);

    delete from public.order_lines l where l.order_id = v_order_id;
    insert into public.order_lines
      (tenant_id, order_id, external_id, product_external_id, title, variant_title, sku, quantity,
       unit_price, unit_cost, session_ref, class_date)
    select p_tenant_id, v_order_id, l.external_id, l.product_external_id,
           coalesce(l.title, 'Item'), l.variant_title, l.sku, coalesce(l.quantity, 0),
           coalesce(l.unit_price, 0), l.unit_cost,
           case when e ? 'session_ref' then private.uuid_or_null(e ->> 'session_ref')
                else private.uuid_or_null(v_kept -> l.external_id ->> 's') end,
           case when e ? 'class_date' then private.date_or_null(e ->> 'class_date')
                else private.date_or_null(v_kept -> l.external_id ->> 'd') end
    from jsonb_array_elements(coalesce(v_order -> 'lines', '[]'::jsonb)) as e,
         jsonb_to_record(e) as l(
           external_id text, product_external_id text, title text, variant_title text, sku text,
           quantity int, unit_price numeric, unit_cost numeric);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privacy: a tag can say something about the shopper, so when they ask to be
-- forgotten an order keeps only the tags the workspace's own line rules look
-- for (business words like "workshop"), and its sales stay in their line.
-- ---------------------------------------------------------------------------

create function private.keep_line_tags_only()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.tags is not null
     and new.email is null and new.customer_external_id is null
     and (old.email is not null or old.customer_external_id is not null) then
    new.tags := coalesce((
      select array_agg(u.t order by u.n)
      from unnest(new.tags) with ordinality as u(t, n)
      where private.money_word(u.t) in (
        select private.money_word(w.word)
        from public.configs c,
             jsonb_array_elements(case when jsonb_typeof(c.body -> 'rules') = 'array'
                                       then c.body -> 'rules' else '[]'::jsonb end) as r(rule),
             jsonb_array_elements_text(case when jsonb_typeof(r.rule -> 'words') = 'array'
                                            then r.rule -> 'words' else '[]'::jsonb end) as w(word)
        where c.tenant_id = new.tenant_id and c.module = 'dashboard' and c.key = 'revenue'
          and r.rule ->> 'match' = 'order_tag'
      )
    ), '{}');
  end if;
  return new;
end;
$$;

create trigger orders_keep_line_tags_only
  before update of email, customer_external_id on public.orders
  for each row execute function private.keep_line_tags_only();

-- ---------------------------------------------------------------------------
-- Backfill: every shop connected before this is read once more in full, so
-- the history gains its tags and dates with no one pressing anything.
--
-- The worker asks `queue_commerce_detail_reads()` now and then; it queues a
-- full sync for each shop not yet read with the new details. Only the new
-- sync code calls `note_commerce_details_read()` when a full read of the
-- orders finishes, so a full sync run by a worker still on earlier code
-- doesn't count: after six hours it is queued again, three tries in all. A
-- shop connected from now on is marked by its own first full sync.
-- ---------------------------------------------------------------------------

create table private.commerce_detail_reads (
  connection_id uuid primary key references public.connections (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  tries int not null default 0,
  queued_at timestamptz,
  done_at timestamptz,
  created_at timestamptz not null default now()
);
create index commerce_detail_reads_tenant_idx on private.commerce_detail_reads (tenant_id);
alter table private.commerce_detail_reads enable row level security;
revoke all on private.commerce_detail_reads from public, anon, authenticated, service_role;

create function public.queue_commerce_detail_reads(p_limit int default 20)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_conn record;
  v_count int := 0;
begin
  for v_conn in
    select c.id, c.tenant_id
    from public.connections c
    left join private.commerce_detail_reads r on r.connection_id = c.id
    where c.provider = 'shopify' and c.status = 'active'
      and (r.connection_id is null
           or (r.done_at is null and r.tries < 3 and r.queued_at < now() - interval '6 hours'))
    order by c.created_at
    limit greatest(1, least(coalesce(p_limit, 20), 100))
  loop
    -- Nothing is queued over a sync already waiting or running; the next look tries again.
    if public.enqueue_sync(v_conn.id, 'full') then
      insert into private.commerce_detail_reads (connection_id, tenant_id, tries, queued_at)
      values (v_conn.id, v_conn.tenant_id, 1, now())
      on conflict (connection_id) do update
        set tries = private.commerce_detail_reads.tries + 1, queued_at = now();
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

create function public.note_commerce_details_read(p_tenant_id uuid, p_provider text)
returns void
language sql security definer set search_path = ''
as $$
  insert into private.commerce_detail_reads (connection_id, tenant_id, done_at)
  select c.id, c.tenant_id, now()
  from public.connections c
  where c.tenant_id = p_tenant_id and c.provider = p_provider
  on conflict (connection_id) do update set done_at = now();
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.queue_commerce_detail_reads(int)',
    'public.note_commerce_details_read(uuid, text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
