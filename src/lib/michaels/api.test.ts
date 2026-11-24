import { describe, expect, it } from "vitest";
import { allListings, checkKey, listingInventory, queryOrders, queryOrdersByStatus } from "./api";
import type { MichaelsClient } from "./client";

const o = (n: string) => ({ orderNumber: n, status: "READY_TO_SHIP" });

/** A fake client whose /order/query answers per page number. */
function fakeClient(pages: Record<number, unknown>) {
  const asked: number[] = [];
  const methods: string[] = [];
  const client: MichaelsClient = {
    request: async <T>(m: string, _p: string, req?: { query?: Record<string, unknown> }) => {
      methods.push(m);
      const n = Number(req?.query?.pageNumber);
      asked.push(n);
      return (pages[n] ?? { records: [] }) as T;
    },
  };
  return { client, asked, methods };
}

describe("queryOrders", () => {
  it("uses page 1 when Michaels numbers pages from 1", async () => {
    const { client, asked, methods } = fakeClient({ 1: { records: [o("A"), o("B")] } });
    const r = await queryOrders(client, ["READY_TO_SHIP"], new Date(0));
    expect(r.orders.map((x) => x.orderNumber)).toEqual(["A", "B"]);
    expect(r.firstPage).toBe(1);
    expect(asked).toEqual([1]);
    expect(methods).toEqual(["GET"]);
  });

  it("falls back to page 0 when page 1 is empty: numbering from 0", async () => {
    const { client, asked } = fakeClient({ 0: { total: 1, list: [o("ORD-0000-1")] } });
    const r = await queryOrders(client, ["READY_TO_SHIP"], new Date(0));
    expect(r.orders.map((x) => x.orderNumber)).toEqual(["ORD-0000-1"]);
    expect(r.firstPage).toBe(0);
    expect(asked).toEqual([1, 0]);
  });

  it("reports the reply shape when there are no orders at all", async () => {
    const { client } = fakeClient({});
    const r = await queryOrders(client, ["READY_TO_SHIP"], new Date(0));
    expect(r).toEqual({ orders: [], firstPage: null, shape: "records:array(0)" });
  });

  it("keeps reading full pages and stops when a page repeats", async () => {
    const full = Array.from({ length: 200 }, (_, i) => o(`N-${i}`));
    const { client, asked } = fakeClient({ 1: { records: full }, 2: { records: full } });
    const r = await queryOrders(client, ["READY_TO_SHIP"], new Date(0));
    expect(r.orders).toHaveLength(200);
    expect(asked).toEqual([1, 2]);
  });
});

describe("queryOrdersByStatus", () => {
  /** A Michaels that honours only the FIRST status of a comma list: the failure we guard against. */
  function firstStatusOnly(orders: { orderNumber: string; status: string }[]): MichaelsClient {
    return {
      request: async <T>(_m: string, _p: string, req?: { query?: Record<string, unknown> }) => {
        const first = String(req?.query?.orderStatusList ?? "").split(",")[0];
        const page = Number(req?.query?.pageNumber);
        return { records: page === 1 ? orders.filter((x) => x.status === first) : [] } as T;
      },
    };
  }
  const live = [
    { orderNumber: "P1", status: "PENDING_CONFIRMATION" },
    { orderNumber: "R1", status: "READY_TO_SHIP" },
    { orderNumber: "R2", status: "READY_TO_SHIP" },
  ];

  it("a combined status list can miss ready-to-ship orders", async () => {
    const r = await queryOrders(
      firstStatusOnly(live),
      ["PENDING_CONFIRMATION", "READY_TO_SHIP"],
      new Date(0),
    );
    expect(r.orders.map((x) => x.orderNumber)).toEqual(["P1"]);
  });

  it("asking per status finds every order and counts each status", async () => {
    const r = await queryOrdersByStatus(
      firstStatusOnly(live),
      ["PENDING_CONFIRMATION", "READY_TO_SHIP", "PARTIAL_FULFILLED"],
      new Date(0),
    );
    expect(r.orders.map((x) => x.orderNumber).sort()).toEqual(["P1", "R1", "R2"]);
    expect(r.byStatus).toEqual({ PENDING_CONFIRMATION: 1, READY_TO_SHIP: 2, PARTIAL_FULFILLED: 0 });
    expect(r.firstPage).toBe(1);
  });
});

describe("catalog reads", () => {
  function catalog(pages: { listings: unknown[]; nextCursor?: string | null }[]) {
    const calls: { method: string; path: string; query: unknown }[] = [];
    let n = 0;
    const client: MichaelsClient = {
      request: async <T>(method: string, path: string, req?: { query?: unknown }) => {
        calls.push({ method, path, query: req?.query });
        return pages[Math.min(n++, pages.length - 1)] as T;
      },
    };
    return { client, calls };
  }

  it("follows the cursor to the end", async () => {
    const { client, calls } = catalog([
      { listings: [{ skuNumber: "1" }], nextCursor: "c2" },
      { listings: [{ skuNumber: "2" }], nextCursor: null },
    ]);
    const r = await allListings(client);
    expect(r).toMatchObject({ pages: 2, complete: true });
    expect(r.listings).toHaveLength(2);
    expect(calls.map((c) => c.query)).toEqual([
      { limit: 100, cursor: undefined },
      { limit: 100, cursor: "c2" },
    ]);
    expect(calls.every((c) => c.method === "GET" && c.path === "/listing/all-listings")).toBe(true);
  });

  it("stops on a cursor that repeats, and says when the page limit cut it short", async () => {
    const stuck = catalog([{ listings: [{ skuNumber: "1" }], nextCursor: "same" }]);
    expect((await allListings(stuck.client)).pages).toBe(2);
    const endless = catalog([
      { listings: [], nextCursor: "a" },
      { listings: [], nextCursor: "b" },
      { listings: [], nextCursor: "c" },
      { listings: [], nextCursor: "d" },
    ]);
    let i = 0;
    endless.client.request = async <T>() => ({ listings: [], nextCursor: `c${i++}` }) as T;
    expect(await allListings(endless.client, 3)).toMatchObject({ pages: 3, complete: false });
  });

  it("checks a key with one small read that is not retried", async () => {
    const { client, calls } = catalog([{ listings: [] }]);
    await checkKey(client);
    expect(calls).toEqual([{ method: "GET", path: "/listing/all-listings", query: { limit: 1 } }]);
  });

  it("asks for one listing's stock by its Michaels number", async () => {
    const { client, calls } = catalog([{ listings: [] }]);
    await listingInventory(client, "12/34");
    expect(calls[0]).toMatchObject({ method: "GET", path: "/listing/inventory/12%2F34" });
  });
});
