import { describe, it, expect } from "vitest";
import { classifyStockHealth, type StockHealthInput } from "./stock-health";

// Kestrel-like defaults: 45d lead, 30d cover, 7d review → horizon 75, bridge 52,
// overstock line max(180, 150) = 180 days.
function input(o: Partial<StockHealthInput>): StockHealthInput {
  return {
    stockOnHand: 0,
    onOrder: 0,
    unitsPerDay: 1,
    isDeadStock: false,
    effectiveLeadTimeDays: 45,
    effectiveCoverageDays: 30,
    reviewBufferDays: 7,
    ...o,
  };
}

describe("stock health (docs/04 §8)", () => {
  it("out: nothing on hand", () => {
    const r = classifyStockHealth(input({ stockOnHand: 0, onOrder: 40 }));
    expect(r.health).toBe("out");
    expect(r.reason).toContain("40 on order");
  });

  it("under: runway shorter than lead + review buffer", () => {
    const r = classifyStockHealth(input({ stockOnHand: 30 })); // 30 days < 52
    expect(r.health).toBe("under");
    expect(r.coverDays).toBe(30);
    expect(r.reason).toBe(
      "30 days of cover; a new order takes 52 (45d lead + 7d review) — reorder is overdue.",
    );
  });

  it("on-order stock counts toward the bridge", () => {
    const r = classifyStockHealth(input({ stockOnHand: 30, onOrder: 40 })); // runway 70 ≥ 52
    expect(r.health).toBe("healthy");
    expect(r.runwayDays).toBe(70);
  });

  it("the line is the reorder date, not the reorder date plus safety stock", () => {
    // 55 days of cover against a 52-day bridge is healthy even with safety stock
    // configured — safety stock shows up in the suggested quantity instead.
    expect(classifyStockHealth(input({ stockOnHand: 55 })).health).toBe("healthy");
    expect(classifyStockHealth(input({ stockOnHand: 51 })).health).toBe("under");
  });

  it("healthy: between the bridge and the overstock line", () => {
    expect(classifyStockHealth(input({ stockOnHand: 100 })).health).toBe("healthy");
    expect(classifyStockHealth(input({ stockOnHand: 180 })).health).toBe("healthy"); // exactly on the line
  });

  it("over: cover beyond 2× horizon (min 180 days), with the excess to sell", () => {
    const r = classifyStockHealth(input({ stockOnHand: 250 }));
    expect(r.health).toBe("over");
    expect(r.excessUnits).toBe(70); // 250 − 1/day × 180
    expect(r.reason).toContain("70 units beyond 180 days");
  });

  it("over line scales with a long horizon: 60d lead + 60d cover → 240 days", () => {
    const r = classifyStockHealth(
      input({ stockOnHand: 200, effectiveLeadTimeDays: 60, effectiveCoverageDays: 60 }),
    );
    expect(r.health).toBe("healthy");
    expect(
      classifyStockHealth(
        input({ stockOnHand: 241, effectiveLeadTimeDays: 60, effectiveCoverageDays: 60 }),
      ).health,
    ).toBe("over");
  });

  it("nosales: dead stock with units on hand; out when dead and empty", () => {
    expect(
      classifyStockHealth(input({ stockOnHand: 12, isDeadStock: true, unitsPerDay: 0 })).health,
    ).toBe("nosales");
    expect(
      classifyStockHealth(input({ stockOnHand: 0, isDeadStock: true, unitsPerDay: 0 })).health,
    ).toBe("out");
  });

  it("oversold (negative stock) is out, not over", () => {
    expect(classifyStockHealth(input({ stockOnHand: -3 })).health).toBe("out");
  });
});
