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
  /** One unit's weight in grams, when the shop gave one: "Split evenly" goes by it. */
  grams?: number | null;
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

// ---------------------------------------------------------------------------
// Changing the boxes at the bench, before the label is bought
// ---------------------------------------------------------------------------

/** One box on the bench's "Change boxes" sheet: its size and weight as typed, and what is in it. */
export type BenchSplitBox = BenchBox & {
  /** Units of each line in this box, by line id. */
  items: Record<string, number>;
};

/** The most boxes one purchase takes. */
export const BENCH_MAX_BOXES = 6;

type SplitLine = { line_id: string; left: number };

const units = (box: BenchSplitBox, lineId: string) =>
  Math.max(0, Math.floor(box.items[lineId] ?? 0));

/**
 * Another box, as the label builder adds one: the same size as the last, its
 * weight left to follow the items, and empty. The other boxes keep what's in
 * them; items are moved in afterwards.
 */
export function addSplitBox(boxes: BenchSplitBox[]): BenchSplitBox[] {
  if (boxes.length === 0 || boxes.length >= BENCH_MAX_BOXES) return boxes;
  const last = boxes[boxes.length - 1];
  return [...boxes, { ...last, weightLb: "", weightOz: "", items: {} }];
}

/** Takes a box away. What was in it goes to the box before it (the first box's go to the next). */
export function removeSplitBox(boxes: BenchSplitBox[], index: number): BenchSplitBox[] {
  if (boxes.length < 2 || index < 0 || index >= boxes.length) return boxes;
  const gone = boxes[index];
  const rest = boxes.filter((_, i) => i !== index);
  const to = Math.max(0, index - 1);
  return rest.map((box, i) => {
    if (i !== to) return box;
    const items = { ...box.items };
    for (const [lineId, count] of Object.entries(gone.items)) {
      if (count > 0) items[lineId] = units(box, lineId) + Math.floor(count);
    }
    // Its contents changed, so a weight typed for it no longer stands.
    return { ...box, weightLb: "", weightOz: "", items };
  });
}

/**
 * Puts `count` of a line in one box. More than before: the difference is
 * taken from whichever boxes hold the most of it. Fewer: what comes out goes
 * to the next box, so nothing is left unpacked. A box whose contents change
 * loses a weight typed for it (it follows the items again).
 */
export function setSplitQty(
  boxes: BenchSplitBox[],
  line: SplitLine,
  index: number,
  count: number,
): BenchSplitBox[] {
  if (index < 0 || index >= boxes.length) return boxes;
  const wanted = Math.max(0, Math.min(line.left, Math.round(Number(count) || 0)));
  const next = boxes.map((box) => ({ ...box, items: { ...box.items } }));
  const touch = (i: number, value: number) => {
    if (units(next[i], line.line_id) === value) return;
    next[i].items[line.line_id] = value;
    next[i].weightLb = "";
    next[i].weightOz = "";
  };
  let diff = wanted - units(next[index], line.line_id);
  touch(index, wanted);
  const others = next.map((_, i) => i).filter((i) => i !== index);
  if (diff > 0) {
    for (const i of [...others].sort(
      (a, b) => units(next[b], line.line_id) - units(next[a], line.line_id),
    )) {
      const take = Math.min(diff, units(next[i], line.line_id));
      touch(i, units(next[i], line.line_id) - take);
      diff -= take;
      if (diff === 0) break;
    }
  } else if (diff < 0 && others.length > 0) {
    const to = (index + 1) % next.length;
    touch(to, units(next[to], line.line_id) - diff);
  }
  return next;
}

/** How many of a line aren't in any box yet. */
export const notBoxed = (boxes: BenchSplitBox[], line: SplitLine) =>
  line.left - boxes.reduce((sum, box) => sum + units(box, line.line_id), 0);

/**
 * Deals the units out so each box gets about the same weight, heaviest
 * first (a unit with no weight on file counts as one).
 */
export function splitEvenly(
  boxes: BenchSplitBox[],
  lines: (SplitLine & { grams?: number | null })[],
): BenchSplitBox[] {
  if (boxes.length < 2) return boxes;
  const next = boxes.map((box) => ({
    ...box,
    weightLb: "",
    weightOz: "",
    items: {} as Record<string, number>,
  }));
  const weight = (line: { grams?: number | null }) =>
    line.grams && line.grams > 0 ? Number(line.grams) : 1;
  const each = lines
    .flatMap((line) => Array.from({ length: Math.max(0, line.left) }, () => line))
    .sort((a, b) => weight(b) - weight(a));
  const load = next.map(() => 0);
  for (const unit of each) {
    const i = load.indexOf(Math.min(...load));
    next[i].items[unit.line_id] = (next[i].items[unit.line_id] ?? 0) + 1;
    load[i] += weight(unit);
  }
  return next;
}

/**
 * The boxes a person laid out at the bench as the order's saved choice,
 * checked against what is left on the order: one to six boxes, every figure
 * a real one, every unit still to send in exactly one box, and no box left
 * empty. Run in the browser to say what's wrong, and again on the server
 * against the stored order, which is the check that counts.
 */
export function benchSplitChoice(
  input: unknown,
  lines: SplitLine[],
  saved?: Pick<SavedChoice, "signature" | "service"> | null,
): { choice: SavedChoice } | { error: string } {
  const asked = Array.isArray(input) ? (input as Partial<BenchSplitBox>[]) : [];
  if (asked.length < 1) return { error: "Add a box first." };
  if (asked.length > BENCH_MAX_BOXES) {
    return { error: `One label purchase covers up to ${BENCH_MAX_BOXES} boxes.` };
  }
  const left = new Map(lines.filter((line) => line.left > 0).map((l) => [l.line_id, l.left]));
  const placed = new Map<string, number>();
  const boxes: SavedChoice["boxes"] = [];
  for (const [index, box] of asked.entries()) {
    const name = asked.length > 1 ? `Box ${index + 1}` : "The box";
    if (!box || typeof box !== "object") return { error: `${name} isn't filled in.` };
    const size = [box.length, box.width, box.height].map((v) => parseInches(String(v ?? "")));
    if (size.some((value) => value === null)) {
      return { error: `${name} needs its length, width and height in inches.` };
    }
    const lb = String(box.weightLb ?? "").trim();
    const oz = String(box.weightOz ?? "").trim();
    const weight = lb === "" && oz === "" ? null : lbOzToTenthOz(lb, oz);
    if ((lb !== "" || oz !== "") && (weight === null || weight <= 0 || weight > 24_000)) {
      return { error: `${name}'s weight should be numbers, like 2 lb 4 oz.` };
    }
    const items: Record<string, number> = {};
    const raw = box.items && typeof box.items === "object" ? box.items : {};
    for (const [lineId, value] of Object.entries(raw)) {
      const count = Number(value);
      if (!Number.isInteger(count) || count < 0) return { error: `${name} has an odd count.` };
      if (count === 0) continue;
      if (!left.has(lineId)) {
        return { error: "What's left on this order has changed. Scan its slip again." };
      }
      items[lineId] = count;
      placed.set(lineId, (placed.get(lineId) ?? 0) + count);
    }
    if (Object.keys(items).length === 0) {
      return { error: `${name} is empty. Put something in it, or remove it.` };
    }
    boxes.push({
      box_id: UUID.test(String(box.boxId ?? "")) ? String(box.boxId) : null,
      length: size[0]!,
      width: size[1]!,
      height: size[2]!,
      weight_tenth_oz: weight,
      items,
    });
  }
  for (const [lineId, count] of left) {
    const inBoxes = placed.get(lineId) ?? 0;
    if (inBoxes > count) return { error: "More of an item is boxed than is left to send." };
    if (inBoxes < count) return { error: "Every item needs a box before this can be saved." };
  }
  const choice = parseSavedChoice({
    v: 1,
    boxes,
    signature: saved?.signature ?? null,
    service: saved?.service ?? null,
  });
  return choice ? { choice } : { error: "Those boxes don't add up. Check each one." };
}

/**
 * What was scanned, held to a new split. The bench keeps its counts when the
 * boxes change (as the reference does: they are kept box by box for as long
 * as the same order is open) and shows them against the new amounts, so a
 * count is never more than now goes in that box, and a box that is gone
 * takes its counts with it.
 */
export function keepScanned(
  packedBy: Record<number, Record<string, number>>,
  boxes: { n: number; items: Record<string, number> }[],
): Record<number, Record<string, number>> {
  const kept: Record<number, Record<string, number>> = {};
  // 0 is the order packed as a whole: a new split doesn't change what was scanned of it.
  if (packedBy[0]) kept[0] = packedBy[0];
  for (const box of boxes) {
    const before = packedBy[box.n];
    if (!before) continue;
    const now: Record<string, number> = {};
    for (const [lineId, count] of Object.entries(before)) {
      const most = Math.max(0, Math.floor(box.items[lineId] ?? 0));
      if (most > 0 && count > 0) now[lineId] = Math.min(count, most);
    }
    kept[box.n] = now;
  }
  return kept;
}

/** Whether two splits put the same things in the same boxes (sizes and weights aside). */
export function sameSplit(
  a: { items: Record<string, number> }[],
  b: { items: Record<string, number> }[],
): boolean {
  const key = (boxes: { items: Record<string, number> }[]) =>
    JSON.stringify(
      boxes.map((box) =>
        Object.entries(box.items)
          .filter(([, count]) => count > 0)
          .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
      ),
    );
  return key(a) === key(b);
}
