-- Money: revenue by business line.
--
-- The lines and their rules are a config (`dashboard` / `revenue`,
-- src/lib/dashboard/lines.ts). Which line a sale belongs to is decided in
-- code by one pure evaluator; the database adds sales up for every set of
-- facts a rule can read (order tags, product, product tags and type, whether
-- the product sells a Bookings workshop) so a year of orders comes back as a
-- few hundred rows, never thousands.
--
-- Everything here runs as the signed-in member, so row-level security
-- decides what is seen; `p_tenant_id` only narrows it.

-- ---------------------------------------------------------------------------
-- What an order counts as revenue, in whole cents. The twin of
-- `orderRevenueCents()` in src/lib/dashboard/lines.ts; a test holds them equal.
--   net_sales: the current subtotal (items after discounts and refunds).
--   order_totals: the current total with tax and shipping; nothing for an
--     order refunded in full or voided.
-- Cancelled and test orders count for nothing under either.
-- ---------------------------------------------------------------------------

create function private.money_order_cents(
  p_net_sales numeric,
  p_total numeric,
  p_cancelled boolean,
  p_is_test boolean,
  p_financial_status text,
  p_figure text
)
returns bigint
language sql immutable set search_path = ''
as $$
  select case
    when coalesce(p_cancelled, false) or coalesce(p_is_test, false) then 0
    when p_figure = 'order_totals' then
      case when upper(coalesce(p_financial_status, '')) in ('REFUNDED', 'VOIDED') then 0
           else round(coalesce(p_total, 0) * 100)::bigint end
    else round(coalesce(p_net_sales, 0) * 100)::bigint
  end
$$;

-- ---------------------------------------------------------------------------
-- Sales under the order-totals figure. Money keeps calling the earlier
-- `dashboard_sales_by_period` / `dashboard_sales_by_channel` for net sales,
-- so a workspace that never changes the setting sees exactly what it did.
-- An order refunded in full or voided isn't counted as an order here either.
-- ---------------------------------------------------------------------------

create function public.money_sales_by_period(
  p_tenant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_grouping text,
  p_timezone text,
  p_figure text
)
returns table (period date, order_count bigint, revenue numeric, cost numeric, costed_sales numeric)
language sql stable set search_path = ''
as $$
  with scoped as (
    select o.id,
           private.money_order_cents(o.net_sales, o.total, o.cancelled_at is not null, o.is_test,
                                     o.financial_status, p_figure) as cents,
           p_figure <> 'order_totals'
             or upper(coalesce(o.financial_status, '')) not in ('REFUNDED', 'VOIDED') as counted,
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
  select s.period, count(*) filter (where s.counted), round(coalesce(sum(s.cents), 0) / 100.0, 2),
         coalesce(sum(t.cost), 0), coalesce(sum(t.costed_sales), 0)
  from scoped s
  left join line_totals t on t.order_id = s.id
  group by s.period
  order by s.period;
$$;

create function public.money_sales_by_channel(
  p_tenant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_figure text
)
returns table (channel text, order_count bigint, revenue numeric)
language sql stable set search_path = ''
as $$
  select o.channel,
         count(*) filter (where p_figure <> 'order_totals'
                           or upper(coalesce(o.financial_status, '')) not in ('REFUNDED', 'VOIDED')),
         round(coalesce(sum(private.money_order_cents(o.net_sales, o.total, false, false,
                                                      o.financial_status, p_figure)), 0) / 100.0, 2)
  from public.orders o
  where o.tenant_id = p_tenant_id
    and o.processed_at >= p_from and o.processed_at < p_to
    and o.cancelled_at is null and not o.is_test
  group by o.channel
  order by 3 desc, o.channel;
$$;

-- ---------------------------------------------------------------------------
-- Revenue for every set of facts a line rule can read.
--
-- Each order's revenue (under the chosen figure) is shared among its items
-- by what each sold for, in whole cents that add back up exactly: the
-- rounded-down share, then the cents left over to the largest remainders
-- (the twin of `splitCents()`). An order with no priced items keeps its
-- revenue whole, on a row with no product.
--
-- When `p_by_class_date` is on, an item for a class counts at the class's
-- start rather than when it was bought. The class is found, in order:
--   1. the Bookings date whose id the product page put on the cart line;
--   2. the earliest date of a booking made from this order for a workshop
--      sold through this product (`book_from_shop`, a manager placing a line,
--      or an import from the earlier booking app);
--   3. a date written on the cart line by another booking app, at the start
--      of that day in the workspace's timezone.
-- `p_dated_only` keeps only items for a class (for deferred revenue).
--
-- Rows come back ordered, so the caller can page through them.
-- ---------------------------------------------------------------------------

create function public.money_line_revenue(
  p_tenant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_grouping text,
  p_timezone text,
  p_figure text default 'net_sales',
  p_by_class_date boolean default false,
  p_dated_only boolean default false
)
returns table (
  period date,
  order_tags text[],
  product_external_id text,
  product_tags text[],
  product_type text,
  workshop boolean,
  dated boolean,
  revenue_cents bigint,
  units bigint
)
language sql stable set search_path = ''
as $$
  with linked as (
    select distinct sv.shop_product_id
    from public.services sv
    where sv.tenant_id = p_tenant_id and sv.shop_product_id is not null
  ),
  candidates as (
    select o.id, o.provider, o.external_id, o.processed_at, o.tags,
           private.money_order_cents(o.net_sales, o.total, false, false, o.financial_status,
                                     p_figure) as revenue
    from public.orders o
    where o.tenant_id = p_tenant_id
      and o.cancelled_at is null and not o.is_test
      and o.processed_at < p_to
      and (
        o.processed_at >= p_from
        -- A class bought before the window can still run inside it.
        or ((p_by_class_date or p_dated_only)
            and o.processed_at >= p_from - interval '2 years'
            and exists (
              select 1 from public.order_lines l
              where l.tenant_id = p_tenant_id and l.order_id = o.id
                and (l.session_ref is not null or l.class_date is not null
                     or l.product_external_id in (select k.shop_product_id from linked k))))
      )
  ),
  items as (
    select c.id as order_id, c.provider, c.external_id as order_ext, c.processed_at, c.tags,
           c.revenue, l.external_id as line_ext, l.product_external_id, l.session_ref,
           l.class_date, greatest(round(l.quantity * l.unit_price * 100), 0)::numeric as weight,
           greatest(l.quantity, 0)::bigint as units
    from candidates c
    join public.order_lines l on l.order_id = c.id and l.tenant_id = p_tenant_id
  ),
  weights as (
    select i.order_id, sum(i.weight) as total_weight from items i group by i.order_id
  ),
  parts as (
    select i.*, w.total_weight
    from items i
    join weights w on w.order_id = i.order_id
    where w.total_weight > 0
    union all
    -- No priced items: the order's revenue stays whole, with no product.
    select c.id, c.provider, c.external_id, c.processed_at, c.tags, c.revenue, null, null, null,
           null, 1, coalesce((select sum(i.units) from items i where i.order_id = c.id), 0), 1
    from candidates c
    where not exists (select 1 from weights w where w.order_id = c.id and w.total_weight > 0)
  ),
  shares as (
    select p.*,
           div(abs(p.revenue)::numeric * p.weight, p.total_weight) as base,
           mod(abs(p.revenue)::numeric * p.weight, p.total_weight) as remainder
    from parts p
  ),
  ranked as (
    select s.*,
           abs(s.revenue) - sum(s.base) over (partition by s.order_id) as left_over,
           row_number() over (partition by s.order_id
                              order by s.remainder desc, s.line_ext nulls last) as place
    from shares s
  ),
  allocated as (
    select r.*,
           (sign(r.revenue) * (r.base + case when r.place <= r.left_over then 1 else 0 end))::bigint
             as cents
    from ranked r
  ),
  dated as (
    select a.*,
           case when p_by_class_date or p_dated_only then coalesce(
             (select s.starts_at from public.sessions s
              where s.tenant_id = p_tenant_id and s.id = a.session_ref),
             (select min(s.starts_at)
              from public.bookings b
              join public.sessions s on s.id = b.session_id and s.tenant_id = p_tenant_id
              join public.services sv on sv.id = s.service_id and sv.tenant_id = p_tenant_id
              where b.tenant_id = p_tenant_id and b.shop_order_id = a.order_ext
                and a.product_external_id is not null
                and sv.shop_product_id = a.product_external_id),
             (a.class_date::timestamp at time zone p_timezone)
           ) end as class_at
    from allocated a
  ),
  attributed as (
    select d.*, coalesce(d.class_at, d.processed_at) as counted_at from dated d
  )
  select date_trunc(
           case when p_grouping in ('day', 'week', 'month') then p_grouping else 'month' end,
           x.counted_at at time zone p_timezone
         )::date,
         x.tags, x.product_external_id, pr.tags, pr.product_type,
         coalesce(x.product_external_id in (select k.shop_product_id from linked k), false),
         x.class_at is not null,
         sum(x.cents)::bigint, sum(x.units)::bigint
  from attributed x
  left join public.products pr
    on pr.tenant_id = p_tenant_id and pr.provider = x.provider
   and pr.external_id = x.product_external_id
  where x.counted_at >= p_from and x.counted_at < p_to
    and (not p_dated_only or x.class_at is not null)
  group by 1, 2, 3, 4, 5, 6, 7
  order by 1, 3 nulls first, 2 nulls first, 4 nulls first, 5 nulls first, 6, 7;
$$;

-- ---------------------------------------------------------------------------
-- The items of recent orders with the facts a rule reads, one row per item
-- (or one per order with no items), for Settings → Money to say how many
-- orders fell to the default line. Ordered, so the caller can page.
-- ---------------------------------------------------------------------------

create function public.money_recent_order_lines(p_tenant_id uuid, p_from timestamptz)
returns table (
  order_id uuid,
  order_tags text[],
  product_external_id text,
  product_tags text[],
  product_type text,
  workshop boolean
)
language sql stable set search_path = ''
as $$
  with linked as (
    select distinct sv.shop_product_id
    from public.services sv
    where sv.tenant_id = p_tenant_id and sv.shop_product_id is not null
  )
  select o.id, o.tags, l.product_external_id, pr.tags, pr.product_type,
         coalesce(l.product_external_id in (select k.shop_product_id from linked k), false)
  from public.orders o
  left join public.order_lines l on l.order_id = o.id and l.tenant_id = p_tenant_id
  left join public.products pr
    on pr.tenant_id = p_tenant_id and pr.provider = o.provider
   and pr.external_id = l.product_external_id
  where o.tenant_id = p_tenant_id and o.processed_at >= p_from
    and o.cancelled_at is null and not o.is_test
  order by o.processed_at desc, o.id, l.external_id nulls first;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.money_sales_by_period(uuid, timestamptz, timestamptz, text, text, text)',
    'public.money_sales_by_channel(uuid, timestamptz, timestamptz, text)',
    'public.money_line_revenue(uuid, timestamptz, timestamptz, text, text, text, boolean, boolean)',
    'public.money_recent_order_lines(uuid, timestamptz)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
