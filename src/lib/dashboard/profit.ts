import { z } from "zod";
import { splitByPercent, type Sort } from "./expenses";
import { DASHBOARD_MODULE } from "./schema";

/**
 * Profit by business line, the earlier finance dashboard's rule:
 *
 *   a line's profit = its revenue
 *                   − its cost of goods (when the shop knows it, and only if
 *                     the workspace counts it that way)
 *                   − the expenses sorted to it (a split gives it its share)
 *                   − its share of the shared expenses
 *                   − its share of the monthly costs the books don't hold
 *                     (rent split between lines, help paid by the hour or
 *                     the class, an owner's salary).
 *
 * The shares and the monthly costs are this config (`dashboard` / `profit`),
 * never code, and never anyone's real amounts. Expenses not sorted yet and
 * those set aside are shown apart, as the dashboard shows them. Pure: whole
 * cents, no network, no database.
 */
export const PROFIT_MODULE = DASHBOARD_MODULE;
export const PROFIT_KEY = "profit";

/** The earlier dashboard's weeks in a month, for help paid by the hour. */
export const WEEKS_PER_MONTH = 4.333;

const id = z.string().regex(/^[a-z0-9-]{1,40}$/);

/** Whole percents per line id, adding up to 100 (one line at 100% is fine). */
export const sharesSchema = z
  .record(id, z.number().int().min(1).max(100))
  .refine((shares) => Object.keys(shares).length >= 1, {
    message: "Give at least one line a share",
  })
  .refine((shares) => Object.values(shares).reduce((a, b) => a + b, 0) === 100, {
    message: "The shares must add up to 100%",
  });
export type Shares = z.infer<typeof sharesSchema>;

export const COST_KINDS = ["amount", "weekly_hours", "sessions"] as const;
export type CostKind = (typeof COST_KINDS)[number];

export const COST_WORDS: Record<CostKind, string> = {
  amount: "A set amount each month",
  weekly_hours: "An hourly rate × hours a week",
  sessions: "An hourly rate × hours a class × classes a month",
};

export const monthlyCostSchema = z.object({
  id,
  name: z.string().trim().min(1).max(60),
  how: z.enum(COST_KINDS),
  amount_cents: z.number().int().min(0).max(100_000_000).default(0),
  rate_cents: z.number().int().min(0).max(1_000_000).default(0),
  hours_per_week: z.number().min(0).max(168).default(0),
  hours_per_session: z.number().min(0).max(24).default(0),
  sessions_per_month: z.number().min(0).max(200).default(0),
  split: sharesSchema,
});
export type MonthlyCost = z.infer<typeof monthlyCostSchema>;

export const COGS_SOURCES = ["in_expenses", "shop_item_costs"] as const;
export type CogsSource = (typeof COGS_SOURCES)[number];

export const COGS_WORDS: Record<CogsSource, string> = {
  in_expenses:
    "Cost of goods is among the expenses I sort into lines (what you pay suppliers is an expense like any other)",
  shop_item_costs:
    "Take each line's cost of goods from the item costs in my shop, where an item has one",
};

export const profitSettingsSchema = z
  .object({
    version: z.literal(1),
    cost_of_goods: z.enum(COGS_SOURCES).default("in_expenses"),
    /** How shared expenses are shared out. Empty until set: they then stay "not split yet". */
    shared_split: z.record(id, z.number().int().min(1).max(100)).default({}),
    monthly_costs: z.array(monthlyCostSchema).max(30).default([]),
  })
  .superRefine((value, ctx) => {
    const shares = Object.values(value.shared_split);
    if (shares.length > 0 && shares.reduce((a, b) => a + b, 0) !== 100) {
      ctx.addIssue({
        code: "custom",
        path: ["shared_split"],
        message: "The shares of shared costs must add up to 100%",
      });
    }
    if (new Set(value.monthly_costs.map((c) => c.id)).size !== value.monthly_costs.length) {
      ctx.addIssue({
        code: "custom",
        path: ["monthly_costs"],
        message: "Each cost needs its own id",
      });
    }
  });
export type ProfitSettings = z.infer<typeof profitSettingsSchema>;

export const DEFAULT_PROFIT_SETTINGS: ProfitSettings = {
  version: 1,
  cost_of_goods: "in_expenses",
  shared_split: {},
  monthly_costs: [],
};

export function parseProfitSettings(body: unknown): ProfitSettings {
  const parsed = profitSettingsSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_PROFIT_SETTINGS;
}

/** One month's cost, in whole cents. */
export function monthlyCostCents(cost: MonthlyCost): number {
  switch (cost.how) {
    case "amount":
      return cost.amount_cents;
    case "weekly_hours":
      return Math.round(cost.rate_cents * cost.hours_per_week * WEEKS_PER_MONTH);
    case "sessions":
      return Math.round(cost.rate_cents * cost.hours_per_session * cost.sessions_per_month);
  }
}

// ---------------------------------------------------------------------------
// The calendar months a range covers
// ---------------------------------------------------------------------------

export type MonthPart = { month: string; days: number; daysInMonth: number };

const dayNumber = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

/**
 * How many days of each calendar month fall between two plain days (`to`
 * not included). A monthly cost counts in full for a whole month and by the
 * day for part of one, so the month so far carries only its days so far.
 */
export function monthParts(from: string, to: string): MonthPart[] {
  const parts: MonthPart[] = [];
  let day = dayNumber(from);
  const end = dayNumber(to);
  while (day < end && parts.length < 240) {
    const date = new Date(day * 86_400_000);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const nextMonth = Date.UTC(year, month + 1, 1) / 86_400_000;
    const daysInMonth = nextMonth - Date.UTC(year, month, 1) / 86_400_000;
    const stop = Math.min(nextMonth, end);
    parts.push({
      month: `${year}-${String(month + 1).padStart(2, "0")}`,
      days: stop - day,
      daysInMonth,
    });
    day = stop;
  }
  return parts;
}

/**
 * A monthly amount over the months of a range, in whole cents, each month
 * rounded once. `monthly` is one figure for every month, or each month's own.
 */
export function proratedCents(
  monthly: number | ((month: string) => number),
  parts: readonly MonthPart[],
): number {
  return parts.reduce((sum, part) => {
    const amount = typeof monthly === "number" ? monthly : monthly(part.month);
    return (
      sum +
      (part.days === part.daysInMonth
        ? amount
        : Math.round((amount * part.days) / part.daysInMonth))
    );
  }, 0);
}

/**
 * Month-by-month entries (`money_line_entries`): what a monthly cost really
 * came to in a month, in place of its usual amount, and revenue a line had
 * that reached neither the shop nor the books. By subject id, then month
 * (`YYYY-MM`), in whole cents.
 */
export type MonthEntries = {
  cost: ReadonlyMap<string, ReadonlyMap<string, number>>;
  revenue: ReadonlyMap<string, ReadonlyMap<string, number>>;
};

export const NO_ENTRIES: MonthEntries = { cost: new Map(), revenue: new Map() };

/** Rows as the database hands them back, sorted into `MonthEntries`. */
export function monthEntries(
  rows: readonly { kind: string; month: string; subject: string; amount_cents: number }[],
): MonthEntries {
  const cost = new Map<string, Map<string, number>>();
  const revenue = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const into = row.kind === "cost" ? cost : row.kind === "revenue" ? revenue : null;
    if (!into) continue;
    const months = into.get(row.subject) ?? new Map<string, number>();
    months.set(row.month.slice(0, 7), Math.round(row.amount_cents));
    into.set(row.subject, months);
  }
  return { cost, revenue };
}

/** A monthly cost in one month: that month's entry where there is one, else its usual amount. */
export const costInMonth = (cost: MonthlyCost, month: string, entries: MonthEntries) =>
  entries.cost.get(cost.id)?.get(month) ?? monthlyCostCents(cost);

/** Typed-in revenue per line over a range's months, each month counted by the day for part of one. */
export function typedRevenue(entries: MonthEntries, parts: readonly MonthPart[]) {
  const out = new Map<string, number>();
  for (const [line, months] of entries.revenue) {
    const cents = proratedCents((month) => months.get(month) ?? 0, parts);
    if (cents !== 0) out.set(line, cents);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The sum
// ---------------------------------------------------------------------------

/** Sorted expenses added up per way of sorting (from `money_expense_totals`). */
export type ExpenseGroup = {
  sort: Sort | null;
  line: string | null;
  split: Record<string, number> | null;
  cents: number;
};

export type LineProfit = {
  id: string;
  name: string;
  revenue: number;
  /** Null when the workspace doesn't count cost of goods from the shop. */
  cogs: number | null;
  direct: number;
  shared: number;
  monthly: number;
  profit: number;
};

export type ProfitSum = {
  rows: LineProfit[];
  /** Expenses nobody has sorted yet (or sorted to a line since removed). */
  unsorted: number;
  setAside: number;
  /** Shared expenses and monthly costs with no split to share them by. */
  sharedUnsplit: number;
  /** The part of that from the books (shared expenses only, no monthly costs). */
  sharedExpensesUnsplit: number;
  /** Line profits added up; the amounts shown apart are not in it. */
  profit: number;
};

const add = (map: Map<string, number>, key: string, cents: number) =>
  map.set(key, (map.get(key) ?? 0) + cents);

const fits = (shares: Record<string, number> | null, ids: ReadonlySet<string>) =>
  shares !== null && Object.keys(shares).length > 0 && Object.keys(shares).every((k) => ids.has(k));

export function profitByLine(input: {
  lines: readonly { id: string; name: string }[];
  revenue: ReadonlyMap<string, number>;
  /** Null when cost of goods isn't counted from the shop. */
  cogs: ReadonlyMap<string, number> | null;
  expenses: readonly ExpenseGroup[];
  settings: ProfitSettings;
  parts: readonly MonthPart[];
  /** Months where a monthly cost came to something other than its usual amount. */
  entries?: MonthEntries;
}): ProfitSum {
  const entries = input.entries ?? NO_ENTRIES;
  const ids = new Set(input.lines.map((line) => line.id));
  const direct = new Map<string, number>();
  const shared = new Map<string, number>();
  const monthly = new Map<string, number>();
  let unsorted = 0;
  let setAside = 0;
  let sharedPool = 0;
  let sharedUnsplit = 0;

  for (const group of input.expenses) {
    switch (group.sort) {
      case "line":
        if (group.line && ids.has(group.line)) add(direct, group.line, group.cents);
        else unsorted += group.cents;
        break;
      case "split":
        if (fits(group.split, ids)) {
          for (const [line, cents] of splitByPercent(group.cents, Object.entries(group.split!))) {
            add(direct, line, cents);
          }
        } else unsorted += group.cents;
        break;
      case "shared":
        sharedPool += group.cents;
        break;
      case "set_aside":
        setAside += group.cents;
        break;
      default:
        unsorted += group.cents;
    }
  }

  if (fits(input.settings.shared_split, ids)) {
    for (const [line, cents] of splitByPercent(
      sharedPool,
      Object.entries(input.settings.shared_split),
    )) {
      add(shared, line, cents);
    }
  } else {
    sharedUnsplit += sharedPool;
  }
  const sharedExpensesUnsplit = sharedUnsplit;

  for (const cost of input.settings.monthly_costs) {
    const cents = proratedCents((month) => costInMonth(cost, month, entries), input.parts);
    if (fits(cost.split, ids)) {
      for (const [line, part] of splitByPercent(cents, Object.entries(cost.split))) {
        add(monthly, line, part);
      }
    } else {
      sharedUnsplit += cents;
    }
  }

  const rows = input.lines.map((line) => {
    const revenue = input.revenue.get(line.id) ?? 0;
    const cogs = input.cogs ? (input.cogs.get(line.id) ?? 0) : null;
    const d = direct.get(line.id) ?? 0;
    const s = shared.get(line.id) ?? 0;
    const m = monthly.get(line.id) ?? 0;
    return {
      id: line.id,
      name: line.name,
      revenue,
      cogs,
      direct: d,
      shared: s,
      monthly: m,
      profit: revenue - (cogs ?? 0) - d - s - m,
    };
  });
  return {
    rows,
    unsorted,
    setAside,
    sharedUnsplit,
    sharedExpensesUnsplit,
    profit: rows.reduce((sum, row) => sum + row.profit, 0),
  };
}
