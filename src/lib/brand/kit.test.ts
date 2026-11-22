import { describe, expect, it } from "vitest";
import { buildSlide } from "../design/slide-layouts";
import { kitFor, schemeFor } from "../design/brands";
import { brandBrief, brandKitSchema, contrast, tidyColorName, tidyHex, toDesignKit } from "./kit";

const config = brandKitSchema.parse({
  version: 1,
  name: "Wild Thread Studio",
  site: "wildthread.example",
  tagline: "Rugs with a pulse",
  about: "Hand-tufted rugs and weekend workshops.",
  voice: "Short sentences. Dry humour. Never salesy.",
  words_to_use: ["studio", "by hand"],
  words_to_avoid: ["luxury"],
  feel: "earthy",
  colors: [
    { name: "Forest", hex: "#1F3D2B" },
    { name: "cream", hex: "#F6EFE2" },
    { name: "rust", hex: "#B5532C" },
    { name: "sky", hex: "#9CC4D9" },
  ],
});

describe("a workspace's brand kit", () => {
  it("tidies colours and refuses kits that can't work", () => {
    expect(config.colors[0]).toEqual({ name: "forest", hex: "#1f3d2b" });
    const bad = (colors: object[]) =>
      brandKitSchema.safeParse({ version: 1, name: "X", colors }).success;
    expect(bad([{ name: "one", hex: "#000000" }])).toBe(false);
    expect(
      bad([
        { name: "same", hex: "#000000" },
        { name: "same", hex: "#ffffff" },
      ]),
    ).toBe(false);
    expect(
      bad([
        { name: "a", hex: "red" },
        { name: "b", hex: "#ffffff" },
      ]),
    ).toBe(false);
    expect(brandKitSchema.safeParse({ ...config, logo_on_light: "../../etc/passwd" }).success).toBe(
      false,
    );
  });

  it("works out readable text and an accent for every colour", () => {
    const kit = toDesignKit(config);
    expect(kit.dark).toBe("forest");
    expect(kit.light).toBe("cream");
    for (const [bg, pair] of Object.entries(kit.pairings)) {
      expect(contrast(kit.palette[bg], kit.palette[pair.ink]), bg).toBeGreaterThanOrEqual(4);
      expect(pair.accent).not.toBe(bg);
    }
    expect(kit.pairings.forest).toEqual({ ink: "cream", accent: "rust" });
    expect(kit.neutrals).toContain("cream");
  });

  it("is a kit the design engine can draw with", () => {
    const kit = toDesignKit(config);
    expect(kitFor(kit)).toBe(kit);
    expect(kit.own).toBe(true);
    expect(kitFor("nonsense").id).toBe("ttw");
    const scheme = schemeFor(kit.palette.forest, kit);
    expect(scheme.ink).toBe(kit.palette.cream);
    const slide = buildSlide(
      "statement",
      { headline: "New rugs", brand: kit as never, color: kit.palette.forest },
      "4:5",
    );
    expect(slide.bg).toBe(kit.palette.forest);
    expect(slide.layers.length).toBeGreaterThan(0);
  });

  it("describes the brand in words for drafting", () => {
    const brief = brandBrief(config);
    expect(brief).toContain("Wild Thread Studio (Rugs with a pulse)");
    expect(brief).toContain("Words it never uses: luxury");
    expect(brandBrief(null)).toBe("");
  });

  it("cleans up what people type for colours", () => {
    expect(tidyHex("#ABC")).toBe("#aabbcc");
    expect(tidyHex("1f3d2b")).toBe("#1f3d2b");
    expect(tidyHex("teal")).toBeNull();
    expect(tidyColorName("Deep Teal!", 0)).toBe("deep-teal");
    expect(tidyColorName("123", 2)).toBe("colour-3");
  });
});
