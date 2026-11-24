import { createHash } from "node:crypto";
import type { Alloc } from "./packing";

/**
 * Packing memory: after a label is bought for a whole order, the boxes it
 * went in are remembered for that exact set of items, so the next order with
 * the same things starts packed the same way. Ported from the reference help
 * desk's `learnPacking` and the memory half of `planOrders`.
 *
 * Pure: no network, no database. Nothing here is about a shopper: a key is
 * item codes (or product names) and how many of each.
 */

/** What memory needs to know of an order's line. */
export type MemoryItem = {
  line_id: string;
  title?: string | null;
  variant?: string | null;
  sku?: string | null;
  /** How many are going. */
  qty: number;
};

/** One product, however it's listed on the order: its item code, else its name and option. */
export const productKey = (item: Pick<MemoryItem, "title" | "variant" | "sku">) =>
  (item.sku || `${item.title ?? ""}${item.variant ? ` / ${item.variant}` : ""}`).toLowerCase();

const going = (items: MemoryItem[]) => items.filter((item) => item.qty > 0);

/** A key that would be too long to keep is kept as its fingerprint instead. */
const MOST_KEY = 400;
const kept = (key: string) =>
  key.length > MOST_KEY ? `h:${createHash("sha256").update(key).digest("hex")}` : key;

/** Identical item sets share a key, e.g. "ak5-cut×1|yarn-mustard×4". Lines of one product are added up. */
export function itemsKey(items: MemoryItem[]): string {
  const qty = new Map<string, number>();
  for (const item of going(items)) {
    qty.set(productKey(item), (qty.get(productKey(item)) ?? 0) + item.qty);
  }
  return kept(
    [...qty]
      .map(([key, count]) => `${key}×${count}`)
      .sort()
      .join("|"),
  );
}

/** The same products, whatever the quantities. */
export function productsKey(items: MemoryItem[]): string {
  return kept([...new Set(going(items).map(productKey))].sort().join("|"));
}

/** "2 × Wool rug (Large), 3 × Yarn bundle": what a remembered packing was for, in words. */
export const itemsLabel = (items: MemoryItem[]) =>
  going(items)
    .map(
      (item) =>
        `${item.qty} × ${item.title ?? item.sku ?? "Item"}${item.variant ? ` (${item.variant})` : ""}`,
    )
    .join(", ")
    .slice(0, 500);

export type LearnedBox = {
  /** The saved box it went in, when it was one. */
  box_id: string | null;
  /** Inches. */
  length: number;
  width: number;
  height: number;
  /** The packed box, in tenths of an ounce. */
  weight_tenth_oz: number;
  /** Product key → how many went in this box. */
  items: Record<string, number>;
};

export type Learned = {
  item_key: string;
  products_key: string | null;
  boxes: LearnedBox[];
};

/** A box as it was bought: what the label was priced for, and which lines went in it. */
export type PackedBox = {
  boxId: string | null;
  length: number;
  width: number;
  height: number;
  weightTenthOz: number;
  /** Units of each line in this box, by line id. Left out: not known. */
  alloc?: Alloc | null;
};

/**
 * How an order was packed, as it is remembered: every box, its size and
 * weight, and what went in it. One box holds everything; with several, each
 * holds what its split says (and nothing, when no split was given).
 */
export function learnedBoxes(items: MemoryItem[], parcels: PackedBox[]): LearnedBox[] {
  const lines = new Map(going(items).map((item) => [item.line_id, item]));
  return parcels.map((parcel) => {
    const inside: Record<string, number> = {};
    if (parcels.length === 1) {
      for (const item of lines.values()) {
        inside[productKey(item)] = (inside[productKey(item)] ?? 0) + item.qty;
      }
    } else {
      for (const [lineId, count] of Object.entries(parcel.alloc ?? {})) {
        const item = lines.get(lineId);
        const units = Math.max(0, Math.round(Number(count) || 0));
        if (item && units > 0) inside[productKey(item)] = (inside[productKey(item)] ?? 0) + units;
      }
    }
    return {
      box_id: parcel.boxId,
      length: parcel.length,
      width: parcel.width,
      height: parcel.height,
      weight_tenth_oz: Math.round(parcel.weightTenthOz),
      items: inside,
    };
  });
}

const UUID = /^[0-9a-f-]{36}$/i;
const inches = (value: unknown) => {
  const size = Number(value);
  return Number.isFinite(size) && size > 0 && size <= 108 ? size : null;
};

/** A row of `shipping_packings`, read defensively. Null when it isn't usable. */
export function parseLearned(row: {
  item_key?: unknown;
  products_key?: unknown;
  boxes?: unknown;
}): Learned | null {
  if (typeof row.item_key !== "string" || !Array.isArray(row.boxes) || row.boxes.length < 1) {
    return null;
  }
  const boxes: LearnedBox[] = [];
  for (const raw of row.boxes.slice(0, 6)) {
    if (!raw || typeof raw !== "object") return null;
    const box = raw as Record<string, unknown>;
    const length = inches(box.length);
    const width = inches(box.width);
    const height = inches(box.height);
    if (!(length && width && height)) return null;
    const weight = Number(box.weight_tenth_oz);
    const items: Record<string, number> = {};
    if (box.items && typeof box.items === "object") {
      for (const [key, count] of Object.entries(box.items as Record<string, unknown>)) {
        const units = Math.round(Number(count));
        if (key.length <= 300 && Number.isFinite(units) && units > 0) items[key] = units;
      }
    }
    boxes.push({
      box_id: typeof box.box_id === "string" && UUID.test(box.box_id) ? box.box_id : null,
      length,
      width,
      height,
      weight_tenth_oz: Number.isFinite(weight) && weight > 0 ? Math.round(weight) : 0,
      items,
    });
  }
  return {
    item_key: row.item_key,
    products_key: typeof row.products_key === "string" ? row.products_key : null,
    boxes,
  };
}

/**
 * A remembered split laid onto a new order's lines: the same products in the
 * same boxes, whatever the lines are called this time. Anything that finds no
 * place (which shouldn't happen for an exact match) goes in the first box.
 */
export function allocFromMemory(memory: Learned, items: MemoryItem[]): Alloc[] {
  const lines = going(items);
  const left = new Map(lines.map((item) => [item.line_id, item.qty]));
  const allocs = memory.boxes.map((box) => {
    const alloc: Alloc = {};
    for (const [key, count] of Object.entries(box.items ?? {})) {
      let need = count;
      for (const item of lines) {
        if (productKey(item) !== key || need <= 0) continue;
        const take = Math.min(need, left.get(item.line_id) ?? 0);
        if (take > 0) {
          alloc[item.line_id] = (alloc[item.line_id] ?? 0) + take;
          left.set(item.line_id, (left.get(item.line_id) ?? 0) - take);
          need -= take;
        }
      }
    }
    return alloc;
  });
  for (const [lineId, count] of left) {
    if (count > 0) allocs[0][lineId] = (allocs[0][lineId] ?? 0) + count;
  }
  return allocs;
}

/** What a workspace has remembered, as planning looks it up. */
export type PackingMemory = {
  /** By `itemsKey`. */
  exact: Map<string, Learned>;
  /** By `productsKey`: the latest packing of those products in any quantities. */
  similar: Map<string, Learned>;
};

export const NO_MEMORY: PackingMemory = { exact: new Map(), similar: new Map() };

/** Rows oldest first, so the latest packing of a product set wins. */
export function buildMemory(rows: Learned[]): PackingMemory {
  const memory: PackingMemory = { exact: new Map(), similar: new Map() };
  for (const row of rows) {
    memory.exact.set(row.item_key, row);
    if (row.products_key) memory.similar.set(row.products_key, row);
  }
  return memory;
}
