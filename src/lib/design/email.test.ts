import { describe, expect, it } from "vitest";
import { bannerWords, mainButton, normalizeEmail, postBrief } from "./email";
import { buildSlide } from "./slide-layouts";
import { FORMATS, normalizeDesign } from "./slide-design";

const raw = {
  subject: "Yarn sale this weekend",
  preview: "20% off every colour, in store and online.",
  banner: {
    layout: "sale",
    color: "canary",
    kicker: "This weekend",
    headline: "The big yarn sale",
    body: "Every colour we stock.",
    badge: "20% off",
  },
  bannerImage: "https://cdn.example.com/banner.png",
  sections: [
    { heading: "", body: "All yarn is 20% off.\n\nSaturday & Sunday <only>." },
    { heading: "", body: "" },
  ],
  products: [
    {
      title: "Reflect Wool",
      price: "$18",
      url: "https://tufttheworld.com/products/wool",
      image: "https://cdn.example.com/wool.jpg",
    },
    { title: "No photo", price: "$1", url: "https://tufttheworld.com/products/x", image: "" },
    {
      title: "Bad link",
      price: "$1",
      url: "javascript:alert(1)",
      image: "https://cdn.example.com/a.jpg",
    },
  ],
  button: { label: "Shop the sale", url: "https://tufttheworld.com/collections/yarn" },
  signoff: "Happy tufting,\nTim",
};

describe("normalizeEmail", () => {
  const spec = normalizeEmail(raw);
  it("keeps what is usable and drops empty sections and products that cannot be shown or linked", () => {
    // The writer's sections, products, button and sign-off become blocks, in that order.
    expect(spec.blocks.map((b) => b.type)).toEqual(["text", "products", "button", "note"]);
    const products = spec.blocks.find((b) => b.type === "products");
    expect(products?.type === "products" && products.items.map((p) => p.title)).toEqual([
      "Reflect Wool",
    ]);
    expect(spec.banner).toMatchObject({ layout: "sale", color: "canary" });
  });
  it("falls back to safe values for anything unexpected", () => {
    const odd = normalizeEmail({
      banner: { layout: "weird", color: "mauve" },
      bannerImage: "http://insecure/x.png",
      button: { label: "Go", url: "ftp://x" },
    });
    expect(odd.banner).toMatchObject({ layout: "statement", color: "royal" });
    expect(odd.bannerImage).toBeNull();
    expect(odd.blocks).toEqual([{ id: "button", type: "button", label: "Go", url: "" }]);
    expect(mainButton(odd)).toBeNull();
    expect(normalizeEmail(null).blocks).toEqual([]);
  });
});

describe("the email banner", () => {
  it("fits the banner shape and survives saving", () => {
    for (const layout of ["sale", "statement"] as const) {
      const s = buildSlide(
        layout,
        {
          kicker: "This weekend",
          headline: "The big yarn sale",
          body: "Every colour we stock.",
          badge: "20% off",
          color: "canary",
        },
        "3:2",
        "banner",
      );
      for (const l of s.layers) {
        expect(l.x + l.w).toBeLessThanOrEqual(100.01);
        expect(l.y, `${layout} ${l.role}`).toBeLessThanOrEqual(96);
      }
      expect(normalizeDesign({ format: "3:2", slides: [s] })!.format).toBe("3:2");
    }
    expect(FORMATS["3:2"]).toMatchObject({ w: 1080, h: 720 });
  });
});

describe("postBrief", () => {
  const post = {
    title: "Yarn sale",
    copy: "All yarn is 20% off this weekend.\n\n#tufttheworld",
    notes:
      'Drafted from your prompt: "sale"\nCheck before posting. Not given in the prompt: the code.',
    scheduled_at: "2026-11-27T15:00:00Z",
    text_overlay_suggestions: {
      kind: "slide_studio",
      design: {
        slides: [
          {
            bg: "#ffe813",
            layout: "sale",
            layers: [
              { role: "kicker", text: "This weekend" },
              { role: "headline", text: "The big yarn sale" },
              { role: "badge", text: "20% off" },
            ],
          },
          {
            bg: "#213838",
            layout: "closing",
            layers: [
              { role: "headline", text: "Shop the sale" },
              { role: "footer", text: "tufttheworld.com" },
            ],
          },
        ],
      },
    },
  };
  it("gathers what the post says: caption, every slide's words, its date and what was left out", () => {
    const { text } = postBrief(post);
    expect(text).toContain("Title: Yarn sale");
    expect(text).toContain("The post goes out on Friday, November 27, 2026.");
    expect(text).toContain("All yarn is 20% off this weekend.");
    expect(text).toContain("Slide 1: This weekend / The big yarn sale / 20% off");
    expect(text).toContain("Slide 2: Shop the sale / tufttheworld.com");
    expect(text).toContain("Not given in the prompt: the code.");
  });
  it("takes the banner's look from the first slide", () => {
    expect(postBrief(post).banner).toEqual({
      color: "canary",
      layout: "sale",
      kicker: "This weekend",
      headline: "The big yarn sale",
      badge: "20% off",
    });
  });
  it("works for a photo post with only a caption", () => {
    const plain = postBrief({
      title: "Rug",
      copy: "A new rug.",
      notes: null,
      scheduled_at: null,
      text_overlay_suggestions: null,
    });
    expect(plain).toEqual({ text: "Title: Rug\n\nCaption:\nA new rug.", banner: {} });
  });
});

describe("a banner edited by hand", () => {
  const slide = buildSlide(
    "sale",
    {
      kicker: "This weekend",
      headline: "Yarn sale, two days only",
      body: "Every colour.",
      badge: "20% off",
      color: "pepper",
    },
    "3:2",
    "banner",
  );
  it("is kept as one slide in the banner shape, whatever shape it arrives in", () => {
    const spec = normalizeEmail({
      ...raw,
      bannerDesign: { format: "4:5", slides: [slide, slide] },
    });
    expect(spec.bannerDesign).toMatchObject({ format: "3:2" });
    expect(spec.bannerDesign!.slides).toHaveLength(1);
    expect(normalizeEmail(raw).bannerDesign).toBeNull();
    expect(normalizeEmail({ ...raw, bannerDesign: { slides: [] } }).bannerDesign).toBeNull();
  });
  it("gives its words back, so the picture's description matches what it shows", () => {
    const design = normalizeEmail({ ...raw, bannerDesign: { slides: [slide] } }).bannerDesign!;
    expect(bannerWords(design)).toEqual({
      kicker: "This weekend",
      headline: "Yarn sale, two days only",
      body: "Every colour.",
      badge: "20% off",
    });
  });
  it("reads a banner whose texts have lost their roles", () => {
    const design = normalizeDesign({
      format: "3:2",
      slides: [{ layers: [{ text: "Big line" }, { text: "Small line" }] }],
    })!;
    expect(bannerWords(design)).toMatchObject({ headline: "Big line", body: "Small line" });
  });
});

describe("emails for each brand and platform", () => {
  it("defaults to Tuft the World on Shopify, and keeps a brand's own colours", () => {
    expect(normalizeEmail(raw)).toMatchObject({ brand: "ttw", platform: "shopify" });
    const pyc = normalizeEmail({
      brand: "pyc",
      platform: "other",
      banner: { layout: "sale", color: "canary", headline: "Hi" },
    });
    // Canary is not a Price Your Craft colour and it has no sale layout.
    expect(pyc.banner).toMatchObject({ color: "mat", layout: "statement" });
    expect(normalizeEmail({ brand: "nope" }).brand).toBe("ttw");
  });
});

describe("email blocks", () => {
  const base = {
    subject: "S",
    preview: "P",
    bannerImage: "https://cdn.example.com/b.png",
    banner: { headline: "Hi" },
  };
  const blocks = [
    {
      id: "a",
      type: "image",
      url: "https://cdn.example.com/rug.jpg",
      alt: "A blue rug",
      link: "https://tufttheworld.com/rugs",
    },
    {
      id: "b",
      type: "text",
      heading: "Read on",
      body: "See [our guide](https://tufttheworld.com/guide) and **save the date**.\n\nWrite to [us](mailto:hello@example.com).",
    },
    { id: "c", type: "divider" },
    { id: "d", type: "button", label: "Book a class", url: "https://tufttheworld.com/classes" },
    { id: "e", type: "button", label: "Second", url: "https://tufttheworld.com/second" },
    { id: "f", type: "mystery" },
  ];
  const spec = normalizeEmail({ ...base, blocks });
  it("keeps the owner's blocks in their order, and drops kinds it does not know", () => {
    expect(spec.blocks.map((b) => b.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(mainButton(spec)?.url).toBe("https://tufttheworld.com/classes");
  });
  it("keeps unfinished blocks for editing", () => {
    const draft = normalizeEmail({
      ...base,
      blocks: [{ type: "image" }, { type: "button" }, { type: "text" }],
    });
    expect(draft.blocks).toHaveLength(3);
  });
  it("reads an email saved before blocks existed", () => {
    const old = normalizeEmail({
      ...base,
      sections: [{ heading: "", body: "Hello." }],
      button: { label: "Shop", url: "https://tufttheworld.com" },
      signoff: "Tim",
    });
    expect(old.blocks.map((b) => b.type)).toEqual(["text", "button", "note"]);
  });
});
