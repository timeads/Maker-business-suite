-- What an item costs. Until now it was always the shop's cost field. Now, in
-- this order (the same as TuftStock): the workspace's own figure if one was
-- typed, else the average of what checked-in deliveries really cost, else the
-- shop's cost.
--
-- Only the workspace's own figure is stored. The average is worked out on
-- read (lib/stock/cost.ts, on whole cents) from the sums below.

alter table public.stock_items
  -- The workspace's own cost for one unit. Its own planning: the sync
  -- (upsert_stock_items) names the columns it writes and leaves this alone.
  add column own_cost numeric(14, 2)
    check (own_cost is null or own_cost between 0 and 100000000);

-- Sets, or with null clears, the workspace's own cost for one item.
create function public.set_stock_item_own_cost(p_tenant_id uuid, p_item_id uuid, p_cost numeric)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  if p_cost is not null and (p_cost < 0 or p_cost > 100000000) then
    raise exception 'That cost is not valid' using errcode = '22023';
  end if;
  update public.stock_items si set own_cost = round(p_cost, 2)
  where si.tenant_id = p_tenant_id and si.id = p_item_id;
  if not found then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;
end;
$$;
revoke all on function public.set_stock_item_own_cost(uuid, uuid, numeric) from public, anon;
grant execute on function public.set_stock_item_own_cost(uuid, uuid, numeric) to authenticated;

-- For each item that has had a delivery checked in: how many units arrived
-- across all its orders, and what they cost at each line's price. Runs as
-- the member, so row-level security decides what it can see. The division is
-- left to the app, which does it in whole cents.
create function public.stock_received_costs(p_tenant_id uuid)
returns table (stock_item_id uuid, units bigint, total numeric)
language sql stable security invoker set search_path = ''
as $$
  select l.stock_item_id, sum(l.qty_received)::bigint, sum(l.qty_received * l.unit_cost)
  from public.purchase_order_lines l
  where l.tenant_id = p_tenant_id and l.qty_received > 0
  group by l.stock_item_id;
$$;
revoke all on function public.stock_received_costs(uuid) from public, anon;
grant execute on function public.stock_received_costs(uuid) to authenticated;
