import { allListings, listingInventory, listingPrices, queryOrdersByStatus } from "./api";
import { MichaelsApiError, type MichaelsClient } from "./client";
import type { MichaelsSettings } from "./config";
import {
  buildSkuIndex,
  centsText,
  flattenListings,
  matchAll,
  toCents,
  toInt,
  type MatchProblem,
  type MatchRule,
  type MatchSummary,
} from "./mapping";
import { buildOrderResolver, orderPreview, orderRecord, type OrderRecord } from "./orders";
import { OPEN_ORDER_STATUSES, RECENT_DONE_ORDER_STATUSES } from "./types";
import { wouldSend, type ItemFacts, type JobCounts, type WouldChange } from "./would-send";

/**
 * One look at Michaels for one workspace, watch-only. In order: read the whole
 * catalog and match it to the shop's items; work out the stock and prices that
 * WOULD be sent and how they differ from what Michaels shows; read recent
 * orders and what bringing them in WOULD make. Each part's failure is noted
 * and the others still run, except a key Michaels won't accept, which stops
 * the look.
 *
 * Everything this function can do to the outside world is in `RunDeps`: a
 * client that only reads, and three ways of writing to OUR database. There is
 * no way here to write to Michaels or to the shop.
 */

export type RunItem = ItemFacts & { sku: string | null };

export type ListingRecord = {
  michaels_sku_number: string;
  primary_sku_number: string;
  seller_sku: string | null;
  item_name: string | null;
  listing_status: string | null;
  gtin: string | null;
  stock_item_id: string | null;
  matched_by: MatchRule | null;
  problem: MatchProblem | null;
  problem_detail: string | null;
  /** What Michaels shows now, when this look read it; null leaves what was known. */
  michaels_qty: number | null;
  michaels_price: string | null;
  michaels_updated_at: string | null;
};

export type StoredFigures = {
  michaels_sku_number: string;
  michaels_qty: number | null;
  michaels_price: string | null;
  figures_at: string | null;
};

export type RunDeps = {
  client: MichaelsClient;
  settings: MichaelsSettings;
  now: Date;
  loadItems(): Promise<RunItem[]>;
  loadPairings(): Promise<{ seller_sku: string; stock_item_id: string | null }[]>;
  /** What earlier looks learned about Michaels' own stock and prices. */
  loadFigures(): Promise<StoredFigures[]>;
  recordListings(rows: ListingRecord[], complete: boolean): Promise<void>;
  recordOrders(orders: OrderRecord[]): Promise<void>;
};

export type RunCounts = {
  listings: (MatchSummary & { pages: number; complete: boolean; figure_reads: number }) | null;
  stock: JobCounts | null;
  prices: JobCounts | null;
  changes: number;
  more_changes: boolean;
  orders: {
    seen: number;
    by_status: Record<string, number>;
    would_create: number;
    need_pairing: number;
    first_page: 0 | 1 | null;
    shape: string;
  } | null;
  job_errors: Record<string, string>;
};

export type RunOutcome = {
  status: "done" | "failed";
  counts: RunCounts;
  changes: WouldChange[];
  error: string | null;
  /** Michaels said the key itself is no good. */
  keyRejected: boolean;
};

/** Listings whose Michaels figures weren't in the catalog read are asked about a few at a time. */
export const FIGURE_READS_PER_RUN = 25;
const ORDER_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_DONE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

const KEY_REJECTED =
  "Michaels didn't accept the API key. It may have run out: keys last 90 days. Make a new one in the Michaels Developer Account Center and connect again with it.";

export async function runMichaelsWatch(deps: RunDeps): Promise<RunOutcome> {
  const { client, settings, now } = deps;
  const counts: RunCounts = {
    listings: null,
    stock: null,
    prices: null,
    changes: 0,
    more_changes: false,
    orders: null,
    job_errors: {},
  };
  let changes: WouldChange[] = [];
  let fatal: string | null = null;
  let keyRejected = false;

  const job = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    if (fatal) return undefined;
    try {
      return await fn();
    } catch (e) {
      if (e instanceof MichaelsApiError && e.isAuthError && !e.isPermissionError) {
        fatal = KEY_REJECTED;
        keyRejected = true;
      }
      counts.job_errors[name] =
        e instanceof MichaelsApiError && e.isPermissionError
          ? "This API key isn't allowed to read this part of Michaels. Give it Read Only access in the Michaels Developer Account Center."
          : e instanceof Error
            ? e.message.slice(0, 300)
            : "It didn't work";
      return undefined;
    }
  };

  const items = (await job("items", () => deps.loadItems())) ?? [];
  const itemsById = new Map(items.map((item) => [item.id, item]));
  let matchedListings: {
    michaels_sku_number: string;
    seller_sku: string | null;
    stock_item_id: string | null;
  }[] = [];

  await job("listings", async () => {
    const [pairings, stored, catalog] = [
      await deps.loadPairings(),
      await deps.loadFigures(),
      await allListings(client),
    ];
    const { rows, summary } = matchAll(
      flattenListings(catalog.listings),
      buildSkuIndex(items, pairings),
    );

    // Michaels' own stock and price: from the catalog read when it says, else
    // asked for directly, a few listings a look, the longest-unknown first.
    const fresh = new Map<string, { qty: number | null; price: string | null }>();
    for (const row of rows) {
      fresh.set(row.michaelsSkuNumber, { qty: row.michaelsQty, price: row.michaelsPrice });
    }
    const known = new Map(stored.map((f) => [f.michaels_sku_number, f]));
    const wantQty = settings.jobs.stock;
    const wantPrice = settings.jobs.prices;
    const lacking = new Map<string, number>();
    for (const row of rows) {
      if (!row.match.itemId) continue;
      const f = fresh.get(row.michaelsSkuNumber)!;
      if ((wantQty && f.qty === null) || (wantPrice && f.price === null)) {
        const at = Date.parse(known.get(row.michaelsSkuNumber)?.figures_at ?? "") || 0;
        lacking.set(
          row.michaelsPrimarySku,
          Math.min(lacking.get(row.michaelsPrimarySku) ?? at, at),
        );
      }
    }
    const toAsk = [...lacking.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, FIGURE_READS_PER_RUN)
      .map(([primary]) => primary);
    let figureReads = 0;
    for (const primary of toAsk) {
      if (wantQty) {
        const reply = await listingInventory(client, primary);
        figureReads += 1;
        for (const s of reply?.skuInventories ?? []) {
          const f = fresh.get(String(s.skuNumber));
          if (f && s.availableQuantity !== null && s.availableQuantity !== undefined) {
            f.qty = toInt(s.availableQuantity);
          }
        }
      }
      if (wantPrice) {
        const reply = await listingPrices(client, primary);
        figureReads += 1;
        for (const s of reply?.skuPrices ?? []) {
          const f = fresh.get(String(s.skuNumber));
          const cents = toCents(s.price);
          if (f && cents !== null && cents >= 0) f.price = centsText(cents);
        }
      }
    }

    const records: ListingRecord[] = rows.map((row) => {
      const f = fresh.get(row.michaelsSkuNumber)!;
      return {
        michaels_sku_number: row.michaelsSkuNumber,
        primary_sku_number: row.michaelsPrimarySku,
        seller_sku: row.sellerSku,
        item_name: row.itemName,
        listing_status: row.listingStatus,
        gtin: row.gtin,
        stock_item_id: row.match.itemId,
        matched_by: row.match.itemId !== null ? row.match.rule : null,
        problem: row.match.itemId !== null ? null : row.match.problem,
        problem_detail: row.match.itemId !== null ? null : row.match.detail,
        michaels_qty: f.qty,
        michaels_price: f.price,
        michaels_updated_at: row.updatedAt?.toISOString() ?? null,
      };
    });
    await deps.recordListings(records, catalog.complete);
    counts.listings = {
      ...summary,
      pages: catalog.pages,
      complete: catalog.complete,
      figure_reads: figureReads,
    };
    matchedListings = records;

    if (settings.jobs.stock || settings.jobs.prices) {
      const result = wouldSend(
        records.map((r) => ({
          sellerSku: r.seller_sku,
          michaelsSkuNumber: r.michaels_sku_number,
          listingStatus: r.listing_status,
          itemId: r.stock_item_id,
          // This look's figure, else what an earlier look learned.
          michaelsQty: r.michaels_qty ?? known.get(r.michaels_sku_number)?.michaels_qty ?? null,
          michaelsPrice:
            r.michaels_price ?? known.get(r.michaels_sku_number)?.michaels_price ?? null,
        })),
        itemsById,
        settings,
      );
      changes = result.changes;
      counts.stock = result.stock;
      counts.prices = result.prices;
      counts.changes = result.changes.length;
      counts.more_changes = result.more;
    }
  });

  if (settings.jobs.orders) {
    await job("orders", async () => {
      const open = await queryOrdersByStatus(
        client,
        OPEN_ORDER_STATUSES,
        new Date(now.getTime() - ORDER_LOOKBACK_MS),
        now,
      );
      const done = await queryOrdersByStatus(
        client,
        RECENT_DONE_ORDER_STATUSES,
        new Date(now.getTime() - RECENT_DONE_LOOKBACK_MS),
        now,
      );
      const byNumber = new Map<string, OrderRecord>();
      for (const o of [...done.orders, ...open.orders]) {
        const record = orderRecord(o);
        if (record) byNumber.set(record.order_number, record);
      }
      const records = [...byNumber.values()];
      await deps.recordOrders(records);
      const resolve = buildOrderResolver(matchedListings, items);
      const openStatuses = new Set<string>(OPEN_ORDER_STATUSES);
      const openRecords = records.filter((r) => openStatuses.has(r.status));
      const previews = openRecords.map((r) => orderPreview(r, resolve));
      counts.orders = {
        seen: records.length,
        by_status: { ...open.byStatus, ...done.byStatus },
        would_create: previews.filter((p) => p.wouldCreate).length,
        need_pairing: previews.filter((p) => !p.wouldCreate).length,
        first_page: open.firstPage ?? done.firstPage,
        shape: (open.shape || done.shape).slice(0, 200),
      };
      // Michaels sent a list we couldn't read as orders: say so loudly rather
      // than quietly seeing "no orders".
      const sample = open.orders.length ? "" : open.shape;
      if (/array\([1-9]/.test(sample)) {
        throw new Error(
          `Michaels sent orders in a shape the connector couldn't read (${sample.slice(0, 120)}).`,
        );
      }
    });
  }

  const errors = Object.entries(counts.job_errors);
  const error = fatal ?? (errors.length ? errors.map(([k, v]) => `${k}: ${v}`).join("; ") : null);
  return {
    status: error ? "failed" : "done",
    counts,
    changes,
    error: error ? error.slice(0, 1000) : null,
    keyRejected,
  };
}
