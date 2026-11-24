-- When a supplier is shut. Factories close for weeks at a time (Spring
-- Festival is about a month, and it moves every year), and an order has to
-- land before they do. A manager writes the dates down; every order-by date
-- for that supplier's items is then worked out around them on read
-- (lib/stock/engine/closures.ts). Only the dates are stored, never the
-- order-by dates or amounts they lead to.

create table public.supplier_closures (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  supplier_id uuid not null references public.suppliers (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  -- First and last day shut, both included. Plain days: no time, no timezone.
  starts_on date not null,
  ends_on date not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on),
  -- A closure is weeks, not years: a slip of the year is caught here.
  check (ends_on - starts_on <= 366)
);
create index supplier_closures_supplier_idx
  on public.supplier_closures (tenant_id, supplier_id, starts_on);

alter table public.supplier_closures enable row level security;
create policy "members read their supplier_closures" on public.supplier_closures
  for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));
-- Read by the team; written only through the functions below.
revoke all on public.supplier_closures from public, anon, authenticated, service_role;
grant select on public.supplier_closures to authenticated, service_role;

-- Adds a closure, or changes one (p_closure_id set). Owners and admins only.
create function public.save_supplier_closure(
  p_tenant_id uuid, p_supplier_id uuid, p_closure_id uuid, p_name text,
  p_starts_on date, p_ends_on date
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_manager(p_tenant_id);
  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception 'A closure needs a name' using errcode = '22023';
  end if;
  if p_starts_on is null or p_ends_on is null or p_ends_on < p_starts_on
     or p_ends_on - p_starts_on > 366 then
    raise exception 'Bad dates' using errcode = '22023';
  end if;
  -- The supplier must be this workspace's own.
  perform 1 from public.suppliers s
  where s.id = p_supplier_id and s.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'Supplier not found' using errcode = 'P0002';
  end if;
  if p_closure_id is null then
    if (select count(*) from public.supplier_closures c
        where c.tenant_id = p_tenant_id and c.supplier_id = p_supplier_id) >= 40 then
      raise exception 'too_many_closures' using errcode = '54000';
    end if;
    insert into public.supplier_closures
      (tenant_id, supplier_id, name, starts_on, ends_on, created_by)
    values (p_tenant_id, p_supplier_id, left(btrim(p_name), 80), p_starts_on, p_ends_on,
            (select auth.uid()))
    returning id into v_id;
  else
    update public.supplier_closures c
    set name = left(btrim(p_name), 80), starts_on = p_starts_on, ends_on = p_ends_on
    where c.id = p_closure_id and c.tenant_id = p_tenant_id and c.supplier_id = p_supplier_id
    returning c.id into v_id;
    if v_id is null then
      raise exception 'Closure not found' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
end;
$$;

-- Takes a closure off. Owners and admins of its own workspace only.
create function public.remove_supplier_closure(p_closure_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select c.tenant_id into v_tenant
  from public.supplier_closures c
  where c.id = p_closure_id
    and c.tenant_id in (select private.user_tenant_ids());
  if v_tenant is null then
    raise exception 'Closure not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_tenant);
  delete from public.supplier_closures c where c.id = p_closure_id and c.tenant_id = v_tenant;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.save_supplier_closure(uuid, uuid, uuid, text, date, date)',
    'public.remove_supplier_closure(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
