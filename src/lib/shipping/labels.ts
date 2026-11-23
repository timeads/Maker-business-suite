import type { ShippingSettings } from "./config";
import {
  MAX_BOXES,
  lbOzToTenthOz,
  normalizePhone,
  type LabelAddress,
  type LabelParcel,
  type LabelRate,
} from "./easypost";

/**
 * What sits between an order and a label request: the two addresses, the box
 * and its weight, each checked, with a plain sentence when something is
 * missing. No network, no database.
 */

/** The heaviest parcel the common carriers take: 150 lb. */
export const MAX_TENTH_OZ = 150 * 160;

export type SavedBox = {
  id: string;
  name: string;
  kind: "box" | "envelope" | "soft";
  length_in: number | string;
  width_in: number | string;
  height_in: number | string;
  empty_weight_oz: number | string;
  is_default: boolean;
};

export const BOX_KINDS = [
  { key: "box", label: "Box" },
  { key: "envelope", label: "Envelope" },
  { key: "soft", label: "Soft pack" },
] as const;

/** "12 × 9 × 4 in" */
export const boxSize = (box: Pick<SavedBox, "length_in" | "width_in" | "height_in">) =>
  `${Number(box.length_in)} × ${Number(box.width_in)} × ${Number(box.height_in)} in`;

/** Inches as typed: up to 108, two decimal places at most. Null when it isn't that. */
export function parseInches(value: string): number | null {
  const text = value.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return null;
  const inches = Number(text);
  return inches > 0 && inches <= 108 ? inches : null;
}

/** Ounces as typed, for a box's own weight: 0 to 2,400, two decimals at most. */
export function parseOunces(value: string): number | null {
  const text = value.trim();
  if (text === "") return 0;
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(text)) return null;
  const ounces = Number(text);
  return ounces <= 2400 ? ounces : null;
}

/** A box's empty weight (ounces, as stored) in tenths of an ounce. */
export function boxTenthOz(box: Pick<SavedBox, "empty_weight_oz">): number {
  const match = /^(\d+)(?:\.(\d))?/.exec(String(box.empty_weight_oz));
  return match ? Number(match[1]) * 10 + Number(match[2] ?? "0") : 0;
}

export type ParcelInput = {
  /** A saved box, or null for a size typed in. */
  box: Pick<SavedBox, "length_in" | "width_in" | "height_in"> | null;
  length: string;
  width: string;
  height: string;
  weightLb: string;
  weightOz: string;
};

/** The box and weight to quote, or what's wrong with them. */
export function parcelFrom(input: ParcelInput): { parcel: LabelParcel } | { error: string } {
  const size = input.box
    ? {
        length: Number(input.box.length_in),
        width: Number(input.box.width_in),
        height: Number(input.box.height_in),
      }
    : {
        length: parseInches(input.length),
        width: parseInches(input.width),
        height: parseInches(input.height),
      };
  if (!(size.length && size.width && size.height)) {
    return { error: "Give the box's length, width and height in inches (up to 108 each)." };
  }
  const weightTenthOz = lbOzToTenthOz(input.weightLb, input.weightOz);
  if (weightTenthOz === null) {
    return { error: "The weight should be numbers, like 2 lb 4 oz." };
  }
  if (weightTenthOz <= 0) return { error: "Say what the packed box weighs." };
  if (weightTenthOz > MAX_TENTH_OZ) {
    return { error: "That's over 150 lb, which is more than these carriers take in one box." };
  }
  return {
    parcel: { length: size.length, width: size.width, height: size.height, weightTenthOz },
  };
}

/**
 * Every box of one purchase, or what's wrong with the first that isn't
 * right. One to six boxes, and no more than 150 lb between them.
 */
export function parcelsFrom(inputs: ParcelInput[]): { parcels: LabelParcel[] } | { error: string } {
  if (inputs.length < 1) return { error: "Add a box first." };
  if (inputs.length > MAX_BOXES) {
    return { error: `One label purchase covers up to ${MAX_BOXES} boxes.` };
  }
  const parcels: LabelParcel[] = [];
  for (const [index, input] of inputs.entries()) {
    const parsed = parcelFrom(input);
    if ("error" in parsed) {
      return { error: inputs.length > 1 ? `Box ${index + 1}: ${parsed.error}` : parsed.error };
    }
    parcels.push(parsed.parcel);
  }
  if (parcels.reduce((sum, parcel) => sum + parcel.weightTenthOz, 0) > MAX_TENTH_OZ) {
    return {
      error: "Together these boxes are over 150 lb, which is more than one purchase takes.",
    };
  }
  return { parcels };
}

/**
 * What's missing from the ship-from address before a carrier will quote, in
 * the words used on the settings page. Empty means it's ready.
 */
export function missingShipFrom(settings: ShippingSettings): string[] {
  const from = settings.ship_from;
  const country = settings.ship_from_country;
  const missing: string[] = [];
  if (!from.name) missing.push("your name or business");
  if (!from.address1) missing.push("street address");
  if (!from.city) missing.push("town or city");
  if (!from.region && ["US", "CA", "AU"].includes(country)) missing.push("state");
  if (!from.postal_code) missing.push("ZIP or postcode");
  if (normalizePhone(from.phone, country).length < 7) missing.push("phone number");
  return missing;
}

/** The ship-from address as a carrier wants it. Call `missingShipFrom` first. */
export function shipFromAddress(settings: ShippingSettings): LabelAddress {
  const from = settings.ship_from;
  return {
    name: from.name,
    street1: from.address1,
    street2: from.address2 || undefined,
    city: from.city,
    state: from.region || undefined,
    zip: from.postal_code,
    country: settings.ship_from_country,
    phone: from.phone,
  };
}

export type LabelOrder = {
  recipient: string | null;
  company: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country_code: string | null;
  phone: string | null;
};

/** Whether the order's address is whole enough to put on a label. */
export function missingShipTo(order: LabelOrder): string[] {
  const missing: string[] = [];
  if (!order.recipient && !order.company) missing.push("a name");
  if (!order.address1) missing.push("a street address");
  if (!order.city) missing.push("a town or city");
  if (!order.postal_code) missing.push("a ZIP or postcode");
  return missing;
}

export function shipToAddress(order: LabelOrder, homeCountry: string): LabelAddress {
  return {
    name: order.recipient ?? "",
    company: order.company || undefined,
    street1: order.address1 ?? "",
    street2: order.address2 || undefined,
    city: order.city ?? "",
    state: order.region || undefined,
    zip: order.postal_code ?? "",
    country: (order.country_code || homeCountry).toUpperCase(),
    phone: order.phone || undefined,
  };
}

/** The address boxes a person can change for one label, as typed. */
export type ShipToEdit = {
  recipient: string;
  company: string;
  phone: string;
  address1: string;
  address2: string;
  city: string;
  region: string;
  postal_code: string;
};

const SHIP_TO_LIMITS: Record<keyof ShipToEdit, number> = {
  recipient: 120,
  company: 120,
  phone: 30,
  address1: 120,
  address2: 120,
  city: 120,
  region: 60,
  postal_code: 20,
};

export const shipToEdit = (order: LabelOrder): ShipToEdit => ({
  recipient: order.recipient ?? "",
  company: order.company ?? "",
  phone: order.phone ?? "",
  address1: order.address1 ?? "",
  address2: order.address2 ?? "",
  city: order.city ?? "",
  region: order.region ?? "",
  postal_code: order.postal_code ?? "",
});

/**
 * The order's address with one label's changes laid over it. The country is
 * always the order's own: a label to somewhere else is a different job.
 * Null when what was typed isn't an address (too long, or not text).
 */
export function withShipToEdit(order: LabelOrder, edit: unknown): LabelOrder | null {
  if (edit === undefined || edit === null) return order;
  if (typeof edit !== "object") return null;
  const typed = edit as Record<string, unknown>;
  const out = { ...order };
  for (const field of Object.keys(SHIP_TO_LIMITS) as (keyof ShipToEdit)[]) {
    const value = typed[field];
    if (typeof value !== "string") return null;
    const clean = value.replace(/\s+/g, " ").trim();
    if (clean.length > SHIP_TO_LIMITS[field]) return null;
    out[field] = clean || null;
  }
  return out;
}

/** Whether an order's value alone calls for a signature, by the workspace's rule. */
export const signatureByRule = (
  orderTotal: number | null | undefined,
  over: number | null | undefined,
): boolean =>
  over !== null &&
  over !== undefined &&
  orderTotal !== null &&
  orderTotal !== undefined &&
  Number.isFinite(Number(orderTotal)) &&
  Number(orderTotal) >= over;

/** What the browser is shown of a rate. */
export type RateChoice = Pick<LabelRate, "id" | "carrier" | "name" | "price" | "currency" | "days">;

export const rateChoice = (rate: LabelRate): RateChoice => ({
  id: rate.id,
  carrier: rate.carrier,
  name: rate.name,
  price: rate.price,
  currency: rate.currency,
  days: rate.days,
});

/** "2 days", "1 day", or nothing when the carrier doesn't say. */
export const deliveryDays = (days: number | null) =>
  days === null ? "" : days === 1 ? "1 day" : `${days} days`;

/** One box of a bought label, as the page shows it. */
export type LabelBox = {
  /** The source's id for this box: what a refund is asked for by. */
  shipmentId: string;
  trackingNumber: string;
  trackingUrl: string | null;
  labelUrl: string | null;
};

const httpsLink = (value: unknown) =>
  typeof value === "string" && value.startsWith("https://") ? value : null;

/** Where a label we keep the file of is opened from. */
export const LABEL_FILE_PATH = "/api/shipping/label-file";
const fileLink = (value: unknown) =>
  typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value)
    ? `${LABEL_FILE_PATH}/${value}`
    : null;

/**
 * The boxes kept with a bought label (`label_parcels` on a parcel, `parcels`
 * on a label still to finish), read defensively. Empty for a parcel recorded
 * by hand or from before boxes were kept one by one.
 */
export function labelBoxes(stored: unknown): LabelBox[] {
  if (!Array.isArray(stored)) return [];
  return stored
    .filter((box): box is Record<string, unknown> => Boolean(box) && typeof box === "object")
    .map((box) => ({
      shipmentId: typeof box.shipment_id === "string" ? box.shipment_id : "",
      trackingNumber: typeof box.tracking_number === "string" ? box.tracking_number : "",
      trackingUrl: httpsLink(box.tracking_url),
      // Our own copy of the label when we have one (UPS, Redo), else the carrier's link.
      labelUrl: fileLink(box.label_file) ?? httpsLink(box.label_url),
    }));
}

/**
 * What to show for a parcel or a label: every box when they were kept, else
 * the single tracking number and label link the row has always carried.
 */
export function shownBoxes(row: {
  tracking_number?: string | null;
  tracking_url?: string | null;
  label_url?: string | null;
  boxes?: unknown;
}): LabelBox[] {
  const boxes = labelBoxes(row.boxes);
  if (boxes.length > 0) return boxes;
  return [
    {
      shipmentId: "",
      trackingNumber: row.tracking_number ?? "",
      // A link typed in by hand is shown as it always was.
      trackingUrl: row.tracking_url || null,
      labelUrl: httpsLink(row.label_url),
    },
  ];
}
