import { describe, expect, it } from "vitest";
import {
  bySupplier,
  computeBuildAhead,
  peakFactor,
  seasonLiftByMonth,
  type Season,
  type SupplierLead,
} from "./seasons";

// TuftStock's own cases (seasons/build-ahead.test.ts), on plain days.
const TODAY = "2026-08-22";

const holiday: Season = {
  id: "e1",
  name: "Holiday build",
  inStockBy: "2026-11-15",
  liftPct: 0,
  note: "",
};

const suppliers: SupplierLead[] = [
  { supplierId: "s1", supplierName: "Far Mill (sea)", leadDays: 60, itemCount: 20 },
  { supplierId: "s2", supplierName: "Local", leadDays: 7, itemCount: 3 },
];

describe("computeBuildAhead", () => {
  it("works out order by = in stock by − lead − buffer, most urgent first", () => {
    const [plan] = computeBuildAhead([holiday], suppliers, 7, TODAY);
    expect(plan.suppliers[0].supplierName).toBe("Far Mill (sea)");
    // Nov 15 − 60 − 7 = Sep 9
    expect(plan.suppliers[0].orderBy).toBe("2026-09-09");
    // Local: Nov 15 − 7 − 7 = Nov 1
    expect(plan.suppliers[1].orderBy).toBe("2026-11-01");
    expect(plan.daysUntil).toBe(85);
  });

  it("says overdue, soon or on track", () => {
    const late: SupplierLead[] = [
      { supplierId: "x", supplierName: "Far", leadDays: 120, itemCount: 1 },
    ];
    // Nov 15 − 120 − 7 = Jul 11, already gone
    expect(computeBuildAhead([holiday], late, 7, TODAY)[0].suppliers[0].status).toBe("overdue");
    const soon: SupplierLead[] = [
      { supplierId: "y", supplierName: "Soon", leadDays: 78, itemCount: 1 },
    ];
    // Nov 15 − 78 − 7 = Aug 30, eight days out
    expect(computeBuildAhead([holiday], soon, 7, TODAY)[0].suppliers[0].status).toBe("soon");
    expect(computeBuildAhead([holiday], suppliers, 7, TODAY)[0].suppliers[0].status).toBe(
      "ontrack",
    );
  });

  it("drops a season whose day has passed, and keeps one that is today", () => {
    const past: Season = { ...holiday, inStockBy: "2026-07-01" };
    expect(computeBuildAhead([past], suppliers, 7, TODAY)).toHaveLength(0);
    expect(computeBuildAhead([{ ...holiday, inStockBy: TODAY }], suppliers, 7, TODAY)).toHaveLength(
      1,
    );
  });

  it("lists seasons soonest first", () => {
    const spring: Season = { ...holiday, id: "e2", name: "Spring fair", inStockBy: "2027-03-01" };
    expect(computeBuildAhead([spring, holiday], suppliers, 7, TODAY).map((p) => p.id)).toEqual([
      "e1",
      "e2",
    ]);
  });

  it("keeps a supplier's lead-time groups together", () => {
    const [plan] = computeBuildAhead(
      [holiday],
      [
        ...suppliers,
        { supplierId: "s1", supplierName: "Far Mill (sea)", leadDays: 45, itemCount: 4 },
      ],
      7,
      TODAY,
    );
    const grouped = bySupplier(plan.suppliers);
    expect(grouped.map((g) => [g.supplierName, g.groups.map((c) => c.leadDays)])).toEqual([
      ["Far Mill (sea)", [60, 45]],
      ["Local", [7]],
    ]);
  });
});

describe("seasonLiftByMonth", () => {
  it("multiplies the season's month for seasons still to come", () => {
    const lift = seasonLiftByMonth([{ ...holiday, liftPct: 20 }], TODAY);
    expect(lift[10]).toBeCloseTo(1.2, 5); // November
    expect(lift[0]).toBe(1);
  });

  it("stacks two seasons in a month and ignores one that has passed", () => {
    const lift = seasonLiftByMonth(
      [
        { ...holiday, liftPct: 20 },
        { ...holiday, id: "e2", inStockBy: "2026-11-27", liftPct: 10 },
        { ...holiday, id: "e3", inStockBy: "2026-07-04", liftPct: 50 },
      ],
      TODAY,
    );
    expect(lift[10]).toBeCloseTo(1.32, 5);
    expect(lift[6]).toBe(1);
  });
});

describe("peakFactor", () => {
  const index = Array(12).fill(1) as number[];
  index[10] = 1.25;
  it("finds a busy month inside the days an order has to cover", () => {
    // Aug 22 + 90 days reaches into November.
    expect(peakFactor(index, TODAY, 90)).toBe(1.25);
    // Thirty days only reaches September.
    expect(peakFactor(index, TODAY, 30)).toBe(1);
  });
});
