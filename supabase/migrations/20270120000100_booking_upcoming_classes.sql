-- "Upcoming classes": a list of a workshop's open dates for a shop's own
-- workshops page, drawn by a small script on the shop's site and read from a
-- public endpoint that names the workspace (`/api/book/upcoming`).
--
-- It says only what a shopper could see on a product page anyway: for each
-- workshop the business sells through its shop, the dates that are public,
-- taking bookings, still to come (past the shop page's cut-off) and have a
-- place left, how many places are left, and the product's page in the shop
-- as the shop sync stored it (https only). Nothing about anyone booked.
--
-- Whether a workspace shows the list at all is its own config (bookings /
-- upcoming, off unless switched on); the server reads that before asking.

create function public.shop_upcoming_classes(
  p_tenant_id uuid, p_cutoff_hours int default 12, p_limit int default 12
)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(row_to_json(d)::jsonb order by d.starts_at), '[]'::jsonb)
  from (
    select s.id, s.starts_at, s.ends_at, sv.name as service, sv.location,
           private.seats_left(s.id) as seats_left,
           (select left(si.product_url, 1000)
            from public.stock_items si
            where si.tenant_id = sv.tenant_id and si.product_external_id = sv.shop_product_id
              and si.product_url ~ '^https://[A-Za-z0-9.-]+/'
            order by si.synced_at desc
            limit 1) as product_url
    from public.sessions s
    join public.services sv on sv.id = s.service_id
    where sv.tenant_id = p_tenant_id and sv.active and sv.kind = 'workshop'
      and sv.shop_product_id is not null
      and s.cancelled_at is null and not s.private and not s.bookings_closed
      and s.starts_at > now() + make_interval(hours => greatest(0, least(coalesce(p_cutoff_hours, 12), 336)))
      and s.starts_at < now() + interval '400 days'
      and private.seats_left(s.id) > 0
    order by s.starts_at
    limit greatest(1, least(coalesce(p_limit, 12), 50))
  ) d;
$$;
revoke all on function public.shop_upcoming_classes(uuid, int, int) from public, anon, authenticated;
grant execute on function public.shop_upcoming_classes(uuid, int, int) to service_role;
