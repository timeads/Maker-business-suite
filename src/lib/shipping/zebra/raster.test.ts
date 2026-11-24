import { describe, expect, it } from "vitest";
import { code128 } from "../code128";
import { barModule, blankRows, lumaBits, pageCuts, stampBars } from "./raster";

describe("lumaBits", () => {
  it("prints what is dark and leaves light grey white", () => {
    const px = [0, 0, 0, 255, 255, 255, 255, 255, 0x33, 0x33, 0x33, 255, 0xbb, 0xbb, 0xbb, 255];
    expect([...lumaBits(px, 4, 1)]).toEqual([1, 0, 1, 0]);
  });
});

describe("barModule", () => {
  it("is three dots at 203 dpi, more on a finer printer, less only when it must be", () => {
    expect(barModule(143, 682, 203)).toBe(3);
    expect(barModule(143, 1008, 300)).toBe(4);
    expect(barModule(300, 682, 203)).toBe(2);
    expect(barModule(600, 682, 203)).toBe(1);
    expect(barModule(700, 682, 203)).toBe(0);
  });
});

/** The widths of the black and white runs along one row of dots. */
const runs = (row: Uint8Array) => {
  const out: [number, number][] = [];
  for (const bit of row) {
    const last = out[out.length - 1];
    if (last && last[0] === bit) last[1]++;
    else out.push([bit, 1]);
  }
  return out;
};

describe("stampBars", () => {
  const W = 812;
  const H = 120;
  const box = { x: 65.3, y: 10.2, width: 682.1, height: 93.4 };

  it("lays every bar and gap down as a whole number of modules, centred, over whatever was drawn", () => {
    const code = code128("68762-TG")!;
    const bits = new Uint8Array(W * H);
    // A blurry barcode drawn by the browser sits there first.
    for (let i = 0; i < bits.length; i++) bits[i] = i % 5 === 0 ? 1 : 0;
    const dots = stampBars(bits, W, H, box, code, 203);
    expect(dots).toBe(3);
    const row = bits.subarray(40 * W + 65, 40 * W + 748);
    const seen = runs(row);
    // White either side (the quiet zone and the centring), bars in between.
    expect(seen[0][0]).toBe(0);
    expect(seen[seen.length - 1][0]).toBe(0);
    const inner = seen.slice(1, -1);
    expect(inner.every(([, length]) => length % 3 === 0 && length / 3 <= 4)).toBe(true);
    // Exactly the code's own bars, in order.
    expect(inner.filter(([bit]) => bit === 1).map(([, length]) => length / 3)).toEqual(
      code.bars.map((bar) => bar.width),
    );
    // At least the ten-module quiet zone on each side.
    expect(seen[0][1]).toBeGreaterThanOrEqual(30);
    expect(seen[seen.length - 1][1]).toBeGreaterThanOrEqual(30);
    // Every row of the box is the same; rows outside it are untouched.
    expect([...bits.subarray(100 * W + 65, 100 * W + 748)]).toEqual([...row]);
    expect(bits[5 * W + 100]).toBe(1);
    expect(bits[5 * W + 101]).toBe(0);
  });

  it("keeps a box's code and a group's code scannable by narrowing the module", () => {
    const bits = new Uint8Array(W * H);
    expect(stampBars(bits, W, H, box, code128("68762-TG/B2")!, 203)).toBe(3);
    expect(stampBars(bits, W, H, box, code128("68762-TG+68763-TG+68764-TG")!, 203)).toBe(2);
  });

  it("leaves the drawing alone when the code can't fit at all", () => {
    const bits = new Uint8Array(W * H).fill(1);
    const narrow = { x: 0, y: 0, width: 100, height: 50 };
    expect(stampBars(bits, W, H, narrow, code128("68762-TG")!, 203)).toBe(0);
    expect(bits.every((bit) => bit === 1)).toBe(true);
  });
});

describe("pageCuts", () => {
  const rows = (pattern: [number, number][]) => {
    const blank: number[] = [];
    for (const [value, count] of pattern) for (let i = 0; i < count; i++) blank.push(value);
    return Uint8Array.from(blank);
  };

  it("finds the blank rows", () => {
    const bits = Uint8Array.from([0, 0, 0, 0, 1, 0, 0, 0, 0]);
    expect([...blankRows(bits, 3, 3)]).toEqual([1, 0, 1]);
  });

  it("is one label when the slip is one label tall", () => {
    expect(pageCuts(rows([[0, 1218]]), 1218, 203)).toEqual([{ from: 0, to: 1218, top: 0 }]);
    expect(pageCuts(rows([[0, 1222]]), 1218, 203).length).toBe(2);
  });

  it("cuts a long slip on white, never through a line, and starts the next label at its margin", () => {
    // Lines of text 30 dots tall with 10 dots of white between them.
    const pattern: [number, number][] = [];
    for (let i = 0; i < 60; i++) pattern.push([0, 30], [1, 10]);
    const blank = rows(pattern);
    const cuts = pageCuts(blank, 1218, 203);
    expect(cuts.length).toBe(3);
    expect(cuts[0]).toMatchObject({ from: 0, top: 0 });
    for (const [index, cut] of cuts.entries()) {
      // Every cut lands in white...
      if (cut.to < blank.length) expect(blank[cut.to]).toBe(1);
      // ...fits on the label with its margin...
      expect(cut.top + (cut.to - cut.from)).toBeLessThanOrEqual(1218);
      // ...and a continuation starts on ink, 0.3in down.
      if (index > 0) {
        expect(cut.top).toBe(61);
        expect(blank[cut.from]).toBe(0);
      }
    }
    // Nothing printed is lost between labels.
    const covered = new Uint8Array(blank.length);
    for (const cut of cuts) covered.fill(1, cut.from, cut.to);
    expect(blank.every((white, y) => white === 1 || covered[y] === 1)).toBe(true);
  });
});
