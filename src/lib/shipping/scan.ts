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
