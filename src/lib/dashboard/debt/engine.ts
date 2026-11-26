/**
 * Debt payoff, ported from the earlier finance dashboard (`debt-engine.ts`,
 * `useDebtProjection.ts`, `useDebtStrategySim.ts`) onto whole cents. Pure:
 * no database, no clock (the first month is handed in), no network.
 *
 * Two models, as in the dashboard, each used where the dashboard uses it:
 *
 * 1. The plan (`projectPlan`, the dashboard's `generatePayoffProjection`):
 *    60 months of the snowball POOL. The pool is only the payments freed as
 *    debts are paid off; it never includes operating profit. Each month the
 *    emergency fund takes its share first (a fixed amount a month, else a
 *    share of the pool, until the target is reached; everything once no
 *    pool debt is left), the rest goes to the first pool debt in priority
 *    order. Fixed-payment debts keep paying their payment; share-of-revenue
 *    debts pay their payment (or a share of average revenue) and never feed
 *    the pool. A pool debt that isn't the target pays only its share-of-
 *    balance minimum (a revolving line), else nothing. Any month's pool or
 *    emergency amount can be set by hand. This drives the chart, the
 *    schedule, the emergency fund's date and each debt's payoff month in the
 *    table.
 *
 * 2. The strategies (`simulate`, the dashboard's `debt-engine.ts`): the pool
 *    debts only, every one paying its minimum, the extra (the plan's pool
 *    budget less those minimums) going to debts in the strategy's order, and
 *    minimums freed by a paid-off debt rolling on from the next month.
 *    Avalanche (highest rate first), snowball (smallest balance first),
 *    hybrid (balances at or under a threshold smallest first, then highest
 *    rate) and custom (the debts' own priority). This drives "this month",
 *    the milestones, the cards per debt and the side-by-side comparison.
 *
 * ROUNDING RULE (one rule, everywhere): every amount is whole cents; a
 * month's interest is balance × annual rate (basis points) ÷ 120,000, and
 * every other share (a share of the pool, of revenue, of a balance) is
 * amount × part ÷ whole, each worked out exactly in integers and rounded
 * to the nearest cent, half a cent up (`shareOf`). Nothing is carried as
 * a fraction of a cent, so the same inputs always give the same cents.
 *
 * Where this differs from the dashboard on purpose (each also noted where
 * it happens): a debt is "paid off" at zero cents rather than under half a
 * cent; a month's cash paid is what was really paid (the dashboard adds
 * interest to principal paid, which overstates the month when a minimum is
 * below that month's interest); and the hybrid threshold compares cents.
 */

export const STRATEGIES = ["avalanche", "snowball", "hybrid", "custom"] as const;
export type Strategy = (typeof STRATEGIES)[number];

export const STRATEGY_META: Record<
  Strategy,
  { label: string; tagline: string; pros: string[]; cons: string[] }
> = {
  avalanche: {
    label: "Avalanche",
    tagline: "Highest rate first",
    pros: ["Pays the least interest", "The plan the arithmetic favours"],
    cons: ["The first payoff can take a while", "Asks for patience"],
  },
  snowball: {
    label: "Snowball",
    tagline: "Smallest balance first",
    pros: ["Early payoffs you can feel", "Fewer bills to juggle sooner"],
    cons: ["Usually a little more interest", "Chosen for momentum, not arithmetic"],
  },
  hybrid: {
    label: "Hybrid",
    tagline: "Small balances, then highest rate",
    pros: ["Quick wins on the tiny ones", "Then the interest-saving order"],
    cons: ["A little more interest than avalanche", "The cut-off is your call"],
  },
  custom: {
    label: "Your own order",
    tagline: "The order you set",
    pros: ["You decide what goes first", "Room for reasons the numbers don't see"],
    cons: ["No promise on interest", "Easy to put the costly one last"],
  },
};

/** The dashboard's hybrid cut-off: balances at or under this go first. */
export const DEFAULT_HYBRID_THRESHOLD = 100_000;
/** 50 years, as the dashboard caps a simulation. */
export const DEFAULT_MAX_MONTHS = 600;
/** The plan's length, as the dashboard projects it. */
export const PLAN_MONTHS = 60;

// ---------------------------------------------------------------------------
// Whole-cent arithmetic
// ---------------------------------------------------------------------------

/**
 * amount × part ÷ whole, to the nearest whole cent, half a cent up (amounts
 * here are never below zero). Exact: worked out in big integers, so a large
 * balance at a high rate has no floating-point drift.
 */
export function shareOf(amount: number, part: number, whole: number): number {
  if (!Number.isInteger(amount) || !Number.isInteger(part) || !Number.isInteger(whole)) {
    throw new Error("shareOf takes whole numbers");
  }
  if (whole <= 0) throw new Error("shareOf needs a positive whole");
  if (amount <= 0 || part <= 0) return 0;
  const product = BigInt(amount) * BigInt(part) * BigInt(2) + BigInt(whole);
  return Number(product / (BigInt(whole) * BigInt(2)));
}

/** One month's interest on a balance at an annual rate in basis points (2299 = 22.99%). */
export const monthlyInterest = (balance: number, rateBp: number) =>
  shareOf(balance, rateBp, 120_000);

/** `YYYY-MM` moved by whole months. */
export function addMonth(month: string, delta: number): string {
  const [year, m] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, m - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

const clean = (cents: number) => (Number.isFinite(cents) ? Math.max(0, Math.round(cents)) : 0);

// ---------------------------------------------------------------------------
// The strategies (debt-engine.ts)
// ---------------------------------------------------------------------------

export type DebtInput = {
  id: string;
  name: string;
  /** Whole cents owed now. */
  balance: number;
  /** Annual rate in basis points. */
  rateBp: number;
  /** Whole cents a month. */
  minimum: number;
  /** Lower goes first; only for the custom order. */
  priority?: number | null;
};

export type SimulationConfig = {
  strategy: Strategy;
  /** The month the simulation starts in, `YYYY-MM`. */
  start: string;
  /** Extra each month, whole cents; ignored where `extraSchedule` has a value. */
  extraMonthly: number;
  /** Extra per month from the start; months past its end take its last value. */
  extraSchedule?: readonly number[];
  hybridThreshold?: number;
  maxMonths?: number;
  /**
   * Whether a paid-off debt's minimum rolls on to the others (the snowball).
   * Off only for the "minimums only" comparison.
   */
  rollover?: boolean;
};

export type SimMonth = {
  index: number;
  month: string;
  /** Owed at the end of the month. */
  balances: Record<string, number>;
  interest: Record<string, number>;
  minPaid: Record<string, number>;
  extraPaid: Record<string, number>;
  totalBalance: number;
  totalInterest: number;
  /** Cash paid this month, minimums and extra together. */
  totalPaid: number;
};

export type SimulationResult = {
  strategy: Strategy;
  months: SimMonth[];
  /** Months until the last debt is gone (0 with nothing owed). */
  monthsToFreedom: number;
  /** The month the last debt is paid off, `YYYY-MM`. */
  payoffMonth: string;
  totalInterest: number;
  totalPaid: number;
  /** The month index each debt was paid off in. */
  payoffByDebt: Record<string, number>;
  /** Stopped at the limit with money still owed. */
  capped: boolean;
};

/**
 * The order extra money goes in. Sorted once, at the start, on the starting
 * balances, as the dashboard does; ties keep the order the debts came in.
 */
export function attackOrder<T extends DebtInput>(
  debts: readonly T[],
  strategy: Strategy,
  hybridThreshold = DEFAULT_HYBRID_THRESHOLD,
): T[] {
  const rank = (d: DebtInput): [number, number] => {
    switch (strategy) {
      case "avalanche":
        return [0, -d.rateBp];
      case "snowball":
        return [0, d.balance];
      case "hybrid":
        return d.balance <= hybridThreshold ? [0, d.balance] : [1, -d.rateBp];
      case "custom":
        return [0, d.priority ?? 9999];
    }
  };
  return debts
    .map((debt, at) => ({ debt, at, key: rank(debt) }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.at - b.at)
    .map((one) => one.debt);
}

export function simulate(debts: readonly DebtInput[], config: SimulationConfig): SimulationResult {
  const maxMonths = config.maxMonths ?? DEFAULT_MAX_MONTHS;
  const rollover = config.rollover ?? true;
  const working = debts.map((d) => ({
    id: d.id,
    balance: clean(d.balance),
    rateBp: clean(d.rateBp),
    minimum: clean(d.minimum),
  }));
  const byId = new Map(working.map((w) => [w.id, w]));
  const ordered = attackOrder(
    debts.map((d) => ({ ...d, balance: clean(d.balance), rateBp: clean(d.rateBp) })),
    config.strategy,
    config.hybridThreshold,
  );

  const payoffByDebt: Record<string, number> = {};
  const months: SimMonth[] = [];
  let totalInterest = 0;
  let totalPaid = 0;
  let m = 0;

  while (m < maxMonths) {
    const interest: Record<string, number> = {};
    const minPaid: Record<string, number> = {};
    const extraPaid: Record<string, number> = {};
    let allZero = true;

    for (const d of working) {
      interest[d.id] = 0;
      minPaid[d.id] = 0;
      extraPaid[d.id] = 0;
      if (d.balance <= 0) continue;
      allZero = false;
      const charge = monthlyInterest(d.balance, d.rateBp);
      d.balance += charge;
      interest[d.id] = charge;
    }
    if (allZero) break;

    const extra = config.extraSchedule?.length
      ? clean(config.extraSchedule[Math.min(m, config.extraSchedule.length - 1)])
      : clean(config.extraMonthly);
    let pool = extra;
    for (const d of working) {
      if (d.balance <= 0) {
        if (rollover) pool += d.minimum;
        continue;
      }
      const pay = Math.min(d.minimum, d.balance);
      d.balance -= pay;
      minPaid[d.id] = pay;
      totalPaid += pay;
    }
    for (const target of ordered) {
      if (pool <= 0) break;
      const w = byId.get(target.id);
      if (!w || w.balance <= 0) continue;
      const pay = Math.min(pool, w.balance);
      w.balance -= pay;
      pool -= pay;
      extraPaid[w.id] += pay;
      totalPaid += pay;
    }
    for (const d of working) {
      if (d.balance <= 0 && payoffByDebt[d.id] === undefined) payoffByDebt[d.id] = m;
    }

    const totalBalance = working.reduce((s, d) => s + d.balance, 0);
    const monthInterest = Object.values(interest).reduce((s, v) => s + v, 0);
    const monthPaid =
      Object.values(minPaid).reduce((s, v) => s + v, 0) +
      Object.values(extraPaid).reduce((s, v) => s + v, 0);
    totalInterest += monthInterest;
    months.push({
      index: m,
      month: addMonth(config.start, m),
      balances: Object.fromEntries(working.map((d) => [d.id, d.balance])),
      interest,
      minPaid,
      extraPaid,
      totalBalance,
      totalInterest: monthInterest,
      totalPaid: monthPaid,
    });
    m++;
    if (totalBalance <= 0) break;
  }

  const monthsToFreedom = months.length;
  const lastBalance = months.at(-1)?.totalBalance ?? 0;
  return {
    strategy: config.strategy,
    months,
    monthsToFreedom,
    payoffMonth: addMonth(config.start, Math.max(0, monthsToFreedom - 1)),
    totalInterest,
    totalPaid,
    payoffByDebt,
    capped: m >= maxMonths && lastBalance > 0,
  };
}

export type ScheduleRow = {
  id: string;
  name: string;
  startBalance: number;
  interest: number;
  minPaid: number;
  extraPaid: number;
  totalPaid: number;
  endBalance: number;
  isTarget: boolean;
  paidOff: boolean;
};

export type ScheduleMonth = {
  index: number;
  month: string;
  targetId: string | null;
  targetName: string | null;
  rows: ScheduleRow[];
  totals: {
    minPaid: number;
    extraPaid: number;
    interest: number;
    totalPaid: number;
    endBalance: number;
  };
};

/**
 * Month by month, what each debt was paid and which one the extra went to
 * (the dashboard's `buildPaymentSchedule`): the target is the first debt in
 * the strategy's order still owing at the start of the month.
 */
export function paymentSchedule(
  sim: SimulationResult,
  debts: readonly DebtInput[],
  hybridThreshold = DEFAULT_HYBRID_THRESHOLD,
): ScheduleMonth[] {
  const ordered = attackOrder(debts, sim.strategy, hybridThreshold);
  const start: Record<string, number> = Object.fromEntries(
    debts.map((d) => [d.id, clean(d.balance)]),
  );
  return sim.months.map((m) => {
    const target = ordered.find((d) => (start[d.id] ?? 0) > 0) ?? null;
    const rows = debts
      .map((d): ScheduleRow => {
        const minPaid = m.minPaid[d.id] ?? 0;
        const extraPaid = m.extraPaid[d.id] ?? 0;
        const startBalance = start[d.id] ?? 0;
        const endBalance = m.balances[d.id] ?? 0;
        return {
          id: d.id,
          name: d.name,
          startBalance,
          interest: m.interest[d.id] ?? 0,
          minPaid,
          extraPaid,
          totalPaid: minPaid + extraPaid,
          endBalance,
          isTarget: d.id === target?.id && extraPaid > 0,
          paidOff: startBalance > 0 && endBalance <= 0,
        };
      })
      .filter((r) => r.startBalance > 0 || r.totalPaid > 0);
    for (const d of debts) start[d.id] = m.balances[d.id] ?? 0;
    const sum = (pick: (r: ScheduleRow) => number) => rows.reduce((s, r) => s + pick(r), 0);
    return {
      index: m.index,
      month: m.month,
      targetId: target?.id ?? null,
      targetName: target?.name ?? null,
      rows,
      totals: {
        minPaid: sum((r) => r.minPaid),
        extraPaid: sum((r) => r.extraPaid),
        interest: sum((r) => r.interest),
        totalPaid: sum((r) => r.totalPaid),
        endBalance: sum((r) => r.endBalance),
      },
    };
  });
}

export type Milestone = {
  id: string;
  name: string;
  index: number;
  month: string;
  /** The minimum it frees each month. */
  freed: number;
  /** Where that minimum goes next; null for the last one. */
  rollsInto: string | null;
};

/** Each pool debt's payoff month and where its freed minimum rolls on to (`PayoffMilestones`). */
export function milestones(
  sim: SimulationResult,
  debts: readonly DebtInput[],
  schedule: readonly ScheduleMonth[],
): Milestone[] {
  return debts
    .flatMap((d) => {
      const index = sim.payoffByDebt[d.id];
      if (index === undefined) return [];
      const next = schedule[index + 1]?.targetName ?? null;
      return [
        {
          id: d.id,
          name: d.name,
          index,
          month: schedule[index]?.month ?? addMonth(sim.months[0]?.month ?? "", index),
          freed: clean(d.minimum),
          rollsInto: next && next !== d.name ? next : null,
        },
      ];
    })
    .sort((a, b) => a.index - b.index);
}

export type DebtCard = {
  id: string;
  name: string;
  startBalance: number;
  rateBp: number;
  payoffIndex: number;
  payoffMonth: string;
  interest: number;
  /** How far along the plan this debt's payoff falls, 0–1. */
  progress: number;
};

/** One card per pool debt, in payoff order (`ByDebtCards`). */
export function debtCards(sim: SimulationResult, debts: readonly DebtInput[]): DebtCard[] {
  return debts
    .map((d) => {
      const payoffIndex = sim.payoffByDebt[d.id] ?? Math.max(0, sim.monthsToFreedom - 1);
      const interest = sim.months.reduce((s, m) => s + (m.interest[d.id] ?? 0), 0);
      return {
        id: d.id,
        name: d.name,
        startBalance: clean(d.balance),
        rateBp: clean(d.rateBp),
        payoffIndex,
        payoffMonth: sim.months[payoffIndex]?.month ?? "",
        interest,
        progress: Math.min(1, (payoffIndex + 1) / Math.max(1, sim.monthsToFreedom)),
      };
    })
    .sort((a, b) => a.payoffIndex - b.payoffIndex);
}

/** The dashboard calls strategies "nearly identical" within $50 of interest and a month. */
export function strategiesConverge(sims: Record<Strategy, SimulationResult>): boolean {
  const interest = STRATEGIES.map((s) => sims[s].totalInterest);
  const months = STRATEGIES.map((s) => sims[s].monthsToFreedom);
  return (
    Math.max(...interest) - Math.min(...interest) < 5_000 &&
    Math.max(...months) - Math.min(...months) <= 1
  );
}

// ---------------------------------------------------------------------------
// The plan (useDebtProjection.ts)
// ---------------------------------------------------------------------------

/**
 * How a debt is paid in the plan (the dashboard decided this from words in
 * the debt's name; here it is the debt's own field):
 * - pool: paid from the snowball pool, and its payment joins the pool once
 *   it is gone;
 * - fixed: keeps paying its fixed payment from the business until done,
 *   then that payment joins the pool;
 * - revenue_share: paid from the business as a share of sales; when done,
 *   that money stays in the business and never joins the pool.
 */
export const PLAN_KINDS = ["pool", "fixed", "revenue_share"] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];

export type PlanDebt = {
  id: string;
  name: string;
  balance: number;
  rateBp: number;
  minimum: number;
  /** The usual monthly payment; null uses the minimum. */
  payment: number | null;
  plan: PlanKind;
  /**
   * A revolving line's least payment as a share of its balance (basis
   * points), paid from the business whether or not it is the target. Null
   * for none. (The dashboard used 1.8% for a name with "loc" in it.)
   */
  revolvingBp: number | null;
  priority: number | null;
  /** Counted in the plan (the dashboard's active, waiting and auto). */
  active: boolean;
};

export type PlanOverride = { pool: number | null; emergency: number | null };

export type PlanInput = {
  debts: readonly PlanDebt[];
  /** The first month, `YYYY-MM` (the month in progress). */
  start: string;
  months?: number;
  /** Average monthly revenue, whole cents, for share-of-revenue debts with no payment. */
  averageRevenue: number;
  /** Whole percent of revenue a share-of-revenue debt takes when it has no payment. */
  revenueSharePct: number;
  emergency: {
    target: number;
    /** What's in the fund now. */
    current: number;
    /** Whole percent of the pool, used when `monthly` is 0. */
    splitPct: number;
    /** A fixed amount a month; 0 uses the split. */
    monthly: number;
  };
  /** Pool and emergency amounts set by hand, by `YYYY-MM`. */
  overrides: ReadonlyMap<string, PlanOverride>;
  /**
   * A what-if's extra a month for the debts, on top of the pool (never part
   * of the saved plan). Once no pool debt is left it is set aside instead.
   */
  extraEachMonth?: number;
};

export type PlanMonth = {
  index: number;
  month: string;
  /** Owed at the end of the month, per debt. */
  balances: Record<string, number>;
  total: number;
  emergencyBalance: number;
  emergencyIn: number;
  /** The pool this month: freed payments only. */
  pool: number;
  /** What the pool has for debts after the emergency share (or the amount set by hand). */
  poolBudget: number;
  poolSpent: number;
  /** A what-if's extra in this month's pool budget (0 in the plan itself). */
  extraIn: number;
  overridden: boolean;
};

const basePayment = (d: PlanDebt) => clean(d.payment ?? d.minimum);

/** Debts the plan counts, in priority order (no priority last, as 99). */
export function planOrder<T extends { priority: number | null; name: string }>(
  debts: readonly T[],
): T[] {
  return debts
    .map((debt, at) => ({ debt, at }))
    .sort((a, b) => (a.debt.priority ?? 99) - (b.debt.priority ?? 99) || a.at - b.at)
    .map((one) => one.debt);
}

export function projectPlan(input: PlanInput): PlanMonth[] {
  const months = input.months ?? PLAN_MONTHS;
  const debts = planOrder(input.debts.filter((d) => d.active && clean(d.balance) > 0)).map((d) => ({
    ...d,
    balance: clean(d.balance),
    rateBp: clean(d.rateBp),
    minimum: clean(d.minimum),
    paidOff: false,
  }));
  // Debts already paid off when the plan starts free their payments at once;
  // a share-of-revenue debt's never joins the pool.
  let freed = input.debts
    .filter((d) => d.active && clean(d.balance) <= 0 && d.plan !== "revenue_share")
    .reduce((s, d) => s + basePayment(d), 0);
  let emergencyBalance = clean(input.emergency.current);
  const target = clean(input.emergency.target);
  const out: PlanMonth[] = [];

  for (let index = 0; index < months; index++) {
    const month = addMonth(input.start, index);
    const override = input.overrides.get(month);
    const pool = freed;
    const setPool = override?.pool ?? null;
    const setEmergency = override?.emergency ?? null;
    const hasPoolDebt = debts.some((d) => !d.paidOff && d.plan === "pool");

    const needed = Math.max(0, target - emergencyBalance);
    let emergencyIn: number;
    if (setEmergency !== null) {
      // Set by hand: may go past the target, never past the pool.
      emergencyIn = Math.min(clean(setEmergency), pool);
    } else if (!hasPoolDebt) {
      // Nothing left for the pool to pay: all of it is set aside.
      emergencyIn = pool;
    } else if (needed > 0) {
      emergencyIn =
        clean(input.emergency.monthly) > 0
          ? Math.min(clean(input.emergency.monthly), needed, pool)
          : Math.min(needed, shareOf(pool, clean(input.emergency.splitPct), 100));
    } else {
      emergencyIn = 0;
    }
    const extra = clean(input.extraEachMonth ?? 0);
    const extraIn = hasPoolDebt ? extra : 0;
    const poolBudget =
      (setPool !== null ? clean(setPool) : Math.max(0, pool - emergencyIn)) + extraIn;
    if (!hasPoolDebt) emergencyIn += extra;
    emergencyBalance += emergencyIn;

    const targetAt = debts.findIndex((d) => !d.paidOff && d.plan === "pool");
    let spent = 0;
    const balances: Record<string, number> = {};
    debts.forEach((d, i) => {
      if (d.paidOff) {
        balances[d.id] = 0;
        return;
      }
      const interest = monthlyInterest(d.balance, d.rateBp);
      const owed = d.balance + interest;
      const revolving = d.revolvingBp
        ? Math.max(d.minimum, shareOf(d.balance, d.revolvingBp, 10_000))
        : 0;
      let payment: number;
      if (d.plan === "fixed") {
        payment = Math.min(owed, basePayment(d));
      } else if (d.plan === "revenue_share") {
        const ops =
          basePayment(d) > 0
            ? basePayment(d)
            : shareOf(clean(input.averageRevenue), clean(input.revenueSharePct), 100);
        payment = Math.min(owed, ops);
      } else if (i === targetAt) {
        const fromPool = Math.max(0, poolBudget - spent);
        payment = Math.min(owed, fromPool + revolving);
        spent += Math.min(fromPool, Math.max(0, payment - revolving));
      } else {
        payment = Math.min(owed, revolving);
      }
      const after = owed - payment;
      if (after <= 0) {
        d.balance = 0;
        d.paidOff = true;
        if (d.plan !== "revenue_share") freed += basePayment(d);
      } else {
        d.balance = after;
      }
      balances[d.id] = d.balance;
    });

    out.push({
      index,
      month,
      balances,
      total: debts.reduce((s, d) => s + d.balance, 0),
      emergencyBalance,
      emergencyIn,
      pool,
      poolBudget,
      poolSpent: spent,
      extraIn,
      overridden: setPool !== null || setEmergency !== null,
    });
  }
  return out;
}

/** The first month the fund reaches its target; null within the plan's months. */
export function emergencyReached(plan: readonly PlanMonth[], target: number): PlanMonth | null {
  return plan.find((m) => m.emergencyBalance >= target) ?? null;
}

/** Each debt's payoff month in the plan; null when it is still owed at the plan's end. */
export function planPayoffs(plan: readonly PlanMonth[], ids: readonly string[]) {
  return new Map(
    ids.map((id) => [id, plan.find((m) => (m.balances[id] ?? Infinity) <= 0)?.month ?? null]),
  );
}

// ---------------------------------------------------------------------------
// Both together (useDebtStrategySim.ts)
// ---------------------------------------------------------------------------

export type DebtPlan = {
  plan: PlanMonth[];
  /** The pool debts the strategies decide between. */
  poolDebts: DebtInput[];
  totalMinimums: number;
  extraSchedule: number[];
  sims: Record<Strategy, SimulationResult>;
  chosen: SimulationResult;
  schedule: ScheduleMonth[];
  /** Every pool debt paying only its own minimum, nothing rolling on. */
  minimumsOnly: SimulationResult;
  /** Interest the chosen plan saves against minimums only; null when minimums never clear the debts. */
  interestSaved: number | null;
};

export function debtPlan(
  input: PlanInput & { strategy: Strategy; hybridThreshold?: number },
): DebtPlan {
  const plan = projectPlan(input);
  const poolDebts: DebtInput[] = planOrder(
    input.debts.filter((d) => d.active && clean(d.balance) > 0 && d.plan === "pool"),
  ).map((d) => ({
    id: d.id,
    name: d.name,
    balance: clean(d.balance),
    rateBp: clean(d.rateBp),
    minimum: clean(d.minimum),
    priority: d.priority ?? 99,
  }));
  const totalMinimums = poolDebts.reduce((s, d) => s + d.minimum, 0);
  // The extra each month: the plan's pool budget (which honours amounts set
  // by hand) less the pool debts' own minimums.
  // A what-if's extra always reaches the debts, even in a month whose pool
  // doesn't yet cover the minimums.
  const extraSchedule = plan.map(
    (m) => Math.max(0, m.poolBudget - m.extraIn - totalMinimums) + m.extraIn,
  );
  const config = {
    start: input.start,
    extraMonthly: 0,
    extraSchedule,
    hybridThreshold: input.hybridThreshold,
  };
  const sims = Object.fromEntries(
    STRATEGIES.map((strategy) => [strategy, simulate(poolDebts, { ...config, strategy })]),
  ) as Record<Strategy, SimulationResult>;
  const chosen = sims[input.strategy];
  const minimumsOnly = simulate(poolDebts, {
    strategy: input.strategy,
    start: input.start,
    extraMonthly: 0,
    rollover: false,
  });
  return {
    plan,
    poolDebts,
    totalMinimums,
    extraSchedule,
    sims,
    chosen,
    schedule: paymentSchedule(chosen, poolDebts, input.hybridThreshold),
    minimumsOnly,
    interestSaved:
      minimumsOnly.capped || chosen.capped
        ? null
        : minimumsOnly.totalInterest - chosen.totalInterest,
  };
}
