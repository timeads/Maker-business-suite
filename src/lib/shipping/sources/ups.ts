import type { Fetch } from "../../connections/types";
import {
  centsToPrice,
  normalizePhone,
  priceToCents,
  type AddressCheck,
  type LabelAddress,
  type LabelParcel,
  type Signature,
} from "../easypost";
import { SourceError, StaleTokenError, poundsOf, type LabelRequest } from "./types";

/**
 * UPS's own API, for a business's own UPS account: sign-in, rates, labels,
 * voids and the address check. Ported from the reference help desk's
 * `ups.ts`. Nothing here knows about workspaces or the database: every call
 * takes what it needs to sign in as its first argument.
 *
 * The client secret only ever goes in the Authorization header of the
 * sign-in call, and the token only in the Authorization header of the rest.
 * Neither is logged or put in an error message.
 */
const API_VERSION = "v2409";
const TIMEOUT_MS = 20_000;
/** Says which app is calling. Not a secret, and not about any one customer. */
const TRANSACTION_SRC = "maker-suite";

export const UPS_SERVICES: Record<string, string> = {
  "01": "UPS Next Day Air",
  "02": "UPS 2nd Day Air",
  "03": "UPS Ground",
  "12": "UPS 3 Day Select",
  "13": "UPS Next Day Air Saver",
  "14": "UPS Next Day Air Early",
  "59": "UPS 2nd Day Air A.M.",
  "07": "UPS Worldwide Express",
  "08": "UPS Worldwide Expedited",
  "11": "UPS Standard",
  "54": "UPS Worldwide Express Plus",
  "65": "UPS Worldwide Saver",
  "75": "UPS Heavy Goods",
  "93": "UPS Ground Saver",
};

export type UpsAccess = {
  /** The bearer token from `fetchUpsToken`. */
  token: string;
  /** The six-character shipper number the postage is billed to. */
  account: string;
  /** UPS's practice system: labels aren't real and nothing is billed. */
  test: boolean;
};

export type UpsKeys = { clientId: string; clientSecret: string; account: string; test: boolean };

const base = (test: boolean) => (test ? "https://wwwcie.ups.com" : "https://onlinetools.ups.com");

const NO_ANSWER = "UPS didn't answer in time. Check your connection and try again.";

/** Shown when UPS accepts the keys but refuses the request itself. */
export const UPS_AUTH_HELP =
  "UPS accepted your keys but refused this request. At developer.ups.com, open your app and check that Rating and Shipping are added under Products (and Address Validation if you want addresses checked), and that the account number you gave us is the one linked to the app.";

/** The keys were turned down outright. */
export class UpsKeysRefused extends Error {
  constructor() {
    super("UPS didn't accept those keys");
    this.name = "UpsKeysRefused";
  }
}

/**
 * Signs in with the app's keys (OAuth client credentials) and returns a
 * token that lasts a few hours.
 */
export async function fetchUpsToken(
  keys: UpsKeys,
  fetchImpl: Fetch = fetch,
): Promise<{ token: string; expiresIn: number }> {
  let response: Response;
  let body: unknown = {};
  try {
    response = await fetchImpl(`${base(keys.test)}/security/v1/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${btoa(`${keys.clientId}:${keys.clientSecret}`)}`,
        "x-merchant-id": keys.account,
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    body = await response.json().catch(() => ({}));
  } catch {
    // Deliberately not passing the cause along: it can carry the request.
    throw new SourceError(NO_ANSWER, null, true);
  }
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw new UpsKeysRefused();
  }
  const token = (body as { access_token?: unknown }).access_token;
  if (!response.ok || typeof token !== "string" || !token) {
    throw new SourceError(
      "UPS is having trouble signing in right now. Try again in a minute.",
      response.status,
      response.status >= 500,
    );
  }
  return { token, expiresIn: Number((body as { expires_in?: unknown }).expires_in) || 3600 };
}

type UpsErrors = { response?: { errors?: { code?: unknown; message?: unknown }[] } };

/** A shipment that was already voided is as good as voided. */
const ALREADY_VOIDED = /already\s+(been\s+)?voided/i;

/**
 * UPS's practice system makes labels but keeps no record of them, so it can
 * never find one to void. Nothing was billed, so the void counts as done.
 * Only ever applied to a practice account: on a real one this is an error.
 */
const PRACTICE_NOT_FOUND = /no shipment found/i;

async function ups<T>(
  fetchImpl: Fetch,
  access: UpsAccess,
  method: "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(base(access.test) + path, {
      method,
      headers: {
        authorization: `Bearer ${access.token}`,
        "content-type": "application/json",
        transId: crypto.randomUUID().replace(/-/g, "").slice(0, 32),
        transactionSrc: TRANSACTION_SRC,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await response.text();
  } catch {
    throw new SourceError(NO_ANSWER, null, true);
  }
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  // The saved token may be from older keys or revoked: the caller gets a fresh one and tries once more.
  if (response.status === 401) throw new StaleTokenError();
  if (!response.ok) {
    const errors = ((json ?? {}) as UpsErrors).response?.errors;
    const list = Array.isArray(errors) ? errors : [];
    if (list.some((item) => String(item?.code ?? "") === "250002")) {
      throw new SourceError(UPS_AUTH_HELP, response.status, false);
    }
    if (response.status === 429) {
      throw new SourceError(
        "UPS is busy right now. Wait a moment and try again.",
        response.status,
        false,
      );
    }
    if (response.status >= 500) {
      throw new SourceError(
        "UPS is having trouble right now. Try again in a minute.",
        response.status,
        true,
      );
    }
    const said = list
      .map((item) => (typeof item?.message === "string" ? item.message : ""))
      .filter(Boolean)
      .join("; ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    throw new SourceError(
      said ? `UPS says: ${said}` : "UPS couldn't do that. Check the details and try again.",
      response.status,
      false,
    );
  }
  return json as T;
}

// ---------------------------------------------------------------------------
// What we send
// ---------------------------------------------------------------------------

const trunc = (value: string | undefined, length: number) => (value ?? "").slice(0, length);
const asArray = <T>(value: T | T[] | undefined | null): T[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

function upsAddress(a: LabelAddress, residential: boolean) {
  return {
    AddressLine: [a.street1, a.street2].filter(Boolean).map((line) => trunc(line, 35)),
    City: trunc(a.city, 30),
    // Many countries have no state.
    ...(a.state?.trim() ? { StateProvinceCode: a.state.trim() } : {}),
    PostalCode: a.zip,
    CountryCode: a.country,
    ...(residential ? { ResidentialAddressIndicator: "" } : {}),
  };
}

function party(a: LabelAddress, residential = false) {
  const phone = normalizePhone(a.phone, a.country);
  return {
    Name: trunc(a.company || a.name, 35),
    AttentionName: trunc(a.name || a.company, 35),
    ...(phone ? { Phone: { Number: phone } } : {}),
    Address: upsAddress(a, residential),
  };
}

function pkg(
  parcel: LabelParcel,
  packagingKey: "PackagingType" | "Packaging",
  signature: Signature,
  reference?: string,
) {
  return {
    // A box of the sender's own.
    [packagingKey]: { Code: "02" },
    // The order number, on the label. At package level: UPS refuses
    // shipment-level references on many shipments.
    ...(reference ? { ReferenceNumber: { Value: trunc(reference, 35) } } : {}),
    Dimensions: {
      UnitOfMeasurement: { Code: "IN" },
      // Whole inches, and at least one: an envelope can be thinner.
      Length: String(Math.max(1, Math.ceil(parcel.length))),
      Width: String(Math.max(1, Math.ceil(parcel.width))),
      Height: String(Math.max(1, Math.ceil(parcel.height))),
    },
    // Delivery confirmation: 2 = signature required, 3 = adult signature.
    ...(signature === "none"
      ? {}
      : {
          PackageServiceOptions: {
            DeliveryConfirmation: { DCISType: signature === "adult" ? "3" : "2" },
          },
        }),
    PackageWeight: {
      UnitOfMeasurement: { Code: "LBS" },
      Weight: String(Math.max(0.1, Math.round(poundsOf(parcel) * 10) / 10)),
    },
  };
}

/** A home unless we were told otherwise, as the reference does. */
const toParty = (to: LabelAddress) => party(to, to.residential ?? true);

export function buildRateRequest(account: string, request: LabelRequest) {
  return {
    RateRequest: {
      // Every service the account offers, in one answer.
      Request: { RequestOption: "Shop" },
      Shipment: {
        Shipper: { ...party(request.from), ShipperNumber: account },
        ShipFrom: party(request.from),
        ShipTo: toParty(request.to),
        PaymentDetails: {
          ShipmentCharge: [{ Type: "01", BillShipper: { AccountNumber: account } }],
        },
        // The account's own agreed prices, not the list price.
        ShipmentRatingOptions: { NegotiatedRatesIndicator: "" },
        NumOfPieces: String(request.parcels.length),
        Package: request.parcels.map((parcel) => pkg(parcel, "PackagingType", request.signature)),
      },
    },
  };
}

export type UpsRate = {
  serviceCode: string;
  name: string;
  /** The account's own price when UPS gives one, else the list price. */
  price: string;
  currency: string;
  days: number | null;
};

type Money = { MonetaryValue?: unknown; CurrencyCode?: unknown };
type RatedShipment = {
  Service?: { Code?: unknown };
  TotalCharges?: Money;
  NegotiatedRateCharges?: { TotalCharge?: Money };
  GuaranteedDelivery?: { BusinessDaysInTransit?: unknown };
};

export function parseRates(json: unknown): UpsRate[] {
  const rated = asArray(
    (json as { RateResponse?: { RatedShipment?: RatedShipment | RatedShipment[] } })?.RateResponse
      ?.RatedShipment,
  );
  const out: (UpsRate & { cents: bigint })[] = [];
  for (const item of rated) {
    const code = typeof item?.Service?.Code === "string" ? item.Service.Code : "";
    const cents =
      priceToCents(item?.NegotiatedRateCharges?.TotalCharge?.MonetaryValue) ??
      priceToCents(item?.TotalCharges?.MonetaryValue);
    if (!/^[0-9A-Za-z]{1,4}$/.test(code) || cents === null) continue;
    const days = Number(item.GuaranteedDelivery?.BusinessDaysInTransit);
    out.push({
      serviceCode: code,
      name: UPS_SERVICES[code] ?? `UPS service ${code}`,
      price: centsToPrice(cents),
      currency:
        typeof item.TotalCharges?.CurrencyCode === "string"
          ? item.TotalCharges.CurrencyCode
          : "USD",
      days: Number.isInteger(days) && days > 0 ? days : null,
      cents,
    });
  }
  return out
    .sort((a, b) => (a.cents < b.cents ? -1 : a.cents > b.cents ? 1 : 0))
    .map(({ cents: _cents, ...rate }) => rate);
}

export async function getUpsRates(
  access: UpsAccess,
  request: LabelRequest,
  fetchImpl: Fetch = fetch,
): Promise<UpsRate[]> {
  const json = await ups(
    fetchImpl,
    access,
    "POST",
    `/api/rating/${API_VERSION}/Shop`,
    buildRateRequest(access.account, request),
  );
  return parseRates(json);
}

export function buildShipRequest(account: string, request: LabelRequest, serviceCode: string) {
  const several = request.parcels.length > 1;
  return {
    ShipmentRequest: {
      Request: { RequestOption: "nonvalidate" },
      Shipment: {
        Description: "Merchandise",
        Shipper: { ...party(request.from), ShipperNumber: account },
        ShipFrom: party(request.from),
        ShipTo: toParty(request.to),
        PaymentInformation: {
          ShipmentCharge: [{ Type: "01", BillShipper: { AccountNumber: account } }],
        },
        Service: { Code: serviceCode },
        ShipmentRatingOptions: { NegotiatedRatesIndicator: "" },
        // Several boxes are one shipment with a label and tracking number each.
        Package: request.parcels.map((parcel, index) =>
          pkg(
            parcel,
            "Packaging",
            request.signature,
            request.reference
              ? several
                ? `${trunc(request.reference, 24)} box ${index + 1}/${request.parcels.length}`
                : request.reference
              : undefined,
          ),
        ),
      },
      LabelSpecification: {
        // A Zebra's own format when the computer asking prints straight to one, else a picture.
        LabelImageFormat: { Code: request.labelFormat === "zpl" ? "ZPL" : "GIF" },
        HTTPUserAgent: "Mozilla/4.5",
        ...(request.labelFormat === "zpl" ? { LabelStockSize: { Height: "6", Width: "4" } } : {}),
      },
    },
  };
}

export type UpsShipment = {
  /** What a void is asked for by. */
  shipmentId: string;
  boxes: { trackingNumber: string; label: string | null }[];
  price: string;
  currency: string;
};

type PackageResult = { TrackingNumber?: unknown; ShippingLabel?: { GraphicImage?: unknown } };
type ShipmentResults = {
  ShipmentIdentificationNumber?: unknown;
  PackageResults?: PackageResult | PackageResult[];
  NegotiatedRateCharges?: { TotalCharge?: Money };
  ShipmentCharges?: { TotalCharges?: Money };
};

/**
 * The label's file as plain base64, or null when there isn't one we can keep.
 * UPS may wrap the base64 over several lines; the breaks are not part of it.
 */
export function labelData(image: unknown): string | null {
  if (typeof image !== "string") return null;
  const data = image.replace(/\s+/g, "");
  if (data && /^[A-Za-z0-9+/]+=*$/.test(data)) return data;
  // Never the label itself: only enough to say what arrived, for whoever reads the log.
  console.warn("ups label file not usable", {
    length: image.length,
    startsLike: image.slice(0, 6).replace(/[A-Za-z0-9+/=]/g, "x"),
  });
  return null;
}

/** Null when the answer doesn't describe a shipment. */
export function parseShipResponse(json: unknown): UpsShipment | null {
  const results = (json as { ShipmentResponse?: { ShipmentResults?: ShipmentResults } })
    ?.ShipmentResponse?.ShipmentResults;
  const shipmentId =
    typeof results?.ShipmentIdentificationNumber === "string"
      ? results.ShipmentIdentificationNumber
      : "";
  if (!results || !shipmentId) return null;
  const total = results.NegotiatedRateCharges?.TotalCharge ?? results.ShipmentCharges?.TotalCharges;
  const cents = priceToCents(total?.MonetaryValue);
  return {
    shipmentId,
    boxes: asArray(results.PackageResults).map((box) => ({
      trackingNumber: typeof box?.TrackingNumber === "string" ? box.TrackingNumber : "",
      label: labelData(box?.ShippingLabel?.GraphicImage),
    })),
    price: cents === null ? "0.00" : centsToPrice(cents),
    currency: typeof total?.CurrencyCode === "string" ? total.CurrencyCode : "USD",
  };
}

/** Makes the shipment and its labels. This spends money on the UPS account. */
export async function createUpsShipment(
  access: UpsAccess,
  request: LabelRequest,
  serviceCode: string,
  fetchImpl: Fetch = fetch,
): Promise<UpsShipment> {
  if (!/^[0-9A-Za-z]{1,4}$/.test(serviceCode)) {
    throw new SourceError("That rate can't be found. Get rates again.", null, false);
  }
  const json = await ups(
    fetchImpl,
    access,
    "POST",
    `/api/shipments/${API_VERSION}/ship`,
    buildShipRequest(access.account, request, serviceCode),
  );
  const shipment = parseShipResponse(json);
  if (!shipment) {
    // A 200 with no shipment in it: we can't say whether money moved.
    throw new SourceError("UPS didn't confirm the label.", null, true);
  }
  return shipment;
}

/** Cancels a shipment (every box of it) with UPS. Asking twice is fine. */
export async function voidUpsShipment(
  access: UpsAccess,
  shipmentId: string,
  fetchImpl: Fetch = fetch,
): Promise<void> {
  if (!/^[A-Za-z0-9]{6,40}$/.test(shipmentId)) {
    throw new SourceError("That label can't be found at UPS.", null, false);
  }
  try {
    await ups(
      fetchImpl,
      access,
      "DELETE",
      `/api/shipments/${API_VERSION}/void/cancel/${encodeURIComponent(shipmentId)}`,
    );
  } catch (err) {
    if (err instanceof SourceError && err.status !== null) {
      if (ALREADY_VOIDED.test(err.message)) return;
      if (access.test && PRACTICE_NOT_FOUND.test(err.message)) return;
    }
    throw err;
  }
}

/** Signs in, then asks for one real rate, so a missing product or unlinked account shows up when connecting. */
export async function checkUpsKeys(
  keys: UpsKeys,
  fetchImpl: Fetch = fetch,
): Promise<{ token: string; expiresIn: number }> {
  const signedIn = await fetchUpsToken(keys, fetchImpl);
  const sample: LabelRequest = {
    from: {
      name: "Test",
      street1: "100 Main St",
      city: "New York",
      state: "NY",
      zip: "10001",
      country: "US",
      phone: "2125550100",
    },
    to: {
      name: "Test",
      street1: "200 Main St",
      city: "Los Angeles",
      state: "CA",
      zip: "90001",
      country: "US",
      residential: true,
    },
    parcels: [{ length: 10, width: 8, height: 4, weightTenthOz: 160 }],
    signature: "none",
  };
  try {
    await getUpsRates(
      { token: signedIn.token, account: keys.account, test: keys.test },
      sample,
      fetchImpl,
    );
  } catch (err) {
    // A token we were handed a moment ago and UPS won't take: the app isn't set up for this.
    if (err instanceof StaleTokenError) throw new SourceError(UPS_AUTH_HELP, 401, false);
    throw err;
  }
  return signedIn;
}

// ---------------------------------------------------------------------------
// Address check (US and Puerto Rico)
// ---------------------------------------------------------------------------

const norm = (value: string | undefined) =>
  (value ?? "").toUpperCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
const zip5 = (zip: string | undefined) => (zip ?? "").replace(/\D/g, "").slice(0, 5);

type Spelled = Pick<LabelAddress, "street1" | "street2" | "city" | "state" | "zip">;

/** True when a candidate only differs by formatting, abbreviations or a ZIP+4. */
export function sameAddress(a: Spelled, b: Spelled): boolean {
  const abbr = (value: string) =>
    norm(value)
      .replace(/\bSTREET\b/g, "ST")
      .replace(/\bAVENUE\b/g, "AVE")
      .replace(/\bROAD\b/g, "RD")
      .replace(/\bDRIVE\b/g, "DR")
      .replace(/\bBOULEVARD\b/g, "BLVD")
      .replace(/\bLANE\b/g, "LN")
      .replace(/\bCOURT\b/g, "CT")
      .replace(/\bPLACE\b/g, "PL")
      .replace(/\bAPARTMENT\b/g, "APT")
      .replace(/\bSUITE\b/g, "STE")
      .replace(/\bNORTH\b/g, "N")
      .replace(/\bSOUTH\b/g, "S")
      .replace(/\bEAST\b/g, "E")
      .replace(/\bWEST\b/g, "W");
  const lines = (x: Spelled) => abbr([x.street1, x.street2].filter(Boolean).join(" "));
  return (
    lines(a) === lines(b) &&
    norm(a.city) === norm(b.city) &&
    norm(a.state) === norm(b.state) &&
    zip5(a.zip) === zip5(b.zip)
  );
}

/** UPS checks street addresses in these countries only. */
export const upsChecksAddress = (country: string) =>
  ["US", "PR"].includes((country || "US").toUpperCase());

type Candidate = {
  AddressClassification?: { Code?: unknown };
  AddressKeyFormat?: {
    AddressLine?: string | string[];
    PoliticalDivision2?: string;
    PoliticalDivision1?: string;
    PostcodePrimaryLow?: string;
    PostcodeExtendedLow?: string;
  };
};
type XavResponse = {
  ValidAddressIndicator?: unknown;
  NoCandidatesIndicator?: unknown;
  AddressClassification?: { Code?: unknown };
  Candidate?: Candidate | Candidate[];
};

/** Reads UPS's answer to an address check. No network. */
export function readUpsAddressCheck(sent: LabelAddress, json: unknown): AddressCheck {
  const r = ((json as { XAVResponse?: XavResponse })?.XAVResponse ?? {}) as XavResponse;
  const candidates = asArray(r.Candidate);
  if (r.NoCandidatesIndicator !== undefined || candidates.length === 0) {
    return {
      found: false,
      problem: "UPS couldn't find this address",
      residential: null,
      suggestion: null,
    };
  }
  const first = candidates[0];
  const key = first.AddressKeyFormat ?? {};
  const lines = asArray(key.AddressLine);
  const spelled: Spelled = {
    street1: lines[0] ?? sent.street1,
    street2: lines[1] ?? sent.street2,
    city: key.PoliticalDivision2 ?? sent.city,
    state: key.PoliticalDivision1 ?? sent.state,
    zip: key.PostcodeExtendedLow
      ? `${key.PostcodePrimaryLow}-${key.PostcodeExtendedLow}`
      : (key.PostcodePrimaryLow ?? sent.zip),
  };
  const code = String(first.AddressClassification?.Code ?? r.AddressClassification?.Code ?? "");
  const residential = code === "2" ? true : code === "1" ? false : null;
  if (r.ValidAddressIndicator !== undefined) {
    return {
      found: true,
      problem: "",
      residential,
      suggestion: sameAddress(sent, spelled) ? null : spelled,
    };
  }
  // Several possible matches: not something to buy a label on without a look.
  return {
    found: false,
    problem: "UPS found more than one address this could be",
    residential,
    suggestion: null,
  };
}

/**
 * UPS Address Validation, street level, with home or business. Needs the
 * "Address Validation" product on the UPS developer app. Buys nothing.
 */
export async function validateUpsAddress(
  access: UpsAccess,
  to: LabelAddress,
  fetchImpl: Fetch = fetch,
): Promise<AddressCheck> {
  const json = await ups(fetchImpl, access, "POST", "/api/addressvalidation/v2/3", {
    XAVRequest: {
      AddressKeyFormat: {
        ConsigneeName: trunc(to.company || to.name, 35),
        AddressLine: [to.street1, to.street2].filter(Boolean).map((line) => trunc(line, 35)),
        PoliticalDivision2: to.city,
        PoliticalDivision1: to.state ?? "",
        PostcodePrimaryLow: zip5(to.zip),
        CountryCode: to.country || "US",
      },
    },
  });
  return readUpsAddressCheck(to, json);
}
