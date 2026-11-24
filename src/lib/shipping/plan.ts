import { createHash, randomBytes } from "node:crypto";
import type { ShippingSettings } from "./config";
import { gramsToTenthOz, type LabelParcel } from "./easypost";
import {
  MAX_TENTH_OZ,
  boxTenthOz,
  missingShipFrom,
  missingShipTo,
  signatureByRule,
  type LabelOrder,
  type SavedBox,
} from "./labels";
import { listService, marginOf, marginText, type PlanCell } from "./list";
import { carrierMark } from "./order-page";
import { formatWeight, isInternational } from "./queue";
import { SOURCE_NAMES, isLabelSource, type LabelSourceKey } from "./sources/types";
import { upsChecksAddress } from "./sources/ups";

/**
 * The To ship list's note on each order: the box it would go in, what that
 * weighs, the best price for it and whether the carriers know the address.
 * Worked out here from the order as it stands; `shipping_order_plans` only
 * remembers the answers that took a carrier to get. No network, no database.
 *
 * A price in the list is for looking at. It has no rate id, so it can never
 * be bought: buying goes through the order page's own quote.
 */

/** How long a price in the list is shown before the carriers are asked again. */
export const QUOTE_LIFETIME_MS = 12 * 60 * 60 * 1000;
/** When nobody offered a price (a carrier was down, say), ask again sooner. */
export const NO_QUOTE_RETRY_MS = 30 * 60 * 1000;
/** An address check that couldn't be made is tried again after this long. */
export const ADDRESS_RETRY_MS = 12 * 60 * 60 * 1000;

/** A row of `shipping_order_plans`, as members read it. */
export type StoredPlan = {
  shipping_order_id: string;
  chosen_box_id: string | null;
  plan_key: string | null;
  quote_status: string | null;
  quote_source: string | null;
  quote_carrier: string | null;
  quote_service: string | null;
  quote_cents: number | null;
  quote_currency: string | null;
  quoted_at: string | null;
  address_key: string | null;
  address_status: string | null;
  address_residential: boolean | null;
  address_checked_at: string | null;
};

export const PLAN_FIELDS =
  "shipping_order_id, chosen_box_id, plan_key, quote_status, quote_source, quote_carrier, quote_service, quote_cents, quote_currency, quoted_at, address_key, address_status, address_residential, address_checked_at";

// ---------------------------------------------------------------------------
// Fingerprints: how a stored answer is tied to the order it was for, without
// keeping the address.
// ---------------------------------------------------------------------------

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .filter(([, item]) => item !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;

const digest = (salt: string, facts: unknown) =>
  createHash("sha256")
    .update(`${salt}\n${JSON.stringify(canonical(facts))}`)
    .digest("hex");

/** A salted fingerprint of some facts. The same facts give a different one each time. */
export function fingerprint(facts: unknown): string {
  const salt = randomBytes(12).toString("hex");
  return `${salt}:${digest(salt, facts)}`;
}

/** Whether a stored fingerprint was made from exactly these facts. */
export function sameFingerprint(stored: unknown, facts: unknown): boolean {
  if (typeof stored !== "string") return false;
  const [salt, hash] = stored.split(":");
  return Boolean(salt && hash) && digest(salt, facts) === hash;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type PlanOrder = LabelOrder & {
  items: { line_id: string; left: number }[];
  weight_grams: number | null;
  pickup: boolean;
};

export type PlanSetup = {
  /** The workspace's boxes, the usual one first. */
  boxes: SavedBox[];
  /** The connected postage accounts. */
  sources: LabelSourceKey[];
  settings: ShippingSettings;
};

/** Why no price is asked for an order. */
export type NoQuote =
  "pickup" | "abroad" | "address" | "source" | "ship_from" | "box" | "weight" | "heavy";

export const NO_QUOTE_WORDS: Record<NoQuote, string> = {
  pickup: "No label needed: this one is being collected.",
  abroad: "International labels aren't quoted here yet.",
  address: "This order needs a full address first.",
  source: "Connect a postage account to see prices here.",
  ship_from: "Finish your ship-from address in Shipping settings to see prices here.",
  box: "Add a box in Shipping settings to see prices here.",
  weight: "The shop hasn't given a weight for these items.",
  heavy: "Over 150 lb, which is more than one box takes.",
};

export type OrderPlan = {
  box: SavedBox | null;
  /** 'person': someone picked this box for this order. */
  boxSource: "default" | "person";
  /** Items plus the box, in tenths of an ounce. Null when either isn't known. */
  weightTenthOz: number | null;
  /** The workspace's rule asks for a signature on this order. */
  signature: boolean;
  /** Why no price is asked; null when one can be. */
  noQuote: NoQuote | null;
  /** Whether the carriers' address book can be asked about this address. */
  canCheck: boolean;
  /** What a price depends on. Fingerprinted, never stored. */
  quoteFacts: unknown;
  /** What an address check depends on. Fingerprinted, never stored. */
  addressFacts: unknown;
};

const tidy = (value: string | null | undefined) =>
  (value ?? "").replace(/\s+/g, " ").trim().toUpperCase();

/** The parts of an address a carrier's answer depends on (not who it's for). */
const addressFacts = (order: LabelOrder, home: string) => [
  tidy(order.address1),
  tidy(order.address2),
  tidy(order.city),
  tidy(order.region),
  tidy(order.postal_code),
  tidy(order.country_code || home),
];

/** Which account would be asked about an address: EasyPost, else UPS (US addresses), else none. */
export function addressChecker(
  sources: LabelSourceKey[],
  country: string,
): "easypost" | "ups" | null {
  if (sources.includes("easypost")) return "easypost";
  return sources.includes("ups") && upsChecksAddress(country) ? "ups" : null;
}

/**
 * The box, weight and signature an order would be quoted with, and whether
 * it can be quoted at all. The box is the one a person picked for this order
 * while it is still on the list, else the workspace's usual box.
 */
export function planFor(
  order: PlanOrder,
  chosenBoxId: string | null | undefined,
  orderTotal: number | string | null | undefined,
  setup: PlanSetup,
): OrderPlan {
  const home = setup.settings.ship_from_country;
  const chosen = chosenBoxId ? setup.boxes.find((box) => box.id === chosenBoxId) : undefined;
  const box = chosen ?? setup.boxes[0] ?? null;
  const boxSource = chosen && chosen.id !== setup.boxes[0]?.id ? "person" : "default";
  const contents =
    order.weight_grams && Number(order.weight_grams) > 0
      ? gramsToTenthOz(Number(order.weight_grams))
      : null;
  const weightTenthOz = contents !== null && box ? contents + boxTenthOz(box) : null;
  const signature = signatureByRule(
    orderTotal === null || orderTotal === undefined ? null : Number(orderTotal),
    setup.settings.signature_over,
  );
  const abroad = isInternational(order.country_code, home);
  const whole = missingShipTo(order).length === 0;
  const country = (order.country_code || home).toUpperCase();

  const noQuote: NoQuote | null = order.pickup
    ? "pickup"
    : abroad
      ? "abroad"
      : !whole
        ? "address"
        : setup.sources.length === 0
          ? "source"
          : missingShipFrom(setup.settings).length > 0
            ? "ship_from"
            : !box
              ? "box"
              : weightTenthOz === null
                ? "weight"
                : weightTenthOz > MAX_TENTH_OZ
                  ? "heavy"
                  : null;

  const to = addressFacts(order, home);
  const from = setup.settings.ship_from;
  return {
    box,
    boxSource,
    weightTenthOz,
    signature,
    noQuote,
    canCheck: !order.pickup && !abroad && whole && addressChecker(setup.sources, country) !== null,
    quoteFacts: {
      v: 1,
      to,
      items: order.items
        .filter((item) => item.left > 0)
        .map((item) => [item.line_id, item.left])
        .sort(([a], [b]) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)),
      grams: order.weight_grams === null ? null : Number(order.weight_grams),
      box: box
        ? [
            box.id,
            Number(box.length_in),
            Number(box.width_in),
            Number(box.height_in),
            boxTenthOz(box),
          ]
        : null,
      signature,
      from: [
        tidy(from.address1),
        tidy(from.city),
        tidy(from.region),
        tidy(from.postal_code),
        tidy(home),
      ],
      sources: [...setup.sources].sort(),
    },
    addressFacts: { v: 1, to },
  };
}

/** The one box a plan is quoted with. Call only when `noQuote` is null. */
export const planParcel = (plan: OrderPlan): LabelParcel => ({
  length: Number(plan.box!.length_in),
  width: Number(plan.box!.width_in),
  height: Number(plan.box!.height_in),
  weightTenthOz: plan.weightTenthOz!,
});

const age = (at: string | null, now: Date) => {
  const when = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(when) ? now.getTime() - when : Number.POSITIVE_INFINITY;
};

/**
 * Whether the stored price still stands: it was asked for exactly this plan
 * (same address, items left, weight, box, signature) and isn't old.
 */
export function quoteFresh(stored: StoredPlan | null | undefined, plan: OrderPlan, now: Date) {
  if (!stored || !stored.quote_status || !sameFingerprint(stored.plan_key, plan.quoteFacts)) {
    return false;
  }
  const gone = age(stored.quoted_at, now);
  return gone >= 0 && gone < (stored.quote_status === "ok" ? QUOTE_LIFETIME_MS : NO_QUOTE_RETRY_MS);
}

/**
 * Whether the address needs no asking: the carriers already answered for
 * this very address (that answer is kept for good), or a check that couldn't
 * be made was tried recently.
 */
export function addressSettled(stored: StoredPlan | null | undefined, plan: OrderPlan, now: Date) {
  if (!stored || !stored.address_status) return false;
  if (!sameFingerprint(stored.address_key, plan.addressFacts)) return false;
  if (stored.address_status === "found" || stored.address_status === "not_found") return true;
  const gone = age(stored.address_checked_at, now);
  return gone >= 0 && gone < ADDRESS_RETRY_MS;
}

/** Whether a carrier has to be asked something before this order's row is complete. */
export const needsPlanning = (stored: StoredPlan | null | undefined, plan: OrderPlan, now: Date) =>
  (plan.canCheck && !addressSettled(stored, plan, now)) ||
  (!plan.noQuote && !quoteFresh(stored, plan, now));

/** Tenths of an ounce as a weight a person packing would say. */
export const formatPlanWeight = (tenths: number, imperial: boolean) =>
  formatWeight(Math.max(1, Math.round(tenths * 2.8349523125)), imperial);

/**
 * What the list shows for one order. `willFill`: the page is about to ask
 * for whatever is missing, so a gap reads as "working it out" instead of "–".
 */
export function planCell(
  plan: OrderPlan,
  stored: StoredPlan | null | undefined,
  show: {
    now: Date;
    willFill: boolean;
    /** What the shopper paid for shipping, in cents, when known. */
    paidCents: number | null;
    /** The workspace's currency: a margin is only said in it. */
    currency: string;
    imperial: boolean;
    money: (amount: number, currency: string) => string;
  },
): PlanCell {
  let quote: PlanCell["quote"];
  if (plan.noQuote) {
    quote = { state: "off", why: NO_QUOTE_WORDS[plan.noQuote] };
  } else if (quoteFresh(stored, plan, show.now) && stored) {
    const currency = stored.quote_currency ?? show.currency;
    if (
      stored.quote_status === "ok" &&
      stored.quote_cents !== null &&
      stored.quote_carrier &&
      isLabelSource(stored.quote_source)
    ) {
      const margin =
        currency === show.currency ? marginOf(show.paidCents, stored.quote_cents) : null;
      quote = {
        state: "ok",
        mark: carrierMark(stored.quote_carrier),
        service: listService(stored.quote_carrier, stored.quote_service ?? ""),
        source: SOURCE_NAMES[stored.quote_source],
        price: show.money(stored.quote_cents / 100, currency),
        margin: margin
          ? {
              text: marginText(margin, (amount) => show.money(amount, currency)),
              short: margin.short,
            }
          : null,
      };
    } else {
      quote = { state: "none" };
    }
  } else {
    quote = show.willFill
      ? { state: "waiting" }
      : { state: "off", why: "Not worked out yet. Open the order to see prices." };
  }

  let address: PlanCell["address"] = null;
  if (plan.canCheck) {
    if (addressSettled(stored, plan, show.now)) {
      address =
        stored?.address_status === "found"
          ? "found"
          : stored?.address_status === "not_found"
            ? "not_found"
            : null;
    } else if (show.willFill) {
      address = "waiting";
    }
  }

  return {
    box: plan.box?.name ?? null,
    boxNote: plan.box && plan.boxSource === "person" ? "your choice" : null,
    weight:
      plan.weightTenthOz === null ? null : formatPlanWeight(plan.weightTenthOz, show.imperial),
    quote,
    address,
  };
}
