import { describe, expect, it } from "vitest";
import {
  allPacked,
  boxPackLines,
  isItemCode,
  nextBox,
  orderCode,
  scanItem,
  type PackLine,
} from "./scan";

const lines: PackLine[] = [
  {
    line_id: "l1",
    title: "Wool rug",
    variant: "Large",
    sku: "RUG-L",
    barcode: "0123456789012",
    left: 2,
  },
  { line_id: "l2", title: "Yarn bundle", variant: null, sku: null, barcode: null, left: 1 },
  { line_id: "l3", title: "Already sent", variant: null, sku: "GONE", left: 0 },
];

describe("scan and pack", () => {
  it("reads an order number off a slip or as typed", () => {
    expect(orderCode("1042")).toBe("1042");
    expect(orderCode(" #1052-TG ")).toBe("1052-TG");
    expect(orderCode("")).toBe("");
    expect(orderCode("%_%")).toBe("");
  });

  it("ticks one unit per scan, by SKU or barcode, whatever the case", () => {
    const first = scanItem(lines, {}, "rug-l");
    expect(first).toEqual({ ok: true, line_id: "l1", title: "Wool rug", done: false });
    const second = scanItem(lines, { l1: 1 }, "0123456789012");
    expect(second).toMatchObject({ ok: true, line_id: "l1" });
  });

  it("says plainly when a scan is wrong", () => {
    expect(scanItem(lines, {}, "RUG-M")).toEqual({ ok: false, reason: "unknown" });
    // Something on the order that has already gone isn't packed again.
    expect(scanItem(lines, {}, "GONE")).toEqual({ ok: false, reason: "unknown" });
    expect(scanItem(lines, { l1: 2 }, "RUG-L")).toEqual({
      ok: false,
      reason: "full",
      title: "Wool rug",
      left: 2,
    });
    expect(scanItem(lines, {}, "  ")).toEqual({ ok: false, reason: "unknown" });
  });

  it("knows when everything left to send is packed", () => {
    expect(allPacked(lines, { l1: 2 })).toBe(false);
    expect(allPacked(lines, { l1: 2, l2: 1 })).toBe(true);
    expect(allPacked([lines[2]], {})).toBe(false);
    expect(
      scanItem([{ line_id: "a", title: "One", variant: null, sku: "A", left: 1 }], {}, "a"),
    ).toMatchObject({ ok: true, done: true });
  });

  it("gives a shared code to the line that still needs it", () => {
    const twins: PackLine[] = [
      { line_id: "a", title: "Yarn", variant: "Red", sku: "YARN", left: 1 },
      { line_id: "b", title: "Yarn", variant: "Gift", sku: "YARN", left: 1 },
    ];
    expect(scanItem(twins, { a: 1 }, "YARN")).toMatchObject({ ok: true, line_id: "b", done: true });
  });
});

describe("packing one box of several", () => {
  const first = { n: 1, items: { l1: 1, l3: 2 } };
  const second = { n: 2, items: { l1: 1, l2: 1 } };

  it("lists only what goes in that box, in that box's numbers", () => {
    expect(boxPackLines(lines, first).map((line) => [line.line_id, line.left])).toEqual([
      ["l1", 1],
      // Nothing is left of it on the order (the labels are bought), but two went in this box.
      ["l3", 2],
    ]);
    expect(boxPackLines(lines, second).map((line) => [line.line_id, line.left])).toEqual([
      ["l1", 1],
      ["l2", 1],
    ]);
    expect(boxPackLines(lines, { items: {} })).toEqual([]);
  });

  it("checks a box against its own numbers, not the order's", () => {
    const inBox = boxPackLines(lines, second);
    const one = scanItem(inBox, {}, "RUG-L");
    expect(one).toMatchObject({ ok: true, line_id: "l1", done: false });
    // The order has two rugs, but only one goes in this box.
    expect(scanItem(inBox, { l1: 1 }, "RUG-L")).toMatchObject({
      ok: false,
      reason: "full",
      left: 1,
    });
    expect(allPacked(inBox, { l1: 1 })).toBe(false);
    expect(allPacked(inBox, { l1: 1, l2: 1 })).toBe(true);
    // Something that goes in another box isn't in this one.
    expect(scanItem(inBox, {}, "GONE")).toEqual({ ok: false, reason: "unknown" });
    expect(isItemCode(lines, "gone")).toBe(true);
  });

  it("tells an item's code from anything else", () => {
    expect(isItemCode(lines, "rug-l")).toBe(true);
    expect(isItemCode(lines, " 0123456789012 ")).toBe(true);
    expect(isItemCode(lines, "1042")).toBe(false);
    expect(isItemCode(lines, "")).toBe(false);
  });

  it("knows which box's label is still to print", () => {
    const boxes = [{ n: 1 }, { n: 2 }, { n: 3 }];
    expect(nextBox(boxes, [])).toEqual({ n: 1 });
    expect(nextBox(boxes, [1, 3])).toEqual({ n: 2 });
    expect(nextBox(boxes, [3, 2, 1])).toBeNull();
  });
});
