import { describe, expect, it } from "vitest";
import { DEFAULT_SHIPPING_SETTINGS, type ShippingSettings } from "./config";
import {
  BOX_ORDER_WORDS,
  boxExplained,
  holdExplained,
  quoteExplained,
  signatureExplained,
} from "./explain";
import type { SavedBox } from "./labels";
import { itemsKey, productsKey, type PackingMemory } from "./memory";
import { planFor, type PlanOrder, type PlanSetup } from "./plan";
import type { ShippingRule } from "./rules";

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
  items: [{ line_id: "l1", left: 2, title: "Rug", sku: "R1" }],
  weight_grams: 1871,
  pickup: false,
  ...over,
});
const rule = (over: Partial<ShippingRule>): ShippingRule => ({
  id: "r1",
  name: "Big orders",
  enabled: true,
  conditions: [{ field: "order_total", op: "gt", value: "100" }],
  actions: [{ type: "set_package", value: "Big box" }],
  ...over,
});
const explain = (plan: ReturnType<typeof planFor>, s = setup()) => boxExplained(plan, s);

describe("boxExplained", () => {
  it("always says the order boxes are chosen in, then which one applied", () => {
    const lines = explain(planFor(order(), null, 50, setup()));
    expect(lines[0]).toBe(BOX_ORDER_WORDS);
    expect(lines[1]).toBe("It's in your usual box, Medium box.");
    expect(lines.at(-1)).toBe(
      "The weight is your shop's weight for the items, plus the empty box.",
    );
  });

  it("follows planFor: a person's pick, then a rule's box", () => {
    expect(explain(planFor(order(), big.id, 50, setup()))[1]).toBe(
      "This order goes in what you chose for it: Big box.",
    );
    const ruled = setup({ rules: [rule({})] });
    expect(boxExplained(planFor(order(), null, 150, ruled), ruled)[1]).toBe(
      "A rule chose the box: Big box.",
    );
  });

  it("says when the packing was remembered, exactly or for similar orders", () => {
    const items = [{ line_id: "l1", title: "Rug", variant: null, sku: "R1", qty: 2 }];
    const remembered = {
      boxes: [
        { box_id: big.id, length: 18, width: 14, height: 6, weight_tenth_oz: 700, items: {} },
      ],
    };
    const memory = {
      exact: new Map([[itemsKey(items), remembered]]),
      similar: new Map([[productsKey(items), remembered]]),
    } as unknown as PackingMemory;
    const lines = explain(planFor(order(), null, 50, setup({ memory })));
    expect(lines[1]).toMatch(/^You've sent exactly these items before/);
    expect(lines.at(-1)).toBe("The weight is what was weighed for it before.");
    const similar = setup({
      memory,
      settings: { ...settings, remember_packing: { exact: false, similar: true } },
    });
    const near = boxExplained(planFor(order(), null, 50, similar), similar);
    expect(near[1]).toMatch(/^You've sent these products before in other amounts/);
    expect(near).toContain(
      "Orders with exactly the same items aren't remembered; similar ones are.",
    );
  });

  it("says when none is marked usual, when there are no boxes, and when the weight isn't known", () => {
    const unmarked = setup({ boxes: [box({ is_default: false }), big] });
    expect(boxExplained(planFor(order(), null, 50, unmarked), unmarked)[1]).toBe(
      "It's in Medium box, the first box you added, since none is marked as your usual box.",
    );
    expect(explain(planFor(order(), null, 50, setup({ boxes: [] })), setup({ boxes: [] }))[1]).toBe(
      "There's no box saved yet, so none can be chosen.",
    );
    expect(explain(planFor(order({ weight_grams: null }), null, 50, setup())).at(-1)).toBe(
      "The weight isn't known: your shop gave none for some of these items.",
    );
  });
});

describe("quoteExplained", () => {
  it("says who is asked, which price is shown, how long it lasts and what margin means", () => {
    const plan = planFor(order(), null, 50, setup());
    const lines = quoteExplained(plan, { sources: ["easypost", "ups"], costs: true });
    expect(lines[0]).toBe(
      "Prices are asked of EasyPost and UPS for these boxes, weights and address, and the cheapest is shown.",
    );
    expect(lines[1]).toMatch(/^A price is kept for 12 hours/);
    expect(lines[2]).toBe(
      "The margin is what the customer paid for shipping, less the label's price.",
    );
    expect(quoteExplained(plan, { sources: ["ups"], costs: false })).toHaveLength(2);
  });

  it("names a rule's service, and why there's no price", () => {
    const ruled = setup({
      rules: [rule({ actions: [{ type: "set_service", value: "fastest" }] })],
    });
    expect(
      quoteExplained(planFor(order(), null, 150, ruled), { sources: ["ups"], costs: false })[0],
    ).toContain("a rule asks for the fastest, so that's the one shown");
    expect(
      quoteExplained(planFor(order({ pickup: true }), null, 50, setup()), {
        sources: [],
        costs: true,
      }),
    ).toEqual(["No label needed: this one is being collected."]);
  });
});

describe("signatureExplained", () => {
  const money = (n: number) => `$${n.toFixed(2)}`;
  it("says which rule asked, or why none did", () => {
    const over = setup({ settings: { ...settings, signature_over: 250 } });
    const asked = planFor(order(), null, 300, {
      ...over,
      signatureName: "Signature on orders of $250.00 or more",
    });
    expect(signatureExplained(asked, { signatureOver: 250, total: 300, money })).toEqual([
      "The rule “Signature on orders of $250.00 or more” asks for a signature.",
    ]);
    const not = planFor(order(), null, 80, over);
    expect(signatureExplained(not, { signatureOver: 250, total: 80, money })).toEqual([
      "Orders of $250.00 or more need a signature. This one comes to $80.00, so it doesn't.",
    ]);
    expect(
      signatureExplained(planFor(order(), null, 80, setup()), {
        signatureOver: null,
        total: 80,
        money,
      })[0],
    ).toMatch(/^No rule asks for a signature/);
  });
});

describe("holdExplained", () => {
  const plan = { ruleHold: null };
  it("says why it's held and when it comes back", () => {
    expect(
      holdExplained(
        { on_hold: true, hold_until: "2026-12-01", hold_reason: "Waiting on yarn" },
        plan,
        "2026-11-27",
      ),
    ).toEqual(["It's on hold: Waiting on yarn.", "It comes back by itself on Tue, Dec 1."]);
    expect(
      holdExplained({ on_hold: true, hold_until: null, hold_reason: "" }, plan, "2026-11-27"),
    ).toEqual(["It's on hold.", "It stays on hold until someone releases it."]);
    expect(
      holdExplained(
        { on_hold: true, hold_until: "2026-11-20", hold_reason: "x" },
        plan,
        "2026-11-27",
      ),
    ).toEqual(["Its hold ended, so it's back with the orders ready to go."]);
  });

  it("says when a rule held it, and that a release sticks", () => {
    const ruled = { ruleHold: "Check the colour" };
    expect(
      holdExplained(
        { on_hold: true, hold_until: null, hold_reason: "Check the colour" },
        ruled,
        "2026-11-27",
      ).at(-1),
    ).toBe("A rule held it. Once someone releases it, no rule holds it again.");
    expect(
      holdExplained({ on_hold: false, hold_until: null, hold_reason: "" }, ruled, "2026-11-27"),
    ).toEqual(["A rule says to hold it: Check the colour."]);
    expect(
      holdExplained(
        {
          on_hold: false,
          hold_until: null,
          hold_reason: "",
          rule_hold_settled_at: "2026-11-01T00:00:00Z",
        },
        ruled,
        "2026-11-27",
      ),
    ).toEqual(["It isn't on hold."]);
  });
});
