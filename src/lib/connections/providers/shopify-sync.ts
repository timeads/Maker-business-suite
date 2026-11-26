import type {
  CustomerRow,
  OrderRow,
  ProductPhotoRow,
  ProductRow,
  ShippingOrderRow,
  ShopBookingOrder,
  ShopOrderLines,
  StockItemRow,
  StockTagsRow,
  VariantPhotoRow,
  SyncContext,
  SyncResult,
  TokenSet,
} from "../types";
import { shopPhotoAddress } from "../../social/product-photos";
import { ReconnectRequiredError } from "../types";

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

export type ShopifyOrder = {
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
  /** Everything taken off by discounts, as the shop adds it up. */
  currentTotalDiscountsSet?: Money;
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
      customAttributes?: { key: string; value: string | null }[] | null;
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
  currentTotalDiscountsSet { shopMoney { amount } }
  currentTotalTaxSet { shopMoney { amount } }
  totalShippingPriceSet { shopMoney { amount } }
  currentTotalPriceSet { shopMoney { amount } }
  customer { legacyResourceId firstName lastName createdAt updatedAt }
  lineItems(first: 100) {
    nodes {
      id title variantTitle sku currentQuantity
      customAttributes { key value }
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

/**
 * What the products came to before discounts, and the discounts themselves:
 * the shop's own total of discounts, added back onto the subtotal. Left out
 * when the shop didn't say, so nothing is shown rather than a guess.
 */
function discountFigures(
  order: Pick<ShopifyOrder, "currentSubtotalPriceSet" | "currentTotalDiscountsSet">,
): { gross_sales: number | null; total_discounts: number | null } {
  if (!order.currentTotalDiscountsSet || !order.currentSubtotalPriceSet) {
    return { gross_sales: null, total_discounts: null };
  }
  const discounts = money(order.currentTotalDiscountsSet);
  const cents =
    Math.round(money(order.currentSubtotalPriceSet) * 100) + Math.round(discounts * 100);
  return { gross_sales: cents / 100, total_discounts: discounts };
}

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
      ...discountFigures(order),
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

type ShopifyShipping = {
  legacyResourceId: string;
  displayFinancialStatus: string | null;
  note: string | null;
  /** Grams, as a string (Shopify's UnsignedInt64). */
  currentTotalWeight?: string | number | null;
  currentShippingPriceSet?: Money | null;
  tags?: string[] | null;
  shippingAddress: {
    name: string | null;
    company: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    provinceCode: string | null;
    zip: string | null;
    countryCodeV2: string | null;
    phone: string | null;
  } | null;
  shippingLines: { nodes: { title: string }[] };
  /** Only asked for when the shop lets the app see how orders are delivered. */
  fulfillmentOrders?: {
    nodes: { status: string; deliveryMethod: { methodType: string } | null }[];
  } | null;
  lineItems: {
    nodes: {
      id: string;
      title: string;
      variantTitle: string | null;
      sku: string | null;
      currentQuantity: number;
      customAttributes?: { key: string; value: string | null }[] | null;
      unfulfilledQuantity: number;
      requiresShipping: boolean;
      discountedUnitPriceAfterAllDiscountsSet?: Money | null;
      /** The picture of the option that was ordered (the shop falls back to the product's). */
      image?: { url?: string | null } | null;
      variant?: {
        barcode: string | null;
        inventoryItem?: {
          measurement?: { weight?: { unit: string; value: number } | null } | null;
        } | null;
      } | null;
    }[];
  };
} | null;

/**
 * Asked separately from the sales figures: a shop that hasn't let the app
 * see addresses still gets its dashboards, just no packing list.
 *
 * How each order is delivered (posted or collected) needs a permission of
 * its own, so that part is left out for shops that haven't given it.
 */
const shippingQuery = (deliveryMethods: boolean) => `query Shipping($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Order {
      legacyResourceId displayFinancialStatus note currentTotalWeight tags
      currentShippingPriceSet { shopMoney { amount } }
      shippingAddress { name company address1 address2 city provinceCode zip countryCodeV2 phone }
      shippingLines(first: 1) { nodes { title } }
      ${deliveryMethods ? "fulfillmentOrders(first: 5) { nodes { status deliveryMethod { methodType } } }" : ""}
      lineItems(first: 100) {
        nodes {
          id title variantTitle sku currentQuantity unfulfilledQuantity requiresShipping
          discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
          image { url(transform: { maxWidth: ${ITEM_PHOTO_WIDTH} }) }
          variant { barcode inventoryItem { measurement { weight { unit value } } } }
        }
      }
    }
  }
}`;

/** Item pictures are thumbnails on the order page, so a small one is asked for. */
const ITEM_PHOTO_WIDTH = 120;

const UNPAID = new Set(["PENDING", "AUTHORIZED", "PARTIALLY_PAID", "EXPIRED", "VOIDED"]);
/** Without the shop's own word on it, the name of the checkout option is the best clue. */
const PICKUP_NAME = /\b(pick ?-?up|in[- ]store|collect(ion)?)\b/i;

const GRAMS_PER: Record<string, number> = {
  GRAMS: 1,
  KILOGRAMS: 1000,
  OUNCES: 28.349523125,
  POUNDS: 453.59237,
};

/** A product weight from the shop in whole grams, or null when there isn't a usable one. */
export function unitGrams(
  weight: { unit: string; value: number } | null | undefined,
): number | null {
  const per = weight ? GRAMS_PER[weight.unit] : undefined;
  const grams = per ? Math.round(Number(weight!.value) * per) : Number.NaN;
  return Number.isFinite(grams) && grams > 0 ? grams : null;
}

export function mapShopifyShipping(orders: ShopifyShipping[]): ShippingOrderRow[] {
  return orders.flatMap((order) => {
    if (!order) return [];
    const address = order.shippingAddress;
    const method = order.shippingLines.nodes[0]?.title ?? null;
    const weight = Number(order.currentTotalWeight ?? Number.NaN);
    const deliveries = order.fulfillmentOrders?.nodes;
    return [
      {
        external_id: order.legacyResourceId,
        recipient: address?.name ?? null,
        company: address?.company ?? null,
        address1: address?.address1 ?? null,
        address2: address?.address2 ?? null,
        city: address?.city ?? null,
        region: address?.provinceCode ?? null,
        postal_code: address?.zip ?? null,
        country_code: address?.countryCodeV2 ?? null,
        phone: address?.phone ?? null,
        shipping_method: method,
        shipping_paid: order.currentShippingPriceSet ? money(order.currentShippingPriceSet) : null,
        weight_grams: Number.isFinite(weight) && weight > 0 ? Math.round(weight) : null,
        pickup: deliveries
          ? deliveries.some((delivery) => delivery.deliveryMethod?.methodType === "PICK_UP")
          : PICKUP_NAME.test(method ?? ""),
        note: order.note,
        paid: !UNPAID.has(order.displayFinancialStatus ?? ""),
        tags: Array.isArray(order.tags)
          ? order.tags.filter((tag) => typeof tag === "string" && tag.trim() !== "")
          : null,
        // Only things that go in a box; a gift card or a class has nothing to send.
        items: order.lineItems.nodes
          .filter((line) => line.requiresShipping && line.currentQuantity > 0)
          .map((line) => ({
            line_id: line.id,
            title: line.title,
            variant: line.variantTitle,
            sku: line.sku?.trim() || null,
            barcode: line.variant?.barcode?.trim() || null,
            // One unit's weight, so a box's weight can follow what's put in it.
            grams: unitGrams(line.variant?.inventoryItem?.measurement?.weight),
            price: line.discountedUnitPriceAfterAllDiscountsSet
              ? money(line.discountedUnitPriceAfterAllDiscountsSet)
              : null,
            // Only ever a picture on the shop platform's own image servers.
            image: shopPhotoAddress(line.image?.url, ITEM_PHOTO_WIDTH),
            qty: line.currentQuantity,
            left: Math.max(0, Math.min(line.currentQuantity, line.unfulfilledQuantity)),
          })),
      },
    ];
  });
}

/** What a run has learned about this shop, so it doesn't ask for the same refusal twice. */
type ShippingAsk = { deliveryMethods: boolean };

/** Reads the packing details for orders just stored. Never fails the sync. */
const SHIPPING_BATCH = 10;

async function pullShipping(
  ctx: SyncContext,
  graphql: ShopifyGraphql,
  orderIds: string[],
  ask: ShippingAsk = { deliveryMethods: true },
): Promise<boolean> {
  if (orderIds.length === 0) return true;
  const all = orderIds.map((id) => `gid://shopify/Order/${id}`);
  // The shop caps how much one question may ask for, and each order here
  // brings its lines with it: so a few orders at a time.
  const batches: string[][] = [];
  for (let i = 0; i < all.length; i += SHIPPING_BATCH)
    batches.push(all.slice(i, i + SHIPPING_BATCH));
  const read = async (deliveryMethods: boolean) => {
    const nodes: ShopifyShipping[] = [];
    for (const ids of batches) {
      const page = await graphql<{ nodes: ShopifyShipping[] }>(
        ctx.externalAccountId,
        ctx.token,
        shippingQuery(deliveryMethods),
        { ids },
      );
      nodes.push(...(page.nodes ?? []));
    }
    return { nodes };
  };
  try {
    let data: { nodes: ShopifyShipping[] };
    if (ask.deliveryMethods) {
      try {
        data = await read(true);
      } catch (err) {
        if (err instanceof ReconnectRequiredError) throw err;
        // Most likely the shop hasn't shared how orders are delivered: ask for the rest.
        ask.deliveryMethods = false;
        data = await read(false);
      }
    } else {
      data = await read(false);
    }
    await ctx.store.upsertShipping(mapShopifyShipping(data.nodes ?? []));
    return true;
  } catch (err) {
    console.warn(
      `shipping details unavailable for ${ctx.externalAccountId}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
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
  price?: string | null;
  product: {
    legacyResourceId: string;
    title: string;
    status: string | null;
    vendor?: string | null;
    /** Asked for along with the photos; absent when the shop wouldn't answer that. */
    tags?: string[] | null;
  } | null;
  inventoryItem: { id: string; tracked: boolean; unitCost: { amount: string } | null } | null;
  /** This option's own photo, when the shop has one for it. */
  image?: { url?: string | null } | null;
};

// With each option's own photo and its product's tags, and without: a shop
// that won't answer the first is asked the second, so neither a picture nor
// a tag can ever cost the stock count.
const variantsQuery = (photos: boolean) => `query Variants($first: Int!, $after: String) {
  productVariants(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      legacyResourceId title sku inventoryQuantity price
      product { legacyResourceId title status vendor${photos ? " tags" : ""} }
      inventoryItem { id tracked unitCost { amount } }
      ${photos ? `image { url(transform: { maxWidth: ${VARIANT_PHOTO_WIDTH} }) }` : ""}
    }
  }
}`;
const VARIANT_PHOTO_WIDTH = 160;

/** Each option's own photo, only ever one on the shop platform's image servers. */
export function mapVariantPhotos(variants: ShopifyVariant[]): VariantPhotoRow[] {
  return variants.map((variant) => ({
    external_id: variant.legacyResourceId,
    image_url: shopPhotoAddress(variant.image?.url, VARIANT_PHOTO_WIDTH),
  }));
}

/** Each product's tags, once per product, as the shop spells them. */
export function mapStockTags(variants: ShopifyVariant[]): StockTagsRow[] {
  const byProduct = new Map<string, string[]>();
  for (const variant of variants) {
    const id = variant.product?.legacyResourceId;
    if (!id || byProduct.has(id) || !Array.isArray(variant.product?.tags)) continue;
    byProduct.set(
      id,
      variant.product.tags
        .filter((tag): tag is string => typeof tag === "string" && tag.trim() !== "")
        .map((tag) => tag.trim().slice(0, 80))
        .slice(0, 100),
    );
  }
  return [...byProduct].map(([product_external_id, tags]) => ({ product_external_id, tags }));
}
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
      vendor: variant.product?.vendor?.trim() || null,
      price: variant.price == null || variant.price === "" ? null : Number(variant.price),
    };
  });
}

/**
 * Reads what the shop has on the shelf. Only ever reads: the count in the
 * shop changes when someone checks a delivery in, never during a sync.
 */
type ShopifyProductPhoto = {
  legacyResourceId: string;
  onlineStoreUrl?: string | null;
  featuredMedia?: { preview?: { image?: { url?: string | null } | null } | null } | null;
  featuredImage?: { url?: string | null } | null;
};

// Two spellings of "the product's main photo": the current one, and the one
// older shops' API versions still answer to.
const productPhotosQuery = (
  current: boolean,
) => `query ProductPhotos($first: Int!, $after: String) {
  products(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      legacyResourceId onlineStoreUrl
      ${current ? "featuredMedia { preview { image { url } } }" : "featuredImage { url }"}
    }
  }
}`;

const https = (value: string | null | undefined) =>
  typeof value === "string" && value.startsWith("https://") ? value : null;

export function mapProductPhotos(products: ShopifyProductPhoto[]): ProductPhotoRow[] {
  return products.map((product) => ({
    product_external_id: product.legacyResourceId,
    image_url: https(product.featuredMedia?.preview?.image?.url ?? product.featuredImage?.url),
    product_url: https(product.onlineStoreUrl),
  }));
}

/**
 * Notes each product's main photo and shop page. Never allowed to stop a
 * sync: the stock count matters more than the pictures. Returns the calls made.
 */
async function pullProductPhotos(ctx: SyncContext, graphql: ShopifyGraphql): Promise<number> {
  let calls = 0;
  let current = true;
  let after: string | null = null;
  try {
    for (let page = 0; page < PAGES_PER_RUN; page++) {
      type Page = {
        products: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: ShopifyProductPhoto[];
        };
      };
      let data: Page;
      const ask = (spelling: boolean) =>
        graphql<Page>(ctx.externalAccountId, ctx.token, productPhotosQuery(spelling), {
          first: 100,
          after,
        });
      try {
        calls += 1;
        data = await ask(current);
      } catch (err) {
        if (err instanceof ReconnectRequiredError || !current) throw err;
        current = false;
        calls += 1;
        data = await ask(false);
      }
      if (data.products.nodes.length > 0) {
        await ctx.store.setProductPhotos(mapProductPhotos(data.products.nodes));
      }
      if (!data.products.pageInfo.hasNextPage) break;
      after = data.products.pageInfo.endCursor;
    }
  } catch (err) {
    console.warn(
      `product photos unavailable for ${ctx.externalAccountId}:`,
      err instanceof Error ? err.message : err,
    );
  }
  return calls;
}

async function pullStock(
  ctx: SyncContext,
  graphql: ShopifyGraphql,
  startedAt: string,
  from: string | null,
): Promise<SyncResult> {
  let after = from;
  let calls = 0;
  let photos = true;
  type Page = {
    productVariants: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: ShopifyVariant[];
    };
  };
  for (let page = 0; page < PAGES_PER_RUN; page++) {
    const ask = (withPhotos: boolean) =>
      graphql<Page>(ctx.externalAccountId, ctx.token, variantsQuery(withPhotos), {
        first: VARIANT_PAGE_SIZE,
        after,
      });
    let data: Page;
    try {
      calls += 1;
      data = await ask(photos);
    } catch (err) {
      if (err instanceof ReconnectRequiredError || !photos) throw err;
      // The count matters more than the pictures: ask again without them.
      photos = false;
      calls += 1;
      data = await ask(false);
    }
    if (data.productVariants.nodes.length > 0) {
      await ctx.store.upsertStock(mapShopifyVariants(data.productVariants.nodes));
      if (photos) {
        try {
          await ctx.store.setVariantPhotos(mapVariantPhotos(data.productVariants.nodes));
          const tags = mapStockTags(data.productVariants.nodes);
          if (tags.length > 0) await ctx.store.setStockTags(tags);
        } catch (err) {
          console.warn(
            `variant photos or tags not saved for ${ctx.externalAccountId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
    if (!data.productVariants.pageInfo.hasNextPage) {
      calls += await pullProductPhotos(ctx, graphql);
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

const SESSION_KEY = "Session ID";
/**
 * The number and tick for text reminders, on the same cart line. Names that
 * start with "_" are carried to the order but hidden at checkout. The second
 * pair is what the business's earlier booking app wrote, so carts started
 * before the switch keep their consent.
 */
const TEXT_PHONE_KEYS = ["_text_phone", "_ttw_sms_phone"];
const TEXT_CONSENT_KEYS = ["_text_consent", "_ttw_sms_consent"];

/** The text consent a cart line carries: a ticked box and a number, or nothing. */
export function textConsentOf(
  attributes: { key: string; value: string | null }[] | null | undefined,
): { phone: string; agreed: boolean } | null {
  const value = (keys: string[]) =>
    keys.map((key) => attributes?.find((a) => a.key === key)?.value?.trim() ?? "").find(Boolean) ??
    "";
  const phone = value(TEXT_PHONE_KEYS).slice(0, 40);
  if (!phone) return null;
  return { phone, agreed: value(TEXT_CONSENT_KEYS).toLowerCase() === "yes" };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The orders that carry workshop dates. The product page's date picker puts
 * the date's id on the cart line as "Session ID"; lines for the same date
 * are added together. The seats are what the order holds now, so a refunded
 * seat is a seat given back.
 */
export function shopBookingsFrom(orders: ShopifyOrder[]): ShopBookingOrder[] {
  const out: ShopBookingOrder[] = [];
  for (const order of orders) {
    const byDate = new Map<
      string,
      { seats: number; amount_cents: number; text?: { phone: string; agreed: boolean } }
    >();
    for (const line of order.lineItems.nodes) {
      const id = line.customAttributes?.find((a) => a.key === SESSION_KEY)?.value?.trim() ?? "";
      if (!UUID.test(id)) continue;
      const key = id.toLowerCase();
      const seats = Math.max(0, Math.trunc(line.currentQuantity));
      const soFar = byDate.get(key) ?? { seats: 0, amount_cents: 0 };
      // Lines for one date are one booking: a ticked box on any of them counts.
      const consent = textConsentOf(line.customAttributes);
      const text = soFar.text?.agreed ? soFar.text : (consent ?? soFar.text);
      byDate.set(key, {
        seats: soFar.seats + seats,
        amount_cents:
          soFar.amount_cents +
          Math.round(money(line.discountedUnitPriceAfterAllDiscountsSet) * 100) * seats,
        ...(text ? { text } : {}),
      });
    }
    if (byDate.size === 0) continue;
    const name = [order.customer?.firstName, order.customer?.lastName]
      .filter(Boolean)
      .join(" ")
      .trim();
    out.push({
      external_id: order.legacyResourceId,
      name: order.name,
      cancelled: order.cancelledAt !== null,
      customer_name: name,
      email: order.email,
      lines: [...byDate].map(([session_id, line]) => ({ session_id, ...line })),
    });
  }
  return out;
}

/**
 * Every line of every order, with the date it carries when it has the shape
 * of one. Bookings uses it to spot a workshop that was paid for without a
 * date ("Buy again" strips it) and to keep such a booking in step with
 * refunds; which lines matter is decided in the database.
 */
export function shopOrderLinesFrom(orders: ShopifyOrder[]): ShopOrderLines[] {
  return orders
    .map((order) => ({
      external_id: order.legacyResourceId,
      name: order.name,
      cancelled: order.cancelledAt !== null,
      lines: order.lineItems.nodes.map((line) => {
        const id = line.customAttributes?.find((a) => a.key === SESSION_KEY)?.value?.trim() ?? "";
        return {
          line_id: line.id.split("/").pop() ?? line.id,
          product_id: line.product?.legacyResourceId ?? null,
          seats: Math.max(0, Math.trunc(line.currentQuantity)),
          session_id: UUID.test(id) ? id.toLowerCase() : null,
        };
      }),
    }))
    .filter((order) => order.lines.length > 0);
}

/**
 * The search that finds every order changed since a moment. Written the way
 * the shop's search reads it for certain: whole seconds, no quotes, and
 * `status:any` so closed (sent and archived) orders are included, not just
 * open ones.
 */
export const ordersSince = (since: string) =>
  `updated_at:>=${since.replace(/\.\d+Z$/, "Z")} status:any`;

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
  let addresses = true;
  const shippingAsk = { deliveryMethods: true };

  // A count of what the shop says it has, beside what it hands over, so an
  // empty sync can be told apart from a shop that isn't sharing its orders.
  if (after === null) {
    try {
      const seen = await graphql<{
        all: { count: number } | null;
        window: { count: number } | null;
      }>(
        ctx.externalAccountId,
        ctx.token,
        `
          query ($q: String) {
            all: ordersCount(query: "status:any") {
              count
            }
            window: ordersCount(query: $q) {
              count
            }
          }
        `,
        { q: ordersSince(since) },
      );
      console.log(
        `Shopify sync: shop reports ${seen.all?.count ?? "?"} orders, ${seen.window?.count ?? "?"} changed since ${since}`,
      );
    } catch (err) {
      console.error(
        `Shopify sync: the shop would not count its orders (${err instanceof Error ? err.message : "unknown"})`,
      );
    }
  }

  for (let page = 0; page < PAGES_PER_RUN; page++) {
    const data = await graphql<{
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ShopifyOrder[];
      };
    }>(ctx.externalAccountId, ctx.token, ORDERS_QUERY, {
      first: PAGE_SIZE,
      after,
      query: ordersSince(since),
    });
    calls += 1;
    if (data.orders.nodes.length > 0) {
      await ctx.store.upsertCommerce(mapShopifyOrders(data.orders.nodes));
      const dated = shopBookingsFrom(data.orders.nodes);
      if (dated.length > 0) await ctx.store.bookShopOrders(dated);
      await ctx.store.noteShopOrderLines(shopOrderLinesFrom(data.orders.nodes));
      // One refusal means the shop hasn't shared addresses; don't ask again this run.
      if (addresses) {
        addresses = await pullShipping(
          ctx,
          graphql,
          data.orders.nodes.map((order) => order.legacyResourceId),
          shippingAsk,
        );
        calls += 1;
      }
    }
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
    if (data.order) {
      await ctx.store.upsertCommerce(mapShopifyOrders([data.order]));
      const dated = shopBookingsFrom([data.order]);
      if (dated.length > 0) await ctx.store.bookShopOrders(dated);
      await ctx.store.noteShopOrderLines(shopOrderLinesFrom([data.order]));
      await pullShipping(ctx, graphql, [data.order.legacyResourceId]);
    }
    await ctx.store.recordUsage(2);
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
