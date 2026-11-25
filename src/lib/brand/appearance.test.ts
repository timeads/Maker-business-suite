import { describe, expect, it } from "vitest";
import {
  brandThemeVars,
  brandThemeVarsDark,
  hue,
  mix,
  parseAppearance,
  readsAsWarning,
} from "./appearance";
import { brandKitSchema, contrast } from "./kit";

const kit = (colors: [string, string][]) =>
  brandKitSchema.parse({
    version: 1,
    name: "X",
    colors: colors.map(([name, hex]) => ({ name, hex })),
  });

describe("a workspace's own look", () => {
  it("starts light, and ignores settings it can't read", () => {
    expect(parseAppearance(null)).toMatchObject({ mode: "light", brand_colors: false });
    expect(parseAppearance({ version: 1, mode: "neon" })).toMatchObject({ mode: "light" });
    expect(parseAppearance({ version: 1, mode: "dark", brand_colors: true })).toEqual({
      version: 1,
      mode: "dark",
      brand_colors: true,
    });
  });

  it("mixes colours", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mix("#102030", "#102030", 0.7)).toBe("#102030");
  });

  it("never makes the filled button a red, which on screen means something went wrong", () => {
    expect(Math.round(hue("#ff0000"))).toBe(0);
    expect(Math.round(hue("#00ff00"))).toBe(120);
    expect(Math.round(hue("#0000ff"))).toBe(240);
    for (const red of ["#b03424", "#e0705f", "#b5532c", "#d7263d", "#e63946"]) {
      expect(readsAsWarning(red)).toBe(true);
    }
    for (const fine of ["#c78c2b", "#f28c28", "#0051ff", "#1f3d2b", "#8a8a8a", "#f6efe2"]) {
      expect(readsAsWarning(fine)).toBe(false);
    }
    // Rust is the liveliest colour here; the button takes the next one instead.
    const earthy = brandThemeVars(
      kit([
        ["forest", "#1f3d2b"],
        ["cream", "#f6efe2"],
        ["rust", "#b5532c"],
        ["sky", "#9cc4d9"],
      ]),
    );
    expect(earthy["--tuft-ochre"]).toBe("#9cc4d9");
    // Nothing but red to choose from: the button stays the house ochre.
    const reds = brandThemeVars(
      kit([
        ["ink", "#1a1a1a"],
        ["paper", "#ffffff"],
        ["tomato", "#d7263d"],
      ]),
    );
    expect(reds["--tuft-ochre"]).toBeUndefined();
    expect(reds["--tuft-on-ochre"]).toBeUndefined();
    expect(reds["--tuft-teal"]).toBeDefined();
  });

  const palettes: [string, [string, string][]][] = [
    [
      "earthy",
      [
        ["forest", "#1f3d2b"],
        ["cream", "#f6efe2"],
        ["rust", "#b5532c"],
        ["sky", "#9cc4d9"],
      ],
    ],
    [
      "pastel, nothing dark",
      [
        ["pink", "#f7c8d8"],
        ["butter", "#fff3b0"],
        ["mint", "#bfe8d0"],
      ],
    ],
    [
      "two greys",
      [
        ["ink", "#222222"],
        ["paper", "#fafafa"],
      ],
    ],
    [
      "bright",
      [
        ["yellow", "#ffe813"],
        ["blue", "#0051ff"],
        ["white", "#ffffff"],
        ["black", "#000000"],
      ],
    ],
  ];
  for (const [name, colors] of palettes) {
    it(`keeps the menu and the button readable for a ${name} palette`, () => {
      for (const vars of [brandThemeVars(kit(colors)), brandThemeVarsDark(kit(colors))]) {
        if (vars["--tuft-teal"]) {
          expect(contrast(vars["--tuft-teal"], "#f3efe9")).toBeGreaterThanOrEqual(7);
        }
        if (vars["--tuft-ochre"]) {
          expect(contrast(vars["--tuft-ochre"], vars["--tuft-on-ochre"])).toBeGreaterThanOrEqual(
            4.5,
          );
        }
      }
      const light = brandThemeVars(kit(colors));
      if (light["--tuft-ochre-text"]) {
        expect(contrast(light["--tuft-ochre-text"], "#ffffff")).toBeGreaterThanOrEqual(4.5);
      }
      const dark = brandThemeVarsDark(kit(colors));
      if (dark["--tuft-ochre-text"]) {
        expect(contrast(dark["--tuft-ochre-text"], "#211f1d")).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it("uses the brand's dark colour for the menu and its accent for the button", () => {
    const vars = brandThemeVars(kit(palettes[0][1]));
    expect(vars["--tuft-teal"]).toBe("#1f3d2b");
    // Rust is this palette's accent, but a red button reads as a warning: the next colour is used.
    expect(vars["--tuft-ochre"]).toBe("#9cc4d9");
    expect(brandThemeVars(kit(palettes[3][1]))["--tuft-ochre"]).toBe("#0051ff");
    expect(brandThemeVars(null)).toEqual({});
  });
});
