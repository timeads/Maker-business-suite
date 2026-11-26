import { describe, expect, it } from "vitest";
import {
  STRATEGIES,
  addMonth,
  attackOrder,
  debtCards,
  debtPlan,
  emergencyReached,
  milestones,
  monthlyInterest,
  paymentSchedule,
  planPayoffs,
  projectPlan,
  shareOf,
  simulate,
  strategiesConverge,
  type DebtInput,
  type PlanDebt,
  type PlanInput,
} from "./engine";

describe("the rounding rule", () => {
  it("rounds a share to the nearest cent, half a cent up", () => {
    expect(shareOf(1, 1, 2)).toBe(1);
    expect(shareOf(3, 1, 2)).toBe(2);
    expect(shareOf(1, 1, 3)).toBe(0);
    expect(shareOf(2, 1, 3)).toBe(1);
    expect(shareOf(0, 5, 7)).toBe(0);
    expect(shareOf(500, 0, 7)).toBe(0);
  });

  it("works a month's interest as balance × rate ÷ 120,000", () => {
    expect(monthlyInterest(100_000, 2_400)).toBe(2_000);
    // 12,345 × 1,999 ÷ 120,000 = 205.647… → 206
    expect(monthlyInterest(12_345, 1_999)).toBe(206);
    // 1 cent at 6% is 0.005 of a cent: rounds to nothing, never a fraction.
    expect(monthlyInterest(1, 600)).toBe(0);
    expect(monthlyInterest(10_000, 600)).toBe(50);
    // 1,000 × 6 ÷ 120,000... exactly half a cent goes up.
    expect(monthlyInterest(10_100, 594)).toBe(50); // 49.995 → 50
  });

  it("has no floating-point drift on large balances", () => {
    // 99,999,999,999 × 99,999 ÷ 120,000 = 83,332,499,999.1666… → 83,332,499,999
    expect(monthlyInterest(99_999_999_999, 99_999)).toBe(83_332_499_999);
    // Done in plain floating point this product passes 2^53 and loses cents.
    expect(Number.isSafeInteger(99_999_999_999 * 99_999)).toBe(false);
  });

  it("refuses anything but whole numbers", () => {
    expect(() => shareOf(1.5, 1, 2)).toThrow();
    expect(() => shareOf(1, 1, 0)).toThrow();
  });

  it("moves months across years", () => {
    expect(addMonth("2026-11", 0)).toBe("2026-11");
    expect(addMonth("2026-11", 2)).toBe("2027-01");
    expect(addMonth("2027-01", -1)).toBe("2026-12");
  });
});

const A: DebtInput = {
  id: "a",
  name: "Card A",
  balance: 50_000,
  rateBp: 0,
  minimum: 10_000,
  priority: 2,
};
const B: DebtInput = {
  id: "b",
  name: "Loan B",
  balance: 100_000,
  rateBp: 0,
  minimum: 10_000,
  priority: 1,
};

describe("the strategies' order", () => {
  const small = { id: "s", name: "Small", balance: 40_000, rateBp: 900, minimum: 0, priority: 3 };
  const big = { id: "g", name: "Big", balance: 900_000, rateBp: 2_499, minimum: 0, priority: 1 };
  const mid = { id: "m", name: "Mid", balance: 200_000, rateBp: 1_500, minimum: 0, priority: 2 };
  const all = [small, big, mid];
  const ids = (list: DebtInput[]) => list.map((d) => d.id);

  it("avalanche goes highest rate first", () => {
    expect(ids(attackOrder(all, "avalanche"))).toEqual(["g", "m", "s"]);
  });
  it("snowball goes smallest balance first", () => {
    expect(ids(attackOrder(all, "snowball"))).toEqual(["s", "m", "g"]);
  });
  it("hybrid clears balances at or under the cut-off first, then highest rate", () => {
    expect(ids(attackOrder(all, "hybrid"))).toEqual(["s", "g", "m"]);
    expect(ids(attackOrder(all, "hybrid", 200_000))).toEqual(["s", "m", "g"]);
  });
  it("custom follows the debts' own priority, none last", () => {
    expect(ids(attackOrder([...all, { ...small, id: "x", priority: null }], "custom"))).toEqual([
      "g",
      "m",
      "s",
      "x",
    ]);
  });
  it("keeps the order they came in on a tie", () => {
    expect(ids(attackOrder([A, B], "avalanche"))).toEqual(["a", "b"]);
  });
});

describe("a simulation", () => {
  it("pays minimums, sends the extra in order and rolls a freed minimum on next month", () => {
    const sim = simulate([A, B], { strategy: "snowball", start: "2026-11", extraMonthly: 10_000 });
    expect(sim.months.map((m) => [m.balances.a, m.balances.b])).toEqual([
      [30_000, 90_000],
      [10_000, 80_000],
      // A clears on its minimum; the extra moves straight on to B.
      [0, 60_000],
      // A's minimum now rolls on to B as well.
      [0, 30_000],
      [0, 0],
    ]);
    expect(sim.monthsToFreedom).toBe(5);
    expect(sim.payoffMonth).toBe("2027-03");
    expect(sim.payoffByDebt).toEqual({ a: 2, b: 4 });
    expect(sim.totalInterest).toBe(0);
    expect(sim.totalPaid).toBe(150_000);
    expect(sim.capped).toBe(false);
  });

  it("charges interest first, on the balance owed, and every cent paid is balance or interest", () => {
    const debt = { id: "c", name: "Card", balance: 250_000, rateBp: 2_299, minimum: 7_500 };
    const sim = simulate([debt], { strategy: "avalanche", start: "2026-11", extraMonthly: 2_500 });
    // Month one: 250,000 × 2,299 ÷ 120,000 = 4,789.58 → 4,790; then 10,000 paid.
    expect(sim.months[0].interest.c).toBe(4_790);
    expect(sim.months[0].balances.c).toBe(250_000 + 4_790 - 10_000);
    expect(sim.totalPaid).toBe(250_000 + sim.totalInterest);
    for (const m of sim.months) expect(Number.isInteger(m.balances.c)).toBe(true);
    expect(sim.months.at(-1)!.balances.c).toBe(0);
  });

  it("takes each month's extra from a schedule, its last value after its end", () => {
    const sim = simulate([B], {
      strategy: "avalanche",
      start: "2026-11",
      extraMonthly: 999_999,
      extraSchedule: [0, 20_000],
    });
    expect(sim.months.map((m) => m.balances.b)).toEqual([90_000, 60_000, 30_000, 0]);
  });

  it("stops at the limit and says so when the minimum never covers the interest", () => {
    const debt = { id: "d", name: "Loan", balance: 100_000, rateBp: 2_400, minimum: 1_000 };
    const sim = simulate([debt], {
      strategy: "avalanche",
      start: "2026-11",
      extraMonthly: 0,
      maxMonths: 12,
    });
    expect(sim.months).toHaveLength(12);
    expect(sim.capped).toBe(true);
    expect(sim.months[0].balances.d).toBe(101_000);
    // Cash paid in a month is what was paid, never interest counted as principal.
    expect(sim.months[0].totalPaid).toBe(1_000);
  });

  it("is empty with nothing owed", () => {
    const sim = simulate([{ ...A, balance: 0 }], {
      strategy: "snowball",
      start: "2026-11",
      extraMonthly: 5,
    });
    expect(sim.months).toEqual([]);
    expect(sim.monthsToFreedom).toBe(0);
    expect(sim.payoffMonth).toBe("2026-11");
  });

  it("with nothing rolling on, each debt pays only its own minimum", () => {
    const rolling = simulate([A, B], { strategy: "snowball", start: "2026-11", extraMonthly: 0 });
    const flat = simulate([A, B], {
      strategy: "snowball",
      start: "2026-11",
      extraMonthly: 0,
      rollover: false,
    });
    expect(rolling.payoffByDebt).toEqual({ a: 4, b: 7 });
    expect(flat.payoffByDebt).toEqual({ a: 4, b: 9 });
  });
});

describe("the schedule, milestones and cards", () => {
  const sim = simulate([A, B], { strategy: "snowball", start: "2026-11", extraMonthly: 10_000 });
  const schedule = paymentSchedule(sim, [A, B]);

  it("names the debt the extra goes to and splits minimum from extra", () => {
    expect(schedule[0].targetName).toBe("Card A");
    expect(schedule[0].totals).toEqual({
      minPaid: 20_000,
      extraPaid: 10_000,
      interest: 0,
      totalPaid: 30_000,
      endBalance: 120_000,
    });
    expect(schedule[0].rows.find((r) => r.id === "a")!.isTarget).toBe(true);
    // Month three: A clears on its minimum, so the extra lands on B.
    const third = schedule[2];
    expect(third.rows.find((r) => r.id === "a")).toMatchObject({ paidOff: true, isTarget: false });
    expect(third.rows.find((r) => r.id === "b")!.extraPaid).toBe(10_000);
    expect(schedule[3].targetName).toBe("Loan B");
    expect(schedule[3].rows.map((r) => r.id)).toEqual(["b"]);
    expect(schedule[3].totals.extraPaid).toBe(20_000);
  });

  it("lists payoffs in order with where each freed minimum goes", () => {
    expect(milestones(sim, [A, B], schedule)).toEqual([
      { id: "a", name: "Card A", index: 2, month: "2027-01", freed: 10_000, rollsInto: "Loan B" },
      { id: "b", name: "Loan B", index: 4, month: "2027-03", freed: 10_000, rollsInto: null },
    ]);
  });

  it("gives each debt its payoff month, interest and place in the plan", () => {
    const cards = debtCards(sim, [B, A]);
    expect(cards.map((c) => [c.id, c.payoffMonth, c.interest, c.progress])).toEqual([
      ["a", "2027-01", 0, 3 / 5],
      ["b", "2027-03", 0, 1],
    ]);
  });
});

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

const debt = (over: Partial<PlanDebt> & Pick<PlanDebt, "id">): PlanDebt => ({
  name: over.id,
  balance: 0,
  rateBp: 0,
  minimum: 0,
  payment: null,
  plan: "pool",
  revolvingBp: null,
  priority: null,
  active: true,
  ...over,
});

const PLAN: PlanInput = {
  start: "2026-11",
  months: 8,
  averageRevenue: 100_000,
  revenueSharePct: 7,
  emergency: { target: 10_000, current: 0, splitPct: 30, monthly: 0 },
  overrides: new Map(),
  debts: [
    debt({ id: "fixed", plan: "fixed", balance: 30_000, payment: 10_000 }),
    debt({ id: "p1", balance: 50_000, minimum: 2_000, priority: 1 }),
    debt({ id: "p2", balance: 100_000, minimum: 3_000, priority: 2 }),
    debt({ id: "share", plan: "revenue_share", balance: 20_000 }),
    // Already paid off: its payment is in the pool from the first month.
    debt({ id: "done", balance: 0, payment: 5_000 }),
    // Paid off but a share of revenue: never joins the pool.
    debt({ id: "done-share", plan: "revenue_share", balance: 0, payment: 9_000 }),
    // Not in the plan at all.
    debt({ id: "paused", balance: 70_000, minimum: 1_000, active: false }),
  ],
};

describe("the plan", () => {
  const plan = projectPlan(PLAN);

  it("starts the pool with payments already freed, never a share-of-revenue debt's", () => {
    expect(plan[0].pool).toBe(5_000);
    expect(plan[0].balances).not.toHaveProperty("paused");
  });

  it("sets the emergency share aside first, then pays the first pool debt by priority", () => {
    expect(plan.slice(0, 3).map((m) => [m.emergencyIn, m.emergencyBalance, m.poolBudget])).toEqual([
      [1_500, 1_500, 3_500],
      [1_500, 3_000, 3_500],
      [1_500, 4_500, 3_500],
    ]);
    expect(plan.slice(0, 3).map((m) => m.balances.p1)).toEqual([46_500, 43_000, 39_500]);
    // Not the target and not revolving: nothing paid, as the dashboard has it.
    expect(plan[2].balances.p2).toBe(100_000);
  });

  it("keeps fixed and share-of-revenue debts paying from the business", () => {
    expect(plan.slice(0, 3).map((m) => m.balances.fixed)).toEqual([20_000, 10_000, 0]);
    // No payment set: 7% of 1,000.00 average revenue.
    expect(plan.slice(0, 3).map((m) => m.balances.share)).toEqual([13_000, 6_000, 0]);
  });

  it("adds a fixed debt's payment to the pool once it's paid, never a share-of-revenue one", () => {
    expect(plan[3].pool).toBe(15_000);
    expect(plan.slice(3, 6).map((m) => [m.emergencyIn, m.emergencyBalance, m.poolBudget])).toEqual([
      [4_500, 9_000, 10_500],
      [1_000, 10_000, 14_000],
      // The target is reached: everything goes to debts.
      [0, 10_000, 15_000],
    ]);
    expect(plan.slice(3, 6).map((m) => m.balances.p1)).toEqual([29_000, 15_000, 0]);
    expect(plan[6].pool).toBe(17_000);
    expect(plan[6].balances.p2).toBe(83_000);
    expect(emergencyReached(plan, 10_000)?.month).toBe("2027-03");
  });

  it("knows each debt's payoff month, and null for one still owed", () => {
    const payoffs = planPayoffs(plan, ["fixed", "p1", "p2"]);
    expect(payoffs.get("fixed")).toBe("2027-01");
    expect(payoffs.get("p1")).toBe("2027-04");
    expect(payoffs.get("p2")).toBeNull();
  });

  it("sends the whole pool to the fund once no pool debt is left", () => {
    const only = projectPlan({
      ...PLAN,
      months: 2,
      debts: [
        debt({ id: "done", balance: 0, payment: 5_000 }),
        debt({ id: "fx", plan: "fixed", balance: 50_000, payment: 1_000 }),
      ],
    });
    expect(only.map((m) => m.emergencyIn)).toEqual([5_000, 5_000]);
  });

  it("uses a fixed monthly amount for the fund ahead of the split", () => {
    const fixed = projectPlan({
      ...PLAN,
      months: 1,
      emergency: { ...PLAN.emergency, monthly: 4_000 },
    });
    expect(fixed[0].emergencyIn).toBe(4_000);
    expect(fixed[0].poolBudget).toBe(1_000);
  });

  it("follows amounts set by hand for a month", () => {
    const set = projectPlan({
      ...PLAN,
      months: 2,
      overrides: new Map([["2026-12", { pool: 0, emergency: 9_000 }]]),
    });
    // The fund can't take more than the pool has; the pool's own amount isn't capped.
    expect(set[1]).toMatchObject({ emergencyIn: 5_000, poolBudget: 0, overridden: true });
    expect(set[1].balances.p1).toBe(46_500);
  });

  it("charges interest and takes a revolving line's share of its balance every month", () => {
    const run = projectPlan({
      ...PLAN,
      months: 1,
      debts: [
        debt({ id: "first", balance: 10_000, priority: 1 }),
        debt({
          id: "line",
          balance: 120_000,
          rateBp: 1_200,
          minimum: 1_000,
          revolvingBp: 180,
          priority: 2,
        }),
      ],
    });
    // 1,200.00 at 12%: 12.00 interest; 1.8% of the balance is 21.60, above the 10.00 minimum.
    expect(run[0].balances.line).toBe(120_000 + 1_200 - 2_160);
  });
});

describe("the plan and the strategies together", () => {
  const input = {
    ...PLAN,
    months: 60,
    strategy: "avalanche" as const,
    debts: [
      debt({ id: "done", balance: 0, payment: 20_000 }),
      debt({
        id: "c1",
        name: "Card one",
        balance: 300_000,
        rateBp: 2_499,
        minimum: 9_000,
        priority: 2,
      }),
      debt({
        id: "c2",
        name: "Card two",
        balance: 80_000,
        rateBp: 1_299,
        minimum: 3_000,
        priority: 1,
      }),
      debt({ id: "fx", plan: "fixed", balance: 200_000, payment: 10_000 }),
    ],
  };
  const result = debtPlan(input);

  it("runs only the pool debts through the strategies", () => {
    expect(result.poolDebts.map((d) => d.id)).toEqual(["c2", "c1"]);
    expect(result.totalMinimums).toBe(12_000);
    expect(Object.keys(result.sims)).toEqual([...STRATEGIES]);
    expect(result.chosen).toBe(result.sims.avalanche);
  });

  it("gives the strategies the plan's pool budget less the minimums", () => {
    expect(result.extraSchedule[0]).toBe(Math.max(0, result.plan[0].poolBudget - 12_000));
    expect(result.extraSchedule).toHaveLength(60);
  });

  it("finds avalanche never pays more interest than snowball", () => {
    expect(result.sims.avalanche.totalInterest).toBeLessThanOrEqual(
      result.sims.snowball.totalInterest,
    );
  });

  it("says what the plan saves against paying minimums only", () => {
    expect(result.interestSaved).toBe(
      result.minimumsOnly.totalInterest - result.chosen.totalInterest,
    );
    expect(result.interestSaved!).toBeGreaterThan(0);
  });

  it("calls the strategies nearly identical only when they are", () => {
    expect(strategiesConverge(result.sims)).toBe(false);
    const one = debtPlan({
      ...input,
      debts: [debt({ id: "only", balance: 50_000, rateBp: 1_000, minimum: 5_000 })],
    });
    expect(strategiesConverge(one.sims)).toBe(true);
  });

  it("is the same every time from the same figures", () => {
    expect(debtPlan(input)).toEqual(result);
  });
});
