/**
 * A label batch: the record of one bulk run, read defensively. Pure: no
 * network, no database, safe in the browser.
 */
export type BatchOrder = {
  orderId: string;
  name: string;
  /** waiting and buying are only seen on a run that stopped part-way. */
  status: "waiting" | "buying" | "bought" | "skipped" | "unsure";
  reason: string | null;
  service: string | null;
  /** As the carrier gave it ("9.43"). */
  price: string | null;
  currency: string | null;
  /** The parcel's number here, once bought. */
  shipmentNumber: number | null;
};

const STATUSES = ["waiting", "buying", "bought", "skipped", "unsure"] as const;
const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

/** The `orders` column of `shipping_label_batches`, one entry per order in the run. */
export function parseBatchOrders(stored: unknown): BatchOrder[] {
  if (!Array.isArray(stored)) return [];
  return stored
    .filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object",
    )
    .filter((entry) => typeof entry.order_id === "string")
    .map((entry) => {
      const status = STATUSES.find((known) => known === entry.status) ?? "waiting";
      const number = Number(entry.shipment_number);
      return {
        orderId: entry.order_id as string,
        name: text(entry.name) ?? "Order",
        status,
        reason: text(entry.reason),
        service: text(entry.service),
        price: /^\d{1,9}(\.\d{1,2})?$/.test(String(entry.price ?? "")) ? String(entry.price) : null,
        currency: /^[A-Z]{3}$/.test(String(entry.currency ?? "")) ? String(entry.currency) : null,
        shipmentNumber: Number.isInteger(number) && number > 0 ? number : null,
      };
    });
}
