import { Money } from "../balance/money";
import { fromCents } from "../po/totals";
import { tidyReference } from "../po/reference";
import { parseCsv, type CsvRow } from "./csv";

/**
 * The spreadsheets a business brings its stock records across in. Pure: each
 * reader takes the file's text (and, where rows name items, the workspace's
 * items) and gives back what would be imported and what was left out, line by
 * line and in plain words. Nothing here touches the database; what "new" and
 * "changed" come to is worked out there, by the same functions that do the
 * import (see the `import_*` functions).
 *
 * Column names and what each file means follow TuftStock's docs/06-migration
 * and its three CSV readers (src/lib/import), widened to the rest of what
 * TuftStock holds. docs/stock-import.md is the guide for people.
 */

export const IMPORT_KINDS = [
  "suppliers",
  "items",
  "orders",
  "ledger",
  "counts",
  "deliveries",
] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];
export const isImportKind = (value: string): value is ImportKind =>
  (IMPORT_KINDS as readonly string[]).includes(value);

/** A file bigger than this isn't read. */
export const MAX_IMPORT_BYTES = 4_000_000;
/** Rows a file may hold. Daily counts are one row per item per day, so they get more room. */
export const MAX_IMPORT_ROWS: Record<ImportKind, number> = {
  suppliers: 2_000,
  items: 10_000,
  orders: 10_000,
  ledger: 10_000,
  counts: 20_000,
  deliveries: 10_000,
};
/** The longest look-back any stock sum uses, with a little spare (as the daily counts are kept). */
export const COUNT_DAYS_KEPT = 200;

export type Problem = { line: number; reason: string };
export type ItemRef = {
  id: string;
  sku: string | null;
  title: string;
  variant_title: string | null;
};

export type ImportRead =
  | {
      ok: true;
      kind: ImportKind;
      /** What goes to the database, already matched and tidied. */
      payload: Record<string, unknown>[];
      /** Rows the file held, not counting the heading. */
      read: number;
      /** Rows left out, each with why. */
      problems: Problem[];
      /** Things worth knowing that aren't about one line. */
      notes: string[];
    }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

/** Other names a column may go by, mostly TuftStock's own and the Monocle export it grew from. */
const ALIASES: Record<ImportKind, Record<string, string[]>> = {
  suppliers: {
    name: ["supplier", "supplier_name"],
    emails: ["contact_email", "contact_emails", "email"],
    moq: ["minimum_order", "smallest_order"],
    lead_time_days: ["lead_time", "lead_days"],
    coverage_days: ["cover_days", "cover"],
    payment_terms_days: ["payment_terms", "terms_days"],
  },
  items: {
    product: ["title", "product_title", "item"],
    option: ["variant", "variant_title", "option_label"],
    supplier: ["primary_supplier", "supplier_name"],
    supplier_sku: ["supplier_code", "suppliers_code"],
    own_cost: ["cost", "avg_cost_override", "unit_cost"],
    lead_time_days: ["lead_time_override", "lead_time_override_days", "lead_days"],
    coverage_days: ["coverage_days_target", "cover_days", "cover"],
    safety_stock: ["safety_stock_units", "spare"],
    moq: ["minimum_order", "smallest_order"],
    case_pack: ["case_pack_size", "case_size"],
    hidden: [],
    dont_reorder: [],
  },
  orders: {
    reference: ["po_number", "po_reference"],
    created_at: ["created"],
    sent_at: ["date_placed", "ordered_at"],
    expected_at: ["expected_delivery_date", "expected_on", "expected"],
    product: ["title", "product_title", "item"],
    option: ["variant", "variant_title"],
    qty_ordered: ["confirmed_qty", "ordered_qty", "quantity"],
    qty_received: ["received_qty"],
    unit_cost: ["confirmed_cost", "unit_price", "cost"],
    supplier_sku: ["supplier_code"],
    line_note: ["note"],
  },
  ledger: {
    supplier: ["vendor", "supplier_name"],
    entry_date: ["date"],
    stated_balance: ["balance"],
    reference: ["invoice", "invoice_number", "number"],
    paid_on: ["payment_sent_at", "paid"],
  },
  counts: {
    product: ["title", "product_title", "item"],
    option: ["variant", "variant_title"],
    date: ["day"],
    on_hand: ["stock_on_hand", "count", "stock"],
  },
  deliveries: {
    reference: ["po_number", "po_reference"],
    product: ["title", "product_title", "item"],
    option: ["variant", "variant_title"],
    received_at: ["received_on", "date"],
    quantity: ["qty", "units"],
  },
};

/** The columns a file can't do without. `item` means a SKU, or a product name. */
const REQUIRED: Record<ImportKind, string[]> = {
  suppliers: ["name"],
  items: ["item"],
  orders: ["reference", "supplier", "item", "qty_ordered"],
  ledger: ["supplier", "type", "entry_date"],
  counts: ["item", "date", "on_hand"],
  deliveries: ["reference", "item", "received_at", "quantity"],
};

const FILE_WORDS: Record<ImportKind, string> = {
  suppliers: "suppliers",
  items: "item planning",
  orders: "purchase orders",
  ledger: "supplier ledger",
  counts: "daily counts",
  deliveries: "past deliveries",
};

type Row = { line: number; has: (column: string) => boolean; get: (column: string) => string };

function open(
  kind: ImportKind,
  text: string,
): { ok: true; rows: Row[]; has: (column: string) => boolean } | { ok: false; error: string } {
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) {
    return {
      ok: false,
      error: `That file is bigger than ${MAX_IMPORT_BYTES / 1_000_000} MB. Split it into smaller files and bring them in one at a time.`,
    };
  }
  const file = parseCsv(text);
  if (!file.ok) return file;
  if (file.rows.length === 0) {
    return { ok: false, error: "That file has headings but no rows under them." };
  }
  if (file.rows.length > MAX_IMPORT_ROWS[kind]) {
    return {
      ok: false,
      error: `That file has ${file.rows.length.toLocaleString("en-US")} rows; the most we take at once for ${FILE_WORDS[kind]} is ${MAX_IMPORT_ROWS[kind].toLocaleString("en-US")}. Split it and bring the parts in one at a time.`,
    };
  }
  const present = new Set(file.headers);
  // Which heading in the file stands for each of our columns.
  const source = (column: string): string | null =>
    [column, ...(ALIASES[kind][column] ?? [])].find((name) => present.has(name)) ?? null;
  const has = (column: string) => source(column) !== null;
  const missing = REQUIRED[kind].filter((column) =>
    column === "item" ? !has("sku") && !has("product") : !has(column),
  );
  if (missing.length > 0) {
    const names = missing.map((column) =>
      column === "item" ? "“sku” (or “product”)" : `“${column}”`,
    );
    return {
      ok: false,
      error: `A ${FILE_WORDS[kind]} file needs ${names.length === 1 ? "a column called" : "columns called"} ${names.join(" and ")}. This file's columns are: ${file.headers.join(", ")}.`,
    };
  }
  const rows = file.rows.map((row: CsvRow) => ({
    line: row.line,
    has,
    get: (column: string) => {
      const from = source(column);
      return from ? (row.cells[from] ?? "") : "";
    },
  }));
  return { ok: true, rows, has };
}

// ---------------------------------------------------------------------------
// Reading one cell
// ---------------------------------------------------------------------------

/** Thrown for a cell we can't use; the message is the reason shown beside the line. */
class Unusable extends Error {}
const bad = (reason: string): never => {
  throw new Unusable(reason);
};

/** A whole number in a range, or null for an empty cell. */
function whole(row: Row, column: string, min: number, max: number, what: string): number | null {
  const typed = row.get(column).replace(/,/g, "");
  if (typed === "") return null;
  if (!/^-?\d{1,9}$/.test(typed)) {
    return bad(`“${row.get(column)}” isn't a whole number (${what})`);
  }
  const value = Number(typed);
  if (value < min || value > max) {
    return bad(
      `${what} should be between ${min.toLocaleString("en-US")} and ${max.toLocaleString("en-US")}, not ${value.toLocaleString("en-US")}`,
    );
  }
  return value;
}

/** An amount of money as "12.50", or null for an empty cell. Reads "$1,200.00" too. */
function money(row: Row, column: string, what: string, signed = false): string | null {
  const typed = row.get(column).replace(/[$,\s]/g, "");
  if (typed === "") return null;
  if (!/^-?\d{0,9}(\.\d{1,6})?$/.test(typed) || !/\d/.test(typed)) {
    return bad(`“${row.get(column)}” isn't an amount of money (${what})`);
  }
  const amount = new Money(typed);
  if (amount.isNegative() && !signed) return bad(`${what} can't be less than zero`);
  return amount.toFixed(2);
}

// "t" and "f" are how a database writes yes and no into a CSV.
const YES = new Set(["true", "t", "yes", "y", "1", "x"]);
const NO = new Set(["false", "f", "no", "n", "0", ""]);
function yesNo(row: Row, column: string): boolean {
  const typed = row.get(column).toLowerCase();
  if (YES.has(typed)) return true;
  if (NO.has(typed)) return false;
  return bad(`“${row.get(column)}” should be yes or no (${column})`);
}

const isDay = (year: number, month: number, day: number) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    year >= 2000 &&
    year <= 2100 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A date or a moment. "2026-03-04", "3/4/2026" (month first) and
 * "2026-03-04T15:20:00Z" are all read. Gives the calendar day and, when the
 * cell carried a time, the moment; a plain day stands for noon UTC, which is
 * the same calendar day almost everywhere.
 */
export function readWhen(typed: string): { day: string; at: string } | null {
  const text = typed.trim();
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (match) {
    const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (!isDay(y, m, d)) return null;
    const day = `${y}-${pad(m)}-${pad(d)}`;
    return { day, at: `${day}T12:00:00.000Z` };
  }
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (match) {
    const [m, d, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (!isDay(y, m, d)) return null;
    const day = `${y}-${pad(m)}-${pad(d)}`;
    return { day, at: `${day}T12:00:00.000Z` };
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)) {
    const spaced = text.replace(" ", "T");
    // A time with no zone is read as UTC, as a database would write it.
    const date = new Date(/(Z|[+-]\d{2}:?\d{2})$/i.test(spaced) ? spaced : `${spaced}Z`);
    if (Number.isNaN(date.getTime())) return null;
    const year = date.getUTCFullYear();
    if (year < 2000 || year > 2100) return null;
    return { day: date.toISOString().slice(0, 10), at: date.toISOString() };
  }
  return null;
}

function when(row: Row, column: string, what: string): { day: string; at: string } | null {
  const typed = row.get(column);
  if (typed === "") return null;
  return (
    readWhen(typed) ??
    bad(`“${typed}” isn't a date we can read (${what}). Write it like 2026-03-04`)
  );
}

const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
/** "a@x.example; B <b@x.example>" → the addresses, lower case, each once. */
function emails(row: Row, column: string): string[] {
  const out: string[] = [];
  for (const part of row.get(column).split(/[,;\s]+/)) {
    const address = part.replace(/^<|>$/g, "").trim().toLowerCase();
    if (!address) continue;
    // A name before an address in pointed brackets is dropped with the split above.
    if (!address.includes("@")) continue;
    if (!EMAIL.test(address) || address.length > 200) {
      bad(`“${part}” isn't an email address`);
    }
    if (!out.includes(address)) out.push(address);
  }
  if (out.length > 6) bad("A supplier can have six email addresses at most");
  return out;
}

const short = (value: string, max: number) => value.slice(0, max);

/** Runs `read` for every row; a row it throws on is left out with the reason. */
function eachRow<T>(rows: Row[], problems: Problem[], read: (row: Row) => T | null): T[] {
  const out: T[] = [];
  for (const row of rows) {
    try {
      const value = read(row);
      if (value !== null) out.push(value);
    } catch (err) {
      if (!(err instanceof Unusable)) throw err;
      problems.push({ line: row.line, reason: err.message });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Finding the item a row is about
// ---------------------------------------------------------------------------

const fold = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();

/** By SKU, else by product and option: the same order sales are matched in. */
export function itemFinder(items: ItemRef[]) {
  const bySku = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, id: string) => {
    const list = map.get(key);
    if (list) list.push(id);
    else map.set(key, [id]);
  };
  for (const item of items) {
    if (fold(item.sku)) add(bySku, fold(item.sku), item.id);
    add(byName, `${fold(item.title)}\n${fold(item.variant_title)}`, item.id);
  }
  /** The item's id, or the reason there isn't one. */
  return (sku: string, product: string, option: string): { id: string } | { why: string } => {
    let shared = 0;
    if (sku) {
      const found = bySku.get(fold(sku));
      if (found?.length === 1) return { id: found[0] };
      shared = found?.length ?? 0;
    }
    // "Default Title" is what a shop calls the option of a product that has none.
    const plain = fold(option) === "default title" ? "" : option;
    if (product) {
      const found = byName.get(`${fold(product)}\n${fold(plain)}`);
      if (found?.length === 1) return { id: found[0] };
      if (found && found.length > 1 && shared === 0) {
        return {
          why: `${found.length} items in your shop are called “${product}${plain ? ` — ${plain}` : ""}”, so we can't tell which one this is`,
        };
      }
    }
    if (shared > 1) {
      return {
        why: `${shared} items in your shop share the SKU “${sku}”, so we can't tell which one this is`,
      };
    }
    if (sku) return { why: `No item in your shop has the SKU “${sku}”` };
    if (product) {
      return { why: `No item in your shop is called “${product}${plain ? ` — ${plain}` : ""}”` };
    }
    return { why: "This row has no SKU and no product name to find the item by" };
  };
}

// ---------------------------------------------------------------------------
// 1. Suppliers
// ---------------------------------------------------------------------------

function readSuppliers(rows: Row[], has: (c: string) => boolean) {
  const problems: Problem[] = [];
  const seen = new Map<string, number>();
  const payload = eachRow(rows, problems, (row) => {
    const name = row.get("name");
    if (!name) return bad("This row has no supplier name");
    if (name.length > 120) return bad("A supplier's name can be 120 characters at most");
    const first = seen.get(fold(name));
    if (first) return bad(`“${name}” is already on line ${first}; this second row was left out`);

    const out: Record<string, unknown> = { name };
    if (has("contact_name")) out.contact_name = short(row.get("contact_name"), 120);
    if (has("emails")) out.emails = emails(row, "emails");
    const lead = whole(row, "lead_time_days", 0, 365, "lead time in days");
    if (lead !== null) out.lead_time_days = lead;
    const cover = whole(row, "coverage_days", 1, 365, "days of cover");
    if (cover !== null) out.coverage_days = cover;
    const moq = whole(row, "moq", 1, 1_000_000, "smallest order");
    if (moq !== null) out.moq = moq;
    const applies = row.get("moq_applies_to").toLowerCase();
    if (applies) {
      if (applies !== "order" && applies !== "sku") {
        return bad(`“${row.get("moq_applies_to")}” should be ORDER or SKU (moq_applies_to)`);
      }
      out.moq_applies_to = applies;
    }
    const terms = whole(row, "payment_terms_days", 0, 365, "payment terms in days");
    if (terms !== null) out.payment_terms_days = terms;
    if (has("notes")) out.notes = short(row.get("notes"), 2000);
    // An empty cell leaves the supplier as it is, in use or not.
    if (row.get("archived") !== "") out.archived = yesNo(row, "archived");
    seen.set(fold(name), row.line);
    return out;
  });
  return { payload, problems, notes: [] as string[] };
}

// ---------------------------------------------------------------------------
// 2. Planning figures for items
// ---------------------------------------------------------------------------

function readItems(rows: Row[], has: (c: string) => boolean, items: ItemRef[]) {
  const problems: Problem[] = [];
  const find = itemFinder(items);
  const seen = new Map<string, number>();
  const payload = eachRow(rows, problems, (row) => {
    const match = find(row.get("sku"), row.get("product"), row.get("option"));
    if ("why" in match) return bad(match.why);
    const first = seen.get(match.id);
    if (first) return bad(`This item is already on line ${first}; this second row was left out`);

    const out: Record<string, unknown> = { stock_item_id: match.id };
    // A supplier left blank leaves the item with whoever it has now.
    if (row.get("supplier")) {
      if (row.get("supplier").length > 120)
        return bad("A supplier's name can be 120 characters at most");
      out.supplier = row.get("supplier");
    }
    // For the rest, a column in the file is applied to every row: an empty
    // cell clears the figure (back to the supplier's own, or to none).
    if (has("supplier_sku")) out.supplier_sku = short(row.get("supplier_sku"), 120) || null;
    if (has("own_cost")) out.own_cost = money(row, "own_cost", "your own cost");
    if (has("lead_time_days"))
      out.lead_time_days = whole(row, "lead_time_days", 0, 365, "lead time in days");
    if (has("coverage_days"))
      out.coverage_days = whole(row, "coverage_days", 1, 365, "days of cover");
    if (has("safety_stock"))
      out.safety_stock = whole(row, "safety_stock", 0, 1_000_000, "spare stock") ?? 0;
    if (has("moq")) out.moq = whole(row, "moq", 1, 1_000_000, "smallest order");
    if (has("case_pack")) out.case_pack = whole(row, "case_pack", 1, 100_000, "case size");
    // TuftStock keeps "don't reorder" and "hidden" apart; here they are one switch.
    if (has("hidden") || has("dont_reorder")) {
      out.hidden =
        (has("hidden") && yesNo(row, "hidden")) ||
        (has("dont_reorder") && yesNo(row, "dont_reorder"));
    }
    seen.set(match.id, row.line);
    return out;
  });
  return { payload, problems, notes: [] as string[] };
}

// ---------------------------------------------------------------------------
// 3. Purchase orders
// ---------------------------------------------------------------------------

const ORDER_STATUSES = ["draft", "ordered", "partial", "closed", "cancelled", "archived"] as const;

/**
 * Where an order stands when the file doesn't say (ported from TuftStock's
 * purchase-orders-csv.ts): never sent → draft; sent, nothing in → ordered;
 * some in → part received; all in → closed.
 */
export function inferStatus(ordered: number, received: number, sent: boolean): string {
  if (!sent && received === 0) return "draft";
  if (ordered > 0 && received >= ordered) return "closed";
  if (received > 0) return "partial";
  return sent ? "ordered" : "draft";
}

/** "Pallet fee=25.00; Discount=-10" → [{label, amount}], as an order keeps them. */
function readAdjustments(row: Row): { label: string; amount: string }[] {
  const out: { label: string; amount: string }[] = [];
  for (const part of row.get("adjustments").split(";")) {
    if (!part.trim()) continue;
    const at = part.lastIndexOf("=");
    const label = at < 0 ? "" : part.slice(0, at).trim();
    const typed = at < 0 ? "" : part.slice(at + 1).replace(/[$,\s]/g, "");
    if (!label || !/^-?\d{0,9}(\.\d{1,6})?$/.test(typed) || !/\d/.test(typed)) {
      bad(
        `“${part.trim()}” isn't an adjustment we can read. Write each as Label=12.50, with ; between them`,
      );
    }
    const amount = new Money(typed);
    if (!amount.isZero()) out.push({ label: short(label, 80), amount: amount.toFixed(2) });
  }
  return out;
}

type OrderLine = {
  stock_item_id: string;
  qty_ordered: number;
  qty_received: number;
  unit_cost: string;
  supplier_sku: string;
  note: string;
};

function readOrders(rows: Row[], items: ItemRef[]) {
  const problems: Problem[] = [];
  const notes: string[] = [];
  const find = itemFinder(items);
  type Group = { key: string; reference: string; rows: Row[] };
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const reference = tidyReference(row.get("reference"));
    if (!reference) {
      problems.push({
        line: row.line,
        reason: row.get("reference")
          ? `“${row.get("reference")}” can't be used as an order's reference (3 to 40 characters)`
          : "This row has no order reference, so we can't tell which order it belongs to",
      });
      continue;
    }
    const key = reference.toUpperCase();
    const group = groups.get(key);
    if (group) group.rows.push(row);
    else groups.set(key, { key, reference, rows: [row] });
  }

  const payload: Record<string, unknown>[] = [];
  let folded = 0;
  for (const group of groups.values()) {
    const head = group.rows[0];
    // What is said once for the whole order comes from the first row that says it.
    const firstWith = (column: string) => group.rows.find((row) => row.get(column) !== "") ?? head;
    try {
      const supplier = firstWith("supplier").get("supplier");
      if (!supplier) bad(`Order ${group.reference} doesn't name a supplier, so it was left out`);
      if (supplier.length > 120) bad("A supplier's name can be 120 characters at most");
      const other = group.rows.find(
        (row) => row.get("supplier") && fold(row.get("supplier")) !== fold(supplier),
      );
      if (other) {
        bad(
          `Order ${group.reference} names two suppliers (“${supplier}” and “${other.get("supplier")}” on line ${other.line}), so it was left out`,
        );
      }
      const created = when(firstWith("created_at"), "created_at", "created_at");
      const sent = when(firstWith("sent_at"), "sent_at", "sent_at");
      const expected = when(firstWith("expected_at"), "expected_at", "expected_at");
      const closed = when(firstWith("closed_at"), "closed_at", "closed_at");
      const shipping =
        money(firstWith("shipping_cost"), "shipping_cost", "shipping cost") ?? "0.00";
      const taxRow = firstWith("tax_rate_pct");
      const taxTyped = taxRow.get("tax_rate_pct").replace(/[%\s]/g, "");
      if (taxTyped !== "" && (!/^\d{1,3}(\.\d{1,3})?$/.test(taxTyped) || Number(taxTyped) > 100)) {
        bad(`“${taxRow.get("tax_rate_pct")}” isn't a tax rate between 0 and 100 (tax_rate_pct)`);
      }
      const adjustments = readAdjustments(firstWith("adjustments"));
      const typedStatus = firstWith("status").get("status").toLowerCase();
      if (typedStatus && !(ORDER_STATUSES as readonly string[]).includes(typedStatus)) {
        bad(
          `“${firstWith("status").get("status")}” isn't a status we know. Use DRAFT, ORDERED, PARTIAL, CLOSED or ARCHIVED, or leave it empty`,
        );
      }

      // The lines. A row we can't read is left out by itself; the order still comes.
      const byItem = new Map<string, OrderLine & { cents: number }>();
      let lostCents = 0;
      let lostLines = 0;
      for (const row of group.rows) {
        try {
          const ordered = whole(row, "qty_ordered", 0, 1_000_000, "quantity ordered") ?? 0;
          const received = whole(row, "qty_received", 0, 1_000_000, "quantity received") ?? 0;
          const cost = money(row, "unit_cost", "cost each") ?? "0.00";
          if (ordered === 0 && received === 0) continue;
          const value = new Money(cost).cents * ordered;
          const match = find(row.get("sku"), row.get("product"), row.get("option"));
          if ("why" in match) {
            lostCents += value;
            lostLines += 1;
            problems.push({
              line: row.line,
              reason: `${match.why}. Its cost stays on order ${group.reference} as one amount, so the order's total is still right`,
            });
            continue;
          }
          const line = byItem.get(match.id);
          if (line) {
            // The same item twice on one order becomes one line at its average cost.
            line.cents += new Money(cost).cents * ordered;
            line.qty_ordered += ordered;
            line.qty_received += received;
            line.unit_cost =
              line.qty_ordered > 0
                ? fromCents(Math.round(line.cents / line.qty_ordered)).toFixed(2)
                : line.unit_cost;
          } else {
            byItem.set(match.id, {
              stock_item_id: match.id,
              qty_ordered: ordered,
              qty_received: received,
              unit_cost: cost,
              supplier_sku: short(row.get("supplier_sku"), 120),
              note: short(row.get("line_note"), 500),
              cents: new Money(cost).cents * ordered,
            });
          }
        } catch (err) {
          if (!(err instanceof Unusable)) throw err;
          problems.push({ line: row.line, reason: err.message });
        }
      }
      const lines: OrderLine[] = [...byItem.values()].map((line) => ({
        stock_item_id: line.stock_item_id,
        qty_ordered: line.qty_ordered,
        qty_received: line.qty_received,
        unit_cost: line.unit_cost,
        supplier_sku: line.supplier_sku,
        note: line.note,
      }));
      if (lines.length === 0 && lostLines === 0) {
        bad(`Order ${group.reference} has nothing on it that we could read, so it was left out`);
      }
      if (lostCents > 0) {
        adjustments.push({
          label: `Items no longer in your shop (${lostLines} line${lostLines === 1 ? "" : "s"})`,
          amount: fromCents(lostCents).toFixed(2),
        });
      }
      folded += lostLines;
      if (adjustments.length > 12) bad(`Order ${group.reference} has more than 12 adjustments`);

      const ordered = lines.reduce((n, line) => n + line.qty_ordered, 0);
      const received = lines.reduce((n, line) => n + line.qty_received, 0);
      let status = typedStatus || inferStatus(ordered, received, sent !== null);
      // TuftStock's "archived" is an order put away: finished if anything came, called off if not.
      if (status === "archived") status = received > 0 ? "closed" : "cancelled";
      // The quantities have the last word between "ordered" and "part received".
      if (status === "ordered" && received > 0) status = "partial";
      if (status === "partial" && received === 0) status = "ordered";
      if (status === "draft" && received > 0) status = received >= ordered ? "closed" : "partial";

      payload.push({
        reference: group.reference,
        supplier,
        status,
        created_at: (created ?? sent)?.at ?? null,
        ordered_at: status === "draft" ? null : ((sent ?? created)?.at ?? null),
        expected_on: expected?.day ?? null,
        closed_at: closed?.at ?? null,
        shipping_cost: shipping,
        tax_rate_pct: taxTyped === "" ? "0" : taxTyped,
        notes: short(firstWith("notes").get("notes"), 2000),
        adjustments,
        lines,
      });
    } catch (err) {
      if (!(err instanceof Unusable)) throw err;
      problems.push({ line: head.line, reason: err.message });
    }
  }
  if (folded > 0) {
    notes.push(
      `${folded} line${folded === 1 ? " names an item that isn't" : "s name items that aren't"} in your shop. Each order keeps what ${folded === 1 ? "it" : "they"} cost as one amount, so spend still adds up; ${folded === 1 ? "it doesn't" : "they don't"} count as on order.`,
    );
  }
  const open = payload.filter(
    (order) => order.status === "ordered" || order.status === "partial",
  ).length;
  if (open > 0) {
    notes.push(
      `${open} of these ${open === 1 ? "is" : "are"} still open. What ${open === 1 ? "it says" : "they say"} has already arrived is kept as history: your counts aren't raised and nothing is sent to your shop. What is still to come can be checked in as usual.`,
    );
  }
  problems.sort((a, b) => a.line - b.line);
  return { payload, problems, notes };
}

// ---------------------------------------------------------------------------
// 4. The supplier ledger
// ---------------------------------------------------------------------------

const LEDGER_TYPES = ["statement", "invoice", "payment", "adjustment"];

function readLedger(rows: Row[], today: string) {
  const problems: Problem[] = [];
  const latest = shiftDay(today, 366);
  const payload = eachRow(rows, problems, (row) => {
    const supplier = row.get("supplier");
    if (!supplier) return bad("This row has no supplier name");
    if (supplier.length > 120) return bad("A supplier's name can be 120 characters at most");
    const type = row.get("type").toLowerCase();
    if (!LEDGER_TYPES.includes(type)) {
      return bad(`“${row.get("type")}” should be STATEMENT, INVOICE, PAYMENT or ADJUSTMENT (type)`);
    }
    const date = when(row, "entry_date", "entry_date");
    if (!date) return bad("This row has no date");
    if (date.day > latest) return bad(`${date.day} is more than a year from now`);
    const amount = money(row, "amount", "amount", type === "adjustment");
    const stated = money(row, "stated_balance", "stated balance", true);
    if (type === "statement") {
      if (stated === null)
        return bad("A statement needs the balance the supplier says is owed (stated_balance)");
    } else if (amount === null || new Money(amount).isZero()) {
      return bad(
        `${type === "adjustment" ? "An adjustment" : type === "invoice" ? "An invoice" : "A payment"} needs an amount that isn't zero`,
      );
    }
    const paid = type === "invoice" ? when(row, "paid_on", "paid_on") : null;
    return {
      supplier,
      type,
      entry_date: date.day,
      amount: type === "statement" ? "0.00" : amount,
      stated_balance: type === "statement" ? stated : null,
      reference: short(row.get("reference"), 80) || null,
      description: short(row.get("description"), 500),
      paid_on: paid?.at ?? null,
    };
  });
  return { payload, problems, notes: [] as string[] };
}

// ---------------------------------------------------------------------------
// 5. Past daily counts, and past deliveries
// ---------------------------------------------------------------------------

/** A calendar day moved by some days. */
export function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function readCounts(rows: Row[], items: ItemRef[], today: string) {
  const problems: Problem[] = [];
  const notes: string[] = [];
  const find = itemFinder(items);
  const oldest = shiftDay(today, -COUNT_DAYS_KEPT);
  let tooOld = 0;
  let notYet = 0;
  // An item named on hundreds of days is explained once, not hundreds of times.
  const unknown = new Map<string, number>();
  const seen = new Set<string>();
  const payload = eachRow(rows, problems, (row) => {
    const date = when(row, "date", "date");
    if (!date) return bad("This row has no date");
    const onHand = whole(row, "on_hand", -1_000_000, 1_000_000, "the count");
    if (onHand === null) return bad("This row has no count (on_hand)");
    if (date.day >= today) {
      notYet += 1;
      return null;
    }
    if (date.day < oldest) {
      tooOld += 1;
      return null;
    }
    const match = find(row.get("sku"), row.get("product"), row.get("option"));
    if ("why" in match) {
      const times = unknown.get(match.why);
      unknown.set(match.why, (times ?? 0) + 1);
      return times === undefined ? bad(match.why) : null;
    }
    const key = `${match.id}\n${date.day}`;
    if (seen.has(key)) return bad("This item already has a count for this day earlier in the file");
    seen.add(key);
    return { stock_item_id: match.id, day: date.day, on_hand: onHand };
  });
  for (const problem of problems) {
    const times = unknown.get(problem.reason);
    if (times && times > 1)
      problem.reason += ` (and on ${times - 1} more row${times === 2 ? "" : "s"})`;
  }
  if (tooOld > 0) {
    notes.push(
      `${tooOld.toLocaleString("en-US")} row${tooOld === 1 ? " is" : "s are"} from more than ${COUNT_DAYS_KEPT} days ago, further back than any sum looks, and ${tooOld === 1 ? "was" : "were"} left out.`,
    );
  }
  if (notYet > 0) {
    notes.push(
      `${notYet.toLocaleString("en-US")} row${notYet === 1 ? " is" : "s are"} for today or later and ${notYet === 1 ? "was" : "were"} left out: today's count comes from your shop.`,
    );
  }
  notes.push("A day this app already has a count for keeps the count it has.");
  return { payload, problems, notes };
}

function readDeliveries(rows: Row[], items: ItemRef[], now: string) {
  const problems: Problem[] = [];
  const find = itemFinder(items);
  const seen = new Set<string>();
  const payload = eachRow(rows, problems, (row) => {
    const reference = tidyReference(row.get("reference"));
    if (!reference)
      return bad("This row has no order reference, so we can't tell which order it arrived on");
    const date = when(row, "received_at", "received_at");
    if (!date) return bad("This row doesn't say when it arrived (received_at)");
    if (date.at > now) return bad(`${date.day} hasn't happened yet`);
    const quantity = whole(row, "quantity", 1, 1_000_000, "how many arrived");
    if (quantity === null) return bad("This row doesn't say how many arrived (quantity)");
    const match = find(row.get("sku"), row.get("product"), row.get("option"));
    if ("why" in match) return bad(match.why);
    const key = `${reference.toUpperCase()}\n${match.id}\n${quantity}\n${date.at}`;
    if (seen.has(key)) return bad("The same delivery is already earlier in the file");
    seen.add(key);
    return { reference, stock_item_id: match.id, quantity, received_at: date.at };
  });
  return {
    payload,
    problems,
    notes: [
      "Past deliveries are history only: they say when goods arrived, so we can work out how long each supplier really takes. They don't raise a count and are never sent to your shop.",
      "A delivery is kept only if its order was brought in from a spreadsheet and has that item on it; bring the orders in first.",
    ],
  };
}

// ---------------------------------------------------------------------------

/**
 * Reads one file. `items` is the workspace's items (needed for every kind but
 * suppliers and the ledger); `now` is the moment of the request and `today`
 * the workspace's own calendar day.
 */
export function readImport(
  kind: ImportKind,
  text: string,
  context: { items: ItemRef[]; today: string; now: string },
): ImportRead {
  const file = open(kind, text);
  if (!file.ok) return file;
  const { rows, has } = file;
  const result =
    kind === "suppliers"
      ? readSuppliers(rows, has)
      : kind === "items"
        ? readItems(rows, has, context.items)
        : kind === "orders"
          ? readOrders(rows, context.items)
          : kind === "ledger"
            ? readLedger(rows, context.today)
            : kind === "counts"
              ? readCounts(rows, context.items, context.today)
              : readDeliveries(rows, context.items, context.now);
  return { ok: true, kind, read: rows.length, ...result };
}
