import { describe, expect, it } from "vitest";
import { averageCost, receivedFromLines, resolveCost } from "./cost";

describe("what an item costs", () => {
  it("uses your own figure first, then the average of deliveries, then the shop's", () => {
    const received = { units: 10, total: "125.00" };
    const all = resolveCost({ ownCost: "11.00", received, shopCost: "9.99" });
    expect([all.cost.toFixed(2), all.source]).toEqual(["11.00", "own"]);
    expect([all.average?.toFixed(2), all.shop?.toFixed(2)]).toEqual(["12.50", "9.99"]);

    const noOwn = resolveCost({ ownCost: null, received, shopCost: "9.99" });
    expect([noOwn.cost.toFixed(2), noOwn.source]).toEqual(["12.50", "average"]);

    const shopOnly = resolveCost({ ownCost: null, received: null, shopCost: 9.99 });
    expect([shopOnly.cost.toFixed(2), shopOnly.source]).toEqual(["9.99", "shop"]);

    const nothing = resolveCost({ ownCost: null, received: null, shopCost: null });
    expect([nothing.cost.toFixed(2), nothing.source]).toEqual(["0.00", "none"]);
  });

  it("an own figure of zero is a figure (a free sample), not a gap", () => {
    const free = resolveCost({ ownCost: "0.00", received: null, shopCost: "4.00" });
    expect([free.cost.toFixed(2), free.source]).toEqual(["0.00", "own"]);
  });

  it("weights each delivery by how many arrived, as TuftStock does", () => {
    // 10 at 4.00 and 30 at 5.00: (40 + 150) / 40 = 4.75
    const received = receivedFromLines([
      { qtyReceived: 10, unitCost: "4.00" },
      { qtyReceived: 30, unitCost: "5.00" },
      { qtyReceived: 0, unitCost: "99.00" }, // ordered, nothing here yet
    ]);
    expect(received).toEqual({ units: 40, total: expect.anything() });
    expect(averageCost(received)?.toFixed(2)).toBe("4.75");
    expect(receivedFromLines([{ qtyReceived: 0, unitCost: "3.00" }])).toBeNull();
  });

  it("rounds to whole cents without floating-point drift", () => {
    // 0.10 + 0.20 = 0.30 over 3 units = 0.10 exactly (0.1 + 0.2 isn't 0.3 in floats).
    expect(averageCost({ units: 3, total: "0.30" })?.toFixed(2)).toBe("0.10");
    // 1.00 / 3 = 0.333… → 0.33; 2.00 / 3 = 0.666… → 0.67; 0.05 / 2 = 0.025 → 0.03.
    expect(averageCost({ units: 3, total: "1.00" })?.toFixed(2)).toBe("0.33");
    expect(averageCost({ units: 3, total: "2.00" })?.toFixed(2)).toBe("0.67");
    expect(averageCost({ units: 2, total: "0.05" })?.toFixed(2)).toBe("0.03");
    expect(averageCost({ units: 7, total: "1234567.89" })?.toFixed(2)).toBe("176366.84");
  });

  it("has no average when nothing has been checked in, or the sums can't be read", () => {
    expect(averageCost(null)).toBeNull();
    expect(averageCost({ units: 0, total: "0.00" })).toBeNull();
    expect(averageCost({ units: 2, total: "not a number" })).toBeNull();
    expect(resolveCost({ ownCost: "-1", received: null, shopCost: "" }).source).toBe("none");
  });
});
