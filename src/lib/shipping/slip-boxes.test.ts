import { describe, expect, it } from "vitest";
import { code128 } from "./code128";
import {
  barcodeSafe,
  boughtBoxes,
  boxLines,
  boxSlipCode,
  groupSlipCode,
  looksLikeSlip,
  parseSlipCode,
  slipBoxes,
  slipCode,
} from "./slip-boxes";

describe("the code on a packing slip", () => {
  it("is the order's name without its #", () => {
    expect(slipCode("#68762-TG")).toBe("68762-TG");
    expect(slipCode(" #1042 ")).toBe("1042");
    expect(slipCode(null)).toBe("");
  });

  it("says which box on a box's slip, in a form both printers can draw", () => {
    const code = boxSlipCode(slipCode("#68762-TG"), 2);
    expect(code).toBe("68762-TG/B2");
    expect(barcodeSafe(code)).toBe(true);
    expect(code128(code)).not.toBeNull();
  });

  it("joins the orders going together, or falls back to the first when that's too long", () => {
    expect(groupSlipCode(["#1042", "#1055-TG"])).toBe("1042+1055-TG");
    expect(barcodeSafe("1042+1055-TG")).toBe(true);
    const many = Array.from({ length: 8 }, (_, index) => `#6876${index}-TG`);
    expect(groupSlipCode(many)).toBe("68760-TG");
    expect(groupSlipCode([])).toBe("");
  });

  it("refuses what a Zebra would read as a command", () => {
    expect(barcodeSafe("1042^XA")).toBe(false);
    expect(barcodeSafe("1042~B2")).toBe(false);
    expect(barcodeSafe("")).toBe(false);
    expect(barcodeSafe("x".repeat(33))).toBe(false);
  });
});

describe("reading a scanned slip", () => {
  it("reads a plain order number", () => {
    expect(parseSlipCode(" #1052-TG ")).toEqual({
      whole: "1052-TG",
      base: "1052-TG",
      box: null,
      parts: ["1052-TG"],
    });
    expect(parseSlipCode("")).toBeNull();
    expect(parseSlipCode("%_%")).toBeNull();
  });

  it("reads a box's code", () => {
    expect(parseSlipCode("68762-TG/B2")).toMatchObject({ base: "68762-TG", box: 2 });
    expect(parseSlipCode("#1042/b12")).toMatchObject({ base: "1042", box: 12 });
  });

  it("forgives the separators scanners swap in for the slash", () => {
    for (const typed of ["1042/B2", "1042-B2", "1042?B2", "1042 B2", "1042-b2"]) {
      expect(parseSlipCode(typed), typed).toMatchObject({ base: "1042", box: 2 });
    }
  });

  it("keeps the whole code too, for an order really called that", () => {
    // "1042-B2" might be an order's own name: the caller looks for it first.
    expect(parseSlipCode("1042-B2")).toMatchObject({ whole: "1042-B2", base: "1042", box: 2 });
    // A "?" can't be in an order's name, so only the box reading stands.
    expect(parseSlipCode("1042?B2")).toMatchObject({ whole: "1042", base: "1042", box: 2 });
  });

  it("doesn't take box 0, or a third digit, for a box", () => {
    expect(parseSlipCode("1042/B0")).toMatchObject({ whole: "1042/B0", box: null });
    expect(parseSlipCode("1042-B123")).toMatchObject({ whole: "1042-B123", box: null });
  });

  it("reads orders going together, with or without a box", () => {
    expect(parseSlipCode("1042+1055-TG")).toMatchObject({
      box: null,
      parts: ["1042", "1055-TG"],
    });
    expect(parseSlipCode("#1042+#1055/B2")).toMatchObject({ box: 2, parts: ["1042", "1055"] });
    expect(parseSlipCode("1042+%")).toBeNull();
  });
});

describe("telling a slip from an item at the bench", () => {
  it("knows the old app's order numbers, with and without a box", () => {
    for (const typed of ["68762-TG", "#1042", "1042", "68762-TG/B2", "1042-B2", "1042?b3"]) {
      expect(looksLikeSlip(typed), typed).toBe(true);
    }
  });

  it("takes an item's code for an item", () => {
    for (const typed of ["RUG-L", "YARN-12", "AB", "", "12"]) {
      expect(looksLikeSlip(typed), typed).toBe(false);
    }
  });

  it("knows another box of the order that is open, whatever the order is called", () => {
    expect(looksLikeSlip("ORD-A7/B2", "#ORD-A7")).toBe(true);
    expect(looksLikeSlip("ord-a7 b3", "#ORD-A7")).toBe(true);
    expect(looksLikeSlip("ORD-A7/B2", "#ORD-A8")).toBe(false);
    expect(looksLikeSlip("ORD-A7/B2")).toBe(false);
  });

  it("knows a slip for orders going together, and anything with a #", () => {
    expect(looksLikeSlip("1042+1055-TG")).toBe(true);
    expect(looksLikeSlip("#ORD-A7")).toBe(true);
  });
});

describe("which boxes get their own slip", () => {
  const box = (items: Record<string, number>, name: string | null = null) => ({
    name,
    tracking: null,
    items,
  });

  it("gives an order in one box one slip for the whole order", () => {
    expect(slipBoxes([box({ l1: 2 })])).toEqual([]);
    expect(slipBoxes([])).toEqual([]);
  });

  it("gives each box with something in it its own slip, numbered in order", () => {
    const boxes = slipBoxes([box({ l1: 2 }, "Medium box"), box({ l1: 1, l2: 1 }, "Tube")]);
    expect(boxes.map((each) => [each.n, each.of, each.name, each.label])).toEqual([
      [1, 2, "Medium box", 1],
      [2, 2, "Tube", 2],
    ]);
  });

  it("leaves an empty box out, and still knows where each label sits", () => {
    const boxes = slipBoxes([box({ l1: 1 }), box({}), box({ l2: 0, l3: 4 })]);
    expect(boxes.map((each) => [each.n, each.of, each.label])).toEqual([
      [1, 2, 1],
      [2, 2, 3],
    ]);
    // Only one box has anything in it: one slip for the order.
    expect(slipBoxes([box({ l1: 1 }), box({})])).toEqual([]);
  });

  it("lists only what is in the box, with the number in that box", () => {
    const lines = [
      { line_id: "l1", title: "Wool rug" },
      { line_id: "l2", title: "Yarn" },
    ];
    expect(boxLines(lines, { items: { l1: 2 } })).toEqual([
      { line_id: "l1", title: "Wool rug", inBox: 2 },
    ]);
    expect(boxLines(lines, { items: { l2: 1, gone: 3 } })).toEqual([
      { line_id: "l2", title: "Yarn", inBox: 1 },
    ]);
  });
});

describe("the boxes kept with a bought label", () => {
  it("reads each box with its own tracking number", () => {
    expect(
      boughtBoxes(
        [
          { name: "Medium box", items: { l1: 2 } },
          { name: "", items: { l2: 1, l3: 0 } },
        ],
        ["1Z1", "1Z2"],
      ),
    ).toEqual([
      { name: "Medium box", tracking: "1Z1", items: { l1: 2 } },
      { name: null, tracking: "1Z2", items: { l2: 1 } },
    ]);
  });

  it("is empty for anything it can't trust, so the parcel keeps one slip", () => {
    expect(boughtBoxes(null, [])).toEqual([]);
    expect(boughtBoxes("boxes", [])).toEqual([]);
    expect(boughtBoxes([{ name: "A" }], [])).toEqual([]);
    expect(boughtBoxes([{ items: [1, 2] }], [])).toEqual([]);
    expect(boughtBoxes([{ items: { l1: 1 } }, null], [])).toEqual([]);
  });
});
