-- Shipping list: what each waiting order would go in and roughly cost.
--
-- The To ship list shows, per order, the box it would be packed in, the best
-- price any connected postage account offered for that box and weight, and
-- whether the carriers know the address. Asking for those takes a moment and
-- (for an address) can cost the business a little, so the answers are kept
-- here and asked again only when the order changes or the price gets old.
--
-- This is a note for the list and nothing more. A price here has no rate id
-- and no carrier's own ids, so it can never be bought: buying still needs a
-- quote in `shipping_label_quotes`, which only the order page makes.
--
-- No address is kept here: `plan_key` and `address_key` are salted
-- fingerprints, compared by the server to tell whether the order has changed.

create table public.shipping_order_plans (
  -- One per order. Goes when the order does (a disconnected shop, an erased workspace).
  shipping_order_id uuid primary key references public.shipping_orders (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- The box a person picked for this order on its page. Null: the usual box.
  chosen_box_id uuid references public.shipping_boxes (id) on delete set null,
  -- The plan the price below was asked for.
  box_id uuid references public.shipping_boxes (id) on delete set null,
  box_source text not null default 'default' check (box_source in ('default', 'person')),
  -- Items plus that box, in tenths of an ounce.
  weight_tenth_oz int check (weight_tenth_oz is null or weight_tenth_oz between 0 and 100000),
  -- A fingerprint of what was priced: address, items left, weight, box, signature.
  plan_key text check (plan_key is null or char_length(plan_key) <= 200),
  -- 'ok': a price below. 'none': asked, and nobody offered one.
  quote_status text check (quote_status is null or quote_status in ('ok', 'none')),
  quote_source text check (quote_source is null or quote_source in ('easypost', 'ups', 'redo')),
  quote_carrier text check (quote_carrier is null or char_length(quote_carrier) <= 60),
  quote_service text check (quote_service is null or char_length(quote_service) <= 120),
  quote_cents int check (quote_cents is null or quote_cents between 0 and 100000000),
  quote_currency text check (quote_currency is null or quote_currency ~ '^[A-Z]{3}$'),
  quoted_at timestamptz,
  -- A fingerprint of the address the carriers were asked about.
  address_key text check (address_key is null or char_length(address_key) <= 200),
  address_status text
    check (address_status is null or address_status in ('found', 'not_found', 'not_checked')),
  address_residential boolean,
  address_checked_at timestamptz,
  -- Someone's list is working this order out right now; others leave it be.
  claimed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index shipping_order_plans_tenant_idx on public.shipping_order_plans (tenant_id);

alter table public.shipping_order_plans enable row level security;
create policy "members read their shipping_order_plans" on public.shipping_order_plans
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));
revoke all on public.shipping_order_plans from public, anon, authenticated, service_role;
grant select on public.shipping_order_plans to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Privacy: a fingerprint of an address is still about the shopper, so the
-- whole note goes when they ask to be forgotten. (When the order itself goes,
-- the row goes with it.)
-- ---------------------------------------------------------------------------

create function private.forget_shipping_order_plans()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.email is null and new.customer_external_id is null
     and (old.email is not null or old.customer_external_id is not null) then
    delete from public.shipping_order_plans p
    using public.shipping_orders so
    where so.order_id = new.id and p.shipping_order_id = so.id;
  end if;
  return new;
end;
$$;
revoke all on function private.forget_shipping_order_plans() from public;
create trigger orders_forget_shipping_plans
  after update of email, customer_external_id on public.orders
  for each row execute function private.forget_shipping_order_plans();

-- ---------------------------------------------------------------------------
-- What a member does: pick the box an order goes in (the whole team packs).
-- ---------------------------------------------------------------------------

-- Remembers the box a person picked for one order, or (null) goes back to the
-- usual box. The price that was worked out for the old box is dropped.
create function public.set_shipping_order_box(p_shipping_order_id uuid, p_box_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.shipping_orders := private.member_shipping_order(p_shipping_order_id);
begin
  if p_box_id is not null and not exists (
    select 1 from public.shipping_boxes b
    where b.id = p_box_id and b.tenant_id = v_order.tenant_id and b.archived_at is null) then
    raise exception 'Box not found' using errcode = 'P0002';
  end if;
  insert into public.shipping_order_plans as p (shipping_order_id, tenant_id, chosen_box_id)
  values (v_order.id, v_order.tenant_id, p_box_id)
  on conflict (shipping_order_id) do update
  set chosen_box_id = excluded.chosen_box_id,
      plan_key = case when p.chosen_box_id is distinct from excluded.chosen_box_id
                      then null else p.plan_key end,
      updated_at = now();
end;
$$;
revoke all on function public.set_shipping_order_box(uuid, uuid) from public, anon;
grant execute on function public.set_shipping_order_box(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- What the server does (service role, one named workspace)
-- ---------------------------------------------------------------------------

-- Takes up to twenty of a workspace's orders to work out, and returns the
-- ones it got. An order someone else's list took in the last two minutes is
-- left alone, so two people opening the list don't ask the carriers twice.
create function public.claim_shipping_order_plans(p_tenant_id uuid, p_order_ids uuid[])
returns setof uuid
language sql security definer set search_path = ''
as $$
  insert into public.shipping_order_plans as p (shipping_order_id, tenant_id, claimed_at)
  select so.id, so.tenant_id, now()
  from public.shipping_orders so
  where so.tenant_id = p_tenant_id
    and so.id in (select u.id from unnest(p_order_ids) as u(id) limit 20)
  on conflict (shipping_order_id) do update set claimed_at = now()
  where p.claimed_at is null or p.claimed_at < now() - interval '2 minutes'
  returning p.shipping_order_id;
$$;

-- Keeps what was worked out for one order and lets go of it. Each half is
-- optional: `p_quote` is the plan and its price, `p_address` what the
-- carriers said about the address. Neither holds an address.
--   p_quote:   {"box_id", "box_source", "weight_tenth_oz", "plan_key", "status",
--               "source", "carrier", "service", "cents", "currency"}
--   p_address: {"address_key", "status", "residential"}
create function public.save_shipping_order_plan(
  p_tenant_id uuid,
  p_shipping_order_id uuid,
  p_quote jsonb default null,
  p_address jsonb default null
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_ok boolean := coalesce(p_quote ->> 'status', '') = 'ok';
  v_box uuid;
begin
  if not exists (
    select 1 from public.shipping_orders so
    where so.id = p_shipping_order_id and so.tenant_id = p_tenant_id) then
    return false;
  end if;
  insert into public.shipping_order_plans (shipping_order_id, tenant_id)
  values (p_shipping_order_id, p_tenant_id)
  on conflict (shipping_order_id) do nothing;

  if p_quote is not null then
    if coalesce(p_quote ->> 'status', '') not in ('ok', 'none') then
      raise exception 'Not a plan' using errcode = '22023';
    end if;
    -- A box from this workspace, or none.
    select b.id into v_box from public.shipping_boxes b
    where b.id = nullif(p_quote ->> 'box_id', '')::uuid and b.tenant_id = p_tenant_id;
    update public.shipping_order_plans p
    set box_id = v_box,
        box_source = case when p_quote ->> 'box_source' = 'person' then 'person' else 'default' end,
        weight_tenth_oz = nullif(p_quote ->> 'weight_tenth_oz', '')::int,
        plan_key = left(p_quote ->> 'plan_key', 200),
        quote_status = p_quote ->> 'status',
        quote_source = case when v_ok then p_quote ->> 'source' end,
        quote_carrier = case when v_ok then left(p_quote ->> 'carrier', 60) end,
        quote_service = case when v_ok then left(p_quote ->> 'service', 120) end,
        quote_cents = case when v_ok then nullif(p_quote ->> 'cents', '')::int end,
        quote_currency = case when v_ok then upper(p_quote ->> 'currency') end,
        quoted_at = now()
    where p.shipping_order_id = p_shipping_order_id;
  end if;

  if p_address is not null then
    update public.shipping_order_plans p
    set address_key = left(p_address ->> 'address_key', 200),
        address_status = p_address ->> 'status',
        address_residential = (p_address ->> 'residential')::boolean,
        address_checked_at = now()
    where p.shipping_order_id = p_shipping_order_id;
  end if;

  update public.shipping_order_plans p
  set claimed_at = null, updated_at = now()
  where p.shipping_order_id = p_shipping_order_id;
  return true;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.claim_shipping_order_plans(uuid, uuid[])',
    'public.save_shipping_order_plan(uuid, uuid, jsonb, jsonb)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
