import { differenceInCalendarDays } from "./days";

/**
 * Sales velocity (docs/04 §1). Pure function, no I/O.
 *
 * Built to resist the two ways a plain average misleads a reorder decision:
 *  - a short burst (one wholesale order, a class buying supplies) must not set
 *    the pace for the next month → long base window, capped outlier days, and
 *    only a 25% vote for the last 30 days;
 *  - a day the item was OUT of stock is not a day nobody wanted it → those days
 *    are dropped from the denominator (demand censoring).
 */
export interface DailySale {
  date: Date | string;
  unitsSold: number;
}

export interface VelocityResult {
  unitsPerDay: number;
  velocityPerMonth: number;
  sales30d: number;
  sales90d: number;
  isDeadStock: boolean;
  /** Window the base rate was measured over: 90, or 180 for sparse sellers. */
  baseWindowDays: number;
  /** In-stock days inside the base window (the denominator actually used). */
  inStockDays: number;
  /** Units removed from the window by the outlier cap (0 = nothing capped). */
  cappedUnits: number;
  /** Out-of-stock days dropped from the base window's denominator. */
  outOfStockDays: number;
}

/** Base window, and the sparse-seller threshold that widens it. */
export const BASE_WINDOW_DAYS = 90;
export const SPARSE_WINDOW_DAYS = 180;
export const SPARSE_UNITS_THRESHOLD = 10;
/** Recency: weight of the trailing-30-day rate in the blend. */
export const RECENT_WEIGHT = 0.25;
/** Outlier cap: max(P95 of window days, CAP_MULTIPLE × median sale-day). */
export const CAP_PERCENTILE = 0.95;
export const CAP_MULTIPLE = 2;
/** Dead stock: no sales at all in this many days. */
export const DEAD_STOCK_DAYS = 90;
const MIN_DENOMINATOR_DAYS = 14;

function toDate(d: Date | string): Date {
  return typeof d === "string" ? new Date(d) : d;
}

export function computeVelocity(
  sales: DailySale[],
  today: Date,
  /** Days the item had no stock to sell (from the daily snapshot); optional. */
  outOfStockDates: (Date | string)[] = [],
): VelocityResult {
  // Units per day-of-age (0 = today), summed in case a day has several rows.
  const unitsByAge = new Map<number, number>();
  let firstSaleAge = -1;
  for (const s of sales) {
    const age = differenceInCalendarDays(today, toDate(s.date));
    if (age < 0) continue; // future-dated; ignore
    unitsByAge.set(age, (unitsByAge.get(age) ?? 0) + s.unitsSold);
    if (s.unitsSold > 0 && age > firstSaleAge) firstSaleAge = age;
  }

  const sumWindow = (days: number) => {
    let n = 0;
    for (const [age, u] of unitsByAge) if (age < days) n += u;
    return n;
  };
  const sales30d = sumWindow(30);
  const sales90d = sumWindow(DEAD_STOCK_DAYS);

  if (sales90d === 0) {
    return {
      unitsPerDay: 0,
      velocityPerMonth: 0,
      sales30d,
      sales90d,
      isDeadStock: true,
      baseWindowDays: BASE_WINDOW_DAYS,
      inStockDays: 0,
      cappedUnits: 0,
      outOfStockDays: 0,
    };
  }

  // A day counts as out of stock only if the snapshot shows no stock AND nothing
  // sold — a day that sold its last unit still counts as demand.
  const oos = new Set<number>();
  for (const d of outOfStockDates) {
    const age = differenceInCalendarDays(today, toDate(d));
    if (age >= 0 && (unitsByAge.get(age) ?? 0) === 0) oos.add(age);
  }

  // Sparse sellers get the longer window so a handful of orders isn't a "rate".
  const baseWindowDays = sales90d < SPARSE_UNITS_THRESHOLD ? SPARSE_WINDOW_DAYS : BASE_WINDOW_DAYS;

  // Outlier cap, measured over the base window's in-stock days.
  const windowDays: number[] = [];
  const saleDays: number[] = [];
  for (let age = 0; age < baseWindowDays; age++) {
    if (oos.has(age)) continue;
    const u = unitsByAge.get(age) ?? 0;
    windowDays.push(u);
    if (u > 0) saleDays.push(u);
  }
  const cap = Math.max(percentile(windowDays, CAP_PERCENTILE), CAP_MULTIPLE * median(saleDays));

  const rate = (days: number) => {
    // New product: don't dilute over days before it existed — the window runs
    // from the first sale (inclusive) to today; the denominator floors at 14.
    const span = firstSaleAge >= 0 && firstSaleAge + 1 < days ? firstSaleAge + 1 : days;
    let units = 0;
    let capped = 0;
    let inStock = 0;
    let outOfStock = 0;
    for (let age = 0; age < span; age++) {
      if (oos.has(age)) {
        outOfStock++;
        continue;
      }
      inStock++;
      const u = unitsByAge.get(age) ?? 0;
      units += Math.min(u, cap);
      capped += Math.max(0, u - cap);
    }
    const denom = Math.max(MIN_DENOMINATOR_DAYS, inStock);
    return { perDay: units / denom, inStock, capped, outOfStock };
  };

  const base = rate(baseWindowDays);
  const recent = rate(30);
  const unitsPerDay = RECENT_WEIGHT * recent.perDay + (1 - RECENT_WEIGHT) * base.perDay;

  return {
    unitsPerDay,
    velocityPerMonth: unitsPerDay * 30,
    sales30d,
    sales90d,
    isDeadStock: false,
    baseWindowDays,
    inStockDays: base.inStock,
    cappedUnits: base.capped,
    outOfStockDays: base.outOfStock,
  };
}

/** Nearest-rank percentile of a list (0 for an empty list). */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
