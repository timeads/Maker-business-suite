import { describe, expect, it } from "vitest";
import {
  designKey,
  drawSlide,
  hasDecoration,
  luminance,
  normalizeDesign,
  type Slide,
} from "./slide-design";
import { BRAND_IDS, BRANDS } from "./brands";
import {
  LAYOUT_IDS,
  PALETTE,
  buildSlide,
  contentOf,
  paceColors,
  pickLogo,
  recolor,
  relayout,
  schemeFor,
  withPhoto,
  withoutPic,
} from "./slide-layouts";

const content = {
  kicker: "This weekend",
  headline: "Every yarn in the shop is on sale",
  body: "Wool, acrylic and cotton, in store and online.",
  footer: "tufttheworld.com",
  badge: "20% off",
  accent: "happy tufting!",
  photos: ["https://x/1.jpg", "https://x/2.jpg", "https://x/3.jpg", "https://x/4.jpg"],
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("schemeFor", () => {
  it("pairs every palette colour with ink and an accent that read on it", () => {
    for (const name of Object.keys(PALETTE)) {
      const s = schemeFor(name);
      expect(contrast(s.bg, s.ink), `${name} ink`).toBeGreaterThan(3.9);
      expect(s.accent, `${name} accent`).not.toBe(s.bg);
      expect(contrast(s.accent, s.onAccent), `${name} on accent`).toBeGreaterThan(3.9);
    }
  });
  it("accepts a palette hex and gives off-palette colours a readable pairing", () => {
    expect(schemeFor("#0051FF")).toEqual(schemeFor("royal"));
    const odd = schemeFor("#101010");
    expect(contrast(odd.bg, odd.ink)).toBeGreaterThan(7);
  });
});

describe("paceColors", () => {
  it("replaces a colour that repeats the one before it", () => {
    const out = paceColors(["royal", "royal", "royal", "natural"]);
    out.slice(1).forEach((c, i) => expect(c).not.toBe(out[i]));
    expect(out[0]).toBe("royal");
    expect(out[3]).toBe("natural");
  });
  it("leaves a paced list alone", () => {
    expect(paceColors(["charcoal", "canary", "charcoal"])).toEqual([
      "charcoal",
      "canary",
      "charcoal",
    ]);
  });
});

describe("buildSlide", () => {
  it("keeps every layout's text and photos on the slide, in all three shapes", () => {
    for (const format of ["4:5", "1:1", "9:16"] as const) {
      for (const layout of LAYOUT_IDS.filter((l) => l !== "tag")) {
        const s = buildSlide(layout, content, format, "s1");
        expect(s.layout).toBe(layout);
        for (const l of s.layers) {
          expect(l.x, `${layout} ${l.role} x`).toBeGreaterThanOrEqual(0);
          expect(l.x + l.w, `${layout} ${l.role} right`).toBeLessThanOrEqual(100.01);
          expect(l.y, `${layout} ${l.role} y`).toBeLessThanOrEqual(96);
        }
        for (const p of s.pics) {
          expect(p.x + p.w, `${layout} pic right`).toBeLessThanOrEqual(100.01);
          expect(p.y + p.h, `${layout} pic bottom`).toBeLessThanOrEqual(100.01);
        }
        // What it builds survives being saved and read back.
        expect(normalizeDesign({ format, slides: [s] })!.slides[0]).toEqual(s);
      }
    }
  });
  it("shrinks a long headline rather than letting it run on", () => {
    const short = buildSlide("statement", { headline: "Yarn sale" }, "4:5", "s1").layers[0];
    const long = buildSlide(
      "statement",
      { headline: "Everything you need to know before you buy your first tufting gun this year" },
      "4:5",
      "s1",
    ).layers[0];
    expect(long.size).toBeLessThan(short.size);
  });
  it("places as many photos as the layout holds", () => {
    expect(buildSlide("grid", content, "4:5").pics).toHaveLength(4);
    expect(
      buildSlide("grid", { ...content, photos: content.photos.slice(0, 3) }, "4:5").pics,
    ).toHaveLength(3);
    expect(buildSlide("product", content, "4:5").pics).toHaveLength(1);
    expect(buildSlide("photo", content, "4:5").image).toBe("https://x/1.jpg");
    expect(buildSlide("statement", content, "4:5").pics).toHaveLength(0);
  });
  it("falls back when photos are missing", () => {
    expect(buildSlide("grid", { ...content, photos: ["https://x/1.jpg"] }, "4:5").layout).toBe(
      "product",
    );
    expect(buildSlide("split", { ...content, photos: [] }, "4:5").layout).toBe("statement");
  });
  it("leaves out text that was not given", () => {
    const s = buildSlide("sale", { headline: "Sale" }, "4:5");
    expect(s.layers.map((l) => l.role)).toEqual(["headline"]);
  });
  it("puts the logo on the closing slide whole, not cropped", () => {
    const s = buildSlide("closing", { ...content, logo: "https://x/logo.png" }, "4:5");
    expect(s.pics).toMatchObject([{ url: "https://x/logo.png", contain: true }]);
  });
});

describe("relayout, recolor and photo changes", () => {
  it("keeps the words, photos and ids when the layout changes", () => {
    const a = buildSlide("split", content, "4:5", "s1");
    const b = relayout(a, "sale", "4:5");
    expect(b.id).toBe("s1");
    expect(contentOf(b).headline).toBe(content.headline);
    expect(b.layers.find((l) => l.role === "headline")!.id).toBe(
      a.layers.find((l) => l.role === "headline")!.id,
    );
    expect(b.pics[0].url).toBe("https://x/1.jpg");
  });
  it("reads texts without a role by their order", () => {
    const d = normalizeDesign({
      slides: [{ layers: [{ text: "Big line" }, { text: "Small line" }] }],
    })!;
    expect(contentOf(d.slides[0])).toMatchObject({ headline: "Big line", body: "Small line" });
  });
  it("moves text and shapes to the colours that go with a new background", () => {
    const a = buildSlide("sale", { ...content, photos: [] }, "4:5", "s1");
    const b = recolor(a, "#ffe813");
    const s = schemeFor("canary");
    expect(b.bg).toBe(s.bg);
    expect(b.layers.find((l) => l.role === "headline")!.color).toBe(s.ink);
    const badge = b.layers.find((l) => l.role === "badge")!;
    expect(badge.plateColor).toBe(s.accent);
    expect(contrast(badge.plateColor!, badge.color)).toBeGreaterThan(3.9);
    expect(b.wave).toBe(s.accent);
    // Positions are untouched.
    expect(b.layers.map((l) => [l.x, l.y])).toEqual(a.layers.map((l) => [l.x, l.y]));
  });
  it("adds and removes photos by laying the slide out again", () => {
    const text = buildSlide("statement", { ...content, photos: [] }, "4:5", "s1");
    const one = withPhoto(text, "https://x/1.jpg", "4:5");
    expect(one.layout).toBe("split");
    const two = withPhoto(one, "https://x/2.jpg", "4:5");
    expect(two.layout).toBe("grid");
    expect(two.pics).toHaveLength(2);
    const back = withoutPic(two, two.pics[0].id, "4:5");
    expect(back.pics.map((p) => p.url)).toEqual(["https://x/2.jpg"]);
  });
});

describe("brand kits", () => {
  it("pair every colour of every brand with text and an accent that read on it", () => {
    for (const brand of BRAND_IDS) {
      const kit = BRANDS[brand];
      for (const name of Object.keys(kit.palette)) {
        const s = schemeFor(name, brand);
        expect(s.bg, `${brand} ${name}`).toBe(kit.palette[name]);
        expect(contrast(s.bg, s.ink), `${brand} ${name} ink`).toBeGreaterThan(3.9);
        expect(contrast(s.accent, s.onAccent), `${brand} ${name} on accent`).toBeGreaterThan(3.9);
        expect(s.accent, `${brand} ${name} accent`).not.toBe(s.bg);
      }
      for (const n of [...kit.rotation, ...kit.neutrals, kit.dark, kit.light, kit.overPhoto])
        expect(kit.palette[n], `${brand} ${n}`).toBeTruthy();
    }
  });
  it("build every layout a brand offers, inside the slide, in that brand's colours", () => {
    for (const brand of BRAND_IDS) {
      for (const layout of BRANDS[brand].layouts) {
        const s = buildSlide(
          layout,
          {
            ...content,
            body: layout === "tag" ? "Yarn: $64\nYour time: $420\nProfit: $180" : content.body,
            brand,
          },
          "4:5",
          "s1",
        );
        expect(s.layout, `${brand} ${layout}`).toBe(layout);
        expect(s.brand).toBe(brand === "ttw" ? undefined : brand);
        const colors = new Set([...Object.values(BRANDS[brand].palette), "#ffffff"]);
        for (const l of s.layers) {
          expect(colors.has(l.color), `${brand} ${layout} ${l.role} colour ${l.color}`).toBe(true);
          expect(l.x + l.w).toBeLessThanOrEqual(100.01);
          expect(l.y).toBeLessThanOrEqual(96);
        }
        expect(normalizeDesign({ slides: [s] })!.slides[0]).toEqual(s);
      }
    }
  });
  it("turn a layout a brand does not use into one it does", () => {
    expect(buildSlide("sale", { ...content, brand: "history", photos: [] }, "4:5").layout).toBe(
      "statement",
    );
    expect(buildSlide("tag", { ...content, brand: "ttw" }, "4:5").layout).toBe("statement");
  });
  it("leave handwriting, the wave and the burst to Tuft the World", () => {
    const s = buildSlide("closing", { ...content, brand: "pyc" }, "4:5");
    expect(s.wave).toBeNull();
    expect(s.layers.some((l) => l.font === "hand")).toBe(false);
    expect(buildSlide("statement", { ...content, brand: "history" }, "4:5").grid).toBeNull();
  });
  it("rule a price tag's lines and read them back", () => {
    const s = buildSlide(
      "tag",
      {
        headline: "Granny square blanket",
        body: "Yarn: $64.00\nYour time: $420.00",
        badge: "$710",
        brand: "pyc",
      },
      "4:5",
      "s1",
    );
    const rows = s.layers.find((l) => l.role === "body")!.text.split("\n");
    expect(rows[0]).toMatch(/^Yarn \.{3,} \$64\.00$/);
    expect(rows[0].length).toBe(rows[1].length);
    expect(s.panel).toBeTruthy();
    expect(contentOf(s).body).toBe("Yarn: $64.00\nYour time: $420.00");
  });
  it("swap colours that are not the brand's when pacing", () => {
    const out = paceColors(["charcoal", "mat", "mat"], "pyc");
    out.forEach((c, i) => {
      expect(BRANDS.pyc.palette[c]).toBeTruthy();
      if (i) expect(c).not.toBe(out[i - 1]);
    });
  });
});

describe("pickLogo", () => {
  const logos = { badge: "b", dark: "d", light: "l" };
  it("prefers the badge on neutral colours and the transparent mark on brand colours", () => {
    expect(pickLogo("natural", logos)).toBe("b");
    expect(pickLogo("charcoal", logos)).toBe("b");
    expect(pickLogo("canary", logos)).toBe("d");
    expect(pickLogo("pepper", logos)).toBe("d");
    expect(pickLogo("royal", logos)).toBe("l");
  });
  it("falls back to the mark without a badge, and to nothing rather than a logo that would not read", () => {
    expect(pickLogo("natural", { dark: "d" })).toBe("d");
    expect(pickLogo("royal", { dark: "d", badge: "b" })).toBeNull();
  });
});

describe("drawing decoration", () => {
  const recorder = () => {
    const calls: string[] = [];
    const log = (name: string) => () => {
      calls.push(name);
    };
    const ctx = {
      fillStyle: "",
      strokeStyle: "",
      font: "",
      textBaseline: "",
      textAlign: "",
      lineWidth: 1,
      lineCap: "",
      lineJoin: "",
      globalAlpha: 1,
      fillRect: log("rect"),
      fillText: (t: string) => {
        calls.push(`text:${t}`);
      },
      measureText: (t: string) => ({ width: t.length * 10 }),
      drawImage: log("image"),
      save: log("save"),
      restore: log("restore"),
      beginPath: log("begin"),
      closePath: log("close"),
      moveTo: log("move"),
      lineTo: log("line"),
      quadraticCurveTo: log("curve"),
      arc: log("arc"),
      clip: log("clip"),
      fill: log("fill"),
      stroke: log("stroke"),
    };
    return { ctx, calls };
  };
  it("draws framed photos clipped to their frames and a placeholder for one not loaded", () => {
    const s = buildSlide("grid", { ...content, photos: content.photos.slice(0, 2) }, "4:5");
    const { ctx, calls } = recorder();
    drawSlide(ctx, s, 1080, 1350, null, undefined, {
      "https://x/1.jpg": { width: 800, height: 600 },
    });
    expect(calls.filter((c) => c === "clip")).toHaveLength(2);
    expect(calls.filter((c) => c === "image")).toHaveLength(1);
  });
  it("draws the burst behind the badge before its text", () => {
    const s = buildSlide("sale", { headline: "Sale", badge: "20% off" }, "4:5");
    const { ctx, calls } = recorder();
    drawSlide(ctx, s, 1080, 1350, null);
    expect(calls.indexOf("fill")).toBeGreaterThan(-1);
    expect(calls.indexOf("fill")).toBeLessThan(calls.indexOf("text:20% OFF"));
  });
  it("knows which slides are decorated, and keeps plain designs' fingerprints as they were", () => {
    const plain = normalizeDesign({
      slides: [{ bg: "#213838", layers: [{ id: "a", text: "Hello", role: "headline" }] }],
    })!;
    expect(hasDecoration(plain.slides[0])).toBe(false);
    const decorated: Slide = { ...plain.slides[0], grid: "#f5edeb" };
    expect(hasDecoration(decorated)).toBe(true);
    expect(designKey({ ...plain, slides: [decorated] })).not.toBe(designKey(plain));
  });
});
