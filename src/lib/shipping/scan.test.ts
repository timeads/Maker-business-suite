import { describe, expect, it } from "vitest";
import { allPacked, orderCode, scanItem, type PackLine } from "./scan";

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
