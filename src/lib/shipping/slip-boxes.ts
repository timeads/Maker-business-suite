import { code128 } from "./code128";

/**
 * Packing slips for an order going out in several boxes, and the codes on
 * them. One slip per box, each listing only what goes in that box, with a
 * barcode that says which box it is ("68762-TG/B2"), so the packing bench can
 * check one box at a time.
 *
 * Ported from the single-tenant help desk (`renderSlip` in `src/lib/slip.ts`,
 * `slipsFor` and `/shipping/scan/:code` in `src/routes/shipping.ts`, and the
 * `looksLikeOrder` pattern in `public/js/scan.js`). Pure: no network, no
 * database, safe in the browser.
 */

/** A code both printers can draw: Code 128 B on screen, and `^BC` on a Zebra, which reads ^ ~ > as commands. */
export const barcodeSafe = (code: string) =>
  /^[\x20-\x7e]{1,32}$/.test(code) && !/[\^~>]/.test(code) && code128(code) !== null;

/** What an order's slip says in bars: its name without the "#" ("68762-TG"). */
export const slipCode = (name: string | null | undefined) =>
  (name ?? "").trim().replace(/^#+/, "").trim();

/** The code on one box's slip: the order's code, then which box ("68762-TG/B2"). */
export const boxSlipCode = (code: string, n: number) => `${code}/B${n}`;

/**
 * The code on the one slip for orders going out together: their numbers
 * joined with "+" ("1042+1055-TG"), which opens the whole group at the
 * bench. When that is too long for a barcode, the first order's own number,
 * which leads to the group once it is saved.
 */
export function groupSlipCode(names: (string | null | undefined)[]): string {
  const codes = names.map(slipCode).filter(Boolean);
  const joined = codes.join("+");
  return barcodeSafe(joined) ? joined : (codes[0] ?? "");
}

export type SlipCodeRead = {
  /** The whole code, tidied: tried first as an order's own number. */
  whole: string;
  /** The order's code when the end reads as a box ("68762-TG" of "68762-TG/B2"); else the whole code. */
  base: string;
  /** Which box, when the end reads as one. */
  box: number | null;
  /** The order codes: several when the slip is for orders going out together. */
  parts: string[];
};

const ORDER_CODE = /^[A-Za-z0-9][A-Za-z0-9 ./-]{0,39}$/;
/** "/B2" at the end. Some scanners turn "/" into "-", "?" or a space, so those are read as well. */
const BOX_END = /^(.*?)[/?\-\s]B(\d{1,2})$/i;

/**
 * Reads what was scanned off a slip, or typed: an order's number, a box of
 * it ("1042/B2", "1042-B2", "1042?B2", "1042 b2"), or several orders going
 * together ("1042+1055"). Null when it couldn't be any of those.
 *
 * An order can really be called "1042-B2", so the caller looks for the whole
 * code first and only then for the box of the shorter one.
 */
export function parseSlipCode(input: string): SlipCodeRead | null {
  const typed = input.trim().replace(/^#+/, "").trim();
  if (!typed) return null;
  const end = BOX_END.exec(typed);
  const box = end ? Number(end[2]) : null;
  const base = end && box !== null && box >= 1 ? end[1].trim() : typed;
  const split = (value: string) =>
    value
      .split("+")
      .map((part) => part.trim().replace(/^#+/, "").trim())
      .filter(Boolean);
  const parts = split(base);
  if (parts.length === 0 || parts.length > 10 || !parts.every((part) => ORDER_CODE.test(part))) {
    // The end only looked like a box: is the whole thing an order number?
    return ORDER_CODE.test(typed) ? { whole: typed, base: typed, box: null, parts: [typed] } : null;
  }
  const whole = split(typed).every((part) => ORDER_CODE.test(part)) ? typed : base;
  return {
    whole,
    base,
    box: base === typed ? null : box,
    parts,
  };
}

/**
 * With an order already open at the bench: does this scan look like another
 * slip rather than an item? The old app's rule (a number of three digits or
 * more, an optional "-TG" style ending, an optional box), plus anything that
 * starts with "#" and any box of the order that is open. The caller still
 * treats it as an item when it is one of the open order's own codes.
 */
export function looksLikeSlip(input: string, openCode?: string | null): boolean {
  const typed = input.trim();
  if (!typed) return false;
  if (/^#?\d{3,}(-[a-z]+)?([/?\-\s]B\d{1,2})?$/i.test(typed)) return true;
  if (typed.startsWith("#")) return parseSlipCode(typed) !== null;
  const read = parseSlipCode(typed);
  if (!read) return false;
  if (read.parts.length > 1) return true;
  const open = slipCode(openCode).toLowerCase();
  return Boolean(open) && read.box !== null && read.base.toLowerCase() === open;
}

/** One box of an order: what it is, and how many of each line go in it. */
export type BoxContents = {
  /** "Medium box", or its size when it isn't a saved box. */
  name: string | null;
  /** Its tracking number, once the label is bought. */
  tracking: string | null;
  /** Units of each line in this box, by line id. */
  items: Record<string, number>;
};

/** One box that gets its own slip. */
export type SlipBox = BoxContents & {
  /** Which box it is among those with something in them, counting from 1: what the slip and its code say. */
  n: number;
  /** How many boxes have something in them. */
  of: number;
  /** Where its label sits among the purchase's labels, counting from 1 (an empty box still has a label). */
  label: number;
};

const units = (items: Record<string, number>) =>
  Object.values(items).reduce((sum, qty) => sum + (qty > 0 ? qty : 0), 0);

/**
 * The boxes that each get their own slip: those with something in them, when
 * there are two or more. An order in one box (or with nothing said about
 * what goes where) has one slip for the whole order, so this is empty.
 */
export function slipBoxes(boxes: BoxContents[]): SlipBox[] {
  const filled = boxes
    .map((box, index) => ({ ...box, label: index + 1 }))
    .filter((box) => units(box.items) > 0);
  if (filled.length < 2) return [];
  return filled.map((box, index) => ({ ...box, n: index + 1, of: filled.length }));
}

/** The lines that go in one box, each with the number in that box. */
export function boxLines<T extends { line_id: string }>(
  lines: T[],
  box: Pick<BoxContents, "items">,
): (T & { inBox: number })[] {
  return lines
    .map((line) => ({ ...line, inBox: Math.max(0, Math.floor(box.items[line.line_id] ?? 0)) }))
    .filter((line) => line.inBox > 0);
}

/**
 * What was kept about a bought label's boxes (`shipments.box_items`), read
 * defensively, with each box's tracking number beside it. Empty when nothing
 * usable was kept: the parcel then has one slip, as before.
 */
export function boughtBoxes(
  stored: unknown,
  tracking: (string | null | undefined)[],
): BoxContents[] {
  if (!Array.isArray(stored) || stored.length === 0 || stored.length > 6) return [];
  const boxes: BoxContents[] = [];
  for (const [index, entry] of stored.entries()) {
    if (!entry || typeof entry !== "object") return [];
    const box = entry as { name?: unknown; items?: unknown };
    if (!box.items || typeof box.items !== "object" || Array.isArray(box.items)) return [];
    const items: Record<string, number> = {};
    for (const [lineId, qty] of Object.entries(box.items as Record<string, unknown>)) {
      if (typeof qty === "number" && Number.isInteger(qty) && qty > 0) items[lineId] = qty;
    }
    boxes.push({
      name: typeof box.name === "string" && box.name.trim() ? box.name.trim().slice(0, 80) : null,
      tracking: tracking[index] || null,
      items,
    });
  }
  return boxes;
}

/** A person's own size for a box that isn't a saved one: "12 × 9 × 4 in". */
export const sizeName = (box: { length: number; width: number; height: number }) =>
  `${box.length} × ${box.width} × ${box.height} in`;
