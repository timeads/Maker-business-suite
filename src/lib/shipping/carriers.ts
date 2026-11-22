/** The carriers offered in the list, and where each one's tracking page lives. */
export const CARRIERS = [
  "USPS",
  "UPS",
  "FedEx",
  "DHL Express",
  "Canada Post",
  "Royal Mail",
  "Australia Post",
] as const;

const TRACKERS: Record<string, (code: string) => string> = {
  usps: (c) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${c}`,
  ups: (c) => `https://www.ups.com/track?tracknum=${c}`,
  fedex: (c) => `https://www.fedex.com/fedextrack/?trknbr=${c}`,
  "dhl express": (c) => `https://www.dhl.com/en/express/tracking.html?AWB=${c}`,
  dhl: (c) => `https://www.dhl.com/en/express/tracking.html?AWB=${c}`,
  "canada post": (c) =>
    `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${c}`,
  "royal mail": (c) => `https://www.royalmail.com/track-your-item#/tracking-results/${c}`,
  "australia post": (c) => `https://auspost.com.au/mypost/track/#/details/${c}`,
};

/** Tracking numbers are letters and digits; people paste them with spaces and dashes. */
export const tidyTracking = (value: string) =>
  value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .slice(0, 60);

/** The carrier's own tracking page for a number, when we know the carrier. */
export function trackingUrl(carrier: string, tracking: string): string | null {
  const code = tidyTracking(tracking);
  if (!/^[A-Z0-9]{6,60}$/.test(code)) return null;
  const build = TRACKERS[carrier.trim().toLowerCase()];
  return build ? build(encodeURIComponent(code)) : null;
}

/** A best guess at the carrier from the shape of a tracking number. */
export function guessCarrier(tracking: string): string | null {
  const code = tidyTracking(tracking);
  if (/^1Z[A-Z0-9]{16}$/.test(code)) return "UPS";
  if (/^(94|93|92|95)\d{20}$/.test(code) || /^[A-Z]{2}\d{9}US$/.test(code)) return "USPS";
  if (/^\d{12}$/.test(code) || /^\d{15}$/.test(code)) return "FedEx";
  if (/^\d{10}$/.test(code)) return "DHL Express";
  if (/^[A-Z]{2}\d{9}GB$/.test(code)) return "Royal Mail";
  if (/^[A-Z]{2}\d{9}CA$/.test(code) || /^\d{16}$/.test(code)) return "Canada Post";
  return null;
}

export type ShipTo = {
  recipient: string | null;
  company: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country_code: string | null;
};

/** An address as the lines you'd write on a parcel. */
export function addressLines(to: ShipTo, homeCountry?: string | null): string[] {
  const cityLine = [to.city, [to.region, to.postal_code].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  const abroad = to.country_code && to.country_code !== (homeCountry ?? "").toUpperCase();
  return [
    to.recipient,
    to.company,
    to.address1,
    to.address2,
    cityLine,
    abroad ? countryName(to.country_code!) : null,
  ].filter((line): line is string => Boolean(line && line.trim()));
}

export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

export type QueueOrder = {
  units_left: number;
  cancelled: boolean;
  paid: boolean;
  on_hold: boolean;
  address1: string | null;
  recipient: string | null;
};

/** Which pile an order belongs in. Exactly one. */
export function queueOf(order: QueueOrder): "ready" | "hold" | "unpaid" | "done" {
  if (order.cancelled || order.units_left <= 0) return "done";
  if (order.on_hold) return "hold";
  if (!order.paid) return "unpaid";
  return "ready";
}

/** Whether there's enough of an address to send to. */
export const hasAddress = (order: Pick<QueueOrder, "address1" | "recipient">) =>
  Boolean(order.address1 && order.recipient);
