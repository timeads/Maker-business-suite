import type { ShopPermission } from "../connections/shop-permission";
import { shopItems, type ConnectionFact } from "../setup/connection";
import type { SetupItem, SetupStep } from "../setup/items";
import { hasAddress } from "./carriers";
import { isInternational } from "./queue";
import { SOURCE_NAMES, type LabelSourceKey } from "./sources/types";

/**
 * "Finish setting up Shipping": what still stands between the workspace and
 * labels priced right and parcels that go out smoothly, worked out on read
 * (docs/setup-pattern.md). Pure: the facts come from `setup-data.ts`, or from
 * what the To ship list already read through `shippingOrderFacts`. Nothing
 * is stored but a person's "Not now".
 *
 * Required items stop labels being priced or bought right; optional ones
 * (a postage account, the shop's permission, the slip, rules) are offered on
 * the guided page only. How a computer prints is that computer's own choice
 * and never an item here (the guided page mentions it).
 */

export const SHIPPING_TOOL = "shipping";

export const SHIPPING_STEPS: readonly SetupStep[] = [
  { id: "shop", title: "Your shop and its orders" },
  { id: "from", title: "Where parcels leave from" },
  { id: "boxes", title: "The boxes you pack in" },
  { id: "labels", title: "Buying labels" },
  { id: "slip", title: "Your packing slip" },
  { id: "rules", title: "Rules, if you'd like them" },
  { id: "review", title: "Have a look" },
];

/** Open orders as the checklist sees them: no addresses, only counts. */
export type ShippingOrderFacts = {
  /** Orders still to post (not collected, not going abroad). */
  toPost: number;
  /** Of those, with no address to send to. */
  noAddress: number;
  /** Of those with an address, with no weight from the shop for the order or every item. */
  noWeight: number;
};

export type ShippingSetupFacts = {
  now: Date;
  shop: ConnectionFact | null;
  /** Orders from the shop in the last 30 days, and how many reached Shipping. Null when not known. */
  recent: { shop: number; shipping: number } | null;
  open: ShippingOrderFacts | null;
  /** What the ship-from address still lacks (`missingShipFrom`). */
  shipFromMissing: string[];
  boxes: { count: number; usualMarked: boolean };
  postage: {
    active: LabelSourceKey[];
    needsReconnect: LabelSourceKey[];
    testMode: LabelSourceKey[];
  };
  /** The shop's permission to be told a parcel went. */
  permission: ShopPermission;
  slip: { saved: boolean; logoWanted: boolean; logo: boolean };
  rules: { count: number; signatureOver: number | null };
};

/** Raised when at least this many open orders lack an address or weight… */
export const ORDERS_MIN = 3;
/** …and they are at least this share of what's waiting. */
export const ORDERS_SHARE = 0.2;

/** The order facts, from open orders as the list reads them. */
export function shippingOrderFacts(
  orders: readonly {
    pickup: boolean;
    country_code: string | null;
    address1: string | null;
    recipient: string | null;
    weight_grams: number | string | null;
    items: { left: number; grams?: number | string | null }[];
  }[],
  homeCountry: string,
): ShippingOrderFacts {
  const toPost = orders.filter((o) => !o.pickup && !isInternational(o.country_code, homeCountry));
  const addressed = toPost.filter((o) => hasAddress(o));
  const known = (n: number | string | null | undefined) =>
    n !== null && n !== undefined && Number(n) > 0;
  return {
    toPost: toPost.length,
    noAddress: toPost.length - addressed.length,
    noWeight: addressed.filter(
      (o) => !known(o.weight_grams) && o.items.some((item) => item.left > 0 && !known(item.grams)),
    ).length,
  };
}

const many = (n: number, of: number) => n >= ORDERS_MIN && n / Math.max(1, of) >= ORDERS_SHARE;
const names = (keys: readonly LabelSourceKey[]) => keys.map((key) => SOURCE_NAMES[key]);
const list = (words: readonly string[]) =>
  words.length <= 1
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;

/** The open items, in the order the guided setup takes them. */
export function shippingSetupItems(facts: ShippingSetupFacts): SetupItem[] {
  const items: SetupItem[] = shopItems(facts.shop, facts.now, {
    what: "Shipping reads the orders waiting to go, and where they're going, from your shop.",
    step: "shop",
    readAgain: "connections",
  });
  const shopOn = facts.shop?.status === "active";

  if (shopOn && facts.recent && facts.recent.shop >= ORDERS_MIN && facts.recent.shipping === 0) {
    items.push({
      id: "shop.addresses",
      title: "Your shop isn't sharing delivery addresses yet",
      why: "Addresses are read on their own, apart from sales. Without them there's nothing here to pack or post; your sales still come through for Money.",
      to: "shipping/setup#shop",
      action: "See what to do",
      facts: "none",
      step: "shop",
      managersOnly: true,
    });
  } else if (facts.open && many(facts.open.noAddress, facts.open.toPost)) {
    items.push({
      id: "orders.no-address",
      title: `${facts.open.noAddress} orders waiting have no address`,
      why: "A label can't be priced or bought without one. If it's most of them, your shop may not be sharing addresses.",
      count: facts.open.noAddress,
      to: "shipping/setup#shop",
      action: "See what to do",
      facts: String(Math.floor((facts.open.noAddress / Math.max(1, facts.open.toPost)) * 10)),
      step: "shop",
      managersOnly: true,
    });
  }

  if (facts.shipFromMissing.length > 0) {
    items.push({
      id: "from.address",
      title: "Finish your ship-from address",
      why: "Carriers need it to price and print a label, and the packing slip prints it as your return address.",
      names: facts.shipFromMissing,
      to: "shipping/setup#from",
      action: "Fill it in",
      facts: facts.shipFromMissing.join(","),
      step: "from",
      managersOnly: true,
    });
  }

  if (facts.boxes.count === 0) {
    items.push({
      id: "boxes.none",
      title: "Add the boxes you pack in",
      why: "A label is priced for a box. With none saved, no order can be quoted and every one starts from scratch.",
      to: "shipping/setup#boxes",
      action: "Add a box",
      facts: "none",
      step: "boxes",
      managersOnly: true,
    });
  } else if (facts.boxes.count > 1 && !facts.boxes.usualMarked) {
    items.push({
      id: "boxes.usual",
      title: "Choose your usual box",
      why: "Orders start in it when nothing else decides. Until you choose, it's the first box you added.",
      to: "shipping/setup#boxes",
      action: "Choose it",
      facts: String(facts.boxes.count),
      step: "boxes",
      managersOnly: true,
    });
  }

  const { postage } = facts;
  if (postage.needsReconnect.length > 0) {
    items.push({
      id: "labels.reconnect",
      title: `${list(names(postage.needsReconnect))} needs connecting again`,
      why: "Its saved key has stopped working, so it can't price or buy labels.",
      to: "connections",
      action: "Connect it again",
      facts: [...postage.needsReconnect].sort().join(","),
      step: "labels",
      managersOnly: true,
    });
  }
  if (postage.testMode.length > 0) {
    items.push({
      id: "labels.practice",
      title: `${list(names(postage.testMode))} is buying practice labels`,
      why: "Practice labels can't be posted. Connect it with your live key when you're ready to send for real.",
      to: "connections",
      action: "Use the live key",
      facts: [...postage.testMode].sort().join(","),
      step: "labels",
      managersOnly: true,
    });
  }
  if (
    postage.active.length > 0 &&
    facts.boxes.count > 0 &&
    facts.open &&
    many(facts.open.noWeight, facts.open.toPost - facts.open.noAddress)
  ) {
    items.push({
      id: "weights.missing",
      title: `${facts.open.noWeight} orders waiting have items with no weight`,
      why: "Prices are worked out from the weight. Add weights to those products in your shop and they come across with the next read.",
      count: facts.open.noWeight,
      to: "shipping/setup#labels",
      action: "See how",
      facts: String(
        Math.floor(
          (facts.open.noWeight / Math.max(1, facts.open.toPost - facts.open.noAddress)) * 10,
        ),
      ),
      step: "labels",
    });
  }

  // Optional from here on: offered on the guided page, never on the card.
  if (postage.active.length === 0 && postage.needsReconnect.length === 0) {
    items.push({
      id: "labels.none",
      title: "Connect a postage account to buy labels here",
      why: "EasyPost, your own UPS account or Redo. If you buy labels elsewhere and only record parcels by hand, that works too.",
      to: "connections",
      action: "Connect one",
      facts: "none",
      step: "labels",
      optional: true,
      managersOnly: true,
    });
  }
  if (
    shopOn &&
    (facts.permission.state === "not_granted" || facts.permission.state === "asked_not_granted")
  ) {
    items.push({
      id: "shop.permission",
      title: "Let us tell your shop when a parcel goes",
      why: "Then the order is marked as sent there and the customer gets their tracking. Without it, mark orders as sent in your shop yourself.",
      to: "settings/shipping#shop-permission",
      action: "See the permission",
      facts: facts.permission.state,
      step: "shop",
      optional: true,
      managersOnly: true,
    });
  }
  if (!facts.slip.saved || (facts.slip.logoWanted && !facts.slip.logo)) {
    items.push({
      id: "slip.layout",
      title: facts.slip.saved ? "Add your logo to the packing slip" : "Make the packing slip yours",
      why: facts.slip.saved
        ? "Tag a picture “logo” in Social → Assets and it prints at the top of every slip."
        : "Add your logo, a thank-you note, and choose what it shows. The usual slip works fine as it is.",
      to: facts.slip.saved ? "social/library" : "settings/shipping/slip",
      action: facts.slip.saved ? "Add a logo" : "Design the slip",
      facts: `${facts.slip.saved ? "saved" : "never"}:${facts.slip.logo ? "logo" : "none"}`,
      step: "slip",
      optional: true,
      managersOnly: true,
    });
  }
  if (facts.rules.count === 0 && facts.rules.signatureOver === null) {
    items.push({
      id: "rules",
      title: "Set rules for boxes, signatures and holds",
      why: "Say once that big orders need a signature, or that a certain item goes in a certain box, and every order follows.",
      to: "settings/shipping/rules",
      action: "Add a rule",
      facts: "none",
      step: "rules",
      optional: true,
      managersOnly: true,
    });
  }
  return items;
}
