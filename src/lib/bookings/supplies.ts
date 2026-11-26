import { zonedTimeToUtc } from "./slots";

/**
 * Classroom supplies: how much is on hand, when it runs out and what to
 * order. Ported from the business's earlier booking app, made to work out
 * everything on read. Pure: nothing here is stored.
 *
 * What is stored is what a person said (counts, deliveries, corrections,
 * orders). On hand is the latest count, plus what came in and was corrected
 * since, less what each class has used since (its places × what one person
 * uses), never below nothing. A count re-anchors: from it on, only what
 * happens after it is counted, so a changed "per student" never reaches back
 * before the last count.
 */

export type Supply = {
  id: string;
  per_student: number;
  lead_time_days: number;
  safety_stock: number;
  coverage_days: number;
  active: boolean;
  /** Classes from this moment on use it up. */
  counts_from: string;
};

export type Entry = {
  supply_id: string;
  kind: "count" | "received" | "adjustment";
  qty: number;
  at: string;
};

/** A date of a workshop, with the places taken. */
export type ClassRun = {
  service_id: string;
  starts_at: string;
  seats: number;
  cancelled: boolean;
};

export type SupplyOrder = {
  supply_id: string;
  qty: number;
  /** YYYY-MM-DD on the workspace's clock. */
  expected_on: string;
  status: "open" | "received" | "cancelled";
};

/** Quantities are kept to three places, so sums don't show floating-point dust. */
const tidy = (n: number) => Math.round(n * 1000) / 1000;
const DAY = 86_400_000;

export type OnHand = {
  /** What should be on the shelf now. */
  qty: number;
  /** Used by classes since the last count. */
  used: number;
  /** What classes needed that wasn't there (stock hit nothing). */
  short: number;
  /** When the starting count was made, or null when there was none. */
  countedAt: string | null;
};

/** What is on hand now, from what was said and what classes used. */
export function onHand(
  supply: Supply,
  entries: Entry[],
  classes: ClassRun[],
  linked: Set<string>,
  now: Date,
): OnHand {
  const mine = entries
    .filter((e) => e.supply_id === supply.id && Date.parse(e.at) <= now.getTime())
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const lastCount = [...mine].reverse().find((e) => e.kind === "count") ?? null;
  const from = Math.max(
    Date.parse(supply.counts_from),
    lastCount ? Date.parse(lastCount.at) : -Infinity,
  );
  type Ev = { t: number; delta: number; use: boolean };
  const events: Ev[] = [
    ...mine
      .filter(
        (e) => e.kind !== "count" && (!lastCount || Date.parse(e.at) > Date.parse(lastCount.at)),
      )
      .map((e) => ({ t: Date.parse(e.at), delta: e.qty, use: false })),
    ...(supply.per_student > 0
      ? classes
          .filter(
            (c) =>
              !c.cancelled &&
              c.seats > 0 &&
              linked.has(c.service_id) &&
              Date.parse(c.starts_at) <= now.getTime() &&
              Date.parse(c.starts_at) >= from,
          )
          .map((c) => ({
            t: Date.parse(c.starts_at),
            delta: -c.seats * supply.per_student,
            use: true,
          }))
      : []),
  ].sort((a, b) => a.t - b.t || Number(a.use) - Number(b.use));

  let qty = lastCount ? lastCount.qty : 0;
  let used = 0;
  let short = 0;
  for (const ev of events) {
    if (ev.use) {
      const take = Math.min(-ev.delta, Math.max(qty, 0));
      used += take;
      short += -ev.delta - take;
      qty -= take;
    } else {
      qty = Math.max(0, qty + ev.delta);
    }
  }
  return { qty: tidy(qty), used: tidy(used), short: tidy(short), countedAt: lastCount?.at ?? null };
}

export type Projection =
  | { status: "ok" }
  | {
      status: "order_by" | "order_now";
      orderBy: Date;
      /** The class that would take it into the safety buffer, and by how much. */
      dipOn: Date;
      shortBy: number;
    };

/**
 * Walks the coming classes and the open orders in time order, protecting the
 * safety buffer. The first class that would dip below it is the run-out, and
 * the order-by date is the lead time before it. An order counts from the end
 * of its expected day on the workspace's clock (one arriving the day of a
 * class may land after it).
 */
export function project(
  supply: Supply,
  qtyOnHand: number,
  upcoming: ClassRun[],
  orders: SupplyOrder[],
  linked: Set<string>,
  now: Date,
  timeZone: string,
): Projection {
  if (supply.per_student <= 0 || linked.size === 0) return { status: "ok" };
  let remaining = qtyOnHand - supply.safety_stock;
  if (remaining < 0) {
    return { status: "order_now", orderBy: now, dipOn: now, shortBy: tidy(-remaining) };
  }
  type Ev = { t: number; delta: number; use: boolean };
  const events: Ev[] = [
    ...upcoming
      .filter(
        (c) => !c.cancelled && linked.has(c.service_id) && Date.parse(c.starts_at) > now.getTime(),
      )
      .map((c) => ({
        t: Date.parse(c.starts_at),
        delta: -c.seats * supply.per_student,
        use: true,
      })),
    ...orders
      .filter((o) => o.supply_id === supply.id && o.status === "open")
      .map((o) => ({
        t: (
          zonedTimeToUtc(o.expected_on, 23 * 60 + 59, timeZone) ?? new Date(o.expected_on)
        ).getTime(),
        delta: o.qty,
        use: false,
      })),
  ].sort((a, b) => a.t - b.t);
  for (const ev of events) {
    remaining += ev.delta;
    if (ev.use && remaining < 0) {
      const orderBy = new Date(ev.t - supply.lead_time_days * DAY);
      return {
        status: orderBy.getTime() <= now.getTime() ? "order_now" : "order_by",
        orderBy,
        dipOn: new Date(ev.t),
        shortBy: tidy(-remaining),
      };
    }
  }
  return { status: "ok" };
}

/** How many weeks of past classes the usual rate is read from. */
export const HISTORY_WEEKS = 8;

/** Places booked a week in the classes that use it, over the last eight weeks. */
export function weeklyRate(classes: ClassRun[], linked: Set<string>, now: Date): number {
  if (linked.size === 0) return 0;
  const since = now.getTime() - HISTORY_WEEKS * 7 * DAY;
  const seats = classes
    .filter(
      (c) =>
        !c.cancelled &&
        linked.has(c.service_id) &&
        Date.parse(c.starts_at) <= now.getTime() &&
        Date.parse(c.starts_at) > since,
    )
    .reduce((n, c) => n + c.seats, 0);
  return seats / HISTORY_WEEKS;
}

/**
 * An order that lasts through the lead time and then the supply's coverage
 * window, plus the safety buffer, less what is on hand and on its way. Whole
 * units, rounded up; nothing when there is enough.
 */
export function suggestQty(
  supply: Supply,
  rate: number,
  qtyOnHand: number,
  incoming: number,
): number {
  if (supply.per_student <= 0) return 0;
  const horizon = supply.lead_time_days + supply.coverage_days;
  const need = (rate / 7) * horizon * supply.per_student + supply.safety_stock;
  return Math.max(0, Math.ceil(tidy(need - (qtyOnHand + incoming))));
}

/**
 * Days until the order-by point at the usual rate, for when nothing booked
 * yet runs it short. Null with no rate to go on.
 */
export function estimateOrderDays(
  supply: Supply,
  rate: number,
  qtyOnHand: number,
  incoming: number,
): number | null {
  const daily = (rate / 7) * supply.per_student;
  if (supply.per_student <= 0 || daily <= 0) return null;
  return Math.floor((qtyOnHand + incoming - supply.safety_stock) / daily) - supply.lead_time_days;
}

/** "in 5 days", "today": the order-by date in words. */
export function daysWords(days: number): string {
  if (days <= 0) return "now";
  return days === 1 ? "in 1 day" : `in ${days} days`;
}
