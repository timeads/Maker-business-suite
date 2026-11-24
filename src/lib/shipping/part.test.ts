import { describe, expect, it } from "vitest";
import {
  PART_CHANGED,
  cleanPart,
  formatPart,
  leftBehind,
  parsePart,
  partHoldNote,
  partOrder,
  samePart,
} from "./part";

const lines = [
  {
    line_id: "gid://shopify/LineItem/1",
    title: "Tufting Cloth",
    variant: null,
    grams: 400,
    left: 2,
  },
  { line_id: "gid://shopify/LineItem/2", title: "Yarn", variant: "Red", grams: 100, left: 3 },
  { line_id: "gid://shopify/LineItem/3", title: "Frame", variant: null, grams: null, left: 0 },
];

describe("which items go now", () => {
  it("survives the trip through the page's address", () => {
    const part = [
      { line_id: "gid://shopify/LineItem/1", qty: 1 },
      { line_id: "gid://shopify/LineItem/2", qty: 3 },
    ];
    expect(parsePart(formatPart(part), lines)).toEqual(part);
  });

  it("never asks for more than is left, or for a line that has gone", () => {
    expect(
      parsePart(
        formatPart([
          { line_id: "gid://shopify/LineItem/1", qty: 1 },
          { line_id: "gid://shopify/LineItem/2", qty: 99 },
          { line_id: "gid://shopify/LineItem/3", qty: 1 },
          { line_id: "not-on-the-order", qty: 1 },
        ]),
        lines,
      ),
    ).toEqual([
      { line_id: "gid://shopify/LineItem/1", qty: 1 },
      { line_id: "gid://shopify/LineItem/2", qty: 3 },
    ]);
  });

  it("is no part at all when it is everything left, nothing, or nonsense", () => {
    expect(
      parsePart(
        formatPart([
          { line_id: "gid://shopify/LineItem/1", qty: 2 },
          { line_id: "gid://shopify/LineItem/2", qty: 3 },
        ]),
        lines,
      ),
    ).toBeNull();
    expect(parsePart("", lines)).toBeNull();
    expect(parsePart(undefined, lines)).toBeNull();
    expect(parsePart("x~y,~,-1~a,1.5~b,%E0%A4%A~c", lines)).toBeNull();
  });

  it("knows when two lists are the same, whatever their order", () => {
    const a = [
      { line_id: "a", qty: 1 },
      { line_id: "b", qty: 2 },
    ];
    expect(samePart(a, [...a].reverse())).toBe(true);
    expect(samePart(a, [{ line_id: "a", qty: 1 }])).toBe(false);
    expect(samePart(null, null)).toBe(true);
    expect(samePart(a, null)).toBe(false);
  });
});

describe("what is left behind", () => {
  const part = [
    { line_id: "gid://shopify/LineItem/1", qty: 1 },
    { line_id: "gid://shopify/LineItem/2", qty: 1 },
  ];
  it("lists what still has to go, with its option", () => {
    expect(leftBehind(lines, part)).toBe("1 × Tufting Cloth, 2 × Yarn (Red)");
    expect(partHoldNote(lines, part)).toBe(
      "Part sent — waiting on: 1 × Tufting Cloth, 2 × Yarn (Red)",
    );
  });

  it("lays out only what is going, with its weight when every item says its own", () => {
    const going = partOrder({ items: lines, units_left: 5 }, part);
    expect(going.units_left).toBe(2);
    expect(going.items.map((item) => item.left)).toEqual([1, 1, 0]);
    expect(going.weight_grams).toBe(500);
    const unweighed = partOrder(
      { items: lines.map((line) => ({ ...line, grams: null })), units_left: 5 },
      part,
    );
    expect(unweighed.weight_grams).toBeNull();
  });
});

describe("a part as the browser sent it", () => {
  it("is taken when every item is still there to send", () => {
    expect(cleanPart([{ line_id: "gid://shopify/LineItem/2", qty: 2 }], lines)).toEqual({
      part: [{ line_id: "gid://shopify/LineItem/2", qty: 2 }],
    });
    expect(cleanPart(undefined, lines)).toEqual({ part: null });
  });

  it("is the whole order when it is everything left", () => {
    expect(
      cleanPart(
        [
          { line_id: "gid://shopify/LineItem/1", qty: 2 },
          { line_id: "gid://shopify/LineItem/2", qty: 3 },
        ],
        lines,
      ),
    ).toEqual({ part: null });
  });

  it("is refused when it asks for more than is left, or isn't a list of items", () => {
    expect(cleanPart([{ line_id: "gid://shopify/LineItem/2", qty: 4 }], lines)).toEqual({
      error: PART_CHANGED,
    });
    expect(cleanPart([{ line_id: "gid://shopify/LineItem/3", qty: 1 }], lines)).toEqual({
      error: PART_CHANGED,
    });
    expect(cleanPart("everything", lines)).toEqual({ error: PART_CHANGED });
    expect(cleanPart([{ line_id: "gid://shopify/LineItem/2", qty: 1.5 }], lines)).toEqual({
      error: PART_CHANGED,
    });
    expect("error" in cleanPart([{ line_id: "gid://shopify/LineItem/2", qty: 0 }], lines)).toBe(
      true,
    );
  });
});
