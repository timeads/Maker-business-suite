import type {
  CustomerRow,
  OrderRow,
  ProductRow,
  StockItemRow,
  SyncContext,
  SyncResult,
  TokenSet,
} from "../types";

/** How far back the first sync reaches. */
export const SHOPIFY_HISTORY_MONTHS = 24;
const PAGE_SIZE = 50;
/** Pages per job run; a long first sync continues as a chain of short jobs. */
const PAGES_PER_RUN = 20;

export type ShopifyGraphql = <T>(
  shop: string,
  token: TokenSet,
  query: string,
  variables?: object,
) => Promise<T>;

type Money = { shopMoney: { amount: string } } | null;

type ShopifyOrder = {
  legacyResourceId: string;
  name: string;
  email: string | null;
  processedAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  test: boolean;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  currencyCode: string;
  sourceName: string | null;
  app: { name: string } | null;
  currentSubtotalPriceSet: Money;
  currentTotalTaxSet: Money;
  totalShippingPriceSet: Money;
  currentTotalPriceSet: Money;
  customer: {
    legacyResourceId: string;
    firstName: string | null;
    lastName: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  lineItems: {
    nodes: {
      id: string;
      title: string;
      variantTitle: string | null;
      sku: string | null;
      currentQuantity: number;
      discountedUnitPriceAfterAllDiscountsSet: Money;
      product: {
        legacyResourceId: string;
        title: string;
        vendor: string | null;
        productType: string | null;
        status: string | null;
        updatedAt: string;
      } | null;
      variant: { inventoryItem: { unitCost: { amount: string } | null } | null } | null;
    }[];
  };
};

const ORDER_FIELDS = `
  legacyResourceId name email processedAt updatedAt cancelledAt test
  displayFinancialStatus displayFulfillmentStatus currencyCode sourceName
  app { name }
  currentSubtotalPriceSet { shopMoney { amount } }
  currentTotalTaxSet { shopMoney { amount } }
  totalShippingPriceSet { shopMoney { amount } }
  currentTotalPriceSet { shopMoney { amount } }
  customer { legacyResourceId firstName lastName createdAt updatedAt }
  lineItems(first: 100) {
    nodes {
      id title variantTitle sku currentQuantity
      discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
      product { legacyResourceId title vendor productType status updatedAt }
      variant { inventoryItem { unitCost { amount } } }
    }
  }`;

const ORDERS_QUERY = `query Orders($first: Int!, $after: String, $query: String) {
  orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { ${ORDER_FIELDS} }
  }
}`;

const ORDER_QUERY = `query Order($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`;

const CHANNEL_NAMES: Record<string, string> = {
  web: "Online Store",
  pos: "Point of Sale",
  shopify_draft_order: "Draft orders",
  iphone: "Shopify mobile app",
  android: "Shopify mobile app",
  subscription_contract: "Subscriptions",
};

const money = (value: Money): number => {
  const amount = Number(value?.shopMoney.amount ?? 0);
  return Number.isFinite(amount) ? amount : 0;
};

/** A plain name for where a sale happened. */
export function channelName(sourceName: string | null, appName: string | null): string {
  if (sourceName && CHANNEL_NAMES[sourceName]) return CHANNEL_NAMES[sourceName];
  // Numeric source names are app ids; the app's own name reads better.
  if (appName) return appName;
  return sourceName && !/^\d+$/.test(sourceName) ? sourceName : "Other";
}

export function mapShopifyOrders(orders: ShopifyOrder[]): {
  customers: CustomerRow[];
  products: ProductRow[];
  orders: OrderRow[];
} {
  const customers = new Map<string, CustomerRow>();
  const products = new Map<string, ProductRow>();
  const rows: OrderRow[] = [];

  for (const order of orders) {
    if (order.customer) {
      customers.set(order.customer.legacyResourceId, {
        external_id: order.customer.legacyResourceId,
        email: order.email,
        first_name: order.customer.firstName,
        last_name: order.customer.lastName,
        source_created_at: order.customer.createdAt,
        source_updated_at: order.customer.updatedAt,
      });
    }
    rows.push({
      external_id: order.legacyResourceId,
      name: order.name,
      customer_external_id: order.customer?.legacyResourceId ?? null,
      email: order.email,
      processed_at: order.processedAt,
      currency: order.currencyCode,
      net_sales: money(order.currentSubtotalPriceSet),
      total_tax: money(order.currentTotalTaxSet),
      total_shipping: money(order.totalShippingPriceSet),
      total: money(order.currentTotalPriceSet),
      financial_status: order.displayFinancialStatus,
      fulfillment_status: order.displayFulfillmentStatus,
      channel: channelName(order.sourceName, order.app?.name ?? null),
      cancelled_at: order.cancelledAt,
      is_test: order.test,
      source_updated_at: order.updatedAt,
      lines: order.lineItems.nodes.map((line) => {
        if (line.product) {
          products.set(line.product.legacyResourceId, {
            external_id: line.product.legacyResourceId,
            title: line.product.title,
            vendor: line.product.vendor,
            product_type: line.product.productType,
            status: line.product.status,
            source_updated_at: line.product.updatedAt,
          });
        }
        const cost = line.variant?.inventoryItem?.unitCost?.amount;
        return {
          external_id: line.id.split("/").pop() ?? line.id,
          product_external_id: line.product?.legacyResourceId ?? null,
          title: line.title,
          variant_title: line.variantTitle,
          sku: line.sku,
          quantity: line.currentQuantity,
          unit_price: money(line.discountedUnitPriceAfterAllDiscountsSet),
          unit_cost: cost == null ? null : Number(cost),
        };
      }),
    });
  }
  return { customers: [...customers.values()], products: [...products.values()], orders: rows };
}

type Cursor = {
  since?: string;
  after?: string | null;
  started_at?: string;
  synced_through?: string;
  /** Set while the stock count is being read, after the orders are done. */
  stock_after?: string | null;
};

type ShopifyVariant = {
  legacyResourceId: string;
  title: string;
  sku: string | null;
  inventoryQuantity: number | null;
  product: { legacyResourceId: string; title: string; status: string | null } | null;
  inventoryItem: { id: string; tracked: boolean; unitCost: { amount: string } | null } | null;
};

const VARIANTS_QUERY = `query Variants($first: Int!, $after: String) {
  productVariants(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      legacyResourceId title sku inventoryQuantity
      product { legacyResourceId title status }
      inventoryItem { id tracked unitCost { amount } }
    }
  }
}`;
const VARIANT_PAGE_SIZE = 100;

/** A product with no options has one variant that Shopify calls "Default Title". */
export function mapShopifyVariants(variants: ShopifyVariant[]): StockItemRow[] {
  return variants.map((variant) => {
    const cost = variant.inventoryItem?.unitCost?.amount;
    return {
      external_id: variant.legacyResourceId,
      product_external_id: variant.product?.legacyResourceId ?? null,
      inventory_item_id: variant.inventoryItem?.id ?? null,
      title: variant.product?.title ?? variant.title,
      variant_title: variant.title === "Default Title" ? null : variant.title,
      sku: variant.sku?.trim() || null,
      on_hand: variant.inventoryQuantity ?? 0,
      unit_cost: cost == null ? null : Number(cost),
      tracked: variant.inventoryItem?.tracked ?? false,
      product_status: variant.product?.status ?? null,
    };
  });
}

/**
 * Reads what the shop has on the shelf. Only ever reads: the count in the
 * shop changes when someone checks a delivery in, never during a sync.
 */
async function pullStock(
  ctx: SyncContext,
  graphql: ShopifyGraphql,
  startedAt: string,
  from: string | null,
): Promise<SyncResult> {
  let after = from;
  let calls = 0;
  for (let page = 0; page < PAGES_PER_RUN; page++) {
    const data = await graphql<{
      productVariants: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ShopifyVariant[];
      };
    }>(ctx.externalAccountId, ctx.token, VARIANTS_QUERY, { first: VARIANT_PAGE_SIZE, after });
    calls += 1;
    if (data.productVariants.nodes.length > 0) {
      await ctx.store.upsertStock(mapShopifyVariants(data.productVariants.nodes));
    }
    if (!data.productVariants.pageInfo.hasNextPage) {
      await ctx.store.recordUsage(calls);
      return { cursor: { synced_through: startedAt } };
    }
    after = data.productVariants.pageInfo.endCursor;
  }
  await ctx.store.recordUsage(calls);
  return { continueWith: { stock_after: after, started_at: startedAt } };
}

const monthsAgo = (months: number, from: Date) => {
  const date = new Date(from);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString();
};

/** Pulls orders (with their customers, products and costs) changed since the cursor. */
async function pullOrders(
  ctx: SyncContext,
  graphql: ShopifyGraphql,
  now: Date,
): Promise<SyncResult> {
  const previous = (ctx.job.cursor ?? {}) as Cursor;
  if (previous.stock_after !== undefined && previous.started_at) {
    return pullStock(ctx, graphql, previous.started_at, previous.stock_after);
  }
  // A continuation keeps its window; otherwise start from where the last
  // finished sync got to, or from the beginning of the history we keep.
  const since =
    previous.after !== undefined && previous.since
      ? previous.since
      : ctx.job.type === "full" || !previous.synced_through
        ? monthsAgo(SHOPIFY_HISTORY_MONTHS, now)
        : previous.synced_through;
  const startedAt =
    previous.after !== undefined && previous.started_at ? previous.started_at : now.toISOString();
  let after = previous.after ?? null;
  let calls = 0;

  for (let page = 0; page < PAGES_PER_RUN; page++) {
    const data = await graphql<{
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ShopifyOrder[];
      };
    }>(ctx.externalAccountId, ctx.token, ORDERS_QUERY, {
      first: PAGE_SIZE,
      after,
      query: `updated_at:>='${since}'`,
    });
    calls += 1;
    if (data.orders.nodes.length > 0)
      await ctx.store.upsertCommerce(mapShopifyOrders(data.orders.nodes));
    if (!data.orders.pageInfo.hasNextPage) {
      await ctx.store.recordUsage(calls);
      // Orders are in; the stock count follows in the same run.
      return pullStock(ctx, graphql, startedAt, null);
    }
    after = data.orders.pageInfo.endCursor;
  }
  await ctx.store.recordUsage(calls);
  return { continueWith: { since, after, started_at: startedAt } };
}

type WebhookPayload = {
  id?: number | string;
  admin_graphql_api_id?: string;
  customer?: { id?: number | string; email?: string | null };
  orders_requested?: unknown[];
};

/** Handles one Shopify webhook delivery. */
async function handleWebhook(ctx: SyncContext, graphql: ShopifyGraphql): Promise<SyncResult> {
  const topic = ctx.job.topic ?? "";
  const payload = (ctx.job.payload ?? {}) as WebhookPayload;

  if (topic === "app/uninstalled") return { disconnected: "The app was removed from the store" };

  if (topic === "shop/redact") {
    await ctx.store.purgeProviderData();
    return { disconnected: "Shopify asked us to erase this store's data" };
  }

  if (topic === "customers/redact") {
    const id = payload.customer?.id;
    if (id != null) await ctx.store.redactCustomer(String(id), payload.customer?.email ?? null);
    return {};
  }

  if (topic === "customers/data_request") {
    const who = payload.customer?.email ?? `customer ${payload.customer?.id ?? "unknown"}`;
    await ctx.store.notifyOwners(
      "A customer asked for a copy of their data",
      [
        `Shopify passed on a request from ${who} for the personal data held about them.`,
        "",
        "Maker Business Suite holds their name, email address and order history, copied from your Shopify store for your dashboards. Your Shopify admin has the same details and is the place to export them from.",
        "",
        "You have 30 days to respond to the customer.",
      ].join("\n"),
    );
    return {};
  }

  if (topic === "orders/create" || topic === "orders/updated") {
    // The webhook says which order changed; its current state comes from
    // Shopify, so late or repeated deliveries can't write stale data.
    const id =
      payload.admin_graphql_api_id ?? (payload.id ? `gid://shopify/Order/${payload.id}` : null);
    if (!id) return {};
    const data = await graphql<{ order: ShopifyOrder | null }>(
      ctx.externalAccountId,
      ctx.token,
      ORDER_QUERY,
      { id },
    );
    if (data.order) await ctx.store.upsertCommerce(mapShopifyOrders([data.order]));
    await ctx.store.recordUsage(1);
    return {};
  }

  // Customer changes reach us through their next order; nothing to do yet.
  return {};
}

export function syncShopify(
  ctx: SyncContext,
  graphql: ShopifyGraphql,
  now = new Date(),
): Promise<SyncResult> {
  return ctx.job.type === "webhook" ? handleWebhook(ctx, graphql) : pullOrders(ctx, graphql, now);
}
