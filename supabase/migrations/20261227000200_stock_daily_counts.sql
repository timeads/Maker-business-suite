-- Sold-out days. A day an item had none to sell is not a day nobody wanted
-- it, so the sales rate leaves those days out (the engine already knows how:
-- lib/stock/engine/velocity.ts). To know which days those were, the sync
-- writes down each counted item's count once a day.
--
-- Only what was seen is kept: the count on that day. Whether a day counts as
-- "sold out" (none on the shelf and none sold) is worked out on read.
-- Kept for 200 days: the longest window the sums look back over is 180.

create table public.stock_daily_counts (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  stock_item_id uuid not null references public.stock_items (id) on delete cascade,
  -- The workspace's own calendar day.
  day date not null,
  -- The shop's count the last time it was read that day.
  on_hand int not null,
  primary key (stock_item_id, day)
);
-- What the Stock screens ask for: the days an item had none.
create index stock_daily_counts_empty_idx
  on public.stock_daily_counts (tenant_id, day)
  where on_hand <= 0;

alter table public.stock_daily_counts enable row level security;
create policy "members read their stock_daily_counts" on public.stock_daily_counts
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));
revoke all on public.stock_daily_counts from public, anon, authenticated, service_role;
grant select on public.stock_daily_counts to authenticated, service_role;

-- The sync, as before (items, vendors as suppliers), and now the day's count.
create or replace function public.upsert_stock_items(p_tenant_id uuid, p_provider text, p_items jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.stock_items
    (tenant_id, provider, external_id, product_external_id, inventory_item_id, title, variant_title,
     sku, on_hand, unit_cost, tracked, product_status, vendor, price, synced_at)
  select p_tenant_id, p_provider, i.external_id, i.product_external_id, i.inventory_item_id,
         coalesce(nullif(btrim(i.title), ''), 'Item'), nullif(btrim(i.variant_title), ''),
         nullif(btrim(i.sku), ''), coalesce(i.on_hand, 0), i.unit_cost, coalesce(i.tracked, true),
         i.product_status, nullif(left(btrim(i.vendor), 120), ''), i.price, now()
  from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as i(
    external_id text, product_external_id text, inventory_item_id text, title text,
    variant_title text, sku text, on_hand int, unit_cost numeric, tracked boolean,
    product_status text, vendor text, price numeric)
  where i.external_id is not null
  on conflict (tenant_id, provider, external_id) do update set
    product_external_id = excluded.product_external_id,
    inventory_item_id = excluded.inventory_item_id, title = excluded.title,
    variant_title = excluded.variant_title, sku = excluded.sku, on_hand = excluded.on_hand,
    unit_cost = excluded.unit_cost, tracked = excluded.tracked,
    product_status = excluded.product_status, vendor = excluded.vendor, price = excluded.price,
    synced_at = now();

  -- A supplier for each vendor in this batch that isn't one already.
  insert into public.suppliers (tenant_id, name)
  select distinct p_tenant_id, left(btrim(i.vendor), 120)
  from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as i(vendor text)
  where nullif(btrim(i.vendor), '') is not null
  on conflict (tenant_id, name) do nothing;

  -- File this batch's items under their vendor, where nobody has chosen yet.
  update public.stock_items si
  set supplier_id = s.id
  from public.suppliers s
  where si.tenant_id = p_tenant_id and si.provider = p_provider and si.supplier_id is null
    and si.vendor is not null and s.tenant_id = p_tenant_id and s.name = si.vendor
    and s.archived_at is null
    and si.external_id in (
      select i.external_id
      from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as i(external_id text));

  -- Today's count for each counted item in this batch, on the workspace's own
  -- calendar. A later sync the same day replaces it, so the last look before
  -- midnight is the one kept (as TuftStock's nightly count does).
  insert into public.stock_daily_counts (tenant_id, stock_item_id, day, on_hand)
  select si.tenant_id, si.id, (now() at time zone t.timezone)::date, si.on_hand
  from public.stock_items si
  join public.tenants t on t.id = si.tenant_id
  where si.tenant_id = p_tenant_id and si.provider = p_provider and si.tracked
    and si.external_id in (
      select i.external_id
      from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as i(external_id text))
  on conflict (stock_item_id, day) do update set on_hand = excluded.on_hand
    where public.stock_daily_counts.on_hand is distinct from excluded.on_hand;

  -- Counts too old for any sum to use are let go.
  delete from public.stock_daily_counts c
  using public.stock_items si
  where c.stock_item_id = si.id and si.tenant_id = p_tenant_id and si.provider = p_provider
    and si.external_id in (
      select i.external_id
      from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as i(external_id text))
    and c.day < (now() at time zone 'UTC')::date - 200;
end;
$$;
