import { addDays } from "./days";
import { computeVelocity } from "./velocity";
import { deseasonalise, forecastUnits, indexForMonth, seasonalRunoutDate } from "./seasonality";
import type { ReorderInput, ReorderResult } from "./types";

/**
 * The reorder engine (docs/04). Pure function: every derived number the UI shows
 * for a variant comes from here. Formulas are exact requirements — do not alter
 * without updating docs/04 and the tests.
 */
export function computeReorder(input: ReorderInput): ReorderResult {
  const {
    salesByDay,
    stockOnHand,
    onOrder,
    effectiveLeadTimeDays,
    effectiveCoverageDays,
    safetyStockUnits,
    moq,
    moqAppliesTo,
    reviewBufferDays,
    today,
  } = input;

  const vel = computeVelocity(salesByDay, today, input.outOfStockDates ?? []);
  const unitsPerDay = vel.unitsPerDay;
  const velMeta = {
    baseWindowDays: vel.baseWindowDays,
    inStockDays: vel.inStockDays,
    cappedUnits: vel.cappedUnits,
  };

  // Seasonality (docs/04 §7): when a 12-month index is supplied, forecast demand
  // forward across the window using each future month's factor instead of a flat
  // rate. `baselineDaily` is the deseasonalised run-rate so we don't double-count
  // the month we're currently in. Absent index → identical legacy (flat) behavior.
  const idx = input.seasonalIndex && input.seasonalIndex.length === 12 ? input.seasonalIndex : null;
  const baselineDaily =
    idx && unitsPerDay > 0 ? deseasonalise(unitsPerDay, idx, today) : unitsPerDay;
  const factorNow = idx ? indexForMonth(idx, today) : 1;

  const forecast30d = idx
    ? Math.round(forecastUnits(baselineDaily, idx, today, 30))
    : Math.round(unitsPerDay * 30);

  // Dead stock: velocity 0, no stock-out, no suggestion (docs/04 §1).
  if (vel.isDeadStock) {
    return {
      unitsPerDay: 0,
      velocityPerMonth: 0,
      sales30d: vel.sales30d,
      sales90d: vel.sales90d,
      isDeadStock: true,
      ...velMeta,
      forecast30d: 0,
      stockOutDate: null,
      reorderDate: null,
      isOverdue: false,
      suggestedQty: 0,
      moqApplied: false,
      explain: "No sales in 90 days — dead stock, no reorder suggested.",
    };
  }

  // §2 Stock-out date — how long the runway (stock + on order) lasts. Seasonal:
  // consumed at the forward seasonal rate; flat: at the current rate.
  const window = effectiveLeadTimeDays + effectiveCoverageDays;
  let stockOutDate: Date | null = null;
  if (unitsPerDay > 0) {
    if (idx) {
      stockOutDate = seasonalRunoutDate(stockOnHand + onOrder, baselineDaily, idx, today) ?? today;
    } else {
      const daysLeft = (stockOnHand + onOrder) / unitsPerDay;
      // Negative/zero cover (oversold or already out) → stock-out is now.
      stockOutDate = daysLeft <= 0 ? today : addDays(today, Math.ceil(daysLeft));
    }
  }

  // §3 Reorder date.
  const reorderDate = stockOutDate
    ? addDays(stockOutDate, -(effectiveLeadTimeDays + reviewBufferDays))
    : null;
  const isOverdue = reorderDate !== null && reorderDate < today;

  // §4 Suggested quantity — demand across the lead+coverage window (seasonal
  // forecast when an index is present, else flat).
  const demandUnits = idx ? forecastUnits(baselineDaily, idx, today, window) : unitsPerDay * window;
  const rawQty = demandUnits + safetyStockUnits - stockOnHand - onOrder;
  let suggestedQty = Math.max(0, Math.ceil(rawQty));
  let moqApplied = false;
  if (moqAppliesTo === "SKU" && suggestedQty > 0 && suggestedQty < moq) {
    suggestedQty = moq;
    moqApplied = true;
  }

  const explain = buildExplain({
    unitsPerDay,
    baselineDaily,
    factorNow,
    seasonal: idx !== null,
    effectiveLeadTimeDays,
    effectiveCoverageDays,
    demandUnits,
    safetyStockUnits,
    stockOnHand,
    onOrder,
    qtyBeforeMoq: Math.max(0, Math.ceil(rawQty)),
    moqApplied,
    finalQty: suggestedQty,
    baseWindowDays: vel.baseWindowDays,
    cappedUnits: vel.cappedUnits,
    outOfStockDays: vel.outOfStockDays,
  });

  return {
    unitsPerDay,
    velocityPerMonth: vel.velocityPerMonth,
    sales30d: vel.sales30d,
    sales90d: vel.sales90d,
    isDeadStock: false,
    ...velMeta,
    forecast30d,
    stockOutDate,
    reorderDate,
    isOverdue,
    suggestedQty,
    moqApplied,
    explain,
  };
}

/**
 * Explanation tooltip (docs/04 §6), e.g.:
 * "0.43/day × (45d lead + 30d cover) = 33 + 10 safety − 5 on hand − 0 on order = 38"
 * Because safety/onHand/onOrder are integers, ceil(demand) + those integers equals
 * ceil(demand + those) = suggestedQty, so the displayed arithmetic is exact.
 */
function buildExplain(a: {
  unitsPerDay: number;
  baselineDaily: number;
  factorNow: number;
  seasonal: boolean;
  effectiveLeadTimeDays: number;
  effectiveCoverageDays: number;
  demandUnits: number;
  safetyStockUnits: number;
  stockOnHand: number;
  onOrder: number;
  qtyBeforeMoq: number;
  moqApplied: boolean;
  finalQty: number;
  baseWindowDays: number;
  cappedUnits: number;
  outOfStockDays: number;
}): string {
  const demand = Math.ceil(a.demandUnits);
  const tail = `+ ${a.safetyStockUnits} safety − ${a.stockOnHand} on hand − ${a.onOrder} on order = ${a.qtyBeforeMoq}`;
  let s: string;
  if (a.seasonal) {
    // Forward, season-adjusted demand over the window.
    s =
      `${round2(a.baselineDaily)}/day base × season (now ${round2(a.factorNow)}×) → ` +
      `${demand} forecast over ${a.effectiveLeadTimeDays}d lead + ${a.effectiveCoverageDays}d cover ${tail}`;
  } else {
    s =
      `${round2(a.unitsPerDay)}/day × (${a.effectiveLeadTimeDays}d lead + ${a.effectiveCoverageDays}d cover) ` +
      `= ${demand} ${tail}`;
  }
  if (a.moqApplied) s += ` → MOQ ${a.finalQty}`;
  // How the rate was measured, when it differs from the plain 90-day case.
  const notes: string[] = [];
  if (a.baseWindowDays !== 90) notes.push(`rate over ${a.baseWindowDays}d (sparse seller)`);
  if (a.cappedUnits > 0) notes.push(`${a.cappedUnits} units of unusual days trimmed`);
  if (a.outOfStockDays > 0) notes.push(`${a.outOfStockDays} out-of-stock days excluded`);
  if (notes.length > 0) s += ` · ${notes.join(", ")}`;
  return s;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
