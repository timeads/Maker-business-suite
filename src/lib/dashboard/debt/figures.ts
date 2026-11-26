import { sameAccount, varianceStanding, type BudgetRow } from "../budget";
import { averageCents, type BookMonth, type Standing } from "../health";
import { STRATEGY_META, type PlanDebt } from "./engine";
import type { DebtSettings, DebtStatus } from "./settings";

/**
 * The figures around the plan, from the earlier dashboard's Debt Tracker,
 * Financial Advisor and Budget (`DebtTracker.tsx`, `useAdvisorInsights.ts`,
 * `FinancialAdvisor.tsx`, `useBudget.ts`), on whole cents. Pure. Only ever
 * worked out for someone the database let read the debts (owners and
 * admins); for anyone else there are no debts to work them out from.
 */

/** A debt as the pages hold it: what was typed in, with its balance worked out on read. */
export type Debt = {
  id: string;
  name: string;
  kind: string;
  plan: PlanDebt["plan"];
  status: DebtStatus;
  rateBp: number;
  minimum: number;
  payment: number | null;
  revolvingBp: number | null;
  dueDay: number | null;
  priority: number | null;
  opening: number | null;
  booksAccount: string | null;
  note: string | null;
  /** From the books' balance sheet (its balance is the books'), or typed in. */
  source: "books" | "person";
  /** The books' account it comes from, for "Not a debt". */
  bookAccountId: string | null;
  /** No rate given yet: the plan counts it at 0% (`rateBp` is 0) and says so. */
  needsRate: boolean;
  /** The latest balance a person or the books gave; null when none yet. */
  balance: number | null;
  balanceAsOf: string | null;
  balanceFrom: "person" | "books" | null;
};

/** The monthly payment the dashboard counts: the payment, else the minimum. */
export const usualPayment = (d: Pick<Debt, "payment" | "minimum">) => d.payment ?? d.minimum;

export const owing = (d: Debt) => d.status !== "closed" && (d.balance ?? 0) > 0;

export function toPlanDebt(d: Debt): PlanDebt {
  return {
    id: d.id,
    name: d.name,
    balance: Math.max(0, d.balance ?? 0),
    rateBp: d.rateBp,
    minimum: d.minimum,
    payment: d.payment,
    plan: d.plan,
    revolvingBp: d.revolvingBp,
    priority: d.priority,
    active: d.status === "active",
  };
}

export type DebtTotals = {
  /** Everything owed now. */
  owed: number;
  /** Starting balances less what's owed, for debts with a starting balance. */
  paidOff: number;
  /** The usual payments of debts still owing, a month. */
  monthly: number;
};

/**
 * The tracker's totals. Paid off so far = starting balances less what's
 * owed, over the debts given a starting balance (the dashboard sums every
 * debt's; one with none would count as paid off below zero). Monthly
 * payments count debts still owing (the dashboard counts every debt's,
 * closed ones too).
 */
export function debtTotals(debts: readonly Debt[]): DebtTotals {
  const live = debts.filter((d) => d.status !== "closed");
  return {
    owed: live.reduce((s, d) => s + Math.max(0, d.balance ?? 0), 0),
    paidOff: debts
      .filter((d) => d.opening !== null)
      .reduce((s, d) => s + Math.max(0, (d.opening ?? 0) - Math.max(0, d.balance ?? 0)), 0),
    monthly: debts.filter(owing).reduce((s, d) => s + usualPayment(d), 0),
  };
}

// ---------------------------------------------------------------------------
// The emergency fund
// ---------------------------------------------------------------------------

/**
 * The business's usual month of expenses: operating plus other expenses,
 * averaged over the last twelve complete months (the dashboard averages its
 * last twelve months of the books, the one in progress included; only
 * complete months count here, as everywhere else in Money).
 */
export function usualMonthlyExpenses(complete: readonly BookMonth[]): number {
  const recent = complete.slice(-12);
  return Math.max(0, averageCents(recent.map((m) => m.expenses + (m.otherExpenses ?? 0))));
}

export type EmergencyFund = {
  target: number;
  targetFrom: "amount" | "months";
  usualMonth: number | null;
  current: number;
  currentFrom: "books" | "typed" | "none";
  /** Accounts chosen that the latest balance sheet didn't have. */
  missing: string[];
  /** 0–1. */
  progress: number;
};

export function emergencyFund(
  settings: DebtSettings,
  complete: readonly BookMonth[],
  bankAccounts: readonly { name: string; cents: number }[] | null,
): EmergencyFund {
  const usualMonth = settings.emergency_target === "months" ? usualMonthlyExpenses(complete) : null;
  const target =
    settings.emergency_target === "months"
      ? (usualMonth ?? 0) * settings.emergency_months
      : settings.emergency_target_cents;
  let current = 0;
  let currentFrom: EmergencyFund["currentFrom"] = "none";
  const missing: string[] = [];
  if (settings.emergency_accounts.length > 0) {
    currentFrom = "books";
    for (const name of settings.emergency_accounts) {
      const found = (bankAccounts ?? []).filter((a) => sameAccount(a.name, name));
      if (found.length === 0) missing.push(name);
      // The dashboard takes the account's balance as a positive amount.
      current += found.reduce((s, a) => s + Math.abs(a.cents), 0);
    }
  } else if (settings.emergency_current_cents !== null) {
    current = settings.emergency_current_cents;
    currentFrom = "typed";
  }
  return {
    target,
    targetFrom: settings.emergency_target,
    usualMonth,
    current,
    currentFrom,
    missing,
    progress: target > 0 ? Math.min(1, current / target) : 0,
  };
}

// ---------------------------------------------------------------------------
// The two cash health tiles, their notes, and "after the debt"
// ---------------------------------------------------------------------------

export type DebtHealth = {
  owed: number;
  monthly: number;
  /** Debt ÷ the last twelve complete months' revenue; null with no revenue. */
  toRevenue: { share: number; standing: Standing; revenue: number } | null;
  /** (Average operating profit + payments) ÷ payments; null `times` means nothing to pay. */
  coverage: { times: number | null; standing: Standing; profit: number };
  notes: { tone: "win" | "watch" | "action"; key: string; text: string }[];
};

export function debtHealth(input: {
  debts: readonly Debt[];
  complete: readonly BookMonth[];
  /** The recent window cash health uses. */
  compareMonths: number;
  /** Operating margin over twelve months, from cash health; null when unknown. */
  operatingMargin: number | null;
  settings: DebtSettings;
  money: (cents: number) => string;
}): DebtHealth {
  const s = input.settings;
  const totals = debtTotals(input.debts);
  const revenue = input.complete.slice(-12).reduce((sum, m) => sum + m.income, 0);
  const recent = input.complete.slice(-input.compareMonths);
  const profit = averageCents(recent.map((m) => m.income - m.cogs - m.expenses));
  const share = revenue > 0 ? totals.owed / revenue : null;
  const toRevenue =
    share === null
      ? null
      : {
          share,
          revenue,
          standing: (share < s.debt_revenue_good_pct / 100
            ? "good"
            : share < s.debt_revenue_watch_pct / 100
              ? "watch"
              : "bad") as Standing,
        };
  const times = totals.monthly > 0 ? (profit + totals.monthly) / totals.monthly : null;
  const coverage = {
    times,
    profit,
    standing: (times === null || times > s.coverage_good_x100 / 100
      ? "good"
      : times > s.coverage_watch_x100 / 100
        ? "watch"
        : "bad") as Standing,
  };

  const notes: DebtHealth["notes"] = [];
  const freed = input.debts
    .filter((d) => d.status === "active" && d.plan === "pool" && (d.balance ?? 0) > 0)
    .reduce((sum, d) => sum + d.minimum, 0);
  if (times !== null && times > s.coverage_good_x100 / 100) {
    notes.push({
      tone: "win",
      key: "debt-coverage",
      text: `Your debt payments are comfortably covered: profit covers them ${times.toFixed(2)} times over.`,
    });
  }
  if (share !== null && share > s.high_debt_pct / 100) {
    notes.push({
      tone: "watch",
      key: "debt-load",
      text: `What you owe is ${(share * 100).toFixed(0)}% of a year's revenue. That's a lot to carry, so the plan matters.`,
    });
  }
  if (totals.monthly > 0) {
    notes.push({
      tone: "action",
      key: "debt-plan",
      text: `Keep going with the ${STRATEGY_META[s.strategy].label.toLowerCase()} plan: it frees ${input.money(freed)} a month as the debts it pays down are cleared.`,
    });
  }
  if (
    input.operatingMargin !== null &&
    input.operatingMargin > s.extra_margin_pct / 100 &&
    share !== null &&
    share > s.extra_debt_pct / 100
  ) {
    notes.push({
      tone: "action",
      key: "debt-extra",
      text: "When a month runs ahead, sending the extra to the highest-rate debt shortens the plan.",
    });
  }
  return { owed: totals.owed, monthly: totals.monthly, toRevenue, coverage, notes };
}

export type AfterDebt = {
  /** Months until the plan's debts are gone; null when it never gets there. */
  months: number | null;
  /** The pool debts' minimums, freed once they're gone. */
  freed: number;
  /** Average operating profit over the recent months. */
  profitNow: number;
  profitAfter: number;
  /** Payments ÷ average revenue over the recent months; null with no revenue. */
  shareOfRevenue: number | null;
};

/** What monthly profit looks like once the payments are freed (the advisor's "post-debt"). */
export function afterDebt(input: {
  debts: readonly Debt[];
  complete: readonly BookMonth[];
  compareMonths: number;
  monthsToFreedom: number | null;
}): AfterDebt {
  const recent = input.complete.slice(-input.compareMonths);
  const profitNow = averageCents(recent.map((m) => m.income - m.cogs - m.expenses));
  const revenue = averageCents(recent.map((m) => m.income));
  const freed = input.debts
    .filter((d) => d.status === "active" && d.plan === "pool" && (d.balance ?? 0) > 0)
    .reduce((s, d) => s + d.minimum, 0);
  const monthly = debtTotals(input.debts).monthly;
  return {
    months: input.monthsToFreedom,
    freed,
    profitNow,
    profitAfter: profitNow + freed,
    shareOfRevenue: revenue > 0 ? monthly / revenue : null,
  };
}

// ---------------------------------------------------------------------------
// Debt rows in the budget
// ---------------------------------------------------------------------------

export const DEBT_GROUP = "Debt payments";
export const DEBT_ROW_PREFIX = "debt:";

/**
 * One budget row per debt (the dashboard's synthetic "Debt Service" rows):
 * each month, what the books show was paid into the debt's own account (its
 * card or loan account in the books, the moves the sync keeps aside), or,
 * where nothing was booked yet for a debt still owing, its usual payment
 * for any month already begun, marked as an estimate. The budget is the
 * usual payment for each month of the period while the debt is owed. A row
 * with nothing paid and nothing budgeted is left out. They count as fixed
 * costs in break-even, as in the dashboard.
 */
export function debtBudgetRows(input: {
  debts: readonly Debt[];
  /** What the books show paid into each debt's account, per month. */
  paid: readonly { debtId: string; month: string; cents: number }[];
  months: readonly string[];
  /** The month in progress. */
  current: string;
  warnPct: number;
}): BudgetRow[] {
  const rows: BudgetRow[] = [];
  for (const d of input.debts) {
    if (d.status === "closed") continue;
    const pay = usualPayment(d);
    const active = d.status === "active" && (d.balance ?? 0) > 0;
    const booked = new Map<string, number>();
    for (const p of input.paid) {
      if (p.debtId === d.id) booked.set(p.month, (booked.get(p.month) ?? 0) + p.cents);
    }
    let actual = 0;
    let estimated = 0;
    for (const month of input.months) {
      const got = booked.get(month) ?? 0;
      if (got > 0) actual += got;
      else if (active && month <= input.current) {
        actual += pay;
        estimated++;
      }
    }
    const budget = active ? pay * input.months.length : 0;
    if (actual <= 0 && budget <= 0) continue;
    rows.push({
      key: `${DEBT_ROW_PREFIX}${d.id}`,
      group: DEBT_GROUP,
      name: d.name,
      average: pay,
      budget,
      budgeted: active ? input.months.length : 0,
      actual,
      variance: actual - budget,
      share: budget > 0 ? (actual - budget) / budget : null,
      standing: varianceStanding(actual, budget, input.warnPct),
      variable: false,
      hidden: false,
      debt: { estimatedMonths: estimated },
    });
  }
  return rows;
}

/** Each payment the books show into a debt's own account, matched by that account's name. */
export function matchPayments<T extends { account: string | null }>(
  moves: readonly T[],
  debts: readonly Pick<Debt, "id" | "booksAccount">[],
): (T & { debtId: string })[] {
  const out: (T & { debtId: string })[] = [];
  for (const move of moves) {
    if (!move.account) continue;
    const debt = debts.find((d) => d.booksAccount && sameAccount(d.booksAccount, move.account!));
    if (debt) out.push({ ...move, debtId: debt.id });
  }
  return out;
}

/** The 24 months the schedule shows by default, or every month to payoff (at least 12). */
export function scheduleLength(plan: readonly { total: number }[], all: boolean): number {
  if (!all) return Math.min(24, plan.length);
  const lastOwing = plan.map((m) => m.total > 0).lastIndexOf(true);
  return Math.min(plan.length, Math.max(12, lastOwing + 2));
}

/**
 * The home card's debt line (the dashboard's "Debt Snowball Progress" on its
 * home page): what's owed, what's been paid off, and the next debt in line,
 * which is the first active one by its place, as the dashboard names it.
 * Null with nothing owed. Only ever worked out for owners and admins.
 */
export function debtHomeLine(
  debts: readonly Debt[],
  money: (cents: number) => string,
): string | null {
  const totals = debtTotals(debts);
  if (totals.owed <= 0) return null;
  const next = debts
    .filter((d) => d.status === "active" && (d.balance ?? 0) > 0)
    .map((d, at) => ({ d, at }))
    .sort((a, b) => (a.d.priority ?? 99) - (b.d.priority ?? 99) || a.at - b.at)[0]?.d;
  return [
    `${money(totals.owed)} of debt to go`,
    totals.paidOff > 0 ? `${money(totals.paidOff)} paid off so far` : "",
    next ? `next to clear: ${next.name}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
