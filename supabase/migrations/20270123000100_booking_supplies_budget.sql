-- Bookings: classroom supplies, their vendors, and the budget.
--
-- Ported from the business's earlier booking app, made multi-tenant. Every
-- table has tenant_id and RLS; the whole team can read, and only owners and
-- admins change anything, through the functions below (no client has insert,
-- update or delete on these tables).
--
-- Nothing derived is stored. How much of a supply is on hand, what classes
-- have used, the run-out and order-by dates, the suggested order, and every
-- figure on the budget are worked out on read by the pure functions in
-- `lib/bookings/supplies` and `lib/bookings/budget`. What is stored is what
-- a person said: a count ("we have 40"), a delivery, a correction, an order
-- placed, a cost, a rate.
--
-- Money is whole cents. Rates per square foot are hundredths of a cent, so a
-- yarn costing $0.0125 a square foot can be written down; every total is
-- rounded to whole cents on read.
--
-- Not linked to Stock's items or suppliers in this pass (docs/bookings-side-by-side.md).

-- ---------------------------------------------------------------------------
-- Vendors and supplies
-- ---------------------------------------------------------------------------

create table public.class_vendors (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  email text not null default '' check (char_length(email) <= 200),
  website text not null default '' check (website = '' or website ~ '^https://' and char_length(website) <= 300),
  -- How to order: a portal, a rep's name, a minimum.
  note text not null default '' check (char_length(note) <= 2000),
  created_at timestamptz not null default now()
);
create unique index class_vendors_name_idx on public.class_vendors (tenant_id, lower(btrim(name)));

create table public.class_supplies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  vendor_id uuid references public.class_vendors (id) on delete set null,
  -- What one person in a class uses (a fraction is fine: half a yard).
  per_student numeric(12, 3) not null default 1 check (per_student >= 0 and per_student <= 100000),
  lead_time_days int not null default 7 check (lead_time_days between 0 and 365),
  -- A buffer the order-by date protects.
  safety_stock numeric(12, 3) not null default 0 check (safety_stock >= 0 and safety_stock <= 1000000),
  -- How long an order should last once it arrives.
  coverage_days int not null default 60 check (coverage_days between 1 and 730),
  -- What one unit costs, for the budget's materials.
  unit_cost_cents int not null default 0 check (unit_cost_cents between 0 and 100000000),
  unit text not null default '' check (char_length(unit) <= 30),
  notes text not null default '' check (char_length(notes) <= 2000),
  active boolean not null default true,
  -- Classes from this moment on use it up. Set when it is added, so a count
  -- typed in today isn't taken down again for classes before it.
  counts_from timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index class_supplies_tenant_idx on public.class_supplies (tenant_id, name);

-- Which workshops use a supply. One with none is kept but never used up.
create table public.class_supply_services (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  supply_id uuid not null references public.class_supplies (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  primary key (supply_id, service_id)
);
create index class_supply_services_tenant_idx on public.class_supply_services (tenant_id);

create table public.class_supply_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  supply_id uuid not null references public.class_supplies (id) on delete cascade,
  qty numeric(12, 3) not null check (qty > 0 and qty <= 1000000),
  placed_on date not null,
  expected_on date not null,
  status text not null default 'open' check (status in ('open', 'received', 'cancelled')),
  received_at timestamptz,
  note text not null default '' check (char_length(note) <= 500),
  created_at timestamptz not null default now()
);
create index class_supply_orders_supply_idx on public.class_supply_orders (supply_id, status);

-- What a person said about a supply's stock, in order:
--   count       "we have this many now": the starting point from then on
--   received    a delivery came in (an order received, or one off)
--   adjustment  a correction, up or down
create table public.class_supply_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  supply_id uuid not null references public.class_supplies (id) on delete cascade,
  kind text not null check (kind in ('count', 'received', 'adjustment')),
  qty numeric(12, 3) not null check (qty between -1000000 and 1000000),
  check (kind = 'adjustment' or qty >= 0),
  order_id uuid references public.class_supply_orders (id) on delete set null,
  note text not null default '' check (char_length(note) <= 500),
  at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  -- An order is received once.
  unique (order_id)
);
create index class_supply_entries_supply_idx on public.class_supply_entries (supply_id, at);

-- ---------------------------------------------------------------------------
-- The budget
-- ---------------------------------------------------------------------------

-- Rent, insurance, software: monthly amounts, from one month to another.
create table public.budget_fixed_costs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  monthly_cents int not null check (monthly_cents between 0 and 1000000000),
  -- First of the first month it applies, and of the last (null: still going).
  from_month date not null default date '2000-01-01' check (extract(day from from_month) = 1),
  to_month date check (to_month is null or (extract(day from to_month) = 1 and to_month >= from_month)),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index budget_fixed_costs_tenant_idx on public.budget_fixed_costs (tenant_id);

-- What materials cost by the square foot of a project (yarn, backing, glue).
create table public.budget_material_rates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  -- Hundredths of a cent per square foot: 125 is $0.0125.
  centi_cents_per_sqft int not null check (centi_cents_per_sqft between 0 and 100000000),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index budget_material_rates_tenant_idx on public.budget_material_rates (tenant_id);

-- Money in that isn't a booking (a private class paid by invoice elsewhere).
create table public.budget_other_income (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  label text not null check (char_length(btrim(label)) between 1 and 120),
  amount_cents int not null check (amount_cents between 0 and 1000000000),
  received_on date not null,
  created_at timestamptz not null default now()
);
create index budget_other_income_tenant_idx on public.budget_other_income (tenant_id, received_on);

-- A workshop's project size, for materials by the square foot (0: not set).
alter table public.services
  add column frame_width_in numeric(6, 2) not null default 0
    check (frame_width_in >= 0 and frame_width_in <= 1000),
  add column frame_height_in numeric(6, 2) not null default 0
    check (frame_height_in >= 0 and frame_height_in <= 1000);

-- One date's own costs: who taught it (one of the budget config's teachers;
-- null: the first), a flat teaching fee instead of hours × rate, and a
-- different project size (a private class choosing a bigger frame).
create table public.session_costs (
  session_id uuid primary key references public.sessions (id) on delete cascade,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  teacher text check (teacher is null or teacher ~ '^[a-z0-9-]{1,20}$'),
  teaching_cents int check (teaching_cents is null or teaching_cents between 0 and 100000000),
  frame_width_in numeric(6, 2) check (frame_width_in is null or frame_width_in between 0 and 1000),
  frame_height_in numeric(6, 2) check (frame_height_in is null or frame_height_in between 0 and 1000),
  updated_at timestamptz not null default now()
);
create index session_costs_tenant_idx on public.session_costs (tenant_id);

-- ---------------------------------------------------------------------------
-- Access: the team reads, nobody writes but the functions
-- ---------------------------------------------------------------------------

-- Supplies and vendors: the whole team reads them.
do $$
declare
  t text;
begin
  foreach t in array array[
    'class_vendors', 'class_supplies', 'class_supply_services', 'class_supply_orders',
    'class_supply_entries'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (tenant_id in (select private.user_tenant_ids()))',
      t || '_select', t);
  end loop;
end;
$$;

-- The budget is money: only owners and admins read it.
do $$
declare
  t text;
begin
  foreach t in array array[
    'budget_fixed_costs', 'budget_material_rates', 'budget_other_income', 'session_costs'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (private.has_tenant_role(tenant_id, array[''owner'', ''admin'']::public.membership_role[]))',
      t || '_select', t);
  end loop;
end;
$$;

grant select (frame_width_in, frame_height_in) on public.services to authenticated;

-- ---------------------------------------------------------------------------
-- Writes, each checking the caller is an owner or admin of the workspace
-- ---------------------------------------------------------------------------

create function public.save_class_vendor(
  p_tenant_id uuid, p_id uuid, p_name text, p_email text, p_website text, p_note text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_manager(p_tenant_id);
  if p_id is null then
    insert into public.class_vendors (tenant_id, name, email, website, note)
    values (p_tenant_id, btrim(p_name), btrim(coalesce(p_email, '')),
            btrim(coalesce(p_website, '')), btrim(coalesce(p_note, '')))
    returning id into v_id;
  else
    update public.class_vendors v
    set name = btrim(p_name), email = btrim(coalesce(p_email, '')),
        website = btrim(coalesce(p_website, '')), note = btrim(coalesce(p_note, ''))
    where v.id = p_id and v.tenant_id = p_tenant_id
    returning v.id into v_id;
    if v_id is null then
      raise exception 'Vendor not found' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
end;
$$;

create function public.delete_class_vendor(p_tenant_id uuid, p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  -- Its supplies are kept, with no vendor.
  delete from public.class_vendors v where v.id = p_id and v.tenant_id = p_tenant_id;
end;
$$;

-- A supply, with the workshops that use it. A new one starts from the count
-- given (`p_count`), and counts classes from now on.
create function public.save_class_supply(
  p_tenant_id uuid,
  p_id uuid,
  p_fields jsonb,
  p_service_ids uuid[],
  p_count numeric default null
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_vendor uuid := nullif(p_fields ->> 'vendor_id', '')::uuid;
begin
  perform private.require_manager(p_tenant_id);
  if v_vendor is not null and not exists (
    select 1 from public.class_vendors v where v.id = v_vendor and v.tenant_id = p_tenant_id) then
    raise exception 'Vendor not found' using errcode = 'P0002';
  end if;
  if p_id is null then
    insert into public.class_supplies
      (tenant_id, name, vendor_id, per_student, lead_time_days, safety_stock, coverage_days,
       unit_cost_cents, unit, notes, active)
    values
      (p_tenant_id, btrim(p_fields ->> 'name'), v_vendor,
       coalesce((p_fields ->> 'per_student')::numeric, 1),
       coalesce((p_fields ->> 'lead_time_days')::int, 7),
       coalesce((p_fields ->> 'safety_stock')::numeric, 0),
       coalesce((p_fields ->> 'coverage_days')::int, 60),
       coalesce((p_fields ->> 'unit_cost_cents')::int, 0),
       btrim(coalesce(p_fields ->> 'unit', '')), btrim(coalesce(p_fields ->> 'notes', '')),
       coalesce((p_fields ->> 'active')::boolean, true))
    returning id into v_id;
    insert into public.class_supply_entries (tenant_id, supply_id, kind, qty, note, created_by)
    values (p_tenant_id, v_id, 'count', greatest(coalesce(p_count, 0), 0), 'Starting count', auth.uid());
  else
    update public.class_supplies s
    set name = btrim(p_fields ->> 'name'), vendor_id = v_vendor,
        per_student = coalesce((p_fields ->> 'per_student')::numeric, s.per_student),
        lead_time_days = coalesce((p_fields ->> 'lead_time_days')::int, s.lead_time_days),
        safety_stock = coalesce((p_fields ->> 'safety_stock')::numeric, s.safety_stock),
        coverage_days = coalesce((p_fields ->> 'coverage_days')::int, s.coverage_days),
        unit_cost_cents = coalesce((p_fields ->> 'unit_cost_cents')::int, s.unit_cost_cents),
        unit = btrim(coalesce(p_fields ->> 'unit', s.unit)),
        notes = btrim(coalesce(p_fields ->> 'notes', s.notes)),
        active = coalesce((p_fields ->> 'active')::boolean, s.active)
    where s.id = p_id and s.tenant_id = p_tenant_id
    returning s.id into v_id;
    if v_id is null then
      raise exception 'Supply not found' using errcode = 'P0002';
    end if;
  end if;
  -- Only this workspace's workshops.
  delete from public.class_supply_services l where l.supply_id = v_id;
  insert into public.class_supply_services (tenant_id, supply_id, service_id)
  select p_tenant_id, v_id, sv.id from public.services sv
  where sv.tenant_id = p_tenant_id and sv.id = any (coalesce(p_service_ids, '{}'))
  on conflict do nothing;
  return v_id;
end;
$$;

-- A count, a delivery or a correction.
create function public.add_class_supply_entry(
  p_supply_id uuid, p_kind text, p_qty numeric, p_note text default ''
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_supply public.class_supplies;
  v_id uuid;
begin
  select * into v_supply from public.class_supplies s where s.id = p_supply_id;
  if not found then
    raise exception 'Supply not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_supply.tenant_id);
  if p_kind is null or p_kind not in ('count', 'received', 'adjustment') then
    raise exception 'Unknown entry' using errcode = '22023';
  end if;
  if p_qty is null or (p_kind = 'adjustment' and p_qty = 0) then
    raise exception 'Give an amount' using errcode = '22023';
  end if;
  insert into public.class_supply_entries (tenant_id, supply_id, kind, qty, note, created_by)
  values (v_supply.tenant_id, v_supply.id, p_kind, p_qty, left(btrim(coalesce(p_note, '')), 500),
          auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

create function public.place_class_supply_order(
  p_supply_id uuid, p_qty numeric, p_expected_on date, p_note text default ''
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_supply public.class_supplies;
  v_id uuid;
  v_today date;
begin
  select * into v_supply from public.class_supplies s where s.id = p_supply_id;
  if not found then
    raise exception 'Supply not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_supply.tenant_id);
  select (now() at time zone t.timezone)::date into v_today
  from public.tenants t where t.id = v_supply.tenant_id;
  insert into public.class_supply_orders (tenant_id, supply_id, qty, placed_on, expected_on, note)
  values (v_supply.tenant_id, v_supply.id, p_qty, v_today, p_expected_on,
          left(btrim(coalesce(p_note, '')), 500))
  returning id into v_id;
  return v_id;
end;
$$;

-- An order arrives: received once, as a delivery entry, in one go. A second
-- press finds the first.
create function public.receive_class_supply_order(p_order_id uuid, p_qty numeric default null)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.class_supply_orders;
begin
  select * into v_order from public.class_supply_orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_order.tenant_id);
  if v_order.status <> 'open' then
    return 'already';
  end if;
  insert into public.class_supply_entries (tenant_id, supply_id, kind, qty, order_id, note, created_by)
  values (v_order.tenant_id, v_order.supply_id, 'received',
          greatest(coalesce(p_qty, v_order.qty), 0), v_order.id, 'Order received', auth.uid());
  update public.class_supply_orders o set status = 'received', received_at = now()
  where o.id = v_order.id;
  return 'received';
end;
$$;

create function public.cancel_class_supply_order(p_order_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_order public.class_supply_orders;
begin
  select * into v_order from public.class_supply_orders o where o.id = p_order_id;
  if not found then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_order.tenant_id);
  update public.class_supply_orders o set status = 'cancelled'
  where o.id = v_order.id and o.status = 'open';
end;
$$;

create function public.save_budget_fixed_cost(
  p_tenant_id uuid, p_id uuid, p_name text, p_monthly_cents int, p_from_month date,
  p_to_month date, p_active boolean
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_manager(p_tenant_id);
  if p_id is null then
    insert into public.budget_fixed_costs (tenant_id, name, monthly_cents, from_month, to_month, active)
    values (p_tenant_id, btrim(p_name), p_monthly_cents,
            date_trunc('month', coalesce(p_from_month, date '2000-01-01'))::date,
            date_trunc('month', p_to_month)::date, coalesce(p_active, true))
    returning id into v_id;
  else
    update public.budget_fixed_costs f
    set name = btrim(p_name), monthly_cents = p_monthly_cents,
        from_month = date_trunc('month', coalesce(p_from_month, date '2000-01-01'))::date,
        to_month = date_trunc('month', p_to_month)::date, active = coalesce(p_active, true)
    where f.id = p_id and f.tenant_id = p_tenant_id
    returning f.id into v_id;
    if v_id is null then
      raise exception 'Not found' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
end;
$$;

create function public.save_budget_material_rate(
  p_tenant_id uuid, p_id uuid, p_name text, p_centi_cents_per_sqft int, p_active boolean
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_manager(p_tenant_id);
  if p_id is null then
    insert into public.budget_material_rates (tenant_id, name, centi_cents_per_sqft, active)
    values (p_tenant_id, btrim(p_name), p_centi_cents_per_sqft, coalesce(p_active, true))
    returning id into v_id;
  else
    update public.budget_material_rates r
    set name = btrim(p_name), centi_cents_per_sqft = p_centi_cents_per_sqft,
        active = coalesce(p_active, true)
    where r.id = p_id and r.tenant_id = p_tenant_id
    returning r.id into v_id;
    if v_id is null then
      raise exception 'Not found' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
end;
$$;

create function public.save_budget_other_income(
  p_tenant_id uuid, p_id uuid, p_label text, p_amount_cents int, p_received_on date
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_manager(p_tenant_id);
  if p_id is null then
    insert into public.budget_other_income (tenant_id, label, amount_cents, received_on)
    values (p_tenant_id, btrim(p_label), p_amount_cents, p_received_on)
    returning id into v_id;
  else
    update public.budget_other_income i
    set label = btrim(p_label), amount_cents = p_amount_cents, received_on = p_received_on
    where i.id = p_id and i.tenant_id = p_tenant_id
    returning i.id into v_id;
    if v_id is null then
      raise exception 'Not found' using errcode = 'P0002';
    end if;
  end if;
  return v_id;
end;
$$;

-- Removes one of the three budget lists' rows.
create function public.delete_budget_row(p_tenant_id uuid, p_kind text, p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  if p_kind = 'fixed' then
    delete from public.budget_fixed_costs f where f.id = p_id and f.tenant_id = p_tenant_id;
  elsif p_kind = 'material' then
    delete from public.budget_material_rates r where r.id = p_id and r.tenant_id = p_tenant_id;
  elsif p_kind = 'income' then
    delete from public.budget_other_income i where i.id = p_id and i.tenant_id = p_tenant_id;
  else
    raise exception 'Unknown list' using errcode = '22023';
  end if;
end;
$$;

-- A workshop's project size.
create function public.set_service_frame(p_service_id uuid, p_width numeric, p_height numeric)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select sv.tenant_id into v_tenant from public.services sv where sv.id = p_service_id;
  if v_tenant is null then
    raise exception 'Workshop not found' using errcode = 'P0002';
  end if;
  perform private.require_manager(v_tenant);
  update public.services sv
  set frame_width_in = greatest(coalesce(p_width, 0), 0),
      frame_height_in = greatest(coalesce(p_height, 0), 0)
  where sv.id = p_service_id;
end;
$$;

-- One or more dates' costs at once (a teacher who covers classes running
-- together). Only the keys handed over change: teacher, teaching_cents,
-- frame_width_in, frame_height_in; a JSON null clears one.
create function public.set_session_costs(p_tenant_id uuid, p_session_ids uuid[], p_changes jsonb)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_count int;
begin
  perform private.require_manager(p_tenant_id);
  if jsonb_typeof(p_changes) is distinct from 'object' then
    raise exception 'Nothing to change' using errcode = '22023';
  end if;
  insert into public.session_costs (session_id, tenant_id)
  select s.id, p_tenant_id from public.sessions s
  where s.tenant_id = p_tenant_id and s.id = any (coalesce(p_session_ids, '{}'))
  on conflict (session_id) do nothing;
  update public.session_costs c
  set teacher = case when p_changes ? 'teacher' then p_changes ->> 'teacher' else c.teacher end,
      teaching_cents = case when p_changes ? 'teaching_cents'
                            then (p_changes ->> 'teaching_cents')::int else c.teaching_cents end,
      frame_width_in = case when p_changes ? 'frame_width_in'
                            then (p_changes ->> 'frame_width_in')::numeric else c.frame_width_in end,
      frame_height_in = case when p_changes ? 'frame_height_in'
                             then (p_changes ->> 'frame_height_in')::numeric else c.frame_height_in end,
      updated_at = now()
  where c.tenant_id = p_tenant_id and c.session_id = any (coalesce(p_session_ids, '{}'));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.save_class_vendor(uuid, uuid, text, text, text, text)',
    'public.delete_class_vendor(uuid, uuid)',
    'public.save_class_supply(uuid, uuid, jsonb, uuid[], numeric)',
    'public.add_class_supply_entry(uuid, text, numeric, text)',
    'public.place_class_supply_order(uuid, numeric, date, text)',
    'public.receive_class_supply_order(uuid, numeric)',
    'public.cancel_class_supply_order(uuid)',
    'public.save_budget_fixed_cost(uuid, uuid, text, int, date, date, boolean)',
    'public.save_budget_material_rate(uuid, uuid, text, int, boolean)',
    'public.save_budget_other_income(uuid, uuid, text, int, date)',
    'public.delete_budget_row(uuid, text, uuid)',
    'public.set_service_frame(uuid, numeric, numeric)',
    'public.set_session_costs(uuid, uuid[], jsonb)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
