-- Who ticked "Paid" on a supplier's bill. The time of the tick was already
-- kept (`payment_sent_at`); an invoice's own page also says who pressed it,
-- and that can't be worked out from anything else that is stored.
--
-- Nothing about the balance changes: the tick is still only a note that the
-- money has been sent, and the bill stays owed until the payment itself is
-- written down.

alter table public.supplier_ledger
  -- Invoices only: the member who ticked "Paid". Empty for a tick that came
  -- in with a spreadsheet, or one made before this was kept.
  add column payment_sent_by uuid references auth.users (id) on delete set null;

-- Ticks an invoice as paid (the money has been sent), or unticks it, as
-- before. The first tick is the one remembered: ticking a bill that is
-- already ticked keeps its time and its person, and unticking clears both.
create or replace function public.mark_bill_paid(p_tenant_id uuid, p_entry_id uuid, p_paid boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_manager(p_tenant_id);
  update public.supplier_ledger l
  set payment_sent_by = case
        when not coalesce(p_paid, false) then null
        when l.payment_sent_at is null then (select auth.uid())
        else l.payment_sent_by
      end,
      payment_sent_at = case when coalesce(p_paid, false) then coalesce(l.payment_sent_at, now()) end
  where l.id = p_entry_id and l.tenant_id = p_tenant_id and l.type = 'invoice';
  if not found then
    raise exception 'Entry not found' using errcode = 'P0002';
  end if;
end;
$$;
