import type { MichaelsClient } from "./client";
import { describeShape, extractOrders } from "./mapping";
import type {
  MichaelsAllListingsPage,
  MichaelsInventoryReply,
  MichaelsListing,
  MichaelsOrder,
  MichaelsOrderPage,
  MichaelsPriceReply,
} from "./types";

/**
 * Typed wrappers for the Michaels endpoints this stage uses, ported from
 * TuftStock. Every one is a GET: this stage reads and never sends. A client is
 * always made from one workspace's access (client.ts), so every call here is
 * that workspace's and nobody else's.
 */

/** One cheap read to prove a key works before it's saved. Throws MichaelsApiError if not. */
export async function checkKey(c: MichaelsClient): Promise<void> {
  await c.request<unknown>("GET", "/listing/all-listings", { query: { limit: 1 }, retry: false });
}

/** One page of the full catalog (cursor pagination, 100 a page at most). */
export function allListingsPage(
  c: MichaelsClient,
  cursor?: string,
): Promise<MichaelsAllListingsPage> {
  return c.request<MichaelsAllListingsPage>("GET", "/listing/all-listings", {
    query: { limit: 100, cursor },
  });
}

/** How many catalog pages one look may read: 300 pages is 30,000 listings. */
export const MAX_LISTING_PAGES = 300;

/** Every listing the seller has. `complete` is false when the page limit cut it short. */
export async function allListings(
  c: MichaelsClient,
  maxPages = MAX_LISTING_PAGES,
): Promise<{ listings: MichaelsListing[]; pages: number; complete: boolean }> {
  const listings: MichaelsListing[] = [];
  let cursor: string | undefined;
  for (let page = 1; page <= maxPages; page++) {
    const resp = await allListingsPage(c, cursor);
    listings.push(...(resp?.listings ?? []));
    if (!resp?.nextCursor || resp.nextCursor === cursor) {
      return { listings, pages: page, complete: true };
    }
    cursor = resp.nextCursor;
  }
  return { listings, pages: maxPages, complete: false };
}

/** What Michaels has in stock for each SKU of one listing. */
export function listingInventory(
  c: MichaelsClient,
  primarySkuNumber: string,
): Promise<MichaelsInventoryReply | null> {
  return c.request<MichaelsInventoryReply | null>(
    "GET",
    `/listing/inventory/${encodeURIComponent(primarySkuNumber)}`,
  );
}

/** What Michaels charges for each SKU of one listing. */
export function listingPrices(
  c: MichaelsClient,
  primarySkuNumber: string,
): Promise<MichaelsPriceReply | null> {
  return c.request<MichaelsPriceReply | null>(
    "GET",
    `/listing/price/${encodeURIComponent(primarySkuNumber)}`,
  );
}

export interface OrderQueryResult {
  orders: MichaelsOrder[];
  /** What the first reply looked like, for the run's record (keys only, no customer data). */
  shape: string;
  /** Which page number turned out to be the first page. */
  firstPage: 0 | 1 | null;
}

const ORDER_PAGE_SIZE = 200;

/**
 * Orders in the given statuses created in [startTime, now]. The docs don't say
 * whether pageNumber starts at 0 or 1, so ask for page 1 and, if that's empty,
 * page 0 too: whichever has orders is the first page. Orders are de-duplicated
 * by number in case a page is repeated.
 */
export async function queryOrders(
  c: MichaelsClient,
  statuses: readonly string[],
  startTime: Date,
  now: Date = new Date(),
): Promise<OrderQueryResult> {
  const fetchPage = (pageNumber: number) =>
    c.request<MichaelsOrderPage | MichaelsOrder[]>("GET", "/order/query", {
      query: {
        startTime: startTime.getTime(),
        endTime: now.getTime(),
        orderStatusList: statuses.join(","),
        pageNumber,
        pageSize: ORDER_PAGE_SIZE,
      },
    });

  const first = await fetchPage(1);
  let page = extractOrders(first);
  let base: 0 | 1 | null = page.length > 0 ? 1 : null;
  if (page.length === 0) {
    const zero = await fetchPage(0).catch(() => null);
    const zeroOrders = extractOrders(zero);
    if (zeroOrders.length > 0) {
      page = zeroOrders;
      base = 0;
    }
  }

  const byNumber = new Map<string, MichaelsOrder>();
  const add = (orders: MichaelsOrder[]) => orders.forEach((o) => byNumber.set(o.orderNumber, o));
  add(page);
  for (let n = 1; base !== null && page.length >= ORDER_PAGE_SIZE && n < 50; n++) {
    const before = byNumber.size;
    page = extractOrders(await fetchPage(base + n));
    add(page);
    if (byNumber.size === before) break; // same page again: stop
  }

  return { orders: [...byNumber.values()], shape: describeShape(first), firstPage: base };
}

export interface OrdersByStatusResult extends OrderQueryResult {
  /** How many orders each status returned. A status stuck at 0 is worth a look. */
  byStatus: Record<string, number>;
}

/**
 * Like queryOrders, but one request per status. The docs show orderStatusList
 * as a comma list, but if Michaels only honours the first value, a combined
 * request would silently return just the pending orders (TuftStock saw exactly
 * that). Asking per status works either way.
 */
export async function queryOrdersByStatus(
  c: MichaelsClient,
  statuses: readonly string[],
  startTime: Date,
  now: Date = new Date(),
): Promise<OrdersByStatusResult> {
  const byNumber = new Map<string, MichaelsOrder>();
  const byStatus: Record<string, number> = {};
  // Report the shape and page base of the first reply that held orders (else the first reply).
  let sample: OrderQueryResult | null = null;
  for (const status of statuses) {
    const r = await queryOrders(c, [status], startTime, now);
    byStatus[status] = r.orders.length;
    for (const o of r.orders) byNumber.set(o.orderNumber, o);
    if (!sample || (sample.orders.length === 0 && r.orders.length > 0)) sample = r;
  }
  return {
    orders: [...byNumber.values()],
    byStatus,
    shape: sample?.shape ?? "",
    firstPage: sample?.firstPage ?? null,
  };
}
