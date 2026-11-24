import { michaelsPrice, michaelsQuantity } from "./mapping";

/**
 * What a look at Michaels WOULD change, worked out and written down. Nothing
 * here sends anything: it only compares. TuftStock's rules, exactly: stock is
 * the shop's count less the units held back, never below zero; the price is
 * the shop's price to the cent, and a missing or zero price is never sent.
 */

export type ItemFacts = {
  id: string;
  name: string;
  /** The shop's count, from the last read of the shop. */
  on_hand: number;
  /** False when the shop doesn't keep a count of it. */
  tracked: boolean;
  price: number | string | null;
};

export type ListingFacts = {
  sellerSku: string | null;
  michaelsSkuNumber: string;
  listingStatus: string | null;
  itemId: string | null;
  michaelsQty: number | null;
  michaelsPrice: string | null;
};

export type WouldChange = {
  kind: "stock" | "price";
  seller_sku: string;
  michaels_sku_number: string;
  item_id: string;
  item_name: string;
  /** What Michaels shows now; null when the read didn't say. */
  from: string | null;
  to: string;
};

export type JobCounts = {
  checked: number;
  same: number;
  /** Michaels shows something else. */
  differ: number;
  /** Michaels' own figure wasn't in what we read, so it can't be compared. */
  unknown: number;
  /** Left alone: the shop keeps no count of it (stock), or it has no price (prices). */
  skipped: number;
};

export type WouldSend = {
  changes: WouldChange[];
  /** True when there were more changes than are kept. */
  more: boolean;
  stock: JobCounts | null;
  prices: JobCounts | null;
};

/** How many would-be changes one run keeps. The counts always cover all of them. */
export const MAX_CHANGES_KEPT = 500;

const empty = (): JobCounts => ({ checked: 0, same: 0, differ: 0, unknown: 0, skipped: 0 });

export function wouldSend(
  listings: ListingFacts[],
  items: Map<string, ItemFacts>,
  settings: { units_held_back: number; jobs: { stock: boolean; prices: boolean } },
): WouldSend {
  const stock = settings.jobs.stock ? empty() : null;
  const prices = settings.jobs.prices ? empty() : null;
  const changes: WouldChange[] = [];
  let total = 0;
  const keep = (change: WouldChange) => {
    total += 1;
    if (changes.length < MAX_CHANGES_KEPT) changes.push(change);
  };

  for (const listing of listings) {
    // Unmatched, or archived on Michaels: nothing is sent for it.
    if (!listing.itemId || !listing.sellerSku) continue;
    if ((listing.listingStatus ?? "").toUpperCase() === "ARCHIVED") continue;
    const item = items.get(listing.itemId);
    if (!item) continue;
    const base = {
      seller_sku: listing.sellerSku,
      michaels_sku_number: listing.michaelsSkuNumber,
      item_id: item.id,
      item_name: item.name,
    };

    if (stock) {
      stock.checked += 1;
      if (!item.tracked) {
        stock.skipped += 1;
      } else {
        const to = michaelsQuantity(item.on_hand, settings.units_held_back);
        if (listing.michaelsQty === null) {
          stock.unknown += 1;
          keep({ kind: "stock", ...base, from: null, to: String(to) });
        } else if (listing.michaelsQty === to) {
          stock.same += 1;
        } else {
          stock.differ += 1;
          keep({ kind: "stock", ...base, from: String(listing.michaelsQty), to: String(to) });
        }
      }
    }

    if (prices) {
      prices.checked += 1;
      const to = michaelsPrice(item.price);
      if (!to) {
        prices.skipped += 1;
      } else if (listing.michaelsPrice === null) {
        prices.unknown += 1;
        keep({ kind: "price", ...base, from: null, to });
      } else if (michaelsPrice(listing.michaelsPrice) === to) {
        prices.same += 1;
      } else {
        prices.differ += 1;
        keep({ kind: "price", ...base, from: listing.michaelsPrice, to });
      }
    }
  }
  return { changes, more: total > changes.length, stock, prices };
}

/** A stored change, checked on the way out of the database. */
export function parseChanges(value: unknown): WouldChange[] {
  if (!Array.isArray(value)) return [];
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  const out: WouldChange[] = [];
  for (const row of value as Record<string, unknown>[]) {
    if (!row || typeof row !== "object") continue;
    const kind = row.kind === "stock" || row.kind === "price" ? row.kind : null;
    const to = text(row.to);
    const sellerSku = text(row.seller_sku);
    if (!kind || to === null || sellerSku === null) continue;
    out.push({
      kind,
      seller_sku: sellerSku,
      michaels_sku_number: text(row.michaels_sku_number) ?? "",
      item_id: text(row.item_id) ?? "",
      item_name: text(row.item_name) ?? "",
      from: text(row.from),
      to,
    });
  }
  return out;
}
