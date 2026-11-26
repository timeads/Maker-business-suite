-- Bookings: tags on shop orders that need a person.
--
-- The business's earlier booking app tagged an order in the shop when it
-- booked a full date anyway (oversold), when it paid for a workshop with no
-- date on the cart line (needs a date), and when the date it named couldn't
-- be booked (not found, or cancelled). The suite now does the same, at the
-- same moments, with the tag words a config (`bookings` / `shop_tags`).
--
-- A tag is a write to the shop, so it follows the once-only queue the other
-- shop writes use: a row is queued once per order and reason, the worker
-- claims it, tries once and writes down what happened; a claim never
-- finished is marked failed, not tried again. Tags are only ever added
-- (Shopify's `tagsAdd`), never set or taken off.
--
-- Nothing is queued for a shop connected without permission to change
-- orders (`write_orders`): `private.shop_can_tag_orders`, the database's twin
-- of `canTagInShopify` in the app.

-- ---------------------------------------------------------------------------
-- What the shop will let us do
-- ---------------------------------------------------------------------------

create function private.shop_can_tag_orders(p_tenant_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.connections c
    where c.tenant_id = p_tenant_id and c.provider = 'shopify' and c.status = 'active'
      and 'write_orders' = any (c.scopes));
$$;
revoke all on function private.shop_can_tag_orders(uuid) from public;

-- The tag for one reason: the workspace's own word, else the standard one.
-- The standard words are the earlier app's, and `DEFAULT_SHOP_TAGS` in
-- `lib/bookings/shop-tags.ts` holds the same (a test keeps them in step).
-- Null when the workspace switched order tags off.
create function private.shop_tag_for(p_tenant_id uuid, p_reason text)
returns text
language sql stable security definer set search_path = ''
as $$
  with cfg as (
    select c.body from public.configs c
    where c.tenant_id = p_tenant_id and c.module = 'bookings' and c.key = 'shop_tags'
  ), standard as (
    select case p_reason
      when 'oversold' then 'ttw-oversold'
      when 'needs_date' then 'ttw-needs-date'
      when 'booking_error' then 'ttw-booking-error' end as tag
  )
  select case
    when exists (select 1 from cfg where cfg.body -> 'on' = 'false'::jsonb) then null
    else coalesce(
      (select nullif(btrim(left(cfg.body -> 'tags' ->> p_reason, 40)), '') from cfg),
      (select standard.tag from standard)) end;
$$;
revoke all on function private.shop_tag_for(uuid, text) from public;

-- ---------------------------------------------------------------------------
-- The queue
-- ---------------------------------------------------------------------------

create table public.shop_order_tags (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  provider text not null default 'shopify' check (provider = 'shopify'),
  shop_order_id text not null check (char_length(shop_order_id) between 1 and 40),
  shop_order_name text not null default '' check (char_length(shop_order_name) <= 40),
  -- Why: oversold, needs_date (no date on the line), booking_error (a date
  -- we can't find, or one that was cancelled).
  reason text not null check (reason in ('oversold', 'needs_date', 'booking_error')),
  -- The word as it was when queued; a later change of word isn't sent again.
  tag text not null check (char_length(tag) between 1 and 40),
  -- pending: waiting for the worker. sending: claimed. done: the shop has it.
  -- not_allowed: the shop said this connection may not change orders.
  -- failed: see error; never tried again by itself.
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'done', 'not_allowed', 'failed')),
  error text check (error is null or char_length(error) <= 500),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz,
  unique (tenant_id, provider, shop_order_id, reason)
);
create index shop_order_tags_open_idx on public.shop_order_tags (status, created_at)
  where status in ('pending', 'sending');
create index shop_order_tags_tenant_idx on public.shop_order_tags (tenant_id, created_at desc);

alter table public.shop_order_tags enable row level security;
revoke all on public.shop_order_tags from anon, authenticated;
grant select on public.shop_order_tags to authenticated;
create policy shop_order_tags_select on public.shop_order_tags
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));

-- Called by the shop sync (service role) at the moments the earlier app
-- tagged: a booking made over the limit, a line with no date, a date that
-- can't be booked. Once per order and reason, whatever happens after.
-- Returns queued, already, off (the workspace switched tags off) or
-- not_allowed (the shop is connected without permission to change orders:
-- nothing is queued).
create function public.queue_shop_order_tag(
  p_tenant_id uuid,
  p_provider text,
  p_order_id text,
  p_order_name text,
  p_reason text
)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_tag text;
  v_id uuid;
begin
  if p_reason is null or p_reason not in ('oversold', 'needs_date', 'booking_error') then
    raise exception 'Unknown reason' using errcode = '22023';
  end if;
  if coalesce(p_provider, '') <> 'shopify' or coalesce(btrim(p_order_id), '') = '' then
    return 'not_allowed';
  end if;
  if exists (
    select 1 from public.shop_order_tags t
    where t.tenant_id = p_tenant_id and t.provider = p_provider
      and t.shop_order_id = left(btrim(p_order_id), 40) and t.reason = p_reason) then
    return 'already';
  end if;
  v_tag := private.shop_tag_for(p_tenant_id, p_reason);
  if v_tag is null then
    return 'off';
  end if;
  if not private.shop_can_tag_orders(p_tenant_id) then
    return 'not_allowed';
  end if;
  insert into public.shop_order_tags (tenant_id, provider, shop_order_id, shop_order_name, reason, tag)
  values (p_tenant_id, p_provider, left(btrim(p_order_id), 40),
          left(coalesce(p_order_name, ''), 40), p_reason, v_tag)
  on conflict (tenant_id, provider, shop_order_id, reason) do nothing
  returning id into v_id;
  return case when v_id is null then 'already' else 'queued' end;
end;
$$;

-- Hands the worker the tags to add, each once. A claim nobody finished in
-- 15 minutes is marked failed: we can't tell whether the shop has it, and
-- the person can add a tag by hand in a second.
create function public.claim_shop_order_tags(p_limit int default 20)
returns table (
  id uuid, tenant_id uuid, provider text, shop_order_id text, shop_order_name text,
  tag text, can_write boolean
)
language plpgsql security definer set search_path = ''
as $$
#variable_conflict use_column
begin
  update public.shop_order_tags t
  set status = 'failed', finished_at = now(),
      error = 'We lost touch part-way through, so we can''t tell whether your shop has this tag'
  where t.status = 'sending' and t.claimed_at < now() - interval '15 minutes';

  return query
  with due as (
    select t.id from public.shop_order_tags t
    where t.status = 'pending'
    order by t.created_at, t.id
    limit greatest(1, least(coalesce(p_limit, 20), 100))
    for update skip locked
  ), taken as (
    update public.shop_order_tags t
    set status = 'sending', claimed_at = now()
    from due where t.id = due.id
    returning t.id, t.tenant_id, t.provider, t.shop_order_id, t.shop_order_name, t.tag
  )
  select taken.id, taken.tenant_id, taken.provider, taken.shop_order_id, taken.shop_order_name,
         taken.tag, private.shop_can_tag_orders(taken.tenant_id)
  from taken;
end;
$$;

create function public.finish_shop_order_tag(p_id uuid, p_outcome text, p_error text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_outcome is null or p_outcome not in ('done', 'not_allowed', 'failed') then
    raise exception 'Unknown outcome' using errcode = '22023';
  end if;
  update public.shop_order_tags t
  set status = p_outcome, finished_at = now(),
      error = case when p_outcome = 'done' then null else left(p_error, 500) end
  where t.id = p_id and t.status = 'sending';
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.queue_shop_order_tag(uuid, text, text, text, text)',
    'public.claim_shop_order_tags(int)',
    'public.finish_shop_order_tag(uuid, text, text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
