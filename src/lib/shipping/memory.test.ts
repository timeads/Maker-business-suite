import { describe, expect, it } from "vitest";
import { DEFAULT_SHIPPING_SETTINGS, type ShippingSettings } from "./config";
import type { SavedBox } from "./labels";
import {
  NO_MEMORY,
  allocFromMemory,
  buildMemory,
  itemsKey,
  itemsLabel,
  learnedBoxes,
  parseLearned,
  productKey,
  productsKey,
  type Learned,
  type MemoryItem,
  type PackedBox,
} from "./memory";
import {
  BOX_NOTES,
  isWholeOrder,
  memoryItems,
  planFor,
  planParcels,
  type PlanOrder,
  type PlanSetup,
} from "./plan";
import type { ShippingRule } from "./rules";

// Ported from the reference help desk's test/packing-memory.test.ts. Weights there are
// pounds; here they are tenths of an ounce (160 to the pound) and grams from the shop.
const LB = 453.59237;
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
const STANDARD: SavedBox = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Standard",
  kind: "box",
  length_in: "16.00",
  width_in: "12.00",
  height_in: "10.00",
  empty_weight_oz: "9.60", // 0.6 lb
  is_default: true,
};
const LARGE: SavedBox = {
  ...STANDARD,
  id: "22222222-2222-4222-8222-222222222222",
  name: "Large",
  length_in: "24.00",
  width_in: "18.00",
  height_in: "14.00",
  empty_weight_oz: "19.20", // 1.2 lb
  is_default: false,
};

/** [line id, item code, how many, pounds each] */
type Line = [string, string, number, number];
const order = (lines: Line[], over: Partial<PlanOrder> = {}): PlanOrder => ({
  recipient: "Sam Shopper",
  company: null,
  address1: "12 Mill Lane",
  address2: null,
  city: "Brooklyn",
  region: "NY",
  postal_code: "11201",
  country_code: "US",
  phone: null,
  items: lines.map(([line_id, sku, qty, lb]) => ({
    line_id,
    sku,
    title: sku,
    variant: null,
    qty,
    left: qty,
    grams: Math.round(lb * LB),
  })),
  weight_grams: Math.round(lines.reduce((sum, [, , qty, lb]) => sum + qty * lb, 0) * LB),
  pickup: false,
  ...over,
});

/** Remembers how `first` was packed, the way the server does after a purchase. */
function learn(first: PlanOrder, parcels: PackedBox[]): Learned {
  const items = memoryItems(first);
  return {
    item_key: itemsKey(items),
    products_key: productsKey(items),
    boxes: learnedBoxes(items, parcels),
  };
}
const setup = (rows: Learned[], over: Partial<PlanSetup> = {}): PlanSetup => ({
  boxes: [STANDARD, LARGE],
  sources: ["easypost"],
  settings,
  memory: buildMemory(rows),
  ...over,
});
const lb = (tenths: number | null) => (tenths === null ? null : Math.round(tenths / 16) / 10);

describe("packing memory", () => {
  it("repeats a multi-box packing for the same items, box by box", () => {
    const first = order([
      ["l1", "GUN", 1, 4],
      ["l2", "CLOTH", 2, 3],
    ]);
    const memory = learn(first, [
      {
        boxId: STANDARD.id,
        length: 16,
        width: 12,
        height: 10,
        weightTenthOz: 816,
        alloc: { l1: 1 },
      },
      { boxId: LARGE.id, length: 24, width: 18, height: 14, weightTenthOz: 1184, alloc: { l2: 2 } },
    ]);
    // A later order: same items, different line ids and order.
    const next = order([
      ["x9", "CLOTH", 2, 3],
      ["x8", "GUN", 1, 4],
    ]);
    const plan = planFor(next, null, 100, setup([memory]));
    expect(plan.boxSource).toBe("learned");
    expect(plan.boxes.map((box) => box.box?.name)).toEqual(["Standard", "Large"]);
    expect(plan.boxes[0].items).toEqual({ x8: 1 });
    expect(plan.boxes[1].items).toEqual({ x9: 2 });
    expect(plan.boxes.map((box) => lb(box.weightTenthOz))).toEqual([5.1, 7.4]);
    expect(plan.boxes.every((box) => box.weighed)).toBe(true);
    expect(lb(plan.weightTenthOz)).toBe(12.5);
    expect(plan.noQuote).toBeNull();
    expect(planParcels(plan)).toEqual([
      { length: 16, width: 12, height: 10, weightTenthOz: 816 },
      { length: 24, width: 18, height: 14, weightTenthOz: 1184 },
    ]);
    expect(BOX_NOTES[plan.boxSource]).toBe("remembered");
  });

  it("reuses the box for the same products in other quantities, weighing from product weights", () => {
    const memory = learn(order([["l1", "YARN", 4, 1]]), [
      { boxId: LARGE.id, length: 24, width: 18, height: 14, weightTenthOz: 800 },
    ]);
    const plan = planFor(order([["l7", "YARN", 6, 1]]), null, 100, setup([memory]));
    expect(plan.boxSource).toBe("learned-similar");
    expect(plan.box?.name).toBe("Large");
    expect(plan.boxes).toHaveLength(1);
    expect(plan.boxes[0].items).toEqual({ l7: 6 });
    // 6 × 1 lb + 1.2 lb box
    expect(lb(plan.weightTenthOz)).toBe(7.2);
    expect(plan.boxes[0].weighed).toBe(false);
  });

  it("only follows a similar packing that was one box", () => {
    const memory = learn(
      order([
        ["l1", "GUN", 1, 4],
        ["l2", "CLOTH", 2, 3],
      ]),
      [
        {
          boxId: STANDARD.id,
          length: 16,
          width: 12,
          height: 10,
          weightTenthOz: 816,
          alloc: { l1: 1 },
        },
        {
          boxId: LARGE.id,
          length: 24,
          width: 18,
          height: 14,
          weightTenthOz: 1184,
          alloc: { l2: 2 },
        },
      ],
    );
    const plan = planFor(
      order([
        ["a", "GUN", 2, 4],
        ["b", "CLOTH", 1, 3],
      ]),
      null,
      100,
      setup([memory]),
    );
    expect(plan.boxSource).toBe("default");
    expect(plan.box?.name).toBe("Standard");
  });

  it("falls back to the default box for products it hasn't seen", () => {
    const plan = planFor(order([["l1", "NEW", 1, 2]]), null, 100, setup([]));
    expect(plan.boxSource).toBe("default");
    expect(plan.box?.name).toBe("Standard");
    expect(lb(plan.weightTenthOz)).toBe(2.6);
    expect(
      planFor(order([["l1", "NEW", 1, 2]]), null, 100, { ...setup([]), memory: NO_MEMORY }),
    ).toMatchObject({ boxSource: "default" });
  });

  it("keys combine duplicate lines of the same product", () => {
    const items = memoryItems(
      order([
        ["l1", "YARN", 2, 1],
        ["l2", "YARN", 2, 1],
      ]),
    );
    expect(itemsKey(items)).toBe("yarn×4");
    expect(productsKey(items)).toBe("yarn");
  });

  it("keys a product by its code, else by its name and option, whatever the case", () => {
    expect(productKey({ sku: "AK5-Cut", title: "Machine", variant: null })).toBe("ak5-cut");
    expect(productKey({ sku: null, title: "Wool Rug", variant: "Large" })).toBe("wool rug / large");
    expect(productKey({ sku: "", title: "Wool Rug", variant: null })).toBe("wool rug");
    const items: MemoryItem[] = [
      { line_id: "2", sku: "yarn-mustard", title: "Yarn", qty: 4 },
      { line_id: "1", sku: "AK5-CUT", title: "Machine", qty: 1 },
      { line_id: "3", sku: "gone", title: "Sent already", qty: 0 },
    ];
    expect(itemsKey(items)).toBe("ak5-cut×1|yarn-mustard×4");
    expect(productsKey(items)).toBe("ak5-cut|yarn-mustard");
    expect(itemsLabel(items)).toBe("4 × Yarn, 1 × Machine");
  });

  it("keeps a very long key as a short fingerprint, the same every time", () => {
    const many: MemoryItem[] = Array.from({ length: 60 }, (_, index) => ({
      line_id: String(index),
      sku: `a-rather-long-item-code-${index}`,
      title: "Thing",
      qty: 1,
    }));
    const key = itemsKey(many);
    expect(key).toMatch(/^h:[0-9a-f]{64}$/);
    expect(itemsKey([...many].reverse())).toBe(key);
    expect(itemsKey(many.slice(1))).not.toBe(key);
  });

  it("can be switched off: exact, similar, or both", () => {
    const yarn = learn(order([["l1", "YARN", 4, 1]]), [
      { boxId: LARGE.id, length: 24, width: 18, height: 14, weightTenthOz: 800 },
    ]);
    const same = order([["n1", "YARN", 4, 1]]);
    const more = order([["n1", "YARN", 6, 1]]);
    const off = (exact: boolean, similar: boolean) =>
      setup([yarn], { settings: { ...settings, remember_packing: { exact, similar } } });
    expect(planFor(same, null, 100, off(true, true)).boxSource).toBe("learned");
    expect(planFor(more, null, 100, off(true, false)).boxSource).toBe("default");
    // With "exact" off, the same items are only "the same products": the box, not the weights.
    expect(planFor(same, null, 100, off(false, true)).boxSource).toBe("learned-similar");
    expect(planFor(same, null, 100, off(false, false)).boxSource).toBe("default");
  });

  it("uses the remembered size when the saved box has since gone", () => {
    const memory = learn(order([["l1", "YARN", 4, 1]]), [
      {
        boxId: "33333333-3333-4333-8333-333333333333",
        length: 20,
        width: 10,
        height: 5,
        weightTenthOz: 700,
      },
    ]);
    const plan = planFor(order([["n1", "YARN", 4, 1]]), null, 100, setup([memory]));
    expect(plan.boxSource).toBe("learned");
    expect(plan.box).toBeNull();
    expect(planParcels(plan)).toEqual([{ length: 20, width: 10, height: 5, weightTenthOz: 700 }]);
  });

  it("takes the latest packing of a set of products", () => {
    const older = learn(order([["l1", "YARN", 2, 1]]), [
      { boxId: STANDARD.id, length: 16, width: 12, height: 10, weightTenthOz: 400 },
    ]);
    const newer = learn(order([["l1", "YARN", 4, 1]]), [
      { boxId: LARGE.id, length: 24, width: 18, height: 14, weightTenthOz: 800 },
    ]);
    const plan = planFor(order([["n", "YARN", 9, 1]]), null, 100, setup([older, newer]));
    expect(plan.box?.name).toBe("Large");
  });
});

describe("what is learned from a purchase", () => {
  const items = memoryItems(
    order([
      ["l1", "GUN", 1, 4],
      ["l2", "YARN", 2, 1],
      ["l3", "YARN", 1, 1],
    ]),
  );

  it("puts everything in the one box, lines of a product added up", () => {
    expect(
      learnedBoxes(items, [{ boxId: null, length: 10, width: 8, height: 4, weightTenthOz: 480.4 }]),
    ).toEqual([
      {
        box_id: null,
        length: 10,
        width: 8,
        height: 4,
        weight_tenth_oz: 480,
        items: { gun: 1, yarn: 3 },
      },
    ]);
  });

  it("keeps each box's share when there are several, and nothing where no split was given", () => {
    const boxes = learnedBoxes(items, [
      {
        boxId: "a",
        length: 10,
        width: 8,
        height: 4,
        weightTenthOz: 700,
        alloc: { l1: 1, l3: 1, gone: 2 },
      },
      { boxId: "b", length: 10, width: 8, height: 4, weightTenthOz: 200, alloc: { l2: 2, l1: 0 } },
      { boxId: "c", length: 10, width: 8, height: 4, weightTenthOz: 100 },
    ]);
    expect(boxes.map((box) => box.items)).toEqual([{ gun: 1, yarn: 1 }, { yarn: 2 }, {}]);
  });

  it("lays a remembered split onto new lines, and leaves nothing unplaced", () => {
    const memory: Learned = {
      item_key: "gun×1|yarn×3",
      products_key: "gun|yarn",
      boxes: [
        { box_id: null, length: 10, width: 8, height: 4, weight_tenth_oz: 700, items: { gun: 1 } },
        { box_id: null, length: 10, width: 8, height: 4, weight_tenth_oz: 300, items: { yarn: 2 } },
      ],
    };
    // Three yarn this time across two lines; the memory only places two: the third joins box 1.
    expect(
      allocFromMemory(memory, [
        { line_id: "a", sku: "YARN", qty: 2 },
        { line_id: "b", sku: "yarn", qty: 1 },
        { line_id: "c", sku: "GUN", qty: 1 },
      ]),
    ).toEqual([{ c: 1, b: 1 }, { a: 2 }]);
  });

  it("only counts an order nothing has been sent from as whole", () => {
    expect(isWholeOrder(order([["l1", "YARN", 4, 1]]))).toBe(true);
    const part = order([["l1", "YARN", 4, 1]]);
    part.items[0].left = 3;
    expect(isWholeOrder(part)).toBe(false);
  });

  it("reads a stored row carefully", () => {
    expect(parseLearned({ item_key: "a×1", boxes: [] })).toBeNull();
    expect(
      parseLearned({ item_key: "a×1", boxes: [{ length: 0, width: 1, height: 1 }] }),
    ).toBeNull();
    expect(parseLearned({ item_key: 3, boxes: [{ length: 1, width: 1, height: 1 }] })).toBeNull();
    expect(
      parseLearned({
        item_key: "a×1",
        products_key: "a",
        boxes: [
          {
            box_id: "not-an-id",
            length: "12",
            width: 9,
            height: 4,
            weight_tenth_oz: "320.4",
            items: { a: 1, b: -2, c: "x" },
          },
        ],
      }),
    ).toEqual({
      item_key: "a×1",
      products_key: "a",
      boxes: [
        { box_id: null, length: 12, width: 9, height: 4, weight_tenth_oz: 320, items: { a: 1 } },
      ],
    });
  });
});

describe("what decides an order's boxes, strongest first", () => {
  const yarn = [["l1", "YARN", 4, 1]] as Line[];
  const remembered = learn(order(yarn), [
    { boxId: LARGE.id, length: 24, width: 18, height: 14, weightTenthOz: 800 },
  ]);
  const TUBE: SavedBox = {
    ...STANDARD,
    id: "44444444-4444-4444-8444-444444444444",
    name: "Tube",
    length_in: "30.00",
    width_in: "4.00",
    height_in: "4.00",
    empty_weight_oz: "8.00",
    is_default: false,
  };
  const rule = (actions: ShippingRule["actions"]): ShippingRule => ({
    id: "r1",
    name: "Yarn rule",
    enabled: true,
    conditions: [{ field: "product_skus", op: "includes_any", value: "yarn" }],
    actions,
  });
  const all = (over: Partial<PlanSetup> = {}) =>
    setup([remembered], {
      boxes: [STANDARD, LARGE, TUBE],
      rules: [
        rule([
          { type: "set_package", value: "tube" },
          { type: "require_signature", value: "adult" },
          { type: "set_service", value: "UPS Ground" },
        ]),
      ],
      ...over,
    });
  const saved = {
    v: 1 as const,
    boxes: [
      {
        box_id: STANDARD.id,
        length: 16,
        width: 12,
        height: 10,
        weight_tenth_oz: 500,
        items: { l1: 3 },
      },
      { box_id: null, length: 8, width: 6, height: 4, weight_tenth_oz: null, items: { l1: 1 } },
    ],
    signature: "none" as const,
    service: "USPS Priority",
  };

  it("a saved choice beats everything: boxes, split, weights, signature and service", () => {
    const plan = planFor(order(yarn), { saved }, 100, all());
    expect(plan.boxSource).toBe("saved");
    expect(plan.boxes.map((box) => box.box?.name ?? "custom")).toEqual(["Standard", "custom"]);
    expect(plan.boxes.map((box) => box.items)).toEqual([{ l1: 3 }, { l1: 1 }]);
    // The typed weight stands; the other follows its one item (1 lb, and no box weight for a custom size).
    expect(plan.boxes.map((box) => [box.weightTenthOz, box.weighed])).toEqual([
      [500, true],
      [160, false],
    ]);
    expect(plan).toMatchObject({
      signatureKind: "none",
      signature: false,
      signatureFrom: "saved",
      signatureRule: "Yarn rule",
      service: "USPS Priority",
      serviceFrom: "saved",
    });
    // The rule still shows as having had something to say.
    expect(plan.rules).toEqual(["Yarn rule"]);
    expect(BOX_NOTES[plan.boxSource]).toBe("your choice");
  });

  it("a saved choice that leaves signature and service alone lets the rule decide those", () => {
    const plan = planFor(
      order(yarn),
      { saved: { ...saved, signature: null, service: null } },
      100,
      all(),
    );
    expect(plan).toMatchObject({
      boxSource: "saved",
      signatureKind: "adult",
      signatureFrom: "rule",
      service: "UPS Ground",
      serviceFrom: "rule",
    });
  });

  it("then a rule's box, ahead of what was remembered (as on the bench it was ported from)", () => {
    const plan = planFor(order(yarn), null, 100, all());
    expect(plan.boxSource).toBe("rule");
    expect(plan.box?.name).toBe("Tube");
    // Its weight comes from the shop's figures, not the remembered one: 4 lb + the tube's 8 oz.
    expect(plan.weightTenthOz).toBe(4 * 160 + 80);
    expect(plan.boxes[0].weighed).toBe(false);
    expect(BOX_NOTES[plan.boxSource]).toBe("by rule");
  });

  it("then memory, when no rule names a box (or names one that isn't on the list)", () => {
    const signatureOnly = all({
      rules: [rule([{ type: "require_signature", value: "standard" }])],
    });
    expect(planFor(order(yarn), null, 100, signatureOnly)).toMatchObject({
      boxSource: "learned",
      signatureKind: "signature",
      weightTenthOz: 800,
    });
    const missing = all({ rules: [rule([{ type: "set_package", value: "Crate" }])] });
    expect(planFor(order(yarn), null, 100, missing).boxSource).toBe("learned");
  });

  it("then the usual box", () => {
    const plan = planFor(order(yarn), null, 100, all({ rules: [], memory: NO_MEMORY }));
    expect(plan).toMatchObject({ boxSource: "default", signatureKind: "none", service: null });
    expect(plan.box?.name).toBe("Standard");
  });

  it("the one box a person picked still beats a rule and memory", () => {
    const plan = planFor(order(yarn), LARGE.id, 100, all({ memory: NO_MEMORY }));
    expect(plan.boxSource).toBe("person");
    expect(plan.box?.name).toBe("Large");
    expect(planFor(order(yarn), { boxId: LARGE.id }, 100, all()).boxSource).toBe("person");
  });

  it("puts lines added since a choice was saved in the first box, and drops ones that have gone", () => {
    const grown = order([
      ["l1", "YARN", 2, 1],
      ["l9", "GUN", 1, 4],
    ]);
    const plan = planFor(grown, { saved }, 100, all({ rules: [] }));
    expect(plan.boxes.map((box) => box.items)).toEqual([
      { l1: 2, l9: 1 },
      { l1: 0, l9: 0 },
    ]);
  });

  it("a different plan is a different thing to price", async () => {
    const { fingerprint, sameFingerprint } = await import("./plan");
    const ruled = planFor(order(yarn), null, 100, all());
    const plain = planFor(order(yarn), null, 100, all({ rules: [], memory: NO_MEMORY }));
    const key = fingerprint(ruled.quoteFacts);
    expect(sameFingerprint(key, ruled.quoteFacts)).toBe(true);
    expect(sameFingerprint(key, plain.quoteFacts)).toBe(false);
    expect(sameFingerprint(key, planFor(order(yarn), { saved }, 100, all()).quoteFacts)).toBe(
      false,
    );
  });

  it("names the built-in signature amount among the rules that applied", () => {
    const over = setup([], {
      settings: { ...settings, signature_over: 250 },
      signatureName: "Signature on orders of $250.00 or more",
    });
    const plan = planFor(order(yarn), null, 250, over);
    expect(plan).toMatchObject({
      signature: true,
      signatureKind: "signature",
      signatureFrom: "rule",
      signatureRule: "Signature on orders of $250.00 or more",
      rules: ["Signature on orders of $250.00 or more"],
    });
    expect(planFor(order(yarn), null, 249.99, over).signature).toBe(false);
    expect(planFor(order(yarn), null, null, over).signature).toBe(false);
  });

  it("says when a rule would hold the order", () => {
    const held = all({ rules: [rule([{ type: "place_hold", value: "Check the dye lot" }])] });
    expect(planFor(order(yarn), null, 100, held).ruleHold).toBe("Check the dye lot");
    expect(planFor(order(yarn), null, 100, all()).ruleHold).toBeNull();
  });
});
