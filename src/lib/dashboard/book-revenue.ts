import type { BookAccountChoice, BooksRevenue, RevenueSettings } from "./lines";
import { hasLines } from "./lines";

/**
 * Revenue from the books beside the shop's: paid invoices, line by line,
 * and the books' other income. Pure, whole cents.
 *
 * Nothing is counted twice: an invoice line counts only once its income
 * account is pointed at a business line (an account that holds the shop's
 * own sales is marked so and left out), and other income is the books'
 * section below the operating line, which never holds a shop sale.
 */

/** One row of `money_invoice_revenue()`: paid invoices' revenue for one account in one period. */
export type InvoiceGroup = {
  period: string;
  account_ref: string | null;
  account: string | null;
  cents: number;
};

/** One month of the books' other income, in whole cents (null: not known for that month). */
export type OtherIncomeMonth = { month: string; cents: number | null };

/** The person's choice for an income account: by the books' id first, else the exact name. */
export function accountChoice(
  books: Pick<BooksRevenue, "accounts">,
  account: { ref: string | null; name: string | null },
): BookAccountChoice | null {
  if (account.ref) {
    const byRef = books.accounts.find((a) => a.ref === account.ref);
    if (byRef) return byRef.choice;
  }
  if (account.name) {
    const byName = books.accounts.find((a) => a.ref === null && a.name === account.name);
    if (byName) return byName.choice;
    // A choice made by id before the books gave one still finds its account by name.
    const any = books.accounts.find((a) => a.name === account.name && !account.ref);
    if (any) return any.choice;
  }
  return null;
}

export type BookRevenue = {
  /** Per line id, invoices and other income together. */
  byLine: Map<string, number>;
  /** Per line id, the invoices' part. */
  invoicesByLine: Map<string, number>;
  /** Per line id and period, the invoices' part (for charts over time). */
  invoicesByPeriod: Map<string, Map<string, number>>;
  /** Paid invoices whose account has no choice yet: counted nowhere. */
  waiting: number;
  /** Paid invoices on accounts marked as the shop's own sales, or left out. */
  leftOut: number;
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
 * The books' revenue for a range, by line. `invoices` are the range's paid
 * invoices; `otherIncome` the books' months the range touches. Either is
 * left out entirely when the setting doesn't count it.
 */
export function bookRevenue(
  settings: RevenueSettings,
  invoices: readonly InvoiceGroup[],
  otherIncome: readonly OtherIncomeMonth[],
): BookRevenue {
  const books = settings.books;
  const lines = new Set(hasLines(settings) ? settings.lines.map((l) => l.id) : []);
  const out: BookRevenue = {
    byLine: new Map(),
    invoicesByLine: new Map(),
    invoicesByPeriod: new Map(),
    waiting: 0,
    leftOut: 0,
    otherIncome: 0,
    otherUnplaced: 0,
    otherUnknown: false,
  };
  if (books.invoices) {
    for (const group of invoices) {
      const choice = accountChoice(books, { ref: group.account_ref, name: group.account });
      if (choice && "line" in choice && lines.has(choice.line)) {
        add(out.byLine, choice.line, group.cents);
        add(out.invoicesByLine, choice.line, group.cents);
        const periods = out.invoicesByPeriod.get(choice.line) ?? new Map<string, number>();
        add(periods, group.period, group.cents);
        out.invoicesByPeriod.set(choice.line, periods);
      } else if (choice && "skip" in choice) {
        out.leftOut += group.cents;
      } else {
        out.waiting += group.cents;
      }
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
