import { NO_QUOTE_WORDS, type NoQuote, type PlanCell } from "./list";

/**
 * Buying labels for several ticked orders at once: which orders may go, what
 * the run would cost, and when a fresh price is too far from the one a
 * person saw. Pure: no network, no database, safe in the browser.
 *
 * Every order in a run is still bought on its own, through the same claim →
 * buy → keep → record steps as a single label. This file only decides what is
 * offered; the server checks it all again for each order as it buys.
 */

/** The most orders one run takes. */
export const BULK_LIMIT = 25;

/** What a run looks at about an order before it will buy for it. */
export type BulkOrderFacts = {
  cancelled: boolean;
  unitsLeft: number;
  pickedUp: boolean;
  /** Where a hold stands today (see `holdState`). */
  hold: "none" | "held" | "back";
  /** A rule says to hold this order and nobody has released it yet: the note. */
  ruleHold: string | null;
  paid: boolean;
  pickup: boolean;
  abroad: boolean;
  /** Some of it has already gone. */
  partSent: boolean;
  /** A label for it is being bought, or was bought and isn't a parcel yet. */
  labelOpen: boolean;
  /** It is waiting to go in one parcel with these other orders (or could). */
  togetherWith: string[];
};

/** Why a run leaves an order out, from the order itself. Null: nothing against it. */
export function orderRefusal(order: BulkOrderFacts): string | null {
  if (order.cancelled) return "It was cancelled.";
  if (order.unitsLeft <= 0 || order.pickedUp) return "Everything on it has already gone.";
  if (order.labelOpen)
    return "A label for it is already being sorted out. Open the order to finish it.";
  if (order.hold === "held") return "It's on hold.";
  if (order.ruleHold !== null) return `A rule holds it: ${order.ruleHold}`;
  if (!order.paid) return "It hasn't been paid for yet.";
  if (order.pickup) return "It's being collected, so it needs no label.";
  if (order.abroad) return "It's going abroad, which needs a customs form.";
  if (order.partSent) return "Part of it has already gone. Open the order to send the rest.";
  if (order.togetherWith.length > 0) {
    return `It could go in one parcel with ${order.togetherWith.join(" and ")}. Ship them together, or say “not now” first.`;
  }
  return null;
}

/** What a run looks at about an order's plan. */
export type BulkPlanFacts = {
  noQuote: NoQuote | null;
  /** Whether the carriers' address book can be asked about this address at all. */
  canCheck: boolean;
  /** What it said: only "found" lets an order through when it can be asked. */
  address: "found" | "not_found" | "unchecked";
  /** The list's price for this very plan: "ok" when one stands, "none" when nobody offered, "missing" when not worked out or out of date. */
  quote: "ok" | "none" | "missing";
};

const ADDRESS_NOT_FOUND = "The carriers don't know its address. Open the order and look it over.";

/** Why a run leaves an order out, from its plan. Null: nothing against it. */
export function planRefusal(plan: BulkPlanFacts): string | null {
  if (plan.noQuote) return NO_QUOTE_WORDS[plan.noQuote];
  if (plan.canCheck && plan.address === "not_found") return ADDRESS_NOT_FOUND;
  if (plan.canCheck && plan.address !== "found") {
    return "Its address hasn't been checked yet. Give the list a moment, or open the order.";
  }
  if (plan.quote === "none") return "No carrier offered a price for its box and weight.";
  if (plan.quote !== "ok") return "Its price hasn't been worked out yet. Give the list a moment.";
  return null;
}

/** The same, from what the list has on screen for a row. The server decides again when buying. */
export function cellRefusal(cell: PlanCell): string | null {
  if (cell.address === "not_found") return ADDRESS_NOT_FOUND;
  if (cell.address === "waiting" || cell.quote.state === "waiting") {
    return "Its box, price and address are still being worked out.";
  }
  if (cell.quote.state === "off") return cell.quote.why || "It has no price yet.";
  if (cell.quote.state === "none") return "No carrier offered a price for its box and weight.";
  return null;
}

export type BulkRow = {
  id: string;
  name: string;
  /** Why it is left out; null when it can be bought. */
  refusal: string | null;
  /** The planned best price, in whole cents. */
  cents: number | null;
  currency: string | null;
};

export type BulkEstimate = {
  /** The orders a run would buy for, in list order, the limit applied. */
  buy: BulkRow[];
  /** Left out, each with why. */
  leftOut: { id: string; name: string; why: string }[];
  /** What the labels would cost together, when they are all priced in one currency. */
  cents: number | null;
  currency: string | null;
};

/** What "Buy N labels · about $X" stands for. */
export function bulkEstimate(rows: BulkRow[], limit: number = BULK_LIMIT): BulkEstimate {
  const buy: BulkRow[] = [];
  const leftOut: BulkEstimate["leftOut"] = [];
  for (const row of rows) {
    if (row.refusal) leftOut.push({ id: row.id, name: row.name, why: row.refusal });
    else if (row.cents === null || !row.currency) {
      leftOut.push({ id: row.id, name: row.name, why: "It has no price yet." });
    } else if (buy.length >= limit) {
      leftOut.push({
        id: row.id,
        name: row.name,
        why: `One run buys up to ${limit} labels. Buy these, then tick the rest.`,
      });
    } else buy.push(row);
  }
  const currencies = new Set(buy.map((row) => row.currency));
  const one = currencies.size === 1;
  return {
    buy,
    leftOut,
    cents: one ? buy.reduce((sum, row) => sum + (row.cents ?? 0), 0) : null,
    currency: one ? buy[0].currency : null,
  };
}

/**
 * Whether the price a carrier gives now is too far above the one the person
 * saw on the list to buy without them: more than a quarter and a dollar on
 * top. A price that went down, or moved a little, is bought.
 */
export function priceMoved(estimateCents: number, freshCents: number): boolean {
  return freshCents > Math.round(estimateCents * 1.25) + 100;
}

/** What became of one order in a run. */
export type BulkOutcome =
  | {
      status: "bought";
      /** "UPS Ground" */
      service: string;
      /** The price as the carrier gave it ("9.43"). */
      price: string;
      currency: string;
      /** The parcel's number here. */
      number: number;
    }
  | { status: "skipped"; reason: string }
  /** Money was or may have been spent and the parcel isn't recorded: it is under "Labels to finish" on the order. */
  | { status: "unsure"; reason: string };

/** "3 labels bought · $28.40", "Nothing was bought". */
export function runSummary(
  outcomes: BulkOutcome[],
  money: (amount: number, currency: string) => string,
): string {
  const bought = outcomes.filter(
    (outcome): outcome is Extract<BulkOutcome, { status: "bought" }> => outcome.status === "bought",
  );
  if (bought.length === 0) return "Nothing was bought";
  const currencies = new Set(bought.map((outcome) => outcome.currency));
  const total = bought.reduce((sum, outcome) => sum + Math.round(Number(outcome.price) * 100), 0);
  return `${bought.length === 1 ? "1 label" : `${bought.length} labels`} bought${
    currencies.size === 1 && Number.isFinite(total)
      ? ` · ${money(total / 100, bought[0].currency)}`
      : ""
  }`;
}
