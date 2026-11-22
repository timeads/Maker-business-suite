import { describe, it, expect } from "vitest";
import {
  designKey,
  drawSlide,
  flowLayers,
  layoutLayer,
  normalizeDesign,
  readStudio,
  readableInk,
  summarizeEdits,
  wrapLines,
  STUDIO_KIND,
  type SlideDesign,
} from "./slide-design";

// One unit of width per character keeps the wrapping maths readable.
const perChar = (t: string) => t.length;

function design(): SlideDesign {
  return normalizeDesign({
    slides: [
      {
        id: "s1",
        bg: "#213838",
        layers: [
          { id: "a", text: "Price a rug in three minutes", role: "headline" },
          { id: "b", text: "Four steps", role: "body" },
        ],
      },
      {
        id: "s2",
        bg: "#f7ecd8",
        layers: [{ id: "c", text: "Start your free trial", role: "footer" }],
      },
    ],
  })!;
}

describe("wrapLines", () => {
  it("wraps on word boundaries", () => {
    expect(wrapLines("one two three four", 9, perChar)).toEqual(["one two", "three", "four"]);
  });
  it("keeps explicit line breaks, including blank lines", () => {
    expect(wrapLines("a\n\nb", 10, perChar)).toEqual(["a", "", "b"]);
  });
  it("breaks a word that is longer than the line", () => {
    expect(wrapLines("abcdefghij", 4, perChar)).toEqual(["abcd", "efgh", "ij"]);
  });
});

describe("normalizeDesign", () => {
  it("fills a layer from its role and picks ink that reads on the background", () => {
    const d = design();
    expect(d.format).toBe("4:5");
    expect(d.slides[0].layers[0]).toMatchObject({ size: 92, weight: 800, color: "#ffffff" });
    expect(d.slides[1].layers[0].color).toBe("#213838");
  });
  it("clamps out-of-range values and keeps text inside the slide", () => {
    const d = normalizeDesign({ slides: [{ layers: [{ text: "x", x: 95, w: 60, size: 9999 }] }] })!;
    const l = d.slides[0].layers[0];
    expect(l.x + l.w).toBeLessThanOrEqual(100);
    expect(l.size).toBe(320);
  });
  it("returns null when there are no slides", () => {
    expect(normalizeDesign({ slides: [] })).toBeNull();
    expect(normalizeDesign("nope")).toBeNull();
  });
  it("drops a photo that is not an http url", () => {
    const d = normalizeDesign({ slides: [{ image: "javascript:alert(1)", layers: [] }] })!;
    expect(d.slides[0].image).toBeNull();
  });
});

describe("readStudio", () => {
  it("ignores overlay data that belongs to workshop ads", () => {
    expect(readStudio({ text: "Join us" })).toBeNull();
    expect(readStudio(["a"])).toBeNull();
    expect(readStudio(null)).toBeNull();
  });
  it("reads a studio record and leaves unset original fields undefined", () => {
    const s = readStudio({
      kind: STUDIO_KIND,
      v: 1,
      design: design(),
      original: { copy: "hello" },
    })!;
    expect(s.design?.slides).toHaveLength(2);
    expect(s.original?.copy).toBe("hello");
    expect(s.original?.title).toBeUndefined();
    expect(s.original?.design).toBeUndefined();
  });
});

describe("designKey", () => {
  it("changes when visible content changes and not otherwise", () => {
    const a = design();
    const b = design();
    expect(designKey(a)).toBe(designKey(b));
    b.slides[0].layers[0].text = "Different";
    expect(designKey(a)).not.toBe(designKey(b));
  });
});

describe("flowLayers", () => {
  it("stacks text without overlap and leaves pinned layers alone", () => {
    const d = normalizeDesign({
      slides: [
        {
          id: "s",
          layers: [
            { id: "k", text: "Price your craft", role: "kicker" },
            { id: "h", text: "What is an hour of your work really worth to you", role: "headline" },
            {
              id: "b",
              text: "Add your materials, your hours and your costs, then choose the profit you want.",
              role: "body",
            },
            { id: "f", text: "priceyourcraft.com", role: "footer", y: 91 },
          ],
        },
      ],
    })!;
    const flowed = flowLayers(d.slides[0], d.format, new Set(["f"]));
    const [k, h, b, f] = flowed.layers;
    expect(k.y).toBeLessThan(h.y);
    expect(h.y).toBeLessThan(b.y);
    expect(f.y).toBe(91);
    // A five-line 92px headline is about 36% of a 1350px slide, so the body must start below it.
    expect(b.y - h.y).toBeGreaterThan(20);
  });
});

describe("layoutLayer and drawSlide", () => {
  it("scales with the slide width", () => {
    const l = design().slides[0].layers[0];
    const small = layoutLayer(l, 540, 675, perChar);
    expect(small.fontPx).toBe(46);
    expect(small.x).toBeCloseTo(43.2);
  });
  it("paints background, photo dimming and each line of text", () => {
    const calls: string[] = [];
    const ctx = {
      fillStyle: "",
      font: "",
      textBaseline: "",
      textAlign: "",
      fillRect: () => calls.push("rect"),
      fillText: (t: string) => calls.push(`text:${t}`),
      measureText: (t: string) => ({ width: t.length * 10 }),
      drawImage: () => calls.push("image"),
    };
    const d = normalizeDesign({
      slides: [{ image: "https://example.com/a.jpg", imageDim: 0.4, layers: [{ text: "Hello" }] }],
    })!;
    drawSlide(ctx, d.slides[0], 1080, 1350, { width: 2000, height: 1000 });
    expect(calls).toEqual(["rect", "image", "rect", "text:Hello"]);
  });
});

describe("readableInk", () => {
  it("is white over photos and dark colours, ink over light ones", () => {
    expect(readableInk("#f8f6f3", true)).toBe("#ffffff");
    expect(readableInk("#213838", false)).toBe("#ffffff");
    expect(readableInk("#f8f6f3", false)).toBe("#213838");
  });
});

describe("summarizeEdits", () => {
  it("reports nothing when the post matches what was proposed", () => {
    const d = design();
    const s = summarizeEdits(
      { copy: "a", platform_captions: {}, design: d },
      { copy: "a", platform_captions: {}, design: design() },
    );
    expect(s.changed).toBe(false);
  });
  it("reports caption, per-platform and slide edits", () => {
    const before = design();
    const after = design();
    after.slides[0].layers[0].text = "Price a rug in 3 minutes";
    after.slides[0].layers[0].size = 80;
    after.slides[0].layers[1].y += 6;
    after.slides[0].bg = "#c78c2b";
    after.slides.pop();
    const s = summarizeEdits(
      { copy: "Long caption", platform_captions: { LinkedIn: "formal" }, design: before },
      { copy: "Short", platform_captions: { LinkedIn: "casual" }, design: after },
    );
    expect(s.fields).toEqual(["copy", "platform_captions", "slides"]);
    expect(s.copy).toEqual({ before: "Long caption", after: "Short" });
    expect(s.platform_captions?.LinkedIn.after).toBe("casual");
    const kinds = s.slides!.map((c) => c.change);
    expect(kinds).toContain("slide removed");
    expect(kinds).toContain("background colour");
    expect(kinds).toContain("text");
    expect(kinds.some((k) => k.startsWith("style of"))).toBe(true);
    expect(kinds.some((k) => k.startsWith("position of"))).toBe(true);
  });
  it("does not compare fields Claude never set", () => {
    const s = summarizeEdits({ design: design() }, { copy: "user wrote this", design: design() });
    expect(s.changed).toBe(false);
  });
  it("notices slides the user built on a caption-only draft", () => {
    const s = summarizeEdits({ copy: "a", design: null }, { copy: "a", design: design() });
    expect(s.slides?.[0].change).toBe("design added");
  });
});
