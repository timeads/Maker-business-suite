import { describe, expect, it } from "vitest";
import {
  contrast,
  defaultDoc,
  defaultGlobalStyles,
  docChecks,
  findBlock,
  newBlock,
  newRow,
  newSection,
  normalizeDoc,
  optimize,
  reduceDoc,
  renderDocHtml,
  type Block,
  type DocAction,
  type EmailDoc,
  type Suggestion,
} from "./index";

const block = (
  type: Parameters<typeof newBlock>[0],
  id: string,
  more: Record<string, unknown> = {},
) => ({ ...newBlock(type), id, ...more }) as Block;
/** A finished email: nothing to find in it. */
const good = (blocks: Block[] = []): EmailDoc => ({
  ...defaultDoc("ttw"),
  meta: { subject: "Yarn sale this weekend", previewText: "20% off every colour." },
  sections: [
    {
      ...newSection("Body", [
        newRow("1", [block("heading", "h", { level: 1, html: "The yarn sale" })]),
        newRow("1", [block("paragraph", "p", { html: "All yarn is 20% off this weekend." })]),
        newRow("1", [
          block("button", "b", { label: "Shop the sale", url: "https://tufttheworld.com/yarn" }),
        ]),
        ...blocks.map((b) => newRow("1", [b])),
      ]),
      id: "body",
    },
    { ...newSection("Footer", [newRow("1", [block("footer", "f")])]), id: "foot" },
  ],
});
const rules = (doc: EmailDoc) => optimize(doc).map((s) => s.rule);
const find = (doc: EmailDoc, rule: string): Suggestion =>
  optimize(doc).find((s) => s.rule === rule)!;
const fixed = (doc: EmailDoc, rule: string) => (find(doc, rule).fix ?? []).reduce(reduceDoc, doc);
const globals = (doc: EmailDoc, patch: DocAction & { type: "setGlobalStyles" }) =>
  reduceDoc(doc, patch);
const g = defaultGlobalStyles("ttw");

describe("optimize", () => {
  it("finds nothing in a finished email, and so does the list shown before sending", () => {
    expect(optimize(good())).toEqual([]);
    expect(docChecks(good())).toEqual([]);
  });
  it("puts what must be fixed first, then what is worth a look, then tips, and names each finding once", () => {
    const doc = {
      ...good([
        block("button", "b2", { label: "", url: "" }),
        block("paragraph", "long", { html: "word ".repeat(300) }),
      ]),
      meta: { subject: "", previewText: "" },
    };
    const found = optimize(doc);
    expect(found.map((s) => s.level)).toEqual(
      [...found.map((s) => s.level)].sort(
        (a, b) => ["error", "warn", "tip"].indexOf(a) - ["error", "warn", "tip"].indexOf(b),
      ),
    );
    expect(new Set(found.map((s) => s.id)).size).toBe(found.length);
    expect(found[0]).toMatchObject({ rule: "subject-missing", level: "error" });
    expect(docChecks(doc)).toEqual(found.filter((s) => s.level !== "tip").map((s) => s.title));
    expect(docChecks(doc)).not.toContain("A block of text is very long.");
  });

  describe("the subject and preview text", () => {
    const subject = (s: string) => ({ ...good(), meta: { subject: s, previewText: "x" } });
    it("must be there, and not too long", () => {
      expect(rules(subject(""))).toEqual(["subject-missing"]);
      expect(rules(subject("  "))).toEqual(["subject-missing"]);
      expect(rules(subject("x".repeat(61)))).toEqual(["subject-long"]);
      expect(rules(subject("x".repeat(60)))).toEqual([]);
      expect(rules({ ...good(), meta: { subject: "Fine", previewText: "" } })).toEqual([
        "preview-missing",
      ]);
    });
    it("should not shout: capitals all through, or more than one exclamation mark, each with a fix", () => {
      expect(rules(subject("HUGE YARN SALE"))).toEqual(["subject-caps"]);
      expect(fixed(subject("HUGE YARN SALE"), "subject-caps").meta.subject).toBe("Huge yarn sale");
      for (const fine of ["Yarn sale", "SALE on yarn", "20% OFF", "USA", "Österreich news", "2026"])
        expect(rules(subject(fine)), fine).toEqual([]);
      expect(rules(subject("ÉTÉ SOLDES"))).toEqual(["subject-caps"]);
      expect(rules(subject("Sale! Today!"))).toEqual(["subject-exclaim"]);
      expect(rules(subject("Sale!!!"))).toEqual(["subject-exclaim"]);
      expect(fixed(subject("Sale!! Today only!!!"), "subject-exclaim").meta.subject).toBe(
        "Sale! Today only",
      );
      expect(rules(subject("Sale today!"))).toEqual([]);
      expect(rules(subject("SALE!! NOW!!")).sort()).toEqual(["subject-caps", "subject-exclaim"]);
      // After its fix a finding is gone.
      expect(rules(fixed(subject("HUGE YARN SALE"), "subject-caps"))).toEqual([]);
    });
  });

  describe("pictures", () => {
    it("need a description, which only a logo can be given automatically", () => {
      const doc = good([
        block("image", "i", { src: "https://cdn.example.com/a.jpg" }),
        block("image", "logo", { src: "https://cdn.example.com/l.png", role: "logo", alt: "" }),
        block("logo", "lg", { src: "https://cdn.example.com/l.png", alt: "" }),
      ]);
      const found = optimize(doc).filter((s) => s.rule === "image-alt");
      expect(found.map((s) => [s.blockId, !!s.fix])).toEqual([
        ["i", false],
        ["logo", true],
        ["lg", true],
      ]);
      const after = found.flatMap((s) => s.fix ?? []).reduce(reduceDoc, doc);
      expect(findBlock(after, "logo")?.block).toMatchObject({ alt: "Tuft the World" });
      expect(findBlock(after, "lg")?.block).toMatchObject({ alt: "Tuft the World" });
      expect(
        rules(reduceDoc(after, { type: "updateBlock", id: "i", patch: { alt: "A rug" } })),
      ).toEqual([]);
    });
    it("that are missing are named, since the block is left out", () => {
      expect(rules(good([block("image", "i")]))).toEqual(["image-empty"]);
      expect(rules(good([block("logo", "l")]))).toEqual(["image-empty"]);
      expect(rules(good([block("video", "v", { url: "https://youtu.be/abcdefghijk" })]))).toEqual([
        "video-empty",
      ]);
      expect(rules(good([block("social", "s")]))).toEqual(["social-empty"]);
      expect(rules(good([block("products", "pr")]))).toEqual(["products-empty"]);
      expect(rules(good([block("banner", "ban")]))).toEqual(["banner-unmade"]);
      expect(
        rules(good([block("banner", "ban", { image: "https://cdn.example.com/b.png", alt: "" })])),
      ).toEqual(["image-alt"]);
    });
    it("are not enough alone: an email of only pictures is flagged", () => {
      const only: EmailDoc = {
        ...good(),
        sections: [
          {
            ...newSection("Body", [
              newRow("1", [
                block("image", "i", {
                  src: "https://cdn.example.com/a.jpg",
                  alt: "A rug",
                  link: "https://tufttheworld.com",
                }),
              ]),
              newRow("1", [block("footer", "f")]),
            ]),
            id: "body",
          },
        ],
      };
      expect(rules(only).sort()).toEqual(["button-none", "image-only"]);
      const withWords = reduceDoc(only, {
        type: "insertBlock",
        block: block("paragraph", "p", { html: "Hello" }),
        at: { sectionId: "body", rowIndex: 0 },
      });
      expect(rules(withWords)).toEqual(["button-none"]);
    });
  });

  describe("buttons", () => {
    it("there should be one, and not a crowd", () => {
      const none: EmailDoc = {
        ...good(),
        sections: [
          {
            ...newSection("Body", [
              newRow("1", [block("paragraph", "p", { html: "Hi" }), block("footer", "f")]),
            ]),
            id: "body",
          },
        ],
      };
      expect(rules(none)).toEqual(["button-none"]);
      const many = good(
        [1, 2, 3].map((n) =>
          block("button", `x${n}`, { label: `More ${n}`, url: `https://tufttheworld.com/${n}` }),
        ),
      );
      expect(find(many, "button-many")).toMatchObject({ level: "tip", blockId: "x3" });
      expect(
        rules(good([block("button", "x1", { label: "More", url: "https://tufttheworld.com/1" })])),
      ).toEqual([]);
    });
    it("need words and a link", () => {
      expect(
        find(
          good([block("button", "x", { label: "", url: "https://tufttheworld.com/1" })]),
          "button-unfinished",
        ),
      ).toMatchObject({ level: "error", blockId: "x" });
      expect(rules(good([block("button", "x", { label: "Later", url: "" })]))).toEqual([
        "button-unfinished",
      ]);
    });
  });

  describe("text", () => {
    it("that is very long gets a tip", () => {
      expect(
        find(good([block("paragraph", "long", { html: "word ".repeat(200) })]), "long-text"),
      ).toMatchObject({ level: "tip", blockId: "long" });
      expect(rules(good([block("paragraph", "ok", { html: "word ".repeat(100) })]))).toEqual([]);
    });
    it("must stand out from what is behind it, measured as the accessibility guidelines do", () => {
      expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
      expect(contrast("#ffffff", "#ffffff")).toBe(1);
      expect(contrast("#fff", "#000")).toBeCloseTo(21, 5);
      expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
      expect(contrast("#213838", "#ffffff")).toBeGreaterThan(4.5);

      const pale = reduceDoc(good(), {
        type: "updateBlockStyles",
        id: "p",
        patch: { color: "#cccccc" },
      });
      expect(find(pale, "contrast-text")).toMatchObject({
        level: "warn",
        blockId: "p",
        fixLabel: "Use a colour that reads",
      });
      expect(findBlock(fixed(pale, "contrast-text"), "p")?.block.styles.color).toBe("#213838");
      expect(rules(fixed(pale, "contrast-text"))).toEqual([]);
      // Against the block's own background, the section's, or the email's, whichever applies.
      const onDark = reduceDoc(good(), {
        type: "updateBlockStyles",
        id: "p",
        patch: { background: "#213838" },
      });
      expect(rules(onDark)).toEqual(["contrast-text"]);
      expect(findBlock(fixed(onDark, "contrast-text"), "p")?.block.styles.color).toBe("#f5edeb");
      const section = reduceDoc(good(), {
        type: "updateSectionStyles",
        id: "body",
        patch: { contentBg: "#213838" },
      });
      expect(
        optimize(section)
          .filter((s) => s.rule === "contrast-text")
          .map((s) => s.blockId),
      ).toEqual(["h", "p"]);
      expect(
        rules(
          reduceDoc(section, {
            type: "updateSectionStyles",
            id: "body",
            patch: { textColor: "#f5edeb" },
          }),
        ),
      ).toEqual([]);
      // Large text may be a little weaker than small.
      const grey = (id: string) =>
        reduceDoc(good(), { type: "updateBlockStyles", id, patch: { color: "#888888" } });
      expect(rules(grey("p"))).toEqual(["contrast-text"]);
      expect(rules(grey("h"))).toEqual([]);
      // Where neither brand colour reads, black or white is used.
      const mid = reduceDoc(good(), {
        type: "updateBlockStyles",
        id: "p",
        patch: { background: "#777777", color: "#888888" },
      });
      expect(["#000000", "#ffffff"]).toContain(
        findBlock(fixed(mid, "contrast-text"), "p")?.block.styles.color,
      );
    });
    it("on buttons must stand out from the button, fixed for all buttons or for the one that has its own colour", () => {
      const all = globals(good(), {
        type: "setGlobalStyles",
        patch: { button: { ...g.button, bg: "#ffe813", color: "#ffffff" } },
      });
      expect(find(all, "contrast-button")).toMatchObject({
        level: "warn",
        id: "contrast-button:all",
      });
      expect(fixed(all, "contrast-button").globalStyles.button.color).toBe("#213838");
      expect(rules(fixed(all, "contrast-button"))).toEqual([]);
      const one = reduceDoc(good(), {
        type: "updateBlockStyles",
        id: "b",
        patch: { color: "#0051ff" },
      });
      expect(find(one, "contrast-button")).toMatchObject({ id: "contrast-button:b", blockId: "b" });
      expect(findBlock(fixed(one, "contrast-button"), "b")?.block.styles.color).toBe("#f5edeb");
      expect(fixed(one, "contrast-button").globalStyles.button.color).toBe(g.button.color);
    });
    it("should be at least 14 pixels on a phone: one finding per text style, or per block with its own size", () => {
      const p = {
        ...g.text.p,
        sameForMobile: false,
        mobile: { size: 12, lineHeight: 1.6, spacing: 0 },
      };
      const small = globals(good([block("paragraph", "p2", { html: "More" })]), {
        type: "setGlobalStyles",
        patch: { text: { ...g.text, p } },
      });
      const found = optimize(small).filter((s) => s.rule === "small-text");
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        id: "small:p",
        blockId: "p",
        fixLabel: "Make it 14 pixels",
      });
      const after = fixed(small, "small-text");
      expect(after.globalStyles.text.p).toMatchObject({
        desktop: { size: 16 },
        mobile: { size: 14 },
      });
      expect(rules(after)).toEqual([]);
      const both = globals(good(), {
        type: "setGlobalStyles",
        patch: {
          text: {
            ...g.text,
            p: { ...g.text.p, desktop: { size: 12, lineHeight: 1.6, spacing: 0 } },
          },
        },
      });
      expect(fixed(both, "small-text").globalStyles.text.p.desktop.size).toBe(14);
      const own = reduceDoc(good(), {
        type: "updateBlockStyles",
        id: "p",
        patch: { sameForMobile: false, mobile: { size: 11 } },
      });
      expect(find(own, "small-text")).toMatchObject({ id: "small:p", blockId: "p" });
      expect(findBlock(fixed(own, "small-text"), "p")?.block.styles).toMatchObject({
        mobile: { size: 14 },
      });
      const ownBoth = reduceDoc(good(), {
        type: "updateBlockStyles",
        id: "p",
        patch: { size: 12 },
      });
      expect(findBlock(fixed(ownBoth, "small-text"), "p")?.block.styles).toMatchObject({
        size: 14,
      });
      // The footer's small print is left alone.
      expect(rules(good())).toEqual([]);
      const button = globals(good(), {
        type: "setGlobalStyles",
        patch: {
          button: {
            ...g.button,
            sameForMobile: false,
            mobile: { ...g.button.mobile, size: "small" },
          },
        },
      });
      expect(rules(button)).toEqual([]);
    });
  });

  describe("the footer and unsubscribe link", () => {
    it("must be there, and can be added in one step", () => {
      const none: EmailDoc = { ...good(), sections: [good().sections[0]] };
      expect(find(none, "footer-missing")).toMatchObject({
        level: "error",
        fixLabel: "Add a footer",
      });
      const after = fixed(none, "footer-missing");
      expect(
        after.sections[0].rows[after.sections[0].rows.length - 1].columns[0].blocks[0],
      ).toMatchObject({ type: "footer" });
      expect(rules(after)).toEqual([]);
      expect(renderDocHtml(after)).toContain("{{ unsubscribe_link }}");
    });
    it("for another platform, the marker is pointed out, once", () => {
      const other = { ...good(), platform: "other" as const };
      expect(optimize(other).map((s) => [s.rule, s.blockId])).toEqual([
        ["unsubscribe-marker", "f"],
      ]);
      expect(docChecks(other)[0]).toMatch(
        /replace PASTE-YOUR-UNSUBSCRIBE-LINK-HERE .* unsubscribe tag/,
      );
    });
  });

  describe("links", () => {
    it("that are stand-ins or not secure are found wherever they are, with a fix where it is safe", () => {
      const doc = good([
        block("button", "old", { label: "Old", url: "http://tufttheworld.com/old" }),
        block("paragraph", "text", { html: 'See <a href="https://example.com">this</a>' }),
        block("button", "local", { label: "Local", url: "https://localhost/x" }),
        block("social", "soc", {
          links: [{ network: "instagram", url: "https://www.example.com/me" }],
        }),
      ]);
      const found = optimize(doc).filter((s) => s.rule.startsWith("link-"));
      expect(found.map((s) => [s.rule, s.blockId, s.level, !!s.fix])).toEqual([
        ["link-placeholder", "text", "error", false],
        ["link-blocked", "local", "error", false],
        ["link-placeholder", "soc", "error", false],
        ["link-http", "old", "warn", true],
      ]);
      expect(findBlock(fixed(doc, "link-http"), "old")?.block).toMatchObject({
        url: "https://tufttheworld.com/old",
      });
    });
    it("leave alone what the platform fills in, email addresses and phone numbers", () => {
      expect(
        rules(
          good([
            block("paragraph", "t", {
              html: 'Write to <a href="mailto:hello@tufttheworld.com">us</a> or <a href="{{ unsubscribe_link }}">unsubscribe</a>',
            }),
          ]),
        ),
      ).toEqual([]);
    });
    it("in pasted HTML are fixed inside the HTML", () => {
      const doc = good([
        block("code", "c", {
          html: '<a href="http://tufttheworld.com/a?x=1&amp;y=2">one</a> <a href="https://tufttheworld.com/b">two</a>',
        }),
      ]);
      expect(find(doc, "link-http")).toMatchObject({ blockId: "c" });
      expect(findBlock(fixed(doc, "link-http"), "c")?.block).toMatchObject({
        html: '<a href="https://tufttheworld.com/a?x=1&amp;y=2">one</a> <a href="https://tufttheworld.com/b">two</a>',
      });
    });
  });

  it("warns as the email nears the size Gmail cuts off, and says when it is over", () => {
    // Text in short words, so each paragraph is long but not one of the "very long" ones is all that is found.
    const filler = (n: number) =>
      good(
        Array.from({ length: n }, (_, i) =>
          block("code", `c${i}`, { html: `<p>${"x".repeat(1900)}</p>` }),
        ),
      );
    expect(rules(filler(20))).toEqual([]);
    expect(find(filler(48), "size")).toMatchObject({ id: "size-near", level: "warn" });
    expect(find(filler(56), "size")).toMatchObject({ id: "size-over", level: "error" });
  });
  it("every fix it offers is a change that really changes the email, and survives saving", () => {
    const messy = {
      ...good([
        block("button", "old", { label: "Old", url: "http://tufttheworld.com/old" }),
        block("image", "logo", { src: "https://cdn.example.com/l.png", role: "logo", alt: "" }),
      ]),
      meta: { subject: "BIG SALE!! NOW!!", previewText: "" },
    };
    for (const s of optimize(messy).filter((x) => x.fix)) {
      const after = s.fix!.reduce(reduceDoc, messy);
      expect(after, s.rule).not.toBe(messy);
      expect(
        optimize(after).some((x) => x.id === s.id),
        s.rule,
      ).toBe(false);
      expect(normalizeDoc(JSON.parse(JSON.stringify(after))), s.rule).toEqual(normalizeDoc(after));
    }
  });
});
