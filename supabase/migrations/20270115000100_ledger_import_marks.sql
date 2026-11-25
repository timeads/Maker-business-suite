-- The ledger import, now carrying two things a spreadsheet can say about an
-- entry and the balance needs:
--
--   * whose word a payment is (`reported_by`: the supplier's "we received
--     it", or the bank's notice). The balance counts a payment seen from both
--     sides once (lib/stock/balance); a file that left this out made both
--     halves plain payments, and both were taken off.
--   * "to check" (`needs_review`, `review_note`), which counts in the balance
--     meanwhile, as everywhere else.
--
-- [{"supplier", "type", "entry_date", "amount", "stated_balance",
--   "reference", "description", "paid_on",
--   "reported_by", "needs_review", "review_note"}, ...]
--
-- The three new keys follow the rule of the other imports: a key in a row is
-- set (null clears it), one that isn't there is left alone, so a file without
-- these columns does exactly what it did before.
--
-- An entry that is already here and differs from its row only in these marks
-- is CHANGED in place, never added again, so the same records can be brought
-- in a second time from a file that now says who reported each payment. Only
-- entries that came from a spreadsheet have their marks changed; one typed in
-- or read from an email keeps its own.
--
-- Everything else holds as before: an invoice or payment with a number
-- corrects the entry that has that number; anything else is added only if
-- the very same entry isn't here already; two identical rows in a file make
-- two entries, once; the same file again changes nothing. Rows are matched
-- one to one: each row of the file takes an entry of its own, so two
-- payments of the same amount on the same day that differ only in who
-- reported them stay two entries.
create or replace function public.import_ledger_entries(
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
  v_pass int;
  v_supplier uuid;
  v_id uuid;
  v_row public.supplier_ledger;
  -- Entries a row of this file has already been matched to (or made).
  v_taken uuid[] := '{}';
  -- Entries with a number that this file added.
  v_fresh uuid[] := '{}';
  -- Rows with no exact match, left for the second pass.
  v_later bigint[] := '{}';
begin
  if v_done is not null then
    return v_done;
  end if;
  begin
    -- Two passes over the rows that have no number to go by. First every row
    -- takes an entry that is exactly as it says; only then do the rest look
    -- for one to change, so an entry that is already right is never changed
    -- to suit another row.
    for v_pass in 1..2 loop
      for r in
        select x.ord, btrim(x.supplier) as supplier, lower(x.type) as type, x.entry_date,
               case when lower(x.type) = 'statement' then 0 else round(coalesce(x.amount, 0), 2) end
                 as amount,
               case when lower(x.type) = 'statement' then round(coalesce(x.stated_balance, 0), 2) end
                 as stated_balance,
               nullif(left(btrim(coalesce(x.reference, '')), 80), '') as reference,
               left(btrim(coalesce(x.description, '')), 500) as description,
               x.paid_on,
               x.has_by, nullif(lower(btrim(coalesce(x.reported_by, ''))), '') as reported_by,
               x.has_review, coalesce(x.needs_review, false) as needs_review,
               case when coalesce(x.needs_review, false)
                 then nullif(left(btrim(coalesce(x.review_note, '')), 500), '') end as review_note
        from (
          select t.e ->> 'supplier' as supplier, t.e ->> 'type' as type,
                 (t.e ->> 'entry_date')::date as entry_date, (t.e ->> 'amount')::numeric as amount,
                 (t.e ->> 'stated_balance')::numeric as stated_balance,
                 t.e ->> 'reference' as reference, t.e ->> 'description' as description,
                 (t.e ->> 'paid_on')::timestamptz as paid_on,
                 t.e ? 'reported_by' as has_by, t.e ->> 'reported_by' as reported_by,
                 t.e ? 'needs_review' as has_review,
                 (t.e ->> 'needs_review')::boolean as needs_review,
                 t.e ->> 'review_note' as review_note, t.ord
          from jsonb_array_elements(p_rows) with ordinality as t(e, ord)
        ) x
        where v_pass = 1 or x.ord = any(v_later)
        order by x.ord
      loop
        if r.type not in ('statement', 'invoice', 'payment', 'adjustment') or r.entry_date is null
           or r.entry_date < date '2000-01-01' or r.entry_date > current_date + 366
           or (r.type in ('invoice', 'payment') and r.amount <= 0)
           or (r.type = 'adjustment' and r.amount = 0)
           or (r.reported_by is not null
               and (r.type <> 'payment' or r.reported_by not in ('supplier', 'bank'))) then
          raise exception 'That entry is not valid' using errcode = '22023';
        end if;
        select s.p_added, s.p_id into v_suppliers, v_supplier
        from private.import_supplier(p_tenant_id, r.supplier, v_suppliers) s;

        -- An invoice or payment with a number: the entry with that number.
        if r.reference is not null and r.type in ('invoice', 'payment') then
          select l.* into v_row from public.supplier_ledger l
          where l.tenant_id = p_tenant_id and l.supplier_id = v_supplier and l.type = r.type
            and lower(l.reference) = lower(r.reference)
          order by l.created_at, l.id limit 1;
          if v_row.id is not null
             -- The very same row twice in one file is two entries, as before.
             and not (v_row.id = any(v_fresh)
                      and v_row.entry_date = r.entry_date and v_row.amount = r.amount
                      and v_row.description = r.description
                      and v_row.payment_sent_at is not distinct from
                          (case when r.type = 'invoice' then r.paid_on end)
                      and v_row.reported_by is not distinct from r.reported_by
                      and v_row.needs_review = r.needs_review
                      and v_row.review_note is not distinct from r.review_note) then
            update public.supplier_ledger l
            set entry_date = r.entry_date, amount = r.amount, description = r.description,
                payment_sent_at = case when r.type = 'invoice'
                  then coalesce(l.payment_sent_at, r.paid_on) else l.payment_sent_at end,
                reported_by = case when r.has_by and l.source = 'import'
                  then r.reported_by else l.reported_by end,
                needs_review = case when r.has_review and l.source = 'import'
                  then r.needs_review else l.needs_review end,
                review_note = case when r.has_review and l.source = 'import'
                  then r.review_note else l.review_note end
            where l.id = v_row.id
              and (l.entry_date <> r.entry_date or l.amount <> r.amount
                   or l.description <> r.description
                   or (r.type = 'invoice' and l.payment_sent_at is null and r.paid_on is not null)
                   or (l.source = 'import' and r.has_by
                       and l.reported_by is distinct from r.reported_by)
                   or (l.source = 'import' and r.has_review
                       and (l.needs_review <> r.needs_review
                            or l.review_note is distinct from r.review_note)));
            if found then v_changed := v_changed + 1; else v_same := v_same + 1; end if;
            continue;
          end if;
          insert into public.supplier_ledger
            (tenant_id, supplier_id, type, entry_date, amount, stated_balance, reference,
             description, source, payment_sent_at, reported_by, needs_review, review_note,
             created_by)
          values (p_tenant_id, v_supplier, r.type, r.entry_date, r.amount, r.stated_balance,
                  r.reference, r.description, 'import',
                  case when r.type = 'invoice' then r.paid_on end,
                  r.reported_by, r.needs_review, r.review_note, auth.uid())
          returning id into v_id;
          v_fresh := v_fresh || v_id;
          v_new := v_new + 1;
          continue;
        end if;

        -- Anything else: an entry that says the same, one for each row.
        if v_pass = 1 then
          select l.id into v_id from public.supplier_ledger l
          where l.tenant_id = p_tenant_id and l.supplier_id = v_supplier and l.type = r.type
            and l.entry_date = r.entry_date and l.amount = r.amount
            and l.stated_balance is not distinct from r.stated_balance
            and l.reference is not distinct from r.reference and l.description = r.description
            and (not r.has_by or l.reported_by is not distinct from r.reported_by)
            and (not r.has_review
                 or (l.needs_review = r.needs_review
                     and l.review_note is not distinct from r.review_note))
            and not (l.id = any(v_taken))
          order by l.created_at, l.id limit 1;
          if v_id is not null then
            v_taken := v_taken || v_id;
            v_same := v_same + 1;
          else
            v_later := v_later || r.ord;
          end if;
          continue;
        end if;

        -- Second pass. The same entry with other marks: one from a
        -- spreadsheet is changed, any other is left as it is.
        select l.id, l.source into v_row.id, v_row.source from public.supplier_ledger l
        where l.tenant_id = p_tenant_id and l.supplier_id = v_supplier and l.type = r.type
          and l.entry_date = r.entry_date and l.amount = r.amount
          and l.stated_balance is not distinct from r.stated_balance
          and l.reference is not distinct from r.reference and l.description = r.description
          and not (l.id = any(v_taken))
        order by (l.source = 'import') desc, l.created_at, l.id limit 1;
        if found then
          v_taken := v_taken || v_row.id;
          if v_row.source = 'import' then
            update public.supplier_ledger l
            set reported_by = case when r.has_by then r.reported_by else l.reported_by end,
                needs_review = case when r.has_review then r.needs_review else l.needs_review end,
                review_note = case when r.has_review then r.review_note else l.review_note end
            where l.id = v_row.id;
            v_changed := v_changed + 1;
          else
            v_same := v_same + 1;
          end if;
          continue;
        end if;
        insert into public.supplier_ledger
          (tenant_id, supplier_id, type, entry_date, amount, stated_balance, reference,
           description, source, payment_sent_at, reported_by, needs_review, review_note,
           created_by)
        values (p_tenant_id, v_supplier, r.type, r.entry_date, r.amount, r.stated_balance,
                r.reference, r.description, 'import',
                case when r.type = 'invoice' then r.paid_on end,
                r.reported_by, r.needs_review, r.review_note, auth.uid())
        returning id into v_id;
        v_taken := v_taken || v_id;
        v_new := v_new + 1;
      end loop;
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
