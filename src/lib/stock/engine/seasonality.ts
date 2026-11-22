/**
 * Seasonality for the reorder engine (pure, no I/O — unit-tested).
 *
 * A seasonal index is 12 monthly multipliers (Jan..Dec), mean ≈ 1.0, e.g. Nov 1.45×.
 * We build one from the store's whole sales history and one from each SKU's own
 * history, then BLEND them by how much data the SKU has (shrinkage) so steady
 * items stay ~1.0 while genuinely seasonal items get the uplift. Extreme one-off
 * months are clamped so a single spike can't distort the curve.
 *
 * The engine forecasts demand FORWARD across the lead+coverage window using these
 * multipliers, instead of a flat trailing velocity, so it orders early/enough for
 * a known peak (e.g. the pre-holiday November build).
 */

export const SEASONAL_MIN = 0.6; // clamp floor for a monthly multiplier
export const SEASONAL_MAX = 1.8; // clamp ceiling
export const SHRINK_K = 200; // units of own-history at which a SKU is ~50% self-weighted
export const SINGLE_YEAR_CONF = 0.3; // trust in a month seen in only one year
export const DISAGREE_K = 1.2; // how fast confidence falls when years disagree
export const FLAT_INDEX: number[] = Array(12).fill(1);

export interface DatedUnits {
  date: Date | string;
  unitsSold: number;
}

function toDate(d: Date | string): Date {
  return typeof d === "string" ? new Date(d) : d;
}

/**
 * Build a 12-month seasonal index from daily sales. Averages each calendar
 * month's units across the years present (resistant to one big year), clamps
 * each multiplier to [MIN, MAX], and renormalises to mean 1.0. Returns null when
 * there isn't enough coverage (fewer than `minMonths` distinct calendar months).
 */
export function monthlyIndex(sales: DatedUnits[], minMonths = 6): number[] | null {
  // Units per (year, month), and which months each year has data for.
  const totals = new Map<string, number>(); // "year-month" -> units
  const monthsByYear = new Map<number, Set<number>>();
  for (const s of sales) {
    if (s.unitsSold <= 0) continue;
    const d = toDate(s.date);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    totals.set(`${y}-${m}`, (totals.get(`${y}-${m}`) ?? 0) + s.unitsSold);
    (monthsByYear.get(y) ?? monthsByYear.set(y, new Set()).get(y)!).add(m);
  }

  // Each year's average monthly volume (over months it has), used to normalise
  // that year's months into ratios — this removes year-over-year growth/level so
  // only the within-year seasonal SHAPE is compared across years.
  const yearAvg = new Map<number, number>();
  for (const [y, months] of monthsByYear) {
    let sum = 0;
    for (const m of months) sum += totals.get(`${y}-${m}`) ?? 0;
    if (months.size > 0) yearAvg.set(y, sum / months.size);
  }

  // Per calendar month: the set of per-year seasonal ratios.
  const ratios: number[][] = Array.from({ length: 12 }, () => []);
  for (const [key, units] of totals) {
    const [ys, ms] = key.split("-");
    const y = Number(ys);
    const m = Number(ms);
    const ya = yearAvg.get(y);
    if (ya && ya > 0) ratios[m]!.push(units / ya);
  }

  const monthsWithData = ratios.filter((r) => r.length > 0).length;
  if (monthsWithData < minMonths) return null;

  // A month's multiplier = its median ratio, but shrunk toward 1.0 by how much
  // CONFIDENCE we have: months seen in only one year, or whose years disagree
  // (a one-off spike like a fluke May), are pulled back to neutral. Only a month
  // that repeats across years keeps a strong multiplier.
  const idx = Array(12).fill(1);
  for (let m = 0; m < 12; m++) {
    const r = ratios[m]!;
    if (r.length === 0) continue;
    const med = median(r);
    let conf: number;
    if (r.length === 1) {
      conf = SINGLE_YEAR_CONF;
    } else {
      const mx = Math.max(...r);
      const mn = Math.min(...r);
      const spread = mn > 0 ? mx / mn : Infinity;
      conf = clamp(1 - (spread - 1) * DISAGREE_K, 0, 1);
    }
    idx[m] = clamp(1 + (med - 1) * conf, SEASONAL_MIN, SEASONAL_MAX);
  }
  return idx;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

/**
 * Blend a SKU's own index with the store-wide index by the SKU's data volume:
 * w = skuUnits / (skuUnits + K). Thin/new SKUs lean on the store curve; high-volume
 * SKUs use their own. Falls back gracefully when either index is missing.
 */
export function blendIndex(
  skuIdx: number[] | null,
  storeIdx: number[] | null,
  skuTotalUnits: number,
  k = SHRINK_K,
): number[] {
  if (!skuIdx && !storeIdx) return FLAT_INDEX;
  if (!skuIdx) return storeIdx!;
  if (!storeIdx) return skuIdx;
  const w = skuTotalUnits / (skuTotalUnits + k);
  return skuIdx.map((s, m) => w * s + (1 - w) * storeIdx[m]!);
}

/** Multiplier for the calendar month of `d` (UTC). */
export function indexForMonth(idx: number[], d: Date): number {
  return idx[d.getUTCMonth()] ?? 1;
}

/**
 * Forecast total demand over [from, from + days) as Σ baselineDaily × index[month].
 * `baselineDaily` is the deseasonalised run-rate (see deseasonalise()).
 */
export function forecastUnits(
  baselineDaily: number,
  idx: number[],
  from: Date,
  days: number,
): number {
  let total = 0;
  const cur = new Date(from.getTime());
  for (let i = 0; i < days; i++) {
    total += baselineDaily * indexForMonth(idx, cur);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return total;
}

/** Convert an observed (in-season) daily rate to a deseasonalised baseline. */
export function deseasonalise(unitsPerDay: number, idx: number[], asOf: Date): number {
  const f = indexForMonth(idx, asOf);
  return f > 0 ? unitsPerDay / f : unitsPerDay;
}

/**
 * The date at which cumulative seasonal demand consumes `qty`, walking forward
 * from `from`. Returns `from` if qty ≤ 0, null if baselineDaily ≤ 0 (never runs out).
 */
export function seasonalRunoutDate(
  qty: number,
  baselineDaily: number,
  idx: number[],
  from: Date,
  maxDays = 3650,
): Date | null {
  if (qty <= 0) return from;
  if (baselineDaily <= 0) return null;
  let remaining = qty;
  const cur = new Date(from.getTime());
  for (let i = 0; i < maxDays; i++) {
    remaining -= baselineDaily * indexForMonth(idx, cur);
    cur.setUTCDate(cur.getUTCDate() + 1);
    if (remaining <= 0) return cur;
  }
  return null;
}
