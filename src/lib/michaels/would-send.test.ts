import { describe, expect, it } from "vitest";
import {
  MAX_CHANGES_KEPT,
  parseChanges,
  wouldSend,
  type ItemFacts,
  type ListingFacts,
} from "./would-send";

const item = (id: string, over: Partial<ItemFacts> = {}): ItemFacts => ({
  id,
  name: `Item ${id}`,
  on_hand: 10,
  tracked: true,
  price: 20,
  ...over,
});
const listing = (
  n: number,
  itemId: string | null,
  over: Partial<ListingFacts> = {},
): ListingFacts => ({
  sellerSku: `SKU-${n}`,
  michaelsSkuNumber: `M${n}`,
  listingStatus: "ACTIVE",
  itemId,
  michaelsQty: 9,
  michaelsPrice: "20.00",
  ...over,
});
const settings = (over: Partial<{ stock: boolean; prices: boolean }> = {}, held = 1) => ({
  units_held_back: held,
  jobs: { stock: true, prices: true, ...over },
});
const items = (...list: ItemFacts[]) => new Map(list.map((i) => [i.id, i]));

describe("wouldSend", () => {
  it("records nothing when Michaels already shows the shop's count less the units held back", () => {
    const r = wouldSend([listing(1, "a")], items(item("a")), settings());
    expect(r.changes).toEqual([]);
    expect(r.stock).toEqual({ checked: 1, same: 1, differ: 0, unknown: 0, skipped: 0 });
    expect(r.prices).toEqual({ checked: 1, same: 1, differ: 0, unknown: 0, skipped: 0 });
  });

  it("lists the stock and the price that differ, from and to", () => {
    const r = wouldSend(
      [listing(1, "a", { michaelsQty: 3, michaelsPrice: "18.50" })],
      items(item("a")),
      settings(),
    );
    expect(r.changes).toEqual([
      {
        kind: "stock",
        seller_sku: "SKU-1",
        michaels_sku_number: "M1",
        item_id: "a",
        item_name: "Item a",
        from: "3",
        to: "9",
      },
      {
        kind: "price",
        seller_sku: "SKU-1",
        michaels_sku_number: "M1",
        item_id: "a",
        item_name: "Item a",
        from: "18.50",
        to: "20.00",
      },
    ]);
    expect(r.stock?.differ).toBe(1);
    expect(r.prices?.differ).toBe(1);
  });

  it("never goes below zero, whatever is held back", () => {
    const r = wouldSend(
      [listing(1, "a", { michaelsQty: 4 })],
      items(item("a", { on_hand: 2 })),
      settings({}, 5),
    );
    expect(r.changes[0]).toMatchObject({ kind: "stock", from: "4", to: "0" });
  });

  it("leaves alone what the shop keeps no count of, and what has no price", () => {
    const r = wouldSend(
      [listing(1, "a", { michaelsQty: 4, michaelsPrice: "9.00" })],
      items(item("a", { tracked: false, price: 0 })),
      settings(),
    );
    expect(r.changes).toEqual([]);
    expect(r.stock?.skipped).toBe(1);
    expect(r.prices?.skipped).toBe(1);
  });

  it("says so when Michaels' own figure wasn't read", () => {
    const r = wouldSend(
      [listing(1, "a", { michaelsQty: null, michaelsPrice: null })],
      items(item("a")),
      settings(),
    );
    expect(r.changes.map((c) => c.from)).toEqual([null, null]);
    expect(r.stock?.unknown).toBe(1);
    expect(r.prices?.unknown).toBe(1);
  });

  it("skips unmatched and archived listings, and items that are gone", () => {
    const r = wouldSend(
      [
        listing(1, null, { michaelsQty: 0 }),
        listing(2, "a", { listingStatus: "archived", michaelsQty: 0 }),
        listing(3, "missing", { michaelsQty: 0 }),
        listing(4, "a", { sellerSku: null, michaelsQty: 0 }),
      ],
      items(item("a")),
      settings(),
    );
    expect(r.changes).toEqual([]);
    expect(r.stock?.checked).toBe(0);
  });

  it("only does the jobs that are switched on", () => {
    const rows = [listing(1, "a", { michaelsQty: 1, michaelsPrice: "1.00" })];
    const stockOnly = wouldSend(rows, items(item("a")), settings({ prices: false }));
    expect(stockOnly.prices).toBeNull();
    expect(stockOnly.changes.map((c) => c.kind)).toEqual(["stock"]);
    const neither = wouldSend(rows, items(item("a")), settings({ stock: false, prices: false }));
    expect(neither).toEqual({ changes: [], more: false, stock: null, prices: null });
  });

  it("keeps a bounded list but counts everything", () => {
    const many = Array.from({ length: MAX_CHANGES_KEPT + 20 }, (_, i) =>
      listing(i, "a", { michaelsQty: 0 }),
    );
    const r = wouldSend(many, items(item("a")), settings({ prices: false }));
    expect(r.changes).toHaveLength(MAX_CHANGES_KEPT);
    expect(r.more).toBe(true);
    expect(r.stock?.differ).toBe(MAX_CHANGES_KEPT + 20);
  });
});

describe("parseChanges", () => {
  it("reads back what was stored and drops what isn't a change", () => {
    expect(
      parseChanges([
        {
          kind: "stock",
          seller_sku: "A",
          michaels_sku_number: "1",
          item_id: "i",
          item_name: "n",
          from: null,
          to: "3",
        },
        { kind: "send", seller_sku: "A", to: "3" },
        { kind: "price", seller_sku: "A" },
        null,
        "x",
      ]),
    ).toEqual([
      {
        kind: "stock",
        seller_sku: "A",
        michaels_sku_number: "1",
        item_id: "i",
        item_name: "n",
        from: null,
        to: "3",
      },
    ]);
    expect(parseChanges({})).toEqual([]);
  });
});
