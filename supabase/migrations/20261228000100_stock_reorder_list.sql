-- The reorder list, as the owner's TuftStock shows it: a photo of the very
-- option on each row, and each item's share of what the shop took in.
--
-- Nothing worked out is stored. The photo is something the shop told us; the
-- share is summed from the sales on read.

alter table public.stock_items
  -- This option's own photo (a yarn's colour, say). The product's main photo
  -- stays in image_url and is used when an option has none of its own.
  add column variant_image_url text
    check (variant_image_url is null or variant_image_url ~ '^https://');

-- Sync (service role, one named workspace): each option's own photo. Touches
-- nothing else on the items, and never the workspace's planning columns.
create function public.set_variant_photos(p_tenant_id uuid, p_provider text, p_items jsonb)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  update public.stock_items si
  set variant_image_url = case when i.image_url ~ '^https://' then left(i.image_url, 1000) end
  from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as i(external_id text, image_url text)
  where si.tenant_id = p_tenant_id and si.provider = p_provider
    and si.external_id = i.external_id
    and si.variant_image_url is distinct from
        (case when i.image_url ~ '^https://' then left(i.image_url, 1000) end);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.set_variant_photos(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.set_variant_photos(uuid, text, jsonb) to service_role;

-- What each stock item brought in over the last p_days days of the
-- workspace's own calendar: units still sold after refunds × the price paid.
-- Runs as the member, so row-level security decides what it can see. Sales
-- are matched to an item exactly as stock_sales_by_day matches them.
create function public.stock_revenue_by_item(p_tenant_id uuid, p_days int default 90)
returns table (stock_item_id uuid, revenue numeric)
language sql stable security invoker set search_path = ''
as $$
  select si.id, sum(l.quantity * l.unit_price)::numeric
  from public.stock_items si
  join public.tenants t on t.id = si.tenant_id
  join public.order_lines l on l.tenant_id = si.tenant_id
    and ((si.sku is not null and l.sku = si.sku)
      or (si.sku is null and l.product_external_id = si.product_external_id
          and coalesce(l.variant_title, '') = coalesce(si.variant_title, '')))
  join public.orders o on o.id = l.order_id
  where si.tenant_id = p_tenant_id
    and o.cancelled_at is null and not o.is_test and l.quantity > 0
    and (o.processed_at at time zone t.timezone)::date
        >= (now() at time zone t.timezone)::date - greatest(1, least(coalesce(p_days, 90), 800))
  group by 1;
$$;
revoke all on function public.stock_revenue_by_item(uuid, int) from public, anon;
grant execute on function public.stock_revenue_by_item(uuid, int) to authenticated;
