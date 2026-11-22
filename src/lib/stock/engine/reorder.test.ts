import { describe, expect, it } from "vitest";
import { addDays } from "./days";
import { computeVelocity, type DailySale } from "./velocity";
import { computeReorder } from "./reorder";
import { computeDraftPo, largestRemainder } from "./draft-po";
import { computeOnOrder } from "./on-order";
import type { ReorderInput } from "./types";

const TODAY = new Date("2026-07-01T00:00:00.000Z");

function sale(daysAgo: number, units: number): DailySale {
  return { date: addDays(TODAY, -daysAgo), unitsSold: units };
}

/** Established product (first sale >90d ago) with the given 30d/90d totals. */
function established(units30: number, units90: number): DailySale[] {
  return [
    sale(10, units30), // inside 30d and 90d
    sale(60, units90 - units30), // inside 90d only
    sale(120, 1), // anchor: makes first-sale >90d ago so denom = 90
  ];
}

function input(overrides: Partial<ReorderInput>): ReorderInput {
  return {
    salesByDay: [],
    stockOnHand: 0,
    onOrder: 0,
    effectiveLeadTimeDays: 45,
    effectiveCoverageDays: 30,
    safetyStockUnits: 0,
    moq: 1,
    moqAppliesTo: "ORDER",
    reviewBufferDays: 7,
    today: TODAY,
    ...overrides,
  };
}

/** Steady seller: `perDay` units every day for `days` days (no outlier days). */
function steady(perDay: number, days: number): DailySale[] {
  return Array.from({ length: days }, (_, i) => sale(i, perDay));
}

describe("velocity (docs/04 §1)", () => {
  it("1. base rate over 90d with a 25% vote for the last 30d: 30 in 30d, 60 in 90d → 0.75/day", () => {
    const v = computeVelocity(established(30, 60), TODAY);
    expect(v.unitsPerDay).toBeCloseTo(0.25 * 1.0 + 0.75 * (60 / 90), 4); // 0.75
    expect(v.baseWindowDays).toBe(90);
  });

  it("2. new product (first sale 20d ago, 10 sold) is measured over its 21 days, not 90", () => {
    const v = computeVelocity([sale(20, 10)], TODAY);
    // Both windows shrink to the product's 21 days (first sale through today),
    // so base = recent = 10/21 and the blend is 10/21 too.
    expect(v.unitsPerDay).toBeCloseTo(10 / 21, 4);
    expect(v.inStockDays).toBe(21);
  });

  it("3. dead stock: 0 sales in 90d → velocity 0", () => {
    const v = computeVelocity([sale(200, 5)], TODAY);
    expect(v.isDeadStock).toBe(true);
    expect(v.unitsPerDay).toBe(0);
  });

  it("12. a one-day burst is capped: 1/day steady + one 40-unit day ≈ still ~1/day", () => {
    const plain = computeVelocity(steady(1, 120), TODAY);
    const spiked = computeVelocity([...steady(1, 120), sale(5, 39)], TODAY); // day 5 → 40 units
    expect(plain.unitsPerDay).toBeCloseTo(1, 6);
    // cap = max(P95 of window days (=1), 2 × median sale-day (=1)) = 2 → 40 counts as 2
    expect(spiked.cappedUnits).toBe(38);
    expect(spiked.unitsPerDay).toBeLessThan(1.05);
    // The uncapped blend would have said ~1.34/day.
  });

  it("13. sparse seller (< 10 units in 90d) is measured over 180 days", () => {
    // 8 units in the last 90d, 8 more in days 90–180.
    const sales = [sale(10, 4), sale(50, 4), sale(100, 4), sale(150, 4), sale(300, 1)];
    const v = computeVelocity(sales, TODAY);
    expect(v.baseWindowDays).toBe(180);
    // base = 16/180; recent = 4/30 → 0.25*0.1333 + 0.75*0.0889 = 0.1
    expect(v.unitsPerDay).toBeCloseTo(0.25 * (4 / 30) + 0.75 * (16 / 180), 4);
  });

  it("14. out-of-stock days are dropped from the denominator, not counted as zero demand", () => {
    // Sold 1/day for 30 days, then out of stock for the 60 days before that.
    const sales = [...steady(1, 30), sale(120, 1)];
    const oos = Array.from({ length: 60 }, (_, i) => addDays(TODAY, -(30 + i)));
    const plain = computeVelocity(sales, TODAY);
    const censored = computeVelocity(sales, TODAY, oos);
    expect(plain.unitsPerDay).toBeCloseTo(0.25 * 1 + 0.75 * (30 / 90), 4); // 0.5
    expect(censored.inStockDays).toBe(30);
    expect(censored.outOfStockDays).toBe(60);
    expect(censored.unitsPerDay).toBeCloseTo(1, 4); // 30 units over 30 in-stock days
    const explained = computeReorder(
      input({ salesByDay: sales, outOfStockDates: oos, stockOnHand: 10 }),
    );
    expect(explained.explain).toContain("60 out-of-stock days excluded");
    // A day that sold something is never treated as out of stock.
    const sameDay = computeVelocity(sales, TODAY, [TODAY]);
    expect(sameDay.inStockDays).toBe(90);
  });
});

describe("reorder engine (docs/04 §2–4,6)", () => {
  it("3. dead stock: stock 12 → suggestedQty 0, stockOutDate null", () => {
    const r = computeReorder(input({ salesByDay: [sale(200, 5)], stockOnHand: 12 }));
    expect(r.isDeadStock).toBe(true);
    expect(r.suggestedQty).toBe(0);
    expect(r.stockOutDate).toBeNull();
  });

  it("4. stock-out: stock 5, onOrder 40, velocity 1.5/day → today + 30", () => {
    const r = computeReorder(
      input({ salesByDay: established(45, 135), stockOnHand: 5, onOrder: 40 }),
    );
    expect(r.unitsPerDay).toBeCloseTo(1.5, 6);
    expect(r.stockOutDate).toEqual(addDays(TODAY, 30));
  });

  it("5. reorder date in the past → overdue", () => {
    const r = computeReorder(
      input({ salesByDay: established(45, 135), stockOnHand: 5, onOrder: 0 }),
    );
    // stockOut = today + ceil(5/1.5)=+4; reorder = +4 - (45+7) = today-48 → overdue
    expect(r.isOverdue).toBe(true);
    expect(r.reorderDate!.getTime()).toBeLessThan(TODAY.getTime());
  });

  it("6. suggested qty worked example → 38", () => {
    const r = computeReorder(
      input({
        salesByDay: established(13, 39), // rate30=rate90≈0.4333 → upd≈0.4333
        effectiveLeadTimeDays: 45,
        effectiveCoverageDays: 30,
        safetyStockUnits: 10,
        stockOnHand: 5,
        onOrder: 0,
      }),
    );
    expect(r.suggestedQty).toBe(38);
  });

  it("7. SKU MOQ bump: 4→10, 0 stays 0, 12 stays 12", () => {
    // suggested 4: demand=1.0*60=60, raw=60-56=4
    const bumped = computeReorder(
      input({
        salesByDay: established(30, 90), // upd 1.0
        effectiveLeadTimeDays: 30,
        effectiveCoverageDays: 30,
        stockOnHand: 56,
        moq: 10,
        moqAppliesTo: "SKU",
      }),
    );
    expect(bumped.suggestedQty).toBe(10);
    expect(bumped.moqApplied).toBe(true);

    // suggested 0 stays 0
    const zero = computeReorder(
      input({
        salesByDay: established(30, 90),
        effectiveLeadTimeDays: 30,
        effectiveCoverageDays: 30,
        stockOnHand: 100,
        moq: 10,
        moqAppliesTo: "SKU",
      }),
    );
    expect(zero.suggestedQty).toBe(0);

    // suggested 12 stays 12: demand=1.0*60=60, raw=60-48=12
    const above = computeReorder(
      input({
        salesByDay: established(30, 90), // upd 1.0
        effectiveLeadTimeDays: 30,
        effectiveCoverageDays: 30,
        stockOnHand: 48,
        moq: 10,
        moqAppliesTo: "SKU",
      }),
    );
    expect(above.suggestedQty).toBe(12);
    expect(above.moqApplied).toBe(false);
  });

  it("10. oversold: stock −14, velocity 1.0 → stock-out now, overdue, deficit added", () => {
    const r = computeReorder(
      input({
        salesByDay: established(30, 90), // upd 1.0
        effectiveLeadTimeDays: 30,
        effectiveCoverageDays: 30,
        stockOnHand: -14,
        onOrder: 0,
      }),
    );
    expect(r.stockOutDate).toEqual(TODAY); // now
    expect(r.isOverdue).toBe(true);
    // demand=1.0*60=60; raw = 60 + 0 − (−14) − 0 = 74
    expect(r.suggestedQty).toBe(74);
  });

  it("11. explanation string matches the numbers used", () => {
    const r = computeReorder(
      input({
        salesByDay: established(13, 39),
        effectiveLeadTimeDays: 45,
        effectiveCoverageDays: 30,
        safetyStockUnits: 10,
        stockOnHand: 5,
        onOrder: 0,
      }),
    );
    expect(r.explain).toBe(
      "0.43/day × (45d lead + 30d cover) = 33 + 10 safety − 5 on hand − 0 on order = 38",
    );
  });
});

describe("draft PO (docs/04 §5,9)", () => {
  it("8. ORDER MOQ scaling: two lines 30/30, moq 100 → 50/50", () => {
    const result = computeDraftPo(
      [
        { variantId: "a", suggestedQty: 30, unitCost: "5.00", effectiveLeadTimeDays: 45 },
        { variantId: "b", suggestedQty: 30, unitCost: "5.00", effectiveLeadTimeDays: 30 },
      ],
      100,
      "ORDER",
      TODAY,
    );
    expect(result.lines.map((l) => l.qty)).toEqual([50, 50]);
    expect(result.totalUnits).toBe(100);
    expect(result.moqBumped).toBe(true);
    expect(result.estDeliveryDate).toEqual(addDays(TODAY, 45));
  });

  it("largest-remainder distributes an odd remainder", () => {
    expect(largestRemainder([10, 20, 30], 100)).toEqual([17, 33, 50]);
  });

  it("9. on-order includes ORDERED/PARTIAL remainder, excludes DRAFT/CLOSED", () => {
    const onOrder = computeOnOrder([
      { status: "ORDERED", qtyOrdered: 40, qtyReceived: 10 }, // +30
      { status: "PARTIAL", qtyOrdered: 20, qtyReceived: 5 }, // +15
      { status: "DRAFT", qtyOrdered: 100, qtyReceived: 0 }, // excluded
      { status: "CLOSED", qtyOrdered: 50, qtyReceived: 50 }, // excluded
    ]);
    expect(onOrder).toBe(45);
  });
});

describe("seasonality (docs/04 §7)", () => {
  // TODAY is 2026-07-01; boost the forward months (Aug=7, Sep=8).
  const idx = Array(12).fill(1);
  idx[7] = 1.5;
  idx[8] = 1.5;

  it("raises suggested qty when the forward window covers a peak", () => {
    const flat = computeReorder(input({ salesByDay: established(30, 60), stockOnHand: 0 }));
    const seas = computeReorder(
      input({ salesByDay: established(30, 60), stockOnHand: 0, seasonalIndex: idx }),
    );
    expect(seas.suggestedQty).toBeGreaterThan(flat.suggestedQty);
    expect(seas.explain).toContain("season");
  });

  it("pulls the reorder date earlier when a peak is coming", () => {
    const flat = computeReorder(input({ salesByDay: established(30, 60), stockOnHand: 80 }));
    const seas = computeReorder(
      input({ salesByDay: established(30, 60), stockOnHand: 80, seasonalIndex: idx }),
    );
    expect(flat.reorderDate).not.toBeNull();
    expect(seas.reorderDate!.getTime()).toBeLessThan(flat.reorderDate!.getTime());
  });

  it("a flat all-1.0 index reproduces legacy no-index behavior (within rounding)", () => {
    const noIdx = computeReorder(input({ salesByDay: established(30, 60), stockOnHand: 50 }));
    const flatIdx = computeReorder(
      input({ salesByDay: established(30, 60), stockOnHand: 50, seasonalIndex: Array(12).fill(1) }),
    );
    expect(Math.abs(flatIdx.suggestedQty - noIdx.suggestedQty)).toBeLessThanOrEqual(1);
    const dDays = Math.abs(
      (flatIdx.stockOutDate!.getTime() - noIdx.stockOutDate!.getTime()) / 86400000,
    );
    expect(dDays).toBeLessThanOrEqual(1);
  });
});
