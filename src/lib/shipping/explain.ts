import type { ShippingSettings } from "./config";
import { boxSize, type SavedBox } from "./labels";
import { NO_QUOTE_WORDS } from "./list";
import { QUOTE_LIFETIME_MS, type OrderPlan } from "./plan";
import { formatHoldDate, holdState } from "./queue";
import { SOURCE_NAMES, type LabelSourceKey } from "./sources/types";

/**
 * "How this is worked out" for an order's plan: which box and why (the
 * order `planFor` takes them in), its weight, the best price and margin, the
 * signature and any hold. Plain words built only from the plan `planFor`
 * made and the workspace's settings, so they say what the page shows and
 * can't drift from it. Pure, no model.
 */

const list = (words: readonly string[]) =>
  words.length <= 1
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;

/** The order boxes are chosen in, as one sentence (`planFor`'s own order). */
export const BOX_ORDER_WORDS =
  "The first of these that applies decides the boxes: what you saved for this order, a rule's box, how you packed exactly these items before, the box used for the same products in other amounts, then your usual box.";

/** What "remember how I pack" is set to, when it isn't the usual (both on). */
function rememberWords(settings: Pick<ShippingSettings, "remember_packing">): string[] {
  const remember = settings.remember_packing;
  if (remember.exact && remember.similar) return [];
  if (!remember.exact && !remember.similar) {
    return ["Remembering how you pack is switched off, so earlier orders aren't looked at."];
  }
  return [
    remember.exact
      ? "Only orders with exactly the same items are remembered; similar ones aren't."
      : "Orders with exactly the same items aren't remembered; similar ones are.",
  ];
}

/** How any order's boxes are chosen, for the guided setup. */
export function packingExplained(
  settings: Pick<ShippingSettings, "remember_packing">,
  boxes: readonly SavedBox[],
): string[] {
  const usual = boxes.find((box) => box.is_default) ?? boxes[0];
  return [
    BOX_ORDER_WORDS,
    ...rememberWords(settings),
    usual
      ? `Your usual box is ${usual.name}${usual.is_default ? "" : " (the first you added, since none is marked)"}.`
      : "There's no box saved yet.",
  ];
}

const boxName = (box: OrderPlan["boxes"][number]) =>
  box.box?.name ?? boxSize({ length_in: box.length, width_in: box.width, height_in: box.height });

/** Why the order starts in the boxes it does, and where its weight comes from. */
export function boxExplained(
  plan: OrderPlan,
  setup: { boxes: readonly SavedBox[]; settings: Pick<ShippingSettings, "remember_packing"> },
): string[] {
  const out = [BOX_ORDER_WORDS];
  const first = plan.boxes[0];
  const which = plan.boxes.map(boxName);
  switch (plan.boxSource) {
    case "saved":
    case "person":
      out.push(`This order goes in what you chose for it: ${list(which)}.`);
      break;
    case "rule":
      out.push(`A rule chose the box: ${list(which)}.`);
      break;
    case "learned":
      out.push(
        `You've sent exactly these items before, so it starts the same way: ${list(which)}.`,
      );
      break;
    case "learned-similar":
      out.push(
        `You've sent these products before in other amounts, so it starts in the same box: ${list(which)}.`,
      );
      break;
    case "default":
      if (!first) out.push("There's no box saved yet, so none can be chosen.");
      else {
        const usual = setup.boxes[0];
        out.push(
          usual && !usual.is_default
            ? `It's in ${boxName(first)}, the first box you added, since none is marked as your usual box.`
            : `It's in your usual box, ${boxName(first)}.`,
        );
      }
      break;
  }
  out.push(...rememberWords(setup.settings));
  if (plan.boxes.length > 0) {
    out.push(
      plan.weightTenthOz === null
        ? "The weight isn't known: your shop gave none for some of these items."
        : plan.boxes.every((box) => box.weighed)
          ? "The weight is what was weighed for it before."
          : "The weight is your shop's weight for the items, plus the empty box.",
    );
  }
  return out;
}

/** How the best price and the margin are found. `costs`: the person sees margins. */
export function quoteExplained(
  plan: OrderPlan,
  opts: { sources: readonly LabelSourceKey[]; costs: boolean },
): string[] {
  if (plan.noQuote) return [NO_QUOTE_WORDS[plan.noQuote]];
  const who = list(opts.sources.map((key) => SOURCE_NAMES[key]));
  const service =
    plan.service === null || plan.service === "cheapest"
      ? "the cheapest is shown"
      : `${plan.serviceFrom === "saved" ? "you chose" : "a rule asks for"} ${
          plan.service === "fastest" ? "the fastest" : plan.service
        }, so that's the one shown`;
  const out = [
    `Prices are asked of ${who} for these boxes, weights and address, and ${service}.`,
    `A price is kept for ${Math.round(QUOTE_LIFETIME_MS / 3_600_000)} hours, or until something about the order changes. The list's price is only for looking; buying always asks again.`,
  ];
  if (opts.costs) {
    out.push("The margin is what the customer paid for shipping, less the label's price.");
  }
  return out;
}

/** Why a signature is asked for, or isn't. */
export function signatureExplained(
  plan: OrderPlan,
  opts: { signatureOver: number | null; total: number | null; money: (n: number) => string },
): string[] {
  const kind = plan.signatureKind === "adult" ? "an adult's signature" : "a signature";
  if (plan.signatureFrom === "saved") {
    return [
      plan.signatureKind === "none"
        ? "You chose no signature for this order."
        : `You chose ${kind} for this order.`,
      ...(plan.signatureRule ? [`Your choice wins over the rule “${plan.signatureRule}”.`] : []),
    ];
  }
  if (plan.signatureFrom === "rule" && plan.signatureRule) {
    return [`The rule “${plan.signatureRule}” asks for ${kind}.`];
  }
  if (opts.signatureOver !== null) {
    return [
      `Orders of ${opts.money(opts.signatureOver)} or more need a signature. ${
        opts.total === null
          ? "This one has no total to go by, so it doesn't."
          : `This one comes to ${opts.money(opts.total)}, so it doesn't.`
      }`,
    ];
  }
  return ["No rule asks for a signature, so none is asked for unless you choose one."];
}

/** Why an order is on hold, or back from it. */
export function holdExplained(
  order: {
    on_hold: boolean;
    hold_until: string | null;
    hold_reason: string;
    rule_hold_settled_at?: string | null;
  },
  plan: Pick<OrderPlan, "ruleHold">,
  today: string,
): string[] {
  const state = holdState(order, today);
  if (state === "back") {
    return ["Its hold ended, so it's back with the orders ready to go."];
  }
  if (state === "held") {
    const out = [
      order.hold_reason ? `It's on hold: ${order.hold_reason}.` : "It's on hold.",
      order.hold_until
        ? `It comes back by itself on ${formatHoldDate(order.hold_until)}.`
        : "It stays on hold until someone releases it.",
    ];
    if (plan.ruleHold && order.hold_reason === plan.ruleHold.slice(0, 300)) {
      out.push("A rule held it. Once someone releases it, no rule holds it again.");
    }
    return out;
  }
  if (plan.ruleHold && !order.rule_hold_settled_at) {
    return [`A rule says to hold it: ${plan.ruleHold}.`];
  }
  return ["It isn't on hold."];
}
