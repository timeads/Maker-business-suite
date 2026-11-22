-- Stock: what's on the shelf, who it comes from, and what's on order.
-- Stock items mirror the shop's variants (synced by the worker); suppliers,
-- purchase orders and receipts are the workspace's own. The reorder maths is
-- never stored: the app works it out from sales and these rows each time.

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  email text check (email is null or char_length(email) <= 200),
  -- Days from placing an order to having it on the shelf.
  lead_time_days int not null default 30 check (lead_time_days between 0 and 365),
  -- How many days of sales one order should cover.
  coverage_days int not null default 30 check (coverage_days between 1 and 365),
  -- Smallest order they take, counted per item or across the whole order.
  moq int not null default 1 check (moq between 1 and 1000000),
  moq_applies_to text not null default 'order' check (moq_applies_to in ('order', 'sku')),
  notes text not null default '' check (char_length(notes) <= 2000),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table public.stock_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  provider text not null,
  -- The shop's id for the variant, and for the thing its stock is counted on.
  external_id text not null,
  product_external_id text,
  inventory_item_id text,
  title text not null,
  variant_title text,
  sku text,
  on_hand int not null default 0,
  unit_cost numeric(14, 2),
  tracked boolean not null default true,
  product_status text,
  -- The workspace's own planning, kept across syncs.
  supplier_id uuid references public.suppliers (id) on delete set null,
  lead_time_days int check (lead_time_days is null or lead_time_days between 0 and 365),
  coverage_days int check (coverage_days is null or coverage_days between 1 and 365),
  safety_stock int not null default 0 check (safety_stock between 0 and 1000000),
  hidden boolean not null default false,
  synced_at timestamptz not null default now(),
  unique (tenant_id, provider, external_id)
);
create index stock_items_tenant_sku_idx on public.stock_items (tenant_id, sku);
create index stock_items_tenant_supplier_idx on public.stock_items (tenant_id, supplier_id);

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- Counts up per workspace: PO 1, PO 2, ...
  number int not null,
  supplier_id uuid not null references public.suppliers (id) on delete restrict,
  status text not null default 'draft'
    check (status in ('draft', 'ordered', 'partial', 'closed', 'cancelled')),
  notes text not null default '' check (char_length(notes) <= 2000),
  ordered_at timestamptz,
  expected_on date,
  closed_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, number)
);
create index purchase_orders_tenant_status_idx on public.purchase_orders (tenant_id, status);

create table public.purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  po_id uuid not null references public.purchase_orders (id) on delete cascade,
  stock_item_id uuid not null references public.stock_items (id) on delete restrict,
  -- Zero means the line was taken off a draft.
  qty_ordered int not null check (qty_ordered between 0 and 1000000),
  qty_received int not null default 0 check (qty_received >= 0),
  unit_cost numeric(14, 2) not null default 0 check (unit_cost >= 0),
  unique (po_id, stock_item_id)
);
create index purchase_order_lines_item_idx on public.purchase_order_lines (stock_item_id);

-- Every time stock is checked in. The worker adds it to the shop's own count
-- when the workspace has asked for that, and records how it went.
create table public.stock_receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  po_line_id uuid not null references public.purchase_order_lines (id) on delete cascade,
  stock_item_id uuid not null references public.stock_items (id) on delete restrict,
  quantity int not null check (quantity between 1 and 1000000),
  received_by uuid references auth.users (id) on delete set null,
  -- pending: waiting for the worker. sent: added in the shop. skipped: the
  -- workspace keeps its shop count by hand. failed: see shop_error.
  shop_status text not null default 'skipped'
    check (shop_status in ('pending', 'sending', 'sent', 'skipped', 'failed')),
  shop_error text,
  shop_synced_at timestamptz,
  created_at timestamptz not null default now()
);
create index stock_receipts_pending_idx on public.stock_receipts (shop_status, created_at);

do $$
declare
  t text;
begin
  foreach t in array array['suppliers', 'stock_items', 'purchase_orders', 'purchase_order_lines', 'stock_receipts']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy "members read their %s" on public.%I for select to authenticated
         using (tenant_id in (select private.user_tenant_ids()))', t, t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to authenticated, service_role', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Sync (service role, always for one named workspace)
-- ---------------------------------------------------------------------------

-- Upserts one page of the shop's variants. The workspace's own planning
-- (supplier, lead time, safety stock, hidden) is left alone.
create function public.upsert_stock_items(p_tenant_id uuid, p_provider text, p_items jsonb)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.stock_items
    (tenant_id, provider, external_id, product_external_id, inventory_item_id, title, variant_title,
     sku, on_hand, unit_cost, tracked, product_status, synced_at)
  select p_tenant_id, p_provider, i.external_id, i.product_external_id, i.inventory_item_id,
         coalesce(nullif(btrim(i.title), ''), 'Item'), nullif(btrim(i.variant_title), ''),
         nullif(btrim(i.sku), ''), coalesce(i.on_hand, 0), i.unit_cost, coalesce(i.tracked, true),
         i.product_status, now()
  from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as i(
    external_id text, product_external_id text, inventory_item_id text, title text,
    variant_title text, sku text, on_hand int, unit_cost numeric, tracked boolean,
    product_status text)
  where i.external_id is not null
  on conflict (tenant_id, provider, external_id) do update set
    product_external_id = excluded.product_external_id,
    inventory_item_id = excluded.inventory_item_id, title = excluded.title,
    variant_title = excluded.variant_title, sku = excluded.sku, on_hand = excluded.on_hand,
    unit_cost = excluded.unit_cost, tracked = excluded.tracked,
    product_status = excluded.product_status, synced_at = now();
$$;

-- Receipts waiting to be added to the shop's count. One worker gets each.
create function public.claim_stock_receipts(p_limit int default 20)
returns table (
  id uuid, tenant_id uuid, quantity int, provider text, inventory_item_id text, po_number int
)
language sql security definer set search_path = ''
as $$
  with due as (
    select r.id from public.stock_receipts r
    where r.shop_status = 'pending'
       or (r.shop_status = 'sending' and r.shop_synced_at < now() - interval '15 minutes')
    order by r.created_at
    limit greatest(1, least(coalesce(p_limit, 20), 100))
    for update skip locked
  ), taken as (
    update public.stock_receipts r set shop_status = 'sending', shop_synced_at = now()
    from due where r.id = due.id
    returning r.id, r.tenant_id, r.quantity, r.stock_item_id, r.po_line_id
  )
  select taken.id, taken.tenant_id, taken.quantity, si.provider, si.inventory_item_id, po.number
  from taken
  join public.stock_items si on si.id = taken.stock_item_id
  join public.purchase_order_lines l on l.id = taken.po_line_id
  join public.purchase_orders po on po.id = l.po_id;
$$;

create function public.finish_stock_receipt(p_id uuid, p_error text default null)
returns void
language sql security definer set search_path = ''
as $$
  update public.stock_receipts r
  set shop_status = case when p_error is null then 'sent' else 'failed' end,
      shop_error = left(p_error, 500), shop_synced_at = now()
  where r.id = p_id and r.shop_status = 'sending';
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.upsert_stock_items(uuid, text, jsonb)',
    'public.claim_stock_receipts(int)',
    'public.finish_stock_receipt(uuid, text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------

-- Units sold per stock item per day, on the workspace's own calendar. Runs as
-- the member, so row-level security decides what it can see. Sales are matched
-- to an item by SKU, or by product and option when there is no SKU.
create function public.stock_sales_by_day(p_tenant_id uuid, p_days int default 365)
returns table (stock_item_id uuid, day date, units bigint)
language sql stable security invoker set search_path = ''
as $$
  select si.id, (o.processed_at at time zone t.timezone)::date, sum(l.quantity)::bigint
  from public.stock_items si
  join public.tenants t on t.id = si.tenant_id
  join public.order_lines l on l.tenant_id = si.tenant_id
    and ((si.sku is not null and l.sku = si.sku)
      or (si.sku is null and l.product_external_id = si.product_external_id
          and coalesce(l.variant_title, '') = coalesce(si.variant_title, '')))
  join public.orders o on o.id = l.order_id
  where si.tenant_id = p_tenant_id
    and o.cancelled_at is null and not o.is_test and l.quantity > 0
    and o.processed_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 365), 800)))
  group by 1, 2;
$$;
revoke all on function public.stock_sales_by_day(uuid, int) from public, anon;
grant execute on function public.stock_sales_by_day(uuid, int) to authenticated;

-- ---------------------------------------------------------------------------
-- What members do. Suppliers and orders are for owners and admins; anyone on
-- the team can check a delivery in.
-- ---------------------------------------------------------------------------

create function public.save_supplier(
  p_tenant_id uuid, p_supplier_id uuid, p_name text, p_email text, p_lead_time_days int,
  p_coverage_days int, p_moq int, p_moq_applies_to text, p_notes text, p_archived boolean default false
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_manager(p_tenant_id);
  if p_supplier_id is null then
    insert into public.suppliers
      (tenant_id, name, email, lead_time_days, coverage_days, moq, moq_applies_to, notes)
    values (p_tenant_id, btrim(p_name), nullif(lower(btrim(coalesce(p_email, ''))), ''),
            p_lead_time_days, p_coverage_days, p_moq, p_moq_applies_to,
            left(coalesce(p_notes, ''), 2000))
    returning id into v_id;
  else
    update public.suppliers s
    set name = btrim(p_name), email = nullif(lower(btrim(coalesce(p_email, ''))), ''),
        lead_time_days = p_lead_time_days, coverage_days = p_coverage_days, moq = p_moq,
        moq_applies_to = p_moq_applies_to, notes = left(coalesce(p_notes, ''), 2000),
        archived_at = case when coalesce(p_archived, false) then coalesce(s.archived_at, now()) end
    where s.id = p_supplier_id and s.tenant_id = p_tenant_id
    returning s.id into v_id;
    if v_id is null then
      raise exception 'Supplier not found' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
end;
$$;

-- Sets the planning for some stock items at once. Nulls leave lead time and
-- coverage to the supplier's own.
create function public.plan_stock_items(
  p_tenant_id uuid, p_item_ids uuid[], p_supplier_id uuid, p_lead_time_days int,
  p_coverage_days int, p_safety_stock int, p_hidden boolean
)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  perform private.require_manager(p_tenant_id);
  if p_supplier_id is not null and not exists (
    select 1 from public.suppliers s where s.id = p_supplier_id and s.tenant_id = p_tenant_id
  ) then
    raise exception 'Supplier not found' using errcode = 'P0002';
  end if;
  update public.stock_items si
  set supplier_id = p_supplier_id, lead_time_days = p_lead_time_days,
      coverage_days = p_coverage_days, safety_stock = coalesce(p_safety_stock, 0),
      hidden = coalesce(p_hidden, false)
  where si.tenant_id = p_tenant_id and si.id = any (coalesce(p_item_ids, '{}'));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Hands some stock items to a supplier without touching the rest of their planning.
create function public.assign_stock_supplier(p_tenant_id uuid, p_item_ids uuid[], p_supplier_id uuid)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  perform private.require_manager(p_tenant_id);
  if p_supplier_id is not null and not exists (
    select 1 from public.suppliers s where s.id = p_supplier_id and s.tenant_id = p_tenant_id
  ) then
    raise exception 'Supplier not found' using errcode = 'P0002';
  end if;
  update public.stock_items si set supplier_id = p_supplier_id
  where si.tenant_id = p_tenant_id and si.id = any (coalesce(p_item_ids, '{}'));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Writes a draft order's lines: [{"stock_item_id", "qty", "unit_cost"}].
-- Lines left out go to zero, which is how a line is taken off.
create function private.write_po_lines(p_po public.purchase_orders, p_lines jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (
    select 1 from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb)) as l(stock_item_id uuid)
    where not exists (
      select 1 from public.stock_items si
      where si.id = l.stock_item_id and si.tenant_id = p_po.tenant_id)
  ) then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;
  update public.purchase_order_lines pl set qty_ordered = 0 where pl.po_id = p_po.id;
  insert into public.purchase_order_lines (tenant_id, po_id, stock_item_id, qty_ordered, unit_cost)
  select p_po.tenant_id, p_po.id, l.stock_item_id, sum(greatest(0, coalesce(l.qty, 0)))::int,
         max(greatest(0, coalesce(l.unit_cost, 0)))
  from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb)) as l(
    stock_item_id uuid, qty int, unit_cost numeric)
  group by l.stock_item_id
  on conflict (po_id, stock_item_id) do update
    set qty_ordered = excluded.qty_ordered, unit_cost = excluded.unit_cost;
end;
$$;
revoke all on function private.write_po_lines(public.purchase_orders, jsonb) from public;

create function public.create_purchase_order(
  p_tenant_id uuid, p_supplier_id uuid, p_lines jsonb, p_notes text default ''
)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_po public.purchase_orders;
begin
  perform private.require_manager(p_tenant_id);
  -- Locking the workspace row keeps order numbers in step.
  perform 1 from public.tenants t where t.id = p_tenant_id for update;
  if not exists (
    select 1 from public.suppliers s where s.id = p_supplier_id and s.tenant_id = p_tenant_id
  ) then
    raise exception 'Supplier not found' using errcode = 'P0002';
  end if;
  insert into public.purchase_orders (tenant_id, number, supplier_id, notes, created_by)
  values (p_tenant_id,
          (select coalesce(max(po.number), 0) + 1 from public.purchase_orders po
           where po.tenant_id = p_tenant_id),
          p_supplier_id, left(coalesce(p_notes, ''), 2000), auth.uid())
  returning * into v_po;
  perform private.write_po_lines(v_po, p_lines);
  return v_po.number;
end;
$$;

create function private.manager_po(p_po_id uuid)
returns public.purchase_orders
language plpgsql security definer set search_path = ''
as $$
declare
  v_po public.purchase_orders;
begin
  select * into v_po from public.purchase_orders po
  where po.id = p_po_id and po.tenant_id in (select private.user_tenant_ids())
  for update;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_po.tenant_id);
  return v_po;
end;
$$;
revoke all on function private.manager_po(uuid) from public;

create function public.update_purchase_order(
  p_po_id uuid, p_lines jsonb, p_notes text, p_expected_on date
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_po public.purchase_orders := private.manager_po(p_po_id);
begin
  if v_po.status = 'draft' then
    perform private.write_po_lines(v_po, p_lines);
  elsif v_po.status in ('closed', 'cancelled') then
    raise exception 'This order is finished' using errcode = 'P0001';
  end if;
  update public.purchase_orders po
  set notes = left(coalesce(p_notes, ''), 2000), expected_on = p_expected_on
  where po.id = v_po.id;
end;
$$;

-- draft -> ordered, ordered/partial -> closed (the rest isn't coming), or cancelled.
create function public.set_purchase_order_status(p_po_id uuid, p_status text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_po public.purchase_orders := private.manager_po(p_po_id);
begin
  if p_status = 'ordered' and v_po.status = 'draft' then
    if not exists (
      select 1 from public.purchase_order_lines l where l.po_id = v_po.id and l.qty_ordered > 0
    ) then
      raise exception 'Add something to the order first' using errcode = 'P0001';
    end if;
    update public.purchase_orders po set status = 'ordered', ordered_at = now() where po.id = v_po.id;
  elsif p_status = 'closed' and v_po.status in ('ordered', 'partial') then
    update public.purchase_orders po set status = 'closed', closed_at = now() where po.id = v_po.id;
  elsif p_status = 'cancelled' and v_po.status in ('draft', 'ordered') then
    update public.purchase_orders po set status = 'cancelled', closed_at = now() where po.id = v_po.id;
  elsif p_status = 'draft' and v_po.status = 'ordered' then
    update public.purchase_orders po set status = 'draft', ordered_at = null where po.id = v_po.id;
  else
    raise exception 'That change isn''t possible from here' using errcode = 'P0001';
  end if;
end;
$$;

-- Checks in part or all of one line. Bumps our own count straight away;
-- `p_push` queues the same amount to be added in the shop.
create function public.receive_po_line(p_line_id uuid, p_quantity int, p_push boolean default false)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_line public.purchase_order_lines;
  v_po public.purchase_orders;
begin
  select * into v_line from public.purchase_order_lines l
  where l.id = p_line_id and l.tenant_id in (select private.user_tenant_ids());
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  select * into v_po from public.purchase_orders po where po.id = v_line.po_id for update;
  if v_po.status not in ('ordered', 'partial') then
    raise exception 'This order isn''t waiting on a delivery' using errcode = 'P0001';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 1000000 then
    raise exception 'How many arrived?' using errcode = '22023';
  end if;

  update public.purchase_order_lines l set qty_received = l.qty_received + p_quantity
  where l.id = v_line.id;
  update public.stock_items si set on_hand = si.on_hand + p_quantity where si.id = v_line.stock_item_id;
  insert into public.stock_receipts
    (tenant_id, po_line_id, stock_item_id, quantity, received_by, shop_status)
  values (v_line.tenant_id, v_line.id, v_line.stock_item_id, p_quantity, auth.uid(),
          case when coalesce(p_push, false) then 'pending' else 'skipped' end);

  update public.purchase_orders po
  set status = case when exists (
          select 1 from public.purchase_order_lines l
          where l.po_id = po.id and l.qty_received < l.qty_ordered) then 'partial' else 'closed' end,
      closed_at = case when exists (
          select 1 from public.purchase_order_lines l
          where l.po_id = po.id and l.qty_received < l.qty_ordered) then null else now() end
  where po.id = v_po.id;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.save_supplier(uuid, uuid, text, text, int, int, int, text, text, boolean)',
    'public.plan_stock_items(uuid, uuid[], uuid, int, int, int, boolean)',
    'public.assign_stock_supplier(uuid, uuid[], uuid)',
    'public.create_purchase_order(uuid, uuid, jsonb, text)',
    'public.update_purchase_order(uuid, jsonb, text, date)',
    'public.set_purchase_order_status(uuid, text)',
    'public.receive_po_line(uuid, int, boolean)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
