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
  /** A home, not a business: some carriers charge and deliver differently. */
  residential?: boolean;
};

/** Who has to sign when the parcel arrives. */
export const SIGNATURES = ["none", "signature", "adult"] as const;
export type Signature = (typeof SIGNATURES)[number];
export const isSignature = (value: unknown): value is Signature =>
  SIGNATURES.includes(value as Signature);
const CONFIRMATION: Record<Signature, string | null> = {
  none: null,
  signature: "SIGNATURE",
  adult: "ADULT_SIGNATURE",
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
  /**
   * What buying names. For one box it is EasyPost's own id for the rate. For
   * several boxes EasyPost buys by carrier and service instead, so the id is
   * one we make from the order, carrier and service (`orderRateId`).
   */
  id: string;
  carrier: string;
  /** EasyPost's own code for the carrier ("USPS", "UPSDAP"): what buying several boxes names. */
  carrierCode: string;
  /** EasyPost's own code for the service. */
  service: string;
  /** "USPS Ground Advantage" */
  name: string;
  /** A decimal as text: "8.40". */
  price: string;
  currency: string;
  days: number | null;
};

/**
 * How EasyPost holds what was quoted: one box is a "shipment"; several boxes
 * going together are an "order" of shipments, priced and bought as one.
 */
export const LABEL_KINDS = ["shipment", "order"] as const;
export type LabelKind = (typeof LABEL_KINDS)[number];
export const isLabelKind = (value: unknown): value is LabelKind =>
  LABEL_KINDS.includes(value as LabelKind);

/** The most boxes one purchase can cover. */
export const MAX_BOXES = 6;

export type RateQuote = {
  /** EasyPost's id for what was quoted: a shipment's, or an order's when there are several boxes. */
  shipmentId: string;
  kind: LabelKind;
  boxes: number;
  mode: LabelMode | null;
  rates: LabelRate[];
};

export type LabelMode = "test" | "live";

/** One box's label. */
export type BoughtBox = {
  /** EasyPost's id for this box's shipment: what a refund is asked for by. */
  shipmentId: string;
  trackingCode: string;
  labelUrl: string | null;
};

export type BoughtLabel = {
  /** The shipment's id, or the order's when there are several boxes. */
  shipmentId: string;
  kind: LabelKind;
  /** The first box's, for the places that show one. */
  trackingCode: string;
  labelUrl: string | null;
  /** Every box, in the order they were given. One entry for a single box. */
  boxes: BoughtBox[];
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

type RawOrder = {
  id?: unknown;
  mode?: unknown;
  rates?: unknown;
  shipments?: unknown;
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
      carrierCode: rawCarrier,
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
  ...(a.residential === undefined ? {} : { residential: a.residential }),
});

/** FNV-1a over the text, 64 bits, as sixteen hex digits. Not a secret: just a short stable name. */
function shortHash(value: string): string {
  let hash = BigInt("0xcbf29ce484222325");
  const prime = BigInt("0x100000001b3");
  const mask = BigInt("0xffffffffffffffff");
  for (const byte of new TextEncoder().encode(value)) {
    hash = ((hash ^ BigInt(byte)) * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * The id we give a rate on a several-box order. EasyPost buys those by
 * carrier and service, not by rate id, so this names the three things that
 * decide the price (which order, which carrier, which service) in a form
 * that passes for a rate id everywhere else. A rate from an earlier quote
 * never matches a later one, because the order's id is part of it.
 */
export const orderRateId = (orderId: string, carrierCode: string, service: string) =>
  `ordrate_${shortHash(`${orderId}\n${carrierCode}\n${service}`)}`;

/** An order's rates in the same shape as a shipment's, each with an id of our own. */
export function normalizeOrderRates(orderId: string, raw: unknown): LabelRate[] {
  const named = (Array.isArray(raw) ? (raw as RawRate[]) : []).map((item) => ({
    ...item,
    // Whatever id EasyPost put on it can't be bought by, so ours replaces it.
    id: orderRateId(orderId, text(item?.carrier), text(item?.service)),
  }));
  return normalizeRates(named);
}

const parcelBody = (parcel: LabelParcel) => ({
  length: parcel.length,
  width: parcel.width,
  height: parcel.height,
  // Ounces, to one decimal place.
  weight: Math.max(1, Math.round(parcel.weightTenthOz)) / 10,
});

/**
 * Asks every carrier on the account what this would cost to send. One box is
 * a shipment; several boxes are an order, whose rates already price all the
 * boxes together under one service. Creating either is free; nothing is
 * bought until `buyLabel` or `buyOrder`.
 */
export async function getRates(
  key: string,
  input: {
    from: LabelAddress;
    to: LabelAddress;
    /** One to six boxes. */
    parcels: LabelParcel[];
    reference?: string;
    signature?: Signature;
  },
  fetchImpl: Fetch = fetch,
): Promise<RateQuote> {
  const parcels = input.parcels;
  if (!Array.isArray(parcels) || parcels.length < 1 || parcels.length > MAX_BOXES) {
    throw new EasyPostError(
      `A label can cover one to ${MAX_BOXES} boxes. Check the boxes and try again.`,
      null,
      false,
    );
  }
  const reference = input.reference?.trim().slice(0, 35) || undefined;
  const confirmation = CONFIRMATION[input.signature ?? "none"];
  const options = {
    label_format: "PNG",
    label_size: "4x6",
    ...(reference ? { print_custom_1: reference } : {}),
    ...(confirmation ? { delivery_confirmation: confirmation } : {}),
  };
  const none = () =>
    new EasyPostError("EasyPost didn't send any rates back. Try again.", null, false);

  if (parcels.length === 1) {
    const shipment = await call<RawShipment>(fetchImpl, key, "POST", "/shipments", {
      shipment: {
        to_address: address(input.to),
        from_address: address(input.from),
        parcel: parcelBody(parcels[0]),
        options,
        reference,
      },
    });
    const shipmentId = text(shipment.id);
    if (!shipmentId) throw none();
    return {
      shipmentId,
      kind: "shipment",
      boxes: 1,
      mode: modeOf(shipment.mode),
      rates: normalizeRates(shipment.rates),
    };
  }

  const order = await call<RawOrder>(fetchImpl, key, "POST", "/orders", {
    order: {
      to_address: address(input.to),
      from_address: address(input.from),
      reference,
      options,
      // Each box carries the options too, so every label prints the same way.
      shipments: parcels.map((parcel) => ({ parcel: parcelBody(parcel), options })),
    },
  });
  const orderId = text(order.id);
  if (!orderId) throw none();
  const first = Array.isArray(order.shipments) ? (order.shipments[0] as RawShipment) : undefined;
  return {
    shipmentId: orderId,
    kind: "order",
    boxes: parcels.length,
    mode: modeOf(order.mode) ?? modeOf(first?.mode),
    rates: normalizeOrderRates(orderId, order.rates),
  };
}

export type AddressCheck = {
  /** The carriers' address book knows this address. */
  found: boolean;
  /** Why not, in EasyPost's words, when it wasn't found. */
  problem: string;
  /** A home rather than a business, when EasyPost can tell. */
  residential: boolean | null;
  /** The address as the carriers spell it, when it differs from what was sent. */
  suggestion: Pick<LabelAddress, "street1" | "street2" | "city" | "state" | "zip"> | null;
};

type RawAddress = {
  street1?: unknown;
  street2?: unknown;
  city?: unknown;
  state?: unknown;
  zip?: unknown;
  residential?: unknown;
  verifications?: {
    delivery?: { success?: unknown; errors?: unknown } | null;
  } | null;
};

const same = (a: string | undefined, b: string) =>
  (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

/** Reads EasyPost's answer to an address check. No network. */
export function readAddressCheck(sent: LabelAddress, raw: unknown): AddressCheck {
  const got = (raw ?? {}) as RawAddress;
  const delivery = got.verifications?.delivery;
  const found = delivery?.success === true;
  const errors = Array.isArray(delivery?.errors)
    ? (delivery.errors as { message?: unknown }[])
        .map((item) => text(item?.message))
        .filter(Boolean)
        .join("; ")
        .slice(0, 200)
    : "";
  const spelled = {
    street1: text(got.street1),
    street2: text(got.street2) || undefined,
    city: text(got.city),
    state: text(got.state) || undefined,
    zip: text(got.zip),
  };
  const differs =
    found &&
    Boolean(spelled.street1 && spelled.city && spelled.zip) &&
    !(
      same(sent.street1, spelled.street1) &&
      same(sent.street2, spelled.street2 ?? "") &&
      same(sent.city, spelled.city) &&
      same(sent.state, spelled.state ?? "") &&
      same(sent.zip, spelled.zip)
    );
  return {
    found,
    problem: found ? "" : errors,
    residential: typeof got.residential === "boolean" ? got.residential : null,
    suggestion: differs ? spelled : null,
  };
}

/** Asks whether the carriers know an address. Buys nothing and changes nothing. */
export async function verifyAddress(
  key: string,
  to: LabelAddress,
  fetchImpl: Fetch = fetch,
): Promise<AddressCheck> {
  const raw = await call<RawAddress>(fetchImpl, key, "POST", "/addresses", {
    // `verify` sits beside the address, not inside it.
    address: address(to),
    verify: true,
  });
  return readAddressCheck(to, raw);
}

const httpsOnly = (url: string) => (url.startsWith("https://") ? url : null);

function boughtFrom(shipment: RawShipment): BoughtLabel | null {
  const trackingCode = text(shipment.tracking_code);
  const labelUrl = text(shipment.postage_label?.label_url);
  if (!trackingCode && !labelUrl) return null;
  const rate = shipment.selected_rate ?? {};
  const rawCarrier = text(rate.carrier);
  const service = text(rate.service);
  const cents = priceToCents(rate.rate);
  const shipmentId = text(shipment.id);
  return {
    shipmentId,
    kind: "shipment",
    trackingCode,
    labelUrl: httpsOnly(labelUrl),
    boxes: [{ shipmentId, trackingCode, labelUrl: httpsOnly(labelUrl) }],
    carrier: rawCarrier ? carrierName(rawCarrier) : "Carrier",
    service,
    name: rawCarrier ? easypostServiceName(rawCarrier, service) : service,
    price: cents === null ? "0.00" : centsToPrice(cents),
    currency: text(rate.currency) || "USD",
    mode: modeOf(shipment.mode) ?? "live",
  };
}

/**
 * A several-box order as one label purchase: every box that has a label, and
 * what they cost together. Null when no box has one (nothing was bought).
 */
function boughtFromOrder(order: RawOrder): BoughtLabel | null {
  const labels = (Array.isArray(order.shipments) ? (order.shipments as RawShipment[]) : [])
    .map((shipment) => boughtFrom(shipment ?? {}))
    .filter((label): label is BoughtLabel => label !== null);
  if (labels.length === 0) return null;
  const first = labels[0];
  const total = labels.reduce(
    (sum, label) => sum + (priceToCents(label.price) ?? BigInt(0)),
    BigInt(0),
  );
  return {
    ...first,
    shipmentId: text(order.id),
    kind: "order",
    boxes: labels.map((label) => label.boxes[0]),
    price: centsToPrice(total),
    mode: modeOf(order.mode) ?? first.mode,
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
  return withId(bought, shipmentId);
}

/** A label read back from EasyPost, with the id we asked by wherever the reply left it out. */
const withId = (label: BoughtLabel, id: string): BoughtLabel =>
  label.kind === "shipment"
    ? {
        ...label,
        shipmentId: label.shipmentId || id,
        boxes: label.boxes.map((box) => ({ ...box, shipmentId: box.shipmentId || id })),
      }
    : { ...label, shipmentId: label.shipmentId || id };

/**
 * Buys every box of an order under one service, in one call. This spends
 * money on the account behind the key. The carrier and service are EasyPost's
 * own codes, as the quote gave them.
 */
export async function buyOrder(
  key: string,
  orderId: string,
  choice: { carrierCode: string; service: string },
  fetchImpl: Fetch = fetch,
): Promise<BoughtLabel> {
  if (!choice.carrierCode || !choice.service) {
    throw new EasyPostError("That rate can't be found. Get rates again.", null, false);
  }
  const order = await call<RawOrder>(fetchImpl, key, "POST", `/orders/${idPath(orderId)}/buy`, {
    carrier: choice.carrierCode,
    service: choice.service,
  });
  const bought = boughtFromOrder(order);
  if (!bought) {
    // A 200 with no labels: we can't say whether money moved.
    throw new EasyPostError("EasyPost didn't confirm the labels.", null, true);
  }
  return withId(bought, orderId);
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
    label: label ? withId(label, shipmentId) : null,
    refundStatus: text(shipment.refund_status) || null,
  };
}

/** Looks a several-box order up again: its labels, if they were bought. */
export async function getOrder(
  key: string,
  orderId: string,
  fetchImpl: Fetch = fetch,
): Promise<{ label: BoughtLabel | null }> {
  const order = await call<RawOrder>(fetchImpl, key, "GET", `/orders/${idPath(orderId)}`);
  const label = boughtFromOrder(order);
  return { label: label ? withId(label, orderId) : null };
}

/** What really happened to a purchase, whichever kind it was. */
export const getPurchase = (
  key: string,
  kind: LabelKind,
  id: string,
  fetchImpl: Fetch = fetch,
): Promise<{ label: BoughtLabel | null }> =>
  kind === "order" ? getOrder(key, id, fetchImpl) : getShipment(key, id, fetchImpl);

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
 * Asks for the postage back on every box of a purchase. Each box is its own
 * request, and every one is tried even when an earlier one is refused, so
 * pressing again only has the refused ones left to do.
 */
export async function refundLabels(
  key: string,
  shipmentIds: string[],
  fetchImpl: Fetch = fetch,
): Promise<{ asked: number; failed: number; error: unknown }> {
  let asked = 0;
  let failed = 0;
  let error: unknown = null;
  for (const id of shipmentIds) {
    try {
      await refundLabel(key, id, fetchImpl);
      asked += 1;
    } catch (err) {
      failed += 1;
      error ??= err;
    }
  }
  return { asked, failed, error };
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
