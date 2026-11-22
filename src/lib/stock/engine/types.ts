import type { DailySale } from "./velocity";

/** Global fallbacks when a Setting is unconfigured (docs/01 §6, docs/04). */
export const DEFAULT_LEAD_TIME_DAYS = 45;
export const DEFAULT_COVERAGE_DAYS = 30;
export const DEFAULT_REVIEW_BUFFER_DAYS = 7;

export type MoqAppliesTo = "ORDER" | "SKU";

/** Per-variant inputs to the reorder engine (docs/04). All plain data; no I/O. */
export interface ReorderInput {
  salesByDay: DailySale[]; // last 365d
  stockOnHand: number;
  onOrder: number;
  effectiveLeadTimeDays: number;
  effectiveCoverageDays: number;
  safetyStockUnits: number;
  moq: number; // supplier MOQ (1 = none)
  moqAppliesTo: MoqAppliesTo;
  reviewBufferDays: number;
  today: Date;
  // Days the item had no stock to sell (from the daily StockDaily snapshot).
  // Excluded from the velocity denominator so a stock-out doesn't read as "no
  // demand" (docs/04 §1). Optional: no history = every day counts.
  outOfStockDates?: (Date | string)[];
  // Optional 12-month seasonal multipliers (Jan..Dec), mean ≈ 1. When present,
  // demand is forecast forward across the lead+coverage window using each future
  // month's factor instead of a flat velocity. Absent/undefined = flat (legacy).
  seasonalIndex?: number[];
}

export interface ReorderResult {
  unitsPerDay: number;
  velocityPerMonth: number;
  sales30d: number;
  sales90d: number;
  isDeadStock: boolean;
  baseWindowDays: number; // 90, or 180 for sparse sellers (docs/04 §1)
  inStockDays: number; // in-stock days in that window (the denominator used)
  cappedUnits: number; // units trimmed off unusual days by the outlier cap
  forecast30d: number;
  stockOutDate: Date | null;
  reorderDate: Date | null;
  isOverdue: boolean;
  suggestedQty: number;
  moqApplied: boolean;
  explain: string;
}
