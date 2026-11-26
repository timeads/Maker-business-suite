/**
 * The one list of every booking (Bookings → All bookings): its search and
 * filters, read from and written to the address so a view can be kept or
 * shared. Pure, so the parsing and the words are tested without a page.
 */

export const BOOKING_STATUSES = ["confirmed", "cancelled", "pending_payment"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const STATUS_NAMES: Record<BookingStatus, string> = {
  confirmed: "Booked",
  cancelled: "Cancelled",
  pending_payment: "Waiting for payment",
};

export const WHENS = ["upcoming", "past", "any"] as const;
export type When = (typeof WHENS)[number];
export const WHEN_NAMES: Record<When, string> = {
  upcoming: "Still to come",
  past: "Already happened",
  any: "Any time",
};

export const SOURCES = ["shop", "online", "manual"] as const;
export type Source = (typeof SOURCES)[number];
export const SOURCE_NAMES: Record<Source, string> = {
  shop: "From your shop",
  online: "Booked online",
  manual: "Added by you",
};

export const PAGE_SIZE = 100;

export type BookingFilters = {
  q: string;
  status: BookingStatus | null;
  when: When;
  source: Source | null;
  /** A workshop's id. */
  service: string | null;
  page: number;
};

const pick = <T extends string>(list: readonly T[], value: unknown): T | null =>
  typeof value === "string" && (list as readonly string[]).includes(value) ? (value as T) : null;

/**
 * Search words are kept to what a name, an email or an order number holds,
 * so nothing typed can change the shape of the query it goes into.
 */
export function cleanSearch(value: unknown): string {
  return (typeof value === "string" ? value : "")
    .replace(/[^\p{L}\p{N}@.\-_+# ']/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export function parseBookingFilters(
  params: Record<string, string | string[] | undefined>,
): BookingFilters {
  const one = (name: string) => {
    const value = params[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const page = Number.parseInt(one("page") ?? "1", 10);
  const service = one("service");
  return {
    q: cleanSearch(one("q")),
    status: pick(BOOKING_STATUSES, one("status")),
    when: pick(WHENS, one("when")) ?? "upcoming",
    source: pick(SOURCES, one("source")),
    service: service && /^[0-9a-f-]{36}$/i.test(service) ? service.toLowerCase() : null,
    page: Number.isFinite(page) && page >= 1 && page <= 1000 ? page : 1,
  };
}

/** The list's address with some filters changed. A change of filter starts at page 1. */
export function bookingsHref(
  base: string,
  filters: BookingFilters,
  change: Partial<BookingFilters>,
): string {
  const next = { ...filters, ...("page" in change ? {} : { page: 1 }), ...change };
  const params = new URLSearchParams();
  if (next.q) params.set("q", next.q);
  if (next.status) params.set("status", next.status);
  if (next.when !== "upcoming") params.set("when", next.when);
  if (next.source) params.set("source", next.source);
  if (next.service) params.set("service", next.service);
  if (next.page > 1) params.set("page", String(next.page));
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

/** Where a booking came from: the shop's order, our own pages, or a person. */
export function sourceOf(row: { source: string; shop_order_id: string | null }): Source {
  if (row.shop_order_id) return "shop";
  return row.source === "manual" ? "manual" : "online";
}

/** The `or` filter for a search: name, email or order number. */
export function searchFilter(q: string): string | null {
  const words = cleanSearch(q);
  if (!words) return null;
  const like = `%${words.replace(/[%_]/g, "")}%`;
  return ["customer_name", "customer_email", "shop_order_name"]
    .map((column) => `${column}.ilike.${like}`)
    .join(",");
}
