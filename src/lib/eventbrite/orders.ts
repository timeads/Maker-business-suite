/**
 * Eventbrite's webhook and order payloads, read without any I/O. Ported from
 * the business's earlier booking app (`eventbrite-webhook/parse.ts`, with its
 * tests), with one change: the webhook's `api_url` is never fetched. Only the
 * order's number is taken from it, and the worker asks Eventbrite's own API
 * for that order by number.
 */

export const ORDER_ACTIONS = "order.placed,order.updated,order.refunded";

export type EventbriteHook = {
  /** The order's number, when the address is an order of Eventbrite's API. */
  orderId: string | null;
  action: string;
  /** Eventbrite's id for the webhook that called, when it says. */
  webhookId: string | null;
};

const API_HOSTS = new Set(["www.eventbriteapi.com", "eventbriteapi.com"]);
const ORDER_PATH = /^\/v3\/orders\/([0-9]{1,30})\/?$/;

/** The order's number from an `api_url`, only on Eventbrite's API host. */
export function orderIdFromApiUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !API_HOSTS.has(parsed.host.toLowerCase())) return null;
    return ORDER_PATH.exec(parsed.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The webhook's body: `{ api_url, config: { action, webhook_id, ... } }`. */
export function parseWebhookBody(body: unknown): EventbriteHook | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { api_url?: unknown; config?: { action?: unknown; webhook_id?: unknown } };
  const apiUrl = typeof b.api_url === "string" ? b.api_url : "";
  if (!apiUrl) return null;
  const action = typeof b.config?.action === "string" ? b.config.action : "";
  const hook = b.config?.webhook_id;
  const webhookId =
    (typeof hook === "string" || typeof hook === "number") && /^[0-9]{1,30}$/.test(String(hook))
      ? String(hook)
      : null;
  return { orderId: orderIdFromApiUrl(apiUrl), action, webhookId };
}

export type EventbriteAttendee = {
  id?: string;
  ticket_class_id?: string;
  status?: string;
  cancelled?: boolean;
  refunded?: boolean;
  profile?: {
    name?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
    cell_phone?: string | null;
  } | null;
};

export type EventbriteOrder = {
  id: string | number;
  event_id?: string | number | null;
  email?: string | null;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  status?: string | null;
  attendees?: EventbriteAttendee[] | null;
};

/** An attendee still takes a place unless cancelled, refunded or deleted. */
export function isLiveAttendee(a: EventbriteAttendee): boolean {
  if (a.cancelled === true || a.refunded === true) return false;
  const s = (a.status ?? "").toLowerCase();
  return s !== "deleted" && s !== "cancelled" && s !== "refunded";
}

export type BookingInput = {
  orderId: string;
  eventId: string | null;
  name: string;
  email: string;
  phone: string;
  seats: number;
};

/**
 * An order as booking details. Places are the live attendees (at least one,
 * as before). The phone is the first one an attendee gave: kept for the
 * team's reference only, since Eventbrite buyers never ticked our box for
 * texts.
 */
export function orderToBooking(order: EventbriteOrder): BookingInput {
  const attendees = Array.isArray(order.attendees) ? order.attendees : [];
  const live = attendees.filter(isLiveAttendee);
  const first = (order.first_name ?? "").trim();
  const last = (order.last_name ?? "").trim();
  const name = (order.name ?? "").trim() || `${first} ${last}`.trim() || order.email || "Guest";
  const phone = live.map((a) => a.profile?.cell_phone).find((p) => p && p.trim()) ?? "";
  return {
    orderId: String(order.id),
    eventId: order.event_id != null && order.event_id !== "" ? String(order.event_id) : null,
    name: name.slice(0, 120),
    email: (order.email ?? "").trim().toLowerCase(),
    phone: phone.trim().slice(0, 40),
    seats: Math.min(50, Math.max(1, live.length)),
  };
}

/**
 * Whether the order's places should all be given back: Eventbrite said
 * "refunded" for it, the order is refunded, deleted or cancelled, or every
 * attendee on it is.
 */
export function isReleaseOrder(order: EventbriteOrder, refunded: boolean): boolean {
  if (refunded) return true;
  const status = (order.status ?? "").toLowerCase();
  if (status === "refunded" || status === "deleted" || status === "cancelled") return true;
  const attendees = Array.isArray(order.attendees) ? order.attendees : [];
  return attendees.length > 0 && attendees.every((a) => !isLiveAttendee(a));
}
