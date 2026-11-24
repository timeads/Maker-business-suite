import { Money } from "./balance/money";

/**
 * What one unit of an item costs, and where that figure comes from. The same
 * order TuftStock uses (its `resolveAvgCost`): your own figure if you typed
 * one, else the average of what checked-in deliveries really cost, else the
 * shop's cost. All of it in whole cents; nothing here is stored.
 */

export type CostSource = "own" | "average" | "shop" | "none";

/** Units checked in across every order for one item, and what they cost in all. */
export type ReceivedCost = { units: number; total: Money.Value };

export type ItemCost = {
  cost: Money;
  source: CostSource;
  /** Each figure on its own, for showing side by side; null when there isn't one. */
  own: Money | null;
  average: Money | null;
  shop: Money | null;
};

export const COST_SOURCE_LABELS: Record<CostSource, string> = {
  own: "your own figure",
  average: "average of your deliveries",
  shop: "from your shop",
  none: "not set",
};

const fromCents = (cents: number) =>
  new Money(`${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`);

const amount = (value: Money.Value | null | undefined): Money | null => {
  if (value === null || value === undefined || value === "") return null;
  try {
    const money = new Money(value);
    return money.isNegative() ? null : money;
  } catch {
    return null;
  }
};

/**
 * The average cost of a unit over everything checked in: each line's cost
 * weighted by how many of it arrived. Whole cents, half a cent rounds up.
 * Null when nothing has been checked in.
 */
export function averageCost(received: ReceivedCost | null | undefined): Money | null {
  if (!received || !Number.isInteger(received.units) || received.units <= 0) return null;
  const total = amount(received.total);
  if (!total) return null;
  const whole = Math.floor(total.cents / received.units);
  const left = total.cents - whole * received.units;
  return fromCents(left * 2 >= received.units ? whole + 1 : whole);
}

/** Adds up lines by hand (cost × units arrived), for when there's no database sum. */
export function receivedFromLines(
  lines: readonly { qtyReceived: number; unitCost: Money.Value }[],
): ReceivedCost | null {
  let units = 0;
  let cents = 0;
  for (const line of lines) {
    if (!(line.qtyReceived > 0)) continue;
    units += line.qtyReceived;
    cents += new Money(line.unitCost).cents * line.qtyReceived;
  }
  return units > 0 ? { units, total: fromCents(cents) } : null;
}

export function resolveCost(input: {
  ownCost: Money.Value | null | undefined;
  received: ReceivedCost | null | undefined;
  shopCost: Money.Value | null | undefined;
}): ItemCost {
  const own = amount(input.ownCost);
  const average = averageCost(input.received);
  const shop = amount(input.shopCost);
  const parts = { own, average, shop };
  if (own) return { cost: own, source: "own", ...parts };
  if (average) return { cost: average, source: "average", ...parts };
  if (shop) return { cost: shop, source: "shop", ...parts };
  return { cost: new Money(0), source: "none", ...parts };
}
