import { describe, expect, it } from "vitest";
import { fitSlide } from "../design/slide-check";
import { normalizeDesign } from "../design/slide-design";
import { recolor } from "../design/slide-layouts";
import { serifHeadlines } from "../design/slide-render";
import { brandKitSchema, toDesignKit, type Feel } from "./kit";
import {
  bannerDesign,
  bannerLayouts,
  kitSlide,
  kitSwatches,
  nextSlideFor,
  ownDesign,
  relayoutIn,
  starterDesignFor,
  withPhotoIn,
  withoutPicIn,
} from "./slides";

const config = (feel: Feel = "playful") =>
  brandKitSchema.parse({
    version: 1,
    name: "Wild Thread Studio",
    site: "wildthread.example",
    feel,
    colors: [
      { name: "sky", hex: "#9cc4d9" },
      { name: "forest", hex: "#1f3d2b" },
      { name: "cream", hex: "#f6efe2" },
      { name: "rust", hex: "#b5532c" },
    ],
  });
const kit = toDesignKit(config());
const own = new Set([...Object.values(kit.palette), "#ffffff"]);
const HOME = "https://files.example/storage/v1/object/public/social/tenant-a/";
const photo = (name: string) => `${HOME}${name}.jpg`;

/** Every colour a slide is drawn in. */
const coloursOf = (slide: ReturnType<typeof kitSlide>) =>
  [
    slide.bg,
    slide.grid,
    slide.wave,
    slide.panel?.color,
    ...slide.layers.flatMap((l) => [l.color, l.plateColor, l.scribble]),
  ].filter((hex): hex is string => Boolean(hex));

describe("designs in a workspace's own kit", () => {
  it("draws every layout the kit offers in the kit's colours and no one else's", () => {
    for (const feel of ["playful", "minimal", "classic", "bold", "earthy"] as const) {
      const k = toDesignKit(config(feel));
      for (const layout of k.layouts) {
        for (const color of k.rotation) {
          const slide = kitSlide(
            k,
            layout,
            {
              kicker: "New",
              headline: "Autumn rugs",
              body: "Six pieces.",
              badge: "20% off",
              footer: "wildthread.example",
              accent: "by hand",
              photos: [photo("a"), photo("b")],
              color,
            },
            "4:5",
          );
          expect(slide.bg, `${feel} ${layout}`).toBe(k.palette[color]);
          // A workspace's kit never leaves a built-in brand's name on the slide.
          expect(slide.brand, `${feel} ${layout}`).toBeUndefined();
          for (const hex of coloursOf(slide)) {
            expect(own.has(hex), `${feel} ${layout} ${color} ${hex}`).toBe(true);
          }
        }
      }
    }
  });

  it("starts from the kit, around a photo when one is given", () => {
    const plain = starterDesignFor(kit);
    expect(plain.format).toBe("4:5");
    expect(plain.slides).toHaveLength(1);
    expect(plain.slides[0].bg).toBe("#9cc4d9");
    const around = starterDesignFor(kit, { photo: photo("rug") }).slides[0];
    expect([around.image, ...around.pics.map((p) => p.url)]).toContain(photo("rug"));
    // The next slide takes the next colour, so two neighbours never match.
    expect(nextSlideFor(kit, plain.slides[0], "4:5").bg).toBe("#1f3d2b");
    expect(kitSwatches(kit).map((c) => c.name)).toEqual([
      "sky",
      "forest",
      "cream",
      "rust",
      "white",
    ]);
  });

  it("keeps words, photos and the kit's colours when a slide is changed", () => {
    const slide = kitSlide(kit, "statement", { headline: "Hello", color: "rust" }, "4:5", "s1");
    const split = withPhotoIn(kit, slide, photo("a"), "4:5");
    expect(split.id).toBe("s1");
    expect(split.bg).toBe("#b5532c");
    expect(split.pics.map((p) => p.url)).toEqual([photo("a")]);
    const grid = withPhotoIn(kit, split, photo("b"), "4:5");
    expect(grid.layout).toBe("grid");
    expect(grid.pics).toHaveLength(2);
    const back = withoutPicIn(kit, grid, grid.pics[0].id, "4:5");
    expect(back.pics.map((p) => p.url)).toEqual([photo("b")]);
    const note = relayoutIn(kit, back, "note", "4:5");
    expect(note.layers.find((l) => l.role === "headline")?.text).toBe("Hello");
    const blue = recolor(slide, "#9cc4d9", kit);
    for (const hex of coloursOf(blue)) expect(own.has(hex), hex).toBe(true);

    // A quiet kit has no photo grid: a second photo takes the first one's place instead of vanishing.
    const quiet = toDesignKit(config("minimal"));
    const one = withPhotoIn(
      quiet,
      kitSlide(quiet, "statement", { headline: "Hi" }, "4:5"),
      photo("a"),
      "4:5",
    );
    const two = withPhotoIn(quiet, one, photo("b"), "4:5");
    expect([two.image, ...two.pics.map((p) => p.url)].filter(Boolean)).toEqual([photo("b")]);
  });

  it("offers the sale banner only to a kit that draws one, and checks what it is asked for", () => {
    expect(bannerLayouts(kit)).toEqual(["statement", "sale"]);
    expect(bannerLayouts(toDesignKit(config("classic")))).toEqual(["statement"]);
    const banner = bannerDesign(
      kit,
      { headline: "Sale", badge: "20% off" },
      { layout: "sale", color: "rust" },
    );
    expect(banner.format).toBe("3:2");
    expect(banner.slides[0].layout).toBe("sale");
    expect(banner.slides[0].bg).toBe("#b5532c");
    const safe = bannerDesign(
      kit,
      { headline: "Sale", badge: "20% off" },
      { layout: "grid", color: "__proto__" },
    );
    expect(safe.slides[0].layout).toBe("statement");
    expect(safe.slides[0].bg).toBe("#9cc4d9");
    expect(safe.slides[0].layers.some((l) => l.role === "badge" && l.text)).toBe(false);
  });

  it("a fitted slide survives being saved and read back", () => {
    const slide = kitSlide(kit, "statement", { headline: "Hello there", color: "forest" }, "1:1");
    const fitted = fitSlide(slide, (l) => ({ x: l.x, y: l.y, w: l.w, h: 6, tx: l.x, tw: l.w }));
    const again = normalizeDesign(
      JSON.parse(JSON.stringify({ v: 1, format: "1:1", slides: [fitted] })),
    );
    expect(again?.slides[0]).toEqual(fitted);
  });

  it("chooses the display face by how the kit sets its headlines", () => {
    expect(serifHeadlines(toDesignKit(config("playful")))).toBe(true);
    expect(serifHeadlines(toDesignKit(config("classic")))).toBe(true);
    expect(serifHeadlines(toDesignKit(config("earthy")))).toBe(true);
    // All capitals, or a quieter size, are set in the sans in its real weights.
    expect(serifHeadlines(toDesignKit(config("bold")))).toBe(false);
    expect(serifHeadlines(toDesignKit(config("minimal")))).toBe(false);
  });
});

describe("a design that is safe to keep", () => {
  const raw = {
    v: 1,
    format: "1:1",
    slides: [
      {
        id: "s1",
        bg: "#1f3d2b",
        brand: "pyc",
        image: "https://evil.example/track.png",
        imageDim: 0.5,
        layers: [{ id: "l1", text: "<img src=x onerror=alert(1)>", role: "headline" }],
        pics: [
          { id: "p1", url: photo("mine") },
          {
            id: "p2",
            url: "https://files.example/storage/v1/object/public/social/tenant-b/theirs.jpg",
          },
          { id: "p3", url: `${HOME}../tenant-b/theirs.jpg` },
          { id: "p4", url: "data:image/png;base64,AAAA" },
        ],
      },
      { id: "s2", bg: "#f6efe2", image: photo("behind"), layers: [] },
    ],
  };

  it("keeps only the workspace's own photos, and words as plain text", () => {
    const design = ownDesign(raw, HOME)!;
    expect(design.format).toBe("1:1");
    expect(design.slides[0].image).toBeNull();
    expect(design.slides[0].imageDim).toBe(0);
    expect(design.slides[0].pics.map((p) => p.url)).toEqual([photo("mine")]);
    expect(design.slides[0].brand).toBeUndefined();
    // Words are kept exactly as typed; they are only ever drawn as text.
    expect(design.slides[0].layers[0].text).toBe("<img src=x onerror=alert(1)>");
    expect(design.slides[1].image).toBe(photo("behind"));
    expect(JSON.stringify(design)).not.toMatch(/evil\.example|tenant-b|data:/);
  });

  it("is bounded, and refuses what isn't a design", () => {
    expect(ownDesign(raw, HOME, 1)!.slides).toHaveLength(1);
    const many = {
      ...raw,
      slides: Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, bg: "#1f3d2b" })),
    };
    expect(ownDesign(many, HOME)!.slides).toHaveLength(10);
    for (const bad of [null, "x", [], {}, { slides: [] }, { slides: "no" }]) {
      expect(ownDesign(bad, HOME)).toBeNull();
    }
    expect(ownDesign(raw, "")).toBeNull();
  });
});
