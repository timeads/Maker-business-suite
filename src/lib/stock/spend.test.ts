import { describe, it, expect } from "vitest";

import { aggregateSpend, monthsBefore, type SpendLineInput } from "./spend";

const D = (n: string) => n;

function line(over: Partial<SpendLineInput>): SpendLineInput {
  return {
    poId: "po1",
    date: new Date("2026-06-15T00:00:00Z"),
    supplierId: "sup1",
    supplierName: "Karida",
    sku: "SKU-A",
    title: "Yarn A",
    qtyOrdered: 10,
    unitCost: D("2.00"),
    ...over,
  };
}

describe("aggregateSpend", () => {
  it("sums ordered value and reconciles sku, vendor, month, and total", () => {
    const lines = [
      line({ poId: "po1", sku: "SKU-A", qtyOrdered: 10, unitCost: D("2.00") }), // 20
      line({ poId: "po1", sku: "SKU-B", qtyOrdered: 5, unitCost: D("3.00"), title: "Yarn B" }), // 15
      line({ poId: "po2", sku: "SKU-A", qtyOrdered: 4, unitCost: D("2.50"), date: new Date("2026-07-02T00:00:00Z") }), // 10
    ];
    const r = aggregateSpend(lines, null);
    expect(r.total).toBe("45.00");
    expect(r.poCount).toBe(2);
    expect(r.lineCount).toBe(3);

    // SKU-A: 20 + 10 = 30 across 2 POs, 14 units; sorted first (highest spend)
    const a = r.bySku.find((s) => s.sku === "SKU-A")!;
    expect(a.spend).toBe("30.00");
    expect(a.units).toBe(14);
    expect(a.poCount).toBe(2);
    expect(r.bySku[0]!.sku).toBe("SKU-A"); // spend-desc order

    // Vendor total reconciles to grand total
    expect(r.byVendor).toHaveLength(1);
    expect(r.byVendor[0]!.spend).toBe("45.00");
    expect(r.byVendor[0]!.skuCount).toBe(2);

    // Two months bucketed
    expect(r.byMonth).toEqual([
      { month: "2026-06", spend: "35.00" },
      { month: "2026-07", spend: "10.00" },
    ]);
  });

  it("excludes lines before the since cutoff", () => {
    const lines = [
      line({ date: new Date("2026-01-01T00:00:00Z"), qtyOrdered: 100, unitCost: D("1.00") }), // old, excluded
      line({ date: new Date("2026-06-15T00:00:00Z"), qtyOrdered: 10, unitCost: D("2.00") }), // 20, kept
    ];
    const r = aggregateSpend(lines, new Date("2026-03-01T00:00:00Z"));
    expect(r.total).toBe("20.00");
    expect(r.lineCount).toBe(1);
  });

  it("groups null-SKU lines by title and tracks the most recent vendor", () => {
    const lines = [
      line({ sku: null, title: "Custom dye", supplierName: "VendorX", date: new Date("2026-05-01T00:00:00Z"), qtyOrdered: 1, unitCost: D("100") }),
      line({ sku: null, title: "Custom dye", supplierName: "VendorY", supplierId: "sup2", date: new Date("2026-06-01T00:00:00Z"), qtyOrdered: 1, unitCost: D("50") }),
    ];
    const r = aggregateSpend(lines, null);
    const row = r.bySku.find((s) => s.title === "Custom dye")!;
    expect(row.spend).toBe("150.00");
    expect(row.supplierName).toBe("VendorY"); // most recent order's vendor
    expect(r.byVendor).toHaveLength(2);
  });
});

describe("monthsBefore", () => {
  it("steps back whole months, like date-fns subMonths", () => {
    const d = (s: string) => new Date(`${s}T00:00:00Z`);
    expect(monthsBefore(d("2026-11-23"), 3)).toEqual(d("2026-08-23"));
    expect(monthsBefore(d("2026-02-10"), 6)).toEqual(d("2025-08-10"));
    // A day the earlier month doesn't have lands on its last day.
    expect(monthsBefore(d("2026-05-31"), 3)).toEqual(d("2026-02-28"));
  });
});
