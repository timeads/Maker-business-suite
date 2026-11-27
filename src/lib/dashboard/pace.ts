/**
 * Small month figures for Money's first card, the earlier dashboard's rules
 * on whole cents. Pure.
 *
 * - Break-even pace: this month's revenue so far, run on to the month's end
 *   at the same rate, against last month's running costs in the books
 *   ("on pace" or "short by").
 * - The same point last month: sales over this month's days so far against
 *   last month's same days (shorter when last month was).
 * - Shipping margin by month: what shoppers paid for shipping against what
 *   the parcels cost.
 */

export type Pace = {
  /** Revenue so far run on to the month's end, whole cents. */
  projected: number;
  /** Last month's running costs in the books, whole cents. */
  target: number;
  onPace: boolean;
  /** How far short the month is on its pace (0 when on pace). */
  short: number;
};

/** Null without a target to measure against. `day` counts today. */
export function breakEvenPace(input: {
  revenue: number;
  day: number;
  daysInMonth: number;
  target: number | null;
}): Pace | null {
  if (input.target === null || input.target <= 0 || input.day <= 0) return null;
  const projected = Math.round(
    (input.revenue * input.daysInMonth) / Math.min(input.day, input.daysInMonth),
  );
  return {
    projected,
    target: input.target,
    onPace: projected >= input.target,
    short: Math.max(0, input.target - projected),
  };
}

/**
 * Last month's same days as this month's so far, as plain days: from the
 * first of last month up to (not including) the day after the same day
 * number, or the end of last month when it was shorter.
 */
export function sameDaysLastMonth(today: { year: number; month: number; day: number }): {
  from: { year: number; month: number; day: number };
  to: { year: number; month: number; day: number };
} {
  const first = new Date(Date.UTC(today.year, today.month - 2, 1));
  const days = new Date(Date.UTC(today.year, today.month - 1, 0)).getUTCDate();
  const end = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(today.day, days) + 1),
  );
  const plain = (d: Date) => ({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  });
  return { from: plain(first), to: plain(end) };
}

/** This month so far against the same point last month; null without last month. */
export const againstLastMonth = (now: number, before: number) =>
  before > 0 ? (now - before) / before : null;

export type ShippingMonth = {
  month: string;
  orders: number;
  /** What shoppers paid for shipping. */
  collected: number;
  /** What the parcels cost in postage. */
  cost: number;
  net: number;
  /** Net ÷ what shoppers paid; null when they paid nothing. */
  share: number | null;
  /** Orders with no postage cost noted (labels bought elsewhere, say). */
  uncosted: number;
};

export function shippingMonths(
  rows: readonly {
    month: string;
    orders: number;
    collected_cents: number;
    cost_cents: number;
    costed: number;
  }[],
): ShippingMonth[] {
  return rows.map((r) => ({
    month: r.month.slice(0, 7),
    orders: r.orders,
    collected: r.collected_cents,
    cost: r.cost_cents,
    net: r.collected_cents - r.cost_cents,
    share: r.collected_cents > 0 ? (r.collected_cents - r.cost_cents) / r.collected_cents : null,
    uncosted: r.orders - r.costed,
  }));
}
