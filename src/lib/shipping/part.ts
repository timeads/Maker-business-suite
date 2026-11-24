/**
 * Shipping part of an order with a bought label: which items go now, and
 * what that leaves behind. Pure: no network, no database, safe in the
 * browser. What is really recorded is decided in the database, from the
 * items the server kept with the quote; this only shapes the page.
 */

export type PartItem = { line_id: string; qty: number };

type Line = {
  line_id: string;
  title: string;
  variant?: string | null;
  /** One unit's weight in grams, where the shop shares it. */
  grams?: number | null;
  left: number;
};

/** "2~line-a,1~line-b" for the page's address. */
export const formatPart = (items: PartItem[]): string =>
  items
    .filter((item) => item.qty > 0)
    .map((item) => `${item.qty}~${encodeURIComponent(item.line_id)}`)
    .join(",");

/**
 * Reads the page's `part` back, held to what is still left on the order.
 * Null when it names nothing that's left, or when it is everything that's
 * left (that is simply the whole order, bought the usual way).
 */
export function parsePart(raw: unknown, lines: Line[]): PartItem[] | null {
  if (typeof raw !== "string" || raw === "" || raw.length > 20_000) return null;
  const asked = new Map<string, number>();
  for (const piece of raw.split(",")) {
    const at = piece.indexOf("~");
    if (at < 1) continue;
    const qty = Number(piece.slice(0, at));
    let id: string;
    try {
      id = decodeURIComponent(piece.slice(at + 1));
    } catch {
      continue;
    }
    if (!Number.isInteger(qty) || qty <= 0 || !id) continue;
    asked.set(id, (asked.get(id) ?? 0) + qty);
  }
  const items = lines
    .filter((line) => line.left > 0)
    .map((line) => ({
      line_id: line.line_id,
      qty: Math.min(line.left, asked.get(line.line_id) ?? 0),
    }))
    .filter((item) => item.qty > 0);
  if (items.length === 0) return null;
  const going = items.reduce((sum, item) => sum + item.qty, 0);
  const left = lines.reduce((sum, line) => sum + Math.max(0, line.left), 0);
  return going >= left ? null : items;
}

/** Whether two lists name the same items in the same amounts. */
export function samePart(a: unknown, b: unknown): boolean {
  const key = (list: unknown) =>
    Array.isArray(list)
      ? list
          .map(
            (item) => `${String((item as PartItem)?.line_id)}×${Number((item as PartItem)?.qty)}`,
          )
          .sort()
          .join("|")
      : null;
  return key(a) === key(b);
}

/** "1 × Primary Tufting Cloth, 2 × Yarn (Red)": what a part shipment leaves waiting. */
export function leftBehind(lines: Line[], part: PartItem[]): string {
  const going = new Map(part.map((item) => [item.line_id, item.qty]));
  return lines
    .map((line) => ({ line, left: line.left - (going.get(line.line_id) ?? 0) }))
    .filter((each) => each.left > 0)
    .map(
      (each) =>
        `${each.left} × ${each.line.title}${each.line.variant ? ` (${each.line.variant})` : ""}`,
    )
    .join(", ");
}

/** The note a part shipment leaves on the hold, as the database writes it. */
export const partHoldNote = (lines: Line[], part: PartItem[]): string =>
  `Part sent — waiting on: ${leftBehind(lines, part) || "the rest"}`.slice(0, 300);

/**
 * The order with only what is going now still "left", for laying out boxes
 * and weights. The weight is known only when every item going says its own.
 */
export function partOrder<T extends { items: Line[]; units_left: number }>(
  order: T,
  part: PartItem[],
): T & { weight_grams: number | null } {
  const going = new Map(part.map((item) => [item.line_id, item.qty]));
  const items = order.items.map((item) => ({
    ...item,
    left: Math.min(item.left, going.get(item.line_id) ?? 0),
  }));
  const sent = items.filter((item) => item.left > 0);
  const weighed = sent.every((item) => item.grams !== null && item.grams !== undefined);
  return {
    ...order,
    items,
    units_left: sent.reduce((sum, item) => sum + item.left, 0),
    weight_grams: weighed
      ? sent.reduce((sum, item) => sum + Number(item.grams) * item.left, 0) || null
      : null,
  };
}

/**
 * A list of items as a browser sent it, checked against what is left on the
 * order. `null`: no part was asked for, or it is everything left. An error
 * when it asks for something the order no longer has to send: the page is
 * out of date, and the person should look again before anything is priced.
 */
export function cleanPart(
  raw: unknown,
  lines: Line[],
): { part: PartItem[] | null } | { error: string } {
  if (raw === undefined || raw === null) return { part: null };
  if (!Array.isArray(raw) || raw.length > 250) return { error: PART_CHANGED };
  const asked = new Map<string, number>();
  for (const each of raw) {
    const id = typeof each?.line_id === "string" ? each.line_id : "";
    const qty = Number(each?.qty);
    if (!id || !Number.isInteger(qty) || qty < 0 || qty > 100_000) return { error: PART_CHANGED };
    if (qty > 0) asked.set(id, (asked.get(id) ?? 0) + qty);
  }
  if (asked.size === 0) return { error: "Say how many of at least one item are going now." };
  const left = new Map(lines.map((line) => [line.line_id, Math.max(0, line.left)]));
  for (const [id, qty] of asked) {
    if ((left.get(id) ?? 0) < qty) return { error: PART_CHANGED };
  }
  const items = lines
    .filter((line) => asked.has(line.line_id))
    .map((line) => ({ line_id: line.line_id, qty: asked.get(line.line_id)! }));
  const going = items.reduce((sum, item) => sum + item.qty, 0);
  const total = [...left.values()].reduce((sum, qty) => sum + qty, 0);
  return { part: going >= total ? null : items };
}

export const PART_CHANGED =
  "What's left on this order has changed. Reload this page and choose what's going again.";
