import { shopPhotoAddress } from "../social/product-photos";

/**
 * The customer and their orders beside a conversation. Pure: the page reads
 * what the shop sync already stored (as the signed-in member) and hands the
 * rows here. Nothing in this file talks to a shop.
 */

export const normalEmail = (value: string | null | undefined): string =>
  (value ?? "").trim().toLowerCase();

export type ShopCustomer = { external_id: string; email: string | null };

/** The shop's customer records that use this address (usually one, sometimes none). */
export function matchCustomer<T extends ShopCustomer>(email: string, customers: T[]): T[] {
  const want = normalEmail(email);
  if (!want) return [];
  return customers.filter((customer) => normalEmail(customer.email) === want);
}

export type OrderLine = {
  title: string;
  quantity: number;
  sku: string | null;
  variant_title: string | null;
  product_external_id: string | null;
};
export type OrderRow = {
  id: string;
  provider: string;
  external_id: string;
  name: string | null;
  email: string | null;
  customer_external_id: string | null;
  processed_at: string;
  total: number | string;
  currency: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  cancelled_at: string | null;
  is_test?: boolean | null;
  order_lines: OrderLine[] | null;
};

/**
 * The orders that are this person's: placed under their address, or under a
 * shop customer record that uses it. Newest first, each once, test orders out.
 */
export function ordersFor<T extends OrderRow>(
  email: string,
  customerIds: string[],
  orders: T[],
): T[] {
  const want = normalEmail(email);
  const seen = new Set<string>();
  return orders
    .filter((order) => {
      if (order.is_test) return false;
      const theirs =
        (want !== "" && normalEmail(order.email) === want) ||
        (order.customer_external_id !== null && customerIds.includes(order.customer_external_id));
      if (!theirs || seen.has(order.id)) return false;
      seen.add(order.id);
      return true;
    })
    .sort((a, b) => b.processed_at.localeCompare(a.processed_at));
}

export type Tiles = { orders: number; lifetime: number; last: number | null };

/** Orders, lifetime and last order. A cancelled order counts as an order but adds nothing to the money. */
export function customerTiles(orders: Pick<OrderRow, "total" | "cancelled_at">[]): Tiles {
  const kept = orders.filter((order) => !order.cancelled_at);
  const cents = kept.reduce((sum, order) => sum + Math.round(Number(order.total) * 100), 0);
  return {
    orders: orders.length,
    lifetime: cents / 100,
    last: orders[0] ? Number(orders[0].total) : null,
  };
}

/** "PARTIALLY_FULFILLED" → "Partially fulfilled". */
export function humanize(value: string | null | undefined): string {
  const text = (value ?? "").toLowerCase().replaceAll("_", " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}

type Tone = "open" | "waiting" | "good" | "bad" | "closed";
const PAID_TONE: Record<string, Tone> = {
  paid: "open",
  pending: "waiting",
  authorized: "waiting",
  partially_paid: "waiting",
  partially_refunded: "waiting",
  refunded: "closed",
  voided: "bad",
};
const FULFIL_TONE: Record<string, Tone> = {
  fulfilled: "good",
  unfulfilled: "waiting",
  partially_fulfilled: "waiting",
  partial: "waiting",
  scheduled: "waiting",
  in_progress: "waiting",
  on_hold: "bad",
};
const badge = (value: string | null, tones: Record<string, Tone>, fallback: string) => {
  const key = (value ?? "").toLowerCase();
  return { tone: tones[key] ?? ("closed" as Tone), label: humanize(value) || fallback };
};

export type ShipTo = {
  order_id: string;
  id: string;
  recipient: string | null;
  company: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country_code: string | null;
  phone: string | null;
  shipping_method: string | null;
  note: string | null;
  units_left: number;
  cancelled: boolean;
};
export type Parcel = {
  shipping_order_id: string | null;
  carrier: string;
  tracking_number: string;
  tracking_url: string | null;
  shipped_at: string;
  voided_at: string | null;
};
export type PhotoItem = {
  sku: string | null;
  product_external_id: string | null;
  variant_title: string | null;
  variant_image_url: string | null;
  image_url: string | null;
};

/** The address as lines, the way a label reads. The country is left off at home. */
export function addressLines(ship: ShipTo, homeCountry = "US"): string[] {
  const cityLine = [ship.city, ship.region, ship.postal_code].filter(Boolean).join(" ");
  return [
    ship.recipient,
    ship.company,
    ship.address1,
    ship.address2,
    cityLine,
    ship.country_code && ship.country_code !== homeCountry ? ship.country_code : null,
    ship.phone,
  ].filter((line): line is string => Boolean(line && line.trim()));
}

/** The photo for an order line: the item with the same SKU, else the same product and option, else the product. */
export function photoFor(line: OrderLine, items: PhotoItem[]): string | null {
  const sku = (line.sku ?? "").trim().toLowerCase();
  const bySku = sku
    ? items.find((item) => (item.sku ?? "").trim().toLowerCase() === sku)
    : undefined;
  const sameProduct = line.product_external_id
    ? items.filter((item) => item.product_external_id === line.product_external_id)
    : [];
  const byOption = sameProduct.find(
    (item) => (item.variant_title ?? "") === (line.variant_title ?? ""),
  );
  const found = bySku ?? byOption ?? sameProduct[0];
  if (!found) return null;
  // Only ever from the shop platform's image servers, and small.
  return shopPhotoAddress(found.variant_image_url ?? found.image_url, 96);
}

/**
 * Links into the shop's own admin, built from the shop name the connection
 * holds. Null unless every part is plain: nothing a customer typed gets in.
 */
export function shopLinks(
  provider: string | null,
  account: string | null,
  ids: { order?: string | null; customer?: string | null },
): { order: string | null; customer: string | null } {
  const handle = /^([a-z0-9][a-z0-9-]*)\.myshopify\.com$/.exec((account ?? "").toLowerCase())?.[1];
  if (provider !== "shopify" || !handle) return { order: null, customer: null };
  const tail = (value: string | null | undefined) => /(\d+)$/.exec(value ?? "")?.[1];
  const order = tail(ids.order);
  const customer = tail(ids.customer);
  const base = `https://admin.shopify.com/store/${handle}`;
  return {
    order: order ? `${base}/orders/${order}` : null,
    customer: customer ? `${base}/customers/${customer}` : null,
  };
}

export type OrderCard = {
  id: string;
  name: string;
  placedAt: string;
  total: number;
  currency: string | null;
  cancelled: boolean;
  paid: { tone: Tone; label: string } | null;
  fulfilment: { tone: Tone; label: string };
  lines: { title: string; variant: string | null; quantity: number; photo: string | null }[];
  tracking: { carrier: string; number: string; url: string | null }[];
  shipTo: { method: string | null; lines: string[] } | null;
  note: string | null;
  /** The order's page in Shipping, when there is still something to send. */
  toShipId: string | null;
  shopUrl: string | null;
};

/** One card per order, with what Shipping holds for it laid in. */
export function orderCards(
  orders: OrderRow[],
  shipTos: ShipTo[],
  parcels: Parcel[],
  photos: PhotoItem[],
  shop: { provider: string | null; account: string | null },
): OrderCard[] {
  return orders.map((order) => {
    const ship = shipTos.find((one) => one.order_id === order.id) ?? null;
    const sent = ship
      ? parcels.filter((parcel) => parcel.shipping_order_id === ship.id && !parcel.voided_at)
      : [];
    const address = ship ? addressLines(ship) : [];
    return {
      id: order.id,
      name: order.name ?? "Order",
      placedAt: order.processed_at,
      total: Number(order.total),
      currency: order.currency,
      cancelled: Boolean(order.cancelled_at),
      paid: order.financial_status ? badge(order.financial_status, PAID_TONE, "") : null,
      fulfilment: badge(order.fulfillment_status, FULFIL_TONE, "Unfulfilled"),
      lines: (order.order_lines ?? []).map((line) => ({
        title: line.title,
        variant: line.variant_title,
        quantity: line.quantity,
        photo: photoFor(line, photos),
      })),
      tracking: sent
        .filter((parcel) => parcel.tracking_number)
        .map((parcel) => ({
          carrier: parcel.carrier,
          number: parcel.tracking_number,
          url: parcel.tracking_url,
        })),
      shipTo: ship && address.length > 0 ? { method: ship.shipping_method, lines: address } : null,
      note: ship?.note?.trim() || null,
      toShipId:
        ship && ship.units_left > 0 && !ship.cancelled && !order.cancelled_at ? ship.id : null,
      shopUrl: shopLinks(shop.provider ?? order.provider, shop.account, {
        order: order.external_id,
      }).order,
    };
  });
}

/** The order as plain text for a reply: its name and date, what was in it, and where the parcel is. */
export function orderSummaryText(order: OrderCard, placed: string): string {
  const lines = [`Order ${order.name}, placed ${placed}:`];
  for (const line of order.lines) {
    lines.push(`• ${line.quantity} × ${line.title}${line.variant ? ` (${line.variant})` : ""}`);
  }
  lines.push(
    `Status: ${order.cancelled ? "Cancelled" : order.fulfilment.label}${order.paid && !order.cancelled ? `, ${order.paid.label.toLowerCase()}` : ""}`,
  );
  for (const parcel of order.tracking) {
    lines.push(
      `Tracking: ${parcel.carrier ? `${parcel.carrier} ` : ""}${parcel.number}${parcel.url ? ` — ${parcel.url}` : ""}`,
    );
  }
  return lines.join("\n");
}
