import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CATEGORICAL,
  DASHES,
  MARKERS,
  NEUTRAL,
  SLOTS,
  SURFACES,
  contrast,
  difference,
  lightnessChroma,
  slotColour,
} from "./palette";

const css = readFileSync(join(__dirname, "..", "..", "app", "globals.css"), "utf8");

/** Every value a token is given in globals.css, in order (light first, then each dark block). */
const tokenValues = (name: string) =>
  [...css.matchAll(new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`, "gi"))].map((m) =>
    m[1].toLowerCase(),
  );

describe("the categorical chart palette", () => {
  it("is what globals.css declares, light and both dark blocks", () => {
    for (let slot = 1; slot <= SLOTS; slot++) {
      const values = tokenValues(`chart-cat-${slot}`);
      expect(values).toEqual([
        CATEGORICAL.light[slot - 1],
        CATEGORICAL.dark[slot - 1],
        CATEGORICAL.dark[slot - 1],
      ]);
    }
    expect(tokenValues("chart-neutral")).toEqual([NEUTRAL.light, NEUTRAL.dark, NEUTRAL.dark]);
    expect(CATEGORICAL.dark).toHaveLength(SLOTS);
    expect(slotColour(3)).toBe("var(--chart-cat-3)");
    expect(slotColour(null)).toBe("var(--chart-neutral)");
  });

  for (const mode of ["light", "dark"] as const) {
    describe(`on the ${mode} cards`, () => {
      const palette = CATEGORICAL[mode];

      it("stands out at least 3:1 from both card backgrounds", () => {
        for (const surface of SURFACES[mode]) {
          for (const colour of [...palette, NEUTRAL[mode]]) {
            expect(contrast(colour, surface), `${colour} on ${surface}`).toBeGreaterThanOrEqual(3);
          }
        }
      });

      it("keeps each colour a colour (chroma) in a readable lightness band", () => {
        const [lo, hi] = mode === "light" ? [0.43, 0.78] : [0.48, 0.7];
        for (const colour of palette) {
          const { l, c } = lightnessChroma(colour);
          expect(l, colour).toBeGreaterThanOrEqual(lo);
          expect(l, colour).toBeLessThanOrEqual(hi);
          expect(c, colour).toBeGreaterThanOrEqual(0.1);
        }
      });

      it("tells neighbours apart with colour-blindness and without", () => {
        for (let i = 0; i < palette.length - 1; i++) {
          const [a, b] = [palette[i], palette[i + 1]];
          expect(difference(a, b), `${a} / ${b}`).toBeGreaterThanOrEqual(15);
          expect(difference(a, b, "protan"), `${a} / ${b} protan`).toBeGreaterThanOrEqual(8);
          expect(difference(a, b, "deutan"), `${a} / ${b} deutan`).toBeGreaterThanOrEqual(8);
        }
      });

      it("never repeats a colour, and every pair differs at least a little to the eye", () => {
        for (let i = 0; i < palette.length; i++) {
          for (let j = i + 1; j < palette.length; j++) {
            expect(
              difference(palette[i], palette[j]),
              `${palette[i]} / ${palette[j]}`,
            ).toBeGreaterThan(5);
          }
        }
      });
    });
  }

  it("gives every slot its own dash and marker pair, so colour is never the only cue", () => {
    const pairs = new Set(DASHES.map((dash, i) => `${dash}|${MARKERS[i]}`));
    expect(DASHES).toHaveLength(SLOTS);
    expect(new Set(DASHES).size).toBe(SLOTS);
    expect(pairs.size).toBe(SLOTS);
  });
});
