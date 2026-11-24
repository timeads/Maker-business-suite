import type { MichaelsListing, MichaelsOrder, MichaelsOrderPage, NumLike } from "./types";

/**
 * Pure translation between Michaels' shapes and ours (ported from TuftStock
 * with its tests). No I/O: the run fetches, calls these, then records. Money
 * is whole cents or a "12.50" string end to end, never float arithmetic.
 */

export function toInt(v: NumLike | null | undefined): number {
  const n = Number.parseInt(String(v ?? "0"), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Michaels timestamps are epoch milliseconds, usually as strings. */
export function epochToDate(v: NumLike | null | undefined): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const ms = Number(v);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
}

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

/** Quantity to show on Michaels: the shop's count minus the units held back, never below 0. */
export function michaelsQuantity(available: number, buffer: number): number {
  return Math.max(0, Math.min(99_999_999, Math.floor(available) - Math.max(0, buffer)));
}

// ---------------------------------------------------------------------------
// Price: identical to the shop's, no markup
// ---------------------------------------------------------------------------

/** An amount as whole cents, rounded half up at the third decimal. Null when it isn't a plain amount. */
export function toCents(v: NumLike | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const m = /^(-?)(\d{1,10})(?:\.(\d+))?$/.exec(String(v).trim());
  if (!m) return null;
  const frac = (m[3] ?? "").padEnd(3, "0");
  let cents = Number(m[2]) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1;
  return m[1] ? -cents : cents;
}

export const centsText = (cents: number) =>
  `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;

/**
 * The Michaels price for a shop price: the same amount, to the cent. Null when
 * there's nothing valid to send (missing, zero, negative, unreadable or over
 * Michaels' cap): an item is never listed at $0.
 */
export function michaelsPrice(shopPrice: NumLike | null | undefined): string | null {
  const cents = toCents(shopPrice);
  return cents !== null && cents > 0 && cents < 9_999_999_999 ? centsText(cents) : null;
}

// ---------------------------------------------------------------------------
// Listings: the seller already has them on Michaels. Map them, never recreate.
// ---------------------------------------------------------------------------

export interface MichaelsSkuRow {
  /** Null when Michaels has the SKU listed without a seller SKU at all. */
  sellerSku: string | null;
  michaelsSkuNumber: string;
  michaelsPrimarySku: string;
  itemName: string | null;
  listingStatus: string | null;
  /** UPC/EAN on Michaels, if any, matched against the shop's barcode. */
  gtin: string | null;
  /** What Michaels shows now, when the catalog read says. */
  michaelsQty: number | null;
  michaelsPrice: string | null;
  /** When Michaels last changed the listing. */
  updatedAt: Date | null;
}

const qtyOf = (v: NumLike | null | undefined): number | null =>
  v === null || v === undefined || v === "" ? null : toInt(v);
const priceOf = (v: NumLike | null | undefined): string | null => {
  const cents = toCents(v);
  return cents === null || cents < 0 ? null : centsText(cents);
};

/**
 * Flatten listings into one row per sellable SKU: a listing with options
 * contributes its subSkus; a single-item listing contributes itself. A row with
 * no seller SKU can't be matched; it is kept, with a null seller SKU, so the
 * issues list can show it.
 */
export function flattenListings(listings: MichaelsListing[]): MichaelsSkuRow[] {
  const rows: MichaelsSkuRow[] = [];
  for (const l of listings) {
    const primary = l.primarySkuNumber || l.skuNumber;
    const subs = l.subSkus?.length ? l.subSkus : null;
    const entries = subs
      ? subs.map((s) => ({
          skuNumber: s.skuNumber,
          sellerSku: s.sellerSkuNumber,
          gtin: s.globalTradeItemNumber,
          inventory: s.inventory,
          price: s.price,
        }))
      : [
          {
            skuNumber: l.skuNumber,
            sellerSku: l.sellerSkuNumber,
            gtin: l.globalTradeItemNumber,
            inventory: l.inventory,
            price: l.price,
          },
        ];
    for (const e of entries) {
      if (!e.skuNumber) continue;
      rows.push({
        // Keep the seller SKU exactly as Michaels has it: stock and price
        // updates address it by this string. Spaces and capitals only matter
        // when matching.
        sellerSku: e.sellerSku?.trim() ? e.sellerSku : null,
        michaelsSkuNumber: String(e.skuNumber),
        michaelsPrimarySku: String(primary),
        itemName: typeof l.itemName === "string" && l.itemName.trim() ? l.itemName.trim() : null,
        listingStatus: l.status ?? null,
        gtin: e.gtin?.trim() || null,
        michaelsQty: qtyOf(e.inventory),
        michaelsPrice: priceOf(e.price),
        updatedAt: epochToDate(l.updateDatetime ?? l.createdTime),
      });
    }
  }
  return rows;
}

export type MatchRule = "hand" | "exact" | "case" | "barcode";
export const MATCH_RULES: readonly MatchRule[] = ["hand", "exact", "case", "barcode"];

/** Why a Michaels SKU has no item. */
export type MatchProblem =
  "no_match" | "ambiguous" | "duplicate" | "no_seller_sku" | "pairing_missing";
export const MATCH_PROBLEMS: readonly MatchProblem[] = [
  "no_match",
  "ambiguous",
  "duplicate",
  "no_seller_sku",
  "pairing_missing",
];

/** The shop's items, indexed for matching Michaels seller SKUs (values: stock item ids). */
export interface SkuIndex {
  exact: Map<string, string[]>;
  /** Keyed by foldSku(sku). */
  folded: Map<string, string[]>;
  /** Michaels GTIN → items whose shop barcode equals it. */
  barcode: Map<string, string[]>;
  /**
   * Pairings typed in by hand: Michaels seller SKU → the item it was paired
   * with, or null when that item is no longer there.
   */
  paired: Map<string, string | null>;
}

export const foldSku = (sku: string) => sku.trim().toLowerCase();

export function buildSkuIndex(
  items: { id: string; sku: string | null; barcode?: string | null }[],
  pairings: { seller_sku: string; stock_item_id: string | null }[],
): SkuIndex {
  const push = (m: Map<string, string[]>, k: string, id: string) =>
    m.set(k, [...(m.get(k) ?? []), id]);
  const idx: SkuIndex = {
    exact: new Map(),
    folded: new Map(),
    barcode: new Map(),
    paired: new Map(),
  };
  for (const item of items) {
    if (item.sku?.trim()) {
      push(idx.exact, item.sku, item.id);
      push(idx.folded, foldSku(item.sku), item.id);
    }
    if (item.barcode?.trim()) push(idx.barcode, item.barcode.trim(), item.id);
  }
  for (const p of pairings) idx.paired.set(p.seller_sku, p.stock_item_id);
  return idx;
}

export type MatchResult =
  { itemId: string; rule: MatchRule } | { itemId: null; problem: MatchProblem; detail: string };

/**
 * Match one Michaels SKU to a stock item. A pairing typed in by hand wins.
 * Then TuftStock's rules in its order: exact SKU, the SKU with capitals and
 * outer spaces ignored, GTIN = the shop's barcode. A rule only counts with
 * exactly one hit. Two or more is ambiguous and we stop rather than guess
 * which item sells; a later rule never overrides that.
 */
export function matchSku(
  row: { sellerSku: string | null; gtin: string | null },
  idx: SkuIndex,
): MatchResult {
  if (!row.sellerSku) {
    return {
      itemId: null,
      problem: "no_seller_sku",
      detail: "Michaels has this without a seller SKU, so there is nothing to match it by",
    };
  }
  if (idx.paired.has(row.sellerSku)) {
    const itemId = idx.paired.get(row.sellerSku);
    if (itemId) return { itemId, rule: "hand" };
    return {
      itemId: null,
      problem: "pairing_missing",
      detail: "It was paired by hand with an item that is no longer in your shop",
    };
  }
  const tries: [MatchRule, string[] | undefined][] = [
    ["exact", idx.exact.get(row.sellerSku)],
    ["case", idx.folded.get(foldSku(row.sellerSku))],
    ["barcode", row.gtin ? idx.barcode.get(row.gtin) : undefined],
  ];
  for (const [rule, ids] of tries) {
    if (!ids || ids.length === 0) continue;
    if (ids.length > 1) {
      return {
        itemId: null,
        problem: "ambiguous",
        detail: `${ids.length} items in your shop ${rule === "barcode" ? "share this barcode" : "share this SKU"}`,
      };
    }
    return { itemId: ids[0], rule };
  }
  return { itemId: null, problem: "no_match", detail: "Nothing in your shop has this SKU" };
}

export type MatchedRow = MichaelsSkuRow & { match: MatchResult };

export interface MatchSummary {
  skus: number;
  matched: number;
  byRule: Record<MatchRule, number>;
  unmatched: number;
  byProblem: Record<MatchProblem, number>;
  /** More than a tenth unmatched: nothing may be sent until they are sorted out. */
  blocked: boolean;
}

/**
 * Match every row. Seller SKUs should be one of a kind on Michaels; where two
 * listings share one, the first keeps its match and the rest are reported as
 * duplicates rather than guessed at.
 */
export function matchAll(
  rows: MichaelsSkuRow[],
  idx: SkuIndex,
): { rows: MatchedRow[]; summary: MatchSummary } {
  const byRule: Record<MatchRule, number> = { hand: 0, exact: 0, case: 0, barcode: 0 };
  const byProblem: Record<MatchProblem, number> = {
    no_match: 0,
    ambiguous: 0,
    duplicate: 0,
    no_seller_sku: 0,
    pairing_missing: 0,
  };
  const seen = new Set<string>();
  const out: MatchedRow[] = [];
  let matched = 0;
  for (const row of rows) {
    let match = matchSku(row, idx);
    if (row.sellerSku) {
      if (seen.has(row.sellerSku)) {
        match = {
          itemId: null,
          problem: "duplicate",
          detail: "The same seller SKU is on more than one Michaels listing",
        };
      }
      seen.add(row.sellerSku);
    }
    if (match.itemId !== null) {
      matched += 1;
      byRule[match.rule] += 1;
    } else {
      byProblem[match.problem] += 1;
    }
    out.push({ ...row, match });
  }
  const unmatched = rows.length - matched;
  return {
    rows: out,
    summary: {
      skus: rows.length,
      matched,
      byRule,
      unmatched,
      byProblem,
      blocked: adoptionBlocked(rows.length, unmatched),
    },
  };
}

/** More than this share unmatched means a format we don't understand: stop and look. */
export const MAX_UNMATCHED_SHARE = 0.1;

export function adoptionBlocked(total: number, unmatched: number): boolean {
  return total > 0 && unmatched / total > MAX_UNMATCHED_SHARE;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

const isOrderArray = (v: unknown): v is MichaelsOrder[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.every((o) => o && typeof o === "object" && "orderNumber" in o);

/**
 * Orders from /order/query. The docs don't name the list inside `data`, so
 * rather than guess a key, take the first array of order-shaped objects found
 * in `data` itself or one level down.
 */
export function extractOrders(
  data: MichaelsOrderPage | MichaelsOrder[] | null | undefined,
): MichaelsOrder[] {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  const values = Object.values(data as Record<string, unknown>);
  for (const v of values) if (isOrderArray(v)) return v;
  for (const v of values) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const w of Object.values(v as Record<string, unknown>)) if (isOrderArray(w)) return w;
    }
  }
  return [];
}

/** Top-level shape of a reply, for diagnosis (keys and array lengths only, no customer data). */
export function describeShape(data: unknown): string {
  if (data === null || data === undefined) return String(data);
  if (Array.isArray(data)) return `array(${data.length})`;
  if (typeof data !== "object") return typeof data;
  return Object.entries(data as Record<string, unknown>)
    .map(
      ([k, v]) =>
        `${k}:${Array.isArray(v) ? `array(${v.length})` : v === null ? "null" : typeof v === "object" ? `{${Object.keys(v as object).join(",")}}` : typeof v}`,
    )
    .join(" ");
}

// ---------------------------------------------------------------------------
// API key expiry (Michaels keys last 90 days)
// ---------------------------------------------------------------------------

export const KEY_LIFETIME_DAYS = 90;
/**
 * Replace keys at 60 days, not 90: in practice a Michaels key degrades or
 * stops working in its last 30 days (learned the hard way in TuftStock). The
 * countdown and alerts work toward this date; the 90-day expiry is shown too.
 */
export const KEY_REPLACE_DAYS = 60;

export type KeyExpiryLevel = "unknown" | "ok" | "warn" | "alert" | "expired";

export interface KeyExpiry {
  /** Against the replace-by date: warn at 14 days, alert at 3 or past it, expired at 90 days. */
  level: KeyExpiryLevel;
  /** Days until the replace-by date (negative once past it). */
  daysToReplace: number | null;
  replaceOn: string | null;
  /** Days until Michaels expires the key outright. */
  daysLeft: number | null;
  expiresOn: string | null;
}

/**
 * Michaels has no call that says when a key ends, so the countdown runs from
 * the day the key was made, as the person typed it when connecting. `today`
 * is the workspace's own calendar day (YYYY-MM-DD).
 */
export function keyExpiry(createdOn: string | null | undefined, today: string): KeyExpiry {
  const unknown: KeyExpiry = {
    level: "unknown",
    daysToReplace: null,
    replaceOn: null,
    daysLeft: null,
    expiresOn: null,
  };
  // Only the calendar date matters: "2026-09-14" or "2026-09-14 09:42:01 AM".
  const day = createdOn?.trim().match(/^(\d{4}-\d{2}-\d{2})(?:$|[ T])/)?.[1];
  if (!day) return unknown;
  const created = Date.parse(`${day}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(created) || !Number.isFinite(now)) return unknown;
  const at = (days: number) => new Date(created + days * 86_400_000);
  const until = (d: Date) => Math.round((d.getTime() - now) / 86_400_000);
  const daysLeft = until(at(KEY_LIFETIME_DAYS));
  const daysToReplace = until(at(KEY_REPLACE_DAYS));
  const level: KeyExpiryLevel =
    daysLeft <= 0 ? "expired" : daysToReplace <= 3 ? "alert" : daysToReplace <= 14 ? "warn" : "ok";
  return {
    level,
    daysToReplace,
    replaceOn: at(KEY_REPLACE_DAYS).toISOString().slice(0, 10),
    daysLeft,
    expiresOn: at(KEY_LIFETIME_DAYS).toISOString().slice(0, 10),
  };
}
