import { localDay } from "../bookings/slots";
import { signatureByRule } from "./labels";

/**
 * The to-ship queue, worked out on read. Nothing here is stored: a hold that
 * ends on a date simply stops counting once that day arrives in the
 * workspace's own time zone, so no timer has to wake anything up.
 */
export const QUEUE_VIEWS = [
  { key: "ready", label: "Ready to ship" },
  { key: "pickup", label: "In-store pickup" },
  { key: "priority", label: "Priority" },
  { key: "signature", label: "Needs signature" },
  { key: "unpaid", label: "Payment pending" },
  { key: "hold", label: "On hold" },
  { key: "international", label: "International" },
  { key: "all", label: "All open" },
] as const;
export type QueueView = (typeof QUEUE_VIEWS)[number]["key"];

export const isQueueView = (value: unknown): value is QueueView =>
  QUEUE_VIEWS.some((view) => view.key === value);

export type QueueFacts = {
  units_left: number;
  cancelled: boolean;
  paid: boolean;
  on_hold: boolean;
  /** The last day of the hold's wait, as YYYY-MM-DD; the order is back that day. */
  hold_until: string | null;
  pickup: boolean;
  pickup_ready_at: string | null;
  picked_up_at: string | null;
  shipping_method: string | null;
  country_code: string | null;
  /** What the whole order came to, when the sale is known: the signature rule looks at it. */
  order_total?: number | string | null;
  /**
   * Worked out from the workspace's shipping rules, on the lists that have
   * the whole order to hand. When set, it decides "Needs signature"; left
   * out, only the older amount setting is looked at.
   */
  needs_signature?: boolean;
};

/** Today's date where the workspace is, as YYYY-MM-DD. */
export const todayIn = (timeZone: string, now: Date) => localDay(now, timeZone);

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Calendar days, not hours: a day with a clock change is still one day. */
export function addDays(day: string, count: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + count)).toISOString().slice(0, 10);
}

/** The next given weekday (0 = Sunday) strictly after `day`. */
export function nextWeekday(day: string, weekday: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const current = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(day, (weekday - current + 7) % 7 || 7);
}

/** The quick choices offered when holding an order. `until` null means "until I release it". */
export const holdChoices = (today: string): { label: string; until: string | null }[] => [
  { label: "Tomorrow", until: addDays(today, 1) },
  { label: "Next Monday", until: nextWeekday(today, 1) },
  { label: "Until I release it", until: null },
];

/** A real calendar date after today. */
export function isHoldDate(value: string, today: string): boolean {
  if (!DAY.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const real = new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === value;
  return real && value > today;
}

/** "Mon, Nov 2" for a YYYY-MM-DD day. */
export function formatHoldDate(day: string): string {
  if (!DAY.test(day)) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${day}T12:00:00Z`));
}

/**
 * Where a hold stands today. "held": set aside. "back": its date has come, so
 * it is in the queue again and says so until someone opens or ships it.
 */
export function holdState(
  order: Pick<QueueFacts, "on_hold" | "hold_until">,
  today: string,
): "none" | "held" | "back" {
  if (!order.on_hold) return "none";
  if (order.hold_until && order.hold_until <= today) return "back";
  return "held";
}

/** Still something to do: not cancelled, not all sent, not collected. */
export const isOpen = (order: Pick<QueueFacts, "units_left" | "cancelled" | "picked_up_at">) =>
  !order.cancelled && order.units_left > 0 && !order.picked_up_at;

/** The shopper paid for speed. */
export const isPriority = (method: string | null | undefined) =>
  /next|express|priority|overnight|expedited|rush/i.test(method ?? "");

/** Going to another country than the one the workspace ships from. */
export const isInternational = (country: string | null | undefined, home: string) =>
  Boolean(country) && country!.toUpperCase() !== (home || "US").toUpperCase();

/**
 * Whether the workspace's rule asks for a signature on this order: it is
 * worth at least `signatureOver`. Never without a rule or without a total.
 */
export const needsSignature = (
  order: Pick<QueueFacts, "order_total" | "needs_signature">,
  signatureOver: number | null | undefined,
) =>
  order.needs_signature ??
  signatureByRule(
    order.order_total === null || order.order_total === undefined
      ? null
      : Number(order.order_total),
    signatureOver,
  );

/**
 * Whether an order shows under a chip. An order can sit under several.
 * `signatureOver` is the workspace's signature rule (null: it has none).
 */
export function inQueueView(
  order: QueueFacts,
  view: QueueView,
  today: string,
  homeCountry: string,
  signatureOver: number | null = null,
): boolean {
  if (!isOpen(order)) return false;
  const held = holdState(order, today) === "held";
  const ready = !held && order.paid && !order.pickup;
  switch (view) {
    case "all":
      return true;
    case "ready":
      return ready;
    case "priority":
      return ready && isPriority(order.shipping_method);
    case "signature":
      return ready && needsSignature(order, signatureOver);
    case "pickup":
      return order.pickup;
    case "unpaid":
      return !order.paid;
    case "hold":
      return held;
    case "international":
      return !order.pickup && isInternational(order.country_code, homeCountry);
  }
}

export function queueCounts(
  orders: QueueFacts[],
  today: string,
  homeCountry: string,
  signatureOver: number | null = null,
): Record<QueueView, number> {
  const counts = Object.fromEntries(QUEUE_VIEWS.map((view) => [view.key, 0])) as Record<
    QueueView,
    number
  >;
  for (const order of orders) {
    for (const view of QUEUE_VIEWS) {
      if (inQueueView(order, view.key, today, homeCountry, signatureOver)) counts[view.key] += 1;
    }
  }
  return counts;
}

/** The chips on the All orders tab. */
export const HISTORY_VIEWS = [
  { key: "all", label: "All" },
  { key: "to_ship", label: "To ship" },
  { key: "shipped", label: "Shipped" },
  { key: "cancelled", label: "Cancelled" },
] as const;
export type HistoryView = (typeof HISTORY_VIEWS)[number]["key"];
export const isHistoryView = (value: unknown): value is HistoryView =>
  HISTORY_VIEWS.some((view) => view.key === value);

export type ShipStatus = {
  key: "cancelled" | "shipped" | "picked_up" | "partial" | "hold" | "unshipped";
  label: string;
  tone: "open" | "waiting" | "good" | "bad" | "closed";
};

/** Where an order stands, in one word or two. */
export function shipStatus(
  order: Pick<
    QueueFacts,
    "units_left" | "cancelled" | "on_hold" | "hold_until" | "picked_up_at"
  > & { items: { qty: number; left: number }[] },
  today: string,
): ShipStatus {
  if (order.cancelled) return { key: "cancelled", label: "Cancelled", tone: "closed" };
  if (order.picked_up_at) return { key: "picked_up", label: "Picked up", tone: "good" };
  if (order.units_left <= 0) return { key: "shipped", label: "Shipped", tone: "good" };
  if (holdState(order, today) === "held") return { key: "hold", label: "On hold", tone: "bad" };
  if (order.items.some((item) => item.left < item.qty)) {
    return { key: "partial", label: "Partly shipped", tone: "waiting" };
  }
  return { key: "unshipped", label: "Not shipped", tone: "open" };
}

/**
 * What someone typed in the search box, made safe to put in a filter: only
 * the characters an order number, a name or an email can have.
 */
export const cleanSearch = (value: string | undefined | null) =>
  (value ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}@.#+' -]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

/** Grams as a weight a person packing would say. */
export function formatWeight(grams: number | null | undefined, imperial: boolean): string {
  if (!grams || grams <= 0) return "";
  if (imperial) {
    const ounces = Math.round(grams / 28.349523125);
    const lb = Math.floor(ounces / 16);
    const oz = ounces % 16;
    return lb > 0 ? `${lb} lb${oz ? ` ${oz} oz` : ""}` : `${Math.max(1, oz)} oz`;
  }
  return grams >= 1000 ? `${Math.round(grams / 100) / 10} kg` : `${grams} g`;
}

export type QueuePlace = {
  /** Where the order sits in the list, counting from 1; null when it isn't in it. */
  position: number | null;
  total: number;
  prev: string | null;
  next: string | null;
};

/**
 * The orders either side of one in a list sorted oldest first. An order that
 * has left the list (just sent, or put on hold) still gets its neighbours,
 * found by where it would have sat, so "next" keeps working after each parcel.
 */
export function queuePlace(
  rows: { id: string; placed_at: string }[],
  current: { id: string; placed_at: string },
): QueuePlace {
  const at = rows.findIndex((row) => row.id === current.id);
  if (at >= 0) {
    return {
      position: at + 1,
      total: rows.length,
      prev: rows[at - 1]?.id ?? null,
      next: rows[at + 1]?.id ?? null,
    };
  }
  const when = Date.parse(current.placed_at);
  const after = rows.findIndex((row) => {
    const other = Date.parse(row.placed_at);
    return other > when || (other === when && row.id > current.id);
  });
  const gap = after < 0 ? rows.length : after;
  return {
    position: null,
    total: rows.length,
    prev: rows[gap - 1]?.id ?? null,
    next: rows[gap]?.id ?? null,
  };
}
