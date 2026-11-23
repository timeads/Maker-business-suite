import { describe, expect, it } from "vitest";
import { computePoTotals, fromCents, outstandingUnits, parseAdjustments } from "./totals";

describe("outstandingUnits (close-PO guard)", () => {
  it("counts units still owed", () => {
    expect(outstandingUnits([{ qtyOrdered: 10, qtyReceived: 4 }])).toBe(6);
  });

  it("is zero when every line is fully received", () => {
    expect(
      outstandingUnits([
        { qtyOrdered: 10, qtyReceived: 10 },
        { qtyOrdered: 5, qtyReceived: 5 },
      ]),
    ).toBe(0);
  });

  it("treats an over-received line as complete — dye lots run over (regression)", () => {
    // Receiving MORE than ordered must not report outstanding units, or closing
    // the PO wrongly warns "not all units received".
    expect(outstandingUnits([{ qtyOrdered: 100, qtyReceived: 112 }])).toBe(0);
  });

  it("does not let an over-received line offset a short one", () => {
    expect(
      outstandingUnits([
        { qtyOrdered: 100, qtyReceived: 112 }, // +12 over, clamps to 0
        { qtyOrdered: 20, qtyReceived: 15 }, // 5 short
      ]),
    ).toBe(5);
  });

  it("is zero for a PO with no lines", () => {
    expect(outstandingUnits([])).toBe(0);
  });
});

describe("PO totals (docs/02)", () => {
  it("sums lines + shipping + tax + adjustments", () => {
    const t = computePoTotals({
      lines: [
        { qtyOrdered: 10, unitCost: "7.50" }, // 75
        { qtyOrdered: 4, unitCost: "2.00" }, // 8
      ],
      shippingCost: "25.00",
      taxRatePct: "10", // 10% of 83 = 8.3
      adjustments: [{ amount: "-5.00" }, { amount: "2.50" }], // -2.5
    });
    expect(t.subtotal.toFixed(2)).toBe("83.00");
    expect(t.tax.toFixed(2)).toBe("8.30");
    expect(t.adjustmentsTotal.toFixed(2)).toBe("-2.50");
    // 83 + 25 + 8.3 - 2.5 = 113.80
    expect(t.total.toFixed(2)).toBe("113.80");
  });

  it("handles zero tax and no adjustments", () => {
    const t = computePoTotals({
      lines: [{ qtyOrdered: 36, unitCost: "7.50" }],
      shippingCost: "250.00",
      taxRatePct: "0",
      adjustments: [],
    });
    expect(t.total.toFixed(2)).toBe("520.00"); // 270 + 250
  });

  // Ours: the port works in whole cents rather than Decimal.
  it("rounds tax half up to the cent and takes a rate with decimals", () => {
    const t = computePoTotals({
      lines: [{ qtyOrdered: 3, unitCost: "19.99" }], // 59.97
      shippingCost: 0,
      taxRatePct: "8.875", // 5.3223... -> 5.32
      adjustments: [],
    });
    expect(t.tax.toFixed(2)).toBe("5.32");
    expect(t.total.toFixed(2)).toBe("65.29");
    // 0.5% of 1.00 is exactly half a cent: up.
    expect(
      computePoTotals({
        lines: [{ qtyOrdered: 1, unitCost: "1.00" }],
        shippingCost: 0,
        taxRatePct: 0.5,
        adjustments: [],
      }).tax.toFixed(2),
    ).toBe("0.01");
  });

  it("never drifts the way floats do", () => {
    const t = computePoTotals({
      lines: Array.from({ length: 10 }, () => ({ qtyOrdered: 1, unitCost: "0.10" })),
      shippingCost: "0.20",
      taxRatePct: "0",
      adjustments: [{ amount: "0.10" }],
    });
    expect(t.total.toFixed(2)).toBe("1.30");
    expect(fromCents(-5).toFixed(2)).toBe("-0.05");
  });
});

describe("adjustments as stored", () => {
  it("keeps labelled amounts and drops anything else", () => {
    expect(
      parseAdjustments([
        { label: " Pallet fee ", amount: "25.00" },
        { label: "Discount", amount: -10 },
        { label: "", amount: "5" },
        { label: "Broken", amount: "lots" },
        "nonsense",
      ]),
    ).toEqual([
      { label: "Pallet fee", amount: "25.00" },
      { label: "Discount", amount: "-10.00" },
    ]);
    expect(parseAdjustments(null)).toEqual([]);
  });
});
