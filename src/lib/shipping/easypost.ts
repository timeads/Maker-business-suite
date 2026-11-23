import { ReconnectRequiredError, type Fetch } from "../connections/types";

/**
 * EasyPost's REST API: rates, buying a label, asking for a refund. Nothing
 * here knows about workspaces or the database. Every call takes the API key
 * as its first argument, so where the key comes from (today: the workspace's
 * own connection) is decided in one place by the caller.
 *
 * The key is only ever put in the Authorization header. It is never logged
 * and never part of an error message.
 */
const API = "https://api.easypost.com/v2";
const TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Weights. Carriers price by the ounce, shops weigh in grams and people at a
// packing bench think in pounds and ounces. Everything is carried as whole
// tenths of an ounce, worked out with integers, so nothing drifts.
// ---------------------------------------------------------------------------

/** One ounce is exactly 28.349523125 g: these are grams x 10^9. */
const NANOGRAMS_PER_OUNCE = BigInt("28349523125");
const NANOGRAMS_PER_GRAM = BigInt("1000000000");
const TENTHS_PER_POUND = 160;

/** Whole grams to tenths of an ounce, rounded half up. */
export function gramsToTenthOz(grams: number): number {
  if (!Number.isFinite(grams) || grams <= 0) return 0;
  const numerator = BigInt(Math.round(grams)) * NANOGRAMS_PER_GRAM * BigInt(10);
  return Number((numerator * BigInt(2) + NANOGRAMS_PER_OUNCE) / (NANOGRAMS_PER_OUNCE * BigInt(2)));
}

/** "4", "4.5" or "" as tenths (45), or null when it isn't a plain amount. */
export function parseTenths(value: string): number | null {
  const text = value.trim();
  if (text === "") return 0;
  const match = /^(\d{1,5})(?:\.(\d)\d*)?$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 10 + Number(match[2] ?? "0");
}

/** What someone typed as pounds and ounces, as tenths of an ounce. */
export function lbOzToTenthOz(lb: string, oz: string): number | null {
  const pounds = parseTenths(lb);
  const ounces = parseTenths(oz);
  if (pounds === null || ounces === null) return null;
  // Tenths of a pound are sixteen tenths of an ounce each.
  return pounds * 16 + ounces;
}

/** Tenths of an ounce as the pounds and ounces to show in two boxes. */
export function tenthOzToLbOz(tenths: number): { lb: string; oz: string } {
  const whole = Math.max(0, Math.round(tenths));
  const rest = whole % TENTHS_PER_POUND;
  return {
    lb: String((whole - rest) / TENTHS_PER_POUND),
    oz: rest % 10 === 0 ? String(rest / 10) : `${(rest - (rest % 10)) / 10}.${rest % 10}`,
  };
}

/** "2 lb 4.5 oz" */
export function formatTenthOz(tenths: number): string {
  const { lb, oz } = tenthOzToLbOz(tenths);
  if (lb === "0") return `${oz} oz`;
  return oz === "0" ? `${lb} lb` : `${lb} lb ${oz} oz`;
}

// ---------------------------------------------------------------------------
// Prices. EasyPost sends them as text ("8.4", "8.40"); they stay text, and
// are compared as whole cents.
// ---------------------------------------------------------------------------

/** A price as whole cents, rounded half up, or null when it isn't one. */
export function priceToCents(value: unknown): bigint | null {
  const match = /^(\d{1,9})(?:\.(\d{1,8}))?$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(3, "0");
  const cents = BigInt(match[1]) * BigInt(100) + BigInt(fraction.slice(0, 2));
  return fraction[2] >= "5" ? cents + BigInt(1) : cents;
}

/** Whole cents as "8.40". */
export function centsToPrice(cents: bigint): string {
  const text = cents.toString().padStart(3, "0");
  return `${text.slice(0, -2)}.${text.slice(-2)}`;
}

/** "$8.40" for dollars, "8.40 CAD" for anything else. */
export const formatPrice = (price: string, currency: string) =>
  currency === "USD" ? `$${price}` : `${price} ${currency}`;

// ---------------------------------------------------------------------------
// Names (ported from the reference help desk's easypost.ts)
// ---------------------------------------------------------------------------

/** The USPS services offered. Others EasyPost lists are retail-only extras. */
export const USPS_SERVICES: Record<string, string> = {
  FirstClassPackageInternationalService: "USPS First-Class Package International",
  PriorityMailInternational: "USPS Priority Mail International",
  ExpressMailInternational: "USPS Priority Mail Express International",
  GroundAdvantage: "USPS Ground Advantage",
  Priority: "USPS Priority Mail",
  Express: "USPS Priority Mail Express",
  ParcelSelect: "USPS Parcel Select",
  MediaMail: "USPS Media Mail",
  LibraryMail: "USPS Library Mail",
};

/** EasyPost's carrier ids -> the names people (and shops) know. */
const CARRIER_NAMES: Record<string, string> = {
  USPS: "USPS",
  UPS: "UPS",
  UPSDAP: "UPS",
  UPSSurePost: "UPS",
  FedEx: "FedEx",
  FedExDefault: "FedEx",
  FedExSmartPost: "FedEx",
  OnTrac: "OnTrac",
  AmazonShipping: "Amazon Shipping",
  DhlEcs: "DHL eCommerce",
  DHLEcommerce: "DHL eCommerce",
  DHLExpress: "DHL Express",
  CanadaPost: "Canada Post",
  LSO: "LSO",
  Veho: "Veho",
  GSO: "GLS",
  Passport: "Passport",
};
export const carrierName = (raw: string) =>
  CARRIER_NAMES[raw] ?? raw.replace(/([a-z])([A-Z])/g, "$1 $2");

const SERVICE_NAMES: Record<string, string> = {
  "UPS:Ground": "Ground",
  "UPS:UPSStandard": "Standard",
  "UPS:3DaySelect": "3 Day Select",
  "UPS:2ndDayAir": "2nd Day Air",
  "UPS:2ndDayAirAM": "2nd Day Air A.M.",
  "UPS:NextDayAir": "Next Day Air",
  "UPS:NextDayAirSaver": "Next Day Air Saver",
  "UPS:NextDayAirEarlyAM": "Next Day Air Early",
  "UPS:UPSSaver": "Worldwide Saver",
  "UPS:Expedited": "Worldwide Expedited",
  "UPS:Express": "Worldwide Express",
  "UPS:UPSGroundsaver": "Ground Saver",
  "UPS:GroundSaver": "Ground Saver",
  "FedEx:FEDEX_GROUND": "Ground",
  "FedEx:GROUND_HOME_DELIVERY": "Home Delivery",
  "FedEx:SMART_POST": "Ground Economy",
  "FedEx:FEDEX_2_DAY": "2Day",
  "FedEx:FEDEX_2_DAY_AM": "2Day A.M.",
  "FedEx:FEDEX_EXPRESS_SAVER": "Express Saver",
  "FedEx:STANDARD_OVERNIGHT": "Standard Overnight",
  "FedEx:PRIORITY_OVERNIGHT": "Priority Overnight",
  "FedEx:FIRST_OVERNIGHT": "First Overnight",
  "FedEx:INTERNATIONAL_ECONOMY": "International Economy",
  "FedEx:INTERNATIONAL_PRIORITY": "International Priority",
  "OnTrac:GRND": "Ground",
  "DHL eCommerce:DHLParcelExpedited": "Parcel Expedited",
  "DHL eCommerce:DHLParcelExpeditedMax": "Parcel Expedited Max",
  "DHL eCommerce:DHLParcelGround": "Parcel Ground",
  "DHL eCommerce:DHLSMParcelsExpedited": "SM Parcel Expedited",
  "DHL eCommerce:DHLSMParcelsExpeditedMax": "SM Parcel Expedited Max",
  "DHL eCommerce:DHLSMParcelsGround": "SM Parcel Ground",
};

/** "FedEx" + "FEDEX_GROUND" -> "FedEx Ground"; unknown services are spelled out from their code. */
export function easypostServiceName(rawCarrier: string, service: string): string {
  if (rawCarrier === "USPS" && USPS_SERVICES[service]) return USPS_SERVICES[service];
  const carrier = carrierName(rawCarrier);
  const known = SERVICE_NAMES[`${carrier}:${service}`];
  let name =
    known ??
    service
      .replace(/_/g, " ")
      .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/\s+/)
      .map((word) =>
        /^(AM|PM|SM|DHL|UPS|USPS)$/.test(word)
          ? word
          : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
      )
      .join(" ");
  const first = carrier.split(" ")[0].toLowerCase();
  if (name.toLowerCase().startsWith(first)) name = name.slice(first.length).trim();
  return `${carrier} ${name}`.trim();
}

/** "USPS Ground Advantage" without its carrier, for where the carrier has its own column. */
export function serviceWithoutCarrier(carrier: string, name: string): string {
  return name.toLowerCase().startsWith(`${carrier.toLowerCase()} `)
    ? name.slice(carrier.length + 1).trim()
    : name;
}

/** Digits only, without the leading 1 North American numbers are often typed with. */
export function normalizePhone(phone: string | null | undefined, country = "US"): string {
  if (!phone) return "";
  const main = phone.split(/\s*(?:ext\.?|x|#)\s*\d*$/i)[0];
  let digits = main.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (
    ["US", "CA", "PR"].includes((country || "US").toUpperCase()) &&
    digits.length === 11 &&
    digits.startsWith("1")
  ) {
    digits = digits.slice(1);
  }
  return digits.slice(0, 15);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * EasyPost said no, or didn't answer. `message` is safe to show a person.
 * `uncertain` means we can't tell whether the request went through (a
 * timeout, a dropped connection, a 5xx): after a purchase, check before
 * assuming nothing was bought.
 */
export class EasyPostError extends Error {
  constructor(
    message: string,
    public status: number | null,
    public uncertain: boolean,
  ) {
    super(message);
    this.name = "EasyPostError";
  }
}

const BAD_KEY =
  "EasyPost didn't accept your API key. Reconnect EasyPost under Connections with a current key.";

type ErrorBody = {
  error?: { message?: unknown; errors?: unknown };
};

function plainError(status: number, body: ErrorBody): string {
  if (status === 402) {
    return "Your EasyPost balance is too low for this label. Add funds in EasyPost, then try again.";
  }
  if (status === 404) return "EasyPost couldn't find that label. Get rates again.";
  if (status === 429) return "EasyPost is busy right now. Wait a moment and try again.";
  if (status >= 500) return "EasyPost is having trouble right now. Try again in a minute.";
  const main = typeof body.error?.message === "string" ? body.error.message : "";
  const details = Array.isArray(body.error?.errors)
    ? body.error.errors
        .map((item: unknown) =>
          typeof item === "string"
            ? item
            : item && typeof item === "object" && "message" in item
              ? String((item as { message: unknown }).message ?? "")
              : "",
        )
        .filter(Boolean)
        .join("; ")
    : "";
  const said = [main, details].filter(Boolean).join(": ").replace(/\s+/g, " ").trim().slice(0, 240);
  return said
    ? `EasyPost says: ${said}`
    : "EasyPost couldn't do that. Check the details and try again.";
}

async function call<T>(
  fetchImpl: Fetch,
  key: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        // HTTP Basic: the key is the username, the password is empty.
        authorization: `Basic ${btoa(`${key}:`)}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await response.text();
  } catch {
    // Deliberately not passing the cause along: it can carry the request.
    throw new EasyPostError(
      "EasyPost didn't answer in time. Check your connection and try again.",
      null,
      true,
    );
  }
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (response.status === 401 || response.status === 403) throw new ReconnectRequiredError(BAD_KEY);
  if (!response.ok) {
    throw new EasyPostError(
      plainError(response.status, (json ?? {}) as ErrorBody),
      response.status,
      response.status >= 500,
    );
  }
  return (json ?? {}) as T;
}

// ---------------------------------------------------------------------------
// What we send and get back
// ---------------------------------------------------------------------------

export type LabelAddress = {
  name: string;
  company?: string;
  street1: string;
  street2?: string;
  city: string;
  state?: string;
  zip: string;
  country: string;
  phone?: string;
};

export type LabelParcel = {
  /** Inches. */
  length: number;
  width: number;
  height: number;
  /** Tenths of an ounce. */
  weightTenthOz: number;
};

export type LabelRate = {
  /** EasyPost's id for this rate: what buying names. */
  id: string;
  carrier: string;
  /** EasyPost's own code for the service. */
  service: string;
  /** "USPS Ground Advantage" */
  name: string;
  /** A decimal as text: "8.40". */
  price: string;
  currency: string;
  days: number | null;
};

export type RateQuote = { shipmentId: string; mode: LabelMode | null; rates: LabelRate[] };

export type LabelMode = "test" | "live";

export type BoughtLabel = {
  shipmentId: string;
  trackingCode: string;
  labelUrl: string | null;
  carrier: string;
  service: string;
  name: string;
  price: string;
  currency: string;
  mode: LabelMode;
};

type RawRate = {
  id?: unknown;
  carrier?: unknown;
  service?: unknown;
  rate?: unknown;
  currency?: unknown;
  delivery_days?: unknown;
  est_delivery_days?: unknown;
};

type RawShipment = {
  id?: unknown;
  mode?: unknown;
  rates?: unknown;
  tracking_code?: unknown;
  postage_label?: { label_url?: unknown } | null;
  selected_rate?: RawRate | null;
  refund_status?: unknown;
};

const text = (value: unknown) => (typeof value === "string" ? value : "");
const modeOf = (value: unknown): LabelMode | null =>
  value === "test" ? "test" : value === "production" ? "live" : null;
const idPath = (id: string) => {
  if (!/^[A-Za-z0-9_]{4,120}$/.test(id)) {
    throw new EasyPostError("That label can't be found. Get rates again.", null, false);
  }
  return id;
};

/**
 * One row per carrier service, cheapest first. When two of a carrier's
 * accounts quote the same service the cheaper is kept.
 */
export function normalizeRates(raw: unknown): LabelRate[] {
  const best = new Map<string, { rate: LabelRate; cents: bigint }>();
  for (const item of Array.isArray(raw) ? (raw as RawRate[]) : []) {
    const id = text(item?.id);
    const rawCarrier = text(item?.carrier);
    const service = text(item?.service);
    const cents = priceToCents(item?.rate);
    if (!id || !rawCarrier || !service || cents === null) continue;
    if (rawCarrier === "USPS" && !USPS_SERVICES[service]) continue;
    const days = Number(item.delivery_days ?? item.est_delivery_days);
    const rate: LabelRate = {
      id,
      carrier: carrierName(rawCarrier),
      service,
      name: easypostServiceName(rawCarrier, service),
      price: centsToPrice(cents),
      currency: text(item.currency) || "USD",
      days: Number.isInteger(days) && days > 0 ? days : null,
    };
    const key = `${rawCarrier}:${service}`;
    const held = best.get(key);
    if (!held || cents < held.cents) best.set(key, { rate, cents });
  }
  return [...best.values()]
    .sort((a, b) =>
      a.cents < b.cents ? -1 : a.cents > b.cents ? 1 : a.rate.name.localeCompare(b.rate.name),
    )
    .map((entry) => entry.rate);
}

const address = (a: LabelAddress) => ({
  name: a.name || undefined,
  company: a.company || undefined,
  street1: a.street1,
  street2: a.street2 || undefined,
  city: a.city,
  state: a.state || undefined,
  zip: a.zip,
  country: a.country || "US",
  phone: normalizePhone(a.phone, a.country) || undefined,
});

/**
 * Asks every carrier on the account what this box would cost to send.
 * Creating the shipment is free; nothing is bought until `buyLabel`.
 */
export async function getRates(
  key: string,
  input: { from: LabelAddress; to: LabelAddress; parcel: LabelParcel; reference?: string },
  fetchImpl: Fetch = fetch,
): Promise<RateQuote> {
  const reference = input.reference?.trim().slice(0, 35) || undefined;
  const shipment = await call<RawShipment>(fetchImpl, key, "POST", "/shipments", {
    shipment: {
      to_address: address(input.to),
      from_address: address(input.from),
      parcel: {
        length: input.parcel.length,
        width: input.parcel.width,
        height: input.parcel.height,
        // Ounces, to one decimal place.
        weight: Math.max(1, Math.round(input.parcel.weightTenthOz)) / 10,
      },
      options: {
        label_format: "PNG",
        label_size: "4x6",
        ...(reference ? { print_custom_1: reference } : {}),
      },
      reference,
    },
  });
  const shipmentId = text(shipment.id);
  if (!shipmentId) {
    throw new EasyPostError("EasyPost didn't send any rates back. Try again.", null, false);
  }
  return { shipmentId, mode: modeOf(shipment.mode), rates: normalizeRates(shipment.rates) };
}

function boughtFrom(shipment: RawShipment): BoughtLabel | null {
  const trackingCode = text(shipment.tracking_code);
  const labelUrl = text(shipment.postage_label?.label_url);
  if (!trackingCode && !labelUrl) return null;
  const rate = shipment.selected_rate ?? {};
  const rawCarrier = text(rate.carrier);
  const service = text(rate.service);
  const cents = priceToCents(rate.rate);
  return {
    shipmentId: text(shipment.id),
    trackingCode,
    labelUrl: labelUrl.startsWith("https://") ? labelUrl : null,
    carrier: rawCarrier ? carrierName(rawCarrier) : "Carrier",
    service,
    name: rawCarrier ? easypostServiceName(rawCarrier, service) : service,
    price: cents === null ? "0.00" : centsToPrice(cents),
    currency: text(rate.currency) || "USD",
    mode: modeOf(shipment.mode) ?? "live",
  };
}

/** Buys the chosen rate. This spends money on the account behind the key. */
export async function buyLabel(
  key: string,
  shipmentId: string,
  rateId: string,
  fetchImpl: Fetch = fetch,
): Promise<BoughtLabel> {
  const shipment = await call<RawShipment>(
    fetchImpl,
    key,
    "POST",
    `/shipments/${idPath(shipmentId)}/buy`,
    { rate: { id: rateId } },
  );
  const bought = boughtFrom(shipment);
  if (!bought) {
    // A 200 with no label: we can't say whether money moved.
    throw new EasyPostError("EasyPost didn't confirm the label.", null, true);
  }
  return { ...bought, shipmentId: bought.shipmentId || shipmentId };
}

/**
 * Looks a shipment up again: the label if one was bought, and whether a
 * refund has been asked for. Used to settle a purchase we couldn't confirm.
 */
export async function getShipment(
  key: string,
  shipmentId: string,
  fetchImpl: Fetch = fetch,
): Promise<{ label: BoughtLabel | null; refundStatus: string | null }> {
  const shipment = await call<RawShipment>(
    fetchImpl,
    key,
    "GET",
    `/shipments/${idPath(shipmentId)}`,
  );
  const label = boughtFrom(shipment);
  return {
    label: label ? { ...label, shipmentId: label.shipmentId || shipmentId } : null,
    refundStatus: text(shipment.refund_status) || null,
  };
}

/**
 * Asks for the postage back. Refunds aren't instant: the carrier first
 * confirms the label was never used. Asking twice is fine.
 */
export async function refundLabel(
  key: string,
  shipmentId: string,
  fetchImpl: Fetch = fetch,
): Promise<{ refundStatus: string }> {
  try {
    const shipment = await call<RawShipment>(
      fetchImpl,
      key,
      "POST",
      `/shipments/${idPath(shipmentId)}/refund`,
    );
    return { refundStatus: text(shipment.refund_status) || "submitted" };
  } catch (err) {
    if (!(err instanceof EasyPostError) || err.status === null || err.status >= 500) throw err;
    // Refused: perhaps because it was already asked for.
    const current = await getShipment(key, shipmentId, fetchImpl).catch(() => null);
    if (current?.refundStatus === "submitted" || current?.refundStatus === "refunded") {
      return { refundStatus: current.refundStatus };
    }
    throw err;
  }
}

/**
 * Checks a key by asking for one shipment (the reference's `testEasypost`).
 * A test key only ever sees test-mode objects, so the newest shipment's mode
 * tells the two apart; on a brand-new account the key's own prefix does.
 */
export async function checkKey(
  key: string,
  fetchImpl: Fetch = fetch,
): Promise<{ mode: "test" | "production" | null }> {
  const list = await call<{ shipments?: RawShipment[] }>(
    fetchImpl,
    key,
    "GET",
    "/shipments?page_size=1",
  );
  const seen = Array.isArray(list.shipments) ? list.shipments[0]?.mode : undefined;
  if (seen === "test" || seen === "production") return { mode: seen };
  if (key.startsWith("EZTK")) return { mode: "test" };
  if (key.startsWith("EZAK")) return { mode: "production" };
  return { mode: null };
}
