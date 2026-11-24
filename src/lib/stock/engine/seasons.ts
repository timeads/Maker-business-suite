/**
 * Selling seasons you plan ahead for (ported from TuftStock's
 * `seasons/build-ahead.ts` with its tests; days are plain YYYY-MM-DD here).
 * For each season still to come ("in stock by Nov 15"), the last day to order
 * from each supplier so the goods are on the shelf in time:
 *
 *   order by = in stock by − days to arrive − review buffer
 *
 * A supplier whose items take different times to arrive gets one line per
 * lead time, since each wants its own order. A season can also carry a lift
 * in percent, which raises that month's demand in the reorder sums.
 * Pure: nothing here is stored.
 */
import { daysApart, shiftDay } from "./closures";

export type BuildStatus = "overdue" | "soon" | "ontrack";

export type Season = {
  id: string;
  name: string;
  /** The day the stock should be on the shelf by. */
  inStockBy: string;
  /** Extra demand to plan for that month, in percent (0 = none). */
  liftPct: number;
  note: string;
};

/** One supplier's items that share a lead time. */
export type SupplierLead = {
  supplierId: string;
  supplierName: string;
  leadDays: number;
  itemCount: number;
};

export type SupplierPlan = SupplierLead & {
  orderBy: string;
  daysUntilOrderBy: number;
  status: BuildStatus;
};

export type SeasonPlan = {
  id: string;
  name: string;
  inStockBy: string;
  daysUntil: number;
  liftPct: number;
  note: string;
  suppliers: SupplierPlan[];
};

/** Seasons still to come, soonest first, each with its order-by dates, most urgent first. */
export function computeBuildAhead(
  seasons: readonly Season[],
  suppliers: readonly SupplierLead[],
  reviewBufferDays: number,
  today: string,
  soonWindowDays = 14,
): SeasonPlan[] {
  return seasons
    .filter((season) => daysApart(today, season.inStockBy) >= 0)
    .sort((a, b) => a.inStockBy.localeCompare(b.inStockBy))
    .map((season) => ({
      id: season.id,
      name: season.name,
      inStockBy: season.inStockBy,
      daysUntil: daysApart(today, season.inStockBy),
      liftPct: season.liftPct,
      note: season.note,
      suppliers: suppliers
        .map((supplier) => {
          const orderBy = shiftDay(season.inStockBy, -(supplier.leadDays + reviewBufferDays));
          const daysUntilOrderBy = daysApart(today, orderBy);
          const status: BuildStatus =
            daysUntilOrderBy < 0
              ? "overdue"
              : daysUntilOrderBy <= soonWindowDays
                ? "soon"
                : "ontrack";
          return { ...supplier, orderBy, daysUntilOrderBy, status };
        })
        .sort((a, b) => a.daysUntilOrderBy - b.daysUntilOrderBy),
    }));
}

/**
 * Twelve multipliers, January to December, from the seasons still to come
 * that carry a lift. Multiplied into the seasonal index, so a promotion the
 * sales history can't know about still raises that month's suggestions.
 */
export function seasonLiftByMonth(seasons: readonly Season[], today: string): number[] {
  const lift: number[] = Array(12).fill(1);
  for (const season of seasons) {
    if (!season.liftPct || daysApart(today, season.inStockBy) < 0) continue;
    const month = Number(season.inStockBy.slice(5, 7)) - 1;
    if (month >= 0 && month < 12) lift[month] *= 1 + season.liftPct / 100;
  }
  return lift;
}

/** A suggestion is marked "↑1.25×" from this much above an ordinary month. */
export const PEAK_MARK_FROM = 1.15;

/**
 * The busiest month's multiplier across the days an order placed today has to
 * cover (days to arrive plus days of cover), to two places. A long-lead item
 * flags a November peak in September, while the month itself is still quiet.
 */
export function peakFactor(index: readonly number[], today: string, windowDays: number): number {
  let peak = 0;
  // Months are all that matter: step a day at a time only across month ends.
  for (let i = 0; i <= Math.max(0, windowDays); i++) {
    const month = Number(shiftDay(today, i).slice(5, 7)) - 1;
    peak = Math.max(peak, index[month] ?? 1);
  }
  return Math.round(peak * 100) / 100;
}

/** Groups a season's lines by supplier, keeping the most urgent supplier first. */
export function bySupplier(
  plans: readonly SupplierPlan[],
): { supplierId: string; supplierName: string; groups: SupplierPlan[] }[] {
  const out: { supplierId: string; supplierName: string; groups: SupplierPlan[] }[] = [];
  for (const plan of plans) {
    const found = out.find((entry) => entry.supplierId === plan.supplierId);
    if (found) found.groups.push(plan);
    else out.push({ supplierId: plan.supplierId, supplierName: plan.supplierName, groups: [plan] });
  }
  return out;
}
