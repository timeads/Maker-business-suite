-- Bringing a business's stock records across from a spreadsheet: suppliers,
-- planning figures, purchase orders, the supplier ledger, past daily counts
-- and past deliveries. Owners and admins only.
--
-- Three rules hold for every file:
--  1. A look first. Each function can be run "for a look" (p_confirm false):
--     it does the whole import inside a block that is then undone, and hands
--     back the counts. So the preview a person sees is worked out by the very
--     code that will do the import, and nothing is written until they say so.
--  2. Once. A confirmed import carries a request key; a second press with the
--     same key finds the first one's result and does nothing. And each file is
--     matched against what is already here, so the same file imported again
--     under a new key changes nothing either.
--  3. History is only history. An imported order may say goods arrived, and an
--     imported delivery says when: neither raises a count, and neither is ever
--     offered to the shop. Imported receipts are marked, a table rule keeps
--     them out of the shop's queue for good, and the worker's claim skips them.

-- ---------------------------------------------------------------------------
-- Marks, and the record of what was imported
-- ---------------------------------------------------------------------------

alter table public.purchase_orders
  -- 'import' for an order brought in from a spreadsheet.
  add column source text not null default 'app' check (source in ('app', 'import'));

alter table public.stock_receipts
  add column source text not null default 'app' check (source in ('app', 'import'));
-- An imported receipt can never wait for, go to, or be offered again to a shop.
alter table public.stock_receipts
  add constraint stock_receipts_import_is_history
  check (source <> 'import' or (shop_status = 'skipped' and not shop_can_retry));

-- One row per confirmed import: what kind, how it went, who pressed. The file
-- itself is read in the request and never kept; only its name and the counts.
create table public.stock_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  kind text not null
    check (kind in ('suppliers', 'items', 'orders', 'ledger', 'counts', 'deliveries')),
  request_key uuid not null,
  file_name text not null default '' check (char_length(file_name) <= 200),
  counts jsonb not null check (jsonb_typeof(counts) = 'object'),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, request_key)
);
create index stock_imports_tenant_idx on public.stock_imports (tenant_id, created_at desc);
alter table public.stock_imports enable row level security;
-- Like suppliers' accounts, this is for the people who run the business.
create policy "managers read their stock imports" on public.stock_imports
  for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin']::public.membership_role[]));
revoke all on public.stock_imports from public, anon, authenticated, service_role;
grant select on public.stock_imports to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The shop's queue never sees an imported receipt
-- ---------------------------------------------------------------------------

create or replace function public.claim_stock_receipt_tries(p_limit int default 20)
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
  where r.shop_status = 'sending' and r.shop_synced_at < now() - interval '15 minutes'
    and r.source = 'app';

  return query
  with due as (
    select r.id from public.stock_receipts r
    -- Only what was checked in here. An imported receipt is history.
    where r.shop_status = 'pending' and r.source = 'app'
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

-- ---------------------------------------------------------------------------
-- Shared steps
-- ---------------------------------------------------------------------------

-- Who may import, how much at once, and whether this press was already done.
-- Returns the first press's counts (with "repeated") or null to carry on.
create function private.import_begin(
  p_tenant_id uuid, p_request_key uuid, p_rows jsonb, p_confirm boolean
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_counts jsonb;
begin
  perform private.require_manager(p_tenant_id);
  if jsonb_typeof(coalesce(p_rows, 'null'::jsonb)) <> 'array'
     or jsonb_array_length(p_rows) > 20000 then
    raise exception 'That file is too big to bring in at once' using errcode = '22023';
  end if;
  if not coalesce(p_confirm, false) then
    return null;
  end if;
  if p_request_key is null then
    raise exception 'A request key is needed' using errcode = '22023';
  end if;
  -- Waits for an earlier press to finish, then sees what it wrote.
  perform 1 from public.tenants t where t.id = p_tenant_id for update;
  select i.counts || jsonb_build_object('repeated', true) into v_counts
  from public.stock_imports i
  where i.tenant_id = p_tenant_id and i.request_key = p_request_key;
  return v_counts;
end;
$$;
revoke all on function private.import_begin(uuid, uuid, jsonb, boolean) from public;

create function private.import_end(
  p_tenant_id uuid, p_request_key uuid, p_kind text, p_file_name text, p_counts jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.stock_imports (tenant_id, kind, request_key, file_name, counts, created_by)
  values (p_tenant_id, p_kind, p_request_key, left(btrim(coalesce(p_file_name, '')), 200),
          p_counts, auth.uid());
  return p_counts || jsonb_build_object('repeated', false);
end;
$$;
revoke all on function private.import_end(uuid, uuid, text, text, jsonb) from public;

-- The supplier with this name, whatever the capitals; made if there is none.
-- `p_added` counts the ones made.
create function private.import_supplier(p_tenant_id uuid, p_name text, inout p_added int, out p_id uuid)
language plpgsql security definer set search_path = ''
as $$
declare
  v_name text := left(btrim(coalesce(p_name, '')), 120);
begin
  if v_name = '' then
    raise exception 'A supplier needs a name' using errcode = '22023';
  end if;
  select s.id into p_id from public.suppliers s
  where s.tenant_id = p_tenant_id and lower(s.name) = lower(v_name)
  order by (s.name = v_name) desc, s.created_at limit 1;
  if p_id is null then
    insert into public.suppliers (tenant_id, name) values (p_tenant_id, v_name)
    returning id into p_id;
    p_added := coalesce(p_added, 0) + 1;
  end if;
end;
$$;
revoke all on function private.import_supplier(uuid, text, int) from public;

-- ---------------------------------------------------------------------------
-- 1. Suppliers
-- ---------------------------------------------------------------------------

-- [{"name", "contact_name", "emails": [..], "lead_time_days", "coverage_days",
--   "moq", "moq_applies_to", "payment_terms_days", "notes", "archived"}, ...]
-- Matched by name, whatever the capitals. A key that isn't in a row leaves
-- that figure as it is (or at its usual starting value for a new supplier).
create function public.import_suppliers(
  p_tenant_id uuid, p_request_key uuid, p_rows jsonb, p_file_name text default '',
  p_confirm boolean default false
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_done jsonb := private.import_begin(p_tenant_id, p_request_key, p_rows, p_confirm);
  v_new int := 0;
  v_changed int := 0;
  v_same int := 0;
  v_counts jsonb;
  e jsonb;
  v_id uuid;
  v_name text;
  v_emails text[];
  v_n int;
begin
  if v_done is not null then
    return v_done;
  end if;
  begin
    for e in select * from jsonb_array_elements(p_rows)
    loop
      v_name := left(btrim(coalesce(e ->> 'name', '')), 120);
      if v_name = '' then
        raise exception 'A supplier needs a name' using errcode = '22023';
      end if;
      v_emails := null;
      if e ? 'emails' then
        select coalesce(array_agg(x.email order by x.ord), '{}') into v_emails
        from (
          select lower(btrim(t.value)) as email, min(t.ord) as ord
          from jsonb_array_elements_text(
                 case when jsonb_typeof(e -> 'emails') = 'array' then e -> 'emails'
                      else '[]'::jsonb end) with ordinality as t(value, ord)
          where btrim(t.value) <> ''
          group by 1
        ) x;
        if cardinality(v_emails) > 6 or exists (
          select 1 from unnest(v_emails) as m
          where char_length(m) > 200 or m !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
        ) then
          raise exception 'Bad email' using errcode = '22023';
        end if;
      end if;

      select s.id into v_id from public.suppliers s
      where s.tenant_id = p_tenant_id and lower(s.name) = lower(v_name)
      order by (s.name = v_name) desc, s.created_at limit 1;
      if v_id is null then
        insert into public.suppliers (tenant_id, name) values (p_tenant_id, v_name)
        returning id into v_id;
        v_new := v_new + 1;
        v_n := 0;
      else
        v_n := 1;
      end if;

      update public.suppliers s
      set contact_name = case when e ? 'contact_name'
            then nullif(left(btrim(coalesce(e ->> 'contact_name', '')), 120), '')
            else s.contact_name end,
          email = case when e ? 'emails' then v_emails[1] else s.email end,
          more_emails = case when e ? 'emails' then coalesce(v_emails[2:], '{}')
            else s.more_emails end,
          lead_time_days = coalesce((e ->> 'lead_time_days')::int, s.lead_time_days),
          coverage_days = coalesce((e ->> 'coverage_days')::int, s.coverage_days),
          moq = coalesce((e ->> 'moq')::int, s.moq),
          moq_applies_to = coalesce(nullif(lower(e ->> 'moq_applies_to'), ''), s.moq_applies_to),
          payment_terms_days = coalesce((e ->> 'payment_terms_days')::int, s.payment_terms_days),
          notes = case when e ? 'notes' then left(coalesce(e ->> 'notes', ''), 2000) else s.notes end,
          archived_at = case
            when not (e ? 'archived') or e ->> 'archived' is null then s.archived_at
            when (e ->> 'archived')::boolean then coalesce(s.archived_at, now())
            else null end
      where s.id = v_id
        and (
          (e ? 'contact_name' and s.contact_name is distinct from
             nullif(left(btrim(coalesce(e ->> 'contact_name', '')), 120), ''))
          or (e ? 'emails' and (s.email is distinct from v_emails[1]
             or s.more_emails is distinct from coalesce(v_emails[2:], '{}')))
          or coalesce((e ->> 'lead_time_days')::int, s.lead_time_days) <> s.lead_time_days
          or coalesce((e ->> 'coverage_days')::int, s.coverage_days) <> s.coverage_days
          or coalesce((e ->> 'moq')::int, s.moq) <> s.moq
          or coalesce(nullif(lower(e ->> 'moq_applies_to'), ''), s.moq_applies_to) <> s.moq_applies_to
          or coalesce((e ->> 'payment_terms_days')::int, s.payment_terms_days) <> s.payment_terms_days
          or (e ? 'notes' and s.notes <> left(coalesce(e ->> 'notes', ''), 2000))
          or (e ? 'archived' and e ->> 'archived' is not null
              and (e ->> 'archived')::boolean <> (s.archived_at is not null))
        );
      if v_n = 1 then
        if found then v_changed := v_changed + 1; else v_same := v_same + 1; end if;
      end if;
    end loop;
    v_counts := jsonb_build_object('new', v_new, 'changed', v_changed, 'same', v_same);
    if not coalesce(p_confirm, false) then
      -- Only a look: undo everything this block did.
      raise exception 'look' using errcode = 'IMPLK';
    end if;
  exception when sqlstate 'IMPLK' then
    return v_counts || jsonb_build_object('repeated', false);
  end;
  return private.import_end(p_tenant_id, p_request_key, 'suppliers', p_file_name, v_counts);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Planning figures for items
-- ---------------------------------------------------------------------------

-- [{"stock_item_id", "supplier", "supplier_sku", "own_cost", "lead_time_days",
--   "coverage_days", "safety_stock", "moq", "case_pack", "hidden"}, ...]
-- The app has already matched each row to an item (by SKU, else by product
-- and option). A key that is in a row is set, null clearing it; a key that
-- isn't is left alone. A supplier is named, and made if it is new; choosing
-- one here counts as chosen by hand, so no sync changes it afterwards.
create function public.import_item_planning(
  p_tenant_id uuid, p_request_key uuid, p_rows jsonb, p_file_name text default '',
  p_confirm boolean default false
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_done jsonb := private.import_begin(p_tenant_id, p_request_key, p_rows, p_confirm);
  v_changed int := 0;
  v_same int := 0;
  v_suppliers int := 0;
  v_counts jsonb;
  e jsonb;
  v_item uuid;
  v_supplier uuid;
  v_case int;
begin
  if v_done is not null then
    return v_done;
  end if;
  begin
    for e in select * from jsonb_array_elements(p_rows)
    loop
      select si.id into v_item from public.stock_items si
      where si.id = (e ->> 'stock_item_id')::uuid and si.tenant_id = p_tenant_id;
      if v_item is null then
        raise exception 'Item not found' using errcode = 'P0002';
      end if;
      v_supplier := null;
      if nullif(btrim(coalesce(e ->> 'supplier', '')), '') is not null then
        select s.p_added, s.p_id into v_suppliers, v_supplier
        from private.import_supplier(p_tenant_id, e ->> 'supplier', v_suppliers) s;
      end if;
      -- A case of one is just single units.
      v_case := nullif((e ->> 'case_pack')::int, 1);

      update public.stock_items si
      set supplier_id = coalesce(v_supplier, si.supplier_id),
          supplier_sku = case when e ? 'supplier_sku'
            then nullif(left(btrim(coalesce(e ->> 'supplier_sku', '')), 120), '')
            else si.supplier_sku end,
          own_cost = case when e ? 'own_cost' then round((e ->> 'own_cost')::numeric, 2)
            else si.own_cost end,
          lead_time_days = case when e ? 'lead_time_days' then (e ->> 'lead_time_days')::int
            else si.lead_time_days end,
          coverage_days = case when e ? 'coverage_days' then (e ->> 'coverage_days')::int
            else si.coverage_days end,
          safety_stock = case when e ? 'safety_stock' then coalesce((e ->> 'safety_stock')::int, 0)
            else si.safety_stock end,
          moq = case when e ? 'moq' then (e ->> 'moq')::int else si.moq end,
          case_pack = case when e ? 'case_pack' then v_case else si.case_pack end,
          hidden = case when e ? 'hidden' then coalesce((e ->> 'hidden')::boolean, false)
            else si.hidden end
      where si.id = v_item
        and (
          (v_supplier is not null and si.supplier_id is distinct from v_supplier)
          or (e ? 'supplier_sku' and si.supplier_sku is distinct from
              nullif(left(btrim(coalesce(e ->> 'supplier_sku', '')), 120), ''))
          or (e ? 'own_cost' and si.own_cost is distinct from round((e ->> 'own_cost')::numeric, 2))
          or (e ? 'lead_time_days' and si.lead_time_days is distinct from (e ->> 'lead_time_days')::int)
          or (e ? 'coverage_days' and si.coverage_days is distinct from (e ->> 'coverage_days')::int)
          or (e ? 'safety_stock' and si.safety_stock <> coalesce((e ->> 'safety_stock')::int, 0))
          or (e ? 'moq' and si.moq is distinct from (e ->> 'moq')::int)
          or (e ? 'case_pack' and si.case_pack is distinct from v_case)
          or (e ? 'hidden' and si.hidden <> coalesce((e ->> 'hidden')::boolean, false))
        );
      if found then v_changed := v_changed + 1; else v_same := v_same + 1; end if;
    end loop;
    v_counts := jsonb_build_object(
      'new', 0, 'changed', v_changed, 'same', v_same, 'suppliers_added', v_suppliers);
    if not coalesce(p_confirm, false) then
      raise exception 'look' using errcode = 'IMPLK';
    end if;
  exception when sqlstate 'IMPLK' then
    return v_counts || jsonb_build_object('repeated', false);
  end;
  return private.import_end(p_tenant_id, p_request_key, 'items', p_file_name, v_counts);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Purchase orders, open and part-received ones included
-- ---------------------------------------------------------------------------

-- [{"reference", "supplier", "status", "created_at", "ordered_at",
--   "expected_on", "closed_at", "shipping_cost", "tax_rate_pct", "notes",
--   "adjustments": [{"label", "amount"}],
--   "lines": [{"stock_item_id", "qty_ordered", "qty_received", "unit_cost",
--              "supplier_sku", "note"}]}, ...]
-- An order whose reference is already here is left exactly as it is.
-- What an imported order says has arrived is written down and nothing more:
-- no count is raised and no receipt is made, so nothing can reach the shop.
create function public.import_purchase_orders(
  p_tenant_id uuid, p_request_key uuid, p_rows jsonb, p_file_name text default '',
  p_confirm boolean default false
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_done jsonb := private.import_begin(p_tenant_id, p_request_key, p_rows, p_confirm);
  v_new int := 0;
  v_same int := 0;
  v_lines int := 0;
  v_suppliers int := 0;
  v_counts jsonb;
  e jsonb;
  v_reference text;
  v_status text;
  v_supplier uuid;
  v_po uuid;
  v_adjustments jsonb;
  v_n int;
begin
  if v_done is not null then
    return v_done;
  end if;
  begin
    -- Order numbers stay in step even for a look.
    perform 1 from public.tenants t where t.id = p_tenant_id for update;
    for e in select * from jsonb_array_elements(p_rows)
    loop
      v_reference := btrim(regexp_replace(coalesce(e ->> 'reference', ''), '\s+', ' ', 'g'));
      v_status := lower(coalesce(e ->> 'status', ''));
      if char_length(v_reference) not between 3 and 40
         or v_status not in ('draft', 'ordered', 'partial', 'closed', 'cancelled') then
        raise exception 'That order can''t be read' using errcode = '22023';
      end if;
      if exists (
        select 1 from public.purchase_orders po
        where po.tenant_id = p_tenant_id and upper(po.reference) = upper(v_reference)
      ) then
        v_same := v_same + 1;
        continue;
      end if;
      if exists (
        select 1
        from jsonb_to_recordset(coalesce(e -> 'lines', '[]'::jsonb)) as l(
          stock_item_id uuid, qty_ordered int, qty_received int, unit_cost numeric)
        where l.stock_item_id is null or coalesce(l.qty_ordered, -1) < 0
           or coalesce(l.qty_received, 0) < 0 or coalesce(l.unit_cost, 0) < 0
           or not exists (
             select 1 from public.stock_items si
             where si.id = l.stock_item_id and si.tenant_id = p_tenant_id)
      ) then
        raise exception 'Item not found' using errcode = 'P0002';
      end if;
      select s.p_added, s.p_id into v_suppliers, v_supplier
      from private.import_supplier(p_tenant_id, e ->> 'supplier', v_suppliers) s;
      select coalesce(jsonb_agg(jsonb_build_object(
               'label', left(btrim(a.label), 80), 'amount', round(a.amount, 2)::text)), '[]'::jsonb)
      into v_adjustments
      from jsonb_to_recordset(coalesce(e -> 'adjustments', '[]'::jsonb)) as a(label text, amount numeric)
      where nullif(btrim(a.label), '') is not null and a.amount is not null and a.amount <> 0
        and abs(a.amount) <= 100000000;
      if jsonb_array_length(v_adjustments) > 12 then
        raise exception 'Those amounts are not valid' using errcode = '22023';
      end if;

      insert into public.purchase_orders
        (tenant_id, number, reference, supplier_id, status, notes, created_at, ordered_at,
         expected_on, closed_at, shipping_cost, tax_rate_pct, adjustments, created_by, source)
      values (
        p_tenant_id,
        (select coalesce(max(po.number), 0) + 1 from public.purchase_orders po
         where po.tenant_id = p_tenant_id),
        v_reference, v_supplier, v_status, left(coalesce(e ->> 'notes', ''), 2000),
        coalesce((e ->> 'created_at')::timestamptz, now()),
        case when v_status = 'draft' then null
             else coalesce((e ->> 'ordered_at')::timestamptz, (e ->> 'created_at')::timestamptz, now())
        end,
        (e ->> 'expected_on')::date,
        case when v_status in ('closed', 'cancelled')
             then coalesce((e ->> 'closed_at')::timestamptz, (e ->> 'ordered_at')::timestamptz,
                           (e ->> 'created_at')::timestamptz, now()) end,
        round(coalesce((e ->> 'shipping_cost')::numeric, 0), 2),
        round(coalesce((e ->> 'tax_rate_pct')::numeric, 0), 3),
        v_adjustments, auth.uid(), 'import')
      returning id into v_po;

      -- The lines as they stood: what was ordered and what had arrived. This
      -- is the only place that writes "arrived" without a delivery being
      -- checked in, and it touches neither a count nor the shop's queue.
      insert into public.purchase_order_lines
        (tenant_id, po_id, stock_item_id, qty_ordered, qty_received, unit_cost, supplier_sku, note)
      select p_tenant_id, v_po, l.stock_item_id, sum(coalesce(l.qty_ordered, 0))::int,
             sum(coalesce(l.qty_received, 0))::int, max(round(coalesce(l.unit_cost, 0), 2)),
             nullif(left(btrim(coalesce(max(l.supplier_sku), '')), 120), ''),
             left(btrim(coalesce(max(l.note), '')), 500)
      from jsonb_to_recordset(coalesce(e -> 'lines', '[]'::jsonb)) as l(
        stock_item_id uuid, qty_ordered int, qty_received int, unit_cost numeric,
        supplier_sku text, note text)
      group by l.stock_item_id;
      get diagnostics v_n = row_count;
      v_lines := v_lines + v_n;
      v_new := v_new + 1;
    end loop;
    v_counts := jsonb_build_object(
      'new', v_new, 'changed', 0, 'same', v_same, 'lines', v_lines,
      'suppliers_added', v_suppliers);
    if not coalesce(p_confirm, false) then
      raise exception 'look' using errcode = 'IMPLK';
    end if;
  exception when sqlstate 'IMPLK' then
    return v_counts || jsonb_build_object('repeated', false);
  end;
  return private.import_end(p_tenant_id, p_request_key, 'orders', p_file_name, v_counts);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The supplier ledger
-- ---------------------------------------------------------------------------

-- [{"supplier", "type", "entry_date", "amount", "stated_balance",
--   "reference", "description", "paid_on"}, ...]
-- An invoice or payment with a number corrects the entry that already has
-- that number. Anything else is added only if an identical entry isn't here
-- already (two identical rows in the file make two entries, once).
create function public.import_ledger_entries(
  p_tenant_id uuid, p_request_key uuid, p_rows jsonb, p_file_name text default '',
  p_confirm boolean default false
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_done jsonb := private.import_begin(p_tenant_id, p_request_key, p_rows, p_confirm);
  v_new int := 0;
  v_changed int := 0;
  v_same int := 0;
  v_suppliers int := 0;
  v_counts jsonb;
  r record;
  v_supplier uuid;
  v_id uuid;
  v_have int;
  v_add int;
begin
  if v_done is not null then
    return v_done;
  end if;
  begin
    for r in
      select btrim(x.supplier) as supplier, lower(x.type) as type, x.entry_date,
             case when lower(x.type) = 'statement' then 0 else round(coalesce(x.amount, 0), 2) end
               as amount,
             case when lower(x.type) = 'statement' then round(coalesce(x.stated_balance, 0), 2) end
               as stated_balance,
             nullif(left(btrim(coalesce(x.reference, '')), 80), '') as reference,
             left(btrim(coalesce(x.description, '')), 500) as description,
             x.paid_on, count(*)::int as times, min(x.ord) as ord
      from (
        select t.e ->> 'supplier' as supplier, t.e ->> 'type' as type,
               (t.e ->> 'entry_date')::date as entry_date, (t.e ->> 'amount')::numeric as amount,
               (t.e ->> 'stated_balance')::numeric as stated_balance,
               t.e ->> 'reference' as reference, t.e ->> 'description' as description,
               (t.e ->> 'paid_on')::timestamptz as paid_on, t.ord
        from jsonb_array_elements(p_rows) with ordinality as t(e, ord)
      ) x
      group by 1, 2, 3, 4, 5, 6, 7, 8
      order by min(x.ord)
    loop
      if r.type not in ('statement', 'invoice', 'payment', 'adjustment') or r.entry_date is null
         or r.entry_date < date '2000-01-01' or r.entry_date > current_date + 366
         or (r.type in ('invoice', 'payment') and r.amount <= 0)
         or (r.type = 'adjustment' and r.amount = 0) then
        raise exception 'That entry is not valid' using errcode = '22023';
      end if;
      select s.p_added, s.p_id into v_suppliers, v_supplier
      from private.import_supplier(p_tenant_id, r.supplier, v_suppliers) s;

      if r.reference is not null and r.type in ('invoice', 'payment') then
        select l.id into v_id from public.supplier_ledger l
        where l.tenant_id = p_tenant_id and l.supplier_id = v_supplier and l.type = r.type
          and lower(l.reference) = lower(r.reference)
        order by l.created_at limit 1;
        if v_id is not null then
          update public.supplier_ledger l
          set entry_date = r.entry_date, amount = r.amount, description = r.description,
              payment_sent_at = case when r.type = 'invoice'
                then coalesce(l.payment_sent_at, r.paid_on) else l.payment_sent_at end
          where l.id = v_id
            and (l.entry_date <> r.entry_date or l.amount <> r.amount
                 or l.description <> r.description
                 or (r.type = 'invoice' and l.payment_sent_at is null and r.paid_on is not null));
          if found then v_changed := v_changed + 1; else v_same := v_same + 1; end if;
          continue;
        end if;
        v_have := 0;
      else
        select count(*)::int into v_have from public.supplier_ledger l
        where l.tenant_id = p_tenant_id and l.supplier_id = v_supplier and l.type = r.type
          and l.entry_date = r.entry_date and l.amount = r.amount
          and l.stated_balance is not distinct from r.stated_balance
          and l.reference is not distinct from r.reference and l.description = r.description;
      end if;
      v_add := greatest(0, r.times - v_have);
      insert into public.supplier_ledger
        (tenant_id, supplier_id, type, entry_date, amount, stated_balance, reference,
         description, source, payment_sent_at, created_by)
      select p_tenant_id, v_supplier, r.type, r.entry_date, r.amount, r.stated_balance,
             r.reference, r.description, 'import',
             case when r.type = 'invoice' then r.paid_on end, auth.uid()
      from generate_series(1, v_add);
      v_new := v_new + v_add;
      v_same := v_same + (r.times - v_add);
    end loop;
    v_counts := jsonb_build_object(
      'new', v_new, 'changed', v_changed, 'same', v_same, 'suppliers_added', v_suppliers);
    if not coalesce(p_confirm, false) then
      raise exception 'look' using errcode = 'IMPLK';
    end if;
  exception when sqlstate 'IMPLK' then
    return v_counts || jsonb_build_object('repeated', false);
  end;
  return private.import_end(p_tenant_id, p_request_key, 'ledger', p_file_name, v_counts);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5a. Past daily counts
-- ---------------------------------------------------------------------------

-- [{"stock_item_id", "day", "on_hand"}, ...]. Fills in days from before this
-- app was watching, so sold-out days don't start thin. A day we already hold
-- a count for is left alone (what was seen here wins), as are days too old
-- for any sum to use and days that haven't happened yet.
create function public.import_daily_counts(
  p_tenant_id uuid, p_request_key uuid, p_rows jsonb, p_file_name text default '',
  p_confirm boolean default false
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_done jsonb := private.import_begin(p_tenant_id, p_request_key, p_rows, p_confirm);
  v_total int;
  v_new int := 0;
  v_counts jsonb;
begin
  if v_done is not null then
    return v_done;
  end if;
  begin
    if exists (
      select 1 from jsonb_to_recordset(p_rows) as x(stock_item_id uuid, day date, on_hand int)
      where x.stock_item_id is null or x.day is null or x.on_hand is null
         or not exists (
           select 1 from public.stock_items si
           where si.id = x.stock_item_id and si.tenant_id = p_tenant_id)
    ) then
      raise exception 'Item not found' using errcode = 'P0002';
    end if;
    select count(*)::int into v_total from (
      select distinct x.stock_item_id, x.day
      from jsonb_to_recordset(p_rows) as x(stock_item_id uuid, day date)) d;
    insert into public.stock_daily_counts (tenant_id, stock_item_id, day, on_hand)
    select p_tenant_id, x.stock_item_id, x.day, (array_agg(x.on_hand order by x.ord desc))[1]
    from (
      select (j.e ->> 'stock_item_id')::uuid as stock_item_id, (j.e ->> 'day')::date as day,
             (j.e ->> 'on_hand')::int as on_hand, j.ord
      from jsonb_array_elements(p_rows) with ordinality as j(e, ord)
    ) x
    join public.tenants t on t.id = p_tenant_id
    where x.day < (now() at time zone t.timezone)::date
      and x.day >= (now() at time zone 'UTC')::date - 200
    group by x.stock_item_id, x.day
    on conflict (stock_item_id, day) do nothing;
    get diagnostics v_new = row_count;
    v_counts := jsonb_build_object('new', v_new, 'changed', 0, 'same', v_total - v_new);
    if not coalesce(p_confirm, false) then
      raise exception 'look' using errcode = 'IMPLK';
    end if;
  exception when sqlstate 'IMPLK' then
    return v_counts || jsonb_build_object('repeated', false);
  end;
  return private.import_end(p_tenant_id, p_request_key, 'counts', p_file_name, v_counts);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5b. Past deliveries
-- ---------------------------------------------------------------------------

-- [{"reference", "stock_item_id", "quantity", "received_at"}, ...]
-- When goods on an imported order arrived. History only: how many arrived is
-- already on the order's lines (the orders file says), so this adds nothing
-- to a line and nothing to a count. It records the day, which is what "how
-- long does this supplier really take" is worked out from. Each is marked as
-- imported and "not sent to the shop", for good.
-- A delivery for an order that isn't here, wasn't imported, or has no such
-- item is left out and counted as "unmatched".
create function public.import_deliveries(
  p_tenant_id uuid, p_request_key uuid, p_rows jsonb, p_file_name text default '',
  p_confirm boolean default false
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_done jsonb := private.import_begin(p_tenant_id, p_request_key, p_rows, p_confirm);
  v_total int;
  v_matched int;
  v_new int := 0;
  v_counts jsonb;
begin
  if v_done is not null then
    return v_done;
  end if;
  begin
    if exists (
      select 1 from jsonb_to_recordset(p_rows) as x(
        reference text, stock_item_id uuid, quantity int, received_at timestamptz)
      where x.stock_item_id is null or x.received_at is null or x.received_at > now()
         or x.quantity is null or x.quantity < 1 or x.quantity > 1000000
    ) then
      raise exception 'How many arrived?' using errcode = '22023';
    end if;
    select count(*)::int into v_total from (
      select distinct upper(btrim(x.reference)), x.stock_item_id, x.quantity, x.received_at
      from jsonb_to_recordset(p_rows) as x(
        reference text, stock_item_id uuid, quantity int, received_at timestamptz)) d;

    with wanted as (
      select distinct l.id as line_id, l.stock_item_id, x.quantity, x.received_at
      from jsonb_to_recordset(p_rows) as x(
        reference text, stock_item_id uuid, quantity int, received_at timestamptz)
      join public.purchase_orders po
        on po.tenant_id = p_tenant_id and upper(po.reference) = upper(btrim(x.reference))
       and po.source = 'import'
      join public.purchase_order_lines l
        on l.po_id = po.id and l.stock_item_id = x.stock_item_id
    ), added as (
      insert into public.stock_receipts
        (tenant_id, po_line_id, stock_item_id, quantity, received_by, shop_status, source,
         created_at)
      select p_tenant_id, w.line_id, w.stock_item_id, w.quantity, null, 'skipped', 'import',
             w.received_at
      from wanted w
      where not exists (
        select 1 from public.stock_receipts r
        where r.po_line_id = w.line_id and r.source = 'import' and r.quantity = w.quantity
          and r.created_at = w.received_at)
      returning 1
    )
    select (select count(*)::int from wanted), (select count(*)::int from added)
    into v_matched, v_new;
    v_counts := jsonb_build_object(
      'new', v_new, 'changed', 0, 'same', v_matched - v_new, 'unmatched', v_total - v_matched);
    if not coalesce(p_confirm, false) then
      raise exception 'look' using errcode = 'IMPLK';
    end if;
  exception when sqlstate 'IMPLK' then
    return v_counts || jsonb_build_object('repeated', false);
  end;
  return private.import_end(p_tenant_id, p_request_key, 'deliveries', p_file_name, v_counts);
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.import_suppliers(uuid, uuid, jsonb, text, boolean)',
    'public.import_item_planning(uuid, uuid, jsonb, text, boolean)',
    'public.import_purchase_orders(uuid, uuid, jsonb, text, boolean)',
    'public.import_ledger_entries(uuid, uuid, jsonb, text, boolean)',
    'public.import_daily_counts(uuid, uuid, jsonb, text, boolean)',
    'public.import_deliveries(uuid, uuid, jsonb, text, boolean)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
