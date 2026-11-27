import type { SupabaseClient } from "@supabase/supabase-js";
import type { InvoiceStatus } from "@/lib/dashboard/invoices";

export { loadInvoiceList, type InvoiceRow } from "@/lib/dashboard/invoice-list";

export type InvoiceCounts = Record<InvoiceStatus, { invoices: number; owed: number }>;

export async function loadInvoiceCounts(
  supabase: SupabaseClient,
  tenantId: string,
  today: string,
): Promise<InvoiceCounts> {
  const { data, error } = await supabase.rpc("money_invoice_counts", {
    p_tenant_id: tenantId,
    p_today: today,
  });
  if (error) throw new Error(`Could not count invoices: ${error.message}`);
  const counts: InvoiceCounts = {
    open: { invoices: 0, owed: 0 },
    overdue: { invoices: 0, owed: 0 },
    paid: { invoices: 0, owed: 0 },
  };
  for (const row of (data as Record<string, unknown>[] | null) ?? []) {
    const status = row.status as InvoiceStatus;
    if (counts[status]) {
      counts[status] = { invoices: Number(row.invoices), owed: Number(row.balance_cents) };
    }
  }
  return counts;
}
