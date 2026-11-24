import { describe, expect, it } from "vitest";
import {
  orderCountsBySupplier,
  orderViewRows,
  ordersCsv,
  searchOrders,
  shippingSummary,
  toOrderRow,
  type OrderListInput,
} from "./list";

// TuftStock's cases for the shipping column (po/shipping-state.test.ts).
const here = { arrivedOn: "2026-11-01", expectedOn: null };
const moving = (eta?: string, carrierStatus?: string) => ({
  arrivedOn: null,
  expectedOn: eta ?? null,
  carrierStatus,
});

describe("shippingSummary", () => {
  it("a sent order with no tracking yet hasn't shipped", () => {
    expect(shippingSummary("ordered", [])).toMatchObject({
      state: "not-shipped",
      label: "Not shipped",
    });
    expect(shippingSummary("partial", []).state).toBe("not-shipped");
  });

  it("drafts and closed orders without tracking show nothing", () => {
    expect(shippingSummary("draft", []).label).toBe("–");
    expect(shippingSummary("closed", []).label).toBe("–");
  });

  it("shipped, with the soonest arrival of what's still on its way", () => {
    expect(shippingSummary("ordered", [moving("2026-12-07")])).toEqual({
      state: "shipped",
      label: "Shipped",
      count: 1,
      delivered: 0,
      nextEta: "2026-12-07",
    });
    expect(shippingSummary("ordered", [moving("2026-11-19"), moving()])).toMatchObject({
      label: "Shipped · 2 parcels",
      nextEta: "2026-11-19",
    });
  });

  it("counts what's delivered so far", () => {
    expect(shippingSummary("partial", [here, moving("2026-11-11")])).toMatchObject({
      state: "partly-delivered",
      label: "1 of 2 delivered",
      nextEta: "2026-11-11",
    });
    expect(shippingSummary("partial", [here, here])).toMatchObject({
      state: "delivered",
      nextEta: null,
    });
  });

  it("a closed order is delivered even if a box never reported it", () => {
    expect(shippingSummary("closed", [here, moving("2026-08-01")]).state).toBe("delivered");
  });

  it("flags a parcel the carrier says is held up", () => {
    expect(shippingSummary("ordered", [moving(undefined, "problem"), moving()]).state).toBe(
      "problem",
    );
  });
});

const TODAY = "2026-11-20";
const order = (overrides: Partial<OrderListInput>): OrderListInput => ({
  id: "o1",
  number: 1,
  reference: "HI-202611-AAAAAA",
  status: "ordered",
  supplierId: "s1",
  supplierName: "Hill Mill",
  expectedOn: "2026-12-01",
  createdOn: "2026-11-01",
  sentOn: "2026-11-02",
  archived: false,
  shippingCost: "10",
  taxRatePct: "0",
  adjustments: [],
  lines: [
    { qtyOrdered: 10, qtyReceived: 0, unitCost: "2.50" },
    { qtyOrdered: 0, qtyReceived: 0, unitCost: "9" },
  ],
  parcels: [],
  ...overrides,
});
const rows = [
  toOrderRow(order({}), TODAY),
  toOrderRow(
    order({ id: "o2", number: 2, reference: "HI-202610-BBBBBB", expectedOn: "2026-11-10" }),
    TODAY,
  ),
  toOrderRow(
    order({ id: "o3", number: 3, reference: "Spring yarn", status: "draft", sentOn: null }),
    TODAY,
  ),
  toOrderRow(
    order({ id: "o4", number: 4, status: "closed", supplierId: "s2", supplierName: "Dye Works" }),
    TODAY,
  ),
  toOrderRow(order({ id: "o5", number: 5, status: "closed", archived: true }), TODAY),
  toOrderRow(order({ id: "o6", number: 6, status: "cancelled" }), TODAY),
];

describe("the orders list", () => {
  it("counts lines still on the order, and totals it with shipping", () => {
    expect(rows[0]).toMatchObject({ items: 1, units: 10, value: "35.00", late: false });
    expect(rows[1].late).toBe(true);
  });

  it("sorts orders into TuftStock's five views, with archived ones only under Archived", () => {
    const views = orderViewRows(rows);
    const numbers = (list: { number: number }[]) => list.map((row) => row.number);
    expect(numbers(views.progress)).toEqual([1, 2]);
    expect(numbers(views.draft)).toEqual([3]);
    expect(numbers(views.overdue)).toEqual([2]);
    expect(numbers(views.all)).toEqual([1, 2, 3, 4, 6]);
    expect(numbers(views.archived)).toEqual([5]);
  });

  it("searches by reference, supplier, status and shipping, and narrows to one supplier", () => {
    const numbers = (q: string, supplier: string | null = null) =>
      searchOrders(rows, q, supplier).map((row) => row.number);
    expect(numbers("spring")).toEqual([3]);
    expect(numbers("dye")).toEqual([4]);
    expect(numbers("not shipped")).toEqual([1, 2]);
    expect(numbers("cancelled")).toEqual([6]);
    expect(numbers("", "s2")).toEqual([4]);
    expect(numbers("hill", "s2")).toEqual([]);
  });

  it("writes the list as a spreadsheet", () => {
    const table = ordersCsv([rows[0], rows[4]]);
    expect(table[0]).toEqual([
      "Reference",
      "Supplier",
      "Items",
      "Units",
      "Arrived",
      "Expected",
      "Sent",
      "Status",
      "Shipping",
      "Value",
    ]);
    expect(table[1]).toEqual([
      "HI-202611-AAAAAA",
      "Hill Mill",
      1,
      10,
      0,
      "2026-12-01",
      "2026-11-02",
      "Sent, waiting",
      "Not shipped",
      "35.00",
    ]);
    expect(table[2][7]).toBe("Archived");
    expect(table[2][8]).toBe("");
  });

  it("counts the orders each supplier has had, leaving out drafts and cancelled ones", () => {
    const counts = orderCountsBySupplier(rows);
    expect(counts.get("s1")).toBe(3);
    expect(counts.get("s2")).toBe(1);
  });
});
