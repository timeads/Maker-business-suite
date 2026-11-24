import type { CarrierMarkKey } from "./order-page";

/**
 * Small things the To ship list says about each order: how old it is, when
 * the list was last read, and what a price leaves over. Pure, and safe in the
 * browser: no network, no database.
 */

/** More rows than this on one screen helps nobody; the chips and the search narrow it. */
export const MOST_SHOWN = 300;

/** How many orders one request works out before answering, so the list never hangs. */
export const PLAN_BATCH = 10;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago an order came in: "just now", "12m ago", "4h ago", "1d ago".
 * After six days it is the date instead, in the workspace's own time zone
 * ("Nov 12", with the year once it isn't this one).
 */
export function orderAge(placedAt: string, now: Date, timeZone: string): string {
  const placed = new Date(placedAt);
  if (Number.isNaN(placed.getTime())) return "";
  const gone = now.getTime() - placed.getTime();
  if (gone < MINUTE) return "just now";
  if (gone < HOUR) return `${Math.floor(gone / MINUTE)}m ago`;
  if (gone < DAY) return `${Math.floor(gone / HOUR)}h ago`;
  if (gone < 6 * DAY) return `${Math.floor(gone / DAY)}d ago`;
  const year = (date: Date) =>
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(date);
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    ...(year(placed) === year(now) ? {} : { year: "numeric" }),
  }).format(placed);
}

/** "Updated now", "Updated 3 min ago", "Updated 2 hr ago": how old the list on screen is. */
export function updatedAgo(sinceMs: number): string {
  const gone = Math.max(0, sinceMs);
  if (gone < MINUTE) return "Updated now";
  if (gone < HOUR) return `Updated ${Math.floor(gone / MINUTE)} min ago`;
  return `Updated ${Math.floor(gone / HOUR)} hr ago`;
}

/**
 * What a label leaves of the shipping the shopper paid, in whole cents.
 * `short` when the label costs more than they were charged. Null when either
 * side isn't known.
 */
export function marginOf(
  paidCents: number | null | undefined,
  costCents: number | null | undefined,
): { cents: number; short: boolean } | null {
  if (paidCents === null || paidCents === undefined || !Number.isFinite(paidCents)) return null;
  if (costCents === null || costCents === undefined || !Number.isFinite(costCents)) return null;
  const left = Math.round(paidCents) - Math.round(costCents);
  return { cents: Math.abs(left), short: left < 0 };
}

/** "+$4.57 margin", or "−$1.20 margin" when the label costs more. */
export const marginText = (
  margin: { cents: number; short: boolean },
  money: (amount: number) => string,
) => `${margin.short ? "−" : "+"}${money(margin.cents / 100)} margin`;

/**
 * A service as the list names it: with its carrier in front, without the
 * "· Redo" some sources add, and the two long USPS names cut short.
 */
export function listService(carrier: string, name: string): string {
  const bare = name.replace(/\s·\s.*$/, "").trim();
  const squashed = carrier.replace(/[^a-z0-9]/gi, "");
  const full =
    squashed && new RegExp(`^${squashed}\\b`, "i").test(bare.replace(/[^a-z0-9 ]/gi, ""))
      ? bare
      : `${carrier} ${bare}`.trim();
  return full
    .replace(/^USPS Priority Mail Express$/i, "USPS Express")
    .replace(/^USPS Priority Mail$/i, "USPS Priority");
}

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
  heavy: "Over 150 lb, which is more than one purchase takes.",
};

/** What one row of the list shows about its plan. Only words: nothing here can be bought. */
export type PlanCell = {
  /** The box the order would go in, when the workspace has one. */
  box: string | null;
  /** Why it's that box: "your choice", "by rule", "remembered". Nothing for the usual box. */
  boxNote: string | null;
  /** The signature the plan asks for. */
  signature?: "none" | "signature" | "adult";
  /** The rules that did something for this order. */
  rules?: string[];
  /** Items and box together ("4 lb 8 oz"), when both are known. */
  weight: string | null;
  quote:
    | {
        state: "ok";
        mark: { key: CarrierMarkKey; label: string };
        /** "UPS Ground" */
        service: string;
        /** "UPS", "Redo", "EasyPost": whose account the price is from. */
        source: string;
        price: string;
        /** The same price in whole cents, for adding up what several labels would cost. */
        cents: number;
        currency: string;
        /** It's the service a rule or a saved choice asked for, not simply the cheapest. */
        byRule: boolean;
        margin: { text: string; short: boolean } | null;
      }
    /** Being worked out now. */
    | { state: "waiting" }
    /** Asked, and no carrier offered a price. */
    | { state: "none" }
    /** Not asked, with why. */
    | { state: "off"; why: string };
  /** What the carriers' address book said, when it was asked. */
  address: "found" | "not_found" | "waiting" | null;
};

/** Nothing known and nothing to ask: an order that's finished, say. */
export const NO_PLAN: PlanCell = {
  box: null,
  boxNote: null,
  weight: null,
  quote: { state: "off", why: "" },
  address: null,
};
