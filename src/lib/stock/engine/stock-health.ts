/**
 * Stock health (docs/04 §8): is an item under-, well- or over-stocked? Pure,
 * measured in days of cover against the item's own lead time and coverage
 * target — the same horizon the suggested quantity plans for — so the labels
 * agree with the reorder engine instead of using a one-size-fits-all number.
 */

export type StockHealth = "out" | "under" | "healthy" | "over" | "nosales";

export interface StockHealthInput {
  stockOnHand: number;
  onOrder: number;
  unitsPerDay: number;
  isDeadStock: boolean; // no sales in 90d
  effectiveLeadTimeDays: number;
  effectiveCoverageDays: number;
  reviewBufferDays: number;
}

export interface StockHealthResult {
  health: StockHealth;
  /** Days the stock ON HAND lasts at the current rate (null when rate is 0). */
  coverDays: number | null;
  /** Days stock on hand + on order lasts (null when rate is 0). */
  runwayDays: number | null;
  /** Units above the overstock line — what a sale would need to clear. 0 unless "over". */
  excessUnits: number;
  /** One-line reason, e.g. "41 days of cover; needs 52 to bridge a reorder". */
  reason: string;
}

/** Overstock line: cover beyond this multiple of the planning horizon... */
export const OVERSTOCK_HORIZON_MULTIPLE = 2;
/** ...and never less than this many days, so slow items aren't flagged on a small stock. */
export const OVERSTOCK_MIN_DAYS = 180;

export function classifyStockHealth(i: StockHealthInput): StockHealthResult {
  const horizon = i.effectiveLeadTimeDays + i.effectiveCoverageDays;
  const bridge = i.effectiveLeadTimeDays + i.reviewBufferDays;
  const overLine = Math.max(OVERSTOCK_MIN_DAYS, OVERSTOCK_HORIZON_MULTIPLE * horizon);

  if (i.isDeadStock || i.unitsPerDay <= 0) {
    if (i.stockOnHand <= 0) {
      return {
        health: "out",
        coverDays: null,
        runwayDays: null,
        excessUnits: 0,
        reason: "No stock and no recent sales.",
      };
    }
    return {
      health: "nosales",
      coverDays: null,
      runwayDays: null,
      excessUnits: 0,
      reason: `${i.stockOnHand} on hand, no sales in 90 days.`,
    };
  }

  const coverDays = i.stockOnHand / i.unitsPerDay;
  const runwayDays = (i.stockOnHand + i.onOrder) / i.unitsPerDay;

  if (i.stockOnHand <= 0) {
    const eta = i.onOrder > 0 ? ` ${i.onOrder} on order.` : "";
    return {
      health: "out",
      coverDays: 0,
      runwayDays,
      excessUnits: 0,
      reason: `Out of stock.${eta}`,
    };
  }

  // Understocked: what's on hand plus what's already coming won't last until a
  // new order could arrive (lead time + review buffer) — i.e. the reorder date
  // has passed. Same rule as the Reorders page (docs/04 §3), so the two agree.
  // Safety stock is a quantity matter (it's in the suggested qty), not a timing one.
  if (runwayDays < bridge) {
    const have = Math.floor(runwayDays);
    const basis = i.onOrder > 0 ? `${have} days incl. on-order` : `${have} days of cover`;
    return {
      health: "under",
      coverDays,
      runwayDays,
      excessUnits: 0,
      reason: `${basis}; a new order takes ${bridge} (${i.effectiveLeadTimeDays}d lead + ${i.reviewBufferDays}d review) — reorder is overdue.`,
    };
  }

  if (coverDays > overLine) {
    const excess = Math.max(0, Math.floor(i.stockOnHand - i.unitsPerDay * overLine));
    return {
      health: "over",
      coverDays,
      runwayDays,
      excessUnits: excess,
      reason: `${Math.round(coverDays)} days of cover on hand — ${excess} units beyond ${overLine} days.`,
    };
  }

  return {
    health: "healthy",
    coverDays,
    runwayDays,
    excessUnits: 0,
    reason: `${Math.round(coverDays)} days of cover on hand (target ${horizon}).`,
  };
}
