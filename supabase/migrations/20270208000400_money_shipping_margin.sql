-- Money: shipping margin by month, from Shipping's own parcels.
--
-- Each shop order counts once, in the month (in the workspace's timezone)
-- its first parcel went: what the shopper paid for shipping (the order's
-- `total_shipping`, counted once however many boxes), against what every
-- parcel of it cost in postage (`shipments.cost`, voided parcels left out;
-- a parcel that rode on another's label carries no cost of its own). How
-- many orders had a cost noted is handed back too, so a month with labels
-- bought elsewhere isn't read as free postage.
--
-- Read as the member; row-level security decides what is seen. Nothing
-- about who an order was for is read.

create function public.money_shipping_by_month(
  p_tenant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_timezone text
)
returns table (
  month date,
  orders bigint,
  collected_cents bigint,
  cost_cents bigint,
  costed bigint
)
language sql stable set search_path = ''
as $$
  with per_order as (
    select so.order_id,
           min(s.shipped_at) as first_at,
           round(coalesce(sum(s.cost), 0) * 100)::bigint as cost_cents,
           count(s.cost) as costed
    from public.shipments s
    join public.shipping_orders so on so.id = s.shipping_order_id and so.tenant_id = p_tenant_id
    where s.tenant_id = p_tenant_id and s.voided_at is null
    group by so.order_id
  )
  select date_trunc('month', po.first_at at time zone p_timezone)::date,
         count(*)::bigint,
         round(coalesce(sum(o.total_shipping), 0) * 100)::bigint,
         coalesce(sum(po.cost_cents), 0)::bigint,
         count(*) filter (where po.costed > 0)
  from per_order po
  join public.orders o on o.id = po.order_id and o.tenant_id = p_tenant_id
  where po.first_at >= p_from and po.first_at < p_to
    and o.cancelled_at is null and not o.is_test
  group by 1
  order by 1;
$$;

revoke all on function public.money_shipping_by_month(uuid, timestamptz, timestamptz, text)
  from public, anon;
grant execute on function public.money_shipping_by_month(uuid, timestamptz, timestamptz, text)
  to authenticated;
