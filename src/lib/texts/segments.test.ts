import { describe, expect, it } from "vitest";
import { lengthWords, textLength } from "./segments";

describe("counting a text the way phone networks do", () => {
  it("fits 160 plain characters in one text, and 153 a text after that", () => {
    expect(textLength("").segments).toBe(0);
    expect(textLength("a".repeat(160))).toMatchObject({ encoding: "gsm", units: 160, segments: 1 });
    expect(textLength("a".repeat(161))).toMatchObject({ segments: 2, perSegment: 153 });
    expect(textLength("a".repeat(306)).segments).toBe(2);
    expect(textLength("a".repeat(307)).segments).toBe(3);
  });

  it("counts the extended characters as two places each", () => {
    expect(textLength("€").units).toBe(2);
    expect(textLength("[x]").units).toBe(5);
    expect(textLength("€".repeat(80)).segments).toBe(1);
    expect(textLength("€".repeat(81)).segments).toBe(2);
  });

  it("drops to 70 a text when anything outside the plain set is used, and says what", () => {
    const curly = textLength("You’re booked");
    expect(curly).toMatchObject({ encoding: "unicode", segments: 1, perSegment: 70 });
    expect(curly.unusual).toEqual(["’"]);
    expect(textLength("é".repeat(10)).encoding).toBe("gsm");
    expect(textLength("ê".repeat(70)).segments).toBe(1);
    expect(textLength("ê".repeat(71))).toMatchObject({ segments: 2, perSegment: 67 });
    // An emoji takes two places.
    expect(textLength("🧶").units).toBe(2);
  });

  it("says it in plain words", () => {
    expect(lengthWords(textLength("Hello"))).toBe("1 text (5 of 160 characters).");
    expect(lengthWords(textLength("a".repeat(200)))).toMatch(/^Sent as 2 texts joined together/);
    expect(lengthWords(textLength("Hi 🧶"))).toContain("fewer fit in each text");
  });
});
