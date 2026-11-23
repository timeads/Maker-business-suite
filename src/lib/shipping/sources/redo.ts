import { ReconnectRequiredError, type Fetch } from "../../connections/types";
import {
  carrierName,
  centsToPrice,
  normalizePhone,
  priceToCents,
  type LabelAddress,
  type LabelParcel,
  type Signature,
} from "../easypost";
import { SourceError, poundsOf, type LabelFile, type LabelRequest } from "./types";

/**
 * Redo's shipping labels, through Redo's GraphQL API: quote every carrier
 * connected in Redo, buy, and void. Labels are paid from the Redo
 * outbound-labels balance. Ported from the reference help desk's `redo.ts`.
 *
 * One purchase is one carrier shipment. Some carriers (UPS, FedEx) carry up
 * to five boxes in one; any other needs a shipment per box, so several boxes
 * are quoted box by box and the prices added up.
 *
 * The API token only ever goes in the Authorization header. It is never
 * logged and never part of an error message or a URL.
 */
const TIMEOUT_MS = 20_000;
/** The most boxes Redo takes in one carrier shipment. */
export const REDO_TOGETHER_MAX = 5;
const MAX_LABEL_BYTES = 4_000_000;

export type RedoAccess = { token: string; storeId: string };

// Address fields Redo's input type turned out not to have (learned from its
// validation errors, then left out). About Redo's API, not about any workspace.
const unknownFields = new Set<string>();
/** Tests: forget what was learned. */
export const resetRedoLearned = () => {
  unknownFields.clear();
  signatureCache.clear();
};

/** An enum value (written bare in GraphQL, not quoted). */
class Enum {
  constructor(public v: string) {}
}
const E = (v: string) => new Enum(v);

/** A JS value as a GraphQL input literal: {key: value}, [a b], "string", ENUM. */
export function literal(value: unknown): string {
  if (value instanceof Enum) return value.v;
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(literal).join(" ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([key, item]) => item !== undefined && !unknownFields.has(key))
      .map(([key, item]) => `${key}: ${literal(item)}`)
      .join(" ")}}`;
  }
  return JSON.stringify(value);
}

type GqlError = { message?: unknown; extensions?: { code?: unknown } };

/** Answers that mean "no, and nothing happened". Anything else after a purchase is treated as unknown. */
const REFUSALS = new Set([
  "INSUFFICIENT_FUNDS",
  "INSUFFICIENT_SCOPE",
  "RATE_NOT_FOUND",
  "BAD_USER_INPUT",
  "GRAPHQL_VALIDATION_FAILED",
  "GRAPHQL_PARSE_FAILED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
]);

function redoError(status: number, errors: GqlError[]): Error {
  const first = errors[0] ?? {};
  const code = String(first.extensions?.code ?? "");
  if (status === 401 || code === "UNAUTHENTICATED") {
    return new ReconnectRequiredError(
      "Redo didn't accept your API token. Reconnect Redo under Connections with a current one.",
    );
  }
  if (code === "INSUFFICIENT_SCOPE" || status === 403) {
    return new SourceError(
      "Your Redo token needs the Shipping read and Shipping write permissions. In Redo, open Settings, then Developer, and make a token with both.",
      status,
      false,
    );
  }
  if (code === "INSUFFICIENT_FUNDS") {
    return new SourceError(
      "Your Redo labels balance can't cover this label. Add funds in Redo, then try again.",
      402,
      false,
    );
  }
  if (code === "RATE_NOT_FOUND") {
    return new SourceError(
      "That Redo rate is no longer on offer. Get rates again.",
      status,
      false,
    );
  }
  if (status === 429) {
    return new SourceError("Redo is busy right now. Wait a moment and try again.", status, false);
  }
  if (status >= 500) {
    return new SourceError(
      "Redo is having trouble right now. Try again in a minute.",
      status,
      true,
    );
  }
  const said = (typeof first.message === "string" ? first.message : "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  // A plain 4xx, or an answer Redo names as a refusal, means nothing happened.
  const refused = (status >= 400 && status < 500) || REFUSALS.has(code);
  return new SourceError(
    said ? `Redo says: ${said}` : "Redo couldn't do that. Check the details and try again.",
    status,
    !refused,
  );
}

async function gql<T>(fetchImpl: Fetch, access: RedoAccess, build: () => string): Promise<T> {
  const storeId = access.storeId.trim();
  if (!/^[A-Za-z0-9_-]{4,80}$/.test(storeId) || !access.token) {
    throw new ReconnectRequiredError("Redo needs connecting again under Connections.");
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    let response: Response;
    let json: { data?: unknown; errors?: unknown };
    try {
      response = await fetchImpl(
        `https://api.getredo.com/v3/account/${encodeURIComponent(storeId)}/graphql`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${access.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ query: build() }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
      json = (await response.json().catch(() => ({}))) as typeof json;
    } catch {
      // Deliberately not passing the cause along: it can carry the request.
      throw new SourceError(
        "Redo didn't answer in time. Check your connection and try again.",
        null,
        true,
      );
    }
    const errors = (Array.isArray(json?.errors) ? json.errors : []) as GqlError[];
    if (response.ok && errors.length === 0 && json?.data) return json.data as T;
    // An optional address field Redo doesn't take: nothing was done, so drop it and ask again.
    const missing = errors
      .map((e) => /Field "(\w+)" is not defined by type/.exec(String(e?.message ?? ""))?.[1])
      .find((field) => field && ["phone", "company", "street2", "email"].includes(field));
    if (missing && !unknownFields.has(missing)) {
      unknownFields.add(missing);
      continue;
    }
    throw redoError(response.status, errors);
  }
  throw new SourceError("Redo kept turning the request down. Try again in a minute.", null, false);
}

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

// Redo's address has no company field: a business keeps its name on the label as "Jane Doe, Acme Studio".
const nameLine = (a: LabelAddress) => {
  const name = a.name?.trim() ?? "";
  const company = a.company?.trim() ?? "";
  if (!company || name.toLowerCase().includes(company.toLowerCase())) return name || undefined;
  return (name ? `${name}, ${company}` : company).slice(0, 70);
};

const address = (a: LabelAddress) => ({
  name: nameLine(a),
  street1: a.street1,
  street2: a.street2 || undefined,
  city: a.city,
  state: a.state || undefined,
  zip: a.zip,
  country: (a.country || "US").toUpperCase(),
  phone: normalizePhone(a.phone, a.country) || undefined,
});

const parcel = (p: LabelParcel) => ({
  weight: { unit: E("POUND"), value: Math.max(0.01, Math.round(poundsOf(p) * 100) / 100) },
  length: { unit: E("INCH"), value: Math.max(1, p.length) },
  width: { unit: E("INCH"), value: Math.max(1, p.width) },
  height: { unit: E("INCH"), value: Math.max(0.25, p.height || 0.25) },
});

type Level = Exclude<Signature, "none">;
type Sig = { option: SigOption; level: Level };

function baseRequest(request: LabelRequest, boxes: LabelParcel[], sig?: Sig) {
  const out: Record<string, unknown> = {
    fromAddress: address(request.from),
    toAddress: address(request.to),
    parcels: boxes.map(parcel),
  };
  if (sig && sig.option.where !== "purchase") applySignature(out, sig.option, sig.level);
  return out;
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

type RawRate = {
  carrier: string;
  service: string;
  carrierAccountId: string;
  rate: { amount: string; currency: string };
  deliveryDays?: number | null;
};

async function quote(fetchImpl: Fetch, access: RedoAccess, request: object): Promise<RawRate[]> {
  const data = await gql<{ getShippingLabelQuotes: { rates: RawRate[] | null } | null }>(
    fetchImpl,
    access,
    () =>
      `mutation { getShippingLabelQuotes(input: ${literal(request)}) { rates { carrier service carrierAccountId rate { amount currency } deliveryDays } messages { carrier carrierAccountId message } } }`,
  );
  return (data.getShippingLabelQuotes?.rates ?? []).filter(
    (r) =>
      r &&
      typeof r.carrier === "string" &&
      r.carrier &&
      typeof r.service === "string" &&
      r.service &&
      typeof r.carrierAccountId === "string" &&
      priceToCents(r.rate?.amount) !== null,
  );
}

/** "GroundAdvantage" -> "USPS Ground Advantage", "UPS_GROUND" -> "UPS Ground". */
export function redoServiceName(carrier: string, service: string): string {
  const name = service
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(new RegExp(`^${carrier.replace(/[^A-Za-z0-9 ]/g, "")}\\s+`, "i"), "")
    .toLowerCase()
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .replace(/\bUsps\b/g, "USPS")
    .replace(/\bUps\b/g, "UPS")
    .replace(/\bAm\b/g, "AM")
    .replace(/(\d)day\b/gi, "$1 Day");
  return `${carrierName(carrier)} ${name}`;
}

export type RedoRate = {
  /** "1": every box in one carrier shipment. "n": a shipment per box. */
  mode: "1" | "n";
  carrierAccountId: string;
  /** Redo's own codes, as buying names them. */
  carrierCode: string;
  service: string;
  carrier: string;
  name: string;
  price: string;
  currency: string;
  days: number | null;
  note?: string;
  /** Where the signature goes when buying, for a rate quoted with one. */
  signature?: SigOption;
};

const keyOf = (r: RawRate) => `${r.carrierAccountId}|${r.carrier}|${r.service}`;
const toRate = (mode: "1" | "n", r: RawRate, cents: bigint): RedoRate => ({
  mode,
  carrierAccountId: r.carrierAccountId,
  carrierCode: r.carrier,
  service: r.service,
  carrier: carrierName(r.carrier),
  name: redoServiceName(r.carrier, r.service),
  price: centsToPrice(cents),
  currency: r.rate.currency || "USD",
  days: Number.isInteger(r.deliveryDays) && (r.deliveryDays as number) > 0 ? r.deliveryDays! : null,
});
const centsOf = (r: RawRate) => priceToCents(r.rate.amount) ?? BigInt(0);

/** Redo's usual signature fee, added to quotes when the signature can only go on at purchase. */
export const REDO_SIGNATURE_FEE_CENTS = BigInt(625);

/**
 * What every carrier connected in Redo would charge. With a signature asked
 * for, Redo is only quoted when its API takes one (found by reading its
 * schema); otherwise it offers nothing rather than a price without one.
 */
export async function getRedoRates(
  access: RedoAccess,
  request: LabelRequest,
  fetchImpl: Fetch = fetch,
): Promise<RedoRate[]> {
  const parcels = request.parcels;
  let sig: Sig | undefined;
  if (request.signature !== "none") {
    const option = await redoSignatureOption(access, fetchImpl);
    if (!option) return [];
    sig = { option, level: request.signature };
  }
  let rates: RedoRate[];
  if (parcels.length === 1) {
    rates = (await quote(fetchImpl, access, baseRequest(request, parcels, sig))).map((r) =>
      toRate("1", r, centsOf(r)),
    );
  } else {
    // Several boxes: one shipment for carriers that carry them together, else box by box added up.
    const [together, ...each] = await Promise.all([
      parcels.length <= REDO_TOGETHER_MAX
        ? quote(fetchImpl, access, baseRequest(request, parcels, sig)).catch(() => [] as RawRate[])
        : Promise.resolve([] as RawRate[]),
      ...parcels.map((p) => quote(fetchImpl, access, baseRequest(request, [p], sig))),
    ]);
    rates = together.map((r) => toRate("1", r, centsOf(r)));
    const have = new Set(together.map(keyOf));
    for (const r of each[0] ?? []) {
      if (have.has(keyOf(r))) continue;
      const per = each.map((list) => list.find((x) => keyOf(x) === keyOf(r)));
      // Not offered for every box.
      if (per.some((x) => !x)) continue;
      rates.push(
        toRate(
          "n",
          r,
          per.reduce((sum, x) => sum + centsOf(x!), BigInt(0)),
        ),
      );
    }
  }
  if (!sig) return rates;
  if (sig.option.where !== "purchase") {
    return rates.map((rate) => ({ ...rate, signature: sig.option }));
  }
  // The signature only goes on when buying: Redo's quote leaves its fee out, so its usual fee is added per box.
  const fee = REDO_SIGNATURE_FEE_CENTS * BigInt(parcels.length);
  return rates.map((rate) => ({
    ...rate,
    price: centsToPrice((priceToCents(rate.price) ?? BigInt(0)) + fee),
    signature: sig.option,
    note: `Includes about $${centsToPrice(REDO_SIGNATURE_FEE_CENTS)}${parcels.length > 1 ? " a box" : ""} for the signature, which Redo adds when the label is bought`,
  }));
}

// ---------------------------------------------------------------------------
// Buying and voiding
// ---------------------------------------------------------------------------

type Purchased = {
  shipmentId: string;
  carrier: string;
  service: string;
  rate: { amount: string; currency: string } | null;
  shipmentPackages: { trackingNumber: string | null; labelUrl: string | null }[] | null;
};

export type RedoChoice = {
  mode: "1" | "n";
  carrierAccountId: string;
  carrierCode: string;
  service: string;
};

export type RedoBought = {
  carrierCode: string;
  service: string;
  /** One per box: the shipment it belongs to, its tracking number and where its label is. */
  boxes: { shipmentId: string; trackingNumber: string; labelUrl: string | null }[];
  price: string;
  currency: string;
};

const ID = /^[A-Za-z0-9_-]{4,80}$/;

/**
 * Buys the label, or one per box. This spends from the Redo labels balance.
 * `idempotencyBase` is ours and the same for every try at one purchase, so
 * Redo is never asked for the same label under two names.
 *
 * If a later box fails after earlier ones were bought, those are cancelled
 * so nothing is left half paid for. If one can't be cancelled, the error is
 * marked uncertain: something may have been bought.
 */
export async function buyRedo(
  access: RedoAccess,
  request: LabelRequest,
  choice: RedoChoice,
  idempotencyBase: string,
  signature: SigOption | null,
  fetchImpl: Fetch = fetch,
): Promise<RedoBought> {
  const parcels = request.parcels;
  if (!choice.carrierCode || !choice.service || !choice.carrierAccountId) {
    throw new SourceError("That rate can't be found. Get rates again.", null, false);
  }
  if (choice.mode === "1" && parcels.length > REDO_TOGETHER_MAX) {
    throw new SourceError(
      `Redo carries at most ${REDO_TOGETHER_MAX} boxes in one shipment.`,
      null,
      false,
    );
  }
  let sig: Sig | undefined;
  if (request.signature !== "none") {
    if (!signature) {
      throw new SourceError(
        "Redo can't add a signature to this label. Pick another service, or choose no signature.",
        null,
        false,
      );
    }
    sig = { option: signature, level: request.signature };
  }
  const base = idempotencyBase.replace(/[^\w#-]/g, "").slice(0, 70);
  const groups = choice.mode === "1" ? [parcels] : parcels.map((p) => [p]);
  const bought: Purchased[] = [];
  try {
    for (const [index, boxes] of groups.entries()) {
      const input: Record<string, unknown> = {
        request: baseRequest(request, boxes, sig),
        carrier: choice.carrierCode,
        service: choice.service,
        carrierAccountId: choice.carrierAccountId,
        idempotencyKey: `${base}-${index + 1}`,
      };
      if (sig?.option.where === "purchase") applySignature(input, sig.option, sig.level);
      const data = await gql<{ purchaseCarrierShipment: Purchased | null }>(
        fetchImpl,
        access,
        () =>
          `mutation { purchaseCarrierShipment(input: ${literal(input)}) { shipmentId carrier service rate { amount currency } shipmentPackages { trackingNumber labelUrl } } }`,
      );
      const made = data.purchaseCarrierShipment;
      if (!made || typeof made.shipmentId !== "string" || !ID.test(made.shipmentId)) {
        // A 200 with no shipment in it: we can't say whether money moved.
        throw new SourceError("Redo didn't confirm the label.", null, true);
      }
      bought.push(made);
    }
  } catch (err) {
    // Don't leave some boxes paid for when the rest failed.
    let left = 0;
    for (const made of bought) {
      const undone = await voidRedo(access, [made.shipmentId], fetchImpl).catch(() => null);
      if (!undone || undone.failed > 0) left += 1;
    }
    if (left > 0) {
      throw new SourceError(
        `Redo bought ${left === 1 ? "a label" : `${left} labels`} for this order before something went wrong, and we couldn't cancel ${left === 1 ? "it" : "them"}. Look in Redo and cancel ${left === 1 ? "it" : "them"} there.`,
        null,
        true,
      );
    }
    throw err;
  }
  const total = bought.reduce(
    (sum, made) => sum + (priceToCents(made.rate?.amount) ?? BigInt(0)),
    BigInt(0),
  );
  return {
    carrierCode: bought[0]?.carrier || choice.carrierCode,
    service: bought[0]?.service || choice.service,
    boxes: bought.flatMap((made) =>
      (Array.isArray(made.shipmentPackages) ? made.shipmentPackages : []).map((box) => ({
        shipmentId: made.shipmentId,
        trackingNumber: typeof box?.trackingNumber === "string" ? box.trackingNumber : "",
        labelUrl:
          typeof box?.labelUrl === "string" && box.labelUrl.startsWith("https://")
            ? box.labelUrl
            : null,
      })),
    ),
    price: centsToPrice(total),
    currency: bought[0]?.rate?.currency || "USD",
  };
}

/** What kind of file a label is, from its first bytes. */
export function sniffLabel(bytes: Uint8Array): LabelFile["contentType"] | null {
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return "application/pdf";
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  const head = new TextDecoder().decode(bytes.subarray(0, 64)).trimStart();
  if (head.startsWith("^XA") || head.startsWith("${")) return "text/plain";
  return null;
}

/** Redo's own hosts: the only places the token is ever sent. */
const redoHost = (url: URL) => url.hostname === "getredo.com" || url.hostname.endsWith(".getredo.com");

/**
 * Fetches a bought label's file from the link Redo gave. The token is only
 * offered to Redo's own hosts, and only if the link asks for it. Null when
 * the file can't be had: the label is still bought, and Redo still has it.
 */
export async function downloadRedoLabel(
  access: RedoAccess,
  link: string,
  fetchImpl: Fetch = fetch,
): Promise<Pick<LabelFile, "contentType" | "data"> | null> {
  try {
    const url = new URL(link);
    if (url.protocol !== "https:") return null;
    const get = (headers?: Record<string, string>) =>
      fetchImpl(url.toString(), { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    let response = await get();
    if ((response.status === 401 || response.status === 403) && redoHost(url)) {
      response = await get({ authorization: `Bearer ${access.token}` });
    }
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_LABEL_BYTES) return null;
    const contentType = sniffLabel(bytes);
    if (!contentType) return null;
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return { contentType, data: btoa(binary) };
  } catch {
    return null;
  }
}

/**
 * Cancels each shipment and asks Redo for the refund to the labels balance.
 * Every one is tried even when an earlier one is refused.
 */
export async function voidRedo(
  access: RedoAccess,
  shipmentIds: string[],
  fetchImpl: Fetch = fetch,
): Promise<{ asked: number; failed: number; error: unknown }> {
  let asked = 0;
  let failed = 0;
  let error: unknown = null;
  for (const id of [...new Set(shipmentIds)]) {
    try {
      if (!ID.test(id)) throw new SourceError("That label can't be found at Redo.", null, false);
      const data = await gql<{ voidCarrierShipment: { refundStatus: string | null } | null }>(
        fetchImpl,
        access,
        () =>
          `mutation { voidCarrierShipment(shipmentId: ${JSON.stringify(id)}) { shipmentId refundStatus } }`,
      );
      if (data.voidCarrierShipment?.refundStatus === "REJECTED") {
        throw new SourceError(
          "The carrier wouldn't cancel this label (it may already have been scanned). Ask Redo's support about a refund.",
          409,
          false,
        );
      }
      asked += 1;
    } catch (err) {
      failed += 1;
      error ??= err;
    }
  }
  return { asked, failed, error };
}

const SAMPLE_FROM: LabelAddress = {
  name: "Test",
  street1: "350 5th Ave",
  city: "New York",
  state: "NY",
  zip: "10118",
  country: "US",
};
const SAMPLE_TO: LabelAddress = {
  name: "Test",
  street1: "1600 Pennsylvania Ave NW",
  city: "Washington",
  state: "DC",
  zip: "20500",
  country: "US",
};
const SAMPLE: LabelRequest = {
  from: SAMPLE_FROM,
  to: SAMPLE_TO,
  parcels: [{ length: 10, width: 8, height: 4, weightTenthOz: 320 }],
  signature: "none",
};

/** Checks a token and store id by asking for one sample quote. Buys nothing. */
export async function checkRedo(
  access: RedoAccess,
  fetchImpl: Fetch = fetch,
): Promise<{ rates: number; carriers: string[] }> {
  const rates = await quote(fetchImpl, access, baseRequest(SAMPLE, SAMPLE.parcels));
  return { rates: rates.length, carriers: [...new Set(rates.map((r) => carrierName(r.carrier)))] };
}

// ---------------------------------------------------------------------------
// Signature confirmation. Redo's guide doesn't say where a signature goes,
// so its place is found by asking the API to describe itself.
// ---------------------------------------------------------------------------

const TYPE_REF = "kind name ofType { kind name ofType { kind name ofType { kind name } } }";
type TypeRef = { kind: string; name: string | null; ofType?: TypeRef | null };
const baseName = (t: TypeRef | null | undefined): string | null =>
  !t ? null : (t.name ?? baseName(t.ofType));
const hasList = (t: TypeRef | null | undefined): boolean =>
  Boolean(t) && (t!.kind === "LIST" || hasList(t!.ofType));

/** One step of the path to the signature setting; `list` steps apply to every item (each parcel). */
export type SigStep = { name: string; list: boolean };
/** Where Redo takes a signature: an enum (with its signature and adult values), a yes/no flag, or text. */
export type SigOption = {
  path: SigStep[];
  kind: "enum" | "boolean" | "string";
  standard: string | null;
  adult: string | null;
  adultPath?: SigStep[];
  /** "request": part of the shipment, so quotes include it. "purchase": only when buying. */
  where?: "request" | "purchase";
};
export type SchemaType = {
  name: string;
  kind: string;
  inputFields: { name: string; description: string | null; type: TypeRef }[] | null;
  enumValues: { name: string }[] | null;
};

const SIG = /signat/i;

/**
 * Finds the signature setting inside a request type (breadth first, a few
 * levels deep): a field named for signatures, or a delivery-confirmation
 * enum with a signature value. Pure.
 */
export function findSignatureOption(root: string, types: Map<string, SchemaType>): SigOption | null {
  const queue: { type: string; path: SigStep[] }[] = [{ type: root, path: [] }];
  const seen = new Set<string>();
  while (queue.length) {
    const { type, path } = queue.shift()!;
    if (seen.has(type) || path.length > 4) continue;
    seen.add(type);
    const t = types.get(type);
    for (const f of t?.inputFields ?? []) {
      const base = baseName(f.type);
      const bt = base ? types.get(base) : undefined;
      const step = [...path, { name: f.name, list: hasList(f.type) }];
      const named = SIG.test(f.name) || SIG.test(f.description ?? "");
      if (bt?.kind === "ENUM") {
        const values = (bt.enumValues ?? []).map((v) => v.name);
        const off = /^(NO|NONE|OFF|FALSE|DISABLED?)$|^NO_|NO_?SIGNATURE|NOT_REQUIRED|WAIVE/i;
        // A field named for signatures takes its values as they are; a general
        // confirmation field only its signature values.
        const sigValues = named
          ? values.filter((v) => !off.test(v))
          : values.filter((v) => SIG.test(v) && !off.test(v));
        if ((named || /confirm/i.test(f.name)) && sigValues.length) {
          return {
            path: step,
            kind: "enum",
            standard:
              sigValues.find(
                (v) => /STANDARD|^SIGNATURE|REQUIRED|DIRECT/i.test(v) && !/ADULT|INDIRECT/i.test(v),
              ) ??
              sigValues.find((v) => !/ADULT|INDIRECT/i.test(v)) ??
              sigValues.find((v) => !/ADULT/i.test(v)) ??
              null,
            adult: sigValues.find((v) => /ADULT/i.test(v)) ?? null,
          };
        }
      } else if (base === "String" && SIG.test(f.name) && !/name|image|url|waive/i.test(f.name)) {
        // Free text: the usual carrier words (checked with a test quote before use).
        return { path: step, kind: "string", standard: "SIGNATURE", adult: "ADULT_SIGNATURE" };
      } else if (base === "Boolean" && SIG.test(f.name) && !/adult|no_?sig|waive/i.test(f.name)) {
        const adultField = (t?.inputFields ?? []).find(
          (x) => baseName(x.type) === "Boolean" && /adult/i.test(x.name),
        );
        return {
          path: step,
          kind: "boolean",
          standard: "true",
          adult: adultField ? "true" : null,
          ...(adultField ? { adultPath: [...path, { name: adultField.name, list: false }] } : {}),
        };
      } else if (bt?.kind === "INPUT_OBJECT") {
        queue.push({ type: base!, path: step });
      }
    }
  }
  return null;
}

/** Puts the signature into a request along the option's path (every parcel when the path runs through the list). */
export function applySignature(req: Record<string, unknown>, option: SigOption, level: Level) {
  const pick = (level === "adult" ? (option.adult ?? option.standard) : option.standard) ?? "";
  const value = option.kind === "enum" ? E(pick) : option.kind === "string" ? pick : true;
  const put = (path: SigStep[], v: unknown) => {
    const go = (obj: Record<string, unknown>, i: number) => {
      const step = path[i];
      if (i === path.length - 1) {
        // A list of plain values isn't a setting we can fill.
        if (step.list && Array.isArray(obj[step.name])) return;
        obj[step.name] = v;
        return;
      }
      if (step.list) {
        if (!Array.isArray(obj[step.name])) obj[step.name] = [{}];
        for (const item of obj[step.name] as Record<string, unknown>[]) go(item, i + 1);
      } else {
        obj[step.name] ??= {};
        go(obj[step.name] as Record<string, unknown>, i + 1);
      }
    };
    go(req, 0);
  };
  put(option.path, value);
  if (option.kind === "boolean" && level === "adult" && option.adultPath) put(option.adultPath, true);
}

/** A stored option read back defensively (it travels through the quote as JSON). */
export function readSigOption(value: unknown): SigOption | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const steps = (raw: unknown): SigStep[] | null =>
    Array.isArray(raw) &&
    raw.length >= 1 &&
    raw.length <= 6 &&
    raw.every(
      (s) =>
        s &&
        typeof s === "object" &&
        /^[A-Za-z_][A-Za-z0-9_]{0,60}$/.test(String((s as SigStep).name)) &&
        typeof (s as SigStep).list === "boolean",
    )
      ? (raw as SigStep[]).map((s) => ({ name: s.name, list: s.list }))
      : null;
  const path = steps(o.path);
  const word = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_]{1,60}$/.test(v) ? v : null);
  if (!path || !["enum", "boolean", "string"].includes(String(o.kind))) return null;
  const adultPath = o.adultPath === undefined ? undefined : steps(o.adultPath);
  if (adultPath === null) return null;
  return {
    path,
    kind: o.kind as SigOption["kind"],
    standard: word(o.standard),
    adult: word(o.adult),
    ...(adultPath ? { adultPath } : {}),
    where: o.where === "purchase" ? "purchase" : "request",
  };
}

type SigState = { at: number; option: SigOption | null };
// What Redo's API takes is the same for every store, but it is read with one
// store's token, so each store keeps its own answer. Held in memory only.
const signatureCache = new Map<string, SigState>();
const SIX_HOURS = 6 * 3600_000;

/**
 * Reads Redo's schema to find where a signature goes; null when it can't
 * take one. Remembered for a few hours, and for less when Redo didn't answer.
 */
export async function redoSignatureOption(
  access: RedoAccess,
  fetchImpl: Fetch = fetch,
  now = Date.now(),
): Promise<SigOption | null> {
  const held = signatureCache.get(access.storeId);
  if (held && now - held.at < SIX_HOURS) return held.option;
  try {
    type Op = { name: string; args: { name: string; type: TypeRef }[] };
    const top = await gql<{ __schema: { mutationType: { fields: Op[] } | null } }>(
      fetchImpl,
      access,
      () =>
        `query { __schema { mutationType { fields { name args { name type { ${TYPE_REF} } } } } } }`,
    );
    const ops = top.__schema.mutationType?.fields ?? [];
    const inputOf = (name: string) => {
      const op = ops.find((f) => f.name === name);
      return op ? baseName(op.args.find((a) => a.name === "input")?.type) : null;
    };
    const root = inputOf("getShippingLabelQuotes");
    const buyRoot = inputOf("purchaseCarrierShipment");
    let option: SigOption | null = null;
    if (root) {
      const types = new Map<string, SchemaType>();
      let queue = [root, ...(buyRoot ? [buyRoot] : [])];
      for (let depth = 0; depth < 5 && queue.length; depth++) {
        const names = [...new Set(queue)]
          .filter((n) => !types.has(n) && !/^(String|Int|Float|Boolean|ID)$/.test(n))
          .filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))
          .slice(0, 40);
        if (!names.length) break;
        const data = await gql<Record<string, SchemaType | null>>(
          fetchImpl,
          access,
          () =>
            `query { ${names.map((n, i) => `t${i}: __type(name: ${JSON.stringify(n)}) { name kind inputFields { name description type { ${TYPE_REF} } } enumValues { name } }`).join(" ")} }`,
        );
        queue = [];
        for (const t of Object.values(data)) {
          if (!t) continue;
          types.set(t.name, t);
          for (const f of t.inputFields ?? []) {
            const b = baseName(f.type);
            if (b) queue.push(b);
          }
        }
      }
      option = findSignatureOption(root, types);
      if (option) option.where = "request";
      else if (buyRoot) {
        // Only on the purchase: search its own fields, not the request inside it (already searched).
        const t = types.get(buyRoot);
        if (t) {
          const trimmed = new Map(types);
          trimmed.set(buyRoot, {
            ...t,
            inputFields: (t.inputFields ?? []).filter((f) => f.name !== "request"),
          });
          option = findSignatureOption(buyRoot, trimmed);
          if (option) option.where = "purchase";
        }
      }
    }
    // Make sure Redo takes it: one free test quote with a signature. No label is bought.
    if (option && option.where === "request") {
      try {
        await quote(
          fetchImpl,
          access,
          baseRequest(SAMPLE, SAMPLE.parcels, { option, level: "signature" }),
        );
      } catch {
        option = null;
      }
    }
    signatureCache.set(access.storeId, { at: now, option });
    return option;
  } catch (err) {
    if (err instanceof ReconnectRequiredError) throw err;
    // Redo's schema didn't answer: say "no signature" for now and look again within the hour.
    signatureCache.set(access.storeId, { at: now - SIX_HOURS + 3600_000, option: null });
    return null;
  }
}
