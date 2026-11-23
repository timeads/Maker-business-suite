import type { ShippingSettings } from "./config";
import {
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
