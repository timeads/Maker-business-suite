-- Stock, three safety fixes.
--  1. Checking a delivery in happens once, however many times the button is
--     pressed: the whole delivery goes in one step under a request key, and a
--     second press with the same key finds the first one's receipts.
--  2. A delivery the shop turned down can be offered to it again, by an owner
--     or admin, and only when we know for certain the shop did not take it.
--  3. A claim the worker never finished is marked failed instead of being
--     tried again by itself, the way every other once-only queue here works.
-- Nothing derived is stored: these are what happened, not sums.

alter table public.stock_receipts
  -- The key the page made for that press of "Check these in".
  add column request_key uuid,
  -- How many times the shop has been asked to add this receipt.
  add column shop_attempts int not null default 0 check (shop_attempts >= 0),
  -- True only for a failure where the shop certainly added nothing.
  add column shop_can_retry boolean not null default false,
  -- Who pressed "Try the shop again" last, and when.
  add column shop_retried_by uuid references auth.users (id) on delete set null,
  add column shop_retried_at timestamptz;
create unique index stock_receipts_request_key_idx
  on public.stock_receipts (tenant_id, request_key, po_line_id)
  where request_key is not null;

-- ---------------------------------------------------------------------------
-- Checking a delivery in, once
-- ---------------------------------------------------------------------------

-- Checks in what arrived on one order: [{"line_id", "quantity"}, ...]. All of
-- it or none of it. The same key always gives back the same delivery: a second
-- press waits on the order's row, then finds what the first press recorded.
-- Anyone on the team can check a delivery in.
create function public.receive_delivery(
  p_po_id uuid, p_request_key uuid, p_lines jsonb, p_push boolean default false
)
returns table (units int, boxes int, repeated boolean)
language plpgsql security definer set search_path = ''
as $$
declare
  v_po public.purchase_orders;
  v_units int;
  v_boxes int;
  v_most bigint;
  v_arrivals jsonb;
begin
  select * into v_po from public.purchase_orders po
  where po.id = p_po_id and po.tenant_id in (select private.user_tenant_ids())
  for update;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  if p_request_key is null then
    raise exception 'A request key is needed' using errcode = '22023';
  end if;

  select coalesce(sum(r.quantity), 0)::int, count(*)::int into v_units, v_boxes
  from public.stock_receipts r
  join public.purchase_order_lines l on l.id = r.po_line_id
  where r.tenant_id = v_po.tenant_id and r.request_key = p_request_key and l.po_id = v_po.id;
  if v_boxes > 0 then
    return query select v_units, v_boxes, true;
    return;
  end if;

  if v_po.status not in ('ordered', 'partial') then
    raise exception 'This order isn''t waiting on a delivery' using errcode = 'P0001';
  end if;
  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' then
    raise exception 'How many arrived?' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb)) as a(line_id uuid, quantity int)
    where a.line_id is null or a.quantity is null or a.quantity < 1 or a.quantity > 1000000
       or not exists (
         select 1 from public.purchase_order_lines l where l.id = a.line_id and l.po_id = v_po.id)
  ) then
    raise exception 'How many arrived?' using errcode = '22023';
  end if;
  -- One entry per line, however the page sent them.
  select coalesce(jsonb_agg(jsonb_build_object(
           'line_id', t.id, 'stock_item_id', t.stock_item_id, 'quantity', t.quantity)), '[]'::jsonb),
         coalesce(sum(t.quantity), 0)::int, count(*)::int, coalesce(max(t.quantity), 0)
  into v_arrivals, v_units, v_boxes, v_most
  from (
    select l.id, l.stock_item_id, sum(a.quantity) as quantity
    from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb)) as a(line_id uuid, quantity int)
    join public.purchase_order_lines l on l.id = a.line_id
    group by l.id, l.stock_item_id
  ) t;
  if v_boxes = 0 or v_most > 1000000 then
    raise exception 'How many arrived?' using errcode = '22023';
  end if;

  update public.purchase_order_lines l set qty_received = l.qty_received + a.quantity
  from jsonb_to_recordset(v_arrivals) as a(line_id uuid, quantity int) where l.id = a.line_id;
  update public.stock_items si set on_hand = si.on_hand + a.quantity
  from jsonb_to_recordset(v_arrivals) as a(stock_item_id uuid, quantity int)
  where si.id = a.stock_item_id;
  insert into public.stock_receipts
    (tenant_id, po_line_id, stock_item_id, quantity, received_by, shop_status, request_key)
  select v_po.tenant_id, a.line_id, a.stock_item_id, a.quantity, auth.uid(),
         case when coalesce(p_push, false) then 'pending' else 'skipped' end, p_request_key
  from jsonb_to_recordset(v_arrivals) as a(line_id uuid, stock_item_id uuid, quantity int);

  update public.purchase_orders po
  set status = case when exists (
          select 1 from public.purchase_order_lines l
          where l.po_id = po.id and l.qty_received < l.qty_ordered) then 'partial' else 'closed' end,
      closed_at = case when exists (
          select 1 from public.purchase_order_lines l
          where l.po_id = po.id and l.qty_received < l.qty_ordered) then null else now() end
  where po.id = v_po.id;

  return query select v_units, v_boxes, false;
end;
$$;

-- ---------------------------------------------------------------------------
-- The shop's count: one try per press
-- ---------------------------------------------------------------------------

-- Receipts waiting to be added to the shop's count; one worker gets each.
-- `shop_key` is different for every try, so the shop treats a deliberate
-- second try as a new request, and the same try sent twice as one.
-- A claim that was never finished (the worker stopped part-way) is not handed
-- out again: nobody can say whether the shop took it, so it is marked failed
-- for a person to check.
create function public.claim_stock_receipt_tries(p_limit int default 20)
returns table (
  id uuid, tenant_id uuid, quantity int, provider text, inventory_item_id text, po_number int,
  attempt int, shop_key uuid
)
language plpgsql security definer set search_path = ''
as $$
begin
  update public.stock_receipts r
  set shop_status = 'failed', shop_can_retry = false, shop_synced_at = now(),
      shop_error = 'We lost track of this one part-way, so we can''t tell whether your shop added it'
  where r.shop_status = 'sending' and r.shop_synced_at < now() - interval '15 minutes';

  return query
  with due as (
    select r.id from public.stock_receipts r
    where r.shop_status = 'pending'
    order by r.created_at
    limit greatest(1, least(coalesce(p_limit, 20), 100))
    for update skip locked
  ), taken as (
    update public.stock_receipts r
    set shop_status = 'sending', shop_synced_at = now(), shop_attempts = r.shop_attempts + 1,
        shop_can_retry = false
    from due where r.id = due.id
    returning r.id, r.tenant_id, r.quantity, r.stock_item_id, r.po_line_id, r.shop_attempts
  )
  select taken.id, taken.tenant_id, taken.quantity, si.provider, si.inventory_item_id, po.number,
         taken.shop_attempts,
         md5(taken.id::text || ':' || taken.shop_attempts::text)::uuid
  from taken
  join public.stock_items si on si.id = taken.stock_item_id
  join public.purchase_order_lines l on l.id = taken.po_line_id
  join public.purchase_orders po on po.id = l.po_id;
end;
$$;

-- The earlier name keeps working, with the same rules.
create or replace function public.claim_stock_receipts(p_limit int default 20)
returns table (
  id uuid, tenant_id uuid, quantity int, provider text, inventory_item_id text, po_number int
)
language sql security definer set search_path = ''
as $$
  select t.id, t.tenant_id, t.quantity, t.provider, t.inventory_item_id, t.po_number
  from public.claim_stock_receipt_tries(p_limit) t;
$$;

-- Records how a try went. `p_can_retry` is true only when the shop certainly
-- added nothing (it said no, or was never asked).
create function public.finish_stock_receipt_try(
  p_id uuid, p_error text default null, p_can_retry boolean default false
)
returns void
language sql security definer set search_path = ''
as $$
  update public.stock_receipts r
  set shop_status = case when p_error is null then 'sent' else 'failed' end,
      shop_error = left(p_error, 500), shop_synced_at = now(),
      shop_can_retry = p_error is not null and coalesce(p_can_retry, false)
  where r.id = p_id and r.shop_status = 'sending';
$$;

-- "Try the shop again": puts one failed receipt back in the queue. Owners and
-- admins only, and only for a failure where the shop certainly added nothing.
-- A receipt that is waiting, being sent or already in the shop is refused, so
-- the same boxes can't be added twice.
create function public.retry_stock_receipt(p_receipt_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_receipt public.stock_receipts;
begin
  select * into v_receipt from public.stock_receipts r
  where r.id = p_receipt_id and r.tenant_id in (select private.user_tenant_ids())
  for update;
  if not found then
    raise exception 'Delivery not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_receipt.tenant_id);
  if v_receipt.shop_status <> 'failed' then
    raise exception 'This delivery isn''t waiting on another try' using errcode = 'P0001';
  end if;
  if not v_receipt.shop_can_retry then
    raise exception 'We can''t tell whether the shop added this one' using errcode = 'P0001';
  end if;
  update public.stock_receipts r
  set shop_status = 'pending', shop_can_retry = false, shop_retried_by = auth.uid(),
      shop_retried_at = now()
  where r.id = v_receipt.id;
end;
$$;

revoke all on function public.receive_delivery(uuid, uuid, jsonb, boolean) from public, anon;
grant execute on function public.receive_delivery(uuid, uuid, jsonb, boolean) to authenticated;
revoke all on function public.retry_stock_receipt(uuid) from public, anon;
grant execute on function public.retry_stock_receipt(uuid) to authenticated;
revoke all on function public.claim_stock_receipt_tries(int) from public, anon, authenticated;
grant execute on function public.claim_stock_receipt_tries(int) to service_role;
revoke all on function public.finish_stock_receipt_try(uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.finish_stock_receipt_try(uuid, text, boolean) to service_role;
