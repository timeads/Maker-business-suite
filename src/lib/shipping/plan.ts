import { createHash, randomBytes } from "node:crypto";
import { parseSavedChoice, type SavedChoice } from "./choices";
import type { ShippingSettings } from "./config";
import { gramsToTenthOz, type LabelParcel, type Signature } from "./easypost";
import {
  MAX_TENTH_OZ,
  boxSize,
  boxTenthOz,
  missingShipFrom,
  missingShipTo,
  type LabelOrder,
  type SavedBox,
} from "./labels";
import {
  NO_QUOTE_WORDS,
  listService,
  marginOf,
  marginText,
  type NoQuote,
  type PlanCell,
} from "./list";

export { NO_QUOTE_WORDS, type NoQuote };
import {
  allocFromMemory,
  itemsKey,
  productsKey,
  type MemoryItem,
  type PackingMemory,
} from "./memory";
import { carrierMark } from "./order-page";
import type { Alloc } from "./packing";
import { evaluateRules, type RuleOrder, type ShippingRule } from "./rules";
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
  /** The price is for the service a rule (or a saved choice) asked for, not simply the cheapest. */
  quote_by_rule?: boolean | null;
  /** What a person set up for this order on its page (see `choices.ts`). */
  saved_choice?: unknown;
};

export const PLAN_FIELDS =
  "shipping_order_id, chosen_box_id, plan_key, quote_status, quote_source, quote_carrier, quote_service, quote_cents, quote_currency, quoted_at, address_key, address_status, address_residential, address_checked_at, quote_by_rule, saved_choice";

/** What a person decided for an order, from its stored plan. */
export const choiceOf = (stored: StoredPlan | null | undefined): PlanChoice => ({
  boxId: stored?.chosen_box_id ?? null,
  saved: parseSavedChoice(stored?.saved_choice),
});

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

export type PlanItem = {
  line_id: string;
  left: number;
  qty?: number;
  title?: string | null;
  variant?: string | null;
  sku?: string | null;
  /** One unit's weight in grams, when the shop gave one. */
  grams?: number | null;
};

export type PlanOrder = LabelOrder & {
  items: PlanItem[];
  weight_grams: number | null;
  pickup: boolean;
  /** The option picked at checkout: rules can look at it. */
  shipping_method?: string | null;
};

export type PlanSetup = {
  /** The workspace's boxes, the usual one first. */
  boxes: SavedBox[];
  /** The connected postage accounts. */
  sources: LabelSourceKey[];
  settings: ShippingSettings;
  /** The workspace's shipping rules, top to bottom. */
  rules?: readonly ShippingRule[];
  /** What the workspace remembers about how it packs. */
  memory?: PackingMemory;
  /** How the older signature setting is named among the rules ("Signature on orders of $250.00 or more"). */
  signatureName?: string;
};

/** What a person decided for this one order. */
export type PlanChoice = {
  /** The one box picked for it (the older, smaller memory). */
  boxId?: string | null;
  /** Everything set up on its page: boxes, weights, split, signature, service. */
  saved?: SavedChoice | null;
};

/**
 * Where the boxes came from, strongest first: what a person saved for this
 * order ("saved", or the one box they picked: "person"), a rule's box, the
 * packing used last time for exactly these items ("learned"), the box used
 * for the same products in other quantities ("learned-similar"), else the
 * workspace's usual box.
 */
export type BoxSource = "default" | "person" | "rule" | "learned" | "learned-similar" | "saved";

/** One box of a plan. */
export type PlanBox = {
  /** The saved box, when it is one (and still on the list). */
  box: SavedBox | null;
  /** Inches. */
  length: number;
  width: number;
  height: number;
  /** Packed, in tenths of an ounce. Null when it can't be worked out. */
  weightTenthOz: number | null;
  /** A weight a person typed or the scale gave last time, not one worked out from the shop's figures. */
  weighed: boolean;
  /** Units of each line in this box, by line id. */
  items: Alloc;
};

export type OrderPlan = {
  /** The first box, when it is a saved one. */
  box: SavedBox | null;
  boxSource: BoxSource;
  /** Every box, in order. Empty when the workspace has no box to start from. */
  boxes: PlanBox[];
  /** All the boxes together, in tenths of an ounce. Null when any isn't known. */
  weightTenthOz: number | null;
  /** A signature is asked for on this order. */
  signature: boolean;
  /** Which kind. */
  signatureKind: Signature;
  /** Who decided the signature: a rule, or the person who saved a choice. Null: nobody, so none. */
  signatureFrom: "rule" | "saved" | null;
  /** The rule that asked for the signature, even when a saved choice overrode it. */
  signatureRule: string | null;
  /** "cheapest", "fastest" or a service's name. Null: the cheapest. */
  service: string | null;
  serviceFrom: "rule" | "saved" | null;
  /** The note, when a rule says to hold this order. */
  ruleHold: string | null;
  /** Every rule that did something for this order, in order. */
  rules: string[];
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

/** An order as a rule sees it. */
export const ruleOrder = (
  order: PlanOrder,
  orderTotal: number | string | null | undefined,
  home: string,
): RuleOrder => ({
  items: order.items.map((item) => ({
    title: item.title ?? "",
    sku: item.sku ?? null,
    qty: item.qty ?? item.left,
  })),
  total:
    orderTotal === null || orderTotal === undefined || !Number.isFinite(Number(orderTotal))
      ? null
      : Number(orderTotal),
  region: order.region,
  country: order.country_code || home,
  shippingMethod: order.shipping_method ?? null,
});

/** The lines still to go, as packing memory keys them. */
export const memoryItems = (order: Pick<PlanOrder, "items">): MemoryItem[] =>
  order.items
    .filter((item) => item.left > 0)
    .map((item) => ({
      line_id: item.line_id,
      title: item.title,
      variant: item.variant,
      sku: item.sku,
      qty: item.left,
    }));

/** Nothing of this order has gone yet: what is left is what was ordered. */
export const isWholeOrder = (order: Pick<PlanOrder, "items">) =>
  order.items.every((item) => item.qty === undefined || item.left >= item.qty);

const sized = (box: SavedBox) => ({
  length: Number(box.length_in),
  width: Number(box.width_in),
  height: Number(box.height_in),
});

/**
 * The boxes, weights, signature and service an order would be quoted and
 * bought with, and whether it can be quoted at all. Strongest first:
 * what a person saved for this order → a rule's box → the packing used last
 * time for exactly these items (every box, the split, the weights) → the box
 * used for the same products in other quantities → the usual box.
 *
 * `chosen` is the box a person picked (an id, as before), or everything they
 * decided for this order.
 */
export function planFor(
  order: PlanOrder,
  chosen: string | null | undefined | PlanChoice,
  orderTotal: number | string | null | undefined,
  setup: PlanSetup,
): OrderPlan {
  const home = setup.settings.ship_from_country;
  const choice: PlanChoice =
    chosen && typeof chosen === "object" ? chosen : { boxId: chosen ?? null };
  const saved = choice.saved ?? null;
  const usual = setup.boxes[0] ?? null;
  const byId = new Map(setup.boxes.map((box) => [box.id, box]));
  const lines = order.items.filter((item) => item.left > 0);
  const everything: Alloc = Object.fromEntries(lines.map((item) => [item.line_id, item.left]));
  const picked = choice.boxId ? byId.get(choice.boxId) : undefined;
  const learning = setup.settings.remember_packing ?? { exact: true, similar: true };

  const ruled = evaluateRules(ruleOrder(order, orderTotal, home), setup.rules ?? [], {
    signatureOver: setup.settings.signature_over,
    name: setup.signatureName,
  });
  const ruleBox = ruled.packageName
    ? setup.boxes.find((box) => box.name.trim().toLowerCase() === ruled.packageName!.toLowerCase())
    : undefined;
  const items = memoryItems(order);
  const remembered =
    learning.exact && setup.memory && items.length > 0
      ? setup.memory.exact.get(itemsKey(items))
      : undefined;
  const near =
    learning.similar && !remembered && setup.memory && items.length > 0
      ? setup.memory.similar.get(productsKey(items))
      : undefined;

  const one = (box: SavedBox | null): PlanBox[] =>
    box ? [{ box, ...sized(box), weightTenthOz: null, weighed: false, items: everything }] : [];
  let boxes: PlanBox[];
  let boxSource: BoxSource = "default";
  if (saved) {
    boxSource = "saved";
    const left = new Map(lines.map((item) => [item.line_id, item.left]));
    boxes = saved.boxes.map((box) => {
      const inside: Alloc = {};
      for (const item of lines) {
        const take = Math.min(box.items[item.line_id] ?? 0, left.get(item.line_id) ?? 0);
        inside[item.line_id] = take;
        left.set(item.line_id, (left.get(item.line_id) ?? 0) - take);
      }
      return {
        box: box.box_id ? (byId.get(box.box_id) ?? null) : null,
        length: box.length,
        width: box.width,
        height: box.height,
        weightTenthOz: box.weight_tenth_oz,
        weighed: box.weight_tenth_oz !== null,
        items: inside,
      };
    });
    // Lines added to the order since it was saved go in the first box.
    for (const [lineId, count] of left) {
      if (count > 0) boxes[0].items[lineId] = (boxes[0].items[lineId] ?? 0) + count;
    }
  } else if (picked && picked.id !== usual?.id) {
    boxSource = "person";
    boxes = one(picked);
  } else if (ruleBox) {
    boxSource = "rule";
    boxes = one(ruleBox);
  } else if (remembered) {
    // Same items as before: same boxes, same split, same weights.
    boxSource = "learned";
    const allocs = allocFromMemory(remembered, items);
    boxes = remembered.boxes.map((box, index) => ({
      box: box.box_id ? (byId.get(box.box_id) ?? null) : null,
      length: box.length,
      width: box.width,
      height: box.height,
      weightTenthOz: box.weight_tenth_oz > 0 ? box.weight_tenth_oz : null,
      weighed: box.weight_tenth_oz > 0,
      items: allocs[index],
    }));
  } else if (near && near.boxes.length === 1) {
    // Same products in other quantities: that box again; the weight comes from the shop's figures.
    boxSource = "learned-similar";
    const box = near.boxes[0];
    boxes = [
      {
        box: box.box_id ? (byId.get(box.box_id) ?? null) : null,
        length: box.length,
        width: box.width,
        height: box.height,
        weightTenthOz: null,
        weighed: false,
        items: everything,
      },
    ];
  } else {
    boxes = one(usual);
  }

  // Weights nobody weighed come from the shop: the order's own figure when one box holds it
  // all, else each item's.
  const whole =
    order.weight_grams && Number(order.weight_grams) > 0
      ? gramsToTenthOz(Number(order.weight_grams))
      : null;
  const unit = new Map(
    lines.map((item) => [
      item.line_id,
      item.grams && Number(item.grams) > 0 ? gramsToTenthOz(Number(item.grams)) : null,
    ]),
  );
  boxes = boxes.map((box) => {
    if (box.weightTenthOz !== null) return box;
    const empty = box.box ? boxTenthOz(box.box) : 0;
    if (boxes.length === 1 && whole !== null) return { ...box, weightTenthOz: whole + empty };
    let contents = 0;
    for (const [lineId, count] of Object.entries(box.items)) {
      if (count <= 0) continue;
      const each = unit.get(lineId);
      if (each === null || each === undefined) return box;
      contents += each * count;
    }
    return boxes.length === 1 && contents === 0
      ? box
      : { ...box, weightTenthOz: Math.max(1, contents + empty) };
  });
  const weightTenthOz =
    boxes.length > 0 && boxes.every((box) => box.weightTenthOz !== null)
      ? boxes.reduce((sum, box) => sum + box.weightTenthOz!, 0)
      : null;

  // A person's own choice always wins over a rule, "no signature" included.
  const ruleSignature: Signature =
    ruled.signature === "adult" ? "adult" : ruled.signature === "standard" ? "signature" : "none";
  const signatureKind: Signature = saved?.signature ?? ruleSignature;
  const signatureFrom = saved?.signature ? "saved" : ruled.signature ? "rule" : null;
  const service = saved?.service ?? ruled.service;
  const serviceFrom = saved?.service ? "saved" : ruled.service ? "rule" : null;

  const abroad = isInternational(order.country_code, home);
  const full = missingShipTo(order).length === 0;
  const country = (order.country_code || home).toUpperCase();

  const noQuote: NoQuote | null = order.pickup
    ? "pickup"
    : abroad
      ? "abroad"
      : !full
        ? "address"
        : setup.sources.length === 0
          ? "source"
          : missingShipFrom(setup.settings).length > 0
            ? "ship_from"
            : boxes.length === 0
              ? "box"
              : weightTenthOz === null
                ? "weight"
                : weightTenthOz > MAX_TENTH_OZ ||
                    boxes.some((box) => box.weightTenthOz! > MAX_TENTH_OZ)
                  ? "heavy"
                  : null;

  const to = addressFacts(order, home);
  const from = setup.settings.ship_from;
  return {
    box: boxes[0]?.box ?? null,
    boxSource,
    boxes,
    weightTenthOz,
    signature: signatureKind !== "none",
    signatureKind,
    signatureFrom,
    signatureRule: ruled.signatureRule,
    service,
    serviceFrom,
    ruleHold: ruled.hold,
    rules: ruled.matched,
    noQuote,
    canCheck: !order.pickup && !abroad && full && addressChecker(setup.sources, country) !== null,
    quoteFacts: {
      v: 2,
      to,
      items: lines
        .map((item) => [item.line_id, item.left])
        .sort(([a], [b]) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)),
      grams: order.weight_grams === null ? null : Number(order.weight_grams),
      boxes: boxes.map((box) => [
        box.box?.id ?? null,
        box.length,
        box.width,
        box.height,
        box.weightTenthOz,
      ]),
      signature: signatureKind,
      service: service ? service.trim().toLowerCase() : null,
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

/** Every box a plan is quoted with. Call only when `noQuote` is null. */
export const planParcels = (plan: OrderPlan): LabelParcel[] =>
  plan.boxes.map((box) => ({
    length: box.length,
    width: box.width,
    height: box.height,
    weightTenthOz: box.weightTenthOz!,
  }));

/** The first box a plan is quoted with. Call only when `noQuote` is null. */
export const planParcel = (plan: OrderPlan): LabelParcel => planParcels(plan)[0];

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

/** The small word under a box's name saying why it is that box. */
export const BOX_NOTES: Record<BoxSource, string | null> = {
  default: null,
  person: "your choice",
  saved: "your choice",
  rule: "by rule",
  learned: "remembered",
  "learned-similar": "remembered · similar order",
};

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
        cents: stored.quote_cents,
        currency,
        byRule: Boolean(stored.quote_by_rule) && plan.serviceFrom !== null,
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

  const first = plan.boxes[0];
  const boxName = (box: PlanBox) =>
    box.box?.name ?? boxSize({ length_in: box.length, width_in: box.width, height_in: box.height });
  return {
    box: !first
      ? null
      : plan.boxes.length === 1
        ? boxName(first)
        : `${plan.boxes.length} boxes: ${plan.boxes.map(boxName).join(" + ")}`,
    boxNote: first ? BOX_NOTES[plan.boxSource] : null,
    signature: plan.signatureKind,
    rules: plan.rules,
    weight:
      plan.weightTenthOz === null ? null : formatPlanWeight(plan.weightTenthOz, show.imperial),
    quote,
    address,
  };
}
