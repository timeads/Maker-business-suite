-- The order page, laid out like the bench it replaces: the shop's own tags on
-- an order, and what the products came to before discounts.
--
-- All three columns are optional: orders synced before this simply don't have
-- them, and the page leaves those lines out.

alter table public.shipping_orders add column tags text[];
alter table public.orders add column gross_sales numeric(14, 2);
alter table public.orders add column total_discounts numeric(14, 2);

-- ---------------------------------------------------------------------------
-- Sync (service role, one named workspace)
-- ---------------------------------------------------------------------------

-- As before, plus the products' total before discounts and the discounts
-- themselves, when the shop gives them.
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
       cancelled_at, is_test, source_updated_at, gross_sales, total_discounts, synced_at)
    select p_tenant_id, p_provider, o.external_id, o.name, o.customer_external_id, lower(o.email),
           o.processed_at, o.currency, coalesce(o.net_sales, 0), coalesce(o.total_tax, 0),
           coalesce(o.total_shipping, 0), coalesce(o.total, 0), o.financial_status,
           o.fulfillment_status, coalesce(nullif(o.channel, ''), 'Other'), o.cancelled_at,
           coalesce(o.is_test, false), o.source_updated_at,
           case when o.gross_sales >= 0 then round(o.gross_sales, 2) end,
           case when o.total_discounts >= 0 then round(o.total_discounts, 2) end, now()
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
      total_discounts = excluded.total_discounts, synced_at = now()
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

-- As before, plus the order's tags (twenty at most, trimmed). Each item may
-- now carry an `image` inside `items`, which needs nothing here.
create or replace function public.upsert_shipping_orders(p_tenant_id uuid, p_provider text, p_orders jsonb)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.shipping_orders
    (tenant_id, order_id, provider, external_id, name, placed_at, recipient, company, address1,
     address2, city, region, postal_code, country_code, phone, email, shipping_method, note, items,
     units_left, cancelled, paid, shipping_paid, weight_grams, pickup, tags, synced_at)
  select p_tenant_id, o.id, p_provider, s.external_id, o.name, o.processed_at,
         nullif(btrim(s.recipient), ''), nullif(btrim(s.company), ''), nullif(btrim(s.address1), ''),
         nullif(btrim(s.address2), ''), nullif(btrim(s.city), ''), nullif(btrim(s.region), ''),
         nullif(btrim(s.postal_code), ''), nullif(upper(btrim(s.country_code)), ''),
         nullif(btrim(s.phone), ''), o.email, nullif(left(btrim(s.shipping_method), 200), ''),
         nullif(left(btrim(s.note), 1000), ''), coalesce(s.items, '[]'::jsonb),
         coalesce((select sum(greatest(0, (i ->> 'left')::int))
                   from jsonb_array_elements(coalesce(s.items, '[]'::jsonb)) i), 0),
         o.cancelled_at is not null, coalesce(s.paid, true),
         case when s.shipping_paid >= 0 then round(s.shipping_paid, 2) end,
         case when s.weight_grams >= 0 then s.weight_grams end,
         coalesce(s.pickup, false),
         (select array_agg(left(btrim(picked.t), 80) order by picked.n)
          from (select u.t, u.n from unnest(s.tags) with ordinality as u(t, n)
                where btrim(u.t) <> '' order by u.n limit 20) picked),
         now()
  from jsonb_to_recordset(coalesce(p_orders, '[]'::jsonb)) as s(
    external_id text, recipient text, company text, address1 text, address2 text, city text,
    region text, postal_code text, country_code text, phone text, shipping_method text, note text,
    items jsonb, paid boolean, shipping_paid numeric, weight_grams bigint, pickup boolean,
    tags text[])
  join public.orders o
    on o.tenant_id = p_tenant_id and o.provider = p_provider and o.external_id = s.external_id
  on conflict (order_id) do update set
    name = excluded.name, placed_at = excluded.placed_at, recipient = excluded.recipient,
    company = excluded.company, address1 = excluded.address1, address2 = excluded.address2,
    city = excluded.city, region = excluded.region, postal_code = excluded.postal_code,
    country_code = excluded.country_code, phone = excluded.phone, email = excluded.email,
    shipping_method = excluded.shipping_method, note = excluded.note, items = excluded.items,
    units_left = excluded.units_left, cancelled = excluded.cancelled, paid = excluded.paid,
    shipping_paid = excluded.shipping_paid, weight_grams = excluded.weight_grams,
    pickup = excluded.pickup, tags = excluded.tags, synced_at = now();
$$;

-- ---------------------------------------------------------------------------
-- Privacy: a tag can say something about the shopper ("Returning_Customer"),
-- so the tags go with the address when they ask to be forgotten.
-- ---------------------------------------------------------------------------

create or replace function private.blank_shipping_details()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.email is null and new.customer_external_id is null
     and (old.email is not null or old.customer_external_id is not null) then
    update public.shipments s set recipient = null, destination = null
    where s.shipping_order_id in (
      select so.id from public.shipping_orders so where so.order_id = new.id);
    delete from public.shipping_label_files f
    using public.shipping_label_quotes q, public.shipping_orders so
    where f.quote_id = q.id and so.order_id = new.id
      and (q.shipping_order_id = so.id or so.id = any (q.rider_ids));
    update public.shipping_label_quotes q set request_hash = null
    from public.shipping_orders so
    where so.order_id = new.id and q.request_hash is not null
      and (q.shipping_order_id = so.id or so.id = any (q.rider_ids));
    update public.shipping_orders so
    set recipient = null, company = null, address1 = null, address2 = null, city = null,
        region = null, postal_code = null, phone = null, email = null, note = null,
        hold_reason = '', tags = null
    where so.order_id = new.id;
  end if;
  return new;
end;
$$;
