-- Payments to suppliers, read from the books. TuftStock fills its supplier
-- balances in three ways by itself: invoices and statements read out of
-- email, bank notices read out of email, and payments read each night from
-- the bookkeeping app's copy of the books. The first two need permission to
-- read the business's mail, which the suite does not ask for. The third
-- needs nothing new: a workspace that has connected QuickBooks has already
-- let us read its books.
--
-- So: when a workspace switches it on (Stock → Settings), each QuickBooks
-- sync hands the payments it found to `import_book_payments`, which files
-- the ones made out to a supplier of the same name on that supplier's
-- account. Nothing is ever written back to the books.

alter table public.supplier_ledger
  drop constraint supplier_ledger_source_check,
  add constraint supplier_ledger_source_check
    check (source in ('manual', 'import', 'books')),
  -- The books' own id for a payment ("qbo:BillPayment:412"), so the same
  -- payment read again lands on the same row.
  add column external_key text check (external_key is null or char_length(external_key) <= 120),
  add constraint supplier_ledger_books_have_a_key
    check ((source = 'books') = (external_key is not null));
create unique index supplier_ledger_external_key_idx
  on public.supplier_ledger (tenant_id, supplier_id, external_key)
  where external_key is not null;

-- A payment from the books that a manager took off an account. It is kept
-- off: the next sync would otherwise put it straight back.
create table public.supplier_ledger_skips (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  supplier_id uuid not null references public.suppliers (id) on delete cascade,
  external_key text not null check (char_length(external_key) <= 120),
  skipped_by uuid references auth.users (id) on delete set null,
  skipped_at timestamptz not null default now(),
  primary key (tenant_id, supplier_id, external_key)
);
alter table public.supplier_ledger_skips enable row level security;
-- Like the ledger itself: for the people who run the business.
create policy "managers read their supplier ledger skips" on public.supplier_ledger_skips
  for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin']::public.membership_role[]));
revoke all on public.supplier_ledger_skips from public, anon, authenticated, service_role;
grant select on public.supplier_ledger_skips to authenticated, service_role;

-- Removing an entry, as before. One that came from the books is also noted
-- as skipped, so it stays removed.
create or replace function public.remove_ledger_entry(p_tenant_id uuid, p_entry_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.supplier_ledger;
begin
  perform private.require_manager(p_tenant_id);
  delete from public.supplier_ledger l where l.id = p_entry_id and l.tenant_id = p_tenant_id
  returning * into v_row;
  if not found then
    raise exception 'Entry not found' using errcode = 'P0002';
  end if;
  if v_row.external_key is not null then
    insert into public.supplier_ledger_skips (tenant_id, supplier_id, external_key, skipped_by)
    values (v_row.tenant_id, v_row.supplier_id, v_row.external_key, (select auth.uid()))
    on conflict do nothing;
  end if;
end;
$$;

-- Whether a workspace has asked for payments to be read from its books. The
-- sync asks this first, so the books of a workspace that never switched it
-- on are not read for payments at all.
create function public.book_payments_wanted(p_tenant_id uuid, p_provider text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_provider = 'quickbooks' and exists (
    select 1 from public.configs c
    where c.tenant_id = p_tenant_id and c.module = 'stock' and c.key = 'settings'
      and c.body -> 'payments_from_books' = 'true'::jsonb);
$$;
revoke all on function public.book_payments_wanted(uuid, text) from public, anon, authenticated;
grant execute on function public.book_payments_wanted(uuid, text) to service_role;

-- Files payments read from the books on the accounts of the suppliers they
-- were made out to. Called by the sync (service role) for one named
-- workspace, with what it read:
--   [{"external_id", "kind", "date", "payee", "amount", "memo"}, ...]
--
-- Does nothing unless the workspace has switched "payments from my books" on.
-- A payment is filed only when:
--   * its payee is a supplier's name (capitals and outer spaces aside);
--   * that supplier's account has been started, and the payment is dated on
--     or after its first invoice or statement (older ones predate what is
--     tracked here);
--   * it isn't already there: the same books id updates its own row, and a
--     payment of the same amount typed in by hand within five days is taken
--     to be the same payment;
--   * a manager hasn't taken it off before.
-- Returns what happened, as counts. Safe to run again with the same rows.
create function public.import_book_payments(p_tenant_id uuid, p_provider text, p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  v_supplier uuid;
  v_from date;
  v_key text;
  v_note text;
  v_added int := 0;
  v_changed int := 0;
  v_same int := 0;
  v_unmatched int := 0;
  v_before int := 0;
  v_typed int := 0;
  v_skipped int := 0;
  v_read int := 0;
begin
  if p_provider is distinct from 'quickbooks' then
    raise exception 'Only the books connection files payments' using errcode = '22023';
  end if;
  if not public.book_payments_wanted(p_tenant_id, p_provider) then
    return jsonb_build_object('off', true);
  end if;
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 5000 then
    raise exception 'Bad rows' using errcode = '22023';
  end if;

  for r in
    select nullif(btrim(i.external_id), '') as external_id,
           coalesce(nullif(btrim(i.kind), ''), 'txn') as kind,
           i.date as day, nullif(btrim(i.payee), '') as payee,
           round(i.amount, 2) as amount, left(btrim(coalesce(i.memo, '')), 300) as memo
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as i(
      external_id text, kind text, date date, payee text, amount numeric, memo text)
  loop
    v_read := v_read + 1;
    if r.external_id is null or r.day is null or r.payee is null or r.amount is null
       or r.amount <= 0 or r.amount > 100000000
       or r.kind !~ '^[A-Za-z]{1,30}$' or char_length(r.external_id) > 60 then
      v_unmatched := v_unmatched + 1;
      continue;
    end if;
    select s.id into v_supplier from public.suppliers s
    where s.tenant_id = p_tenant_id and lower(btrim(s.name)) = lower(r.payee)
    order by (s.archived_at is null) desc, s.created_at limit 1;
    if v_supplier is null then
      v_unmatched := v_unmatched + 1;
      continue;
    end if;
    select min(l.entry_date) into v_from from public.supplier_ledger l
    where l.tenant_id = p_tenant_id and l.supplier_id = v_supplier
      and l.type in ('invoice', 'statement');
    if v_from is null or r.day < v_from then
      v_before := v_before + 1;
      continue;
    end if;
    v_key := 'qbo:' || r.kind || ':' || r.external_id;
    if exists (
      select 1 from public.supplier_ledger_skips k
      where k.tenant_id = p_tenant_id and k.supplier_id = v_supplier and k.external_key = v_key
    ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    v_note := left('From your books (QuickBooks)'
      || case when r.memo <> '' then ' · ' || r.memo else '' end, 500);
    if exists (
      select 1 from public.supplier_ledger l
      where l.tenant_id = p_tenant_id and l.supplier_id = v_supplier and l.external_key = v_key
    ) then
      update public.supplier_ledger l
      set entry_date = r.day, amount = r.amount, description = v_note
      where l.tenant_id = p_tenant_id and l.supplier_id = v_supplier and l.external_key = v_key
        and (l.entry_date <> r.day or l.amount <> r.amount or l.description <> v_note);
      if found then v_changed := v_changed + 1; else v_same := v_same + 1; end if;
      continue;
    end if;
    -- Typed in by hand already? The same amount within five days is the same payment.
    if exists (
      select 1 from public.supplier_ledger l
      where l.tenant_id = p_tenant_id and l.supplier_id = v_supplier and l.type = 'payment'
        and l.external_key is null and l.amount = r.amount
        and abs(l.entry_date - r.day) <= 5
    ) then
      v_typed := v_typed + 1;
      continue;
    end if;
    insert into public.supplier_ledger
      (tenant_id, supplier_id, type, entry_date, amount, description, source, external_key)
    values (p_tenant_id, v_supplier, 'payment', r.day, r.amount, v_note, 'books', v_key);
    v_added := v_added + 1;
  end loop;
  return jsonb_build_object(
    'read', v_read, 'added', v_added, 'changed', v_changed, 'same', v_same,
    'no_supplier', v_unmatched, 'before_account', v_before, 'typed_already', v_typed,
    'taken_off', v_skipped);
end;
$$;
revoke all on function public.import_book_payments(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.import_book_payments(uuid, text, jsonb) to service_role;
