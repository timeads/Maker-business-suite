-- Money → Orders: the shop's orders for a range, with what each line rule
-- reads about their items, so the app can say which business lines an order
-- touches (the rules are the revenue setting, evaluated in code, as for
-- revenue by line). Cancelled and test orders are left out, as everywhere in
-- Money. Nothing about who bought is handed back.
--
-- Read as the member; row-level security decides what is seen.

create function public.money_order_list(
  p_tenant_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_status text default null,
  p_q text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  id uuid,
  name text,
  processed_at timestamptz,
  financial_status text,
  tags text[],
  net_sales numeric,
  total numeric,
  items jsonb,
  total_count bigint
)
language sql stable set search_path = ''
as $$
  with linked as (
    select distinct sv.shop_product_id
    from public.services sv
    where sv.tenant_id = p_tenant_id and sv.shop_product_id is not null
  ),
  picked as (
    select o.*
    from public.orders o
    where o.tenant_id = p_tenant_id
      and o.processed_at >= p_from and o.processed_at < p_to
      and o.cancelled_at is null and not o.is_test
      and (p_status is null or p_status = '' or upper(coalesce(o.financial_status, '')) = upper(p_status))
      and (p_q is null or p_q = ''
           or lower(coalesce(o.name, '')) like p_q escape '\'
           or exists (select 1 from unnest(coalesce(o.tags, '{}'::text[])) t
                      where lower(t) like p_q escape '\'))
  )
  select o.id, o.name, o.processed_at, o.financial_status, o.tags, o.net_sales, o.total,
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'product_tags', pr.tags,
                    'product_type', pr.product_type,
                    'workshop', coalesce(l.product_external_id in (select k.shop_product_id from linked k), false)))
           from public.order_lines l
           left join public.products pr
             on pr.tenant_id = p_tenant_id and pr.provider = o.provider
            and pr.external_id = l.product_external_id
           where l.order_id = o.id and l.tenant_id = p_tenant_id), '[]'::jsonb),
         count(*) over ()
  from picked o
  order by o.processed_at desc, o.id
  limit least(greatest(coalesce(p_limit, 50), 1), 2000)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.money_order_list(uuid, timestamptz, timestamptz, text, text, integer, integer)
  from public, anon;
grant execute on function public.money_order_list(uuid, timestamptz, timestamptz, text, text, integer, integer)
  to authenticated;
