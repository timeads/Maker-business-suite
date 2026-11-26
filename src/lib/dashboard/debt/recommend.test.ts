import { describe, expect, it } from "vitest";
import { simulate, type DebtInput, type SimulationResult, type Strategy } from "./engine";
import {
  choiceNote,
  followOrder,
  rankStrategies,
  recommendStrategy,
  recommendationWords,
} from "./recommend";

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const sim = (
  strategy: Strategy,
  totalInterest: number,
  monthsToFreedom: number,
  capped = false,
): SimulationResult => ({
  strategy,
  months: [],
  monthsToFreedom,
  payoffMonth: "2027-01",
  totalInterest,
  totalPaid: 0,
  payoffByDebt: {},
  capped,
});

const sims = (
  over: Partial<Record<Strategy, [number, number, boolean?]>>,
): Record<Strategy, SimulationResult> => {
  const base: Record<Strategy, [number, number, boolean?]> = {
    avalanche: [10_000, 24],
    snowball: [10_000, 24],
    hybrid: [10_000, 24],
    custom: [10_000, 24],
    ...over,
  };
  return Object.fromEntries(
    Object.entries(base).map(([s, [i, m, c]]) => [s, sim(s as Strategy, i, m, c)]),
  ) as Record<Strategy, SimulationResult>;
};

describe("the recommended order", () => {
  it("is the one paying the least interest", () => {
    const all = sims({ avalanche: [12_000, 20], snowball: [9_000, 26], hybrid: [9_500, 22] });
    expect(rankStrategies(all)).toEqual(["snowball", "hybrid", "custom", "avalanche"]);
  });

  it("breaks a tie in interest by the sooner debt-free month", () => {
    const all = sims({ avalanche: [9_000, 30], custom: [9_000, 28] });
    expect(rankStrategies(all)[0]).toBe("custom");
  });

  it("then by the dashboard's own order: avalanche, snowball, hybrid, your own", () => {
    expect(rankStrategies(sims({}))).toEqual(["avalanche", "snowball", "hybrid", "custom"]);
    expect(rankStrategies(sims({ avalanche: [10_001, 24] }))[0]).toBe("snowball");
  });

  it("puts an order that never clears the debts last, whatever its interest", () => {
    const all = sims({ avalanche: [1, 600, true] });
    expect(rankStrategies(all).at(-1)).toBe("avalanche");
  });

  it("works out what it saves against minimums and the next best", () => {
    const all = sims({ avalanche: [8_000, 20], snowball: [9_000, 22] });
    const rec = recommendStrategy(all, sim("avalanche", 30_000, 40));
    expect(rec).toMatchObject({
      strategy: "avalanche",
      savedVsMinimums: 22_000,
      monthsSoonerVsMinimums: 20,
      next: { strategy: "snowball", moreInterest: 1_000, monthsLater: 2 },
    });
    expect(recommendationWords(rec, money)).toBe(
      "Avalanche saves about $220.00 in interest and finishes 20 months sooner than paying only the minimums; the next best, snowball, pays about $10.00 more.",
    );
  });

  it("says it against the next best when minimums never clear the debts", () => {
    const all = sims({ avalanche: [8_000, 20], snowball: [9_000, 21] });
    const rec = recommendStrategy(all, sim("avalanche", 50_000, 600, true));
    expect(rec.savedVsMinimums).toBeNull();
    expect(recommendationWords(rec, money)).toBe(
      "Avalanche saves about $10.00 in interest and finishes 1 month sooner than the next best, snowball.",
    );
  });

  it("says plainly when the orders come out the same", () => {
    const rec = recommendStrategy(sims({}), sim("avalanche", 10_000, 24));
    expect(recommendationWords(rec, money)).toBe(
      "The orders come out the same here, so avalanche is the one to follow.",
    );
  });

  it("notes quietly when another order would now save more than a person's choice", () => {
    const all = sims({ avalanche: [8_000, 20], snowball: [9_500, 18] });
    const rec = recommendStrategy(all, sim("avalanche", 30_000, 40));
    expect(choiceNote("snowball", rec, all, money)).toBe(
      "Avalanche would now save about $15.00 more in interest than the order you chose.",
    );
    expect(choiceNote("avalanche", rec, all, money)).toBeNull();
    expect(
      choiceNote("custom", rec, sims({ avalanche: [8_000, 20], custom: [8_000, 21] }), money),
    ).toBeNull();
  });

  it("agrees with the engine on real debts: the costly one first saves the most", () => {
    const debts: DebtInput[] = [
      { id: "a", name: "Small Card", balance: 50_000, rateBp: 900, minimum: 2_500 },
      { id: "b", name: "Big Card", balance: 400_000, rateBp: 2_499, minimum: 12_000 },
      {
        id: "c",
        name: "Middle Loan",
        balance: 150_000,
        rateBp: 1_200,
        minimum: 5_000,
        priority: 1,
      },
    ];
    const run = (strategy: Strategy) =>
      simulate(debts, { strategy, start: "2026-12", extraMonthly: 20_000 });
    const all = {
      avalanche: run("avalanche"),
      snowball: run("snowball"),
      hybrid: run("hybrid"),
      custom: run("custom"),
    };
    const minimums = simulate(debts, {
      strategy: "avalanche",
      start: "2026-12",
      extraMonthly: 0,
      rollover: false,
    });
    const rec = recommendStrategy(all, minimums);
    expect(rec.strategy).toBe("avalanche");
    for (const s of rec.ranked) {
      expect(all[s].totalInterest).toBeGreaterThanOrEqual(all.avalanche.totalInterest);
    }
    expect(rec.savedVsMinimums).toBeGreaterThan(0);
  });
});

describe("following the recommended order", () => {
  const input = {
    debts: [
      {
        id: "a",
        name: "Small Card",
        balance: 30_000,
        rateBp: 500,
        minimum: 2_000,
        payment: null,
        plan: "pool" as const,
        revolvingBp: null,
        priority: 2,
        active: true,
      },
      {
        id: "b",
        name: "Costly Card",
        balance: 300_000,
        rateBp: 2_900,
        minimum: 9_000,
        payment: null,
        plan: "pool" as const,
        revolvingBp: null,
        priority: 1,
        active: true,
      },
      {
        // Already paid off: its payment is in the pool from the start.
        id: "c",
        name: "Done Loan",
        balance: 0,
        rateBp: 800,
        minimum: 15_000,
        payment: null,
        plan: "fixed" as const,
        revolvingBp: null,
        priority: null,
        active: true,
      },
    ],
    start: "2026-12",
    averageRevenue: 0,
    revenueSharePct: 7,
    emergency: { target: 0, current: 0, splitPct: 0, monthly: 0 },
    overrides: new Map(),
  };

  it("follows it when nobody chose", () => {
    const followed = followOrder(input, { from: "recommended", strategy: "snowball" });
    expect(followed.recommendation?.strategy).toBe("avalanche");
    expect(followed.strategy).toBe("avalanche");
    expect(followed.result.chosen.strategy).toBe("avalanche");
  });

  it("keeps a person's choice, whatever would save more", () => {
    const followed = followOrder(input, { from: "person", strategy: "snowball" });
    expect(followed.strategy).toBe("snowball");
    expect(followed.result.chosen.strategy).toBe("snowball");
    expect(followed.recommendation?.strategy).toBe("avalanche");
  });

  it("recommends nothing with no debts for the plan to pay down", () => {
    const followed = followOrder(
      { ...input, debts: input.debts.filter((d) => d.plan !== "pool") },
      { from: "recommended", strategy: "avalanche" },
    );
    expect(followed.recommendation).toBeNull();
  });
});
