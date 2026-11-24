import { describe, expect, it } from "vitest";
import { MichaelsApiError, type MichaelsClient } from "./client";
import { DEFAULT_MICHAELS_SETTINGS, type MichaelsSettings } from "./config";
import type { OrderRecord } from "./orders";
import { runMichaelsWatch, type ListingRecord, type RunDeps, type RunItem } from "./run";

const now = new Date("2026-10-21T14:00:00Z");
const settings = (over: Partial<MichaelsSettings> = {}): MichaelsSettings => ({
  ...DEFAULT_MICHAELS_SETTINGS,
  enabled: true,
  ...over,
});

const ITEMS: RunItem[] = [
  { id: "i-cone", name: "Sample cone", sku: "CONE-01", on_hand: 10, tracked: true, price: 20 },
  { id: "i-cloth", name: "Sample cloth", sku: "cloth-01", on_hand: 3, tracked: true, price: 7.5 },
];

type Route = (query: Record<string, unknown>) => unknown;

/** A Michaels that only knows how to be read. Every request is noted. */
function fakeMichaels(routes: Record<string, Route>) {
  const calls: { method: string; path: string }[] = [];
  const client: MichaelsClient = {
    request: async <T>(method: string, path: string, req?: { query?: Record<string, unknown> }) => {
      calls.push({ method, path });
      const route = routes[path];
      if (!route) throw new Error(`no route for ${path}`);
      return route(req?.query ?? {}) as T;
    },
  };
  return { client, calls };
}

function deps(client: MichaelsClient, over: Partial<RunDeps> = {}) {
  const written = {
    listings: [] as ListingRecord[],
    complete: null as boolean | null,
    orders: [] as OrderRecord[],
  };
  const d: RunDeps = {
    client,
    settings: settings(),
    now,
    loadItems: async () => ITEMS,
    loadPairings: async () => [],
    loadFigures: async () => [],
    recordListings: async (rows, complete) => {
      written.listings = rows;
      written.complete = complete;
    },
    recordOrders: async (orders) => {
      written.orders = orders;
    },
    ...over,
  };
  return { d, written };
}

const CATALOG = {
  listings: [
    {
      skuNumber: "P1",
      primarySkuNumber: "P1",
      sellerSkuNumber: "PARENT-1",
      itemName: "Sample cone",
      status: "ACTIVE",
      subSkus: [{ skuNumber: "S1", sellerSkuNumber: "CONE-01", inventory: "4", price: "19.00" }],
    },
    { skuNumber: "P2", sellerSkuNumber: "CLOTH-01", status: "ACTIVE", inventory: 2, price: 7.5 },
    { skuNumber: "P3", sellerSkuNumber: "MYSTERY-9", status: "ACTIVE", inventory: 1, price: 1 },
  ],
  nextCursor: null,
};
const ORDERS: Route = (q) =>
  q.orderStatusList === "READY_TO_SHIP" && q.pageNumber === 1
    ? {
        records: [
          {
            orderNumber: "ORD-1",
            status: "READY_TO_SHIP",
            firstName: "Sample",
            orderLines: [
              {
                orderItemId: "1",
                sellerSkuNumber: "CONE-01",
                skuNumber: "S1",
                quantity: 1,
                price: "19.00",
              },
            ],
          },
          {
            orderNumber: "ORD-2",
            status: "READY_TO_SHIP",
            orderLines: [
              {
                orderItemId: "2",
                sellerSkuNumber: "MYSTERY-9",
                skuNumber: "P3",
                quantity: 1,
                price: "1.00",
              },
            ],
          },
        ],
      }
    : { records: [] };

describe("runMichaelsWatch", () => {
  it("matches, works out what would be sent, reads orders, and only ever reads", async () => {
    const { client, calls } = fakeMichaels({
      "/listing/all-listings": () => CATALOG,
      "/order/query": ORDERS,
    });
    const { d, written } = deps(client);
    const out = await runMichaelsWatch(d);

    expect(out.status).toBe("done");
    expect(out.keyRejected).toBe(false);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(new Set(calls.map((c) => c.path))).toEqual(
      new Set(["/listing/all-listings", "/order/query"]),
    );

    expect(written.complete).toBe(true);
    expect(
      written.listings.map((l) => [l.seller_sku, l.stock_item_id, l.matched_by, l.problem]),
    ).toEqual([
      ["CONE-01", "i-cone", "exact", null],
      ["CLOTH-01", "i-cloth", "case", null],
      ["MYSTERY-9", null, null, "no_match"],
    ]);
    expect(out.counts.listings).toMatchObject({
      skus: 3,
      matched: 2,
      unmatched: 1,
      blocked: true,
      pages: 1,
    });

    // Shop has 10 cones, one held back: 9 against Michaels' 4. Price 20 against 19.
    // Cloth: 3 less 1 is 2, and 7.50: both already right.
    expect(out.changes).toEqual([
      {
        kind: "stock",
        seller_sku: "CONE-01",
        michaels_sku_number: "S1",
        item_id: "i-cone",
        item_name: "Sample cone",
        from: "4",
        to: "9",
      },
      {
        kind: "price",
        seller_sku: "CONE-01",
        michaels_sku_number: "S1",
        item_id: "i-cone",
        item_name: "Sample cone",
        from: "19.00",
        to: "20.00",
      },
    ]);
    expect(out.counts.stock).toEqual({ checked: 2, same: 1, differ: 1, unknown: 0, skipped: 0 });

    expect(written.orders.map((o) => o.order_number)).toEqual(["ORD-1", "ORD-2"]);
    expect(JSON.stringify(written.orders)).not.toContain("firstName");
    expect(out.counts.orders).toMatchObject({
      seen: 2,
      would_create: 1,
      need_pairing: 1,
      first_page: 1,
    });
    // One request per status (page 1, then page 0 where page 1 was empty).
    expect(calls.filter((c) => c.path === "/order/query")).toHaveLength(13);
  });

  it("lets a pairing typed in by hand decide", async () => {
    const { client } = fakeMichaels({
      "/listing/all-listings": () => CATALOG,
      "/order/query": () => ({ records: [] }),
    });
    const { d, written } = deps(client, {
      loadPairings: async () => [{ seller_sku: "MYSTERY-9", stock_item_id: "i-cloth" }],
    });
    const out = await runMichaelsWatch(d);
    expect(written.listings[2]).toMatchObject({ stock_item_id: "i-cloth", matched_by: "hand" });
    expect(out.counts.listings).toMatchObject({ unmatched: 0, blocked: false });
  });

  it("asks Michaels for figures the catalog didn't carry, a few listings a look, longest-unknown first", async () => {
    const bare = {
      listings: [
        { skuNumber: "P1", sellerSkuNumber: "CONE-01", status: "ACTIVE" },
        { skuNumber: "P2", sellerSkuNumber: "CLOTH-01", status: "ACTIVE" },
      ],
    };
    const { client, calls } = fakeMichaels({
      "/listing/all-listings": () => bare,
      "/listing/inventory/P1": () => ({
        skuInventories: [{ skuNumber: "P1", availableQuantity: "9" }],
      }),
      "/listing/price/P1": () => ({ skuPrices: [{ skuNumber: "P1", price: "20" }] }),
      "/listing/inventory/P2": () => ({
        skuInventories: [{ skuNumber: "P2", availableQuantity: 0 }],
      }),
      "/listing/price/P2": () => ({ skuPrices: [{ skuNumber: "P2", price: 7.5 }] }),
    });
    const { d, written } = deps(client, {
      settings: settings({ jobs: { stock: true, prices: true, orders: false } }),
    });
    const out = await runMichaelsWatch(d);
    expect(out.counts.listings?.figure_reads).toBe(4);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(written.listings.map((l) => [l.michaels_qty, l.michaels_price])).toEqual([
      [9, "20.00"],
      [0, "7.50"],
    ]);
    expect(out.changes).toEqual([
      {
        kind: "stock",
        seller_sku: "CLOTH-01",
        michaels_sku_number: "P2",
        item_id: "i-cloth",
        item_name: "Sample cloth",
        from: "0",
        to: "2",
      },
    ]);
  });

  it("uses what an earlier look learned when this one couldn't ask", async () => {
    const bare = { listings: [{ skuNumber: "P1", sellerSkuNumber: "CONE-01", status: "ACTIVE" }] };
    const { client } = fakeMichaels({
      "/listing/all-listings": () => bare,
      "/listing/inventory/P1": () => null,
      "/listing/price/P1": () => null,
    });
    const { d, written } = deps(client, {
      settings: settings({ jobs: { stock: true, prices: true, orders: false } }),
      loadFigures: async () => [
        {
          michaels_sku_number: "P1",
          michaels_qty: 9,
          michaels_price: "18.00",
          figures_at: "2026-10-20T00:00:00Z",
        },
      ],
    });
    const out = await runMichaelsWatch(d);
    // Nothing fresh to store, so the stored figures are left as they were.
    expect(written.listings[0]).toMatchObject({ michaels_qty: null, michaels_price: null });
    expect(out.changes).toEqual([
      {
        kind: "price",
        seller_sku: "CONE-01",
        michaels_sku_number: "P1",
        item_id: "i-cone",
        item_name: "Sample cone",
        from: "18.00",
        to: "20.00",
      },
    ]);
  });

  it("stops at a key Michaels won't accept, and says so", async () => {
    const { client, calls } = fakeMichaels({
      "/listing/all-listings": () => {
        throw new MichaelsApiError("nope", "MCU_API_INVALID_API_KEY", 401, "/listing/all-listings");
      },
      "/order/query": ORDERS,
    });
    const { d, written } = deps(client);
    const out = await runMichaelsWatch(d);
    expect(out).toMatchObject({ status: "failed", keyRejected: true });
    expect(out.error).toContain("didn't accept the API key");
    expect(calls.map((c) => c.path)).toEqual(["/listing/all-listings"]);
    expect(written.listings).toEqual([]);
    expect(written.orders).toEqual([]);
  });

  it("carries on with the other parts when one fails, and marks the look failed", async () => {
    const { client } = fakeMichaels({
      "/listing/all-listings": () => CATALOG,
      "/order/query": () => {
        throw new MichaelsApiError(
          "no",
          "MCU_DEVELOPER_API_DO_NOT_HAVE_PERMISSION",
          401,
          "/order/query",
        );
      },
    });
    const { d, written } = deps(client);
    const out = await runMichaelsWatch(d);
    expect(out.status).toBe("failed");
    expect(out.keyRejected).toBe(false);
    expect(written.listings).toHaveLength(3);
    expect(out.changes).toHaveLength(2);
    expect(out.counts.job_errors.orders).toContain("isn't allowed to read");
  });

  it("says so loudly when Michaels sends orders it can't read", async () => {
    const { client } = fakeMichaels({
      "/listing/all-listings": () => CATALOG,
      "/order/query": () => ({ records: [{ id: 1 }] }),
    });
    const out = await runMichaelsWatch(deps(client).d);
    expect(out.status).toBe("failed");
    expect(out.counts.job_errors.orders).toContain("records:array(1)");
  });

  it("does only the jobs that are switched on", async () => {
    const { client, calls } = fakeMichaels({ "/listing/all-listings": () => CATALOG });
    const { d } = deps(client, {
      settings: settings({ jobs: { stock: false, prices: false, orders: false } }),
    });
    const out = await runMichaelsWatch(d);
    expect(out.status).toBe("done");
    expect(out.changes).toEqual([]);
    expect(out.counts).toMatchObject({ stock: null, prices: null, orders: null });
    expect(calls.map((c) => c.path)).toEqual(["/listing/all-listings"]);
  });
});
