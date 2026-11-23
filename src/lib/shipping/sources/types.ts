import type {
  BoughtLabel,
  LabelAddress,
  LabelKind,
  LabelMode,
  LabelParcel,
  LabelRate,
  Signature,
} from "../easypost";

/**
 * The places a workspace can buy postage. Each is an ordinary optional
 * connection; a workspace may have any of them, or none.
 */
export const LABEL_SOURCES = ["easypost", "ups", "redo"] as const;
export type LabelSourceKey = (typeof LABEL_SOURCES)[number];
export const isLabelSource = (value: unknown): value is LabelSourceKey =>
  LABEL_SOURCES.includes(value as LabelSourceKey);

/** How each source is named to a person. */
export const SOURCE_NAMES: Record<LabelSourceKey, string> = {
  easypost: "EasyPost",
  ups: "UPS",
  redo: "Redo",
};

/** The small tag beside a price saying where the label would be bought. */
export const SOURCE_CHIPS: Record<LabelSourceKey, string> = {
  easypost: "via EasyPost",
  ups: "your UPS account",
  redo: "via Redo",
};

/** Whose money pays for it, for the line under the Buy button. */
export const SOURCE_PAID_FROM: Record<LabelSourceKey, string> = {
  easypost: "your EasyPost account",
  ups: "your UPS account",
  redo: "your Redo labels balance",
};

/** Everything a carrier needs to price or make a label. Never stored. */
export type LabelRequest = {
  from: LabelAddress;
  to: LabelAddress;
  /** One to six boxes. */
  parcels: LabelParcel[];
  reference?: string;
  signature: Signature;
  /**
   * "zpl" when the computer asking prints straight to a Zebra: the label is
   * asked for in the printer's own format instead of as a picture. Left out
   * otherwise, so a request for a picture is exactly what it always was. Part
   * of what is fingerprinted: what is bought is the format that was priced.
   */
  labelFormat?: "zpl";
};

/**
 * A price from one source, as the server keeps it on the quote. `ref` holds
 * the source's own ids: what buying this exact rate needs, and nothing a
 * browser ever sends.
 */
export type SourceRate = LabelRate & {
  source: LabelSourceKey;
  ref: Record<string, string>;
  /** A word on the price, e.g. a fee the source adds when the label is bought. */
  note?: string;
};

/** The same service from another connected source, for comparison. */
export type OtherPrice = { source: LabelSourceKey; price: string };

/** One row of the merged list. */
export type MergedRate = SourceRate & { others?: OtherPrice[] };

export type SourceQuote = {
  rates: SourceRate[];
  /** Only where the source says: null means it has no test mode to report. */
  mode: LabelMode | null;
  /** The source's own id for what was quoted, when it keeps one (EasyPost). */
  shipmentId: string | null;
  /** Why there are no rates, when the source can say. */
  note?: string;
};

/** A label's own file, for sources that hand back the image rather than a link. */
export type LabelFile = {
  /** Which box it is for, counting from 1. */
  box: number;
  contentType: "image/gif" | "image/png" | "application/pdf" | "text/plain";
  /** Base64. */
  data: string;
};

export type SourceLabel = BoughtLabel & { source: LabelSourceKey; files: LabelFile[] };

export type Purchase = {
  /** The rate exactly as the server stored it when it was quoted. */
  rate: Partial<SourceRate> & { id: string };
  /** What `provider_shipment_id` holds on the quote. */
  shipmentId: string;
  kind: LabelKind;
  /** Our own id for the quote: a purchase is made once per quote, ever. */
  quoteId: string;
  /** Rebuilt by the server and checked against the quote; EasyPost keeps its own. */
  request: LabelRequest | null;
};

export type Refunds = { asked: number; failed: number; error: unknown };

/**
 * A source said no, or didn't answer. `message` is safe to show a person.
 * `uncertain` means we can't tell whether the request went through: after a
 * purchase, never assume nothing was bought.
 */
export class SourceError extends Error {
  constructor(
    message: string,
    public status: number | null,
    public uncertain: boolean,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

/** The source took the saved sign-in badly; a fresh one may work. Tried once. */
export class StaleTokenError extends Error {
  constructor() {
    super("The saved sign-in is out of date");
    this.name = "StaleTokenError";
  }
}

/** This source can't be asked what became of a purchase. */
export class CannotLookUpError extends Error {
  constructor(public source: LabelSourceKey) {
    super(`${SOURCE_NAMES[source]} can't be asked about a label`);
    this.name = "CannotLookUpError";
  }
}

/**
 * One place to buy postage. Rating, buying, settling a purchase we never
 * heard back about, and getting the money back all go through this.
 * `Access` is what the source needs to sign in, read from Vault by the caller.
 */
export interface LabelSource<Access> {
  key: LabelSourceKey;
  name: string;
  /** Whether `lookUp` can settle a purchase we never heard back about. */
  canLookUp: boolean;
  /** The most boxes one purchase can cover here. */
  maxBoxes: number;
  /** `quoteRef` is ours: it makes each rate's id belong to this quote alone. */
  quote(access: Access, request: LabelRequest, quoteRef: string): Promise<SourceQuote>;
  /** Spends money. */
  buy(access: Access, purchase: Purchase): Promise<SourceLabel>;
  lookUp(
    access: Access,
    what: { kind: LabelKind; shipmentId: string },
  ): Promise<{ label: SourceLabel | null }>;
  /** Voids or asks for a refund on each of a purchase's shipments. */
  refund(access: Access, shipmentIds: string[]): Promise<Refunds>;
}

/** FNV-1a over the text, 64 bits, as sixteen hex digits. Not a secret: just a short stable name. */
export function shortHash(value: string): string {
  let hash = BigInt("0xcbf29ce484222325");
  const prime = BigInt("0x100000001b3");
  const mask = BigInt("0xffffffffffffffff");
  for (const byte of new TextEncoder().encode(value)) {
    hash = ((hash ^ BigInt(byte)) * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Pounds, as carriers that don't count ounces want them. */
export const poundsOf = (parcel: LabelParcel) =>
  Math.max(1, Math.round(parcel.weightTenthOz)) / 160;
