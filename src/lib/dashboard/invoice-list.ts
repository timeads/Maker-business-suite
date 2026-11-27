import type { SupabaseClient } from "@supabase/supabase-js";
import { accountsOfLine, invoiceSorting, placeInvoice } from "./book-revenue";
import { invoiceLineExplained } from "./explain";
import { likePattern } from "./inbox";
import { placeWords, type InvoiceQuery, type InvoiceStatus, type PlaceWords } from "./invoices";
import type { RevenueSettings } from "./lines";

export type InvoiceLine = { account_ref: string | null; account: string | null; cents: number };

export type InvoiceRow = {
  id: string;
  doc_number: string | null;
  customer_ref: string | null;
  customer: string | null;
  txn_date: string;
  due_date: string | null;
  total_cents: number;
  balance_cents: number;
  memo: string;
  status: InvoiceStatus;
  /** The person's own choice, as stored (null: none). */
  sort: string | null;
  line_id: string | null;
  split: Record<string, number> | null;
  /** Where it counts and why, worked out by the one rule (`placeInvoice`). */
  place: PlaceWords;
  /** Who decided: the person, the customer's default or the income accounts. */
  by: "person" | "customer" | "account";
  /** "Why?", in a few plain sentences. */
  why: string[];
};

const linesOf = (value: unknown): InvoiceLine[] =>
  (Array.isArray(value) ? (value as Record<string, unknown>[]) : []).map((l) => ({
    account_ref: (l?.account_ref as string | null) ?? null,
    account: (l?.account as string | null) ?? null,
    cents: Number(l?.cents ?? 0) || 0,
  }));

/**
 * One page of the invoice list (or every row, up to `limit`, for the
 * spreadsheet), as the member: row-level security decides what is seen.
 * Each row says where it counts and why. A database from before invoices
 * were sorted one by one answers the earlier list (a line's filter by its
 * accounts, no "not sorted yet").
 */
export async function loadInvoiceList(
  supabase: SupabaseClient,
  tenantId: string,
  revenue: RevenueSettings,
  query: InvoiceQuery,
  today: string,
  page: { limit: number; offset: number },
): Promise<{ rows: InvoiceRow[]; total: number }> {
  const common = {
    p_tenant_id: tenantId,
    p_today: today,
    p_status: query.view,
    p_q: query.q ? likePattern(query.q) : null,
    p_limit: page.limit,
    p_offset: page.offset,
  };
  let { data, error } = await supabase.rpc("money_invoice_sorted_list", {
    ...common,
    p_sorting: invoiceSorting(revenue),
    p_line: query.line,
    p_waiting: query.waiting,
  });
  if (error?.code === "PGRST202") {
    const line = query.line ? accountsOfLine(revenue.books, query.line) : null;
    ({ data, error } = await supabase.rpc("money_invoice_list", {
      ...common,
      p_account_refs: line ? line.refs : null,
      p_account_names: line ? line.names : null,
    }));
  }
  if (error) throw new Error(`Could not load invoices: ${error.message}`);
  const list = (data as Record<string, unknown>[] | null) ?? [];
  const lineName = (id: string) =>
    revenue.lines.find((l) => l.id === id)?.name ?? "a line since removed";
  return {
    total: list.length > 0 ? Number(list[0].total_count) : 0,
    rows: list.map((row) => {
      const facts = {
        sort: (row.sort as string | null) ?? null,
        line_id: (row.line_id as string | null) ?? null,
        split: (row.split as Record<string, number> | null) ?? null,
        customer_ref: (row.customer_ref as string | null) ?? null,
        customer: (row.customer as string | null) ?? null,
      };
      const place = placeInvoice(revenue, { ...facts, lines: linesOf(row.lines) });
      const words = placeWords(place, lineName);
      return {
        id: String(row.id),
        doc_number: (row.doc_number as string | null) ?? null,
        customer_ref: facts.customer_ref,
        customer: facts.customer,
        txn_date: String(row.txn_date),
        due_date: (row.due_date as string | null) ?? null,
        total_cents: Number(row.total_cents),
        balance_cents: Number(row.balance_cents),
        memo: String(row.memo ?? ""),
        status: row.status as InvoiceStatus,
        sort: facts.sort,
        line_id: facts.line_id,
        split: facts.split,
        place: words,
        by: place.by,
        why: invoiceLineExplained({
          by: place.by,
          state: words.state,
          split: place.choice !== null && "split" in place.choice,
          shop:
            place.shop !== 0 ||
            (place.choice !== null && "skip" in place.choice && place.choice.skip === "shop"),
          customer: facts.customer,
          paid: Number(row.balance_cents) <= 0,
          counting: revenue.books.invoices,
        }),
      };
    }),
  };
}
