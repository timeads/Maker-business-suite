import { describe, expect, it } from "vitest";
import { DEFAULT_SHIPPING_SETTINGS, type ShippingSettings } from "./config";
import type { SavedBox } from "./labels";
import {
  ADDRESS_RETRY_MS,
  NO_QUOTE_RETRY_MS,
  QUOTE_LIFETIME_MS,
  addressChecker,
  addressSettled,
  fingerprint,
  formatPlanWeight,
  needsPlanning,
  planCell,
  planFor,
  planParcel,
  quoteFresh,
  sameFingerprint,
  type PlanOrder,
  type PlanSetup,
  type StoredPlan,
} from "./plan";

const settings: ShippingSettings = {
  ...DEFAULT_SHIPPING_SETTINGS,
  ship_from: {
    ...DEFAULT_SHIPPING_SETTINGS.ship_from,
    name: "A Makers",
    address1: "1 Mill Lane",
    city: "Hudson",
    region: "NY",
    postal_code: "12534",
    phone: "518 555 0100",
  },
  signature_over: 250,
};
const box = (over: Partial<SavedBox> = {}): SavedBox => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Medium box",
  kind: "box",
  length_in: "12.00",
  width_in: "9.00",
  height_in: "4.00",
  empty_weight_oz: "6.00",
  is_default: true,
  ...over,
});
const big = box({ id: "22222222-2222-4222-8222-222222222222", name: "Big box", is_default: false });
const setup = (over: Partial<PlanSetup> = {}): PlanSetup => ({
  boxes: [box(), big],
  sources: ["easypost", "ups"],
  settings,
  ...over,
});
const order = (over: Partial<PlanOrder> = {}): PlanOrder => ({
  recipient: "Sam Shopper",
  company: null,
  address1: "12 Mill Lane",
  address2: null,
  city: "Brooklyn",
  region: "NY",
  postal_code: "11201",
  country_code: "US",
  phone: null,
  items: [{ line_id: "l1", left: 2 }],
  weight_grams: 1871, // 4 lb 2 oz
  pickup: false,
  ...over,
});
const now = new Date("2026-11-24T17:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const stored = (over: Partial<StoredPlan> = {}): StoredPlan => ({
  shipping_order_id: "o1",
  chosen_box_id: null,
  plan_key: null,
  quote_status: null,
  quote_source: null,
  quote_carrier: null,
  quote_service: null,
  quote_cents: null,
  quote_currency: null,
  quoted_at: null,
  address_key: null,
  address_status: null,
  address_residential: null,
  address_checked_at: null,
  ...over,
});
const show = {
  now,
  willFill: true,
  paidCents: 1400,
  currency: "USD",
  imperial: true,
  money: (amount: number, currency: string) =>
    currency === "USD" ? `$${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`,
};

describe("fingerprints", () => {
  it("match the same facts whatever order they were written in, and nothing else", () => {
    const print = fingerprint({ a: 1, b: ["x", 2] });
    expect(sameFingerprint(print, { b: ["x", 2], a: 1 })).toBe(true);
    expect(sameFingerprint(print, { a: 1, b: ["x", 3] })).toBe(false);
    expect(sameFingerprint(null, { a: 1 })).toBe(false);
    expect(sameFingerprint("nonsense", { a: 1 })).toBe(false);
  });

  it("are salted, and say nothing of what they were made from", () => {
    const facts = { to: ["12 MILL LANE", "BROOKLYN"] };
    expect(fingerprint(facts)).not.toBe(fingerprint(facts));
    expect(fingerprint(facts)).toMatch(/^[0-9a-f]{24}:[0-9a-f]{64}$/);
    expect(fingerprint(facts)).not.toMatch(/mill|brooklyn/i);
  });
});

describe("the plan for an order", () => {
  it("is the usual box at the items' weight plus the box", () => {
    const plan = planFor(order(), null, 80, setup());
    expect(plan.box?.name).toBe("Medium box");
    expect(plan.boxSource).toBe("default");
    // 1871 g is 66.0 oz; the box adds 6.
    expect(plan.weightTenthOz).toBe(720);
    expect(formatPlanWeight(plan.weightTenthOz!, true)).toBe("4 lb 8 oz");
    expect(plan.signature).toBe(false);
    expect(plan.noQuote).toBeNull();
    expect(plan.canCheck).toBe(true);
    expect(planParcel(plan)).toEqual({ length: 12, width: 9, height: 4, weightTenthOz: 720 });
  });

  it("uses the box a person picked, and says so", () => {
    const plan = planFor(order(), big.id, 80, setup());
    expect(plan.box?.name).toBe("Big box");
    expect(plan.boxSource).toBe("person");
    // Picking the usual box, or one that has since been removed, is the usual box.
    expect(planFor(order(), box().id, 80, setup()).boxSource).toBe("default");
    const gone = planFor(order(), "33333333-3333-4333-8333-333333333333", 80, setup());
    expect(gone.box?.name).toBe("Medium box");
    expect(gone.boxSource).toBe("default");
  });

  it("follows the workspace's signature rule on the order's total", () => {
    expect(planFor(order(), null, 250, setup()).signature).toBe(true);
    expect(planFor(order(), null, "318.60", setup()).signature).toBe(true);
    expect(planFor(order(), null, null, setup()).signature).toBe(false);
    const noRule = setup({ settings: { ...settings, signature_over: null } });
    expect(planFor(order(), null, 900, noRule).signature).toBe(false);
  });

  it("asks no price where none could be bought, and says why", () => {
    const why = (o: PlanOrder, s = setup()) => planFor(o, null, 80, s).noQuote;
    expect(why(order({ pickup: true }))).toBe("pickup");
    expect(why(order({ country_code: "CA" }))).toBe("abroad");
    expect(why(order({ postal_code: null }))).toBe("address");
    expect(why(order(), setup({ sources: [] }))).toBe("source");
    expect(
      why(
        order(),
        setup({ settings: { ...settings, ship_from: DEFAULT_SHIPPING_SETTINGS.ship_from } }),
      ),
    ).toBe("ship_from");
    expect(why(order(), setup({ boxes: [] }))).toBe("box");
    expect(why(order({ weight_grams: null }))).toBe("weight");
    expect(why(order({ weight_grams: 0 }))).toBe("weight");
    expect(why(order({ weight_grams: 70_000 }))).toBe("heavy");
  });

  it("checks an address only when an account can, and never abroad or for a pickup", () => {
    expect(addressChecker(["easypost", "ups"], "US")).toBe("easypost");
    expect(addressChecker(["ups", "redo"], "US")).toBe("ups");
    expect(addressChecker(["ups"], "GB")).toBeNull();
    expect(addressChecker(["redo"], "US")).toBeNull();
    expect(planFor(order(), null, 80, setup({ sources: ["redo"] })).canCheck).toBe(false);
    expect(planFor(order({ pickup: true }), null, 80, setup()).canCheck).toBe(false);
    expect(planFor(order({ country_code: "CA" }), null, 80, setup()).canCheck).toBe(false);
    expect(planFor(order({ address1: null }), null, 80, setup()).canCheck).toBe(false);
  });
});

describe("when a stored price still stands", () => {
  const plan = planFor(order(), null, 80, setup());
  const priced = (over: Partial<StoredPlan> = {}) =>
    stored({
      plan_key: fingerprint(plan.quoteFacts),
      quote_status: "ok",
      quote_source: "ups",
      quote_carrier: "UPS",
      quote_service: "Ground",
      quote_cents: 943,
      quote_currency: "USD",
      quoted_at: ago(60_000),
      ...over,
    });

  it("stands for twelve hours, for the very plan it was asked for", () => {
    expect(quoteFresh(priced(), plan, now)).toBe(true);
    expect(quoteFresh(priced({ quoted_at: ago(QUOTE_LIFETIME_MS - 1000) }), plan, now)).toBe(true);
    expect(quoteFresh(priced({ quoted_at: ago(QUOTE_LIFETIME_MS + 1000) }), plan, now)).toBe(false);
    expect(quoteFresh(null, plan, now)).toBe(false);
    expect(quoteFresh(stored(), plan, now)).toBe(false);
    // A clock that says it was asked in the future isn't trusted.
    expect(quoteFresh(priced({ quoted_at: ago(-3_600_000) }), plan, now)).toBe(false);
  });

  it("goes when the address, the items left, the weight, the box or the rule changes", () => {
    const row = priced();
    const still = (o: PlanOrder, chosen: string | null = null, total = 80, s = setup()) =>
      quoteFresh(row, planFor(o, chosen, total, s), now);
    expect(still(order())).toBe(true);
    // Who it's for and their phone don't change a price; how the address is typed doesn't either.
    expect(still(order({ recipient: "Someone Else", phone: "555" }))).toBe(true);
    expect(still(order({ address1: "  12 mill  lane " }))).toBe(true);
    expect(still(order({ address1: "14 Mill Lane" }))).toBe(false);
    expect(still(order({ postal_code: "11215" }))).toBe(false);
    expect(still(order({ items: [{ line_id: "l1", left: 1 }] }))).toBe(false);
    expect(still(order({ weight_grams: 2000 }))).toBe(false);
    expect(still(order(), big.id)).toBe(false);
    expect(still(order(), null, 400)).toBe(false);
    expect(
      still(order(), null, 80, setup({ boxes: [box({ empty_weight_oz: "8.00" }), big] })),
    ).toBe(false);
    expect(still(order(), null, 80, setup({ sources: ["easypost"] }))).toBe(false);
    expect(
      still(
        order(),
        null,
        80,
        setup({
          settings: { ...settings, ship_from: { ...settings.ship_from, postal_code: "10001" } },
        }),
      ),
    ).toBe(false);
  });

  it("asks again sooner when nobody offered a price", () => {
    const none = priced({ quote_status: "none", quote_cents: null });
    expect(quoteFresh(none, plan, now)).toBe(true);
    expect(quoteFresh({ ...none, quoted_at: ago(NO_QUOTE_RETRY_MS + 1000) }, plan, now)).toBe(
      false,
    );
  });

  it("keeps an address answer for good, and retries a check that couldn't be made", () => {
    const answered = stored({
      address_key: fingerprint(plan.addressFacts),
      address_status: "found",
      address_checked_at: ago(400 * 24 * 3_600_000),
    });
    expect(addressSettled(answered, plan, now)).toBe(true);
    expect(addressSettled({ ...answered, address_status: "not_found" }, plan, now)).toBe(true);
    // Another address has never been asked about.
    const moved = planFor(order({ address1: "14 Mill Lane" }), null, 80, setup());
    expect(addressSettled(answered, moved, now)).toBe(false);
    // A different box or weight is the same address.
    expect(
      addressSettled(answered, planFor(order({ weight_grams: 5 }), big.id, 80, setup()), now),
    ).toBe(true);
    const failed = { ...answered, address_status: "not_checked", address_checked_at: ago(60_000) };
    expect(addressSettled(failed, plan, now)).toBe(true);
    expect(
      addressSettled({ ...failed, address_checked_at: ago(ADDRESS_RETRY_MS + 1000) }, plan, now),
    ).toBe(false);
    expect(addressSettled(stored(), plan, now)).toBe(false);
  });

  it("needs planning only while a carrier still has something to say", () => {
    expect(needsPlanning(null, plan, now)).toBe(true);
    const whole = priced({
      address_key: fingerprint(plan.addressFacts),
      address_status: "found",
      address_checked_at: ago(1000),
    });
    expect(needsPlanning(whole, plan, now)).toBe(false);
    expect(needsPlanning({ ...whole, quoted_at: ago(QUOTE_LIFETIME_MS + 1) }, plan, now)).toBe(
      true,
    );
    // Nothing to ask for a pickup, or with nothing connected.
    expect(needsPlanning(null, planFor(order({ pickup: true }), null, 80, setup()), now)).toBe(
      false,
    );
    expect(needsPlanning(null, planFor(order(), null, 80, setup({ sources: [] })), now)).toBe(
      false,
    );
    // No weight: the address can still be checked.
    expect(
      needsPlanning(null, planFor(order({ weight_grams: null }), null, 80, setup()), now),
    ).toBe(true);
  });

  it("shows the box, the price with its margin, and the address", () => {
    const whole = priced({
      address_key: fingerprint(plan.addressFacts),
      address_status: "found",
      address_checked_at: ago(1000),
    });
    expect(planCell(plan, whole, show)).toEqual({
      box: "Medium box",
      boxNote: null,
      signature: "none",
      rules: [],
      weight: "4 lb 8 oz",
      quote: {
        state: "ok",
        mark: { key: "ups", label: "UPS" },
        service: "UPS Ground",
        source: "UPS",
        price: "$9.43",
        cents: 943,
        currency: "USD",
        byRule: false,
        margin: { text: "+$4.57 margin", short: false },
      },
      address: "found",
    });
    const short = planCell(plan, whole, { ...show, paidCents: 800 });
    expect(short.quote).toMatchObject({ margin: { text: "−$1.43 margin", short: true } });
    // No margin when what the shopper paid isn't known, or the price is in another currency.
    expect(planCell(plan, whole, { ...show, paidCents: null }).quote).toMatchObject({
      margin: null,
    });
    expect(planCell(plan, { ...whole, quote_currency: "CAD" }, show).quote).toMatchObject({
      price: "9.43 CAD",
      margin: null,
    });
  });

  it("says a person's box is their choice", () => {
    const chosen = planFor(order(), big.id, 80, setup());
    expect(planCell(chosen, stored({ chosen_box_id: big.id }), show)).toMatchObject({
      box: "Big box",
      boxNote: "your choice",
      quote: { state: "waiting" },
      address: "waiting",
    });
  });

  it("waits only when the page is going to ask, and says why when it won't", () => {
    expect(planCell(plan, null, { ...show, willFill: false })).toMatchObject({
      quote: { state: "off" },
      address: null,
    });
    const pickup = planCell(planFor(order({ pickup: true }), null, 80, setup()), null, show);
    expect(pickup.quote).toMatchObject({ state: "off" });
    expect(pickup.address).toBeNull();
    const none = priced({ quote_status: "none", quote_cents: null, address_status: null });
    expect(planCell(plan, none, show).quote).toEqual({ state: "none" });
    const bad = stored({
      address_key: fingerprint(plan.addressFacts),
      address_status: "not_found",
      address_checked_at: ago(1000),
    });
    expect(planCell(plan, bad, show).address).toBe("not_found");
    expect(planCell(plan, { ...bad, address_status: "not_checked" }, show).address).toBeNull();
  });
});
