import { describe, expect, it } from "vitest";
import {
  SIZE_LIMIT,
  plainSectionStyles,
  plainStyles,
  allBlocks,
  defaultDoc,
  defaultGlobalStyles,
  docChecks,
  docId,
  findBlock,
  htmlBytes,
  inlineFromMarkup,
  inlineText,
  newBlock,
  newRow,
  newSection,
  normalizeDoc,
  reduceDoc,
  renderDocHtml,
  sanitizeInline,
  type Block,
  type DocAction,
  type EmailDoc,
} from "./index";
import { normalizeEmail } from "./email";
import { buildSlide } from "./slide-layouts";

describe("sanitizeInline", () => {
  it("keeps bold, italic, underline, links and line breaks", () => {
    const html =
      'A <b>bold</b> <strong>strong</strong> <i>it</i> <em>em</em> <u>under</u><br>and <a href="https://example.com/a?b=1&amp;c=2">a link</a> or <a href="mailto:hi@example.com">mail</a>';
    expect(sanitizeInline(html)).toBe(html);
  });
  it("removes scripts and style sheets, insides and all", () => {
    expect(sanitizeInline("Hi<script>alert(1)</script> there")).toBe("Hi there");
    expect(sanitizeInline('Hi<SCRIPT src="https://x.example/a.js"></SCRIPT>!')).toBe("Hi!");
    expect(sanitizeInline("a<style>p{color:red}</style>b")).toBe("ab");
    expect(sanitizeInline("a<script>never closed")).toBe("a");
    expect(
      sanitizeInline(
        'a<iframe src="https://x.example"></iframe>b<svg onload=alert(1)><circle/></svg>c',
      ),
    ).toBe("abc");
  });
  it("drops event handlers and every other attribute", () => {
    expect(sanitizeInline('<b onclick="alert(1)" style="color:red" class="x">hi</b>')).toBe(
      "<b>hi</b>",
    );
    expect(
      sanitizeInline('<a href="https://example.com" onmouseover="alert(1)" target="_blank">x</a>'),
    ).toBe('<a href="https://example.com">x</a>');
    expect(sanitizeInline("<img src=x onerror=alert(1)>text")).toBe("text");
    expect(sanitizeInline('<img src="x" onerror="alert(1)">')).toBe("");
  });
  it("only links to https: and mailto: addresses", () => {
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " javascript:alert(1)",
      "java&#115;cript:alert(1)",
      "data:text/html,<b>x</b>",
      "http://plain.example",
      "//example.com",
      "vbscript:x",
      "https://exa mple.com",
    ]) {
      const out = sanitizeInline(`<a href="${href}">click</a>`);
      expect(out, href).not.toContain("<a");
      expect(out, href).toContain("click");
    }
    expect(sanitizeInline("<a href='https://example.com/x'>single</a>")).toBe(
      '<a href="https://example.com/x">single</a>',
    );
    expect(sanitizeInline("<a href=https://example.com/x>bare</a>")).toBe(
      '<a href="https://example.com/x">bare</a>',
    );
    expect(sanitizeInline("<a>no address</a>")).toBe("no address");
    expect(
      sanitizeInline('<a href="https://a.example"><a href="https://b.example">nested</a></a>'),
    ).toBe('<a href="https://a.example">nested</a>');
  });
  it("closes what is left open and ignores closings with no opening", () => {
    expect(sanitizeInline("<b>bold <i>both")).toBe("<b>bold <i>both</i></b>");
    expect(sanitizeInline("plain</b></i></a>")).toBe("plain");
    expect(sanitizeInline("<b><i>x</b>y</i>")).toBe("<b><i>x</i></b>y");
  });
  it("shows anything that only looks like a tag as the characters typed", () => {
    expect(sanitizeInline('1 < 2 > 0 & "quoted"')).toBe("1 &lt; 2 &gt; 0 &amp; &quot;quoted&quot;");
    expect(sanitizeInline("<script src=x")).toBe("&lt;script src=x");
    expect(sanitizeInline('<img src="x onerror=alert(1)>')).toBe(
      "&lt;img src=&quot;x onerror=alert(1)&gt;",
    );
    expect(sanitizeInline("<<b>x</b>")).toBe("&lt;<b>x</b>");
    expect(sanitizeInline("&lt;script&gt;alert(1)&lt;/script&gt; &nbsp;&amp;&#39;")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt; &nbsp;&amp;&#39;",
    );
  });
  it("copes with nested junk and never lets a tag it does not know through", () => {
    const nasty =
      '<div><span style="x"><font color=red><b><scr<script>ipt>alert(1)</scr</script>ipt></b></font></span></div><!-- <b>hidden</b> --><p>next</p><form action="https://x.example"><input value="v">ok</form>';
    const out = sanitizeInline(nasty);
    expect(out).not.toMatch(/<(?!\/?(?:b|strong|i|em|u|a|br)\b)/);
    expect(out).not.toMatch(/on\w+=|javascript:|<script/i);
    expect(out).toContain("next");
    expect(out).toContain("ok");
    expect(out).not.toContain("hidden");
  });
  it("turns the lines a browser makes while typing into line breaks", () => {
    expect(sanitizeInline("one<div>two</div><div><br></div><div>four</div>")).toBe(
      "one<br>two<br><br>four",
    );
    expect(sanitizeInline("<p>one</p><p>two</p>")).toBe("one<br>two");
    expect(sanitizeInline("<br>")).toBe("");
    expect(sanitizeInline("text<br>")).toBe("text");
  });
  it("is stable: cleaning clean text changes nothing", () => {
    for (const s of [
      "<b>a</b>",
      'x <a href="https://e.example/?a=1&amp;b=2">y</a>',
      "1 &lt; 2",
      "a<br><br>b",
      "",
    ])
      expect(sanitizeInline(sanitizeInline(s))).toBe(sanitizeInline(s));
    expect(sanitizeInline(null)).toBe("");
    expect(sanitizeInline("x".repeat(30000)).length).toBeLessThanOrEqual(6000);
  });
  it("holds for any jumble of tags, quotes and addresses: only allowed tags come out, and cleaning twice changes nothing", () => {
    const parts = [
      "<",
      ">",
      '"',
      "'",
      "&",
      "&amp;",
      "&lt;",
      "<b>",
      "</b>",
      "<i>",
      "</i>",
      "<u>",
      "<br>",
      '<a href="https://e.example/a">',
      "<a href='javascript:alert(1)'>",
      "<a href=mailto:a@b.co>",
      "</a>",
      "<script>",
      "</script>",
      "<style>",
      "<img src=x onerror=alert(1)>",
      "<div>",
      "</div>",
      "<p>",
      "<svg onload=x>",
      "<!--",
      "-->",
      ' onclick="x" ',
      "href=",
      "javascript:",
      "text",
      " ",
      "\n",
      "é",
      "<a",
      "<b",
      "</",
      '="',
    ];
    // A small fixed-seed generator, so a failure can be reproduced.
    let seed = 20261121;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let n = 0; n < 1500; n++) {
      const input = Array.from(
        { length: 1 + Math.floor(next() * 14) },
        () => parts[Math.floor(next() * parts.length)],
      ).join("");
      const out = sanitizeInline(input);
      expect(sanitizeInline(out), input).toBe(out);
      const tags = out.match(/<[^>]*>/g) ?? [];
      for (const tag of tags)
        expect(tag, input).toMatch(
          /^<\/?(?:b|i|u)>$|^<br>$|^<\/a>$|^<a href="(?:https:\/\/|mailto:)[^"<>\s]*">$/,
        );
      expect(out.replace(/<[^>]*>/g, ""), input).not.toMatch(/[<>"]/);
      const opened = tags.filter((t) => /^<[abiu][ >]/.test(t)).length;
      expect(tags.filter((t) => t.startsWith("</")).length, input).toBe(opened);
    }
  });
  it("reads the words back out, and converts the earlier link and bold marks", () => {
    expect(inlineText("a <b>b</b><br>1 &lt; 2 &amp; 3")).toBe("a b\n1 < 2 & 3");
    expect(
      inlineFromMarkup(
        "See [our guide](https://tufttheworld.com/guide) and **save the date**.\n\nWrite to [us](mailto:hello@example.com).",
      ),
    ).toBe(
      'See <a href="https://tufttheworld.com/guide">our guide</a> and <b>save the date</b>.<br><br>Write to <a href="mailto:hello@example.com">us</a>.',
    );
    const risky = inlineFromMarkup(
      "[x](javascript:alert(1)) <img src=x onerror=1> [y](http://plain.example)",
    );
    expect(risky).not.toContain("<a");
    expect(risky).not.toContain("<img");
  });
});

const heading = (html: string, id = docId("b")): Block =>
  ({ ...newBlock("heading"), id, html }) as Block;
const small = (): EmailDoc => ({
  ...defaultDoc("ttw"),
  sections: [
    { id: "top", name: "Header", styles: plainSectionStyles(), rows: [] },
    {
      id: "body",
      name: "Body",
      styles: plainSectionStyles(),
      rows: [
        {
          id: "r1",
          layout: "1",
          stackOnMobile: true,
          columns: [{ id: "c1", blocks: [heading("One", "a")] }],
        },
        {
          id: "r2",
          layout: "2",
          stackOnMobile: true,
          columns: [
            { id: "c2", blocks: [heading("Two", "b"), heading("Three", "c")] },
            { id: "c3", blocks: [] },
          ],
        },
        {
          id: "r3",
          layout: "1",
          stackOnMobile: true,
          columns: [{ id: "c4", blocks: [heading("Four", "d")] }],
        },
      ],
    },
    { id: "foot", name: "Footer", styles: plainSectionStyles(), rows: [] },
  ],
});
const order = (doc: EmailDoc) =>
  allBlocks(doc)
    .map((b) => b.id)
    .join("");
const run = (doc: EmailDoc, ...actions: DocAction[]) => actions.reduce(reduceDoc, doc);

describe("reduceDoc", () => {
  it("never changes the document it is given, and returns the same one when nothing changes", () => {
    const doc = small();
    const frozen = JSON.stringify(doc);
    const noops: DocAction[] = [
      { type: "deleteBlock", id: "nope" },
      { type: "moveBlock", id: "b", to: { columnId: "c2", index: 0 } },
      { type: "moveBlock", id: "b", to: { columnId: "c2", index: 1 } },
      { type: "moveBlock", id: "a", to: { sectionId: "body", rowIndex: 0 } },
      { type: "moveBlock", id: "a", to: { sectionId: "body", rowIndex: 1 } },
      { type: "moveBlock", id: "a", to: { columnId: "gone", index: 0 } },
      { type: "updateBlock", id: "a", patch: { html: "One" } },
      { type: "clearBlockStyles", id: "a" },
      { type: "setTitle", title: doc.title },
      { type: "setMeta", patch: {} },
      { type: "nudgeBlock", id: "x", by: 1 },
      { type: "moveSection", id: "top", by: -1 },
      { type: "setRowLayout", id: "r2", layout: "2" },
      { type: "renameSection", id: "body", name: " " },
      { type: "duplicateBlock", id: "a", newId: "b" },
      { type: "insertBlock", block: heading("dupe", "a"), at: { columnId: "c1", index: 0 } },
    ];
    for (const action of noops) expect(reduceDoc(doc, action), action.type).toBe(doc);
    run(
      doc,
      { type: "deleteBlock", id: "a" },
      { type: "moveBlock", id: "b", to: { columnId: "c3", index: 0 } },
      { type: "updateBlock", id: "c", patch: { html: "x" } },
      { type: "setRowLayout", id: "r2", layout: "1" },
      { type: "moveSection", id: "body", by: 1 },
    );
    expect(JSON.stringify(doc)).toBe(frozen);
  });
  it("puts a block in a column, or between rows in a row of its own", () => {
    const inColumn = reduceDoc(small(), {
      type: "insertBlock",
      block: heading("New", "n"),
      at: { columnId: "c2", index: 1 },
    });
    expect(order(inColumn)).toBe("abncd");
    const between = reduceDoc(small(), {
      type: "insertBlock",
      block: heading("New", "n"),
      at: { sectionId: "body", rowIndex: 1 },
    });
    expect(order(between)).toBe("anbcd");
    expect(between.sections[1].rows).toHaveLength(4);
    expect(between.sections[1].rows[1]).toMatchObject({ layout: "1" });
    expect(
      order(
        reduceDoc(small(), {
          type: "insertBlock",
          block: heading("New", "n"),
          at: { columnId: "c3", index: 99 },
        }),
      ),
    ).toBe("abcnd");
  });
  it("moves a block, taking away a one-column row it leaves empty but keeping a row of columns", () => {
    const toColumn = reduceDoc(small(), {
      type: "moveBlock",
      id: "a",
      to: { columnId: "c3", index: 0 },
    });
    expect(order(toColumn)).toBe("bcad");
    expect(toColumn.sections[1].rows.map((r) => r.id)).toEqual(["r2", "r3"]);
    const within = reduceDoc(small(), {
      type: "moveBlock",
      id: "b",
      to: { columnId: "c2", index: 2 },
    });
    expect(order(within)).toBe("acbd");
    const out = run(
      small(),
      { type: "moveBlock", id: "b", to: { sectionId: "foot", rowIndex: 0 } },
      { type: "moveBlock", id: "c", to: { sectionId: "top", rowIndex: 0 } },
    );
    expect(order(out)).toBe("cadb");
    expect(out.sections[1].rows.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
  });
  it("steps a block up and down with the arrow keys, across rows and sections", () => {
    expect(order(reduceDoc(small(), { type: "nudgeBlock", id: "c", by: -1 }))).toBe("acbd");
    const down = reduceDoc(small(), { type: "nudgeBlock", id: "a", by: 1 });
    expect(order(down)).toBe("bcad");
    const up = reduceDoc(small(), { type: "nudgeBlock", id: "a", by: -1 });
    expect(up.sections[0].rows).toHaveLength(1);
    expect(findBlock(up, "a")?.section.id).toBe("top");
    const stepOut = reduceDoc(small(), { type: "nudgeBlock", id: "c", by: 1 });
    expect(order(stepOut)).toBe("abcd");
    expect(stepOut.sections[1].rows).toHaveLength(4);
    expect(findBlock(stepOut, "c")?.row.layout).toBe("1");
    expect(
      reduceDoc(
        run(small(), { type: "moveBlock", id: "d", to: { sectionId: "foot", rowIndex: 0 } }),
        { type: "nudgeBlock", id: "d", by: 1 },
      ).sections[2].rows,
    ).toHaveLength(1);
  });
  it("copies a block directly below it with a new id, and deletes one", () => {
    const styled = reduceDoc(small(), {
      type: "updateBlockStyles",
      id: "b",
      patch: { background: "#ffe813" },
    });
    const copied = reduceDoc(styled, { type: "duplicateBlock", id: "b", newId: "z" });
    expect(order(copied)).toBe("abzcd");
    expect(findBlock(copied, "z")?.block).toMatchObject({
      html: "Two",
      styles: { background: "#ffe813" },
    });
    expect(findBlock(copied, "z")?.block.styles).not.toBe(findBlock(copied, "b")?.block.styles);
    const deleted = reduceDoc(small(), { type: "deleteBlock", id: "a" });
    expect(order(deleted)).toBe("bcd");
    expect(deleted.sections[1].rows.map((r) => r.id)).toEqual(["r2", "r3"]);
    expect(
      run(
        small(),
        { type: "deleteBlock", id: "b" },
        { type: "deleteBlock", id: "c" },
      ).sections[1].rows.map((r) => r.id),
    ).toEqual(["r1", "r2", "r3"]);
  });
  it("changes a block's content and styles, cleaning formatted text on the way in", () => {
    const doc = run(
      small(),
      {
        type: "updateBlock",
        id: "a",
        patch: {
          html: 'Hi<script>alert(1)</script> <b onclick="x()">there</b>',
          id: "hacked",
          type: "button",
          level: 1,
        },
      },
      {
        type: "updateBlockStyles",
        id: "a",
        patch: { align: "center", desktop: { padding: { top: 1, right: 2, bottom: 3, left: 4 } } },
      },
    );
    expect(findBlock(doc, "a")?.block).toMatchObject({
      id: "a",
      type: "heading",
      level: 1,
      html: "Hi <b>there</b>",
      styles: {
        align: "center",
        sameForMobile: true,
        desktop: { padding: { top: 1, right: 2, bottom: 3, left: 4 } },
      },
    });
    const unset = reduceDoc(doc, {
      type: "updateBlockStyles",
      id: "a",
      patch: { align: undefined },
    });
    expect(Object.keys(findBlock(unset, "a")!.block.styles).sort()).toEqual([
      "desktop",
      "sameForMobile",
    ]);
    expect(
      findBlock(reduceDoc(doc, { type: "clearBlockStyles", id: "a" }), "a")?.block.styles,
    ).toEqual(plainStyles());
  });
  it("adds, moves and deletes rows, and changes a row's columns without losing blocks", () => {
    const added = reduceDoc(small(), {
      type: "addRow",
      row: { ...newRow("3"), id: "new" },
      sectionId: "body",
      index: 1,
    });
    expect(added.sections[1].rows.map((r) => r.id)).toEqual(["r1", "new", "r2", "r3"]);
    expect(added.sections[1].rows[1].columns).toHaveLength(3);
    expect(
      reduceDoc(added, { type: "moveRow", id: "new", by: 1 }).sections[1].rows.map((r) => r.id),
    ).toEqual(["r1", "r2", "new", "r3"]);
    const hop = reduceDoc(small(), { type: "moveRow", id: "r1", by: -1 });
    expect(hop.sections[0].rows.map((r) => r.id)).toEqual(["r1"]);
    expect(
      reduceDoc(small(), { type: "deleteRow", id: "r2" }).sections[1].rows.map((r) => r.id),
    ).toEqual(["r1", "r3"]);
    const filled = reduceDoc(small(), {
      type: "moveBlock",
      id: "c",
      to: { columnId: "c3", index: 0 },
    });
    const one = reduceDoc(filled, { type: "setRowLayout", id: "r2", layout: "1" });
    expect(one.sections[1].rows[1].columns).toHaveLength(1);
    expect(order(one)).toBe("abcd");
    const three = reduceDoc(one, { type: "setRowLayout", id: "r2", layout: "1:2" });
    expect(three.sections[1].rows[1].columns.map((c) => c.blocks.length)).toEqual([2, 0]);
  });
  it("changes the email's styles, details and sections", () => {
    const doc = run(
      small(),
      { type: "setGlobalStyles", patch: { pageBg: "#000000" } },
      { type: "setMeta", patch: { subject: "Hello" } },
      { type: "setTitle", title: "Spring" },
      { type: "setPlatform", platform: "other" },
      { type: "addSection", section: { ...newSection("Extra"), id: "extra" }, index: 1 },
      { type: "renameSection", id: "extra", name: "Offers" },
      { type: "moveSection", id: "extra", by: 1 },
    );
    expect(doc).toMatchObject({
      title: "Spring",
      platform: "other",
      meta: { subject: "Hello", previewText: "" },
      globalStyles: { pageBg: "#000000", contentBg: "#ffffff" },
    });
    expect(doc.sections.map((s) => s.name)).toEqual(["Header", "Body", "Offers", "Footer"]);
    expect(reduceDoc(doc, { type: "deleteSection", id: "extra" }).sections).toHaveLength(3);
    const last = run(
      small(),
      { type: "deleteSection", id: "top" },
      { type: "deleteSection", id: "foot" },
    );
    expect(reduceDoc(last, { type: "deleteSection", id: "body" })).toBe(last);
  });
  it("can be stepped back: each earlier document is still exactly as it was", () => {
    const steps: DocAction[] = [
      { type: "insertBlock", block: heading("New", "n"), at: { sectionId: "body", rowIndex: 0 } },
      { type: "moveBlock", id: "n", to: { columnId: "c3", index: 0 } },
      { type: "duplicateBlock", id: "n", newId: "m" },
      { type: "deleteBlock", id: "a" },
      { type: "updateBlock", id: "m", patch: { html: "Changed" } },
    ];
    const history = [small()];
    const snapshots = [JSON.stringify(history[0])];
    for (const action of steps) {
      history.push(reduceDoc(history[history.length - 1], action));
      snapshots.push(JSON.stringify(history[history.length - 1]));
    }
    history.forEach((doc, i) => expect(JSON.stringify(doc)).toBe(snapshots[i]));
    expect(new Set(snapshots).size).toBe(snapshots.length);
    // Every block id stays unique whatever is done.
    const ids = allBlocks(history[history.length - 1]).map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

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
  blocks: [
    {
      id: "a",
      type: "text",
      heading: "Read <on>",
      body: "All yarn is 20% off. See [our guide](https://tufttheworld.com/guide) and **save the date**.\n\nSaturday & Sunday <only>.",
    },
    {
      id: "b",
      type: "image",
      url: "https://cdn.example.com/rug.jpg",
      alt: "A blue rug",
      link: "https://tufttheworld.com/rugs",
    },
    {
      id: "c",
      type: "products",
      items: [
        {
          title: "Reflect Wool",
          price: "$18",
          url: "https://tufttheworld.com/products/wool",
          image: "https://cdn.example.com/wool.jpg",
        },
      ],
    },
    { id: "d", type: "divider" },
    {
      id: "e",
      type: "button",
      label: "Shop the sale",
      url: "https://tufttheworld.com/collections/yarn",
    },
    { id: "f", type: "note", body: "Happy tufting,\nTim" },
  ],
};

describe("normalizeDoc", () => {
  const doc = normalizeDoc(raw, { logo: "https://cdn.example.com/logo.png" });
  const blocks = allBlocks(doc);
  it("turns an email from before the builder into header, body and footer, losing nothing", () => {
    expect(doc).toMatchObject({
      v: 2,
      brand: "ttw",
      platform: "shopify",
      title: "Yarn sale this weekend",
      meta: {
        subject: "Yarn sale this weekend",
        previewText: "20% off every colour, in store and online.",
      },
    });
    expect(doc.sections.map((s) => s.name)).toEqual(["Header", "Body", "Footer"]);
    expect(doc.sections[0].rows[0].columns[0].blocks[0]).toMatchObject({
      type: "image",
      role: "logo",
      alt: "Tuft the World",
    });
    expect(doc.globalStyles.logo).toEqual({
      src: "https://cdn.example.com/logo.png",
      width: 96,
      align: "center",
      link: "https://tufttheworld.com",
    });
    expect(doc.sections[1].rows.flatMap((r) => r.columns[0].blocks.map((b) => b.type))).toEqual([
      "banner",
      "heading",
      "paragraph",
      "image",
      "products",
      "divider",
      "button",
      "paragraph",
    ]);
    expect(doc.sections[1].rows.every((r) => r.layout === "1")).toBe(true);
    expect(doc.sections[2].rows[0].columns[0].blocks[0]).toMatchObject({
      type: "footer",
      site: "https://tufttheworld.com",
      siteLabel: "tufttheworld.com",
    });
  });
  it("carries the banner over as a design that can still be edited, pointing at the main button", () => {
    const banner = blocks.find((b) => b.type === "banner");
    expect(banner).toMatchObject({
      image: "https://cdn.example.com/banner.png",
      alt: "This weekend. The big yarn sale. 20% off",
      link: "https://tufttheworld.com/collections/yarn",
    });
    expect(banner?.type === "banner" && banner.design).toMatchObject({ v: 1, format: "3:2" });
    expect(
      banner?.type === "banner" && banner.design.slides[0].layers.map((l) => l.text),
    ).toContain("The big yarn sale");
    const edited = buildSlide(
      "statement",
      { headline: "Edited by hand", color: "pepper" },
      "3:2",
      "banner",
    );
    const kept = allBlocks(
      normalizeDoc({
        ...raw,
        bannerDesign: { format: "4:5", slides: [edited] },
        bannerImage: null,
      }),
    ).find((b) => b.type === "banner");
    expect(kept?.type === "banner" && kept.design.slides[0].layers.map((l) => l.text)).toContain(
      "Edited by hand",
    );
    expect(kept).toMatchObject({ image: "" });
  });
  it("turns marked-up text into formatted text, and nothing else into HTML", () => {
    expect(blocks.find((b) => b.type === "heading")).toMatchObject({
      level: 2,
      html: "Read &lt;on&gt;",
    });
    const texts = blocks
      .filter((b) => b.type === "paragraph")
      .map((b) => (b.type === "paragraph" ? b.html : ""));
    expect(texts[0]).toBe(
      'All yarn is 20% off. See <a href="https://tufttheworld.com/guide">our guide</a> and <b>save the date</b>.<br><br>Saturday &amp; Sunday &lt;only&gt;.',
    );
    expect(texts[1]).toBe("<i>Happy tufting,<br>Tim</i>");
  });
  it("carries images, products and buttons over as they were", () => {
    expect(blocks.find((b) => b.type === "image" && b.alt === "A blue rug")).toMatchObject({
      src: "https://cdn.example.com/rug.jpg",
      link: "https://tufttheworld.com/rugs",
      width: 100,
    });
    expect(blocks.find((b) => b.type === "products")).toMatchObject({
      items: [{ title: "Reflect Wool", price: "$18" }],
    });
    expect(blocks.find((b) => b.type === "button")).toMatchObject({
      label: "Shop the sale",
      url: "https://tufttheworld.com/collections/yarn",
    });
  });
  it("reads the writer's sections, products, button and sign-off, and an empty email", () => {
    const written = normalizeDoc(
      normalizeEmail({
        subject: "S",
        banner: { headline: "Hi" },
        sections: [{ heading: "", body: "Hello." }],
        button: { label: "Shop", url: "https://tufttheworld.com" },
        signoff: "Tim",
      }),
    );
    expect(written.sections[1].rows.flatMap((r) => r.columns[0].blocks.map((b) => b.type))).toEqual(
      ["banner", "paragraph", "button", "paragraph"],
    );
    expect(written.sections[0].rows).toEqual([]);
    expect(normalizeDoc(null)).toMatchObject({ v: 2, title: "Untitled email", brand: "ttw" });
    expect(normalizeDoc({ brand: "history", platform: "other" })).toMatchObject({
      brand: "history",
      platform: "other",
      globalStyles: defaultGlobalStyles("history"),
    });
  });
  it("gives a builder document back unchanged, so saving and reopening restores it exactly", () => {
    expect(normalizeDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    const edited = run(
      doc,
      { type: "setRowLayout", id: doc.sections[1].rows[1].id, layout: "2:1" },
      {
        type: "setGlobalStyles",
        patch: {
          button: {
            ...doc.globalStyles.button,
            shape: "custom",
            radius: 9,
            bg: "#ff6229",
            sameForMobile: false,
            mobile: {
              size: "large",
              align: "full",
              padding: { top: 1, right: 2, bottom: 3, left: 4 },
            },
          },
        },
      },
      {
        type: "updateBlockStyles",
        id: blocks[2].id,
        patch: {
          background: "#ffe813",
          size: 30,
          align: "center",
          sameForMobile: false,
          mobile: { size: 20, margin: { top: 4, right: 4, bottom: 4, left: 4 } },
        },
      },
      {
        type: "updateSectionStyles",
        id: doc.sections[1].id,
        patch: {
          background: "#213838",
          linkColor: "#ffe813",
          font: "verdana",
          border: { style: "dashed", color: "#0051ff", width: 2 },
        },
      },
      { type: "setRowStack", id: doc.sections[1].rows[1].id, stack: false },
    );
    expect(normalizeDoc(JSON.parse(JSON.stringify(edited)))).toEqual(edited);
  });
  it("accepts only safe values in a builder document", () => {
    const odd = normalizeDoc({
      v: 2,
      brand: "nope",
      platform: "weird",
      title: "",
      meta: { subject: 5 },
      globalStyles: {
        pageBg: "red",
        contentBg: "#FFF",
        text: { p: { font: "comic", size: 900, color: "url(x)" } },
        button: { shape: "blob", size: "huge" },
        divider: { thickness: -4 },
      },
      sections: [
        {
          name: "",
          rows: [
            {
              layout: "9",
              columns: [
                {
                  blocks: [
                    {
                      type: "image",
                      src: "http://insecure.example/x.png",
                      link: "javascript:alert(1)",
                      width: 900,
                    },
                    { type: "button", label: "Go", url: "ftp://x" },
                    { type: "button", label: "Mail", url: "mailto:hi@example.com" },
                    {
                      type: "paragraph",
                      html: "<script>alert(1)</script>ok",
                      styles: {
                        background: "javascript:1",
                        desktop: { padding: { top: -5, left: 999 } },
                        sameForMobile: "no",
                        mobile: { size: 900, junk: 1 },
                        align: "justify",
                        size: 4,
                      },
                    },
                    { type: "banner", design: { slides: [] } },
                    { type: "mystery" },
                    { type: "spacer", height: "big" },
                    {
                      type: "products",
                      items: [
                        { title: "No photo", url: "https://tufttheworld.com/x", image: "" },
                        {
                          title: "Bad link",
                          url: "javascript:alert(1)",
                          image: "https://cdn.example.com/a.jpg",
                        },
                      ],
                    },
                    { type: "footer", site: "http://insecure.example" },
                  ],
                },
                { blocks: [{ type: "divider" }] },
              ],
            },
          ],
        },
      ],
    });
    const d = defaultGlobalStyles("ttw");
    expect(odd).toMatchObject({
      brand: "ttw",
      platform: "shopify",
      title: "Untitled email",
      meta: { subject: "5", previewText: "" },
    });
    expect(odd.globalStyles).toMatchObject({
      pageBg: d.pageBg,
      contentBg: "#fff",
      text: { p: { font: "arial", desktop: { size: 72 }, color: d.text.p.color } },
      button: { shape: "pill", desktop: { size: "medium" } },
      divider: { thickness: 1 },
    });
    expect(odd.sections[0].name).toBe("Section");
    expect(odd.sections[0].rows[0]).toMatchObject({ layout: "1" });
    expect(odd.sections[0].rows[0].columns).toHaveLength(1);
    const kept = allBlocks(odd);
    expect(kept.map((b) => b.type)).toEqual([
      "image",
      "button",
      "button",
      "paragraph",
      "spacer",
      "products",
      "footer",
    ]);
    expect(kept[0]).toMatchObject({ src: "", link: "", width: 100 });
    expect(kept[1]).toMatchObject({ url: "" });
    expect(kept[2]).toMatchObject({ url: "mailto:hi@example.com" });
    expect(kept[3]).toMatchObject({
      html: "ok",
      styles: {
        sameForMobile: true,
        desktop: { padding: { top: 0, right: 0, bottom: 0, left: 80 } },
        mobile: { size: 72 },
        size: 10,
      },
    });
    expect(kept[3].styles).not.toHaveProperty("background");
    expect(kept[4]).toMatchObject({ height: 24 });
    expect(kept[5]).toMatchObject({ items: [] });
    expect(kept[6]).toMatchObject({ site: "https://tufttheworld.com" });
    expect(normalizeDoc({ v: 2, sections: [] }).sections).toHaveLength(1);
  });
});

describe("defaultDoc", () => {
  it("starts with a header, a body and a footer in the brand's own look", () => {
    const doc = defaultDoc("pyc", "other", { logo: "https://cdn.example.com/pyc.png" });
    expect(doc).toMatchObject({ v: 2, brand: "pyc", platform: "other", title: "Untitled email" });
    expect(doc.sections.map((s) => s.name)).toEqual(["Header", "Body", "Footer"]);
    expect(
      doc.sections.map((s) =>
        s.rows.flatMap((r) => r.columns.flatMap((c) => c.blocks.map((b) => b.type))),
      ),
    ).toEqual([["image", "divider"], ["image", "heading", "paragraph", "button"], ["footer"]]);
    expect(doc.globalStyles).toMatchObject({
      pageBg: "#f4f6f2",
      text: {
        h1: { font: "narrow", uppercase: true, bold: true, letterSpacing: 0.5, color: "#213838" },
      },
      button: { bg: "#2f5e4f" },
      link: { color: "#2f5e4f" },
    });
    expect(doc.globalStyles.logo).toMatchObject({
      src: "https://cdn.example.com/pyc.png",
      width: 260,
    });
    expect(allBlocks(doc).find((b) => b.type === "footer")).toMatchObject({
      site: "https://www.priceyourcraft.com",
      why: "You are getting this because you signed up for news from Price Your Craft.",
    });
    expect(
      defaultDoc().sections[0].rows.flatMap((r) => r.columns[0].blocks.map((b) => b.type)),
    ).toEqual(["divider"]);
    expect(defaultDoc("ttw").globalStyles.text.h1).toMatchObject({
      font: "georgia",
      bold: false,
      uppercase: false,
    });
  });
  it("is a valid document with no sending-platform tags of another service in it", () => {
    const doc = defaultDoc("history", "shopify", { logo: "http://insecure.example/logo.png" });
    expect(normalizeDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    expect(JSON.stringify(doc)).not.toContain("*|");
    expect(doc.sections[0].rows).toHaveLength(1);
    expect(renderDocHtml(doc)).not.toContain("*|");
  });
});

describe("renderDocHtml", () => {
  const doc = normalizeDoc(raw, { logo: "https://cdn.example.com/logo.png" });
  const html = renderDocHtml(doc);
  it("carries the placeholders Shopify requires in a custom-coded email", () => {
    expect(html).toContain('href="{{ unsubscribe_link }}"');
    expect(html.trim().endsWith("{{ open_tracking }}\n</body>\n</html>")).toBe(true);
  });
  it("leaves Shopify's placeholders out for another platform and marks where its unsubscribe tag goes", () => {
    const other = renderDocHtml({ ...doc, platform: "other" });
    expect(other).not.toContain("{{");
    expect(other).toContain('href="PASTE-YOUR-UNSUBSCRIBE-LINK-HERE"');
    expect(html).not.toContain("*|");
    expect(other).not.toContain("*|");
  });
  it("is built the way email programs need: tables and inline styles, with one style sheet for phones only", () => {
    expect(html).not.toMatch(/<script|<link|<div class|<section|display:flex/i);
    expect(html.match(/<table/g)!.length).toBe(html.match(/role="presentation"/g)!.length);
    expect(html.match(/<style/g)).toHaveLength(1);
    const sheet = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
    expect(sheet.startsWith("@media (max-width:600px){")).toBe(true);
    expect(sheet.endsWith("}}")).toBe(true);
    expect(html).toContain('width="600"');
    expect(html).toContain("max-width:600px");
    expect(html).not.toMatch(/font-family:[^;"]*(Larken|Inter|Roboto|var\()/);
  });
  it("stacks columns on a phone and tightens the sides", () => {
    const row = doc.sections[1].rows[1];
    const cols = reduceDoc(doc, { type: "setRowLayout", id: row.id, layout: "1:2" });
    const two = reduceDoc(cols, {
      type: "insertBlock",
      block: {
        ...newBlock("button"),
        label: "Right side",
        url: "https://tufttheworld.com/right",
      } as Block,
      at: { columnId: cols.sections[1].rows[1].columns[1].id, index: 0 },
    });
    const out = renderDocHtml(two);
    expect(out).toMatch(
      /@media \(max-width:600px\)\{\.eb-col\{display:block!important;width:100%!important;/,
    );
    expect(out).toContain('<td class="eb-col" width="200" valign="top"');
    expect(out).toContain('<td class="eb-col" width="400" valign="top"');
    expect(out).toContain("Right side");
    // The sides tighten on a phone: each different spacing gets one rule, shared by every block that needs it.
    const rule = /\.(eb-m\d+)\{padding:8px 16px 8px 16px!important;\}/.exec(out);
    expect(rule).not.toBeNull();
    expect(out).toContain(
      `<td class="${rule![1]}" align="left" style="padding:8px 32px 8px 32px;">`,
    );
    expect(html).not.toContain('class="eb-col"');
  });
  it("shows the logo, banner, text, image, products and button, with what the owner typed made safe", () => {
    expect(html).toContain('src="https://cdn.example.com/logo.png"');
    expect(html).toContain(
      '<a href="https://tufttheworld.com/collections/yarn"><img src="https://cdn.example.com/banner.png" alt="This weekend. The big yarn sale. 20% off"',
    );
    expect(html).toContain("Read &lt;on&gt;</h2>");
    expect(html).toContain("Saturday &amp; Sunday &lt;only&gt;.");
    expect(html).not.toContain("<only>");
    expect(html).toContain(
      '<a href="https://tufttheworld.com/guide" style="color:#0051ff;text-decoration:underline;">our guide</a>',
    );
    expect(html).toContain("<b>save the date</b>");
    expect(html).toContain(
      '<a href="https://tufttheworld.com/rugs"><img src="https://cdn.example.com/rug.jpg" alt="A blue rug"',
    );
    expect(html).toContain("Reflect Wool");
    expect(html).toContain("Happy tufting,<br>Tim");
    expect(html).toContain(
      "You are getting this because you signed up for news from Tuft the World.",
    );
    const order = [
      "logo.png",
      "banner.png",
      "Read &lt;on&gt;",
      "rug.jpg",
      "Reflect Wool",
      ">Shop the sale</a>",
      "Happy tufting",
      "Unsubscribe",
    ].map((s) => html.indexOf(s));
    expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]))).toBe(true);
  });
  it("escapes everything typed into a field", () => {
    const blocks = allBlocks(doc);
    const nasty = run(
      doc,
      {
        type: "setMeta",
        patch: {
          subject: "Sale </title><script>alert(1)</script>",
          previewText: '"><img src=x onerror=alert(1)>',
        },
      },
      {
        type: "updateBlock",
        id: blocks.find((b) => b.type === "button")!.id,
        patch: { label: '<b>Shop</b> "now"' },
      },
      {
        type: "updateBlock",
        id: blocks.find((b) => b.type === "image" && b.alt === "A blue rug")!.id,
        patch: { alt: '"><script>alert(2)</script>' },
      },
      {
        type: "updateBlock",
        id: blocks.find((b) => b.type === "footer")!.id,
        patch: { why: "<i>because</i> & so on", siteLabel: "<site>" },
      },
    );
    const out = renderDocHtml(nasty);
    expect(out).not.toMatch(/<script|<img src=x|<i>because/);
    expect(out).toContain(
      "<title>Sale &lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>",
    );
    expect(out).toContain("&lt;b&gt;Shop&lt;/b&gt; &quot;now&quot;</a>");
    expect(out).toContain('alt="&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;"');
    expect(out).toContain("&lt;i&gt;because&lt;/i&gt; &amp; so on");
  });
  it("only ever links to and loads https: addresses, whatever is in the document", () => {
    const blocks = allBlocks(doc);
    const unsafe = run(
      doc,
      {
        type: "updateBlock",
        id: blocks.find((b) => b.type === "button")!.id,
        patch: { url: "javascript:alert(1)" },
      },
      {
        type: "updateBlock",
        id: blocks.find((b) => b.type === "image" && b.alt === "A blue rug")!.id,
        patch: { src: "http://insecure.example/x.png", link: "data:text/html,x" },
      },
      {
        type: "updateBlock",
        id: blocks.find((b) => b.type === "banner")!.id,
        patch: { link: "http://insecure.example" },
      },
    );
    const out = renderDocHtml(unsafe);
    expect(out).not.toMatch(/javascript:|data:text|http:\/\//);
    const addresses = [...out.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => m[1]);
    expect(addresses.length).toBeGreaterThan(5);
    for (const a of addresses)
      expect(a).toMatch(/^(https:\/\/|mailto:|\{\{ unsubscribe_link \}\}$)/);
    expect(out).not.toContain("Shop the sale");
  });
  it("leaves unfinished blocks out of the email but keeps them for editing, and says so", () => {
    const draft = reduceDoc(
      {
        ...defaultDoc("ttw"),
        sections: [
          newSection("Body", [
            newRow("1", [
              newBlock("image"),
              { ...newBlock("button"), label: "" } as Block,
              newBlock("heading"),
              newBlock("paragraph"),
              newBlock("products"),
              newBlock("banner"),
            ]),
          ]),
        ],
      },
      { type: "setTitle", title: "Draft" },
    );
    expect(allBlocks(draft)).toHaveLength(6);
    const out = renderDocHtml(draft);
    expect(out).not.toContain('src=""');
    expect(out).not.toContain('href=""');
    expect(out).not.toMatch(/<h2|<p style="margin:0;font-family:Arial/);
    const checks = docChecks(draft).join(" ");
    expect(checks).toMatch(/image block has no picture/);
    expect(checks).toMatch(/button is missing/);
    expect(checks).toMatch(/subject line/);
    expect(checks).toMatch(/Footer block/);
  });
  it("still reads when the banner picture has not been made", () => {
    const plain = renderDocHtml(normalizeDoc({ ...raw, bannerImage: null }));
    expect(plain).toContain("<h1");
    expect(plain).toContain("The big yarn sale");
    expect(docChecks(normalizeDoc({ ...raw, bannerImage: null })).join(" ")).toMatch(
      /banner picture/,
    );
  });
  it("names the right site and brand in the footer", () => {
    const history = renderDocHtml(
      normalizeDoc({
        ...raw,
        brand: "history",
        banner: { headline: "Where the gun came from", color: "board" },
      }),
    );
    expect(history).toContain("historyoftuftedrugs.com");
    expect(history).toContain("A History of Tufted Rugs");
    expect(history).not.toContain("Tuft the World.");
  });
  it("follows the email's styles, and a block's own where it has them", () => {
    const blocks = allBlocks(doc);
    const para = blocks.find((b) => b.type === "paragraph")!;
    const styled = run(
      doc,
      {
        type: "setGlobalStyles",
        patch: {
          pageBg: "#101010",
          contentBg: "#fafafa",
          link: { color: "#ff6229", underline: true, bold: false },
          button: {
            ...doc.globalStyles.button,
            shape: "square",
            bg: "#213838",
            color: "#ffe813",
            font: "verdana",
            desktop: {
              size: "large",
              align: "center",
              padding: { top: 18, right: 38, bottom: 18, left: 38 },
            },
          },
          divider: { ...doc.globalStyles.divider, color: "#0051ff", thickness: 3 },
          text: {
            ...doc.globalStyles.text,
            p: {
              ...doc.globalStyles.text.p,
              font: "verdana",
              color: "#333333",
              desktop: { size: 18, lineHeight: 1.6, spacing: 0 },
            },
          },
        },
      },
      {
        type: "updateBlockStyles",
        id: para.id,
        patch: {
          background: "#ffe813",
          color: "#111111",
          size: 20,
          align: "center",
          desktop: { padding: { top: 1, right: 2, bottom: 3, left: 4 } },
        },
      },
    );
    const out = renderDocHtml(styled);
    expect(out).toContain('<body style="margin:0;padding:0;background:#101010;">');
    expect(out).toContain("max-width:600px;background:#fafafa;");
    expect(out).toContain('bgcolor="#213838" style="background:#213838;border-radius:0px;"');
    expect(out).toContain(
      "padding:18px 38px 18px 38px;font-family:Verdana, Geneva, sans-serif;font-size:18px;",
    );
    expect(out).toContain("border-top:3px solid #0051ff;");
    expect(out).toContain(
      'align="center" style="padding:1px 2px 3px 4px;background:#ffe813;"><p style="margin:0;font-family:Verdana, Geneva, sans-serif;font-size:20px;line-height:1.6;color:#111111;text-align:center;">',
    );
    expect(out).toContain('style="color:#ff6229;text-decoration:underline;">our guide</a>');
    // The sign-off has no styles of its own, so it follows the email's.
    expect(out).toContain(
      'font-size:18px;line-height:1.6;color:#333333;text-align:left;"><i>Happy tufting',
    );
  });
  it("stays far under the size at which Gmail cuts an email off", () => {
    expect(htmlBytes(html)).toBeLessThan(20_000);
    expect(htmlBytes(html)).toBeLessThan(SIZE_LIMIT);
    expect(htmlBytes("é")).toBe(2);
  });
  it("is quiet about a complete email and names what is missing from an incomplete one", () => {
    expect(docChecks(doc)).toEqual([]);
    const checks = docChecks(
      normalizeDoc({ subject: "x".repeat(70), banner: { headline: "Hi" }, platform: "other" }),
    ).join(" ");
    expect(checks).toMatch(/over 60 characters/);
    expect(checks).toMatch(/preview text/);
    expect(checks).toMatch(/banner picture/);
    expect(checks).toMatch(/Add a button/);
    expect(checks).toMatch(/unsubscribe tag/);
    expect(docChecks(doc).join(" ")).not.toMatch(/unsubscribe tag/);
  });
});
