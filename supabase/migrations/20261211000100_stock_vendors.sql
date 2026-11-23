-- The shop already knows who each product comes from (its "vendor"). Bring
-- that in: each vendor becomes a supplier, and items that have no supplier
-- yet are filed under theirs. A supplier the workspace chose by hand is
-- never changed by a sync.

alter table public.stock_items
  add column vendor text check (vendor is null or char_length(vendor) <= 120),
  -- What it sells for in the shop.
  add column price numeric(14, 2);

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
end;
$$;
