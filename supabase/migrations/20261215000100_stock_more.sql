-- Stock, the rest of the way: ordering by the case, an item's own smallest
-- order, the supplier's code for an item, drafting several orders in one go
-- (once, however many times the button is pressed), the money on an order
-- (shipping, tax, adjustments), changing an order after it has gone out, and
-- tracking numbers for what is on its way.
-- Nothing here is derived: totals, suggestions and "late" are worked out on
-- read by src/lib/stock.

-- ---------------------------------------------------------------------------
-- Columns. The three on stock_items are the workspace's own planning: the
-- sync (upsert_stock_items) names the columns it writes and leaves these alone.
-- ---------------------------------------------------------------------------

alter table public.stock_items
  -- Units in one case; null means it is ordered in single units.
  add column case_pack int check (case_pack is null or case_pack between 1 and 100000),
  -- This item's own smallest order, instead of the supplier's.
  add column moq int check (moq is null or moq between 1 and 1000000),
  -- What the supplier calls it.
  add column supplier_sku text check (supplier_sku is null or char_length(supplier_sku) <= 120);

alter table public.purchase_orders
  add column shipping_cost numeric(14, 2) not null default 0 check (shipping_cost >= 0),
  -- A percentage of the lines' subtotal.
  add column tax_rate_pct numeric(6, 3) not null default 0 check (tax_rate_pct between 0 and 100),
  -- [{"label": "Pallet fee", "amount": "25.00"}, ...]; an amount may be negative.
  add column adjustments jsonb not null default '[]'::jsonb
    check (jsonb_typeof(adjustments) = 'array'),
  -- Set when orders are drafted from a selection: pressing the button twice
  -- sends the same key, and the second press finds the first one's orders.
  add column request_key uuid;
create unique index purchase_orders_request_key_idx
  on public.purchase_orders (tenant_id, request_key, supplier_id)
  where request_key is not null;

alter table public.purchase_order_lines
  add column supplier_sku text check (supplier_sku is null or char_length(supplier_sku) <= 120),
  add column note text not null default '' check (char_length(note) <= 500);

-- Tracking numbers for an order that has gone out. Status is what a person
-- records (expected, arrived); no carrier is asked.
create table public.purchase_order_shipments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  po_id uuid not null references public.purchase_orders (id) on delete cascade,
  carrier text not null default '' check (char_length(carrier) <= 60),
  tracking text not null check (char_length(tracking) between 4 and 60),
  expected_on date,
  arrived_on date,
  note text not null default '' check (char_length(note) <= 300),
  -- Taken off the order by hand; the row is kept.
  removed_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index purchase_order_shipments_tracking_idx
  on public.purchase_order_shipments (po_id, tracking)
  where removed_at is null;
create index purchase_order_shipments_tenant_idx
  on public.purchase_order_shipments (tenant_id, po_id);

alter table public.purchase_order_shipments enable row level security;
create policy "members read their purchase_order_shipments" on public.purchase_order_shipments
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));
revoke all on public.purchase_order_shipments from public, anon, authenticated, service_role;
grant select on public.purchase_order_shipments to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Planning
-- ---------------------------------------------------------------------------

-- One item's own planning, all of it. Nulls leave lead time, cover and the
-- smallest order to the supplier's own; a null case means single units.
create function public.save_stock_item_plan(
  p_tenant_id uuid, p_item_id uuid, p_supplier_id uuid, p_lead_time_days int,
  p_coverage_days int, p_safety_stock int, p_hidden boolean, p_case_pack int, p_moq int,
  p_supplier_sku text
)
returns void
language plpgsql security definer set search_path = ''
as $$
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
      hidden = coalesce(p_hidden, false), case_pack = p_case_pack, moq = p_moq,
      supplier_sku = nullif(left(btrim(coalesce(p_supplier_sku, '')), 120), '')
  where si.tenant_id = p_tenant_id and si.id = p_item_id;
  if not found then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;
end;
$$;

-- "Don't reorder" for some items at once, or bringing them back. Touches
-- nothing else about their planning.
create function public.set_stock_items_hidden(p_tenant_id uuid, p_item_ids uuid[], p_hidden boolean)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  perform private.require_manager(p_tenant_id);
  update public.stock_items si set hidden = coalesce(p_hidden, false)
  where si.tenant_id = p_tenant_id and si.id = any (coalesce(p_item_ids, '{}'))
    and si.hidden is distinct from coalesce(p_hidden, false);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------

-- Writes an order's lines: [{"stock_item_id", "qty", "unit_cost",
-- "supplier_sku", "note"}]. Lines left out go to zero, which is how a line is
-- taken off; the row stays, so anything already checked in against it is kept.
-- A line with no supplier code of its own takes the item's.
create or replace function private.write_po_lines(p_po public.purchase_orders, p_lines jsonb)
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
  insert into public.purchase_order_lines
    (tenant_id, po_id, stock_item_id, qty_ordered, unit_cost, supplier_sku, note)
  select p_po.tenant_id, p_po.id, l.stock_item_id, sum(greatest(0, coalesce(l.qty, 0)))::int,
         max(greatest(0, coalesce(l.unit_cost, 0))),
         coalesce(nullif(left(btrim(max(l.supplier_sku)), 120), ''), max(si.supplier_sku)),
         left(btrim(coalesce(max(l.note), '')), 500)
  from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb)) as l(
    stock_item_id uuid, qty int, unit_cost numeric, supplier_sku text, note text)
  join public.stock_items si on si.id = l.stock_item_id
  group by l.stock_item_id
  on conflict (po_id, stock_item_id) do update
    set qty_ordered = excluded.qty_ordered, unit_cost = excluded.unit_cost,
        supplier_sku = excluded.supplier_sku, note = excluded.note;
end;
$$;

-- Drafts one order per supplier in a single step:
-- [{"supplier_id", "expected_on", "lines": [...]}, ...].
-- The same key always gives back the same orders: a second press of the
-- button waits on the workspace row, then finds what the first press made.
create function public.draft_purchase_orders(p_tenant_id uuid, p_request_key uuid, p_orders jsonb)
returns int[]
language plpgsql security definer set search_path = ''
as $$
declare
  v_numbers int[];
  v_order jsonb;
  v_supplier uuid;
  v_po public.purchase_orders;
begin
  perform private.require_manager(p_tenant_id);
  if p_request_key is null then
    raise exception 'A request key is needed' using errcode = '22023';
  end if;
  -- Locking the workspace row keeps order numbers in step, and makes the
  -- look-up below see anything an earlier press has finished writing.
  perform 1 from public.tenants t where t.id = p_tenant_id for update;
  select array_agg(po.number order by po.number) into v_numbers
  from public.purchase_orders po
  where po.tenant_id = p_tenant_id and po.request_key = p_request_key;
  if v_numbers is not null then
    return v_numbers;
  end if;

  v_numbers := '{}';
  for v_order in select * from jsonb_array_elements(coalesce(p_orders, '[]'::jsonb))
  loop
    v_supplier := (v_order ->> 'supplier_id')::uuid;
    if not exists (
      select 1 from public.suppliers s where s.id = v_supplier and s.tenant_id = p_tenant_id
    ) then
      raise exception 'Supplier not found' using errcode = 'P0002';
    end if;
    insert into public.purchase_orders
      (tenant_id, number, supplier_id, expected_on, created_by, request_key)
    values (p_tenant_id,
            (select coalesce(max(po.number), 0) + 1 from public.purchase_orders po
             where po.tenant_id = p_tenant_id),
            v_supplier, nullif(v_order ->> 'expected_on', '')::date, auth.uid(), p_request_key)
    returning * into v_po;
    perform private.write_po_lines(v_po, v_order -> 'lines');
    v_numbers := v_numbers || v_po.number;
  end loop;
  return v_numbers;
end;
$$;

-- Saves an order: its lines, note, expected date and money. Lines can change
-- until the order is closed, so it can be matched to what really arrived.
create function public.save_purchase_order(
  p_po_id uuid, p_lines jsonb, p_notes text, p_expected_on date, p_shipping_cost numeric,
  p_tax_rate_pct numeric, p_adjustments jsonb
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_po public.purchase_orders := private.manager_po(p_po_id);
  v_adjustments jsonb;
begin
  if v_po.status in ('closed', 'cancelled') then
    raise exception 'This order is finished' using errcode = 'P0001';
  end if;
  if coalesce(p_shipping_cost, 0) < 0 or coalesce(p_shipping_cost, 0) > 100000000
     or coalesce(p_tax_rate_pct, 0) < 0 or coalesce(p_tax_rate_pct, 0) > 100 then
    raise exception 'Those amounts are not valid' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_adjustments, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_adjustments, '[]'::jsonb)) > 12 then
    raise exception 'Those amounts are not valid' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'label', left(btrim(a.label), 80), 'amount', round(a.amount, 2)::text)), '[]'::jsonb)
  into v_adjustments
  from jsonb_to_recordset(coalesce(p_adjustments, '[]'::jsonb)) as a(label text, amount numeric)
  where nullif(btrim(a.label), '') is not null and a.amount is not null and a.amount <> 0
    and abs(a.amount) <= 100000000;

  perform private.write_po_lines(v_po, p_lines);
  if v_po.status <> 'draft' and not exists (
    select 1 from public.purchase_order_lines l
    where l.po_id = v_po.id and (l.qty_ordered > 0 or l.qty_received > 0)
  ) then
    raise exception 'Add something to the order first' using errcode = 'P0001';
  end if;
  update public.purchase_orders po
  set notes = left(coalesce(p_notes, ''), 2000), expected_on = p_expected_on,
      shipping_cost = round(coalesce(p_shipping_cost, 0), 2),
      tax_rate_pct = round(coalesce(p_tax_rate_pct, 0), 3), adjustments = v_adjustments
  where po.id = v_po.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tracking what's on its way
-- ---------------------------------------------------------------------------

-- Adds a tracking number to an order that has gone out, or changes one.
-- Adding a number the order already has changes that one, so a second press
-- never makes a second row.
create function public.save_po_shipment(
  p_po_id uuid, p_shipment_id uuid, p_carrier text, p_tracking text, p_expected_on date,
  p_arrived_on date, p_note text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_po public.purchase_orders := private.manager_po(p_po_id);
  v_tracking text := upper(regexp_replace(btrim(coalesce(p_tracking, '')), '[\s-]+', '', 'g'));
  v_id uuid;
begin
  if v_po.status not in ('ordered', 'partial', 'closed') then
    raise exception 'Tracking is for orders that have been sent' using errcode = 'P0001';
  end if;
  if char_length(v_tracking) < 4 or char_length(v_tracking) > 60 then
    raise exception 'That tracking number is not valid' using errcode = '22023';
  end if;
  if p_shipment_id is null then
    select s.id into v_id from public.purchase_order_shipments s
    where s.po_id = v_po.id and s.tracking = v_tracking and s.removed_at is null;
  else
    select s.id into v_id from public.purchase_order_shipments s
    where s.id = p_shipment_id and s.po_id = v_po.id and s.removed_at is null;
    if v_id is null then
      raise exception 'Tracking number not found' using errcode = 'P0002';
    end if;
  end if;
  if v_id is null then
    insert into public.purchase_order_shipments
      (tenant_id, po_id, carrier, tracking, expected_on, arrived_on, note, created_by)
    values (v_po.tenant_id, v_po.id, left(btrim(coalesce(p_carrier, '')), 60), v_tracking,
            p_expected_on, p_arrived_on, left(btrim(coalesce(p_note, '')), 300), auth.uid())
    returning id into v_id;
  else
    update public.purchase_order_shipments s
    set carrier = left(btrim(coalesce(p_carrier, '')), 60), tracking = v_tracking,
        expected_on = p_expected_on, arrived_on = p_arrived_on,
        note = left(btrim(coalesce(p_note, '')), 300)
    where s.id = v_id;
  end if;
  return v_id;
end;
$$;

-- Takes a tracking number off an order. The row is kept, marked as removed.
create function public.remove_po_shipment(p_shipment_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_po_id uuid;
begin
  select s.po_id into v_po_id from public.purchase_order_shipments s
  where s.id = p_shipment_id and s.removed_at is null
    and s.tenant_id in (select private.user_tenant_ids());
  if v_po_id is null then
    raise exception 'Tracking number not found' using errcode = 'P0002';
  end if;
  perform private.manager_po(v_po_id);
  update public.purchase_order_shipments s set removed_at = now() where s.id = p_shipment_id;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.save_stock_item_plan(uuid, uuid, uuid, int, int, int, boolean, int, int, text)',
    'public.set_stock_items_hidden(uuid, uuid[], boolean)',
    'public.draft_purchase_orders(uuid, uuid, jsonb)',
    'public.save_purchase_order(uuid, jsonb, text, date, numeric, numeric, jsonb)',
    'public.save_po_shipment(uuid, uuid, text, text, date, date, text)',
    'public.remove_po_shipment(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
