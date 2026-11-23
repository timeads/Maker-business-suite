import { describe, expect, it } from "vitest";
import {
  contentsTenthOz,
  emptyAlloc,
  fullAlloc,
  notInBox,
  setQty,
  splitEvenly,
  unitsIn,
  weightsKnown,
  withoutBox,
  type PackLine,
} from "./packing";

const rug: PackLine = { id: "rug", qty: 1, tenthOz: 800 };
const yarn: PackLine = { id: "yarn", qty: 4, tenthOz: 100 };
const lines = [rug, yarn];

describe("putting items in boxes", () => {
  it("starts with everything in the first box and a new box empty", () => {
    expect(fullAlloc(lines)).toEqual({ rug: 1, yarn: 4 });
    expect(emptyAlloc(lines)).toEqual({ rug: 0, yarn: 0 });
  });

  it("moving a single item to another box takes it out of the first", () => {
    const next = setQty([fullAlloc(lines), emptyAlloc(lines)], rug, 1, 1);
    expect(next).toEqual([
      { rug: 0, yarn: 4 },
      { rug: 1, yarn: 0 },
    ]);
  });

  it("raising a box's count takes from the boxes holding the most", () => {
    const start = [
      { rug: 1, yarn: 1 },
      { rug: 0, yarn: 3 },
      { rug: 0, yarn: 0 },
    ];
    expect(setQty(start, yarn, 2, 2)).toEqual([
      { rug: 1, yarn: 1 },
      { rug: 0, yarn: 1 },
      { rug: 0, yarn: 2 },
    ]);
  });

  it("lowering a box's count hands the units to the next box, so none go missing", () => {
    const next = setQty([fullAlloc(lines), emptyAlloc(lines)], yarn, 0, 1);
    expect(next).toEqual([
      { rug: 1, yarn: 1 },
      { rug: 0, yarn: 3 },
    ]);
    expect(notInBox(next, yarn)).toBe(0);
  });

  it("never puts in more than the order has, and treats rubbish as none", () => {
    const start = [fullAlloc(lines), emptyAlloc(lines)];
    expect(setQty(start, yarn, 1, 99)[1].yarn).toBe(4);
    expect(setQty(start, yarn, 1, Number.NaN)[1].yarn).toBe(0);
    expect(setQty(start, yarn, 7, 1)).toBe(start);
  });

  it("doesn't change the boxes it was given", () => {
    const start = [fullAlloc(lines), emptyAlloc(lines)];
    setQty(start, yarn, 1, 2);
    expect(start[0].yarn).toBe(4);
  });

  it("with one box, taking units out leaves them unpacked and says how many", () => {
    const next = setQty([fullAlloc(lines)], yarn, 0, 3);
    expect(notInBox(next, yarn)).toBe(1);
  });
});

describe("taking a box away", () => {
  it("moves what was in it to the box before", () => {
    const start = [
      { rug: 1, yarn: 0 },
      { rug: 0, yarn: 3 },
      { rug: 0, yarn: 1 },
    ];
    expect(withoutBox(start, 2)).toEqual([
      { rug: 1, yarn: 0 },
      { rug: 0, yarn: 4 },
    ]);
    expect(withoutBox(start, 0)).toEqual([
      { rug: 1, yarn: 3 },
      { rug: 0, yarn: 1 },
    ]);
  });

  it("leaves the last box alone", () => {
    const only = [fullAlloc(lines)];
    expect(withoutBox(only, 0)).toBe(only);
  });
});

describe("splitting evenly", () => {
  it("balances by weight, heaviest first, and packs every unit", () => {
    const split = splitEvenly(lines, 2);
    // The rug (80 oz) fills one box; the four yarns (40 oz) go in the other.
    expect(split).toEqual([
      { rug: 1, yarn: 0 },
      { rug: 0, yarn: 4 },
    ]);
    expect(notInBox(split, yarn)).toBe(0);
  });

  it("deals by count when weights aren't known", () => {
    const loose: PackLine = { id: "skein", qty: 5, tenthOz: null };
    const split = splitEvenly([loose], 2);
    expect(split.map((alloc) => alloc.skein)).toEqual([3, 2]);
  });
});

describe("box weights from their contents", () => {
  it("adds up what's in the box", () => {
    expect(contentsTenthOz({ rug: 1, yarn: 2 }, lines)).toBe(1000);
    expect(unitsIn({ rug: 1, yarn: 2 }, lines)).toBe(3);
  });

  it("is only offered when every item has a weight", () => {
    expect(weightsKnown(lines)).toBe(true);
    expect(weightsKnown([rug, { id: "x", qty: 1, tenthOz: null }])).toBe(false);
    expect(weightsKnown([])).toBe(false);
  });
});
