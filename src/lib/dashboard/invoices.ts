import { z } from "zod";
import type { InvoicePlace } from "./book-revenue";
import { splitSchema } from "./expenses";
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
  /** A business line's id (invoices any of which count in it), or null for every line. */
  line: string | null;
  /** Only invoices some of which isn't in a line yet ("Not sorted yet"). */
  waiting: boolean;
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
  const waiting = first(params.waiting) === "1";
  return {
    view: (INVOICE_VIEWS as readonly string[]).includes(view) ? (view as InvoiceView) : "all",
    q: first(params.q).trim().replace(/\s+/g, " ").slice(0, 80),
    // "Not sorted yet" and one line are two ways of choosing by line: one at a time.
    line: !waiting && /^[a-z0-9-]{1,40}$/.test(line) ? line : null,
    waiting,
    page: Number.isFinite(page) && page > 0 && page <= 1000 ? page : 1,
  };
}

/** The list's address with some of its query changed; a new filter starts on page 1. */
export function invoiceHref(base: string, query: InvoiceQuery, change: Partial<InvoiceQuery>) {
  const next = { ...query, page: 1, ...change };
  if (change.line) next.waiting = false;
  if (change.waiting) next.line = null;
  const params = new URLSearchParams();
  if (next.view !== "all") params.set("view", next.view);
  if (next.q) params.set("q", next.q);
  if (next.waiting) params.set("waiting", "1");
  else if (next.line) params.set("line", next.line);
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
  /** Where it counts and why, in words (`placeWords`). */
  place?: PlaceWords;
};

/** The list as spreadsheet rows, the heading first. */
export function invoicesTable(rows: readonly InvoiceListRow[]): (string | number | null)[][] {
  return [
    ["Number", "Customer", "Date", "Due", "Amount", "Still owed", "Status", "Line", "Decided by"],
    ...rows.map((row) => [
      row.doc_number ?? "",
      row.customer ?? "",
      row.txn_date,
      row.due_date ?? "",
      amount(row.total_cents),
      amount(row.balance_cents),
      STATUS_WORDS[row.status],
      row.place?.line ?? "",
      row.place?.why ?? "",
    ]),
  ];
}

/** Where an invoice counts, in words, and how sure that is. */
export type PlaceWords = {
  /** "Classes", "60% Classes, 40% Shop", "Already counted by your shop", "Not sorted yet"… */
  line: string;
  /** "Your choice", "Your choice for this customer", "From its income account"… */
  why: string;
  state: "sorted" | "waiting" | "left_out";
};

/** An invoice's place (`placeInvoice`) in the list's words. */
export function placeWords(place: InvoicePlace, lineName: (id: string) => string): PlaceWords {
  const choice = place.choice;
  if (place.by !== "account" && choice) {
    const why = place.by === "person" ? "Your choice" : "Your choice for this customer";
    if ("line" in choice) return { line: lineName(choice.line), why, state: "sorted" };
    if ("split" in choice) {
      return {
        line: Object.entries(choice.split)
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
          .map(([id, pct]) => `${pct}% ${lineName(id)}`)
          .join(", "),
        why,
        state: "sorted",
      };
    }
    return {
      line: choice.skip === "shop" ? "Already counted by your shop" : "Left out",
      why,
      state: "left_out",
    };
  }
  const names = [...place.byLine.keys()].map(lineName);
  const leftOut = place.shop !== 0 || place.other !== 0;
  if (place.waitingLines > 0) {
    return names.length === 0 && !leftOut
      ? { line: "Not sorted yet", why: "Its income account has no line yet", state: "waiting" }
      : {
          line: `${names.length ? names.join(", ") : "Partly left out"}; the rest not sorted yet`,
          why: "From its income accounts, one with no line yet",
          state: "waiting",
        };
  }
  if (names.length === 0) {
    return leftOut
      ? {
          line: place.shop !== 0 ? "Already counted by your shop" : "Left out",
          why: "From its income account",
          state: "left_out",
        }
      : { line: "Nothing to count", why: "It has no lines", state: "sorted" };
  }
  return {
    line: `${names.join(", ")}${leftOut ? " (part left out)" : ""}`,
    why: names.length > 1 || leftOut ? "From its income accounts" : "From its income account",
    state: "sorted",
  };
}

// ---------------------------------------------------------------------------
// A person's choice for some invoices
// ---------------------------------------------------------------------------

const lineId = z.string().regex(/^[a-z0-9-]{1,40}$/);

/**
 * What a person can choose for one or more invoices: a line, a split across
 * lines (whole percents adding up to 100), "the shop already counted this",
 * left out, or `none`: back to its customer's default, else its income
 * account's choice. Stored by `sort_book_invoices`.
 */
export const invoiceSortSchema = z.discriminatedUnion("sort", [
  z.object({ sort: z.literal("line"), line: lineId }).strict(),
  z.object({ sort: z.literal("split"), split: splitSchema }).strict(),
  z.object({ sort: z.literal("shop") }).strict(),
  z.object({ sort: z.literal("left_out") }).strict(),
  z.object({ sort: z.literal("none") }).strict(),
]);
export type InvoiceSortChoice = z.infer<typeof invoiceSortSchema>;

/** The checked function's arguments for a choice. */
export function invoiceSortArgs(choice: InvoiceSortChoice): {
  p_sort: string;
  p_line: string | null;
  p_split: Record<string, number> | null;
} {
  return {
    p_sort: choice.sort,
    p_line: choice.sort === "line" ? choice.line : null,
    p_split: choice.sort === "split" ? choice.split : null,
  };
}

/** A choice in words, with the workspace's line names. */
export function invoiceSortWords(choice: InvoiceSortChoice, lineName: (id: string) => string) {
  switch (choice.sort) {
    case "line":
      return lineName(choice.line);
    case "split":
      return Object.entries(choice.split)
        .map(([id, pct]) => `${pct}% ${lineName(id)}`)
        .join(", ");
    case "shop":
      return "Already counted by your shop";
    case "left_out":
      return "Left out";
    case "none":
      return "Its customer's or income account's choice";
  }
}

/** The stored choice of an invoice (`book_invoices.sort` and friends), or null for none. */
export function storedInvoiceSort(row: {
  sort: unknown;
  line_id?: unknown;
  split?: unknown;
}): InvoiceSortChoice | null {
  const parsed = invoiceSortSchema.safeParse(
    row.sort === "line"
      ? { sort: "line", line: row.line_id }
      : row.sort === "split"
        ? { sort: "split", split: row.split }
        : { sort: row.sort },
  );
  return parsed.success && parsed.data.sort !== "none" ? parsed.data : null;
}
