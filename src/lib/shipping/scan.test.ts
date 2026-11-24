import { describe, expect, it } from "vitest";
import { parsePart } from "./part";
import {
  allPacked,
  autoPrintNow,
  benchChoice,
  benchMargin,
  boxPackLines,
  isItemCode,
  nextBox,
  notScanned,
  orderCode,
  partQuery,
  scanItem,
  scannedPart,
  type BenchBox,
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

describe("the bench's box row", () => {
  const BOX = "b0000000-0000-4000-8000-000000000001";
  const base = { boxes: [{ items: { a: 2, b: 1 } }] };
  const row = (over: Partial<BenchBox> = {}): BenchBox => ({
    boxId: BOX,
    length: "16",
    width: "12",
    height: "10",
    weightLb: "",
    weightOz: "",
    ...over,
  });

  it("becomes the one planned box, with its items, and a weight that follows them", () => {
    expect(benchChoice(row(), base)).toEqual({
      v: 1,
      boxes: [
        {
          box_id: BOX,
          length: 16,
          width: 12,
          height: 10,
          weight_tenth_oz: null,
          items: { a: 2, b: 1 },
        },
      ],
      signature: null,
      service: null,
    });
  });

  it("carries a typed weight, and a size typed in has no saved box", () => {
    const choice = benchChoice(row({ boxId: "", weightLb: "2", weightOz: "4" }), base);
    expect(choice?.boxes[0]).toMatchObject({ box_id: null, weight_tenth_oz: 360 });
  });

  it("keeps a signature and service already saved for the order", () => {
    const choice = benchChoice(row(), base, { signature: "adult", service: "UPS Ground" });
    expect(choice).toMatchObject({ signature: "adult", service: "UPS Ground" });
  });

  it("is nothing for an order planned in several boxes, or a figure that isn't one", () => {
    expect(benchChoice(row(), { boxes: [{ items: {} }, { items: {} }] })).toBeNull();
    expect(benchChoice(row({ length: "abc" }), base)).toBeNull();
    expect(benchChoice(row({ length: "0" }), base)).toBeNull();
    expect(benchChoice(row({ weightLb: "-1" }), base)).toBeNull();
    expect(benchChoice(row({ weightLb: "0", weightOz: "0" }), base)).toBeNull();
  });
});

describe("shipping what's scanned", () => {
  const lines: PackLine[] = [
    { line_id: "a", title: "Wool rug", variant: "Large", sku: "RUG-L", left: 2 },
    { line_id: "b", title: "Yarn cone", variant: null, sku: "YARN", left: 3 },
    { line_id: "c", title: "Gift note", variant: null, sku: null, left: 1 },
  ];

  it("sends only what was scanned, never more than is left", () => {
    expect(scannedPart(lines, { a: 2, b: 1 })).toEqual([
      { line_id: "a", qty: 2 },
      { line_id: "b", qty: 1 },
    ]);
    expect(scannedPart(lines, { a: 9 })).toEqual([{ line_id: "a", qty: 2 }]);
    expect(scannedPart(lines, {})).toEqual([]);
  });

  it("says what is left behind", () => {
    expect(notScanned(lines, { a: 2, b: 1 })).toEqual(["2 × Yarn cone", "1 × Gift note"]);
    expect(notScanned(lines, { a: 1 })[0]).toBe("1 × Wool rug (Large)");
  });

  it("writes the order page's part link, which reads it back", () => {
    const part = scannedPart(
      [{ line_id: "gid://shop/LineItem/1", title: "x", variant: null, sku: null, left: 2 }],
      { "gid://shop/LineItem/1": 1 },
    );
    const query = partQuery(part);
    expect(query).toBe("1~gid%3A%2F%2Fshop%2FLineItem%2F1");
    expect(
      parsePart(query, [
        { line_id: "gid://shop/LineItem/1", title: "x", left: 2 },
        { line_id: "other", title: "y", left: 1 },
      ]),
    ).toEqual(part);
  });
});

describe("the bench's sums and the auto-print tick", () => {
  it("works out the margin in whole cents", () => {
    expect(benchMargin(33, "12.40")).toBe(2060);
    expect(benchMargin(8.1, "8.40")).toBe(-30);
    expect(benchMargin(0, "5.00")).toBe(-500);
    expect(benchMargin(null, "5.00")).toBeNull();
    expect(benchMargin(5, "n/a")).toBeNull();
  });

  it("presses print only on a finishing scan, with the box ticked", () => {
    const facts = { ticked: true, verified: true, byHand: false, blocked: false };
    expect(autoPrintNow(facts)).toBe(true);
    expect(autoPrintNow({ ...facts, ticked: false })).toBe(false);
    expect(autoPrintNow({ ...facts, verified: false })).toBe(false);
    // Counts filled in by hand don't count as checked with the scanner.
    expect(autoPrintNow({ ...facts, byHand: true })).toBe(false);
    // On hold, already labelled, unpaid: the page says why instead.
    expect(autoPrintNow({ ...facts, blocked: true })).toBe(false);
  });
});

describe("matching an item by its SKU or the option's barcode", () => {
  const lines: PackLine[] = [
    { line_id: "a", title: "Yarn", variant: "Royal", sku: "Y-ROYAL", barcode: "0012345", left: 1 },
    { line_id: "b", title: "Yarn", variant: "Grey", sku: "Y-GREY", barcode: "0012346", left: 2 },
  ];

  it("takes either code, whatever its case, and counts up on a second scan", () => {
    expect(scanItem(lines, {}, "y-royal")).toMatchObject({ ok: true, line_id: "a" });
    expect(scanItem(lines, {}, " 0012346 ")).toMatchObject({ ok: true, line_id: "b", done: false });
    expect(scanItem(lines, { a: 1, b: 1 }, "0012346")).toMatchObject({ ok: true, done: true });
  });

  it("refuses one scan too many, and a code that isn't on the order", () => {
    expect(scanItem(lines, { a: 1 }, "0012345")).toMatchObject({ ok: false, reason: "full" });
    expect(scanItem(lines, {}, "0099999")).toEqual({ ok: false, reason: "unknown" });
  });
});
