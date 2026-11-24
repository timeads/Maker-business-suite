import { describe, expect, it } from "vitest";
import type { Fetch } from "../types";
import {
  StockWriteError,
  StockWriteUnsureError,
  canWriteShopifyStock,
  createShopifyStockWriter,
} from "./shopify-stock";

const token = { access_token: "test-access", refresh_token: null, expires_at: null } as never;

function shop(
  locations: { id: string; isActive: boolean }[],
  userErrors: { message: string }[] = [],
) {
  const sent: { query: string; variables: Record<string, never> }[] = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body));
    sent.push(body);
    const data = body.query.includes("locations")
      ? { locations: { nodes: locations.map((l) => ({ ...l, name: "Studio" })) } }
      : { inventoryAdjustQuantities: { userErrors, inventoryAdjustmentGroup: null } };
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as Fetch;
  return { writer: createShopifyStockWriter(fetchImpl), sent };
}
const change = {
  inventoryItemId: "gid://shopify/InventoryItem/1",
  delta: 5,
  reference: "app://po/2",
  key: "0b0e8a52-7c1f-4d55-9d0a-5d0f1c7b9a11",
};

describe("adding a delivery to the shop's count", () => {
  it("adds the units at the shop's one active location", async () => {
    const { writer, sent } = shop([
      { id: "gid://shopify/Location/1", isActive: true },
      { id: "gid://shopify/Location/2", isActive: false },
    ]);
    await writer.add("wild-thread.myshopify.com", token, change);
    expect(sent[1].query).toContain("@idempotent(key: $key)");
    expect(sent[1].variables).toEqual({
      key: "0b0e8a52-7c1f-4d55-9d0a-5d0f1c7b9a11",
      input: {
        reason: "received",
        name: "available",
        referenceDocumentUri: "app://po/2",
        changes: [
          {
            delta: 5,
            inventoryItemId: "gid://shopify/InventoryItem/1",
            locationId: "gid://shopify/Location/1",
          },
        ],
      },
    });
  });

  it("never takes stock away, and won't guess between two locations", async () => {
    const one = shop([{ id: "a", isActive: true }]);
    await expect(
      one.writer.add("s.myshopify.com", token, { ...change, delta: -2 }),
    ).rejects.toThrow(StockWriteError);
    expect(one.sent).toHaveLength(0);
    const two = shop([
      { id: "a", isActive: true },
      { id: "b", isActive: true },
    ]);
    await expect(two.writer.add("s.myshopify.com", token, change)).rejects.toThrow(
      /more than one place/,
    );
    expect(two.sent).toHaveLength(1);
  });

  it("passes on what the shop said when it refuses", async () => {
    const { writer } = shop(
      [{ id: "a", isActive: true }],
      [{ message: "Item is not stocked here" }],
    );
    await expect(writer.add("s.myshopify.com", token, change)).rejects.toThrow(/not stocked here/);
  });

  it("a plain no from the shop is a clean failure; an unclear answer is not", async () => {
    const refused = shop([{ id: "a", isActive: true }], [{ message: "Not stocked here" }]);
    const no = await refused.writer.add("s.myshopify.com", token, change).catch((e) => e);
    expect(no).toBeInstanceOf(StockWriteError);
    expect(no).not.toBeInstanceOf(StockWriteUnsureError);

    // The line drops while the shop is being asked to add the units.
    let calls = 0;
    const dropped = createShopifyStockWriter((async () => {
      calls += 1;
      if (calls > 1) throw new Error("socket hang up");
      return new Response(
        JSON.stringify({
          data: { locations: { nodes: [{ id: "a", name: "Studio", isActive: true }] } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as Fetch);
    await expect(dropped.add("s.myshopify.com", token, change)).rejects.toBeInstanceOf(
      StockWriteUnsureError,
    );

    // Not being able to read the shop's locations happens before anything is asked.
    const early = createShopifyStockWriter((async () => {
      throw new Error("no route");
    }) as unknown as Fetch);
    const before = await early.add("s.myshopify.com", token, change).catch((e) => e);
    expect(before).not.toBeInstanceOf(StockWriteUnsureError);
  });

  it("needs both permissions before it is offered", () => {
    expect(canWriteShopifyStock(["read_orders", "write_inventory", "read_locations"])).toBe(true);
    expect(canWriteShopifyStock(["read_orders", "write_inventory"])).toBe(false);
    expect(canWriteShopifyStock(undefined)).toBe(false);
  });
});
