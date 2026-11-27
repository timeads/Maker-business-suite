import { shopItems, type ConnectionFact } from "../setup/connection";
import type { SetupItem, SetupStep } from "../setup/items";
import { hasLiveSupplier, isPlanned, type StockRow, type SupplierRow } from "./plan";

/**
 * "Finish setting up Stock": what still stands between the workspace and
 * order-by dates and suggestions it can trust, worked out on read from what
 * it already has (docs/setup-pattern.md). Pure: the facts come from
 * `setup-data.ts` (or from the rows a Stock page already read, through
 * `stockRowFacts`), and nothing here is stored but a person's "Not now".
 *
 * Required items make the figures truer; optional ones (bringing records
 * across, emailing orders from Gmail, bills by email, selling seasons) are
 * offered on the guided page and never on the card.
 */

export const STOCK_TOOL = "stock";

export const STOCK_STEPS: readonly SetupStep[] = [
  { id: "shop", title: "Your shop" },
  { id: "suppliers", title: "Who you buy from" },
  { id: "planning", title: "How you plan" },
  { id: "costs", title: "What things cost you" },
  { id: "extras", title: "Extras, if you'd like them" },
  { id: "review", title: "Have a look" },
];

export type NamedRef = { id: string; name: string };

export type StockSetupFacts = {
  now: Date;
  shop: ConnectionFact | null;
  /** Items the shop sync brought in (any state). */
  items: number;
  /** Items being planned for (counted by the shop, on sale, not switched off). */
  planned: number;
  /** Planned items with nobody to order from (no supplier, or one no longer used). */
  noSupplier: NamedRef[];
  /** Suppliers still used, with planned items, and no delivery time of their own. */
  suppliersNoLead: NamedRef[];
  /** The planning settings were saved at least once (so the usual figures were chosen). */
  settingsSaved: boolean;
  /** Planned items with no cost from anywhere. Null for anyone who doesn't see costs. */
  costsUnknown: number | null;
  /** Purchase orders of any kind, imported ones included. Null when not known. */
  orders: number | null;
  /** Gmail for emailing orders: offered here (keys set) and connected. */
  gmail: { offered: boolean; connected: boolean };
  /** Bills by email set up. Owners and admins only: null for anyone else. */
  bills: { setUp: boolean } | null;
  /** Selling seasons saved, and whether busy seasons are planned for. */
  seasons: { count: number; seasonality: boolean };
};

/** Share of planned items with no cost above which the item is raised. */
export const COSTS_UNKNOWN_SHARE = 0.2;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ids = (refs: readonly NamedRef[]) =>
  refs
    .map((r) => r.id)
    .sort()
    .join(",");

/**
 * The item facts, from rows `buildStockRows` made (with or without sales:
 * suppliers, costs and the rules that leave items out don't need them).
 * `seesCosts` false: costs aren't read, so none are counted.
 */
export function stockRowFacts(
  rows: readonly StockRow[],
  suppliers: readonly SupplierRow[],
  seesCosts: boolean,
): Pick<StockSetupFacts, "items" | "planned" | "noSupplier" | "suppliersNoLead" | "costsUnknown"> {
  const planned = rows.filter(isPlanned);
  const used = new Set(planned.filter(hasLiveSupplier).map((row) => row.supplier!.id));
  return {
    items: rows.length,
    planned: planned.length,
    noSupplier: planned
      .filter((row) => !hasLiveSupplier(row))
      .map((row) => ({ id: row.item.id, name: row.name })),
    suppliersNoLead: suppliers
      .filter((s) => !s.archived_at && s.lead_time_days === null && used.has(s.id))
      .map((s) => ({ id: s.id, name: s.name })),
    costsUnknown: seesCosts ? planned.filter((row) => row.cost.source === "none").length : null,
  };
}

/** The open items, in the order the guided setup takes them. */
export function stockSetupItems(facts: StockSetupFacts): SetupItem[] {
  const items: SetupItem[] = shopItems(facts.shop, facts.now, {
    what: "Stock reads your items, their counts and your sales from your shop.",
    step: "shop",
    readAgain: "stock/setup#shop",
  });
  const shopOn = facts.shop !== null && facts.shop.status !== "disconnected";

  if (facts.noSupplier.length > 0) {
    items.push({
      id: "suppliers.missing",
      title: `Give ${plural(facts.noSupplier.length, "item")} a supplier`,
      why: "Items with nobody to order from never get a suggested order, so they can run out quietly.",
      count: facts.noSupplier.length,
      names: facts.noSupplier.map((r) => r.name),
      to: "stock/items?show=nosupplier",
      action: "Choose their suppliers",
      // A count, not ids: there can be hundreds.
      facts: String(facts.noSupplier.length),
      step: "suppliers",
      managersOnly: true,
    });
  }
  if (facts.suppliersNoLead.length > 0 && !facts.settingsSaved) {
    const one = facts.suppliersNoLead.length === 1 ? facts.suppliersNoLead[0] : null;
    items.push({
      id: "suppliers.lead",
      title: `Say how long ${plural(facts.suppliersNoLead.length, "supplier")} take${facts.suppliersNoLead.length === 1 ? "s" : ""} to deliver`,
      why: "Order-by dates count back from it. Until you say, they use the usual 30-day guess.",
      count: facts.suppliersNoLead.length,
      names: facts.suppliersNoLead.map((r) => r.name),
      to: one ? `stock/suppliers/${one.id}` : "stock/suppliers",
      action: one ? "Add the days" : "Add their days",
      facts: ids(facts.suppliersNoLead),
      step: "suppliers",
      managersOnly: true,
    });
  }
  if (!facts.settingsSaved && facts.planned > 0) {
    items.push({
      id: "planning.defaults",
      title: "Check your planning figures",
      why: "How long things usually take to arrive, how long an order should last and how often you sit down to order: every order-by date leans on them.",
      to: "stock/setup#planning",
      action: "Check them",
      facts: "never",
      step: "planning",
      managersOnly: true,
    });
  }
  const unknown = facts.costsUnknown ?? 0;
  if (facts.planned > 0 && unknown > 0 && unknown / facts.planned > COSTS_UNKNOWN_SHARE) {
    items.push({
      id: "costs.unknown",
      title: `Add what ${plural(unknown, "item")} cost${unknown === 1 ? "s" : ""} you`,
      why: "Order totals and Spend are worked out from it. Without one, an item counts as costing nothing.",
      count: unknown,
      to: "stock/setup#costs",
      action: "See how",
      facts: String(Math.floor((unknown / facts.planned) * 10)),
      step: "costs",
      managersOnly: true,
    });
  }

  // Optional from here on: offered on the guided page, never on the card.
  if (shopOn && facts.orders === 0) {
    items.push({
      id: "history.import",
      title: "Bring your past orders and suppliers across",
      why: "Past orders show what things really cost and how long suppliers take. Starting fresh works just as well.",
      to: "settings/stock/import",
      action: "Bring them across",
      facts: "none",
      step: "extras",
      optional: true,
      managersOnly: true,
    });
  }
  if (facts.gmail.offered && !facts.gmail.connected) {
    items.push({
      id: "gmail",
      title: "Email orders to suppliers from your own Gmail",
      why: "Send an order with its PDF in one press, from your own address. Downloading the PDF and sending it yourself works too.",
      to: "settings/stock/order-emails",
      action: "Connect Gmail",
      facts: "none",
      step: "extras",
      optional: true,
      managersOnly: true,
    });
  }
  if (facts.bills && !facts.bills.setUp) {
    items.push({
      id: "bills",
      title: "Read suppliers' bills from email into Balances",
      why: "Forwarded invoices and statements are read into what you owe each supplier. Typing them in works too.",
      to: "settings/stock/bills",
      action: "Set it up",
      facts: "none",
      step: "extras",
      optional: true,
      managersOnly: true,
    });
  }
  if (facts.seasons.seasonality && facts.seasons.count === 0 && facts.planned > 0) {
    items.push({
      id: "seasons",
      title: "Plan ahead for your busy seasons",
      why: "Name a season and the day stock should be in by, and each supplier gets a last day to order for it.",
      to: "settings/stock/seasons",
      action: "Add a season",
      facts: "none",
      step: "planning",
      optional: true,
      managersOnly: true,
    });
  }
  return items;
}
