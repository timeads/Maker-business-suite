-- A name for each purchase order that a supplier can quote back, the way
-- TuftStock names them: the first two letters of the supplier's name, the
-- year and month the order was started, and a short code, as in
-- KA-202611-A7A950. The plain number (1, 2, 3 ...) stays and still opens the
-- order in its address; the reference is what people read.
--
-- An order brought in from a spreadsheet keeps the reference it already had.

alter table public.purchase_orders
  add column reference text check (reference is null or char_length(reference) between 3 and 40);

-- "Kestrel Mills" -> KE, "3M" -> MX, "" -> PO. The same rule as
-- supplierPrefix() in src/lib/stock/po/reference.ts; a test keeps them in step.
create function private.po_reference_prefix(p_name text)
returns text
language sql immutable set search_path = ''
as $$
  select rpad(
    coalesce(
      nullif(left(upper(regexp_replace(coalesce(p_name, ''), '[^A-Za-z]', '', 'g')), 2), ''),
      'PO'),
    2, 'X');
$$;
revoke all on function private.po_reference_prefix(text) from public;

-- A reference nobody in the workspace has yet.
create function private.new_po_reference(p_tenant_id uuid, p_supplier_id uuid, p_at timestamptz)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_start text;
  v_reference text;
begin
  select private.po_reference_prefix(s.name) into v_start
  from public.suppliers s where s.id = p_supplier_id;
  v_start := coalesce(v_start, 'PO') || '-'
    || to_char(coalesce(p_at, now()) at time zone 'UTC', 'YYYYMM') || '-';
  loop
    v_reference := v_start || upper(substr(md5(gen_random_uuid()::text), 1, 6));
    exit when not exists (
      select 1 from public.purchase_orders po
      where po.tenant_id = p_tenant_id and upper(po.reference) = v_reference);
  end loop;
  return v_reference;
end;
$$;
revoke all on function private.new_po_reference(uuid, uuid, timestamptz) from public;

-- Orders made before this get one now, dated by when they were started.
do $$
declare
  r record;
begin
  for r in
    select po.id, po.tenant_id, po.supplier_id, po.created_at
    from public.purchase_orders po where po.reference is null order by po.created_at
  loop
    update public.purchase_orders po
    set reference = private.new_po_reference(r.tenant_id, r.supplier_id, r.created_at)
    where po.id = r.id;
  end loop;
end;
$$;

-- Every way an order is made (by hand, drafted from a selection, imported)
-- goes through an insert, so the reference is given here and nowhere else.
create function private.purchase_orders_reference()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.reference := nullif(btrim(coalesce(new.reference, '')), '');
  if new.reference is null then
    new.reference := private.new_po_reference(new.tenant_id, new.supplier_id, new.created_at);
  end if;
  return new;
end;
$$;
revoke all on function private.purchase_orders_reference() from public;

create trigger purchase_orders_reference
  before insert on public.purchase_orders
  for each row execute function private.purchase_orders_reference();

alter table public.purchase_orders alter column reference set not null;
-- One of each per workspace, whatever the capitals.
create unique index purchase_orders_reference_idx
  on public.purchase_orders (tenant_id, upper(reference));
