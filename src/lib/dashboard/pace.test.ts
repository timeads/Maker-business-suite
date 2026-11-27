import { describe, expect, it } from "vitest";
import { againstLastMonth, breakEvenPace, sameDaysLastMonth, shippingMonths } from "./pace";

describe("break-even pace", () => {
  it("runs the month so far on to its end against last month's costs", () => {
    expect(breakEvenPace({ revenue: 100000, day: 10, daysInMonth: 30, target: 250000 })).toEqual({
      projected: 300000,
      target: 250000,
      onPace: true,
      short: 0,
    });
    expect(breakEvenPace({ revenue: 50000, day: 10, daysInMonth: 31, target: 200000 })).toEqual({
      projected: 155000,
      target: 200000,
      onPace: false,
      short: 45000,
    });
  });

  it("says nothing without last month's costs", () => {
    expect(breakEvenPace({ revenue: 1, day: 3, daysInMonth: 30, target: null })).toBeNull();
    expect(breakEvenPace({ revenue: 1, day: 3, daysInMonth: 30, target: 0 })).toBeNull();
  });
});

describe("the same point last month", () => {
  it("takes the same days, or all of a shorter month", () => {
    expect(sameDaysLastMonth({ year: 2026, month: 11, day: 21 })).toEqual({
      from: { year: 2026, month: 10, day: 1 },
      to: { year: 2026, month: 10, day: 22 },
    });
    expect(sameDaysLastMonth({ year: 2026, month: 3, day: 31 })).toEqual({
      from: { year: 2026, month: 2, day: 1 },
      to: { year: 2026, month: 3, day: 1 },
    });
    expect(sameDaysLastMonth({ year: 2027, month: 1, day: 5 }).from).toEqual({
      year: 2026,
      month: 12,
      day: 1,
    });
    expect(againstLastMonth(110, 100)).toBeCloseTo(0.1);
    expect(againstLastMonth(5, 0)).toBeNull();
  });
});

describe("shipping margin by month", () => {
  it("is what shoppers paid less postage, with orders missing a cost counted", () => {
    expect(
      shippingMonths([
        { month: "2026-10-01", orders: 3, collected_cents: 3000, cost_cents: 2400, costed: 2 },
        { month: "2026-11-01", orders: 1, collected_cents: 0, cost_cents: 900, costed: 1 },
      ]),
    ).toEqual([
      {
        month: "2026-10",
        orders: 3,
        collected: 3000,
        cost: 2400,
        net: 600,
        share: 0.2,
        uncosted: 1,
      },
      { month: "2026-11", orders: 1, collected: 0, cost: 900, net: -900, share: null, uncosted: 0 },
    ]);
  });
});
