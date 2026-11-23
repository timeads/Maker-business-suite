import { describe, expect, it } from "vitest";
import { memoryStore } from "../testing";
import type { SyncContext, TokenSet } from "../types";
import {
  parseAgedReceivables,
  parseBalanceSheet,
  parseProfitAndLoss,
  type QuickBooksReport,
} from "./quickbooks-reports";
import { channelName, mapShopifyOrders, syncShopify, type ShopifyGraphql } from "./shopify-sync";

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

describe("Shopify order mapping", () => {
  it("turns an order into rows, with net sales, costs, customer and products", () => {
    const { orders, customers, products } = mapShopifyOrders([shopifyOrder("1001") as never]);
    expect(orders[0]).toMatchObject({
      external_id: "1001",
      name: "#1001",
      customer_external_id: "77",
      net_sales: 250,
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
    const shippingCalls: Record<string, unknown>[] = [];
    let shippingFails = false;
    const graphql = (async (_shop: string, _token: TokenSet, query: string, variables?: object) => {
      if (query.includes("shippingAddress")) {
        shippingCalls.push((variables ?? {}) as Record<string, unknown>);
        if (shippingFails) throw new Error("Access denied for shippingAddress field");
        return {
          nodes: ((variables as { ids: string[] }).ids ?? []).map((id) => ({
            legacyResourceId: id.split("/").pop(),
            displayFinancialStatus: "PAID",
            note: null,
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
            shippingLines: { nodes: [{ title: "Standard" }] },
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
      shippingCalls,
      denyShipping: () => {
        shippingFails = true;
      },
    };
  }

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
        paid: true,
        items: [
          {
            line_id: "gid://shopify/LineItem/501",
            title: "Wool rug",
            variant: "Large",
            sku: "RUG-L",
            qty: 2,
            left: 1,
          },
        ],
      }),
    ]);
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
    expect(net.shippingCalls).toHaveLength(1);
    expect(result.cursor).toBeDefined();
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
    expect(result).toEqual({ cursor: { synced_through: NOW.toISOString() } });

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
    expect(finished).toEqual({ cursor: { synced_through: NOW.toISOString() } });
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
    expect(result).toEqual({ cursor: { synced_through: NOW.toISOString() } });
    expect(state.usage).toBe(5);
  });

  it("a later sync only asks for what changed since the last one finished", async () => {
    const net = pagedGraphql([{ nodes: [], hasNextPage: false, endCursor: null }]);
    const { ctx } = context({
      type: "incremental",
      cursor: { synced_through: "2026-11-20T00:00:00.000Z" },
    });
    await syncShopify(ctx, net.graphql, NOW);
    expect(net.calls[0].variables.query).toBe("updated_at:>=2026-11-20T00:00:00Z status:any");
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
    expect(finished).toEqual({ cursor: { synced_through: NOW.toISOString() } });
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
          currency: "USD",
        },
      },
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
      data: { cash: 4321.09, receivables: 650, total_assets: 9000, currency: "USD" },
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
