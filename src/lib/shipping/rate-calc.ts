import {
  MAX_TENTH_OZ,
  boxTenthOz,
  deliveryDays,
  parseInches,
  parcelFrom,
  type SavedBox,
} from "./labels";
import { isSignature, priceToCents, type LabelAddress, type Signature } from "./easypost";
import { carrierMark, type CarrierMarkKey } from "./order-page";
import type { LabelRequest, LabelSourceKey, MergedRate } from "./sources/types";

/**
 * The rate calculator: what a parcel would cost from one ZIP to another, on
 * every connected postage account. Ported from the reference help desk's
 * calculator. Pure: no network, no database, safe in the browser.
 *
 * Its answers are words. No rate id leaves the server and nothing is kept in
 * `shipping_label_quotes`, so a price from here can never be bought.
 */

/** First three digits of a US ZIP, and the state they are in (USPS sectional centres). */
const RANGES: [number, number, string][] = [
  [5, 5, "NY"],
  [6, 7, "PR"],
  [8, 8, "VI"],
  [9, 9, "PR"],
  [10, 27, "MA"],
  [28, 29, "RI"],
  [30, 38, "NH"],
  [39, 49, "ME"],
  [50, 54, "VT"],
  [55, 55, "MA"],
  [56, 59, "VT"],
  [60, 69, "CT"],
  [70, 89, "NJ"],
  [90, 99, "AE"],
  [100, 149, "NY"],
  [150, 196, "PA"],
  [197, 199, "DE"],
  [200, 200, "DC"],
  [201, 201, "VA"],
  [202, 205, "DC"],
  [206, 219, "MD"],
  [220, 246, "VA"],
  [247, 268, "WV"],
  [270, 289, "NC"],
  [290, 299, "SC"],
  [300, 319, "GA"],
  [320, 339, "FL"],
  [340, 340, "AA"],
  [341, 349, "FL"],
  [350, 369, "AL"],
  [370, 385, "TN"],
  [386, 397, "MS"],
  [398, 399, "GA"],
  [400, 427, "KY"],
  [430, 459, "OH"],
  [460, 479, "IN"],
  [480, 499, "MI"],
  [500, 528, "IA"],
  [530, 549, "WI"],
  [550, 567, "MN"],
  [569, 569, "DC"],
  [570, 577, "SD"],
  [580, 588, "ND"],
  [590, 599, "MT"],
  [600, 629, "IL"],
  [630, 658, "MO"],
  [660, 679, "KS"],
  [680, 693, "NE"],
  [700, 714, "LA"],
  [716, 729, "AR"],
  [730, 732, "OK"],
  [733, 733, "TX"],
  [734, 749, "OK"],
  [750, 799, "TX"],
  [800, 816, "CO"],
  [820, 831, "WY"],
  [832, 838, "ID"],
  [840, 847, "UT"],
  [850, 865, "AZ"],
  [870, 884, "NM"],
  [885, 885, "TX"],
  [889, 898, "NV"],
  [900, 961, "CA"],
  [962, 966, "AP"],
  [967, 968, "HI"],
  [969, 969, "GU"],
  [970, 979, "OR"],
  [980, 994, "WA"],
  [995, 999, "AK"],
];

/** The state a US ZIP is in, or null when it isn't a ZIP. Enough for a price; not for a label. */
export function stateForZip(zip: string): string | null {
  const match = /^(\d{3})\d{2}(?:-?\d{4})?$/.exec(String(zip ?? "").trim());
  if (!match) return null;
  const prefix = Number(match[1]);
  return RANGES.find(([from, to]) => prefix >= from && prefix <= to)?.[2] ?? null;
}

/** What the calculator's form says. */
export type CalcInput = {
  /** Empty: the workspace's own ship-from address. */
  fromZip: string;
  toZip: string;
  weightLb: string;
  weightOz: string;
  /** A saved box's id, or empty for a size typed in. */
  boxId: string;
  length: string;
  width: string;
  height: string;
  residential: boolean;
  /** "none", "signature" or "adult". */
  signature: string;
};

/** A ZIP on its own as an address: carriers price by ZIP, so no street or town is asked for. */
const zipAddress = (zip: string, state: string, residential?: boolean): LabelAddress => ({
  name: "Rate quote",
  street1: "",
  city: "",
  state,
  zip: zip.trim().slice(0, 5),
  country: "US",
  ...(residential === undefined ? {} : { residential }),
});

/**
 * What the carriers are asked. The destination is only ever a ZIP; the
 * ship-from is the workspace's own address unless another ZIP was typed. A
 * saved box's own weight is added to what was typed, as on a real label.
 */
export function calcRequest(
  input: CalcInput,
  home: LabelAddress,
  boxes: SavedBox[],
): { request: LabelRequest; boxName: string | null } | { error: string } {
  const toState = stateForZip(input.toZip);
  if (!toState) return { error: "Enter the 5-digit US ZIP it's going to." };
  if ((home.country || "US").toUpperCase() !== "US") {
    return { error: "The calculator prices parcels within the US for now." };
  }
  let from = home;
  const typed = String(input.fromZip ?? "").trim();
  if (typed && typed.slice(0, 5) !== home.zip.trim().slice(0, 5)) {
    const fromState = stateForZip(typed);
    if (!fromState) return { error: "Enter a 5-digit US ZIP for where it ships from." };
    from = { ...home, ...zipAddress(typed, fromState), name: home.name, phone: home.phone };
  } else if (!stateForZip(home.zip)) {
    return {
      error: "Type the ZIP it ships from, or finish your ship-from address in Shipping settings.",
    };
  }
  const box = input.boxId ? (boxes.find((each) => each.id === input.boxId) ?? null) : null;
  if (input.boxId && !box) return { error: "That box isn't on your list any more. Pick another." };
  if (!box && [input.length, input.width, input.height].some((v) => parseInches(v) === null)) {
    return { error: "Pick a box, or type its size in inches." };
  }
  const parsed = parcelFrom({
    box,
    length: input.length,
    width: input.width,
    height: input.height,
    weightLb: input.weightLb,
    weightOz: input.weightOz,
  });
  if ("error" in parsed) return { error: parsed.error };
  // What was typed is what goes in the box; a saved box's own weight counts too.
  const weightTenthOz = parsed.parcel.weightTenthOz + (box ? boxTenthOz(box) : 0);
  if (weightTenthOz > MAX_TENTH_OZ) {
    return { error: "That's over 150 lb, which is more than these carriers take in one box." };
  }
  return {
    boxName: box?.name ?? null,
    request: {
      from,
      to: zipAddress(input.toZip, toState, input.residential !== false),
      parcels: [{ ...parsed.parcel, weightTenthOz }],
      signature: (isSignature(input.signature) ? input.signature : "none") as Signature,
    },
  };
}

/** One price, as words: what the page shows. There is nothing here to buy with. */
export type CalcRow = {
  carrier: string;
  mark: { key: CarrierMarkKey; label: string };
  service: string;
  price: string;
  currency: string;
  /** "About 3 days", or empty when the carrier didn't say. */
  days: string;
  source: LabelSourceKey;
  cheapest: boolean;
  fastest: boolean;
  /** What the other connected accounts would charge for the same service. */
  others: { source: LabelSourceKey; price: string }[];
  note: string;
};

/** The merged price list as rows of words, cheapest first, with the cheapest and fastest marked. */
export function calcRows(rates: MergedRate[]): CalcRow[] {
  const priced = rates
    .map((rate) => ({ rate, cents: priceToCents(rate.price) }))
    .filter((each): each is { rate: MergedRate; cents: bigint } => each.cents !== null)
    .sort((a, b) => (a.cents < b.cents ? -1 : a.cents > b.cents ? 1 : 0));
  if (priced.length === 0) return [];
  const least = priced[0].cents;
  const quickest = Math.min(...priced.map((each) => each.rate.days ?? Number.POSITIVE_INFINITY));
  return priced.map(({ rate, cents }) => ({
    carrier: rate.carrier,
    mark: carrierMark(rate.carrier),
    service: rate.name,
    price: rate.price,
    currency: rate.currency,
    days: rate.days ? `About ${deliveryDays(rate.days)}` : "",
    source: rate.source,
    cheapest: cents === least,
    fastest: rate.days !== null && Number.isFinite(quickest) && rate.days === quickest,
    others: (rate.others ?? []).map((other) => ({ source: other.source, price: other.price })),
    note: rate.note ?? "",
  }));
}
