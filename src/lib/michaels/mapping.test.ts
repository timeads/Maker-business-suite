import { describe, expect, it } from "vitest";
import {
  adoptionBlocked,
  buildSkuIndex,
  describeShape,
  epochToDate,
  extractOrders,
  flattenListings,
  keyExpiry,
  matchAll,
  matchSku,
  michaelsPrice,
  michaelsQuantity,
  toCents,
  type MichaelsSkuRow,
  type SkuIndex,
} from "./mapping";

// Everything here is made up: no real SKUs, order numbers, names or prices.

describe("michaelsQuantity", () => {
  it("holds back the buffer and never goes negative", () => {
    expect(michaelsQuantity(580, 1)).toBe(579);
    expect(michaelsQuantity(1, 1)).toBe(0);
    expect(michaelsQuantity(-3, 1)).toBe(0);
    expect(michaelsQuantity(5, 0)).toBe(5);
    expect(michaelsQuantity(7.9, 2)).toBe(5);
    expect(michaelsQuantity(5, -4)).toBe(5);
    expect(michaelsQuantity(500_000_000, 0)).toBe(99_999_999);
  });
});

describe("michaelsPrice", () => {
  it("is exactly the shop's price, no markup", () => {
    expect(michaelsPrice("0.75")).toBe("0.75");
    expect(michaelsPrice("129.99")).toBe("129.99");
    expect(michaelsPrice("12.5")).toBe("12.50");
    expect(michaelsPrice(12.5)).toBe("12.50");
    expect(michaelsPrice(40)).toBe("40.00");
    expect(michaelsPrice("3.005")).toBe("3.01");
    expect(michaelsPrice("3.004")).toBe("3.00");
  });

  it("never sends a missing, zero, negative or unreadable price", () => {
    expect(michaelsPrice(null)).toBeNull();
    expect(michaelsPrice(undefined)).toBeNull();
    expect(michaelsPrice("")).toBeNull();
    expect(michaelsPrice("0.00")).toBeNull();
    expect(michaelsPrice("-1")).toBeNull();
    expect(michaelsPrice("abc")).toBeNull();
    expect(michaelsPrice("1e3")).toBeNull();
    expect(michaelsPrice("99999999.99")).toBeNull();
    expect(michaelsPrice("99999999.98")).toBe("99999999.98");
  });

  it("keeps cents whole", () => {
    expect(toCents("19.99")).toBe(1999);
    expect(toCents("0.1")).toBe(10);
    expect(toCents("-2.50")).toBe(-250);
    expect(toCents("1,000")).toBeNull();
  });
});

describe("flattenListings", () => {
  it("uses subSkus for listings with options and the listing itself otherwise", () => {
    const rows = flattenListings([
      {
        skuNumber: "P1",
        primarySkuNumber: "P1",
        sellerSkuNumber: "PARENT-1",
        itemName: " Sample yarn ",
        status: "ACTIVE",
        updateDatetime: "1760659200000",
        subSkus: [
          { skuNumber: "S1", sellerSkuNumber: "YARN-RED", inventory: "4", price: "12.5" },
          { skuNumber: "S2", sellerSkuNumber: " " },
        ],
      },
      {
        skuNumber: "P2",
        sellerSkuNumber: "CONE-01",
        status: "SOLD_OUT",
        subSkus: [],
        inventory: 0,
        price: 3,
        globalTradeItemNumber: " 000000000017 ",
      },
    ]);
    expect(rows).toEqual([
      {
        sellerSku: "YARN-RED",
        michaelsSkuNumber: "S1",
        michaelsPrimarySku: "P1",
        itemName: "Sample yarn",
        listingStatus: "ACTIVE",
        gtin: null,
        michaelsQty: 4,
        michaelsPrice: "12.50",
        updatedAt: new Date(1760659200000),
      },
      {
        sellerSku: null,
        michaelsSkuNumber: "S2",
        michaelsPrimarySku: "P1",
        itemName: "Sample yarn",
        listingStatus: "ACTIVE",
        gtin: null,
        michaelsQty: null,
        michaelsPrice: null,
        updatedAt: new Date(1760659200000),
      },
      {
        sellerSku: "CONE-01",
        michaelsSkuNumber: "P2",
        michaelsPrimarySku: "P2",
        itemName: null,
        listingStatus: "SOLD_OUT",
        gtin: "000000000017",
        michaelsQty: 0,
        michaelsPrice: "3.00",
        updatedAt: null,
      },
    ]);
  });

  it("keeps the seller SKU exactly as Michaels has it: updates address it by that string", () => {
    const rows = flattenListings([
      { skuNumber: "M2", sellerSkuNumber: " cone-cc1 ", subSkus: null },
    ]);
    expect(rows[0]!.sellerSku).toBe(" cone-cc1 ");
  });
});

describe("matchSku", () => {
  const idx = (over: Partial<SkuIndex> = {}): SkuIndex => ({
    exact: new Map([
      ["CONE-01", ["i-cone"]],
      ["DUP", ["i-1", "i-2"]],
    ]),
    folded: new Map([
      ["cone-01", ["i-cone"]],
      ["cloth-01", ["i-cloth"]],
      ["dup", ["i-1", "i-2"]],
    ]),
    barcode: new Map([["000000000017", ["i-bar"]]]),
    paired: new Map<string, string | null>([
      ["OLD-123", "i-cone"],
      ["OLD-GONE", null],
    ]),
    ...over,
  });

  it("applies exact, then capitals-and-spaces, then barcode, in that order", () => {
    expect(matchSku({ sellerSku: "CONE-01", gtin: null }, idx())).toEqual({
      itemId: "i-cone",
      rule: "exact",
    });
    expect(matchSku({ sellerSku: " Cloth-01 ", gtin: null }, idx())).toEqual({
      itemId: "i-cloth",
      rule: "case",
    });
    expect(matchSku({ sellerSku: "X-1", gtin: "000000000017" }, idx())).toEqual({
      itemId: "i-bar",
      rule: "barcode",
    });
  });

  it("lets a pairing typed in by hand win over every rule", () => {
    expect(matchSku({ sellerSku: "OLD-123", gtin: null }, idx())).toEqual({
      itemId: "i-cone",
      rule: "hand",
    });
    const both = idx({ paired: new Map([["CONE-01", "i-other"]]) });
    expect(matchSku({ sellerSku: "CONE-01", gtin: null }, both)).toEqual({
      itemId: "i-other",
      rule: "hand",
    });
    const overDup = idx({ paired: new Map([["DUP", "i-2"]]) });
    expect(matchSku({ sellerSku: "DUP", gtin: null }, overDup)).toEqual({
      itemId: "i-2",
      rule: "hand",
    });
  });

  it("never guesses between two items", () => {
    expect(matchSku({ sellerSku: "DUP", gtin: "000000000017" }, idx())).toMatchObject({
      itemId: null,
      problem: "ambiguous",
    });
    expect(matchSku({ sellerSku: " dup ", gtin: null }, idx())).toMatchObject({
      itemId: null,
      problem: "ambiguous",
    });
  });

  it("explains a miss, a pairing whose item is gone, and a missing seller SKU", () => {
    expect(matchSku({ sellerSku: "GHOST", gtin: null }, idx())).toMatchObject({
      itemId: null,
      problem: "no_match",
    });
    expect(matchSku({ sellerSku: "OLD-GONE", gtin: null }, idx())).toMatchObject({
      itemId: null,
      problem: "pairing_missing",
    });
    expect(matchSku({ sellerSku: null, gtin: "000000000017" }, idx())).toMatchObject({
      itemId: null,
      problem: "no_seller_sku",
    });
  });
});

describe("matchAll", () => {
  const row = (n: number, sellerSku: string | null): MichaelsSkuRow => ({
    sellerSku,
    michaelsSkuNumber: `M${n}`,
    michaelsPrimarySku: `M${n}`,
    itemName: null,
    listingStatus: "ACTIVE",
    gtin: null,
    michaelsQty: null,
    michaelsPrice: null,
    updatedAt: null,
  });
  const index = buildSkuIndex(
    [
      { id: "i-a", sku: "A-1" },
      { id: "i-b", sku: "B-1" },
      { id: "i-c1", sku: "C-1" },
      { id: "i-c2", sku: "c-1 " },
      { id: "i-none", sku: null },
    ],
    [{ seller_sku: "HAND-1", stock_item_id: "i-b" }],
  );

  it("counts each rule and each kind of problem", () => {
    const { rows, summary } = matchAll(
      [row(1, "A-1"), row(2, "a-1"), row(3, "HAND-1"), row(4, "NOPE"), row(5, null), row(6, "c-1")],
      index,
    );
    expect(rows.map((r) => r.match.itemId)).toEqual(["i-a", "i-a", "i-b", null, null, null]);
    expect(summary).toEqual({
      skus: 6,
      matched: 3,
      byRule: { hand: 1, exact: 1, case: 1, barcode: 0 },
      unmatched: 3,
      byProblem: { no_match: 1, ambiguous: 1, duplicate: 0, no_seller_sku: 1, pairing_missing: 0 },
      blocked: true,
    });
  });

  it("keeps the first of two listings with one seller SKU and reports the other", () => {
    const { rows, summary } = matchAll([row(1, "A-1"), row(2, "A-1"), row(3, "B-1")], index);
    expect(rows[0]!.match).toEqual({ itemId: "i-a", rule: "exact" });
    expect(rows[1]!.match).toMatchObject({ itemId: null, problem: "duplicate" });
    expect(summary.byProblem.duplicate).toBe(1);
    expect(summary.matched).toBe(2);
  });

  it("is blocked only above a tenth unmatched", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `i-${i}`, sku: `SKU-${i}` }));
    const summary = (unmatched: number) =>
      matchAll(
        items.map((item, i) => row(i, i < unmatched ? `GONE-${i}` : item.sku)),
        buildSkuIndex(items, []),
      ).summary;
    expect(summary(0)).toMatchObject({ skus: 20, matched: 20, blocked: false });
    expect(summary(2)).toMatchObject({ unmatched: 2, blocked: false });
    expect(summary(3)).toMatchObject({ unmatched: 3, blocked: true });
  });
});

describe("adoptionBlocked", () => {
  it("stops when more than 10% of Michaels SKUs are unmatched", () => {
    expect(adoptionBlocked(100, 10)).toBe(false);
    expect(adoptionBlocked(100, 11)).toBe(true);
    expect(adoptionBlocked(0, 0)).toBe(false);
    expect(adoptionBlocked(1, 1)).toBe(true);
    expect(adoptionBlocked(9, 1)).toBe(true);
    expect(adoptionBlocked(10, 1)).toBe(false);
  });
});

describe("extractOrders", () => {
  const o = (n: string) => ({ orderNumber: n, status: "READY_TO_SHIP" });
  it("accepts a bare array or any wrapper key, one level down too", () => {
    expect(extractOrders([o("A")])).toHaveLength(1);
    expect(extractOrders({ orderList: [o("A"), o("B")] })).toHaveLength(2);
    expect(extractOrders({ records: [o("A")] } as never)).toHaveLength(1);
    expect(extractOrders({ page: { records: [o("A")] } } as never)).toHaveLength(1);
  });

  it("is empty for nothing, and for lists that aren't orders", () => {
    expect(extractOrders(null)).toEqual([]);
    expect(extractOrders({ total: 0, list: [] })).toEqual([]);
    expect(extractOrders({ things: [{ id: 1 }] } as never)).toEqual([]);
  });
});

describe("describeShape", () => {
  it("names keys and array lengths, never values", () => {
    expect(describeShape({ total: 2, list: [1, 2], page: { a: 1 }, none: null })).toBe(
      "total:number list:array(2) page:{a} none:null",
    );
    expect(describeShape([1])).toBe("array(1)");
    expect(describeShape(null)).toBe("null");
  });
});

describe("epochToDate", () => {
  it("reads epoch milliseconds given as text", () => {
    expect(epochToDate("1760659200000")?.toISOString()).toBe("2025-10-17T00:00:00.000Z");
    expect(epochToDate("")).toBeNull();
    expect(epochToDate("soon")).toBeNull();
    expect(epochToDate(0)).toBeNull();
  });
});

describe("keyExpiry", () => {
  it("counts down to the 60-day replace-by date and shows the 90-day end", () => {
    expect(keyExpiry("2026-09-01", "2026-09-11")).toEqual({
      level: "ok",
      daysToReplace: 50,
      replaceOn: "2026-10-31",
      daysLeft: 80,
      expiresOn: "2026-11-30",
    });
  });

  it("warns at 14 days, alerts at 3 and past the date, and expires at 90 days", () => {
    expect(keyExpiry("2026-09-01", "2026-10-17").level).toBe("warn");
    expect(keyExpiry("2026-09-01", "2026-10-16").level).toBe("ok");
    expect(keyExpiry("2026-09-01", "2026-10-28").level).toBe("alert");
    expect(keyExpiry("2026-09-01", "2026-11-10")).toMatchObject({
      level: "alert",
      daysToReplace: -10,
      daysLeft: 20,
    });
    expect(keyExpiry("2026-09-01", "2026-11-30").level).toBe("expired");
  });

  it("reads a portal timestamp, and is unknown without a date", () => {
    expect(keyExpiry("2026-09-01 09:42:01 AM", "2026-09-11").daysLeft).toBe(80);
    expect(keyExpiry(undefined, "2026-09-11").level).toBe("unknown");
    expect(keyExpiry("last week", "2026-09-11").level).toBe("unknown");
  });
});
