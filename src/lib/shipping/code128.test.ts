import { describe, expect, it } from "vitest";
import { code128, code128Values } from "./code128";

/** The bars and spaces as a string of module widths, to compare with the published patterns. */
function widths(text: string): string {
  const code = code128(text)!;
  let out = "";
  let x = 10;
  for (const bar of code.bars) {
    if (bar.x > x) out += String(bar.x - x);
    out += String(bar.width);
    x = bar.x + bar.width;
  }
  return out;
}

describe("Code 128 B", () => {
  it("uses the published start, check and stop symbols", () => {
    // Wikipedia's worked example, "PJJ123C": the weighted sum of its characters
    // is 775; with Start B (104) that is 879, and 879 mod 103 = 55.
    expect(code128Values("PJJ123C")).toEqual([104, 48, 42, 42, 17, 18, 19, 35, 55, 106]);
    // "A": 104 + 33 × 1 = 137, mod 103 = 34.
    expect(code128Values("A")).toEqual([104, 33, 34, 106]);
    // An order number: 104 + 17×1 + 16×2 + 20×3 + 18×4 = 285, mod 103 = 79.
    expect(code128Values("1042")).toEqual([104, 17, 16, 20, 18, 79, 106]);
  });

  it("draws the published bar patterns", () => {
    // Start B 211214, "A" (33) 111323, check 34 131123, stop 2331112.
    expect(widths("A")).toBe("211214" + "111323" + "131123" + "2331112");
    // "0" is value 16 (123122), "1" is 17 (123221); check = (104 + 16 + 34) mod 103 = 51 (213113).
    expect(widths("01")).toBe("211214" + "123122" + "123221" + "213113" + "2331112");
  });

  it("is 11 modules a symbol, 13 for the stop, with quiet zones", () => {
    const code = code128("1042")!;
    expect(code.width).toBe(10 + 6 * 11 + 13 + 10);
    expect(code.bars[0]).toEqual({ x: 10, width: 2 });
    // Every symbol has three bars; the stop has four.
    expect(code.bars).toHaveLength(6 * 3 + 4);
  });

  it("refuses what it can't carry instead of printing a wrong code", () => {
    expect(code128("")).toBeNull();
    expect(code128("Zoë")).toBeNull();
    expect(code128("x".repeat(41))).toBeNull();
    expect(code128("#1052-TG")).not.toBeNull();
  });
});
