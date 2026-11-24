import type { LedgerType } from "./balance";

/**
 * The Balances page's filters and its activity list (pure, unit-tested). The
 * whole state lives in the page's address, so a filtered view can be
 * bookmarked or sent to someone:
 *
 *   ?supplier=<id>&type=invoice&from=2026-11-01&to=2026-11-30&q=INV-20
 *
 * Supplier and search narrow both the due dates and the activity; type and
 * the date range are about activity only. Totals and cards are never
 * filtered: a total that quietly left something out would be a wrong number.
 */

export const ACTIVITY_TYPES = ["invoice", "payment", "statement", "credit", "charge"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  invoice: "Invoices",
  payment: "Payments",
  statement: "Statements",
  credit: "Credits",
  charge: "Extra charges",
};

export interface BalanceFilters {
  supplier: string | null;
  type: ActivityType | null;
  /** YYYY-MM-DD, inclusive. */
  from: string | null;
  to: string | null;
  /** Search words, as typed (trimmed). */
  q: string;
  /** Show every activity row, not just the latest. */
  all: boolean;
}

export const NO_FILTERS: BalanceFilters = {
  supplier: null,
  type: null,
  from: null,
  to: null,
  q: "",
  all: false,
};

/** How many activity rows show before "Show everything". */
export const RECENT_ROWS = 25;
/** The most rows a filtered list shows at once. */
export const MAX_ROWS = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function realDay(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

type Params = Record<string, string | string[] | undefined>;
const one = (params: Params, key: string) => {
  const value = params[key];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
};

/** Reads the filters out of the address. Anything that isn't a real value is dropped. */
export function parseBalanceFilters(params: Params): BalanceFilters {
  const supplier = one(params, "supplier");
  const type = one(params, "type");
  let from = realDay(one(params, "from"));
  let to = realDay(one(params, "to"));
  // The wrong way round is taken as meant: the earlier day first.
  if (from && to && from > to) [from, to] = [to, from];
  return {
    supplier: UUID.test(supplier) ? supplier.toLowerCase() : null,
    type: (ACTIVITY_TYPES as readonly string[]).includes(type) ? (type as ActivityType) : null,
    from,
    to,
    q: one(params, "q").slice(0, 80),
    all: one(params, "rows") === "all",
  };
}

/** The filters as a query string ("" when there are none), for links that keep them. */
export function balanceQuery(
  filters: BalanceFilters,
  change: Partial<BalanceFilters> = {},
): string {
  const f = { ...filters, ...change };
  const params = new URLSearchParams();
  if (f.supplier) params.set("supplier", f.supplier);
  if (f.type) params.set("type", f.type);
  if (f.from) params.set("from", f.from);
  if (f.to) params.set("to", f.to);
  if (f.q) params.set("q", f.q);
  if (f.all) params.set("rows", "all");
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Whether anything narrows the lists ("Show everything" alone doesn't). */
export function isFiltered(f: BalanceFilters): boolean {
  return Boolean(f.supplier || f.type || f.from || f.to || f.q);
}

export interface ActivityEntry {
  supplierId: string;
  supplierName: string;
  type: LedgerType;
  /** YYYY-MM-DD. */
  date: string;
  /** Signed for an adjustment: negative is a credit. */
  amount: string;
  reference: string | null;
  description: string;
  createdAt: string;
}

/** Which kind of activity a ledger entry is: an adjustment is a credit or an extra charge. */
export function activityType(entry: { type: LedgerType; amount: string }): ActivityType {
  if (entry.type === "INVOICE") return "invoice";
  if (entry.type === "PAYMENT") return "payment";
  if (entry.type === "STATEMENT") return "statement";
  return entry.amount.trim().startsWith("-") ? "credit" : "charge";
}

/** Capitals, spaces and punctuation aside: "inv 2041" finds "INV-2041". */
const plain = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Whether a search finds a row: every word typed has to be in its number, note or supplier. */
export function matchesSearch(
  q: string,
  row: { reference: string | null; description?: string; supplierName?: string },
): boolean {
  const words = q.split(/\s+/).map(plain).filter(Boolean);
  if (words.length === 0) return true;
  const hay = plain(`${row.reference ?? ""} ${row.description ?? ""} ${row.supplierName ?? ""}`);
  const whole = plain(q);
  return hay.includes(whole) || words.every((word) => hay.includes(word));
}

/** Every entry the filters let through, newest first. */
export function filterActivity<T extends ActivityEntry>(rows: T[], f: BalanceFilters): T[] {
  return rows
    .filter(
      (row) =>
        (!f.supplier || row.supplierId === f.supplier) &&
        (!f.type || activityType(row) === f.type) &&
        (!f.from || row.date >= f.from) &&
        (!f.to || row.date <= f.to) &&
        matchesSearch(f.q, row),
    )
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

/** The rows to show, and how many were left off the end. */
export function activityPage<T>(rows: T[], f: BalanceFilters): { shown: T[]; more: number } {
  const limit = f.all || isFiltered(f) ? MAX_ROWS : RECENT_ROWS;
  return { shown: rows.slice(0, limit), more: Math.max(0, rows.length - limit) };
}

/** Open bills narrowed by supplier and search (type and dates are about activity). */
export function filterBills<
  T extends { supplierId?: string; vendor: string; reference: string | null },
>(bills: T[], f: BalanceFilters): T[] {
  return bills.filter(
    (bill) =>
      (!f.supplier || bill.supplierId === f.supplier) &&
      matchesSearch(f.q, { reference: bill.reference, supplierName: bill.vendor }),
  );
}

export type EntrySource = "manual" | "import" | "books" | "email" | "upload";

/** Where an entry came from, in the words the Source column uses. */
export function sourceLabel(source: EntrySource): string {
  switch (source) {
    case "books":
      return "Your books";
    case "import":
      return "Spreadsheet";
    case "email":
      return "From email";
    case "upload":
      return "Uploaded file";
    default:
      return "Typed in";
  }
}
