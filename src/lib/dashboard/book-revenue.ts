import { splitByPercent } from "./expenses";
import type { BookAccountChoice, BooksRevenue, RevenueSettings } from "./lines";
import { hasLines } from "./lines";

/**
 * Revenue from the books beside the shop's: paid invoices, line by line,
 * and the books' other income. Pure, whole cents.
 *
 * Which line an invoice counts in is ONE rule (`decideInvoice`), used by
 * every figure, the invoice list and its spreadsheet, strongest first:
 *   1. a person's own choice for that invoice (a line, a split across lines
 *      by whole percents, "the shop already counted this", or left out);
 *   2. the workspace's default for the invoice's customer (`books.customers`);
 *   3. each invoice line's income account (`books.accounts`);
 *   4. nothing: counted nowhere and shown apart until someone decides.
 * A choice naming a line that's no longer there is passed over. The first
 * two take the whole invoice before tax; a split shares it to the cent
 * (`splitByPercent`).
 *
 * Nothing is counted twice: an invoice the shop already counted is left
 * out, whether a person says so for that invoice or its account holds the
 * shop's own sales, and other income is the books' section below the
 * operating line, which never holds a shop sale.
 */

/**
 * One row of `money_invoice_sorted_revenue()`: paid invoices' revenue for one
 * account in one period, with what decides their line. The last fields are
 * missing from the earlier `money_invoice_revenue()`.
 */
export type InvoiceGroup = {
  period: string;
  account_ref: string | null;
  account: string | null;
  cents: number;
  customer_ref?: string | null;
  customer?: string | null;
  sort?: string | null;
  line_id?: string | null;
  split?: unknown;
  /** Only for a split invoice: it is shared on its own whole total. */
  invoice_id?: string | null;
};

/** One month of the books' other income, in whole cents (null: not known for that month). */
export type OtherIncomeMonth = { month: string; cents: number | null };

/**
 * A choice in a list kept by the books' id first, else the exact name: by
 * id; else a choice made without an id, by name; else, for something the
 * books gave no id, any choice of that name. The database's twin is
 * `private.money_choice_place()`.
 */
export function choiceIn<T>(
  list: readonly { ref: string | null; name: string; choice: T }[],
  key: { ref: string | null; name: string | null },
): T | null {
  if (key.ref) {
    const byRef = list.find((a) => a.ref === key.ref);
    if (byRef) return byRef.choice;
  }
  if (key.name) {
    const byName = list.find((a) => a.ref === null && a.name === key.name);
    if (byName) return byName.choice;
    // A choice made by id before the books gave one still finds its account by name.
    const any = list.find((a) => a.name === key.name && !key.ref);
    if (any) return any.choice;
  }
  return null;
}

/** The person's choice for an income account: by the books' id first, else the exact name. */
export function accountChoice(
  books: Pick<BooksRevenue, "accounts">,
  account: { ref: string | null; name: string | null },
): BookAccountChoice | null {
  return choiceIn(books.accounts, account);
}

/** The workspace's default for a customer's invoices, by the books' id first, else the name. */
export function customerChoice(
  books: Pick<BooksRevenue, "customers">,
  customer: { ref: string | null; name: string | null },
): BookAccountChoice | null {
  return choiceIn(books.customers ?? [], customer);
}

// ---------------------------------------------------------------------------
// One invoice's line
// ---------------------------------------------------------------------------

/** A person's own choice for one invoice, as `book_invoices.sort` keeps it. */
export const INVOICE_SORTS = ["line", "split", "shop", "left_out"] as const;
export type InvoiceSort = (typeof INVOICE_SORTS)[number];

/** Where a whole invoice goes: a line, shared by whole percents, or left out. */
export type InvoiceChoice =
  { line: string } | { split: Record<string, number> } | { skip: "shop" | "other" };

/** What decided an invoice's line. */
export type InvoiceDecision =
  | { by: "person"; choice: InvoiceChoice }
  | { by: "customer"; choice: BookAccountChoice }
  | { by: "account" };

/** The facts of an invoice that decide its line. */
export type InvoiceFacts = {
  sort?: string | null;
  line_id?: string | null;
  split?: unknown;
  customer_ref?: string | null;
  customer?: string | null;
};

const splitOf = (value: unknown): Record<string, number> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length < 2) return null;
  const out: Record<string, number> = {};
  for (const [key, pct] of entries) {
    const n = typeof pct === "number" ? pct : Number(pct);
    if (!Number.isInteger(n) || n < 1 || n > 100) return null;
    out[key] = n;
  }
  return Object.values(out).reduce((a, b) => a + b, 0) === 100 ? out : null;
};

/**
 * The invoice's own choice, as long as every line it names is still there
 * (`private.money_invoice_own_fits()` is the database's twin).
 */
export function ownChoice(facts: InvoiceFacts, lineIds: ReadonlySet<string>): InvoiceChoice | null {
  switch (facts.sort) {
    case "shop":
      return { skip: "shop" };
    case "left_out":
      return { skip: "other" };
    case "line":
      return facts.line_id && lineIds.has(facts.line_id) ? { line: facts.line_id } : null;
    case "split": {
      const split = splitOf(facts.split);
      return split && Object.keys(split).every((id) => lineIds.has(id)) ? { split } : null;
    }
    default:
      return null;
  }
}

const fits = (choice: BookAccountChoice | null, lineIds: ReadonlySet<string>) =>
  choice !== null && ("skip" in choice || lineIds.has(choice.line));

/**
 * What decides an invoice's line, strongest first: a person's own choice,
 * the customer's default, else its lines' income accounts.
 */
export function decideInvoice(
  books: Pick<BooksRevenue, "customers">,
  lineIds: ReadonlySet<string>,
  facts: InvoiceFacts,
): InvoiceDecision {
  const own = ownChoice(facts, lineIds);
  if (own) return { by: "person", choice: own };
  const customer = customerChoice(books, {
    ref: facts.customer_ref ?? null,
    name: facts.customer ?? null,
  });
  if (customer && fits(customer, lineIds)) return { by: "customer", choice: customer };
  return { by: "account" };
}

/** The workspace's line ids, where revenue can go (none until lines are set up). */
export const lineIdsOf = (settings: RevenueSettings): Set<string> =>
  new Set(hasLines(settings) ? settings.lines.map((l) => l.id) : []);

/** Shares a split invoice's total among its lines, to the cent, the same way everywhere. */
export const shareSplit = (cents: number, split: Record<string, number>): Map<string, number> =>
  splitByPercent(
    cents,
    Object.entries(split).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

/** Where one invoice's revenue goes, in whole cents. */
export type InvoicePlace = {
  by: InvoiceDecision["by"];
  /** The whole-invoice choice that decided it (a person's or the customer's). */
  choice: InvoiceChoice | BookAccountChoice | null;
  /** Per line id. */
  byLine: Map<string, number>;
  /** Left out: the shop already counted it. */
  shop: number;
  /** Left out for another reason. */
  other: number;
  /** Counted nowhere yet: its income account has no choice. */
  waiting: number;
  /** How many of its lines that is (a line can be for nothing). */
  waitingLines: number;
};

/**
 * One invoice placed by the rule: its own choice, its customer's, else
 * line by line by income account. `lines` are the invoice's own lines with
 * their share before tax.
 */
export function placeInvoice(
  settings: RevenueSettings,
  invoice: InvoiceFacts & {
    lines: readonly { account_ref: string | null; account: string | null; cents: number }[];
  },
): InvoicePlace {
  const lineIds = lineIdsOf(settings);
  const decision = decideInvoice(settings.books, lineIds, invoice);
  const out: InvoicePlace = {
    by: decision.by,
    choice: decision.by === "account" ? null : decision.choice,
    byLine: new Map(),
    shop: 0,
    other: 0,
    waiting: 0,
    waitingLines: 0,
  };
  const total = invoice.lines.reduce((sum, line) => sum + line.cents, 0);
  const put = (choice: InvoiceChoice | BookAccountChoice | null, cents: number) => {
    if (choice && "line" in choice && lineIds.has(choice.line)) {
      add(out.byLine, choice.line, cents);
    } else if (choice && "split" in choice) {
      for (const [line, part] of shareSplit(cents, choice.split)) add(out.byLine, line, part);
    } else if (choice && "skip" in choice) {
      if (choice.skip === "shop") out.shop += cents;
      else out.other += cents;
    } else {
      out.waiting += cents;
      out.waitingLines += 1;
    }
  };
  if (decision.by === "account") {
    for (const line of invoice.lines) {
      put(accountChoice(settings.books, { ref: line.account_ref, name: line.account }), line.cents);
    }
  } else {
    put(decision.choice, total);
  }
  return out;
}

/** True when some of the invoice still counts nowhere (the list's "not sorted yet"). */
export const isWaiting = (place: InvoicePlace) => place.waitingLines > 0;

/**
 * The revenue setting as the database's filters read it
 * (`private.money_invoice_in_line`, `private.money_invoice_waiting`): the
 * lines revenue can go to, and each account's and customer's choice as a
 * place ("line:<id>", "skip:shop", "skip:other").
 */
export function invoiceSorting(settings: RevenueSettings) {
  const place = (choice: BookAccountChoice) =>
    "line" in choice ? `line:${choice.line}` : `skip:${choice.skip}`;
  return {
    lines: [...lineIdsOf(settings)],
    accounts: settings.books.accounts.map((a) => ({
      ref: a.ref,
      name: a.name,
      place: place(a.choice),
    })),
    customers: (settings.books.customers ?? []).map((c) => ({
      ref: c.ref,
      name: c.name,
      place: place(c.choice),
    })),
  };
}

export type BookRevenue = {
  /** Per line id, invoices and other income together. */
  byLine: Map<string, number>;
  /** Per line id, the invoices' part. */
  invoicesByLine: Map<string, number>;
  /** Per line id and period, the invoices' part (for charts over time). */
  invoicesByPeriod: Map<string, Map<string, number>>;
  /** Paid invoices with no choice yet (theirs, their customer's or their account's): counted nowhere. */
  waiting: number;
  /** Paid invoices the shop already counted, or left out, by any of those choices. */
  leftOut: number;
  /** Paid invoices placed by a person's own choice or their customer's default. */
  byHand: number;
  /** All of the books' other income counted in the range. */
  otherIncome: number;
  /** Other income with no line to go to: shown as other revenue, beside the lines. */
  otherUnplaced: number;
  /** Some month the range takes other income from was stored before it was read. */
  otherUnknown: boolean;
};

const add = (map: Map<string, number>, key: string, cents: number) =>
  map.set(key, (map.get(key) ?? 0) + cents);

/**
 * The books' revenue for a range, by line, each paid invoice placed by
 * `decideInvoice`. `invoices` are the range's paid invoices; `otherIncome` the books' months the range touches. Either is
 * left out entirely when the setting doesn't count it.
 */
export function bookRevenue(
  settings: RevenueSettings,
  invoices: readonly InvoiceGroup[],
  otherIncome: readonly OtherIncomeMonth[],
): BookRevenue {
  const books = settings.books;
  const lines = lineIdsOf(settings);
  const out: BookRevenue = {
    byLine: new Map(),
    invoicesByLine: new Map(),
    invoicesByPeriod: new Map(),
    waiting: 0,
    leftOut: 0,
    byHand: 0,
    otherIncome: 0,
    otherUnplaced: 0,
    otherUnknown: false,
  };
  if (books.invoices) {
    const toLine = (line: string, period: string, cents: number) => {
      add(out.byLine, line, cents);
      add(out.invoicesByLine, line, cents);
      const periods = out.invoicesByPeriod.get(line) ?? new Map<string, number>();
      add(periods, period, cents);
      out.invoicesByPeriod.set(line, periods);
    };
    // A split invoice is shared on its whole total, once, after its rows are added up.
    const splits = new Map<
      string,
      { period: string; cents: number; split: Record<string, number> }
    >();
    invoices.forEach((group, index) => {
      const decision = decideInvoice(books, lines, group);
      const choice: InvoiceChoice | BookAccountChoice | null =
        decision.by === "account"
          ? accountChoice(books, { ref: group.account_ref, name: group.account })
          : decision.choice;
      if (decision.by !== "account") out.byHand += group.cents;
      if (choice && "line" in choice && lines.has(choice.line)) {
        toLine(choice.line, group.period, group.cents);
      } else if (choice && "split" in choice) {
        const key = group.invoice_id ?? `row:${index}`;
        const seen = splits.get(key);
        if (seen) seen.cents += group.cents;
        else splits.set(key, { period: group.period, cents: group.cents, split: choice.split });
      } else if (choice && "skip" in choice) {
        out.leftOut += group.cents;
      } else {
        out.waiting += group.cents;
      }
    });
    for (const { period, cents, split } of splits.values()) {
      for (const [line, part] of shareSplit(cents, split)) toLine(line, period, part);
    }
  }
  if (books.other_income) {
    for (const month of otherIncome) {
      if (month.cents === null) {
        out.otherUnknown = true;
        continue;
      }
      out.otherIncome += month.cents;
    }
    if (books.other_income_line && lines.has(books.other_income_line)) {
      add(out.byLine, books.other_income_line, out.otherIncome);
    } else {
      out.otherUnplaced = out.otherIncome;
    }
  }
  return out;
}

/** All of the books' revenue the range counts, in or beside the lines (not what's waiting). */
export const bookRevenueTotal = (revenue: BookRevenue) =>
  [...revenue.invoicesByLine.values()].reduce((a, b) => a + b, 0) + revenue.otherIncome;

/** The books' income accounts invoices use, with each one's choice, biggest first. */
export type InvoiceAccount = {
  ref: string | null;
  name: string | null;
  invoices: number;
  cents: number;
  choice: BookAccountChoice | null;
};

export function invoiceAccounts(
  books: Pick<BooksRevenue, "accounts">,
  rows: readonly {
    account_ref: string | null;
    account: string | null;
    invoices: number;
    cents: number;
  }[],
): InvoiceAccount[] {
  const merged = new Map<string, InvoiceAccount>();
  for (const row of rows) {
    const key = row.account_ref ? `ref:${row.account_ref}` : `name:${row.account ?? ""}`;
    const seen = merged.get(key);
    if (seen) {
      seen.invoices += row.invoices;
      seen.cents += row.cents;
      seen.name ??= row.account;
      continue;
    }
    merged.set(key, {
      ref: row.account_ref,
      name: row.account,
      invoices: row.invoices,
      cents: row.cents,
      choice: accountChoice(books, { ref: row.account_ref, name: row.account }),
    });
  }
  return [...merged.values()].sort((a, b) => b.cents - a.cents);
}

/** Which accounts a line takes, for filtering the invoice list to one line. */
export function accountsOfLine(
  books: Pick<BooksRevenue, "accounts">,
  lineId: string,
): { refs: string[]; names: string[] } {
  const chosen = books.accounts.filter((a) => "line" in a.choice && a.choice.line === lineId);
  return {
    refs: chosen.flatMap((a) => (a.ref ? [a.ref] : [])),
    names: chosen.flatMap((a) => (a.ref ? [] : [a.name])),
  };
}
