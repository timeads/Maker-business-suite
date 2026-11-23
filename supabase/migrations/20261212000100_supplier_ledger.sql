-- What the business owes each supplier. A running account, not invoice-by-
-- invoice matching: invoices and payments are written down as they happen,
-- and a statement from the supplier (their own figure for what is owed on a
-- date) re-anchors the whole account. The balance is always worked out from
-- these entries on read; it is never stored.

alter table public.suppliers
  -- Days from an invoice's date until it is due.
  add column payment_terms_days int not null default 30
    check (payment_terms_days between 0 and 365);

create table public.supplier_ledger (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  supplier_id uuid not null references public.suppliers (id) on delete cascade,
  type text not null check (type in ('statement', 'invoice', 'payment', 'adjustment')),
  entry_date date not null,
  -- Positive for an invoice or payment. An adjustment is signed: negative is
  -- a credit in the business's favour. For a statement this is 0.
  amount numeric(14, 2) not null check (amount between -100000000 and 100000000),
  -- Statements only: what the supplier says is owed on that date (negative
  -- when the account is in credit).
  stated_balance numeric(14, 2),
  -- Invoice number, payment reference and the like.
  reference text check (reference is null or char_length(reference) <= 80),
  description text not null default '' check (char_length(description) <= 500),
  source text not null default 'manual' check (source in ('manual', 'import')),
  -- Invoices only: when someone marked it paid, before the payment shows up.
  payment_sent_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check ((type = 'statement') = (stated_balance is not null)),
  check (type = 'adjustment' or amount >= 0)
);
create index supplier_ledger_supplier_idx
  on public.supplier_ledger (tenant_id, supplier_id, entry_date desc);
alter table public.supplier_ledger enable row level security;
-- Like suppliers and orders, the account is for the people who run the business.
create policy "managers read their supplier ledger" on public.supplier_ledger
  for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin']::public.membership_role[]));
revoke all on public.supplier_ledger from public, anon, authenticated, service_role;
grant select on public.supplier_ledger to authenticated, service_role;

-- Writes an entry down. Entering an invoice (or payment) number that is
-- already on that supplier's account corrects the entry rather than adding a
-- second one, so a mistyped amount is fixed by typing it again.
create function public.save_ledger_entry(
  p_tenant_id uuid,
  p_supplier_id uuid,
  p_type text,
  p_entry_date date,
  p_amount numeric,
  p_stated_balance numeric default null,
  p_reference text default null,
  p_description text default ''
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_reference text := nullif(btrim(coalesce(p_reference, '')), '');
  v_amount numeric := case when p_type = 'statement' then 0 else round(coalesce(p_amount, 0), 2) end;
  v_stated numeric := case when p_type = 'statement' then round(coalesce(p_stated_balance, 0), 2) end;
begin
  perform private.require_manager(p_tenant_id);
  if not exists (
    select 1 from public.suppliers s where s.id = p_supplier_id and s.tenant_id = p_tenant_id
  ) then
    raise exception 'Supplier not found' using errcode = 'P0002';
  end if;
  if p_type not in ('statement', 'invoice', 'payment', 'adjustment') or p_entry_date is null
     or p_entry_date > current_date + 366 or p_entry_date < date '2000-01-01' then
    raise exception 'That entry is not valid' using errcode = '22023';
  end if;
  if p_type in ('invoice', 'payment') and v_amount <= 0 then
    raise exception 'amount_needed' using errcode = 'P0001';
  end if;
  if p_type = 'adjustment' and v_amount = 0 then
    raise exception 'amount_needed' using errcode = 'P0001';
  end if;

  if v_reference is not null and p_type in ('invoice', 'payment') then
    update public.supplier_ledger l
    set entry_date = p_entry_date, amount = v_amount,
        description = left(btrim(coalesce(p_description, '')), 500)
    where l.tenant_id = p_tenant_id and l.supplier_id = p_supplier_id and l.type = p_type
      and lower(l.reference) = lower(v_reference)
    returning l.id into v_id;
    if v_id is not null then
      return v_id;
    end if;
  end if;

  insert into public.supplier_ledger
    (tenant_id, supplier_id, type, entry_date, amount, stated_balance, reference, description,
     created_by)
  values
    (p_tenant_id, p_supplier_id, p_type, p_entry_date, v_amount, v_stated, left(v_reference, 80),
     left(btrim(coalesce(p_description, '')), 500), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

create function public.remove_ledger_entry(p_tenant_id uuid, p_entry_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  delete from public.supplier_ledger l where l.id = p_entry_id and l.tenant_id = p_tenant_id;
  if not found then
    raise exception 'Entry not found' using errcode = 'P0002';
  end if;
end;
$$;

-- Ticks an invoice as paid (the money has been sent), or unticks it. The
-- balance doesn't move until the payment itself is written down.
create function public.mark_bill_paid(p_tenant_id uuid, p_entry_id uuid, p_paid boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  update public.supplier_ledger l
  set payment_sent_at = case when coalesce(p_paid, false) then coalesce(l.payment_sent_at, now()) end
  where l.id = p_entry_id and l.tenant_id = p_tenant_id and l.type = 'invoice';
  if not found then
    raise exception 'Entry not found' using errcode = 'P0002';
  end if;
end;
$$;

create function public.set_supplier_terms(p_tenant_id uuid, p_supplier_id uuid, p_days int)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  update public.suppliers s set payment_terms_days = p_days
  where s.id = p_supplier_id and s.tenant_id = p_tenant_id;
  if not found then
    raise exception 'Supplier not found' using errcode = 'P0002';
  end if;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.save_ledger_entry(uuid, uuid, text, date, numeric, numeric, text, text)',
    'public.remove_ledger_entry(uuid, uuid)',
    'public.mark_bill_paid(uuid, uuid, boolean)',
    'public.set_supplier_terms(uuid, uuid, int)'
  ]
  loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
