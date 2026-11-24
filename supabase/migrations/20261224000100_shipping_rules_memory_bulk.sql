-- Shipping: rules, packing memory, saved choices and buying labels in bulk.
--
-- Rules themselves are a setting (`configs`, module "shipping", key "rules")
-- and need nothing here. What does:
--   * a mark on an order saying a rule's hold has had its say, so an order a
--     person released is never held again by the same rule;
--   * `shipping_packings`: the boxes a whole order went in, remembered for
--     that exact set of items (no shopper, no address: item codes and counts);
--   * `shipping_order_plans.saved_choice`: what a person set up for one order
--     on its page, kept so it can be bought later, there or in a bulk run;
--   * `shipping_label_batches`: a record of each bulk run and what became of
--     every order in it.
--
-- Nothing here buys a label or loosens how one is bought. A bulk run buys
-- each order through `claim_label_purchase` exactly as a single purchase
-- does; the batch only writes down what happened.

-- ---------------------------------------------------------------------------
-- A rule's hold, once per order
-- ---------------------------------------------------------------------------

alter table public.shipping_orders
  -- Set when a rule has held this order, or when a person has released it
  -- from any hold. From then on no rule holds it again.
  add column rule_hold_settled_at timestamptz;

-- However an order comes off hold (one order, many, or a hold whose day came
-- and was opened), it counts as a person's decision.
create function private.note_shipping_hold_released()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.on_hold and not new.on_hold and new.rule_hold_settled_at is null then
    new.rule_hold_settled_at := now();
  end if;
  return new;
end;
$$;
revoke all on function private.note_shipping_hold_released() from public;
create trigger shipping_orders_hold_released
  before update of on_hold on public.shipping_orders
  for each row execute function private.note_shipping_hold_released();

-- Puts the orders a rule says to hold on hold, with the rule's note. Only
-- orders that are still waiting, aren't on hold already, and that no rule has
-- held (and no person released) before. Running it again changes nothing.
--   p_holds: [{"id": uuid, "note": text}]
create function public.hold_shipping_orders_by_rule(p_tenant_id uuid, p_holds jsonb)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  perform private.require_member(p_tenant_id);
  if p_holds is null or jsonb_typeof(p_holds) <> 'array' then
    return 0;
  end if;
  update public.shipping_orders so
  set on_hold = true,
      hold_reason = left(btrim(coalesce(h.note, '')), 300),
      hold_until = null,
      rule_hold_settled_at = now()
  from (
    select distinct on (x.id) x.id, x.note
    from (select (e ->> 'id')::uuid as id, e ->> 'note' as note
          from jsonb_array_elements(p_holds) e limit 500) x
    order by x.id
  ) h
  where so.id = h.id and so.tenant_id = p_tenant_id
    and not so.on_hold and so.rule_hold_settled_at is null
    and not so.cancelled and so.units_left > 0 and so.picked_up_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.hold_shipping_orders_by_rule(uuid, jsonb) from public, anon;
grant execute on function public.hold_shipping_orders_by_rule(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Packing memory
-- ---------------------------------------------------------------------------

create table public.shipping_packings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- Item code (or product name) × how many, sorted: "ak5-cut×1|yarn-mustard×4".
  item_key text not null check (char_length(item_key) between 1 and 500),
  -- The same products whatever the quantities, for "similar" orders.
  products_key text check (products_key is null or char_length(products_key) <= 500),
  -- "1 × AK5 machine, 4 × Yarn (Mustard)": what it was for, in words.
  label text not null default '' check (char_length(label) <= 500),
  -- [{"box_id", "length", "width", "height", "weight_tenth_oz", "items": {product: qty}}]
  boxes jsonb not null
    check (jsonb_typeof(boxes) = 'array' and jsonb_array_length(boxes) between 1 and 6),
  uses int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, item_key)
);
create index shipping_packings_products_idx
  on public.shipping_packings (tenant_id, products_key, updated_at);

alter table public.shipping_packings enable row level security;
create policy "members read their shipping_packings" on public.shipping_packings
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));
revoke all on public.shipping_packings from public, anon, authenticated, service_role;
grant select on public.shipping_packings to authenticated, service_role;

-- Remembers how a set of items was packed, replacing what was remembered for
-- the same items before. Written by the server after a label for a whole
-- order has been bought and recorded. A workspace keeps its latest 5,000.
create function public.learn_shipping_packing(
  p_tenant_id uuid,
  p_item_key text,
  p_products_key text,
  p_label text,
  p_boxes jsonb
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_tenant_id is null or coalesce(btrim(p_item_key), '') = ''
     or p_boxes is null or jsonb_typeof(p_boxes) <> 'array'
     or jsonb_array_length(p_boxes) not between 1 and 6
     or exists (
       select 1 from jsonb_array_elements(p_boxes) b
       where jsonb_typeof(b) <> 'object'
          or coalesce((b ->> 'length')::numeric, 0) not between 0.01 and 108
          or coalesce((b ->> 'width')::numeric, 0) not between 0.01 and 108
          or coalesce((b ->> 'height')::numeric, 0) not between 0.01 and 108
          or coalesce((b ->> 'weight_tenth_oz')::numeric, -1) not between 0 and 24000) then
    raise exception 'Not a packing' using errcode = '22023';
  end if;
  if not exists (select 1 from public.tenants t where t.id = p_tenant_id) then
    raise exception 'Workspace not found' using errcode = 'P0002';
  end if;
  insert into public.shipping_packings as p (tenant_id, item_key, products_key, label, boxes)
  values (p_tenant_id, left(p_item_key, 500), nullif(left(p_products_key, 500), ''),
          left(coalesce(p_label, ''), 500), p_boxes)
  on conflict (tenant_id, item_key) do update
  set products_key = excluded.products_key, label = excluded.label, boxes = excluded.boxes,
      uses = p.uses + 1, updated_at = now()
  returning p.id into v_id;
  delete from public.shipping_packings old
  where old.tenant_id = p_tenant_id and old.id in (
    select x.id from public.shipping_packings x
    where x.tenant_id = p_tenant_id
    order by x.updated_at desc, x.id
    offset 5000);
  return v_id;
end;
$$;
revoke all on function public.learn_shipping_packing(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.learn_shipping_packing(uuid, text, text, text, jsonb)
  to service_role;

-- "Forget" one remembered packing (owners and admins).
create function public.forget_shipping_packing(p_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select p.tenant_id into v_tenant from public.shipping_packings p
  where p.id = p_id and p.tenant_id in (select private.user_tenant_ids());
  if not found then
    return false;
  end if;
  perform private.require_manager(v_tenant);
  delete from public.shipping_packings p where p.id = p_id;
  return true;
end;
$$;
revoke all on function public.forget_shipping_packing(uuid) from public, anon;
grant execute on function public.forget_shipping_packing(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- What a person set up for one order, and where a plan's box came from
-- ---------------------------------------------------------------------------

alter table public.shipping_order_plans
  -- Boxes, weights, which items go where, signature and service, as set on
  -- the order's page (see `lib/shipping/choices.ts`). Never an address.
  add column saved_choice jsonb
    check (saved_choice is null
           or (jsonb_typeof(saved_choice) = 'object' and octet_length(saved_choice::text) <= 16000)),
  add column saved_at timestamptz,
  add column saved_by uuid references auth.users (id) on delete set null,
  -- The price is for the service a rule or a saved choice asked for.
  add column quote_by_rule boolean not null default false;

alter table public.shipping_order_plans
  drop constraint shipping_order_plans_box_source_check;
alter table public.shipping_order_plans
  add constraint shipping_order_plans_box_source_check
  check (box_source in ('default', 'person', 'rule', 'learned', 'learned-similar', 'saved'));

-- Keeps what a person set up for one order, or (null) forgets it and goes
-- back to the plan. Either way the list's price for the old set-up is dropped,
-- and the single remembered box gives way to this.
create function public.save_shipping_order_choice(p_shipping_order_id uuid, p_choice jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.shipping_orders := private.member_shipping_order(p_shipping_order_id);
begin
  if p_choice is not null and (
       jsonb_typeof(p_choice) <> 'object'
       or jsonb_typeof(p_choice -> 'boxes') is distinct from 'array'
       or jsonb_array_length(p_choice -> 'boxes') not between 1 and 6
       or octet_length(p_choice::text) > 16000) then
    raise exception 'Not a saved choice' using errcode = '22023';
  end if;
  insert into public.shipping_order_plans as p
    (shipping_order_id, tenant_id, saved_choice, saved_at, saved_by)
  values (v_order.id, v_order.tenant_id, p_choice,
          case when p_choice is null then null else now() end,
          case when p_choice is null then null else auth.uid() end)
  on conflict (shipping_order_id) do update
  set saved_choice = excluded.saved_choice,
      saved_at = excluded.saved_at,
      saved_by = excluded.saved_by,
      chosen_box_id = null,
      plan_key = null,
      updated_at = now();
end;
$$;
revoke all on function public.save_shipping_order_choice(uuid, jsonb) from public, anon;
grant execute on function public.save_shipping_order_choice(uuid, jsonb) to authenticated;

-- As before, and it now also keeps where the plan's box came from (a rule,
-- memory, a saved choice) and whether the price is for a service a rule asked
-- for. Still no address, no rate id: nothing here can be bought.
create or replace function public.save_shipping_order_plan(
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
        box_source = case
          when p_quote ->> 'box_source' in ('person', 'rule', 'learned', 'learned-similar', 'saved')
          then p_quote ->> 'box_source' else 'default' end,
        weight_tenth_oz = nullif(p_quote ->> 'weight_tenth_oz', '')::int,
        plan_key = left(p_quote ->> 'plan_key', 200),
        quote_status = p_quote ->> 'status',
        quote_source = case when v_ok then p_quote ->> 'source' end,
        quote_carrier = case when v_ok then left(p_quote ->> 'carrier', 60) end,
        quote_service = case when v_ok then left(p_quote ->> 'service', 120) end,
        quote_cents = case when v_ok then nullif(p_quote ->> 'cents', '')::int end,
        quote_currency = case when v_ok then upper(p_quote ->> 'currency') end,
        quote_by_rule = v_ok and coalesce((p_quote ->> 'by_rule')::boolean, false),
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

-- ---------------------------------------------------------------------------
-- Label batches: a record of each bulk run
-- ---------------------------------------------------------------------------

create table public.shipping_label_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- Counts up per workspace: "Run 12".
  number int not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  -- One per order, in the order they are bought:
  -- [{"order_id", "name", "status": waiting|buying|bought|skipped|unsure,
  --   "reason", "service", "price", "currency", "shipment_number"}]
  -- An order's name ("#1042") and nothing else about who it is for.
  orders jsonb not null default '[]'::jsonb check (jsonb_typeof(orders) = 'array'),
  order_count int not null default 0,
  bought_count int not null default 0,
  total numeric(12, 2) not null default 0 check (total >= 0),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  unique (tenant_id, number)
);
create index shipping_label_batches_recent_idx
  on public.shipping_label_batches (tenant_id, created_at desc);

alter table public.shipping_label_batches enable row level security;
create policy "members read their shipping_label_batches" on public.shipping_label_batches
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));
revoke all on public.shipping_label_batches from public, anon, authenticated, service_role;
grant select on public.shipping_label_batches to authenticated, service_role;

-- Starts a run for up to 25 of a workspace's orders (the whole team packs).
-- It reserves nothing and buys nothing: each order is still claimed on its
-- own when its turn comes.
create function public.start_label_batch(p_tenant_id uuid, p_order_ids uuid[])
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_ids uuid[];
  v_orders jsonb;
  v_number int;
  v_id uuid;
begin
  perform private.require_member(p_tenant_id);
  -- Each order once, in the order given.
  select coalesce(array_agg(d.id order by d.n), '{}') into v_ids
  from (select u.id, min(u.n) as n
        from unnest(coalesce(p_order_ids, '{}')) with ordinality as u(id, n)
        where u.id is not null group by u.id) d;
  if cardinality(v_ids) not between 1 and 25 then
    raise exception 'A run buys 1 to 25 labels' using errcode = 'P0001';
  end if;
  select jsonb_agg(jsonb_build_object(
           'order_id', so.id, 'name', coalesce(so.name, 'Order'), 'status', 'waiting')
           order by u.n)
  into v_orders
  from unnest(v_ids) with ordinality as u(id, n)
  join public.shipping_orders so on so.id = u.id and so.tenant_id = p_tenant_id;
  if v_orders is null or jsonb_array_length(v_orders) <> cardinality(v_ids) then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  -- One run at a time gets a number.
  perform 1 from public.tenants t where t.id = p_tenant_id for update;
  select coalesce(max(b.number), 0) + 1 into v_number
  from public.shipping_label_batches b where b.tenant_id = p_tenant_id;
  insert into public.shipping_label_batches
    (tenant_id, number, created_by, orders, order_count)
  values (p_tenant_id, v_number, auth.uid(), v_orders, jsonb_array_length(v_orders))
  returning id into v_id;
  return v_id;
end;
$$;

-- The run's own lock on one of its orders, by the person who started it.
create function private.label_batch_for(p_batch_id uuid)
returns public.shipping_label_batches
language plpgsql security definer set search_path = ''
as $$
declare
  v_batch public.shipping_label_batches;
begin
  select * into v_batch from public.shipping_label_batches b
  where b.id = p_batch_id and b.tenant_id in (select private.user_tenant_ids())
    and b.created_by = auth.uid()
  for update;
  if not found then
    raise exception 'Run not found' using errcode = 'P0002';
  end if;
  return v_batch;
end;
$$;
revoke all on function private.label_batch_for(uuid) from public;

create function private.patch_label_batch_order(
  p_batch public.shipping_label_batches,
  p_shipping_order_id uuid,
  p_patch jsonb
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_orders jsonb;
begin
  select coalesce(jsonb_agg(
           case when e ->> 'order_id' = p_shipping_order_id::text then e || p_patch else e end
           order by n), '[]'::jsonb)
  into v_orders
  from jsonb_array_elements(p_batch.orders) with ordinality as t(e, n);
  update public.shipping_label_batches b
  set orders = v_orders,
      bought_count = (
        select count(*) from jsonb_array_elements(v_orders) e where e ->> 'status' = 'bought'),
      total = coalesce((
        select sum((e ->> 'price')::numeric) from jsonb_array_elements(v_orders) e
        where e ->> 'status' = 'bought' and e ->> 'price' ~ '^\d{1,9}(\.\d{1,2})?$'), 0),
      currency = coalesce(b.currency, (
        select upper(e ->> 'currency') from jsonb_array_elements(v_orders) e
        where e ->> 'status' = 'bought' and e ->> 'currency' ~* '^[a-z]{3}$' limit 1)),
      finished_at = case
        when exists (select 1 from jsonb_array_elements(v_orders) e
                     where e ->> 'status' in ('waiting', 'buying'))
        then null else coalesce(b.finished_at, now()) end
  where b.id = p_batch.id;
end;
$$;
revoke all on function private.patch_label_batch_order(public.shipping_label_batches, uuid, jsonb)
  from public;

-- "This run is buying for this order now." True once per order and run: a
-- second press, a retry or another tab gets false and must not buy. (Whatever
-- happens here, `claim_label_purchase` still refuses a second label for the
-- order itself.)
create function public.claim_label_batch_order(p_batch_id uuid, p_shipping_order_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_batch public.shipping_label_batches := private.label_batch_for(p_batch_id);
begin
  if not exists (
    select 1 from jsonb_array_elements(v_batch.orders) e
    where e ->> 'order_id' = p_shipping_order_id::text and e ->> 'status' = 'waiting') then
    return false;
  end if;
  perform private.patch_label_batch_order(
    v_batch, p_shipping_order_id, jsonb_build_object('status', 'buying'));
  return true;
end;
$$;

-- Writes down what became of one order in a run: bought (with the service,
-- the price and the parcel's number), skipped (with why), or unsure (money
-- may have been spent; it is under "Labels to finish" on the order).
create function public.note_label_batch_order(
  p_batch_id uuid,
  p_shipping_order_id uuid,
  p_outcome jsonb
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_batch public.shipping_label_batches := private.label_batch_for(p_batch_id);
  v_status text := p_outcome ->> 'status';
begin
  if v_status is null or v_status not in ('bought', 'skipped', 'unsure') then
    raise exception 'Not an outcome' using errcode = '22023';
  end if;
  -- An order's outcome is written once.
  if not exists (
    select 1 from jsonb_array_elements(v_batch.orders) e
    where e ->> 'order_id' = p_shipping_order_id::text
      and e ->> 'status' in ('waiting', 'buying')) then
    return false;
  end if;
  perform private.patch_label_batch_order(
    v_batch, p_shipping_order_id,
    jsonb_strip_nulls(jsonb_build_object(
      'status', v_status,
      'reason', nullif(left(coalesce(p_outcome ->> 'reason', ''), 300), ''),
      'service', nullif(left(coalesce(p_outcome ->> 'service', ''), 120), ''),
      'price', case when p_outcome ->> 'price' ~ '^\d{1,9}(\.\d{1,2})?$'
                    then p_outcome ->> 'price' end,
      'currency', case when p_outcome ->> 'currency' ~* '^[a-z]{3}$'
                       then upper(p_outcome ->> 'currency') end,
      'shipment_number', case when p_outcome ->> 'shipment_number' ~ '^\d{1,9}$'
                              then (p_outcome ->> 'shipment_number')::int end)));
  return true;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.start_label_batch(uuid, uuid[])',
    'public.claim_label_batch_order(uuid, uuid)',
    'public.note_label_batch_order(uuid, uuid, jsonb)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
