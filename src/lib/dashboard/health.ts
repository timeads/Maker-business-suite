import { z } from "zod";
import { toCents } from "./lines";
import { DASHBOARD_MODULE } from "./schema";

/**
 * Cash health, the earlier finance dashboard's advisor rules
 * (`useAdvisorInsights.ts`, `FinancialAdvisor.tsx`), on whole cents:
 *
 * - only COMPLETE months count: the month in progress is only partly booked,
 *   so it would understate revenue and overstate burn;
 * - operating profit = revenue − cost of goods − operating expenses; the
 *   books' other income and other expenses (one-off income, gains) are left
 *   out, and how much was left out is said;
 * - cash on hand = the balance sheet's bank accounts, nothing else;
 * - monthly burn = minus the average operating cash flow of the last few
 *   complete months (the cash flow statement), or, with no statement,
 *   average expenses less average revenue from the profit and loss;
 * - runway = cash ÷ burn, with no limit while cash grows;
 * - revenue growth = the average of the last few complete months against
 *   the few before;
 * - gross and operating margin over the last twelve complete months;
 * - concentration = the biggest business line's share of revenue.
 *
 * Where it is good, worth watching or needs attention, and the plain notes
 * that follow from the figures, are this workspace's config (`dashboard` /
 * `health`), whose defaults are the dashboard's. Nothing about debt: that is
 * the later debt work. Pure: no network, no database.
 */
export const HEALTH_MODULE = DASHBOARD_MODULE;
export const HEALTH_KEY = "health";

const pct = (min: number, max: number) => z.number().int().min(min).max(max);

export const healthSettingsSchema = z
  .object({
    version: z.literal(1),
    /** How many complete months make "recent", and the run before it compared. */
    compare_months: z.number().int().min(1).max(6).default(3),
    runway_good_months: z.number().int().min(1).max(60).default(12),
    runway_watch_months: z.number().int().min(0).max(60).default(6),
    growth_good_pct: pct(-100, 100).default(5),
    growth_bad_pct: pct(-100, 100).default(-5),
    gross_margin_good_pct: pct(0, 100).default(50),
    gross_margin_watch_pct: pct(0, 100).default(35),
    /** The biggest line's share at or above this is worth watching. */
    concentration_watch_pct: pct(1, 100).default(50),
    /** Notes: an operating margin under this is thin. */
    thin_margin_pct: pct(-100, 100).default(5),
    /** Notes: one line bringing in more than this is a watch. */
    concentrated_pct: pct(1, 100).default(65),
    /** Notes: above this, suggest growing the smaller lines. */
    grow_lines_pct: pct(1, 100).default(60),
    /** Notes: a gross margin under this suggests looking at cost of goods… */
    check_cogs_pct: pct(0, 100).default(45),
    /** …and what a lift of this many points would add in a year. */
    margin_lift_pct: pct(1, 50).default(5),
  })
  .superRefine((value, ctx) => {
    const order = (low: number, high: number, path: string, message: string) => {
      if (low > high) ctx.addIssue({ code: "custom", path: [path], message });
    };
    order(
      value.runway_watch_months,
      value.runway_good_months,
      "runway_watch_months",
      "The 'keep an eye on' runway can't be longer than the healthy one",
    );
    order(
      value.growth_bad_pct,
      value.growth_good_pct,
      "growth_bad_pct",
      "Shrinking can't be set above healthy growth",
    );
    order(
      value.gross_margin_watch_pct,
      value.gross_margin_good_pct,
      "gross_margin_watch_pct",
      "The 'keep an eye on' margin can't be above the healthy one",
    );
  });
export type HealthSettings = z.infer<typeof healthSettingsSchema>;

export const DEFAULT_HEALTH_SETTINGS: HealthSettings = healthSettingsSchema.parse({ version: 1 });

export function parseHealthSettings(body: unknown): HealthSettings {
  const parsed = healthSettingsSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_HEALTH_SETTINGS;
}

// ---------------------------------------------------------------------------
// The books, month by month, in whole cents
// ---------------------------------------------------------------------------

/** One month of the profit and loss. `other*` are null for a month stored before they were read. */
export type BookMonth = {
  month: string;
  income: number;
  cogs: number;
  expenses: number;
  netIncome: number;
  otherIncome: number | null;
  otherExpenses: number | null;
};

/** One month of the cash flow statement. */
export type CashMonth = {
  month: string;
  operating: number;
  investing: number;
  financing: number;
  netChange: number;
};

type Snapshot = { period_start: string; data: Record<string, unknown> };

const centsOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
const dollars = (value: unknown) =>
  typeof value === "number" || typeof value === "string" ? toCents(value) : 0;

/** A stored profit-and-loss snapshot as cents (its first figures were kept in dollars). */
export function bookMonthOf(snapshot: Snapshot): BookMonth {
  const d = snapshot.data;
  return {
    month: snapshot.period_start.slice(0, 7),
    income: dollars(d.income),
    cogs: dollars(d.cogs),
    expenses: dollars(d.expenses),
    netIncome: dollars(d.net_income),
    otherIncome: centsOrNull(d.other_income_cents),
    otherExpenses: centsOrNull(d.other_expenses_cents),
  };
}

export function cashMonthOf(snapshot: Snapshot): CashMonth {
  const d = snapshot.data;
  const operating = centsOrNull(d.operating_cents) ?? 0;
  const investing = centsOrNull(d.investing_cents) ?? 0;
  const financing = centsOrNull(d.financing_cents) ?? 0;
  return {
    month: snapshot.period_start.slice(0, 7),
    operating,
    investing,
    financing,
    netChange: centsOrNull(d.net_change_cents) ?? operating + investing + financing,
  };
}

/** Months before the one in progress, oldest first, one row per month. */
export function completeMonths<T extends { month: string }>(
  rows: readonly T[],
  current: string,
): T[] {
  const byMonth = new Map<string, T>();
  for (const row of rows) if (row.month < current) byMonth.set(row.month, row);
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/** Revenue − cost of goods − operating expenses. Other income and expenses stay out. */
export const operatingProfit = (m: BookMonth) => m.income - m.cogs - m.expenses;

/** The average of whole-cent amounts, to the nearest cent (halves away from zero). */
export function averageCents(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((a, b) => a + b, 0);
  const avg = Math.abs(sum) / values.length;
  return Math.sign(sum) * Math.round(avg);
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// The figures
// ---------------------------------------------------------------------------

export type Burn = {
  /** A month's net cash going out; negative when cash comes in. */
  cents: number;
  source: "cash_flow" | "books";
  /** The months it was worked out from. */
  months: string[];
};

/**
 * Burn from the cash flow statement's operating section when there is one,
 * else from the profit and loss (average expenses less average revenue, as
 * the dashboard falls back). Null with no complete month of either.
 */
export function monthlyBurn(
  books: readonly BookMonth[],
  cash: readonly CashMonth[],
  window: number,
): Burn | null {
  const flows = cash.slice(-window);
  if (flows.length > 0) {
    return {
      cents: -averageCents(flows.map((m) => m.operating)),
      source: "cash_flow",
      months: flows.map((m) => m.month),
    };
  }
  const recent = books.slice(-window);
  if (recent.length === 0) return null;
  return {
    cents: averageCents(recent.map((m) => m.expenses)) - averageCents(recent.map((m) => m.income)),
    source: "books",
    months: recent.map((m) => m.month),
  };
}

/** Months of cash at this burn; null means no limit (cash isn't going down). */
export function runwayMonths(cashCents: number, burnCents: number): number | null {
  if (burnCents <= 0) return null;
  return Math.max(0, cashCents) / burnCents;
}

export type Growth = {
  /** −0.1 is down 10%. Null without a full run of months either side, or no revenue before. */
  growth: number | null;
  recentAverage: number;
  priorAverage: number;
  recent: string[];
  prior: string[];
};

/** The last `window` complete months' average revenue against the `window` before. */
export function revenueGrowth(books: readonly BookMonth[], window: number): Growth {
  const recent = books.slice(-window);
  const prior = books.slice(-2 * window, -window);
  const recentAverage = averageCents(recent.map((m) => m.income));
  const priorAverage = averageCents(prior.map((m) => m.income));
  const full = recent.length === window && prior.length === window;
  return {
    growth: full && priorAverage > 0 ? (recentAverage - priorAverage) / priorAverage : null,
    recentAverage,
    priorAverage,
    recent: recent.map((m) => m.month),
    prior: prior.map((m) => m.month),
  };
}

export type Margins = {
  revenue: number;
  cogs: number;
  expenses: number;
  operatingProfit: number;
  /** (revenue − cost of goods) ÷ revenue. */
  gross: number | null;
  /** Operating profit ÷ revenue. */
  operating: number | null;
  /** What the books had below the operating line, left out of the above; null if not known. */
  otherIncome: number | null;
  otherExpenses: number | null;
  months: string[];
};

/** Margins over a run of months (the dashboard's: the last twelve complete ones). */
export function marginsOver(months: readonly BookMonth[]): Margins {
  const revenue = sum(months.map((m) => m.income));
  const cogs = sum(months.map((m) => m.cogs));
  const expenses = sum(months.map((m) => m.expenses));
  const profit = revenue - cogs - expenses;
  const known = (pick: (m: BookMonth) => number | null) =>
    months.length > 0 && months.every((m) => pick(m) !== null)
      ? sum(months.map((m) => pick(m) ?? 0))
      : null;
  return {
    revenue,
    cogs,
    expenses,
    operatingProfit: profit,
    gross: revenue > 0 ? (revenue - cogs) / revenue : null,
    operating: revenue > 0 ? profit / revenue : null,
    otherIncome: known((m) => m.otherIncome),
    otherExpenses: known((m) => m.otherExpenses),
    months: months.map((m) => m.month),
  };
}

/** The biggest line's share of revenue, from each line's total; null with no revenue. */
export function concentration(
  lines: readonly { name: string; cents: number }[],
): { share: number; name: string } | null {
  const total = sum(lines.map((line) => Math.max(0, line.cents)));
  if (total <= 0 || lines.length < 2) return null;
  const top = lines.reduce((best, line) => (line.cents > best.cents ? line : best));
  return { share: Math.max(0, top.cents) / total, name: top.name };
}

// ---------------------------------------------------------------------------
// Where each stands, and the notes that follow
// ---------------------------------------------------------------------------

export type Standing = "good" | "watch" | "bad";

export const STANDING_WORDS: Record<Standing, string> = {
  good: "Healthy",
  watch: "Keep an eye on it",
  bad: "Needs attention",
};

const ratio = (pct: number) => pct / 100;

export function runwayStanding(runway: number | null, s: HealthSettings): Standing {
  if (runway === null) return "good";
  if (runway >= s.runway_good_months) return "good";
  if (runway >= s.runway_watch_months) return "watch";
  return "bad";
}

export function growthStanding(growth: number, s: HealthSettings): Standing {
  if (growth > ratio(s.growth_good_pct)) return "good";
  if (growth > ratio(s.growth_bad_pct)) return "watch";
  return "bad";
}

export function marginStanding(gross: number, s: HealthSettings): Standing {
  if (gross > ratio(s.gross_margin_good_pct)) return "good";
  if (gross > ratio(s.gross_margin_watch_pct)) return "watch";
  return "bad";
}

/** The dashboard never calls concentration bad: at worst it's worth watching. */
export function concentrationStanding(share: number, s: HealthSettings): Standing {
  return share < ratio(s.concentration_watch_pct) ? "good" : "watch";
}

export type HealthInput = {
  books: readonly BookMonth[];
  cash: readonly CashMonth[];
  /** The month in progress, `YYYY-MM`, in the workspace's timezone. */
  current: string;
  /** Cash in the bank, from the latest balance sheet; null when there is none. */
  cashOnHand: number | null;
  /** Each line's revenue over the recent months, when lines are set up. */
  lines: readonly { name: string; cents: number }[] | null;
  settings: HealthSettings;
};

export type HealthNote = { tone: "win" | "watch" | "action"; key: string; text: string };

export type HealthReport = {
  complete: BookMonth[];
  partial: string | null;
  burn: Burn | null;
  runway: { months: number | null; standing: Standing } | null;
  growth: Growth & { standing: Standing | null };
  margins: Margins & { standing: Standing | null };
  concentration: { share: number; name: string; standing: Standing } | null;
  notes: HealthNote[];
};

/**
 * Every figure and note at once. `money` writes whole cents as an amount
 * for the notes' words (formatting stays with the caller's currency).
 */
export function healthCheck(input: HealthInput, money: (cents: number) => string): HealthReport {
  const s = input.settings;
  const complete = completeMonths(input.books, input.current);
  const cashComplete = completeMonths(input.cash, input.current);
  const partial = input.books.some((m) => m.month === input.current) ? input.current : null;

  const burn = monthlyBurn(complete, cashComplete, s.compare_months);
  const runway =
    burn && input.cashOnHand !== null
      ? (() => {
          const months = runwayMonths(input.cashOnHand, burn.cents);
          return { months, standing: runwayStanding(months, s) };
        })()
      : null;
  const growth = revenueGrowth(complete, s.compare_months);
  const margins = marginsOver(complete.slice(-12));
  const top = input.lines ? concentration(input.lines) : null;

  const notes: HealthNote[] = [];
  const pctText = (value: number) => `${(value * 100).toFixed(1)}%`;
  const note = (tone: HealthNote["tone"], key: string, text: string) =>
    notes.push({ tone, key, text });

  // What's going well.
  if (margins.gross !== null && margins.gross > ratio(s.gross_margin_good_pct)) {
    note(
      "win",
      "margin",
      `A strong gross margin of ${pctText(margins.gross)}: your prices are holding up.`,
    );
  }
  if (growth.growth !== null && growth.growth > ratio(s.growth_good_pct)) {
    note(
      "win",
      "growth",
      `Revenue is up ${pctText(growth.growth)} over the last ${plural(s.compare_months)}.`,
    );
  }
  if (runway && runway.months !== null && runway.months > s.runway_good_months) {
    note("win", "runway", `A comfortable runway of ${runway.months.toFixed(1)} months.`);
  }
  if (runway && runway.months === null && burn) {
    note(
      "win",
      "runway",
      `Cash is growing: about ${money(-burn.cents)} a month more coming in than going out.`,
    );
  }

  // Things to watch.
  if (growth.growth !== null && growth.growth < ratio(s.growth_bad_pct)) {
    note(
      "watch",
      "growth",
      `Revenue is down ${pctText(Math.abs(growth.growth))} over the last ${plural(s.compare_months)}. Worth a look at where sales are coming from.`,
    );
  }
  if (margins.operating !== null && margins.operating < ratio(s.thin_margin_pct)) {
    note(
      "watch",
      "thin-margin",
      `A thin operating margin (${pctText(margins.operating)}) leaves little room for a bad month.`,
    );
  }
  if (top && top.share > ratio(s.concentrated_pct)) {
    note(
      "watch",
      "concentration",
      `${pctText(top.share)} of revenue comes from ${top.name}. A slow patch there would be felt everywhere.`,
    );
  }
  if (
    burn &&
    burn.cents > 0 &&
    runway &&
    runway.months !== null &&
    runway.months < s.runway_watch_months
  ) {
    note(
      "watch",
      "runway",
      `Under ${s.runway_watch_months} months of runway at ${money(burn.cents)} a month going out.`,
    );
  }

  // What to do about it.
  if (top && top.share > ratio(s.grow_lines_pct)) {
    note("action", "lines", "Grow your smaller lines, so less rests on one of them.");
  }
  if (margins.gross !== null && margins.gross < ratio(s.check_cogs_pct)) {
    const recent = averageCents(complete.slice(-s.compare_months).map((m) => m.income));
    const lift = Math.round((recent * 12 * s.margin_lift_pct) / 100);
    note(
      "action",
      "cogs",
      `Look at what your goods cost you: ${s.margin_lift_pct} points more margin would add about ${money(lift)} of gross profit a year.`,
    );
  }

  return {
    complete,
    partial,
    burn,
    runway,
    growth: {
      ...growth,
      standing: growth.growth === null ? null : growthStanding(growth.growth, s),
    },
    margins: {
      ...margins,
      standing: margins.gross === null ? null : marginStanding(margins.gross, s),
    },
    concentration: top ? { ...top, standing: concentrationStanding(top.share, s) } : null,
    notes,
  };
}

const plural = (months: number) => (months === 1 ? "month" : `${months} months`);
