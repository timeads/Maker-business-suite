import { describe, expect, it } from "vitest";
import { memoryStore } from "../testing";
import type { SyncContext, TokenSet } from "../types";
import {
  parseAgedReceivables,
  parseBalanceSheet,
  parseCashFlow,
  parseProfitAndLoss,
  type QuickBooksReport,
} from "./quickbooks-reports";
import {
  channelName,
  classDateOf,
  mapShopifyOrders,
  syncShopify,
  type ShopifyGraphql,
} from "./shopify-sync";

const money = (amount: string) => ({ shopMoney: { amount } });

function shopifyOrder(id: string, overrides: Record<string, unknown> = {}) {
  return {
    legacyResourceId: id,
    name: `#${id}`,
    email: "sam@example.com",
    processedAt: "2026-11-10T15:00:00Z",
    updatedAt: "2026-11-11T09:00:00Z",
    cancelledAt: null,
    test: false,
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    currencyCode: "USD",
    sourceName: "web",
    app: { name: "Online Store" },
    currentSubtotalPriceSet: money("250.00"),
    currentTotalTaxSet: money("15.00"),
    totalShippingPriceSet: money("10.00"),
    currentTotalPriceSet: money("275.00"),
    customer: {
      legacyResourceId: "77",
      firstName: "Sam",
      lastName: "Shopper",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-11-10T15:00:00Z",
    },
    lineItems: {
      nodes: [
        {
          id: "gid://shopify/LineItem/501",
          title: "Wool Rug",
          variantTitle: "Large",
          sku: "RUG-L",
          currentQuantity: 2,
          discountedUnitPriceAfterAllDiscountsSet: money("100.00"),
          product: {
            legacyResourceId: "900",
            title: "Wool Rug",
            vendor: "Wild Thread",
            productType: "Rugs",
            status: "ACTIVE",
            updatedAt: "2026-10-01T00:00:00Z",
          },
          variant: { inventoryItem: { unitCost: { amount: "40.00" } } },
        },
        {
          id: "gid://shopify/LineItem/502",
          title: "Custom work",
          variantTitle: null,
          sku: null,
          currentQuantity: 1,
          discountedUnitPriceAfterAllDiscountsSet: money("50.00"),
          product: null,
          variant: null,
        },
      ],
    },
    ...overrides,
  };
}

function context(job: Partial<SyncContext["job"]>) {
  const memory = memoryStore();
  const ctx: SyncContext = {
    store: memory.store,
    connectionId: "conn-1",
    externalAccountId: "wild-thread.myshopify.com",
    token: { access_token: "t" } as TokenSet,
    job: { type: "full", topic: null, payload: null, cursor: null, ...job },
  };
  return { ctx, state: memory.state };
}

const NOW = new Date("2026-11-21T12:00:00Z");
/** What the fake store says it granted, unless a test says otherwise. */
const GRANTED = ["read_orders", "write_orders"];

describe("Shopify order mapping", () => {
  it("turns an order into rows, with net sales, costs, customer and products", () => {
    const { orders, customers, products } = mapShopifyOrders([shopifyOrder("1001") as never]);
    expect(orders[0]).toMatchObject({
      external_id: "1001",
      name: "#1001",
      customer_external_id: "77",
      net_sales: 250,
      // The shop didn't give its discounts here, so neither figure is guessed.
      gross_sales: null,
      total_discounts: null,
      total_tax: 15,
      total_shipping: 10,
      total: 275,
      channel: "Online Store",
      is_test: false,
    });
    expect(orders[0].lines).toEqual([
      expect.objectContaining({
        external_id: "501",
        title: "Wool Rug",
        quantity: 2,
        unit_price: 100,
        unit_cost: 40,
        product_external_id: "900",
      }),
      // No variant: the cost is unknown, not zero.
      expect.objectContaining({
        external_id: "502",
        quantity: 1,
        unit_price: 50,
        unit_cost: null,
        product_external_id: null,
      }),
    ]);
    expect(customers).toEqual([
      expect.objectContaining({ external_id: "77", email: "sam@example.com", first_name: "Sam" }),
    ]);
    expect(products).toEqual([expect.objectContaining({ external_id: "900", title: "Wool Rug" })]);
  });

  it("keeps the order's and products' tags and each item's date, for Money's business lines", () => {
    const base = shopifyOrder("1003");
    const [rug, custom] = base.lineItems.nodes;
    const { orders, products } = mapShopifyOrders([
      shopifyOrder("1003", {
        tags: ["Workshop", " ", "gift"],
        lineItems: {
          nodes: [
            {
              ...rug,
              product: { ...rug.product, tags: ["wool", ""] },
              customAttributes: [
                { key: "Session ID", value: "6F1C2B3A-1111-4222-8333-444455556666" },
                { key: "_text_phone", value: "555 0100" },
              ],
            },
            {
              ...custom,
              customAttributes: [
                { key: "_date_iso8601", value: "2026-12-05T14:00:00-05:00" },
                { key: "Date", value: "2026-12-04" },
                { key: "Note", value: "2026-01-01 please" },
              ],
            },
          ],
        },
      }) as never,
    ]);
    expect(orders[0].tags).toEqual(["Workshop", "gift"]);
    expect(products[0].tags).toEqual(["wool"]);
    expect(orders[0].lines[0]).toMatchObject({
      session_ref: "6f1c2b3a-1111-4222-8333-444455556666",
      class_date: null,
    });
    // The earliest date under a name that says it's a date; nothing else from the line.
    expect(orders[0].lines[1]).toMatchObject({ session_ref: null, class_date: "2026-12-04" });
    expect(JSON.stringify(orders[0])).not.toContain("555 0100");
  });

  it("reads no tags as none, never as a reason to fail", () => {
    const { orders, products } = mapShopifyOrders([shopifyOrder("1004", { tags: null }) as never]);
    expect(orders[0].tags).toEqual([]);
    expect(products[0].tags).toEqual([]);
    expect(classDateOf([{ key: "Class date", value: "not a date" }])).toBeNull();
    expect(classDateOf(null)).toBeNull();
  });

  it("adds the shop's discounts back on for the products' total before them", () => {
    const { orders } = mapShopifyOrders([
      shopifyOrder("1002", {
        currentSubtotalPriceSet: money("285.60"),
        currentTotalDiscountsSet: money("50.40"),
      }) as never,
    ]);
    expect(orders[0]).toMatchObject({ net_sales: 285.6, gross_sales: 336, total_discounts: 50.4 });
  });

  it("lists a repeat customer and product once per page", () => {
    const { customers, products } = mapShopifyOrders([
      shopifyOrder("1") as never,
      shopifyOrder("2") as never,
    ]);
    expect(customers).toHaveLength(1);
    expect(products).toHaveLength(1);
  });

  it("gives sales channels plain names", () => {
    expect(channelName("web", "Online Store")).toBe("Online Store");
    expect(channelName("pos", null)).toBe("Point of Sale");
    expect(channelName("shopify_draft_order", null)).toBe("Draft orders");
    expect(channelName("580111", "Faire")).toBe("Faire");
    expect(channelName("580111", null)).toBe("Other");
    expect(channelName(null, null)).toBe("Other");
  });
});

describe("Shopify sync", () => {
  type Page = { nodes: unknown[]; hasNextPage: boolean; endCursor: string | null };
  function pagedGraphql(pages: Page[], stockPages: Page[] = []) {
    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    const stockCalls: Record<string, unknown>[] = [];
    const photoCalls: string[] = [];
    let photoRefusals = 0;
    const shippingCalls: Record<string, unknown>[] = [];
    const shippingQueries: string[] = [];
    let shippingFails = false;
    let deliveryMethodsFail = false;
    let pickup = false;
    let granted: string[] | "fail" = GRANTED;
    const scopeChecks: string[] = [];
    const graphql = (async (_shop: string, _token: TokenSet, query: string, variables?: object) => {
      if (query.includes("currentAppInstallation")) {
        scopeChecks.push(query);
        if (granted === "fail") throw new Error("Shopify is having a moment");
        return {
          currentAppInstallation: { accessScopes: granted.map((handle) => ({ handle })) },
        };
      }
      if (query.includes("shippingAddress")) {
        shippingCalls.push((variables ?? {}) as Record<string, unknown>);
        shippingQueries.push(query);
        if (shippingFails) throw new Error("Access denied for shippingAddress field");
        const withDelivery = query.includes("fulfillmentOrders");
        if (withDelivery && deliveryMethodsFail) {
          throw new Error("Access denied for fulfillmentOrders field");
        }
        return {
          nodes: ((variables as { ids: string[] }).ids ?? []).map((id) => ({
            legacyResourceId: id.split("/").pop(),
            displayFinancialStatus: "PAID",
            note: null,
            currentTotalWeight: "1361",
            currentShippingPriceSet: money("8.50"),
            tags: ["Returning_Customer", " "],
            ...(withDelivery
              ? {
                  fulfillmentOrders: {
                    nodes: [
                      {
                        status: "OPEN",
                        deliveryMethod: { methodType: pickup ? "PICK_UP" : "SHIPPING" },
                      },
                    ],
                  },
                }
              : {}),
            shippingAddress: {
              name: "Sam Shopper",
              company: null,
              address1: "12 Mill Lane",
              address2: null,
              city: "Hudson",
              provinceCode: "NY",
              zip: "12534",
              countryCodeV2: "US",
              phone: null,
            },
            shippingLines: { nodes: [{ title: pickup ? "Studio pickup" : "Standard" }] },
            lineItems: {
              nodes: [
                {
                  id: "gid://shopify/LineItem/501",
                  title: "Wool rug",
                  variantTitle: "Large",
                  sku: "RUG-L",
                  currentQuantity: 2,
                  unfulfilledQuantity: 1,
                  requiresShipping: true,
                  discountedUnitPriceAfterAllDiscountsSet: money("100.00"),
                  image: { url: "https://cdn.shopify.com/s/files/1/rug-large.jpg?v=3&width=120" },
                  variant: {
                    barcode: " 0123456789012 ",
                    inventoryItem: { measurement: { weight: { unit: "POUNDS", value: 2 } } },
                  },
                },
                {
                  id: "gid://shopify/LineItem/502",
                  title: "Gift card",
                  variantTitle: null,
                  sku: null,
                  currentQuantity: 1,
                  unfulfilledQuantity: 1,
                  requiresShipping: false,
                },
              ],
            },
          })),
        };
      }
      if (query.includes("ordersCount")) {
        return { all: { count: 0 }, window: { count: 0 } };
      }
      if (query.includes("ProductPhotos")) {
        photoCalls.push(query);
        if (photoRefusals > 0 && query.includes("featuredMedia")) {
          photoRefusals -= 1;
          throw new Error("Field 'featuredMedia' doesn't exist");
        }
        return {
          products: {
            nodes: [
              {
                legacyResourceId: "900",
                onlineStoreUrl: "https://shop.example/products/rug",
                ...(query.includes("featuredMedia")
                  ? {
                      featuredMedia: {
                        preview: { image: { url: "https://cdn.shopify.com/a.jpg" } },
                      },
                    }
                  : { featuredImage: { url: "https://cdn.shopify.com/old.jpg" } }),
              },
              { legacyResourceId: "901", onlineStoreUrl: null, featuredMedia: null },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      if (query.includes("productVariants")) {
        stockCalls.push((variables ?? {}) as Record<string, unknown>);
        const page = stockPages[Math.min(stockCalls.length - 1, stockPages.length - 1)] ?? {
          nodes: [],
          hasNextPage: false,
          endCursor: null,
        };
        return {
          productVariants: {
            nodes: page.nodes,
            pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
          },
        };
      }
      calls.push({ query, variables: (variables ?? {}) as Record<string, unknown> });
      const page = pages[Math.min(calls.length - 1, pages.length - 1)];
      return {
        orders: {
          nodes: page.nodes,
          pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor },
        },
      };
    }) as ShopifyGraphql;
    return {
      graphql,
      calls,
      stockCalls,
      photoCalls,
      refusePhotosOnce() {
        photoRefusals = 1;
      },
      shippingCalls,
      shippingQueries,
      denyShipping: () => {
        shippingFails = true;
      },
      denyDeliveryMethods: () => {
        deliveryMethodsFail = true;
      },
      makePickup: () => {
        pickup = true;
      },
      scopeChecks,
      grant: (scopes: string[] | "fail") => {
        granted = scopes;
      },
    };
  }

  it("asks what the store has granted once a read finishes, and never fails the read over it", async () => {
    const net = pagedGraphql([{ nodes: [shopifyOrder("1")], hasNextPage: false, endCursor: null }]);
    net.grant(["write_orders", "read_orders", "write_orders"]);
    const { ctx, state } = context({ type: "incremental" });
    const result = await syncShopify(ctx, net.graphql, NOW);
    expect(result.scopes).toEqual(["read_orders", "write_orders"]);
    expect(net.scopeChecks).toHaveLength(1);
    expect(state.orders).toHaveLength(1);

    net.grant("fail");
    const second = context({ type: "incremental" });
    const quiet = await syncShopify(second.ctx, net.graphql, NOW);
    expect(quiet.scopes).toBeUndefined();
    expect(quiet.cursor).toBeDefined();
  });

  it("doesn't ask about permissions for a single order notice", async () => {
    const net = pagedGraphql([]);
    const { ctx } = context({
      type: "webhook",
      topic: "customers/update",
      payload: { id: 1 },
    });
    const result = await syncShopify(ctx, net.graphql, NOW);
    expect(net.scopeChecks).toHaveLength(0);
    expect(result.scopes).toBeUndefined();
  });

  const variant = (id: string, overrides: Record<string, unknown> = {}) => ({
    legacyResourceId: id,
    title: "Large",
    sku: " RUG-L ",
    inventoryQuantity: 4,
    product: { legacyResourceId: "p1", title: "Wool rug", status: "ACTIVE" },
    inventoryItem: {
      id: `gid://shopify/InventoryItem/${id}`,
      tracked: true,
      unitCost: { amount: "60.00" },
    },
    ...overrides,
  });

  it("reads what packing needs for each page of orders, leaving out things that don't ship", async () => {
    const net = pagedGraphql([{ nodes: [shopifyOrder("7")], hasNextPage: false, endCursor: null }]);
    const { ctx, state } = context({ type: "full" });
    await syncShopify(ctx, net.graphql, NOW);
    expect(net.shippingCalls[0]).toEqual({ ids: ["gid://shopify/Order/7"] });
    expect(state.shipping).toEqual([
      expect.objectContaining({
        external_id: "7",
        recipient: "Sam Shopper",
        region: "NY",
        country_code: "US",
        shipping_method: "Standard",
        shipping_paid: 8.5,
        weight_grams: 1361,
        pickup: false,
        paid: true,
        tags: ["Returning_Customer"],
        items: [
          {
            line_id: "gid://shopify/LineItem/501",
            title: "Wool rug",
            variant: "Large",
            sku: "RUG-L",
            barcode: "0123456789012",
            // Two pounds, kept in grams.
            grams: 907,
            price: 100,
            // The picture of the option that was ordered, small.
            image: "https://cdn.shopify.com/s/files/1/rug-large.jpg?v=3&width=120",
            qty: 2,
            left: 1,
          },
        ],
      }),
    ]);
  });

  it("knows a pickup from how the shop says the order is delivered", async () => {
    const net = pagedGraphql([{ nodes: [shopifyOrder("7")], hasNextPage: false, endCursor: null }]);
    net.makePickup();
    const { ctx, state } = context({ type: "full" });
    await syncShopify(ctx, net.graphql, NOW);
    expect(state.shipping[0]).toMatchObject({ pickup: true, shipping_method: "Studio pickup" });
  });

  it("a shop that won't say how orders are delivered still gets its packing list", async () => {
    const net = pagedGraphql([
      { nodes: [shopifyOrder("1")], hasNextPage: true, endCursor: "c1" },
      { nodes: [shopifyOrder("2")], hasNextPage: false, endCursor: null },
    ]);
    net.denyDeliveryMethods();
    net.makePickup();
    const { ctx, state } = context({ type: "full" });
    await syncShopify(ctx, net.graphql, NOW);
    // Asked in full once, then without the delivery part for the rest of the run.
    expect(net.shippingQueries.map((query) => query.includes("fulfillmentOrders"))).toEqual([
      true,
      false,
      false,
    ]);
    expect(state.shipping.map((order) => order.external_id)).toEqual(["1", "2"]);
    // Falls back on the name of the checkout option.
    expect(state.shipping.every((order) => order.pickup)).toBe(true);
    expect(state.shipping[0]).toMatchObject({ shipping_paid: 8.5, weight_grams: 1361 });
  });

  it("a shop that won't share addresses still gets its sales, and is asked only once", async () => {
    const net = pagedGraphql([
      { nodes: [shopifyOrder("1")], hasNextPage: true, endCursor: "c1" },
      { nodes: [shopifyOrder("2")], hasNextPage: false, endCursor: null },
    ]);
    net.denyShipping();
    const { ctx, state } = context({ type: "full" });
    const result = await syncShopify(ctx, net.graphql, NOW);
    expect(state.orders.map((o) => o.external_id)).toEqual(["1", "2"]);
    expect(state.shipping).toEqual([]);
    // One page's worth: the full question, then once more without the delivery
    // part in case that was the trouble. The second page isn't asked at all.
    expect(net.shippingCalls).toHaveLength(2);
    expect(net.shippingCalls.every((call) => String(call.ids) === "gid://shopify/Order/1")).toBe(
      true,
    );
    expect(result.cursor).toBeDefined();
  });

  it("notes each option's own photo, and still counts stock for a shop that won't share photos", async () => {
    const stock = [
      {
        nodes: [
          variant("v1", { image: { url: "https://cdn.shopify.com/s/rug-large.jpg" } }),
          // Not on the shop platform's image servers: never kept.
          variant("v2", { image: { url: "https://elsewhere.example/x.jpg" } }),
        ],
        hasNextPage: false,
        endCursor: null,
      },
    ];
    const cursor = { synced_through: "2026-11-20T00:00:00.000Z" };
    const net = pagedGraphql([{ nodes: [], hasNextPage: false, endCursor: null }], stock);
    const first = context({ type: "incremental", cursor });
    await syncShopify(first.ctx, net.graphql, NOW);
    expect(first.state.variantPhotos).toEqual([
      { external_id: "v1", image_url: "https://cdn.shopify.com/s/rug-large.jpg?width=160" },
      { external_id: "v2", image_url: null },
    ]);

    // A shop that refuses the question with photos is asked again without them.
    const plain = pagedGraphql([{ nodes: [], hasNextPage: false, endCursor: null }], stock);
    const asked: boolean[] = [];
    const picky = (async (shop, token, query, variables) => {
      if (query.includes("productVariants")) {
        asked.push(query.includes("image {"));
        if (query.includes("image {")) throw new Error("Field 'image' doesn't exist");
      }
      return plain.graphql(shop, token, query, variables);
    }) as ShopifyGraphql;
    const second = context({ type: "incremental", cursor });
    await syncShopify(second.ctx, picky, NOW);
    expect(asked).toEqual([true, false]);
    expect(second.state.stock.map((item) => item.external_id)).toEqual(["v1", "v2"]);
    expect(second.state.variantPhotos).toEqual([]);
    expect(second.state.stockTags).toEqual([]);
  });

  it("notes each product's shop tags once, for the “never reorder” tag rule", async () => {
    const product = (id: string, tags: unknown) => ({
      legacyResourceId: id,
      title: "Wool rug",
      status: "ACTIVE",
      vendor: null,
      tags,
    });
    const stock = [
      {
        nodes: [
          variant("v1", { product: product("p1", ["Made to order", "  wool ", ""]) }),
          variant("v2", { product: product("p1", ["Made to order", "  wool ", ""]) }),
          variant("v3", { product: product("p2", []) }),
          // A shop that didn't answer with tags for this one: left alone.
          variant("v4", { product: product("p3", undefined) }),
        ],
        hasNextPage: false,
        endCursor: null,
      },
    ];
    const net = pagedGraphql([{ nodes: [], hasNextPage: false, endCursor: null }], stock);
    const { ctx, state } = context({
      type: "incremental",
      cursor: { synced_through: "2026-11-20T00:00:00.000Z" },
    });
    const queries: string[] = [];
    const watching = (async (shop, token, query, variables) => {
      if (query.includes("productVariants")) queries.push(query);
      return net.graphql(shop, token, query, variables);
    }) as ShopifyGraphql;
    await syncShopify(ctx, watching, NOW);
    expect(queries[0]).toContain("vendor tags");
    expect(state.stockTags).toEqual([
      { product_external_id: "p1", tags: ["Made to order", "wool"] },
      { product_external_id: "p2", tags: [] },
    ]);
  });

  it("reads the stock count once the orders are in, and carries on where it left off", async () => {
    const net = pagedGraphql(
      [{ nodes: [], hasNextPage: false, endCursor: null }],
      [
        {
          nodes: [variant("v1"), variant("v2", { title: "Default Title", sku: null })],
          hasNextPage: false,
          endCursor: null,
        },
      ],
    );
    const { ctx, state } = context({
      type: "incremental",
      cursor: { synced_through: "2026-11-20T00:00:00.000Z" },
    });
    const result = await syncShopify(ctx, net.graphql, NOW);
    expect(state.stock).toEqual([
      {
        external_id: "v1",
        product_external_id: "p1",
        inventory_item_id: "gid://shopify/InventoryItem/v1",
        title: "Wool rug",
        variant_title: "Large",
        sku: "RUG-L",
        on_hand: 4,
        unit_cost: 60,
        tracked: true,
        product_status: "ACTIVE",
        vendor: null,
        price: null,
      },
      expect.objectContaining({ external_id: "v2", variant_title: null, sku: null }),
    ]);
    expect(result).toEqual({ cursor: { synced_through: NOW.toISOString() }, scopes: GRANTED });

    // A shop with a great many items pauses part-way and picks up from its marker.
    const big = pagedGraphql(
      [{ nodes: [], hasNextPage: false, endCursor: null }],
      [{ nodes: [variant("v1")], hasNextPage: true, endCursor: "s-more" }],
    );
    const first = context({ type: "full" });
    const paused = await syncShopify(first.ctx, big.graphql, NOW);
    expect(paused.continueWith).toEqual({ stock_after: "s-more", started_at: NOW.toISOString() });
    const rest = pagedGraphql(
      [],
      [{ nodes: [variant("v9")], hasNextPage: false, endCursor: null }],
    );
    const second = context({ type: "full", cursor: paused.continueWith });
    const finished = await syncShopify(second.ctx, rest.graphql, new Date("2026-11-21T13:00:00Z"));
    expect(rest.calls).toHaveLength(0);
    expect(rest.stockCalls[0]).toMatchObject({ after: "s-more" });
    expect(finished).toEqual({ cursor: { synced_through: NOW.toISOString() }, scopes: GRANTED });
  });

  it("a first sync reaches back two years, pages through, and records where it got to", async () => {
    const net = pagedGraphql([
      { nodes: [shopifyOrder("1")], hasNextPage: true, endCursor: "c1" },
      { nodes: [shopifyOrder("2")], hasNextPage: false, endCursor: null },
    ]);
    const { ctx, state } = context({ type: "full" });
    const result = await syncShopify(ctx, net.graphql, NOW);

    expect(state.orders.map((o) => o.external_id)).toEqual(["1", "2"]);
    expect(net.calls[0].variables).toMatchObject({
      after: null,
      query: "updated_at:>=2024-11-21T12:00:00Z status:any",
    });
    expect(net.calls[1].variables).toMatchObject({ after: "c1" });
    expect(result).toEqual({ cursor: { synced_through: NOW.toISOString() }, scopes: GRANTED });
    expect(state.usage).toBe(7);
    // A whole read of the history: Money's one-off backfill is done for this shop.
    expect(state.detailsRead).toBe(1);
  });

  it("a later sync only asks for what changed since the last one finished", async () => {
    const net = pagedGraphql([{ nodes: [], hasNextPage: false, endCursor: null }]);
    const { ctx, state } = context({
      type: "incremental",
      cursor: { synced_through: "2026-11-20T00:00:00.000Z" },
    });
    await syncShopify(ctx, net.graphql, NOW);
    expect(net.calls[0].variables.query).toBe("updated_at:>=2026-11-20T00:00:00Z status:any");
    // Only a full read counts towards the backfill.
    expect(state.detailsRead).toBe(0);
  });

  it("notes each product's main photo, and falls back to the older spelling without failing the sync", async () => {
    const net = pagedGraphql([{ nodes: [], hasNextPage: false, endCursor: null }]);
    const { ctx, state } = context({ type: "full" });
    await syncShopify(ctx, net.graphql, NOW);
    expect(state.productPhotos).toEqual([
      {
        product_external_id: "900",
        image_url: "https://cdn.shopify.com/a.jpg",
        product_url: "https://shop.example/products/rug",
      },
      { product_external_id: "901", image_url: null, product_url: null },
    ]);

    const older = pagedGraphql([{ nodes: [], hasNextPage: false, endCursor: null }]);
    older.refusePhotosOnce();
    const second = context({ type: "full" });
    const result = await syncShopify(second.ctx, older.graphql, NOW);
    expect(older.photoCalls).toHaveLength(2);
    expect(second.state.productPhotos[0].image_url).toBe("https://cdn.shopify.com/old.jpg");
    expect(result).toEqual({ cursor: { synced_through: NOW.toISOString() }, scopes: GRANTED });
  });

  it("a very long sync stops after a batch of pages and asks to be continued", async () => {
    const net = pagedGraphql([
      { nodes: [shopifyOrder("1")], hasNextPage: true, endCursor: "more" },
    ]);
    const first = context({ type: "full" });
    const result = await syncShopify(first.ctx, net.graphql, NOW);
    expect(net.calls).toHaveLength(20);
    expect(result.continueWith).toMatchObject({ after: "more", started_at: NOW.toISOString() });
    expect(result.cursor).toBeUndefined();

    // The continuation keeps the same window and start time, so nothing that
    // changed during the long sync is skipped next time.
    const later = new Date("2026-11-21T13:00:00Z");
    const done = pagedGraphql([{ nodes: [], hasNextPage: false, endCursor: null }]);
    const next = context({ type: "full", cursor: result.continueWith });
    const finished = await syncShopify(next.ctx, done.graphql, later);
    expect(done.calls[0].variables).toMatchObject({
      after: "more",
      query: "updated_at:>=2024-11-21T12:00:00Z status:any",
    });
    expect(finished).toEqual({ cursor: { synced_through: NOW.toISOString() }, scopes: GRANTED });
  });

  it("an order webhook re-reads that order from Shopify rather than trusting the payload", async () => {
    const calls: Record<string, unknown>[] = [];
    const graphql = (async (_s: string, _t: TokenSet, _q: string, variables?: object) => {
      calls.push(variables as Record<string, unknown>);
      return { order: shopifyOrder("1001", { currentSubtotalPriceSet: money("80.00") }) };
    }) as ShopifyGraphql;
    const { ctx, state } = context({
      type: "webhook",
      topic: "orders/updated",
      payload: {
        id: 1001,
        admin_graphql_api_id: "gid://shopify/Order/1001",
        subtotal_price: "999.00",
      },
    });
    await syncShopify(ctx, graphql, NOW);
    // The order itself, then what packing needs for it.
    expect(calls).toEqual([
      { id: "gid://shopify/Order/1001" },
      { ids: ["gid://shopify/Order/1001"] },
    ]);
    expect(state.orders).toEqual([expect.objectContaining({ external_id: "1001", net_sales: 80 })]);
  });

  it("handles privacy requests: erase a shopper, erase the store, pass on a data request", async () => {
    const never = (async () => {
      throw new Error("privacy webhooks must not call Shopify");
    }) as ShopifyGraphql;

    const redact = context({
      type: "webhook",
      topic: "customers/redact",
      payload: { customer: { id: 77, email: "sam@example.com" } },
    });
    expect(await syncShopify(redact.ctx, never, NOW)).toEqual({});
    expect(redact.state.redacted).toEqual([{ externalId: "77", email: "sam@example.com" }]);

    const shop = context({ type: "webhook", topic: "shop/redact", payload: {} });
    expect((await syncShopify(shop.ctx, never, NOW)).disconnected).toBeTruthy();
    expect(shop.state.purged).toBe(1);

    const request = context({
      type: "webhook",
      topic: "customers/data_request",
      payload: { customer: { id: 77, email: "sam@example.com" } },
    });
    await syncShopify(request.ctx, never, NOW);
    expect(request.state.notices).toHaveLength(1);
    expect(request.state.notices[0].text).toContain("sam@example.com");

    const uninstall = context({ type: "webhook", topic: "app/uninstalled", payload: {} });
    expect((await syncShopify(uninstall.ctx, never, NOW)).disconnected).toBeTruthy();
    // Uninstalling alone keeps the data, in case the store reconnects.
    expect(uninstall.state.purged).toBe(0);
  });
});

describe("QuickBooks reports", () => {
  const monthColumn = (title: string, start: string, end: string) => ({
    ColTitle: title,
    ColType: "Money",
    MetaData: [
      { Name: "StartDate", Value: start },
      { Name: "EndDate", Value: end },
    ],
  });
  const section = (group: string, label: string, values: string[]) => ({
    type: "Section",
    group,
    Summary: { ColData: [{ value: label }, ...values.map((value) => ({ value }))] },
  });

  const profitAndLoss: QuickBooksReport = {
    Header: { Currency: "USD" },
    Columns: {
      Column: [
        { ColTitle: "", ColType: "Account" },
        monthColumn("Oct 2026", "2026-10-01", "2026-10-31"),
        monthColumn("Nov 2026", "2026-11-01", "2026-11-21"),
        {
          ColTitle: "Total",
          ColType: "Money",
          MetaData: [
            { Name: "StartDate", Value: "2026-10-01" },
            { Name: "EndDate", Value: "2026-11-21" },
          ],
        },
      ],
    },
    Rows: {
      Row: [
        section("Income", "Total Income", ["1,000.00", "2,500.50", "3,500.50"]),
        section("COGS", "Total Cost of Goods Sold", ["400.00", "900.00", "1,300.00"]),
        section("GrossProfit", "Gross Profit", ["600.00", "1,600.50", "2,200.50"]),
        section("Expenses", "Total Expenses", ["250.00", "300.00", "550.00"]),
        section("NetIncome", "Net Income", ["350.00", "1,300.50", "1,650.50"]),
      ],
    },
  };

  it("reads one month per column and ignores the total column", () => {
    expect(parseProfitAndLoss(profitAndLoss)).toEqual([
      {
        kind: "profit_and_loss",
        period_start: "2026-10-01",
        period_end: "2026-10-31",
        data: {
          income: 1000,
          cogs: 400,
          gross_profit: 600,
          expenses: 250,
          net_income: 350,
          other_income_cents: 0,
          other_expenses_cents: 0,
          lines: [],
          currency: "USD",
        },
      },
      {
        kind: "profit_and_loss",
        period_start: "2026-11-01",
        period_end: "2026-11-21",
        data: {
          income: 2500.5,
          cogs: 900,
          gross_profit: 1600.5,
          expenses: 300,
          net_income: 1300.5,
          other_income_cents: 0,
          other_expenses_cents: 0,
          lines: [],
          currency: "USD",
        },
      },
    ]);
  });

  it("keeps each account's own line per month, sub-accounts one deeper, zeros left out", () => {
    const data = (name: string, values: string[]) => ({
      type: "Data",
      ColData: [{ value: name }, ...values.map((value) => ({ value }))],
    });
    const lined: QuickBooksReport = {
      ...profitAndLoss,
      Rows: {
        Row: [
          {
            type: "Section",
            group: "Income",
            Header: { ColData: [{ value: "Income" }] },
            Rows: { Row: [data("Class income", ["600.00", "0.00", "600.00"])] },
            Summary: { ColData: [{ value: "Total Income" }, { value: "1,000.00" }] },
          },
          {
            type: "Section",
            group: "Expenses",
            Header: { ColData: [{ value: "Expenses" }] },
            Rows: {
              Row: [
                {
                  type: "Section",
                  Header: { ColData: [{ value: "Studio" }, { value: "" }] },
                  Rows: { Row: [data("Studio:Rent", ["200.00", "200.00", "400.00"])] },
                },
              ],
            },
          },
        ],
      },
    };
    const months = parseProfitAndLoss(lined);
    expect(months[0].data.lines).toEqual([
      { section: "Income", name: "Class income", depth: 0, cents: 60000 },
      { section: "Expenses", name: "Studio:Rent", depth: 1, cents: 20000 },
    ]);
    expect(months[1].data.lines).toEqual([
      { section: "Expenses", name: "Studio:Rent", depth: 1, cents: 20000 },
    ]);
  });

  it("reads other income and other expenses in whole cents", () => {
    const withOther: QuickBooksReport = {
      ...profitAndLoss,
      Rows: {
        Row: [
          ...(profitAndLoss.Rows?.Row ?? []),
          {
            group: "NetOtherIncome",
            Rows: {
              Row: [
                section("OtherIncome", "Total Other Income", ["5,000.10", "0.00", "5,000.10"]),
                section("OtherExpenses", "Total Other Expenses", ["12.34", "0.01", "12.35"]),
              ],
            },
          },
        ],
      },
    };
    const months = parseProfitAndLoss(withOther);
    expect(months[0].data).toMatchObject({
      other_income_cents: 500010,
      other_expenses_cents: 1234,
    });
    expect(months[1].data).toMatchObject({ other_income_cents: 0, other_expenses_cents: 1 });
  });

  it("reads the cash flow statement month by month, in whole cents", () => {
    const cashFlow: QuickBooksReport = {
      Header: { Currency: "USD" },
      Columns: profitAndLoss.Columns,
      Rows: {
        Row: [
          section("OperatingActivities", "Net cash provided by operating activities", [
            "-1,234.56",
            "800.00",
            "-434.56",
          ]),
          section("InvestingActivities", "Net cash provided by investing activities", [
            "-500.00",
            "",
            "-500.00",
          ]),
          section("FinancingActivities", "Net cash provided by financing activities", [
            "2,000.00",
            "-100.00",
            "1,900.00",
          ]),
          section("CashIncrease", "Net cash increase for period", ["265.44", "700.00", "965.44"]),
          section("EndingCash", "Cash at end of period", ["10,265.44", "10,965.44", "10,965.44"]),
        ],
      },
    };
    expect(parseCashFlow(cashFlow)).toEqual([
      {
        kind: "cash_flow",
        period_start: "2026-10-01",
        period_end: "2026-10-31",
        data: {
          operating_cents: -123456,
          investing_cents: -50000,
          financing_cents: 200000,
          net_change_cents: 26544,
          ending_cash_cents: 1026544,
          currency: "USD",
        },
      },
      {
        kind: "cash_flow",
        period_start: "2026-11-01",
        period_end: "2026-11-21",
        data: {
          operating_cents: 80000,
          investing_cents: 0,
          financing_cents: -10000,
          net_change_cents: 70000,
          ending_cash_cents: 1096544,
          currency: "USD",
        },
      },
    ]);
    // No net change row: the three sections added up. No operating section: nothing.
    const bare = {
      ...cashFlow,
      Rows: { Row: (cashFlow.Rows?.Row ?? []).slice(0, 3) },
    };
    expect(parseCashFlow(bare)[0].data).toMatchObject({
      net_change_cents: 26544,
      ending_cash_cents: null,
    });
    expect(parseCashFlow({ ...cashFlow, Rows: { Row: [] } })).toEqual([]);
  });

  it("keeps each bank account's line under cash in the bank", () => {
    const sheet: QuickBooksReport = {
      Rows: {
        Row: [
          {
            ...section("BankAccounts", "Total Bank Accounts", ["1,500.25"]),
            Rows: {
              Row: [
                { type: "Data", ColData: [{ value: "Checking" }, { value: "1,000.00" }] },
                { type: "Data", ColData: [{ value: "Savings", id: "35" }, { value: "500.25" }] },
              ],
            },
          },
        ],
      },
    };
    expect(parseBalanceSheet(sheet, "2026-11-21")?.data.bank_accounts).toEqual([
      { name: "Checking", cents: 100000 },
      // The books' own id for the account, where the report gives one.
      { name: "Savings", cents: 50025, id: "35" },
    ]);
  });

  it("works out gross profit when the books have no cost-of-goods section", () => {
    const noCogs: QuickBooksReport = {
      ...profitAndLoss,
      Rows: { Row: [section("Income", "Total Income", ["1,000.00", "2,000.00", "3,000.00"])] },
    };
    expect(parseProfitAndLoss(noCogs)[0].data).toMatchObject({
      income: 1000,
      cogs: 0,
      gross_profit: 1000,
    });
  });

  it("finds cash in the bank however deeply it is nested", () => {
    const balanceSheet: QuickBooksReport = {
      Header: { Currency: "USD" },
      Rows: {
        Row: [
          {
            group: "TotalAssets",
            Summary: { ColData: [{ value: "TOTAL ASSETS" }, { value: "9,000.00" }] },
            Rows: {
              Row: [
                {
                  group: "CurrentAssets",
                  Rows: {
                    Row: [
                      section("BankAccounts", "Total Bank Accounts", ["4,321.09"]),
                      section("AR", "Total Accounts Receivable", ["650.00"]),
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    };
    expect(parseBalanceSheet(balanceSheet, "2026-11-21")).toEqual({
      kind: "balance_sheet",
      period_start: "2026-11-21",
      period_end: "2026-11-21",
      data: {
        cash: 4321.09,
        bank_accounts: [],
        receivables: 650,
        total_assets: 9000,
        lines: [],
        currency: "USD",
      },
    });
    expect(parseBalanceSheet({ Rows: { Row: [] } }, "2026-11-21")).toBeNull();
  });

  it("reads what customers owe by how overdue it is", () => {
    const aging: QuickBooksReport = {
      Columns: {
        Column: [
          { ColTitle: "" },
          { ColTitle: "Current" },
          { ColTitle: "1 - 30" },
          { ColTitle: "31 - 60" },
          { ColTitle: "61 - 90" },
          { ColTitle: "91 and over" },
          { ColTitle: "Total" },
        ],
      },
      Rows: {
        Row: [
          {
            ColData: [
              { value: "A Customer" },
              { value: "100.00" },
              { value: "" },
              { value: "" },
              { value: "" },
              { value: "" },
              { value: "100.00" },
            ],
          },
          section("GrandTotal", "TOTAL", ["400.00", "150.00", "", "75.50", "0.00", "625.50"]),
        ],
      },
    };
    expect(parseAgedReceivables(aging, "2026-11-21")?.data).toEqual({
      buckets: [
        { label: "Current", amount: 400 },
        { label: "1 - 30", amount: 150 },
        { label: "31 - 60", amount: 0 },
        { label: "61 - 90", amount: 75.5 },
        { label: "91 and over", amount: 0 },
      ],
      total: 625.5,
      currency: null,
    });
    expect(parseAgedReceivables({ Rows: { Row: [] } }, "2026-11-21")).toBeNull();
  });
});
