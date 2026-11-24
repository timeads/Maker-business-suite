import { describe, expect, it } from "vitest";
import { buildOrderResolver, orderPreview, orderRecord } from "./orders";
import type { MichaelsOrder } from "./types";

// A made-up order in the shape Michaels sends. The name and address fields
// are here on purpose: the test checks they are never kept.
const order = (over: Record<string, unknown> = {}): MichaelsOrder =>
  ({
    orderNumber: "ORD0000000000000001-1",
    status: "PENDING_CONFIRMATION",
    currency: "USD",
    firstName: "Quentin",
    lastName: "Buyer",
    phone: "5550100",
    address1: "1 Example Street",
    city: "Sampleville",
    state: "PA",
    zipCode: "19999",
    itemsSubtotal: "19.98",
    shippingHandlingCharge: "5.00",
    estimatedTax: "1.20",
    totalDiscount: "0",
    grandTotalCollected: 26.18,
    createdTime: "1760659200000",
    promiseShipDate: "1760832000000",
    updatedTime: "1760662800000",
    orderLines: [
      {
        orderItemId: "1234567890123456789",
        sellerSkuNumber: "CONE-01",
        skuNumber: "111",
        productName: "Sample cone",
        quantity: "2",
        price: "9.99",
        status: "PENDING_CONFIRMATION",
      },
    ],
    ...over,
  }) as MichaelsOrder;

describe("orderRecord", () => {
  it("keeps the number, status, dates, totals and lines", () => {
    expect(orderRecord(order())).toEqual({
      order_number: "ORD0000000000000001-1",
      status: "PENDING_CONFIRMATION",
      currency: "USD",
      placed_at: "2025-10-17T00:00:00.000Z",
      promise_ship_at: "2025-10-19T00:00:00.000Z",
      michaels_updated_at: "2025-10-17T01:00:00.000Z",
      items_subtotal: "19.98",
      shipping: "5.00",
      tax: "1.20",
      discount: "0.00",
      grand_total: "26.18",
      lines: [
        {
          order_item_id: "1234567890123456789",
          seller_sku: "CONE-01",
          michaels_sku_number: "111",
          product_name: "Sample cone",
          quantity: 2,
          unit_price: "9.99",
          line_status: "PENDING_CONFIRMATION",
        },
      ],
    });
  });

  it("never keeps who bought it or where it is going", () => {
    const kept = JSON.stringify(orderRecord(order()));
    for (const personal of [
      "Quentin",
      "Buyer",
      "5550100",
      "Example Street",
      "Sampleville",
      "19999",
    ]) {
      expect(kept).not.toContain(personal);
    }
    expect(Object.keys(orderRecord(order())!)).not.toContain("firstName");
  });

  it("keeps long ids as text and drops what isn't an order or a line", () => {
    expect(orderRecord({ status: "X" } as MichaelsOrder)).toBeNull();
    const r = orderRecord(order({ orderLines: [{ quantity: 1, price: 1 }, null] as never }));
    expect(r?.lines).toEqual([]);
    expect(typeof orderRecord(order())!.lines[0]!.order_item_id).toBe("string");
  });
});

describe("buildOrderResolver", () => {
  const resolve = buildOrderResolver(
    [
      { michaels_sku_number: "111", seller_sku: "OLD-CONE", stock_item_id: "i-cone" },
      { michaels_sku_number: "222", seller_sku: "CLOTH-01", stock_item_id: "i-cloth" },
      { michaels_sku_number: "333", seller_sku: "LOST-01", stock_item_id: null },
    ],
    [
      { id: "i-cone", sku: "CONE-01" },
      { id: "i-frame", sku: "FRAME-01" },
      { id: "i-dup-1", sku: "DUP-01" },
      { id: "i-dup-2", sku: "DUP-01" },
    ],
  );

  it("tries the matched listings by Michaels number, then by seller SKU", () => {
    expect(resolve("ANYTHING", "111")).toBe("i-cone");
    expect(resolve("CLOTH-01", null)).toBe("i-cloth");
  });

  it("falls back to an item that alone has that SKU, and never guesses between two", () => {
    expect(resolve("FRAME-01", "999")).toBe("i-frame");
    expect(resolve("DUP-01", null)).toBeNull();
    expect(resolve("LOST-01", "333")).toBeNull();
    expect(resolve(null, null)).toBeNull();
  });
});

describe("orderPreview", () => {
  const resolveAll = () => "i-1";
  const record = (over: Record<string, unknown> = {}) => orderRecord(order(over))!;

  it("shows what would be created when every line is known", () => {
    const p = orderPreview(record(), resolveAll);
    expect(p).toMatchObject({ wouldCreate: true, problems: [], units: 2, itemsTotal: "19.98" });
    expect(p.lines[0]!.item_id).toBe("i-1");
  });

  it("is all or nothing: one unknown SKU and nothing would be created", () => {
    const two = record({
      orderLines: [
        { orderItemId: "1", sellerSkuNumber: "CONE-01", quantity: 1, price: "9.99" },
        { orderItemId: "2", sellerSkuNumber: "MYSTERY", quantity: 1, price: "4.00" },
      ],
    });
    const p = orderPreview(two, (sku) => (sku === "CONE-01" ? "i-1" : null));
    expect(p.wouldCreate).toBe(false);
    expect(p.problems[0]).toContain("MYSTERY");
    expect(p.lines.map((l) => l.item_id)).toEqual(["i-1", null]);
  });

  it("refuses an order with no lines, another currency or a line of zero", () => {
    expect(orderPreview(record({ orderLines: [] }), resolveAll).wouldCreate).toBe(false);
    expect(orderPreview(record({ currency: "CAD" }), resolveAll).problems[0]).toContain("CAD");
    const zero = record({
      orderLines: [{ orderItemId: "1", sellerSkuNumber: "CONE-01", quantity: 0, price: "1" }],
    });
    expect(orderPreview(zero, resolveAll).wouldCreate).toBe(false);
  });
});
