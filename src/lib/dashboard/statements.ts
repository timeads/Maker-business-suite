/**
 * The books' statements drawn line by line: the income statement over the
 * months a range touches (each account's lines added up month by month, in
 * whole cents), and the latest balance sheet as the books lay it out. Built
 * from the snapshots the sync keeps; nothing is worked out that the books
 * don't say. Pure.
 */

export type StatementLine = { section: string; name: string; depth: number; cents: number };

type Month = { month: string; data: Record<string, unknown> };

const SECTION_ORDER = ["Income", "COGS", "Expenses", "OtherIncome", "OtherExpenses"] as const;
export const SECTION_NAMES: Record<string, string> = {
  Income: "Income",
  COGS: "Cost of goods sold",
  Expenses: "Running costs",
  OtherIncome: "Other income",
  OtherExpenses: "Other expenses",
  OtherExpense: "Other expenses",
  TotalAssets: "What the business owns",
  Liabilities: "What it owes",
  Equity: "Equity",
};

const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const toCents = (dollars: unknown) => Math.round(num(dollars) * 100);

const linesOf = (data: Record<string, unknown>): StatementLine[] | null =>
  Array.isArray(data.lines)
    ? (data.lines as Record<string, unknown>[])
        .filter((l) => typeof l?.name === "string" && typeof l?.section === "string")
        .map((l) => ({
          section: l.section === "OtherExpense" ? "OtherExpenses" : String(l.section),
          name: String(l.name),
          depth: Math.max(0, Math.min(6, Math.round(num(l.depth)))),
          cents: Math.round(num(l.cents)),
        }))
    : null;

export type IncomeStatement = {
  sections: { key: string; name: string; lines: StatementLine[]; total: number }[];
  income: number;
  cogs: number;
  grossProfit: number;
  /** Gross profit ÷ income; null with no income. */
  grossShare: number | null;
  expenses: number;
  operating: number;
  otherIncome: number | null;
  otherExpenses: number | null;
  netIncome: number;
  months: string[];
  /** Months stored before each account's line was read: only their totals are known. */
  totalsOnly: string[];
};

/** The income statement for these months of the books, line by line. */
export function incomeStatement(months: readonly Month[]): IncomeStatement {
  const sums = new Map<string, StatementLine>();
  const totalsOnly: string[] = [];
  for (const m of months) {
    const lines = linesOf(m.data);
    if (lines === null) {
      totalsOnly.push(m.month);
      continue;
    }
    for (const line of lines) {
      const key = `${line.section}\u0000${line.depth}\u0000${line.name}`;
      const seen = sums.get(key);
      if (seen) seen.cents += line.cents;
      else sums.set(key, { ...line });
    }
  }
  const total = (key: string) => months.reduce((sum, m) => sum + toCents(m.data[key]), 0);
  const known = (key: string) =>
    months.length > 0 && months.every((m) => typeof m.data[key] === "number")
      ? months.reduce((sum, m) => sum + Math.round(num(m.data[key])), 0)
      : null;
  const income = total("income");
  const cogs = total("cogs");
  const grossProfit = total("gross_profit");
  const expenses = total("expenses");
  const totals: Record<string, number | null> = {
    Income: income,
    COGS: cogs,
    Expenses: expenses,
    OtherIncome: known("other_income_cents"),
    OtherExpenses: known("other_expenses_cents"),
  };
  return {
    sections: SECTION_ORDER.map((key) => ({
      key,
      name: SECTION_NAMES[key],
      lines: [...sums.values()].filter((l) => l.section === key),
      total: totals[key] ?? 0,
    })).filter((s) => s.lines.length > 0 || s.total !== 0),
    income,
    cogs,
    grossProfit,
    grossShare: income !== 0 ? grossProfit / income : null,
    expenses,
    operating: grossProfit - expenses,
    otherIncome: totals.OtherIncome,
    otherExpenses: totals.OtherExpenses,
    netIncome: total("net_income"),
    months: months.map((m) => m.month),
    totalsOnly,
  };
}

export type BalanceSheet = {
  sections: { key: string; name: string; lines: StatementLine[]; total: number }[];
  /** Kept before each account's line was read: only cash, receivables and total assets are known. */
  totalsOnly: boolean;
  totalAssets: number | null;
};

/** The latest balance sheet as the books lay it out. */
export function balanceSheet(data: Record<string, unknown>): BalanceSheet {
  const lines = linesOf(data);
  const assets =
    data.total_assets === null || data.total_assets === undefined
      ? null
      : toCents(data.total_assets);
  if (lines === null) return { sections: [], totalsOnly: true, totalAssets: assets };
  return {
    sections: ["TotalAssets", "Liabilities", "Equity"]
      .map((key) => {
        const mine = lines.filter((l) => l.section === key);
        return {
          key,
          name: SECTION_NAMES[key],
          lines: mine,
          total: mine.reduce((sum, l) => sum + l.cents, 0),
        };
      })
      .filter((s) => s.lines.length > 0),
    totalsOnly: false,
    totalAssets: assets,
  };
}
