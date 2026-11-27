import { amount } from "./export";

/**
 * Money → Invoices: the books' invoices, with what each is (paid, open,
 * overdue) worked out on read against the workspace's own today, and the
 * list's address (status, search, line, page) kept in the URL. Pure.
 */

export const INVOICE_VIEWS = ["all", "open", "overdue", "paid"] as const;
export type InvoiceView = (typeof INVOICE_VIEWS)[number];
export type InvoiceStatus = Exclude<InvoiceView, "all">;

export const INVOICE_VIEW_NAMES: Record<InvoiceView, string> = {
  all: "All",
  open: "Open",
  overdue: "Overdue",
  paid: "Paid",
};

export const STATUS_WORDS: Record<InvoiceStatus, string> = {
  paid: "Paid",
  open: "Open",
  overdue: "Overdue",
};

export const INVOICE_PAGE = 50;

/**
 * Paid when nothing is owed, overdue once its due day has gone by (the day
 * after it was due, in the workspace's timezone), else open. The database's
 * twin is `private.invoice_status()`.
 */
export function invoiceStatus(
  invoice: { balance_cents: number; due_date: string | null },
  today: string,
): InvoiceStatus {
  if (invoice.balance_cents <= 0) return "paid";
  if (invoice.due_date !== null && invoice.due_date < today) return "overdue";
  return "open";
}

/** How many days late an open invoice is (0 when it isn't). */
export function daysLate(dueDate: string | null, today: string): number {
  if (!dueDate || dueDate >= today) return 0;
  const day = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, m - 1, d) / 86_400_000;
  };
  return day(today) - day(dueDate);
}

export type InvoiceQuery = {
  view: InvoiceView;
  /** Words to look for in the number, customer, memo and lines. */
  q: string;
  /** A business line's id, or null for every line. */
  line: string | null;
  page: number;
};

const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : (value ?? "");

export function parseInvoiceQuery(
  params: Record<string, string | string[] | undefined>,
): InvoiceQuery {
  const view = first(params.view);
  const line = first(params.line);
  const page = Number.parseInt(first(params.page), 10);
  return {
    view: (INVOICE_VIEWS as readonly string[]).includes(view) ? (view as InvoiceView) : "all",
    q: first(params.q).trim().replace(/\s+/g, " ").slice(0, 80),
    line: /^[a-z0-9-]{1,40}$/.test(line) ? line : null,
    page: Number.isFinite(page) && page > 0 && page <= 1000 ? page : 1,
  };
}

/** The list's address with some of its query changed; a new filter starts on page 1. */
export function invoiceHref(base: string, query: InvoiceQuery, change: Partial<InvoiceQuery>) {
  const next = { ...query, page: 1, ...change };
  const params = new URLSearchParams();
  if (next.view !== "all") params.set("view", next.view);
  if (next.q) params.set("q", next.q);
  if (next.line) params.set("line", next.line);
  if (next.page > 1) params.set("page", String(next.page));
  const text = params.toString();
  return text ? `${base}?${text}` : base;
}

export type InvoiceListRow = {
  doc_number: string | null;
  customer: string | null;
  txn_date: string;
  due_date: string | null;
  total_cents: number;
  balance_cents: number;
  status: InvoiceStatus;
};

/** The list as spreadsheet rows, the heading first. */
export function invoicesTable(rows: readonly InvoiceListRow[]): (string | number | null)[][] {
  return [
    ["Number", "Customer", "Date", "Due", "Amount", "Still owed", "Status"],
    ...rows.map((row) => [
      row.doc_number ?? "",
      row.customer ?? "",
      row.txn_date,
      row.due_date ?? "",
      amount(row.total_cents),
      amount(row.balance_cents),
      STATUS_WORDS[row.status],
    ]),
  ];
}
