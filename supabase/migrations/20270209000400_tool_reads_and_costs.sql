-- The last reads that went round the tools' own policies, and costs.
--
-- A few reads are checked functions (they bypass row-level security), so
-- they ask for the tool themselves now: Bookings' seat figures and
-- Eventbrite links, Shipping's report and the help desk's outbox. Each is as
-- before but for `private.user_tenant_ids()` becoming the workspaces where
-- the person has that tool (no change at all while the switch is off).
--
-- Costs: what the business pays and earns in margin is for owners and
-- admins once a workspace chooses tools per person (`private.can_see_costs`).
-- Shipping's report leaves postage, shipping collected and the margin out
-- for anyone else, and what checked-in deliveries cost comes back empty.
-- Columns that hold a cost on tables the whole team reads (an item's cost,
-- an order line's cost, a parcel's postage) are still readable through the
-- API: the app leaves them out of every member's page (docs/roles.md).

-- Costs are open to the signed-in person who sees them, and to no signed-in
-- person at all (the worker, the sync).
create function private.costs_open(p_tenant_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select (select auth.uid()) is null or private.can_see_costs(p_tenant_id);
$$;
revoke all on function private.costs_open(uuid) from public;
grant execute on function private.costs_open(uuid) to authenticated, service_role;

create or replace function public.eventbrite_order_updates(p_tenant_id uuid)
 RETURNS TABLE(registered_at timestamp with time zone, webhook_id text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select h.registered_at, h.webhook_id from private.eventbrite_hooks h
  where h.tenant_id = p_tenant_id and h.tenant_id in (select private.tool_tenant_ids(array['bookings']))
    and h.registered_at is not null;
$function$;


create or replace function public.session_seat_figures(p_session_ids uuid[])
 RETURNS TABLE(session_id uuid, taken integer, capacity integer, seat_group_id uuid, shared_capacity integer, shared_taken integer, seats_left integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select s.id, private.seats_taken(s.id), s.capacity, s.seat_group_id, g.capacity,
         case when g.id is not null then private.shared_seats_taken(g.id) end,
         private.seats_left(s.id)
  from public.sessions s
  left join public.session_seat_groups g on g.id = s.seat_group_id
  where s.id = any(p_session_ids[1:1000])
    and s.tenant_id in (select private.tool_tenant_ids(array['bookings']));
$function$;


create or replace function public.ticket_outbox(p_ticket_id uuid)
 RETURNS TABLE(id uuid, state text, send_at timestamp with time zone, summary jsonb, error text, author_id uuid, created_at timestamp with time zone, doc jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select q.id, q.state, q.send_at, q.summary, q.error, q.author_id, q.created_at,
         -- The words come back only for an email that failed, so they can be put back in the box.
         case when q.state = 'failed' then q.payload -> 'doc' end
  from private.outbound_queue q
  where q.ticket_id = p_ticket_id
    and q.tenant_id in (select private.tool_tenant_ids(array['helpdesk']))
    and q.state in ('waiting', 'sending', 'failed', 'unsure')
  order by q.created_at;
$function$;


-- As before, for people with Shipping; the money in it only for those who
-- see costs.
create or replace function public.shipping_report(p_tenant_id uuid, p_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 366)));
  v_report jsonb;
begin
  perform private.require_member(p_tenant_id);
  perform private.require_tool(p_tenant_id, 'shipping');
  with live as (
    select s.id, s.cost, s.shipped_at, s.shipping_order_id, s.merged_with
    from public.shipments s
    where s.tenant_id = p_tenant_id and s.voided_at is null
  ), sent as (
    select * from live where live.shipped_at >= v_since and live.merged_with is null
  ), first_parcels as (
    select so.id, so.shipping_paid, so.placed_at, min(live.shipped_at) as first_sent
    from live join public.shipping_orders so on so.id = live.shipping_order_id
    group by so.id
  ), orders_sent as (
    select * from first_parcels fp where fp.first_sent >= v_since
  ), totals as (
    select (select count(*) from sent) as parcels,
           (select count(*) from sent where sent.cost is not null) as priced,
           (select coalesce(sum(sent.cost), 0) from sent) as postage,
           (select count(*) from orders_sent) as orders,
           (select coalesce(sum(os.shipping_paid), 0) from orders_sent os) as collected,
           (select round(avg(extract(epoch from (os.first_sent - os.placed_at)) / 86400.0)::numeric, 1)
            from orders_sent os where os.first_sent >= os.placed_at) as avg_days
  ), places as (
    select so.country_code as country, so.region, count(*) as parcels
    from sent join public.shipping_orders so on so.id = sent.shipping_order_id
    where so.country_code is not null
    group by so.country_code, so.region
    order by count(*) desc, so.country_code, so.region
    limit 8
  )
  select jsonb_build_object(
    'days', greatest(1, least(coalesce(p_days, 30), 366)),
    'parcels', t.parcels, 'priced', t.priced, 'orders', t.orders,
    'postage', t.postage, 'collected', t.collected, 'margin', t.collected - t.postage,
    'avg_days', t.avg_days,
    'destinations', coalesce((select jsonb_agg(jsonb_build_object(
        'country', p.country, 'region', p.region, 'parcels', p.parcels)
        order by p.parcels desc, p.country, p.region) from places p), '[]'::jsonb))
  into v_report
  from totals t;
  if not private.can_see_costs(p_tenant_id) then
    v_report := v_report - 'postage' - 'collected' - 'margin' - 'priced';
  end if;
  return v_report;
end;
$function$;

-- As before, empty for anyone who doesn't see costs.
create or replace function public.stock_received_costs(p_tenant_id uuid)
 RETURNS TABLE(stock_item_id uuid, units bigint, total numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select l.stock_item_id, sum(l.qty_received)::bigint, sum(l.qty_received * l.unit_cost)
  from public.purchase_order_lines l
  where l.tenant_id = p_tenant_id and l.qty_received > 0
    and (select private.costs_open(p_tenant_id))
  group by l.stock_item_id;
$function$;
