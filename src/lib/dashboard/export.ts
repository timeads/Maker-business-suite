import type { WidgetData } from "./data";
import type { BudgetRow } from "./budget";
import type { Debt } from "./debt/figures";
import type { WidgetConfig } from "./schema";

/**
 * Money's spreadsheets: the figures on screen as plain CSV, built on the
 * server from the same loaders the pages use. Pure; no library.
 */

/**
 * One cell. Quoted when it holds a comma, quote or line break; a cell a
 * spreadsheet would run as a formula (it starts with = + - @ or a tab) is
 * given a leading apostrophe so it stays text. Numbers are written as
 * numbers, so a negative amount stays one (see `amount`).
 */
export function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Whole cents as a number a spreadsheet reads: 1234 → 12.34, −50 → −0.5. */
export const amount = (cents: number | null | undefined): number | null =>
  cents === null || cents === undefined ? null : Math.round(cents) / 100;

/** Rows as a CSV file's text, Windows line ends, a final line end. */
export function csvText(
  rows: readonly (readonly (string | number | null | undefined)[])[],
): string {
  return rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** A file name's safe part: "Year to date" → "year-to-date". */
export function fileSlug(words: string): string {
  return (
    words
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "money"
  );
}

// ---------------------------------------------------------------------------
// The tables
// ---------------------------------------------------------------------------

type Row = (string | number | null)[];

/** Dollars a widget already holds as a plain number, rounded to the cent. */
const dollars = (value: number | null | undefined) =>
  value === null || value === undefined ? null : Math.round(value * 100) / 100;
/** A share as a percent with one decimal: 0.1234 → 12.3. */
const percent = (value: number | null | undefined) =>
  value === null || value === undefined ? null : Math.round(value * 1000) / 10;

/**
 * Every figure on the Money page for its range, one row each: which card it
 * is on, what it is, the amount and what kind of amount. Built from the same
 * widget data the page draws; cards with nothing yet are left out.
 */
export function figuresTable(
  widgets: readonly WidgetConfig[],
  data: Record<string, WidgetData>,
  titleOf: (widget: WidgetConfig) => string,
): Row[] {
  const rows: Row[] = [["Card", "Figure", "Amount", "In"]];
  const money = (card: string, what: string, value: number | null) =>
    rows.push([card, what, dollars(value), "dollars"]);
  const cents = (card: string, what: string, value: number | null) =>
    rows.push([card, what, amount(value), "dollars"]);
  const share = (card: string, what: string, value: number | null) =>
    rows.push([card, what, percent(value), "percent"]);
  const count = (card: string, what: string, value: number) =>
    rows.push([card, what, value, "count"]);
  for (const widget of widgets) {
    const d = data[widget.id];
    if (!d || d.type === "empty") continue;
    const card = titleOf(widget);
    switch (d.type) {
      case "key_figures":
        money(card, "Sales", d.sales);
        count(card, "Orders", d.orders);
        money(card, "Average order", d.averageOrder);
        share(card, "Gross margin", d.margin);
        if (d.fromBooks) cents(card, "From your books", d.fromBooks);
        break;
      case "sales_over_time":
        for (const p of d.points) money(card, p.longLabel, p.value);
        money(card, "Total", d.total);
        break;
      case "gross_margin":
        for (const p of d.points) share(card, p.longLabel, p.value);
        share(card, "Overall", d.overall);
        break;
      case "top_products":
      case "sales_by_channel":
      case "revenue_by_line":
      case "ar_aging":
        for (const r of d.rows) money(card, r.name, r.value);
        if ("total" in d) money(card, "Total", d.total);
        break;
      case "revenue_by_line_over_time":
        for (const series of d.series) {
          for (const p of series.points) money(card, `${series.name}, ${p.longLabel}`, p.value);
          money(card, `${series.name}, total`, series.total);
        }
        break;
      case "deferred_revenue":
        money(card, "Already paid", d.total);
        count(card, "Places booked", d.places);
        for (const r of d.rows) money(card, r.name, r.value);
        break;
      case "cash_on_hand":
        money(card, `Cash as of ${d.asOf}`, d.cash);
        break;
      case "profit_by_line":
        for (const r of d.rows) cents(card, r.name, r.profit);
        cents(card, "All lines", d.profit);
        cents(card, "Expenses not sorted yet", d.unsorted);
        cents(card, "Shared costs with no split", d.sharedUnsplit);
        cents(card, "Set aside", d.setAside);
        break;
      case "expenses_by_line":
        for (const r of d.rows) {
          cents(card, `${r.name}, its own`, r.direct);
          cents(card, `${r.name}, share of shared`, r.shared);
        }
        cents(card, "Not sorted yet", d.unsorted);
        cents(card, "Set aside", d.setAside);
        break;
      case "runway":
        cents(card, `Cash as of ${d.asOf}`, d.cash);
        if (d.burn) cents(card, "Burn a month", d.burn.cents);
        rows.push([
          card,
          "Runway",
          d.months === null ? null : Math.round(d.months * 10) / 10,
          "months",
        ]);
        break;
      case "revenue_growth":
        share(card, "Growth", d.growth);
        cents(card, "Recent average a month", d.recentAverage);
        cents(card, "Average a month before", d.priorAverage);
        break;
      case "cash_flow":
        for (const m of d.months) {
          cents(card, `${m.label}, operating`, m.operating);
          cents(card, `${m.label}, investing`, m.investing);
          cents(card, `${m.label}, financing`, m.financing);
          cents(card, `${m.label}, net change`, m.net);
        }
        break;
      case "operating_profit":
        for (const p of d.points) money(card, p.longLabel, p.value);
        cents(card, "Revenue", d.revenue);
        cents(card, "Operating profit", d.profit);
        share(card, "Operating margin", d.margin);
        if (d.otherIncome !== null) cents(card, "Other income, left out", d.otherIncome);
        if (d.otherExpenses !== null) cents(card, "Other expenses, left out", d.otherExpenses);
        break;
      case "health_check":
        if (d.runway)
          rows.push([
            card,
            "Runway",
            d.runway.months === null ? null : Math.round(d.runway.months * 10) / 10,
            "months",
          ]);
        if (d.growth) share(card, "Revenue growth", d.growth.value);
        if (d.margin) share(card, "Gross margin", d.margin.gross);
        if (d.margin) share(card, "Operating margin", d.margin.operating);
        if (d.concentration)
          share(card, `Biggest line (${d.concentration.name})`, d.concentration.share);
        if (d.debt) cents(card, "Debt owed", d.debt.owed);
        if (d.debt) cents(card, "Debt payments a month", d.debt.monthly);
        break;
    }
  }
  return rows;
}

/** Profit by line, each step of the sum in its own column, whole cents as dollars. */
export function profitTable(data: Extract<WidgetData, { type: "profit_by_line" }>): Row[] {
  const source = new Map(data.sources.map((s) => [s.id, s]));
  const rows: Row[] = [
    [
      "Line",
      "Revenue",
      "From your shop",
      "From your books",
      "Typed in",
      "Cost of goods",
      "Its expenses",
      "Share of shared",
      "Monthly costs",
      "Profit",
    ],
  ];
  for (const r of data.rows) {
    const s = source.get(r.id);
    rows.push([
      r.name,
      amount(r.revenue),
      amount(s?.shop ?? 0),
      amount(s?.books ?? 0),
      amount(s?.typed ?? 0),
      r.cogs === null ? null : amount(r.cogs),
      amount(r.direct),
      amount(r.shared),
      amount(r.monthly),
      amount(r.profit),
    ]);
  }
  const sum = (pick: (r: (typeof data.rows)[number]) => number) =>
    amount(data.rows.reduce((a, r) => a + pick(r), 0));
  rows.push([
    "All lines",
    sum((r) => r.revenue),
    amount(data.sources.reduce((a, s) => a + s.shop, 0)),
    amount(data.sources.reduce((a, s) => a + s.books, 0)),
    amount(data.sources.reduce((a, s) => a + s.typed, 0)),
    data.cogs === "shop_item_costs" ? sum((r) => r.cogs ?? 0) : null,
    sum((r) => r.direct),
    sum((r) => r.shared),
    sum((r) => r.monthly),
    amount(data.profit),
  ]);
  rows.push(["Expenses not sorted yet", amount(data.unsorted)]);
  rows.push(["Shared costs with no split", amount(data.sharedUnsplit)]);
  rows.push(["Set aside, not business expenses", amount(data.setAside)]);
  if (data.books?.otherUnplaced)
    rows.push(["Other revenue, beside the lines", amount(data.books.otherUnplaced)]);
  if (data.books?.waiting)
    rows.push(["Paid invoices waiting for a line", amount(data.books.waiting)]);
  return rows;
}

/** The budget table on screen: each account or line with its budget, actual and variance. */
export function budgetTable(rows: readonly BudgetRow[], subject: "account" | "line"): Row[] {
  return [
    [
      subject === "line" ? "Line" : "Group",
      subject === "line" ? "" : "Account",
      "Average a month",
      "Budget",
      "Actual",
      "Over (+) or under (−)",
      "Over or under, %",
    ],
    ...rows
      .filter((r) => !r.hidden)
      .map((r) => [
        subject === "line" ? r.name : r.group,
        subject === "line" ? "" : r.name,
        amount(r.average),
        amount(r.budget),
        amount(r.actual),
        amount(r.variance),
        percent(r.share),
      ]),
  ];
}

/** One expense as the inbox shows it. */
export type ExpenseExportRow = {
  txn_date: string;
  payee: string | null;
  account: string | null;
  memo: string;
  amount_cents: number;
  sorted: string;
};

export function expensesTable(rows: readonly ExpenseExportRow[]): Row[] {
  return [
    ["Date", "Payee", "Account", "Memo", "Amount", "Sorted as"],
    ...rows.map((r) => [
      r.txn_date,
      r.payee ?? "",
      r.account ?? "",
      r.memo,
      amount(r.amount_cents),
      r.sorted,
    ]),
  ];
}

/** The debts, for owners and admins only: what's owed, at what rate, and when the plan clears each. */
export function debtsTable(
  debts: readonly Debt[],
  payoffs: ReadonlyMap<string, string | null>,
): Row[] {
  return [
    ["Debt", "From", "Owed", "Rate, %", "Minimum", "Usual payment", "Status", "Paid off in"],
    ...debts.map((d) => [
      d.name,
      d.source === "books" ? "Your books" : "Typed in",
      amount(d.balance),
      d.needsRate ? null : d.rateBp / 100,
      amount(d.minimum),
      amount(d.payment),
      d.status,
      payoffs.get(d.id) ?? "",
    ]),
  ];
}
