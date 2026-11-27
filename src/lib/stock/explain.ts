import type { StockSettings } from "./config";
import type { CostSource } from "./cost";
import { roundUpToCase } from "./engine";
import {
  BASE_WINDOW_DAYS,
  DEAD_STOCK_DAYS,
  RECENT_WEIGHT,
  SPARSE_WINDOW_DAYS,
} from "./engine/velocity";
import {
  NOT_PLANNED_LABELS,
  notPlannedReason,
  peakMark,
  perMonth,
  relativeDay,
  type StockRow,
} from "./plan";

/**
 * "How this is worked out" for Stock's figures: the order-by date, the
 * suggested amount, the sales rate and the cost. Plain words built only from
 * the row `buildStockRows` made and the workspace's settings, so they say
 * what the figure on screen was made from and can't drift from it. Pure, no
 * model. Each returns the lines to show; the page puts the link that changes
 * the setting beside them.
 */

const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/** Where an item's days-to-arrive come from (the same order `buildStockRows` uses). */
export function leadTimeFrom(
  row: Pick<StockRow, "item" | "supplier">,
): "item" | "supplier" | "usual" {
  if (row.item.lead_time_days !== null && row.item.lead_time_days !== undefined) return "item";
  if (row.supplier && row.supplier.lead_time_days !== null) return "supplier";
  return "usual";
}

/** Where an item's days-of-cover come from. */
export function coverFrom(row: Pick<StockRow, "item" | "supplier">): "item" | "supplier" | "usual" {
  if (row.item.coverage_days !== null && row.item.coverage_days !== undefined) return "item";
  return row.supplier ? "supplier" : "usual";
}

const fromWords = (from: "item" | "supplier" | "usual", supplier: string | undefined) =>
  from === "item"
    ? "this item's own figure"
    : from === "supplier"
      ? `${supplier ?? "the supplier"}'s figure`
      : "your usual figure under Settings → Stock";

/** Why the order-by date is the day it is. */
export function orderByExplained(
  row: StockRow,
  settings: Pick<StockSettings, "review_buffer_days" | "seasonality">,
  today: string,
): string[] {
  const { plan, item } = row;
  const left = notPlannedReason(row);
  const out: string[] = [];
  if (left) out.push(`It's left out of reordering (${NOT_PLANNED_LABELS[left].toLowerCase()}).`);
  if (plan.isDeadStock) {
    out.push(`Nothing sold in ${DEAD_STOCK_DAYS} days, so there's no order-by date.`);
    return out;
  }
  if (!plan.stockOutDate || !plan.reorderDate) {
    out.push("It isn't selling right now, so there's no order-by date.");
    return out;
  }
  const have = `the ${item.on_hand} on the shelf${row.onOrder > 0 ? ` and ${row.onOrder} on the way` : ""}`;
  out.push(
    settings.seasonality
      ? `At the rate it's expected to sell over the coming months, ${have} run${item.on_hand + row.onOrder === 1 ? "s" : ""} out ${relativeDay(plan.stockOutDate, today)}.`
      : `At the rate it sells, ${have} run${item.on_hand + row.onOrder === 1 ? "s" : ""} out ${relativeDay(plan.stockOutDate, today)}.`,
  );
  const usual = row.closure ? row.closure.movedFrom : plan.reorderDate;
  out.push(
    `Order by is that day, less the ${days(row.leadTimeDays)} it takes to arrive (${fromWords(
      leadTimeFrom(row),
      row.supplier?.name,
    )}), less your ${days(settings.review_buffer_days)} between sitting down to order: ${relativeDay(usual, today)}.`,
  );
  if (row.closure) {
    out.push(
      `${row.supplier?.name ?? "The supplier"} is shut for ${row.closure.name}, so it moved earlier, to ${relativeDay(plan.reorderDate, today)}, for the order to land first.`,
    );
  }
  if (plan.isOverdue && row.suggestedQty > 0) out.push("That day has gone by, so it's overdue.");
  return out;
}

/** How the suggested amount was reached. */
export function suggestionExplained(row: StockRow): string[] {
  const { plan, item } = row;
  if (plan.isDeadStock)
    return [`Nothing sold in ${DEAD_STOCK_DAYS} days, so nothing is suggested.`];
  const out = [
    `Enough to last the ${days(row.leadTimeDays)} it takes to arrive and ${days(row.coverageDays)} after (${fromWords(
      coverFrom(row),
      row.supplier?.name,
    )}), at the rate it sells.`,
    item.safety_stock > 0
      ? `Plus the ${item.safety_stock} you keep spare, less what's on the shelf (${item.on_hand}) and on the way (${row.onOrder}).`
      : `Less what's on the shelf (${item.on_hand}) and on the way (${row.onOrder}).`,
  ];
  if (plan.suggestedQty <= 0 && row.suggestedQty <= 0) {
    out.push("That comes to nothing, so there's nothing to order yet.");
    return out;
  }
  out.push(`That comes to ${plan.suggestedQty}.`);
  if (plan.moqApplied) out.push(`Raised to this item's smallest order, ${row.minimum}.`);
  const cased = roundUpToCase(plan.suggestedQty, row.casePack);
  if (row.casePack && cased !== plan.suggestedQty) {
    out.push(`Rounded up to whole cases of ${row.casePack}: ${cased}.`);
  }
  if (row.suggestedQty > cased) {
    out.push(
      `Raised to ${row.suggestedQty} to last while ${row.supplier?.name ?? "the supplier"} is shut.`,
    );
  }
  const peak = peakMark(row);
  if (peak) {
    out.push(
      `It's bought into a busy month (${peak}): the busiest month it has to cover sells ${row.seasonalFactor.toFixed(2)} times the usual.`,
    );
  }
  return out;
}

/** How "sells about … a month" is measured. */
export function salesRateExplained(
  row: StockRow,
  settings: Pick<StockSettings, "seasonality">,
): string[] {
  const { plan } = row;
  if (plan.isDeadStock) {
    return [`Nothing sold in the last ${DEAD_STOCK_DAYS} days, so the rate is nothing.`];
  }
  const sparse = plan.baseWindowDays === SPARSE_WINDOW_DAYS;
  const out = [
    `About ${perMonth(row)} a month (${plan.unitsPerDay.toFixed(2)} a day).`,
    `Measured over the last ${days(plan.baseWindowDays)}${
      sparse ? ` rather than ${BASE_WINDOW_DAYS}, since it sells only now and then` : ""
    }, with the last 30 days counting for ${Math.round(RECENT_WEIGHT * 100)}% of it.`,
  ];
  if (plan.cappedUnits > 0) {
    out.push(
      `${plan.cappedUnits} from unusually big days ${plan.cappedUnits === 1 ? "was" : "were"} left out, so one large order doesn't set the pace.`,
    );
  }
  if (row.soldOutDays > 0) {
    out.push(
      `${days(row.soldOutDays)} it was sold out ${row.soldOutDays === 1 ? "is" : "are"} left out, since nobody could buy it then.`,
    );
  }
  out.push(
    settings.seasonality
      ? "Busy seasons are on: the months ahead are weighed by how this item, and your shop as a whole, usually sell in them."
      : "Busy seasons are off, so every month counts the same.",
  );
  return out;
}

const COST_USED: Record<Exclude<CostSource, "none">, string> = {
  own: "your own figure",
  average: "the average of your checked-in deliveries",
  shop: "the cost in your shop",
};

/** Which cost is used, and why that one. Only for people who see costs. */
export function costExplained(row: StockRow, money: (amount: number) => string): string[] {
  const out = [
    "We use your own figure if you've typed one, then the average of what your checked-in deliveries cost, then the cost in your shop.",
  ];
  out.push(
    row.cost.source === "none"
      ? "None of those is known for this one yet, so orders count it as costing nothing."
      : `This one uses ${COST_USED[row.cost.source]}: ${money(row.unitCost)}.`,
  );
  return out;
}
