import type { SupabaseClient } from "@supabase/supabase-js";
import { accountsOfLine } from "@/lib/dashboard/book-revenue";
import { likePattern } from "@/lib/dashboard/inbox";
import type { InvoiceQuery, InvoiceStatus } from "@/lib/dashboard/invoices";
import type { RevenueSettings } from "@/lib/dashboard/lines";

export type InvoiceRow = {
  id: string;
  doc_number: string | null;
  customer: string | null;
  txn_date: string;
  due_date: string | null;
  total_cents: number;
  balance_cents: number;
  memo: string;
  status: InvoiceStatus;
};

/**
 * One page of the invoice list (or every row, up to `limit`, for the
 * spreadsheet), as the member: row-level security decides what is seen.
 */
export async function loadInvoiceList(
  supabase: SupabaseClient,
  tenantId: string,
  revenue: RevenueSettings,
  query: InvoiceQuery,
  today: string,
  page: { limit: number; offset: number },
): Promise<{ rows: InvoiceRow[]; total: number }> {
  const line = query.line ? accountsOfLine(revenue.books, query.line) : null;
  const { data, error } = await supabase.rpc("money_invoice_list", {
    p_tenant_id: tenantId,
    p_today: today,
    p_status: query.view,
    p_q: query.q ? likePattern(query.q) : null,
    p_account_refs: line ? line.refs : null,
    p_account_names: line ? line.names : null,
    p_limit: page.limit,
    p_offset: page.offset,
  });
  if (error) throw new Error(`Could not load invoices: ${error.message}`);
  const list = (data as Record<string, unknown>[] | null) ?? [];
  return {
    total: list.length > 0 ? Number(list[0].total_count) : 0,
    rows: list.map((row) => ({
      id: String(row.id),
      doc_number: (row.doc_number as string | null) ?? null,
      customer: (row.customer as string | null) ?? null,
      txn_date: String(row.txn_date),
      due_date: (row.due_date as string | null) ?? null,
      total_cents: Number(row.total_cents),
      balance_cents: Number(row.balance_cents),
      memo: String(row.memo ?? ""),
      status: row.status as InvoiceStatus,
    })),
  };
}

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
