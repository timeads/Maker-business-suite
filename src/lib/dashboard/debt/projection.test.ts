import { describe, expect, it } from "vitest";
import { projectPlan, type PlanDebt } from "./engine";
import { payoffProjection, projectionLength } from "./projection";

/** Made-up debts: nothing here is a real lender, bank or account. */
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

const words = {
  monthWords: (month: string) => month,
  money: (cents: number) => `$${cents / 100}`,
};

describe("the payoff projection, a chart per debt", () => {
  const debts = [
    debt({ id: "slow", name: "Van loan", balance: 60000, minimum: 10000, priority: 1 }),
    debt({ id: "plan", name: "Card plan", balance: 30000, payment: 10000, plan: "fixed" }),
    debt({ id: "none", name: "Closed card", balance: 5000, active: false }),
  ];
  const plan = projectPlan({
    debts,
    start: "2026-11",
    averageRevenue: 0,
    revenueSharePct: 10,
    emergency: { target: 20000, current: 0, splitPct: 50, monthly: 0 },
    overrides: new Map(),
  });
  const projection = payoffProjection({ plan, debts, fundTarget: 20000, ...words });

  it("has total owed first, each debt by when it's paid off, then the fund", () => {
    expect(projection.series.map((s) => [s.id, s.payoff, s.words])).toEqual([
      ["total", "2027-09", "Debt-free 2027-09"],
      ["plan", "2027-01", "Paid off 2027-01"],
      ["slow", "2027-09", "Paid off 2027-09"],
      ["fund", "2027-05", "Reaches $200 2027-05"],
    ]);
  });

  it("shares one time axis: every series has a figure for every month, whole cents", () => {
    expect(projection.months).toHaveLength(12);
    expect(projection.months[0]).toBe("2026-11");
    for (const s of projection.series) {
      expect(s.values).toHaveLength(projection.months.length);
      expect(s.values.every((v) => Number.isInteger(v) && v >= 0)).toBe(true);
    }
    const planSeries = projection.series.find((s) => s.id === "plan")!;
    expect(planSeries.values.slice(0, 4)).toEqual([20000, 10000, 0, 0]);
    // Total owed is the plan's debts only (a closed one never counts), at each month's end.
    const total = projection.series[0].values;
    expect(total.slice(0, 4)).toEqual([80000, 70000, 60000, 55000]);
    // The fund fills once the plan's payment is freed, half of it, until reached.
    expect(projection.series[3].values.slice(2, 7)).toEqual([0, 5000, 10000, 15000, 20000]);
  });

  it("says so when a debt or the fund isn't done within the plan", () => {
    const stuck = [debt({ id: "big", name: "Big loan", balance: 10_000_000, minimum: 1 })];
    const long = projectPlan({
      debts: stuck,
      start: "2026-11",
      averageRevenue: 0,
      revenueSharePct: 10,
      emergency: { target: 0, current: 0, splitPct: 0, monthly: 0 },
      overrides: new Map(),
    });
    const out = payoffProjection({ plan: long, debts: stuck, fundTarget: 0, ...words });
    expect(out.series.map((s) => s.words)).toEqual([
      "Not debt-free within five years",
      "Not paid off within five years",
      "No target set yet",
    ]);
    expect(out.months).toHaveLength(60);
  });

  it("shows at least a year, and a little past the last payoff", () => {
    const month = (total: number) => ({ total }) as never;
    expect(projectionLength([month(1), month(0), ...Array(40).fill(month(0))])).toBe(12);
    expect(projectionLength([...Array(20).fill(month(1)), ...Array(40).fill(month(0))])).toBe(22);
  });
});
