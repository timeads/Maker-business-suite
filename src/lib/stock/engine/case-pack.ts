/**
 * Ordering by the case. An item with a case pack (say 36 cones to a case) is
 * bought in whole cases, so a suggested quantity is rounded UP to the next
 * full case: never down, which would leave the shelf short.
 *
 * TuftStock keeps a case pack per item and lets an order line be typed in
 * cases or units (`casesFor`, and a new line starting at one full case); the
 * rounding of suggestions is this app's own addition on top of that.
 */

/** A usable case pack: a whole number above one. Anything else means "single units". */
export function casePackOf(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 1 ? value : null;
}

/** `qty` raised to the next whole case. Zero stays zero; no case pack leaves it alone. */
export function roundUpToCase(qty: number, casePack: number | null | undefined): number {
  const pack = casePackOf(casePack);
  if (!pack || qty <= 0) return Math.max(0, qty);
  return Math.ceil(qty / pack) * pack;
}

/** How many cases `units` is: whole when it divides evenly, else to two decimals. */
export function casesFor(units: number, pack: number): number {
  const c = units / pack;
  return Number.isInteger(c) ? c : Math.round(c * 100) / 100;
}

/** "2 cases of 36", "1 case of 12", or "1.5 cases of 36" for a part case. Null without a case pack. */
export function caseLabel(units: number, casePack: number | null | undefined): string | null {
  const pack = casePackOf(casePack);
  if (!pack || units <= 0) return null;
  const cases = casesFor(units, pack);
  return `${cases} case${cases === 1 ? "" : "s"} of ${pack}`;
}

/**
 * Where a hand-added line starts when the engine suggests nothing: one full
 * case if the item has a case pack, else one unit (as TuftStock's order
 * editor does), and never below the item's smallest order.
 */
export function startingQty(
  suggestedQty: number,
  casePack: number | null | undefined,
  minimum = 1,
): number {
  if (suggestedQty > 0) return suggestedQty;
  return roundUpToCase(Math.max(1, minimum), casePack);
}
