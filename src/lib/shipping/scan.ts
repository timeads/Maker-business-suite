import { parseSavedChoice, type SavedChoice } from "./choices";
import { lbOzToTenthOz } from "./easypost";
import { parseInches } from "./labels";

/**
 * Scan & pack: what a scanned code means. Pure, so the packing bench behaves
 * the same whether a scanner or a person typed the code.
 */
export type PackLine = {
  line_id: string;
  title: string;
  variant: string | null;
  sku: string | null;
  barcode?: string | null;
  left: number;
  /** A small picture of the option that was ordered, on the shop platform's image servers. */
  image?: string | null;
  /** In a parcel of several orders: the order this line is from. */
  from?: string | null;
};

const norm = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();

/**
 * The order number on a scanned slip or typed by hand, without its "#".
 * Empty when it isn't something an order number could be.
 */
export function orderCode(input: string): string {
  const code = input.trim().replace(/^#+/, "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9 ./-]{0,39}$/.test(code) ? code : "";
}

export type ScanResult =
  | { ok: true; line_id: string; title: string; done: boolean }
  | { ok: false; reason: "unknown" | "full"; title?: string; left?: number };

/**
 * One scan of an item's SKU or barcode ticks one unit. When two lines share a
 * code, the one that still needs units gets it.
 */
export function scanItem(
  lines: PackLine[],
  packed: Record<string, number>,
  input: string,
): ScanResult {
  const code = norm(input);
  if (!code) return { ok: false, reason: "unknown" };
  const matches = lines.filter(
    (line) => line.left > 0 && (norm(line.sku) === code || norm(line.barcode) === code),
  );
  if (matches.length === 0) return { ok: false, reason: "unknown" };
  const line = matches.find((match) => (packed[match.line_id] ?? 0) < match.left);
  if (!line) return { ok: false, reason: "full", title: matches[0].title, left: matches[0].left };
  const next = { ...packed, [line.line_id]: (packed[line.line_id] ?? 0) + 1 };
  return { ok: true, line_id: line.line_id, title: line.title, done: allPacked(lines, next) };
}

/** Everything still to send has been ticked. */
export const allPacked = (lines: PackLine[], packed: Record<string, number>) =>
  lines.some((line) => line.left > 0) &&
  lines.every((line) => (packed[line.line_id] ?? 0) >= line.left);

/** Whether a scanned code is one of these lines' own (its SKU or barcode). */
export const isItemCode = (lines: PackLine[], input: string) => {
  const code = norm(input);
  return (
    Boolean(code) && lines.some((line) => norm(line.sku) === code || norm(line.barcode) === code)
  );
};

/**
 * The lines to check for one box of an order going out in several: only what
 * goes in that box, each with the number in that box. Worked out from the
 * box, not from what is left on the order, so a box can still be checked
 * after the labels for every box have been bought.
 */
export function boxPackLines(
  lines: PackLine[],
  box: { items: Record<string, number> },
): PackLine[] {
  return lines
    .map((line) => ({ ...line, left: Math.max(0, Math.floor(box.items[line.line_id] ?? 0)) }))
    .filter((line) => line.left > 0);
}

/** The first box whose label hasn't been printed yet; null when every box's has. */
export const nextBox = <T extends { n: number }>(boxes: T[], printed: number[]): T | null =>
  boxes.find((box) => !printed.includes(box.n)) ?? null;

// ---------------------------------------------------------------------------
// The box row and the buttons under the items
// ---------------------------------------------------------------------------

/** The box row as it stands on the bench: a saved box or a size typed in, and the packed weight. */
export type BenchBox = {
  /** A saved box's id, or empty for a size typed in. */
  boxId: string;
  length: string;
  width: string;
  height: string;
  /** Both empty: the weight follows the items. */
  weightLb: string;
  weightOz: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The bench's box row as a choice the plan understands: the one planned box,
 * with the size and weight a person typed. Null when the order is planned in
 * several boxes (those are changed on the order's page) or a figure doesn't
 * read as one. A signature or service already saved for the order is kept.
 */
export function benchChoice(
  box: BenchBox,
  base: { boxes: { items: Record<string, number> }[] },
  saved?: Pick<SavedChoice, "signature" | "service"> | null,
): SavedChoice | null {
  if (!box || typeof box !== "object" || base.boxes.length !== 1) return null;
  const size = [box.length, box.width, box.height].map((value) => parseInches(String(value ?? "")));
  if (size.some((value) => value === null)) return null;
  const lb = String(box.weightLb ?? "").trim();
  const oz = String(box.weightOz ?? "").trim();
  const weight = lb === "" && oz === "" ? null : lbOzToTenthOz(lb, oz);
  if ((lb !== "" || oz !== "") && (weight === null || weight <= 0)) return null;
  return parseSavedChoice({
    v: 1,
    boxes: [
      {
        box_id: UUID.test(String(box.boxId ?? "")) ? box.boxId : null,
        length: size[0],
        width: size[1],
        height: size[2],
        weight_tenth_oz: weight,
        items: base.boxes[0].items,
      },
    ],
    signature: saved?.signature ?? null,
    service: saved?.service ?? null,
  });
}

/** What was scanned of each line, as the part of the order to send now. */
export function scannedPart(
  lines: PackLine[],
  packed: Record<string, number>,
): { line_id: string; qty: number }[] {
  return lines
    .map((line) => ({
      line_id: line.line_id,
      qty: Math.max(0, Math.min(line.left, Math.floor(packed[line.line_id] ?? 0))),
    }))
    .filter((item) => item.qty > 0);
}

/** "2 × Wool rug (Large)" for each line with something still unscanned. */
export function notScanned(lines: PackLine[], packed: Record<string, number>): string[] {
  return lines
    .filter((line) => (packed[line.line_id] ?? 0) < line.left)
    .map(
      (line) =>
        `${line.left - Math.min(line.left, packed[line.line_id] ?? 0)} × ${line.title}${line.variant ? ` (${line.variant})` : ""}`,
    );
}

/** The `?part=` an order's page reads: the scanned amounts, so it opens with them filled in. */
export const partQuery = (part: { line_id: string; qty: number }[]) =>
  part.map((item) => `${item.qty}~${encodeURIComponent(item.line_id)}`).join(",");

/** What the shopper paid for shipping against what the label costs, in cents. Null when either isn't known. */
export function benchMargin(paid: number | null | undefined, price: string): number | null {
  const cost = Number(price);
  if (paid === null || paid === undefined || !Number.isFinite(Number(paid))) return null;
  if (!Number.isFinite(cost)) return null;
  return Math.round(Number(paid) * 100) - Math.round(cost * 100);
}

/**
 * With "print as soon as every item is scanned" ticked: whether the scan that
 * just landed should press the button. Counts filled in by hand don't
 * qualify, and nothing is pressed for an order that can't be bought as it is.
 */
export const autoPrintNow = (facts: {
  ticked: boolean;
  /** Everything being packed (the order, or this box) is checked. */
  verified: boolean;
  /** A count was filled in by hand rather than scanned. */
  byHand: boolean;
  /** The order can't go as it stands (a hold, a label already, payment). */
  blocked: boolean;
}) => facts.ticked && facts.verified && !facts.byHand && !facts.blocked;
