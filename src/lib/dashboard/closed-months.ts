import { splitCents, type ClosedMonths } from "./lines";

export { CLOSED_MONTHS, type ClosedMonths } from "./lines";

/**
 * "The books are the master number for closed months" (revenue setting
 * `closed_months`). Pure, whole cents.
 *
 * With `shop` (the default) nothing changes: revenue is the shop's sales,
 * with the books' paid invoices and other income beside them where the
 * revenue setting counts them.
 *
 * With `books`, every COMPLETE month (in the workspace's timezone) that the
 * books have a profit and loss for, and that the range covers whole, takes
 * its revenue from the books: the month's income (Total Income, above the
 * operating line). The month in progress, any month the books don't have,
 * and a month the range only covers part of stay on the shop's figure.
 *
 * How a books month is shared among the business lines, in this order
 * (the precedence, so nothing is counted twice):
 *   1. Paid invoices whose income account is pointed at a line go to that
 *      line. They are inside the books' income already, so they are carved
 *      out of it, never added on top.
 *   2. The rest of the books' income is shared among the lines in the
 *      proportions the shop's own sales fell into them that month
 *      (`splitCents`, so the shares add up to the cent). The shop knows
 *      product from workshop; the books know the total.
 *   3. With no shop sales that month to share by (or no lines set up), the
 *      rest is "Other revenue from your books", beside the lines.
 * Invoices on accounts marked as the shop's own sales, left out, or not
 * chosen yet are inside the books' income too and are never added again.
 * The books' OTHER income (below the operating line) is not in the month's
 * income at all: it still follows the "other income" switch, in a line or
 * beside them, in every month alike.
 */

/** What one month brings, before deciding where its revenue comes from. */
export type MonthFacts = {
  /** `YYYY-MM`. */
  month: string;
  /** The shop's revenue that month under the workspace's figure. */
  shop: number;
  /** The shop's revenue per line that month (lines with none may be missing). */
  shopLines: ReadonlyMap<string, number>;
  /** Paid invoices pointed at a line, per line, that month (only when invoices are counted). */
  invoiceLines: ReadonlyMap<string, number>;
  /** The books' income for the month; null when it doesn't come from the books. */
  books: number | null;
};

export type MonthFigure = {
  month: string;
  source: "books" | "shop";
  /** The shop's part: its sales in a shop month, nothing in a books month. */
  shop: number;
  /** The books' part: the month's income in a books month; placed invoices in a shop month. */
  books: number;
  /** shop + books: the month's revenue. */
  total: number;
  /** Per line; every line id present. */
  byLine: Map<string, number>;
  /** Revenue in no line: a books month with no shop sales (or no lines) to share it by. */
  unplaced: number;
};

/** Which of the range's months come from the books. */
export function booksMonths(input: {
  closed: ClosedMonths;
  /** The months the range covers whole, `YYYY-MM`. */
  whole: readonly string[];
  /** The month in progress, `YYYY-MM`. */
  current: string;
  /** The books' income per month, where the books have a profit and loss. */
  income: ReadonlyMap<string, number>;
}): Set<string> {
  if (input.closed !== "books") return new Set();
  return new Set(input.whole.filter((m) => m < input.current && input.income.has(m)));
}

const add = (map: Map<string, number>, key: string, cents: number) =>
  map.set(key, (map.get(key) ?? 0) + cents);

/** One month's revenue and its lines, from the books or from the shop (see the rules above). */
export function monthFigure(facts: MonthFacts, lineIds: readonly string[]): MonthFigure {
  const byLine = new Map(lineIds.map((id) => [id, 0]));
  const known = new Set(lineIds);
  const placed = lineIds.reduce((sum, id) => sum + (facts.invoiceLines.get(id) ?? 0), 0);
  for (const id of lineIds) add(byLine, id, facts.invoiceLines.get(id) ?? 0);

  if (facts.books === null) {
    for (const [id, cents] of facts.shopLines) if (known.has(id)) add(byLine, id, cents);
    return {
      month: facts.month,
      source: "shop",
      shop: facts.shop,
      books: placed,
      total: facts.shop + placed,
      byLine,
      unplaced: 0,
    };
  }

  // The books' income less what invoices already put in a line (never below nothing).
  const rest = Math.max(0, facts.books - placed);
  const weights = lineIds.map((id) => Math.max(0, facts.shopLines.get(id) ?? 0));
  const shareable = lineIds.length > 0 && weights.some((w) => w > 0);
  let unplaced = 0;
  if (shareable) {
    splitCents(rest, weights).forEach((cents, i) => add(byLine, lineIds[i], cents));
  } else {
    unplaced = rest;
  }
  return {
    month: facts.month,
    source: "books",
    shop: 0,
    books: placed + rest,
    total: placed + rest,
    byLine,
    unplaced,
  };
}

export type RangeRevenue = {
  months: MonthFigure[];
  /** Every month added up. */
  total: number;
  shop: number;
  books: number;
  byLine: Map<string, number>;
  unplaced: number;
  /** The months from the books, and the ones on the shop's figure, in order. */
  fromBooks: string[];
  fromShop: string[];
};

/** A range's months worked out and added up: the total is the months' sum and the lines' sum. */
export function rangeRevenue(
  facts: readonly MonthFacts[],
  lineIds: readonly string[],
): RangeRevenue {
  const months = facts.map((f) => monthFigure(f, lineIds));
  const byLine = new Map(lineIds.map((id) => [id, 0]));
  for (const m of months) for (const [id, cents] of m.byLine) add(byLine, id, cents);
  const sum = (pick: (m: MonthFigure) => number) => months.reduce((s, m) => s + pick(m), 0);
  return {
    months,
    total: sum((m) => m.total),
    shop: sum((m) => m.shop),
    books: sum((m) => m.books),
    byLine,
    unplaced: sum((m) => m.unplaced),
    fromBooks: months.filter((m) => m.source === "books").map((m) => m.month),
    fromShop: months.filter((m) => m.source === "shop").map((m) => m.month),
  };
}

/**
 * The plain note for a range that mixes the two: "October and November are
 * from your books; December so far is your shop's sales." Null when every
 * month comes from the same place.
 */
export function mixNote(
  fromBooks: readonly string[],
  fromShop: readonly string[],
  monthWords: (month: string) => string,
  current: string,
): string | null {
  if (fromBooks.length === 0 || fromShop.length === 0) return null;
  const list = (months: readonly string[]) => {
    const names = months.map((m) => (m === current ? `${monthWords(m)} so far` : monthWords(m)));
    if (names.length <= 3) {
      return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
    }
    return `${names[0]} to ${names.at(-1)}`;
  };
  const shopWords = fromShop.length === 1 ? "is your shop's sales" : "are your shop's sales";
  const bookWords = fromBooks.length === 1 ? "is from your books" : "are from your books";
  return `${list(fromBooks)} ${bookWords}; ${list(fromShop)} ${shopWords}.`;
}
