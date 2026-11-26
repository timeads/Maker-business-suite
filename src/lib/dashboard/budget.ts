import { z } from "zod";
import { DASHBOARD_MODULE } from "./schema";

/**
 * Budget against actual, the earlier finance dashboard's rules
 * (`useBudget.ts`, `Budget.tsx`), on whole cents:
 *
 * - a budget is typed in per account (or per business line) per month; a
 *   longer period adds its months up and is for looking only, so one
 *   month's budget is never overwritten from a quarter's view;
 * - actual = what the books spent in the period (moves between the
 *   business's own accounts and expenses set aside never count);
 * - the average beside it = the complete months before the chosen month
 *   (three by default); for a longer period, its own monthly average;
 * - variance = actual − budget, worked out here and never stored; more than
 *   a set share over is a warning, except for costs that rise and fall with
 *   sales (cost of goods), where spending more usually means selling more;
 * - expected cost of goods for a month = last month's revenue × the cost of
 *   goods share, shared across those accounts by their usual share;
 * - break-even revenue = fixed costs budgeted ÷ (1 − cost of goods share).
 *
 * Which accounts rise and fall with sales, which are hidden, the warning
 * share and the cost of goods share are this config (`dashboard` /
 * `budget`), never code: no account name is written here. Pure.
 */
export const BUDGET_MODULE = DASHBOARD_MODULE;
export const BUDGET_KEY = "budget";

const accountName = z.string().trim().min(1).max(200);

export const budgetSettingsSchema = z.object({
  version: z.literal(1),
  /**
   * Cost of goods as a whole percent of revenue. Null: worked out from the
   * books' last twelve complete months.
   */
  cogs_pct: z.number().int().min(0).max(95).nullable().default(null),
  /** Accounts whose spending rises and falls with sales (cost of goods). Everything else is fixed. */
  variable_accounts: z.array(accountName).max(50).default([]),
  /** Accounts left off the budget (owner's draws, money held for others…). */
  hidden_accounts: z.array(accountName).max(200).default([]),
  /** Over or under the budget by more than this share is worth a look. */
  warn_pct: z.number().int().min(1).max(100).default(15),
  /** How many complete months the average beside each budget covers. */
  average_months: z.number().int().min(1).max(12).default(3),
});
export type BudgetSettings = z.infer<typeof budgetSettingsSchema>;

export const DEFAULT_BUDGET_SETTINGS: BudgetSettings = budgetSettingsSchema.parse({ version: 1 });

export function parseBudgetSettings(body: unknown): BudgetSettings {
  const parsed = budgetSettingsSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_BUDGET_SETTINGS;
}

/** Account names compared without regard to capitals or spacing. */
export const sameAccount = (a: string, b: string) =>
  a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();

const inList = (list: readonly string[], name: string) =>
  list.some((one) => sameAccount(one, name));

// ---------------------------------------------------------------------------
// Months and periods
// ---------------------------------------------------------------------------

export const PERIODS = ["month", "quarter", "ytd", "year"] as const;
export type Period = (typeof PERIODS)[number];

export const PERIOD_WORDS: Record<Period, string> = {
  month: "Month",
  quarter: "Quarter",
  ytd: "Year to date",
  year: "Whole year",
};

/** `YYYY-MM` shifted by whole months. */
export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

export const isMonth = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-(0[1-9]|1[0-2])$/.test(value) &&
  Number(value.slice(0, 4)) >= 2000 &&
  Number(value.slice(0, 4)) <= 2100;

/** The months a period around `month` covers, in order. */
export function periodMonths(period: Period, month: string): string[] {
  const year = month.slice(0, 4);
  const m = Number(month.slice(5, 7));
  const run = (first: number, last: number) =>
    Array.from(
      { length: last - first + 1 },
      (_, i) => `${year}-${String(first + i).padStart(2, "0")}`,
    );
  switch (period) {
    case "month":
      return [month];
    case "quarter": {
      const first = m - ((m - 1) % 3);
      return run(first, first + 2);
    }
    case "ytd":
      return run(1, m);
    case "year":
      return run(1, 12);
  }
}

/** The complete months before `month` the average covers. */
export const averageMonths = (month: string, count: number) =>
  Array.from({ length: count }, (_, i) => addMonths(month, i - count));

// ---------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------

export type BudgetSubject = "account" | "line";

/** What the books spent on one account (or line) in one month, whole cents. */
export type MonthSpend = { month: string; key: string; cents: number };
/** A budget a person typed in. */
export type BudgetEntry = { month: string; key: string; cents: number };

export type BudgetStanding = "over" | "under" | "on";

export type BudgetRow = {
  key: string;
  /** "Parent" of "Parent:Child", as QuickBooks names sub-accounts. */
  group: string;
  name: string;
  average: number;
  budget: number;
  /** Months of the period with a budget typed in. */
  budgeted: number;
  actual: number;
  variance: number;
  /** variance ÷ budget; null with no budget. */
  share: number | null;
  standing: BudgetStanding | null;
  /** Over budget here is usually good news: it rises with sales. */
  variable: boolean;
  hidden: boolean;
  /**
   * A debt's payments (owners and admins only): its budget follows the
   * debt's usual payment and can't be typed; `estimatedMonths` had nothing
   * booked yet and use that payment.
   */
  debt?: { estimatedMonths: number };
};

/** QuickBooks writes sub-accounts as "Parent:Child". */
export function splitAccount(name: string): { group: string; name: string } {
  const parts = name
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 1) return { group: parts[0] ?? name, name: parts[0] ?? name };
  return { group: parts[0], name: parts.slice(1).join(" › ") };
}

/**
 * Over, under or on budget: more than `warnPct` either way, or within it.
 * Null without a budget. (Over on a cost that rises with sales is shown as
 * good news by the page, as the dashboard does.)
 */
export function varianceStanding(
  actual: number,
  budget: number,
  warnPct: number,
): BudgetStanding | null {
  if (budget <= 0) return null;
  const share = (actual - budget) / budget;
  if (share > warnPct / 100) return "over";
  if (share < -warnPct / 100) return "under";
  return "on";
}

const addTo = (
  map: Map<string, Map<string, number>>,
  key: string,
  month: string,
  cents: number,
) => {
  let inner = map.get(key);
  if (!inner) map.set(key, (inner = new Map()));
  inner.set(month, (inner.get(month) ?? 0) + cents);
};

/** Whole cents divided by a count, to the nearest cent (halves away from zero). */
const divide = (cents: number, by: number) =>
  by <= 0 ? 0 : Math.sign(cents) * Math.round(Math.abs(cents) / by);

/**
 * Every account (or line) with spending, a budget, or a name to show, for a
 * period. `names` gives a line's name; an account is its own name.
 */
export function budgetRows(input: {
  subject: BudgetSubject;
  spend: readonly MonthSpend[];
  budgets: readonly BudgetEntry[];
  /** The period's months; the first is the month the average is taken before. */
  months: readonly string[];
  settings: BudgetSettings;
  names?: ReadonlyMap<string, string>;
}): BudgetRow[] {
  const { settings } = input;
  const period = new Set(input.months);
  const before = new Set(averageMonths(input.months[0], settings.average_months));
  const spent = new Map<string, Map<string, number>>();
  for (const row of input.spend) addTo(spent, row.key, row.month, row.cents);
  const planned = new Map<string, Map<string, number>>();
  for (const row of input.budgets)
    if (period.has(row.month)) addTo(planned, row.key, row.month, row.cents);

  const keys = new Set<string>([
    ...spent.keys(),
    ...planned.keys(),
    ...(input.names?.keys() ?? []),
  ]);
  const rows: BudgetRow[] = [];
  for (const key of keys) {
    const months = spent.get(key);
    const actual = [...(months?.entries() ?? [])]
      .filter(([month]) => period.has(month))
      .reduce((sum, [, cents]) => sum + cents, 0);
    const earlier = [...before].reduce((sum, month) => sum + (months?.get(month) ?? 0), 0);
    const average =
      input.months.length > 1 ? divide(actual, input.months.length) : divide(earlier, before.size);
    const typed = planned.get(key);
    const budget = [...(typed?.values() ?? [])].reduce((a, b) => a + b, 0);
    const isAccount = input.subject === "account";
    const variable = isAccount && inList(settings.variable_accounts, key);
    const shown = isAccount ? splitAccount(key) : { group: "", name: input.names?.get(key) ?? key };
    rows.push({
      key,
      group: shown.group,
      name: shown.name,
      average,
      budget,
      budgeted: typed?.size ?? 0,
      actual,
      variance: actual - budget,
      share: budget > 0 ? (actual - budget) / budget : null,
      standing: varianceStanding(actual, budget, settings.warn_pct),
      variable,
      hidden: isAccount && inList(settings.hidden_accounts, key),
    });
  }
  // Biggest usual spend first, as the dashboard lists them.
  return rows.sort(
    (a, b) => b.average - a.average || b.actual - a.actual || a.key.localeCompare(b.key),
  );
}

/**
 * The cost of goods share as a ratio: the setting, or the books' own over
 * their last twelve complete months (cost of goods ÷ revenue). Null when
 * neither is known.
 */
export function cogsShare(
  settings: BudgetSettings,
  books: readonly { income: number; cogs: number }[],
): { share: number; from: "setting" | "books" } | null {
  if (settings.cogs_pct !== null) return { share: settings.cogs_pct / 100, from: "setting" };
  const recent = books.slice(-12);
  const income = recent.reduce((sum, m) => sum + m.income, 0);
  const cogs = recent.reduce((sum, m) => sum + m.cogs, 0);
  if (income <= 0 || cogs < 0) return null;
  return { share: Math.min(cogs / income, 0.95), from: "books" };
}

/**
 * For a single month: what the accounts that rise with sales should cost,
 * last month's revenue × the cost of goods share, shared across them by
 * their usual spend. Replaces those rows' averages, as the dashboard does.
 */
export function withExpectedVariable(
  rows: readonly BudgetRow[],
  lastMonthRevenue: number,
  share: number | null,
): BudgetRow[] {
  const variable = rows.filter((row) => row.variable && !row.hidden);
  const usual = variable.reduce((sum, row) => sum + row.average, 0);
  if (share === null || usual <= 0 || lastMonthRevenue <= 0) return [...rows];
  const expected = Math.round(lastMonthRevenue * share);
  // Shared out to the cent, leftover cents to the largest.
  const parts = variable.map((row) => ({
    key: row.key,
    cents: Math.floor((expected * row.average) / usual),
  }));
  let left = expected - parts.reduce((sum, part) => sum + part.cents, 0);
  const order = [...parts].sort((a, b) => b.cents - a.cents);
  for (let i = 0; left > 0 && order.length > 0; i++, left--) order[i % order.length].cents += 1;
  const byKey = new Map(parts.map((part) => [part.key, part.cents]));
  return rows.map((row) => (byKey.has(row.key) ? { ...row, average: byKey.get(row.key)! } : row));
}

export type BreakEven = {
  /** Budgeted costs that don't move with sales. */
  fixed: number;
  /** Budgeted costs that do. */
  variable: number;
  share: number | null;
  /** fixed ÷ (1 − share); null without a share. */
  revenue: number | null;
};

/** Break-even revenue from the budget, as the dashboard works it out. */
export function breakEven(rows: readonly BudgetRow[], share: number | null): BreakEven {
  let fixed = 0;
  let variable = 0;
  for (const row of rows) {
    if (row.hidden) continue;
    if (row.variable) variable += row.budget;
    else fixed += row.budget;
  }
  return {
    fixed,
    variable,
    share,
    revenue: share === null || share >= 1 ? null : Math.round(fixed / (1 - share)),
  };
}

/**
 * "Fill blanks from the average": for every shown row with no budget and a
 * usual spend, that average rounded to whole currency units, as the
 * dashboard fills them.
 */
export function blanksFromAverage(rows: readonly BudgetRow[]): { key: string; cents: number }[] {
  return rows
    .filter((row) => !row.hidden && !row.debt && row.budgeted === 0 && row.average > 0)
    .map((row) => ({ key: row.key, cents: Math.round(row.average / 100) * 100 }))
    .filter((row) => row.cents > 0);
}
