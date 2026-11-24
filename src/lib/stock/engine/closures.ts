/**
 * Supplier closures: stretches when a supplier is shut (a factory's month off
 * at Spring Festival, say) and what they do to ordering.
 *
 * The rule is the owner's: an order's lead time must not run through a
 * closure. An order placed on day D with a lead time of L days is "in the
 * works" from D to D + L, both ends included, and none of those days may fall
 * inside a closure. So an order either lands before the supplier shuts or is
 * placed after they reopen; it is never counted on to be made while they are
 * away.
 *
 * Pure, and all in plain calendar days ("2027-01-25"): no clock, no time of
 * day and no timezone in here. Callers hand in the workspace's own "today".
 * Nothing worked out here is stored.
 *
 * Sizing an order to sit out a closure follows TuftStock's build-ahead
 * (src/lib/seasons/build-ahead.ts): work back from the day the goods must be
 * in (target − lead time). Here the target is the day before the supplier
 * shuts, and the order must then last until the first order after they reopen
 * could arrive: the closure plus one more lead time.
 */

export type Closure = {
  id?: string;
  name: string;
  /** First and last day shut, both included. */
  startsOn: string;
  endsOn: string;
};

const DAY = 86_400_000;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar day as a whole number of days, or null when it isn't a real day. */
export function dayNumber(day: string): number | null {
  const match = ISO.exec(day);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = Date.UTC(y, m - 1, d);
  const back = new Date(time);
  // "2027-02-30" would quietly roll over into March: not a day.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return Math.round(time / DAY);
}

export function dayFromNumber(n: number): string {
  return new Date(n * DAY).toISOString().slice(0, 10);
}

/** `day` moved by a number of days (negative goes back). */
export function shiftDay(day: string, days: number): string {
  const n = dayNumber(day);
  return n === null ? day : dayFromNumber(n + Math.trunc(days));
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysApart(from: string, to: string): number {
  const a = dayNumber(from);
  const b = dayNumber(to);
  return a === null || b === null ? 0 : b - a;
}

/** One unbroken stretch shut: closures that overlap or sit back to back, joined. */
export type ClosedSpan = {
  start: number;
  end: number;
  startsOn: string;
  endsOn: string;
  /** "Spring Festival", or "Spring Festival and Stocktake" when two were joined. */
  name: string;
  closures: Closure[];
};

/**
 * The closures as unbroken stretches, earliest first. Two that overlap, or
 * where one starts the day after the other ends, are one stretch: there is no
 * day between them to place an order on. A closure with dates that make no
 * sense (not real days, or ending before it starts) is left out.
 */
export function closedSpans(closures: readonly Closure[]): ClosedSpan[] {
  const real = closures
    .map((closure) => ({
      closure,
      start: dayNumber(closure.startsOn),
      end: dayNumber(closure.endsOn),
    }))
    .filter(
      (c): c is { closure: Closure; start: number; end: number } =>
        c.start !== null && c.end !== null && c.end >= c.start,
    )
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const spans: { start: number; end: number; closures: Closure[] }[] = [];
  for (const c of real) {
    const last = spans.at(-1);
    if (last && c.start <= last.end + 1) {
      last.end = Math.max(last.end, c.end);
      last.closures.push(c.closure);
    } else {
      spans.push({ start: c.start, end: c.end, closures: [c.closure] });
    }
  }
  return spans.map((span) => ({
    ...span,
    startsOn: dayFromNumber(span.start),
    endsOn: dayFromNumber(span.end),
    name: joinNames(span.closures.map((c) => c.name.trim()).filter(Boolean)),
  }));
}

function joinNames(names: string[]): string {
  const unique = [...new Set(names)];
  if (unique.length === 0) return "a closure";
  if (unique.length === 1) return unique[0];
  return `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`;
}

const lead = (days: number) => Math.max(0, Math.trunc(Number.isFinite(days) ? days : 0));

/** The stretch the supplier is shut on `day`, if they are. */
export function closedOn(day: string, closures: readonly Closure[]): ClosedSpan | null {
  const n = dayNumber(day);
  if (n === null) return null;
  return closedSpans(closures).find((span) => span.start <= n && n <= span.end) ?? null;
}

export type OrderDay = {
  /** The last day the order can be placed. */
  orderBy: string;
  /** The day it would then arrive: orderBy + lead time. */
  arrives: string;
  /**
   * The closure that moved the day earlier (the earliest one, when a lead
   * time too long for the gap between two pushed it past both). Null when no
   * closure was in the way.
   */
  closure: ClosedSpan | null;
  /** How many days earlier than "needBy − lead time" the order has to go. */
  daysEarlier: number;
};

/**
 * The last day to place an order that must have arrived by `needBy`, when it
 * takes `leadDays` to arrive and may not be in the works on any closed day.
 *
 * With nothing in the way that is simply needBy − leadDays. If that order
 * would run into a closure it has to land before the supplier shuts: the day
 * before the closure starts, less the lead time. If *that* runs into an
 * earlier closure (the gap between the two is shorter than the lead time),
 * it moves before the earlier one too, and so on.
 */
export function latestOrderDay(input: {
  needBy: string;
  leadDays: number;
  closures: readonly Closure[];
}): OrderDay {
  const need = dayNumber(input.needBy);
  const days = lead(input.leadDays);
  if (need === null) {
    return { orderBy: input.needBy, arrives: input.needBy, closure: null, daysEarlier: 0 };
  }
  const plain = need - days;
  let order = plain;
  let blocker: ClosedSpan | null = null;
  // Latest closure first: moving the order earlier can only meet earlier ones.
  for (const span of closedSpans(input.closures).reverse()) {
    if (span.end >= order && span.start <= order + days) {
      order = span.start - 1 - days;
      blocker = span;
    }
  }
  return {
    orderBy: dayFromNumber(order),
    arrives: dayFromNumber(order + days),
    closure: blocker,
    daysEarlier: plain - order,
  };
}

export type Arrival = {
  /** The day the order really gets going: `orderDay`, or the day they reopen. */
  startsOn: string;
  arrives: string;
  /** The closure it has to wait out (the last one, when there are several). */
  closure: ClosedSpan | null;
};

/**
 * When an order placed on `orderDay` can be counted on to arrive. If its lead
 * time would run through a closure, it is counted from the day the supplier
 * reopens instead (and again, should that run into the next closure).
 */
export function earliestArrival(input: {
  orderDay: string;
  leadDays: number;
  closures: readonly Closure[];
}): Arrival {
  const start = dayNumber(input.orderDay);
  const days = lead(input.leadDays);
  if (start === null) return { startsOn: input.orderDay, arrives: input.orderDay, closure: null };
  let order = start;
  let waited: ClosedSpan | null = null;
  for (const span of closedSpans(input.closures)) {
    if (span.end >= order && span.start <= order + days) {
      order = span.end + 1;
      waited = span;
    }
  }
  return {
    startsOn: dayFromNumber(order),
    arrives: dayFromNumber(order + days),
    closure: waited,
  };
}

/** The next stretch shut that hasn't started yet on `today`. */
export function nextClosure(today: string, closures: readonly Closure[]): ClosedSpan | null {
  const n = dayNumber(today);
  if (n === null) return null;
  return closedSpans(closures).find((span) => span.start > n) ?? null;
}

export type BuildAhead = {
  closure: ClosedSpan;
  /** The last day to place the order that lands before they shut. */
  orderBefore: string;
  /** That day has gone by: an order placed now can't land before they shut. */
  missed: boolean;
  /** When the first order placed after they reopen could arrive. */
  nextArrival: string;
  /**
   * How many days of sales, counted from today, the order has to see the
   * shelf through: up to that next arrival. This is "the closure plus the
   * lead time", with whatever is left of the run-up to it.
   */
  daysToCover: number;
};

/**
 * What ordering ahead of the next closure involves, for something that takes
 * `leadDays` to arrive: the last day to order, and how long the order must
 * last. Null when no closure is coming.
 */
export function planBuildAhead(input: {
  today: string;
  leadDays: number;
  closures: readonly Closure[];
}): BuildAhead | null {
  const today = dayNumber(input.today);
  const closure = nextClosure(input.today, input.closures);
  if (today === null || !closure) return null;
  const days = lead(input.leadDays);
  // In before they shut: arrived by the day before the closure starts.
  const before = latestOrderDay({
    needBy: dayFromNumber(closure.start - 1),
    leadDays: days,
    closures: input.closures,
  });
  // The first order after they reopen (later still, if that runs into another closure).
  const after = earliestArrival({
    orderDay: dayFromNumber(closure.end + 1),
    leadDays: days,
    closures: input.closures,
  });
  const order = dayNumber(before.orderBy)!;
  return {
    closure,
    orderBefore: before.orderBy,
    missed: order < today,
    nextArrival: after.arrives,
    daysToCover: Math.max(0, dayNumber(after.arrives)! - today),
  };
}
