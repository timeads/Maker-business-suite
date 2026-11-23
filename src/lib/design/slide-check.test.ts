import { describe, expect, it } from "vitest";
import { checkSlide, fitSlide, type Measure } from "./slide-check";
import { buildSlide } from "./slide-layouts";
import { FORMATS, type SlideFormat, type TextLayer } from "./slide-design";

/** A stand-in for real measuring: every character is `wide` of the font size across, wrapped by words. */
const measureWith =
  (format: SlideFormat, wide: number): Measure =>
  (l: TextLayer) => {
    const { h: H } = FORMATS[format];
    const perLine = Math.max(1, Math.floor(((l.w / 100) * 1080) / (l.size * wide)));
    let lines = 0;
    let longest = 0;
    for (const para of l.text.split("\n")) {
      let used = 0;
      lines += 1;
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const need = used ? used + 1 + word.length : word.length;
        if (need <= perLine || used === 0) used = need;
        else {
          longest = Math.max(longest, used);
          lines += 1;
          used = word.length;
        }
      }
      longest = Math.max(longest, used);
    }
    const tw = Math.min(l.w, ((longest * l.size * wide) / 1080) * 100);
    const tx =
      l.align === "center" ? l.x + (l.w - tw) / 2 : l.align === "right" ? l.x + l.w - tw : l.x;
    return {
      x: l.x,
      y: l.y,
      w: l.w,
      h: ((lines * l.size * l.lineHeight + (l.scribble ? l.size * 0.3 : 0)) / H) * 100,
      tx,
      tw,
    };
  };

// The two banners the owner reported: text wider in its real typeface than the layout guessed.
const history = buildSlide(
  "statement",
  {
    brand: "history",
    color: "stone",
    kicker: "Now published",
    headline: "A history of tufting, now online",
    body: "Thirteen chapters, with sources, timeline and bibliography.",
  },
  "3:2",
  "b",
);
const pyc = buildSlide(
  "statement",
  {
    brand: "pyc",
    color: "mat",
    kicker: "Welcome to Price Your Craft",
    headline: "Work out what to charge",
    body: "Free pricing calculators, made by a maker.",
  },
  "3:2",
  "b",
);

describe("checkSlide", () => {
  it("passes a slide whose text has room", () => {
    const s = buildSlide(
      "statement",
      { headline: "Yarn sale", body: "Every colour.", color: "royal" },
      "4:5",
      "s",
    );
    expect(checkSlide(s, measureWith("4:5", 0.5))).toEqual([]);
  });
  it("sees text that runs off the bottom, as in the History banner", () => {
    const issues = checkSlide(history, measureWith("3:2", 0.62));
    expect(issues.some((i) => i.kind === "cut-off" && /Thirteen chapters/.test(i.text))).toBe(true);
  });
  it("sees text sitting on other text, as in the Price Your Craft banner", () => {
    const issues = checkSlide(pyc, measureWith("3:2", 0.62));
    expect(issues.some((i) => i.kind === "overlap")).toBe(true);
  });
  it("sees text across a framed photo, but lets a price tag overlap one", () => {
    const s = buildSlide(
      "product",
      {
        headline: "Tufting Cloth",
        badge: "$28",
        body: "Light and tough.",
        photos: ["https://x/a.jpg"],
        color: "natural",
      },
      "4:5",
      "s",
    );
    expect(checkSlide(s, measureWith("4:5", 0.5))).toEqual([]);
    const moved = {
      ...s,
      layers: s.layers.map((l) => (l.role === "headline" ? { ...l, y: 30 } : l)),
    };
    expect(checkSlide(moved, measureWith("4:5", 0.5)).map((i) => i.kind)).toContain("over-photo");
  });
  it("ignores wide text boxes whose words do not actually meet", () => {
    const s = buildSlide(
      "photo",
      { kicker: "Workshop", headline: "Learn to tuft", badge: "New", photos: ["https://x/a.jpg"] },
      "4:5",
      "s",
    );
    expect(checkSlide(s, measureWith("4:5", 0.5)).filter((i) => i.kind === "overlap")).toEqual([]);
  });
});

describe("fitSlide", () => {
  it("puts both reported banners right: nothing cut off, nothing overlapping", () => {
    for (const slide of [history, pyc]) {
      const measure = measureWith("3:2", 0.62);
      const fixed = fitSlide(slide, measure);
      expect(checkSlide(fixed, measure)).toEqual([]);
      expect(fixed.fit).toBe(1);
      // The words are all still there.
      expect(fixed.layers.map((l) => l.text)).toEqual(slide.layers.map((l) => l.text));
    }
  });
  it("makes text smaller only when moving it is not enough", () => {
    const measure = measureWith("3:2", 0.62);
    const before = history.layers.find((l) => l.role === "headline")!.size;
    const after = fitSlide(history, measure).layers.find((l) => l.role === "headline")!.size;
    expect(after).toBeLessThanOrEqual(before);
    expect(after).toBeGreaterThanOrEqual(40);
    const roomy = buildSlide("statement", { headline: "Yarn sale", color: "royal" }, "4:5", "s");
    expect(fitSlide(roomy, measureWith("4:5", 0.5)).layers).toEqual(roomy.layers);
  });
  it("keeps a footer at the foot and a sticker where it is", () => {
    const s = buildSlide(
      "sale",
      {
        kicker: "This weekend only",
        headline: "Everything in the shop is on sale for two days",
        body: "Wool, acrylic and cotton, in store and online, while it lasts.",
        badge: "20% off",
        footer: "Code YARN20",
        color: "canary",
      },
      "4:5",
      "s",
    );
    const measure = measureWith("4:5", 0.66);
    const fixed = fitSlide(s, measure);
    for (const role of ["badge", "footer"])
      expect(fixed.layers.find((l) => l.role === role)!.y).toBe(
        s.layers.find((l) => l.role === role)!.y,
      );
    expect(checkSlide(fixed, measure)).toEqual([]);
  });
  it("does not move text placed under a photo up into it", () => {
    const s = buildSlide(
      "split",
      {
        kicker: "New in the studio",
        headline: "A monogram rug made for Scott over three long days",
        body: "Six colours, cut pile, and a lot of trimming to get the letters crisp.",
        photos: ["https://x/a.jpg"],
        color: "pepper",
      },
      "4:5",
      "s",
    );
    const measure = measureWith("4:5", 0.66);
    const fixed = fitSlide(s, measure);
    const photoBottom = s.pics[0].y + s.pics[0].h;
    for (const l of fixed.layers.filter((x) => !x.plate))
      expect(l.y).toBeGreaterThanOrEqual(photoBottom);
    expect(checkSlide(fixed, measure).filter((i) => i.kind !== "cut-off")).toEqual([]);
  });
});
