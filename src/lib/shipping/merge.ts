import { holdState, isOpen, type QueueFacts } from "./queue";

/**
 * Ship together: orders waiting for the same person at the same address can
 * go out in one parcel on one label. Pure, so the queue, the order page and
 * the label actions all agree on what "the same address" means. The database
 * has the same rule (`private.shipping_address_key`) and checks it again
 * under a lock before any money is spent; `tests/db/shipping-merge.test.ts`
 * keeps the two in step.
 */

const WORDS: [RegExp, string][] = [
  [/\b(street)\b/g, "st"],
  [/\b(avenue)\b/g, "ave"],
  [/\b(road)\b/g, "rd"],
  [/\b(drive)\b/g, "dr"],
  [/\b(boulevard)\b/g, "blvd"],
  [/\b(lane)\b/g, "ln"],
  [/\b(court)\b/g, "ct"],
  [/\b(place)\b/g, "pl"],
  [/\b(circle)\b/g, "cir"],
  [/\b(highway)\b/g, "hwy"],
  [/\b(parkway)\b/g, "pkwy"],
  [/\b(terrace)\b/g, "ter"],
  [/\b(square)\b/g, "sq"],
  [/\b(trail)\b/g, "trl"],
  [/\b(way)\b/g, "wy"],
  [/\bnorth\b/g, "n"],
  [/\bsouth\b/g, "s"],
  [/\beast\b/g, "e"],
  [/\bwest\b/g, "w"],
  [/\b(apartment|apt|unit|suite|ste|floor|fl|number|no)\b/g, " "],
];

/** Lower case, no accents or punctuation, street words shortened, "apt" and friends dropped. */
export function norm(value: string | null | undefined): string {
  let text = String(value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.,#'’\-/]/g, " ");
  for (const [word, short] of WORDS) text = text.replace(word, short);
  return text.replace(/\s+/g, " ").trim();
}

/** Letters and digits only: "12 Oak St Apt 3" and "12 OAK ST" + "#3" read the same. */
export const squash = (value: string | null | undefined) => norm(value).replace(/[^a-z0-9]/g, "");

export type MergeAddress = {
  recipient: string | null;
  address1: string | null;
  address2: string | null;
  city?: string | null;
  region?: string | null;
  postal_code: string | null;
  country_code: string | null;
};

/**
 * Same person, same street address, same postcode and country: these can
 * share a box. Null when there is no street address. Email is never compared.
 */
export function addressKey(order: MergeAddress): string | null {
  if (!order.address1?.trim()) return null;
  const zip = String(order.postal_code ?? "")
    .replace(/\s+/g, "")
    .toUpperCase();
  const country = String(order.country_code ?? "")
    .trim()
    .toUpperCase();
  return [
    squash(order.recipient),
    // The apartment may be on the street line in one order and the second line in the other.
    squash(`${order.address1} ${order.address2 ?? ""}`),
    country === "US" || country === "" ? zip.slice(0, 5) : zip,
    country,
  ].join("|");
}

/** "Jane Doe, 12 Oak St, Apt 3, Austin TX 78701": where one order is going, on one line. */
export const addressLine = (order: MergeAddress) =>
  [
    order.recipient,
    order.address1,
    order.address2,
    [order.city, order.region, order.postal_code].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");

export type MergeItem = {
  line_id: string;
  title: string;
  variant: string | null;
  sku: string | null;
  qty: number;
  left: number;
};

/** What ship-together needs to know about an order. A `ShippingOrder` fits. */
export type MergeOrder = MergeAddress &
  Pick<
    QueueFacts,
    "units_left" | "cancelled" | "paid" | "on_hold" | "hold_until" | "pickup" | "picked_up_at"
  > & {
    id: string;
    name: string | null;
    placed_at: string;
    shipping_paid?: number | string | null;
    weight_grams?: number | string | null;
    items: MergeItem[];
  };

export const MIN_TOGETHER = 2;
export const MAX_TOGETHER = 10;

/** Oldest first; the id settles a tie so everyone agrees on which order leads. */
export const oldestFirst = <T extends { id: string; placed_at: string }>(orders: T[]): T[] =>
  [...orders].sort(
    (a, b) =>
      new Date(a.placed_at).getTime() - new Date(b.placed_at).getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

/** The same orders give the same key whatever order they were picked in. */
export const groupKey = (ids: string[]) =>
  [...new Set(ids.map((id) => id.toLowerCase()))].sort().join(",");

/** "#1042 + #1055" */
export const groupName = (orders: { name: string | null }[]) =>
  orders.map((order) => order.name ?? "Order").join(" + ");

export type GroupSummary = {
  /** `groupKey` of its orders: what "Not now" remembers. */
  key: string;
  /** Oldest first, so the first is the order the label is bought on. */
  orderIds: string[];
  names: string[];
  customer: string;
  address: string;
  /** Units still to send across every order. */
  items: number;
};

const summary = (orders: MergeOrder[]): GroupSummary => ({
  key: groupKey(orders.map((order) => order.id)),
  orderIds: orders.map((order) => order.id),
  names: orders.map((order) => order.name ?? "Order"),
  customer: orders[0].recipient ?? "",
  address: addressLine({ ...orders[0], recipient: null }),
  items: orders.reduce((sum, order) => sum + order.units_left, 0),
});

/**
 * Groups of two or more orders that could go out together, oldest first.
 * Orders on hold, for pickup, unpaid or already sent are left out; a
 * part-sent order takes part with what is left. A group someone said "Not
 * now" to stays away until another order joins that address, because the key
 * is made from the orders in it.
 */
export function mergeSuggestions(
  orders: MergeOrder[],
  dismissed: ReadonlySet<string>,
  today: string,
): GroupSummary[] {
  const groups = new Map<string, MergeOrder[]>();
  for (const order of orders) {
    if (!isOpen(order) || order.pickup || !order.paid) continue;
    if (holdState(order, today) === "held") continue;
    const key = addressKey(order);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), order]);
  }
  const out: GroupSummary[] = [];
  for (const list of groups.values()) {
    if (list.length < MIN_TOGETHER) continue;
    const group = summary(oldestFirst(list).slice(0, MAX_TOGETHER));
    if (!dismissed.has(group.key)) out.push(group);
  }
  return out;
}

export type GroupCheck =
  | { ok: true; orders: MergeOrder[] }
  | {
      ok: false;
      reason: "count" | "missing" | "closed" | "hold" | "pickup" | "no_address" | "mismatch";
      message: string;
      /** For a mismatch: where each order says it is going. */
      addresses?: { name: string; address: string }[];
    };

/**
 * Whether these orders can go out on one label: two to ten of them, each
 * with something left, none on hold or for pickup, each with an address, and
 * all reading as the same place unless someone looked and said they are
 * (`approved`). Comes back oldest first.
 */
export function checkGroup(
  ids: string[],
  found: MergeOrder[],
  approved: boolean,
  today: string,
): GroupCheck {
  const wanted = [...new Set(ids)];
  if (wanted.length < MIN_TOGETHER) {
    return { ok: false, reason: "count", message: "Pick at least two orders to ship together." };
  }
  if (wanted.length > MAX_TOGETHER) {
    return {
      ok: false,
      reason: "count",
      message: `Up to ${MAX_TOGETHER} orders can ship together.`,
    };
  }
  const byId = new Map(found.map((order) => [order.id, order]));
  if (wanted.some((id) => !byId.has(id))) {
    return { ok: false, reason: "missing", message: "We couldn't find one of those orders." };
  }
  const orders = oldestFirst(wanted.map((id) => byId.get(id)!));
  for (const order of orders) {
    const name = order.name ?? "One of these orders";
    if (!isOpen(order)) {
      return {
        ok: false,
        reason: "closed",
        message: order.cancelled
          ? `${name} was cancelled.`
          : `${name} has already been sent or collected.`,
      };
    }
    if (holdState(order, today) === "held") {
      return { ok: false, reason: "hold", message: `${name} is on hold. Release it first.` };
    }
    if (order.pickup) {
      return { ok: false, reason: "pickup", message: `${name} is an in-store pickup.` };
    }
  }
  const keys = orders.map(addressKey);
  if (keys.some((key) => key === null)) {
    return {
      ok: false,
      reason: "no_address",
      message: "One of these orders has no shipping address.",
    };
  }
  if (new Set(keys).size > 1 && !approved) {
    return {
      ok: false,
      reason: "mismatch",
      message: "These orders' addresses don't read exactly the same.",
      addresses: orders.map((order) => ({
        name: order.name ?? "Order",
        address: addressLine(order),
      })),
    };
  }
  return { ok: true, orders };
}

export type CombinedItem = MergeItem & {
  /** The order this line came from. */
  order_id: string;
  order_name: string;
  /** The line's own id on its order; `line_id` here is made unique across orders. */
  own_line_id: string;
};

const amount = (value: number | string | null | undefined) =>
  value === null || value === undefined || value === "" ? null : Number(value);

/** Cents, so sums of money never pick up a float's stray digits. */
const sumMoney = (values: (number | null)[]): number | null => {
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (known.length === 0) return null;
  return known.reduce((sum, value) => sum + Math.round(value * 100), 0) / 100;
};

/** A group line's id: its order and its own id, so two orders' "line 1" stay apart. */
export const combinedLineId = (orderId: string, lineId: string) => `${orderId}:${lineId}`;

/**
 * One order holding everything in the group: the oldest order's details
 * (address, note) with every order's lines, each tagged with where it came
 * from, and what the shopper paid for shipping added up. The weight is only
 * given when every order's is known.
 */
export function combineOrders<T extends MergeOrder>(
  orders: T[],
): Omit<T, "items" | "name" | "shipping_paid" | "weight_grams" | "units_left"> & {
  name: string;
  items: (T["items"][number] & CombinedItem)[];
  shipping_paid: number | null;
  weight_grams: number | null;
  units_left: number;
  order_ids: string[];
} {
  const sorted = oldestFirst(orders);
  const [first] = sorted;
  const weights = sorted.map((order) => amount(order.weight_grams));
  return {
    ...first,
    name: groupName(sorted),
    order_ids: sorted.map((order) => order.id),
    items: sorted.flatMap((order) =>
      order.items.map((item) => ({
        ...item,
        line_id: combinedLineId(order.id, item.line_id),
        own_line_id: item.line_id,
        order_id: order.id,
        order_name: order.name ?? "Order",
      })),
    ),
    units_left: sorted.reduce((sum, order) => sum + order.units_left, 0),
    shipping_paid: sumMoney(sorted.map((order) => amount(order.shipping_paid))),
    weight_grams: weights.every((weight) => weight !== null)
      ? weights.reduce<number>((sum, weight) => sum + (weight ?? 0), 0)
      : null,
  };
}

/** Adds up the same money field across orders; null when none of them has it. */
export const sumAmounts = (values: (number | string | null | undefined)[]) =>
  sumMoney(values.map(amount));

export type StoredGroup = {
  order_ids: string[];
  saved_at: string | null;
  dismissed_at: string | null;
  approved_at: string | null;
};

/** The keys of groups someone said "Not now" to. */
export const dismissedKeys = (groups: StoredGroup[]) =>
  new Set(groups.filter((group) => group.dismissed_at).map((group) => groupKey(group.order_ids)));

export const isApproved = (groups: StoredGroup[], ids: string[]) => {
  const key = groupKey(ids);
  return groups.some((group) => group.approved_at && groupKey(group.order_ids) === key);
};

/**
 * Groups saved to finish later that can still go: every order is still
 * waiting and they still read as one place (or were approved).
 */
export function liveSavedGroups(
  groups: StoredGroup[],
  orders: MergeOrder[],
  today: string,
): (GroupSummary & { savedAt: string })[] {
  const byId = new Map(orders.map((order) => [order.id, order]));
  const out: (GroupSummary & { savedAt: string })[] = [];
  for (const group of groups) {
    if (!group.saved_at) continue;
    const found = group.order_ids.flatMap((id) => byId.get(id) ?? []);
    const check = checkGroup(group.order_ids, found, Boolean(group.approved_at), today);
    if (check.ok) out.push({ ...summary(check.orders), savedAt: group.saved_at });
  }
  return out;
}

/**
 * The group an order is waiting in, if someone saved one or approved one
 * whose addresses differ, and it can still go. Oldest first.
 */
export function knownGroupOf(
  orderId: string,
  groups: StoredGroup[],
  orders: MergeOrder[],
  today: string,
): string[] | null {
  const byId = new Map(orders.map((order) => [order.id, order]));
  const mine = groups
    .filter((group) => (group.saved_at || group.approved_at) && group.order_ids.includes(orderId))
    // A saved group first: that is the one someone packed.
    .sort((a, b) => Number(Boolean(b.saved_at)) - Number(Boolean(a.saved_at)));
  for (const group of mine) {
    const found = group.order_ids.flatMap((id) => byId.get(id) ?? []);
    const check = checkGroup(group.order_ids, found, Boolean(group.approved_at), today);
    if (check.ok) return check.orders.map((order) => order.id);
  }
  return null;
}

/** The orders riding along on another order's label, from a page address (`?with=a,b`). */
export function parseWith(value: string | undefined, primaryId: string): string[] {
  const ids = (value ?? "")
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter((id) => /^[0-9a-f-]{36}$/.test(id) && id !== primaryId.toLowerCase());
  return [...new Set(ids)].slice(0, MAX_TOGETHER);
}

/** Where a group is opened: on its oldest order, with the rest riding along. */
export const groupHref = (base: string, orderIds: string[]) =>
  `${base}/orders/${orderIds[0]}?with=${orderIds.slice(1).join(",")}`;
