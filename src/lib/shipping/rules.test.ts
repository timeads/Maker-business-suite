import { describe, expect, it } from "vitest";
import {
  conditionMatches,
  evaluateRules,
  parseShippingRules,
  pickService,
  ruleSentence,
  shippingRulesSchema,
  type RuleOrder,
  type ShippingRule,
} from "./rules";

// Ported from the reference help desk's test/rules.test.ts.
const order = (
  lines: { title: string; quantity: number; sku?: string }[],
  total: string | null,
  state = "PA",
  extra: Partial<RuleOrder> = {},
): RuleOrder => ({
  items: lines.map((line) => ({ title: line.title, sku: line.sku ?? null, qty: line.quantity })),
  total: total === null ? null : Number(total),
  region: state,
  country: "US",
  shippingMethod: "Standard",
  ...extra,
});

const REDO: ShippingRule[] = [
  {
    id: "1",
    name: "Tufting machine only > standard box",
    enabled: true,
    conditions: [
      { field: "item_quantity", op: "eq", value: "1" },
      { field: "product_names", op: "includes_any", value: "ak5 - cut & loop tufting machine" },
    ],
    actions: [{ type: "set_package", value: "Standard" }],
  },
  {
    id: "2",
    name: "Signature required over $250",
    enabled: true,
    conditions: [{ field: "order_total", op: "gt", value: "250" }],
    actions: [{ type: "require_signature", value: "standard" }],
  },
];

describe("shipping rules", () => {
  it("puts a lone AK5 machine in the Standard box and asks for a signature over $250", () => {
    const result = evaluateRules(
      order([{ title: "AK5 - Cut & Loop Tufting Machine", quantity: 1 }], "329.00"),
      REDO,
    );
    expect(result).toEqual({
      packageName: "Standard",
      signature: "standard",
      signatureRule: "Signature required over $250",
      service: null,
      serviceRule: null,
      hold: null,
      matched: ["Tufting machine only > standard box", "Signature required over $250"],
    });
  });

  it("does not apply the box rule when other items ship with the machine", () => {
    const result = evaluateRules(
      order(
        [
          { title: "AK5 - Cut & Loop Tufting Machine", quantity: 1 },
          { title: "Yarn", quantity: 2 },
        ],
        "120",
      ),
      REDO,
    );
    expect(result.packageName).toBeNull();
    expect(result.signature).toBeNull();
    expect(result.matched).toEqual([]);
  });

  it("skips disabled rules and treats $250 exactly as not over", () => {
    const result = evaluateRules(
      order([{ title: "Yarn", quantity: 1 }], "250.00"),
      REDO.map((rule) => ({ ...rule, enabled: rule.id !== "1" })),
    );
    expect(result.signature).toBeNull();
  });

  const sigRule = (value: string): ShippingRule => ({
    id: "9",
    name: "Signature over",
    enabled: true,
    conditions: [{ field: "order_total", op: "gt", value }],
    actions: [{ type: "require_signature", value: "standard" }],
  });
  const yarnOrder = order(
    [
      { title: "Reflect Wool Yarn", quantity: 2 },
      { title: "Charcoal SoFAT Tee (Fitted)", quantity: 1 },
    ],
    "61.69",
    "OK",
  );

  it("says which rule asked for the signature, and reads $ and commas in amounts", () => {
    expect(
      evaluateRules(order([{ title: "The Duo", quantity: 1 }], "329.00"), [sigRule("$250")]),
    ).toMatchObject({ signature: "standard", signatureRule: "Signature over" });
    expect(
      evaluateRules(order([{ title: "Frame", quantity: 1 }], "1200.00"), [sigRule("1,000")])
        .signature,
    ).toBe("standard");
    expect(evaluateRules(yarnOrder, [sigRule("250")])).toMatchObject({
      signature: null,
      signatureRule: null,
    });
    // A blank amount never matches, and nor does one that isn't a number.
    expect(evaluateRules(yarnOrder, [sigRule(" ")]).signature).toBeNull();
    expect(evaluateRules(yarnOrder, [sigRule("about 250")]).signature).toBeNull();
  });

  it("never matches an amount when the order's total isn't known", () => {
    const unknown = order([{ title: "Frame", quantity: 1 }], null);
    expect(evaluateRules(unknown, [sigRule("0")]).signature).toBeNull();
    expect(conditionMatches(unknown, { field: "order_total", op: "lt", value: "1000" })).toBe(
      false,
    );
  });

  it("gives each kind of action to the first rule that matches", () => {
    const rules: ShippingRule[] = [
      {
        id: "a",
        name: "Alaska and Hawaii by post",
        enabled: true,
        conditions: [{ field: "destination_state", op: "includes_any", value: "AK, HI" }],
        actions: [
          { type: "set_service", value: "USPS Priority Mail" },
          { type: "require_signature", value: "adult" },
        ],
      },
      {
        id: "b",
        name: "Everything fastest",
        enabled: true,
        conditions: [{ field: "item_quantity", op: "gt", value: "0" }],
        actions: [
          { type: "set_service", value: "fastest" },
          { type: "set_package", value: "Large" },
        ],
      },
      {
        id: "c",
        name: "Frames wait for the crate",
        enabled: true,
        conditions: [{ field: "product_skus", op: "contains", value: "frame" }],
        actions: [{ type: "place_hold", value: "" }],
      },
    ];
    const result = evaluateRules(
      order([{ title: "Tufting frame", quantity: 1, sku: "FRAME-24" }], "80", "HI"),
      rules,
    );
    expect(result).toEqual({
      packageName: "Large",
      signature: "adult",
      signatureRule: "Alaska and Hawaii by post",
      service: "USPS Priority Mail",
      serviceRule: "Alaska and Hawaii by post",
      // A hold with no note is named after its rule.
      hold: "Frames wait for the crate",
      matched: ["Alaska and Hawaii by post", "Everything fastest", "Frames wait for the crate"],
    });
    // The second rule's service lost, but it still did something (the box), so it is listed.
    const mainland = evaluateRules(order([{ title: "Yarn", quantity: 1 }], "20", "PA"), rules);
    expect(mainland.service).toBe("fastest");
    expect(mainland.matched).toEqual(["Everything fastest"]);
  });

  it("reads lists, and the shipping the customer chose", () => {
    const express = order([{ title: "Yarn", quantity: 1 }], "20", "PA", {
      shippingMethod: "UPS Next Day Air",
      country: "CA",
    });
    expect(
      conditionMatches(express, { field: "shipping_service", op: "contains", value: "next day" }),
    ).toBe(true);
    expect(
      conditionMatches(express, { field: "shipping_service", op: "excludes", value: "ground" }),
    ).toBe(true);
    expect(
      conditionMatches(express, {
        field: "destination_country",
        op: "includes_any",
        value: "gb\nca",
      }),
    ).toBe(true);
    expect(
      conditionMatches(express, { field: "destination_country", op: "excludes", value: "CA" }),
    ).toBe(false);
    expect(conditionMatches(express, { field: "item_quantity", op: "lt", value: "2" })).toBe(true);
  });
});

describe("the older signature setting, as a rule", () => {
  const frame = order([{ title: "Frame", quantity: 1 }], "250.00");

  it("asks for a signature at the amount exactly, as it always did, and is named", () => {
    const result = evaluateRules(frame, [], { signatureOver: 250 });
    expect(result.signature).toBe("standard");
    expect(result.signatureRule).toBe("Signature on orders of 250 or more");
    expect(result.matched).toEqual(["Signature on orders of 250 or more"]);
    expect(evaluateRules(frame, [], { signatureOver: 250.01 }).signature).toBeNull();
    expect(evaluateRules(frame, [], { signatureOver: null }).signature).toBeNull();
    expect(
      evaluateRules(order([{ title: "Frame", quantity: 1 }], null), [], { signatureOver: 0 })
        .signature,
    ).toBeNull();
  });

  it("comes after the list, so a rule's adult signature stands", () => {
    const adult: ShippingRule = {
      id: "x",
      name: "Machines need an adult",
      enabled: true,
      conditions: [{ field: "product_names", op: "contains", value: "frame" }],
      actions: [{ type: "require_signature", value: "adult" }],
    };
    const result = evaluateRules(frame, [adult], {
      signatureOver: 100,
      name: "Signature over $100",
    });
    expect(result.signature).toBe("adult");
    expect(result.matched).toEqual(["Machines need an adult"]);
    // With that rule off, the setting still asks.
    const off = evaluateRules(frame, [{ ...adult, enabled: false }], {
      signatureOver: 100,
      name: "Signature over $100",
    });
    expect(off).toMatchObject({ signature: "standard", signatureRule: "Signature over $100" });
  });
});

describe("rules as a saved setting", () => {
  it("takes a well-formed list and gives none for nonsense", () => {
    expect(parseShippingRules({ version: 1, rules: REDO })).toHaveLength(2);
    expect(parseShippingRules(null)).toEqual([]);
    expect(parseShippingRules({ version: 2, rules: REDO })).toEqual([]);
  });

  it("refuses a comparison that doesn't go with its condition, and empty actions", () => {
    const bad = (rule: unknown) =>
      shippingRulesSchema.safeParse({ version: 1, rules: [rule] }).success;
    expect(bad(REDO[0])).toBe(true);
    expect(
      bad({ ...REDO[0], conditions: [{ field: "order_total", op: "contains", value: "1" }] }),
    ).toBe(false);
    expect(bad({ ...REDO[0], actions: [{ type: "set_package", value: " " }] })).toBe(false);
    expect(bad({ ...REDO[0], actions: [{ type: "require_signature", value: "maybe" }] })).toBe(
      false,
    );
    expect(bad({ ...REDO[0], actions: [{ type: "place_hold", value: "" }] })).toBe(true);
    expect(
      bad({
        ...REDO[0],
        actions: [
          { type: "place_hold", value: "a" },
          { type: "place_hold", value: "b" },
        ],
      }),
    ).toBe(false);
    expect(bad({ ...REDO[0], conditions: [] })).toBe(false);
    expect(
      shippingRulesSchema.safeParse({ version: 1, rules: [REDO[0], { ...REDO[1], id: "1" }] })
        .success,
    ).toBe(false);
  });

  it("reads as a sentence", () => {
    expect(ruleSentence(REDO[1], (amount) => `$${amount}`)).toBe(
      "When the order total is more than $250: ask for a signature.",
    );
  });
});

describe("picking the service a plan asks for", () => {
  const rates = [
    { carrier: "USPS", name: "Ground Advantage", price: "6.10", days: 4 },
    { carrier: "UPS", name: "UPS Ground · Redo", price: "9.40", days: 3 },
    { carrier: "UPS", name: "2nd Day Air", price: "21.00", days: 2 },
    { carrier: "FedEx", name: "Home Delivery", price: "11.00", days: null },
  ];

  it("takes the cheapest when nothing is asked, and says nothing matched", () => {
    expect(pickService(rates, null)).toEqual({ rate: rates[0], matched: false });
    expect(pickService(rates, "cheapest")).toEqual({ rate: rates[0], matched: true });
    expect(pickService([], "cheapest")).toBeNull();
  });

  it("takes the soonest for fastest, and the cheapest when nobody says how long", () => {
    expect(pickService(rates, "fastest")?.rate).toBe(rates[2]);
    const untimed = rates.map((rate) => ({ ...rate, days: null }));
    expect(pickService(untimed, "Fastest")).toEqual({ rate: untimed[0], matched: false });
  });

  it("finds a named service with or without its carrier, and falls back to the cheapest", () => {
    expect(pickService(rates, "UPS Ground")).toEqual({ rate: rates[1], matched: true });
    expect(pickService(rates, "ups 2nd day air")?.rate).toBe(rates[2]);
    expect(pickService(rates, "Home Delivery")?.rate).toBe(rates[3]);
    expect(pickService(rates, "DHL Express")).toEqual({ rate: rates[0], matched: false });
  });
});
