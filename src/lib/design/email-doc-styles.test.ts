import { describe, expect, it } from "vitest";
import {
  allBlocks,
  cloneSection,
  defaultDoc,
  defaultGlobalStyles,
  findBlock,
  findRow,
  newBlock,
  newRow,
  newSection,
  normalizeDoc,
  normalizeSavedSections,
  plainSectionStyles,
  plainStyles,
  reduceDoc,
  renderDocHtml,
  spacingOf,
  textLook,
  buttonLook,
  type Block,
  type DocAction,
  type EmailDoc,
  type GlobalStyles,
} from "./index";

const run = (doc: EmailDoc, ...actions: DocAction[]) => actions.reduce(reduceDoc, doc);
const sheet = (html: string) => /<style>([\s\S]*?)<\/style>/.exec(html)![1];
/** The phone rule for the element whose opening tag matches, e.g. the <p> of a paragraph. */
const phoneRule = (html: string, opening: RegExp): string => {
  const name = opening.exec(html)?.[1];
  return name ? (new RegExp(`\\.${name}\\{([^}]*)\\}`).exec(sheet(html))?.[1] ?? "") : "";
};

/** A document exactly as the first builder saved it: one size per text style, one padding per block, no logo, image, section or device settings. */
const phase1 = () => ({
  v: 2,
  brand: "pyc",
  platform: "shopify",
  title: "Spring prices",
  meta: { subject: "Spring prices", previewText: "What changed" },
  globalStyles: {
    contentBg: "#ffffff",
    pageBg: "#f4f6f2",
    mobilePadding: 12,
    text: {
      p: { font: "verdana", size: 15, color: "#213838" },
      h1: { font: "narrow", size: 36, color: "#2f5e4f", bold: true, uppercase: true },
      h2: { font: "narrow", size: 26, color: "#2f5e4f", bold: true, uppercase: true },
      h3: { font: "georgia", size: 18, color: "#213838", bold: false, uppercase: false },
    },
    link: { color: "#c2462b" },
    button: { shape: "round", bg: "#2f5e4f", color: "#f4f6f2", size: "large" },
    divider: { color: "#d9bb8c", thickness: 2 },
  },
  sections: [
    {
      id: "s1",
      name: "Header",
      rows: [
        {
          id: "r1",
          layout: "1",
          columns: [
            {
              id: "c1",
              blocks: [
                {
                  id: "logo",
                  type: "image",
                  src: "https://cdn.example.com/pyc.png",
                  alt: "Price Your Craft",
                  link: "https://www.priceyourcraft.com",
                  width: 48,
                  styles: {
                    align: "center",
                    padding: { top: 22, right: 32, bottom: 18, left: 32 },
                  },
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: "s2",
      name: "Body",
      rows: [
        {
          id: "r2",
          layout: "1",
          columns: [
            {
              id: "c2",
              blocks: [
                {
                  id: "h",
                  type: "heading",
                  level: 1,
                  html: "New <b>prices</b>",
                  styles: { align: "center", color: "#c2462b" },
                },
              ],
            },
          ],
        },
        {
          id: "r3",
          layout: "1:2",
          columns: [
            {
              id: "c3",
              blocks: [
                {
                  id: "img",
                  type: "image",
                  src: "https://cdn.example.com/a.jpg",
                  alt: "A rug",
                  link: "",
                  width: 80,
                  styles: {},
                },
              ],
            },
            {
              id: "c4",
              blocks: [
                {
                  id: "p",
                  type: "paragraph",
                  html: 'Read <a href="https://www.priceyourcraft.com/guide">the guide</a>.',
                  styles: {
                    background: "#d9bb8c",
                    size: 17,
                    padding: { top: 4, right: 40, bottom: 6, left: 40 },
                  },
                },
                {
                  id: "btn",
                  type: "button",
                  label: "See prices",
                  url: "https://www.priceyourcraft.com/prices",
                  styles: {},
                },
              ],
            },
          ],
        },
        {
          id: "r4",
          layout: "1",
          columns: [
            {
              id: "c5",
              blocks: [
                { id: "div", type: "divider", styles: {} },
                { id: "sp", type: "spacer", height: 30, styles: {} },
              ],
            },
          ],
        },
      ],
    },
    {
      id: "s3",
      name: "Footer",
      rows: [
        {
          id: "r5",
          layout: "1",
          columns: [
            {
              id: "c6",
              blocks: [
                {
                  id: "f",
                  type: "footer",
                  site: "https://www.priceyourcraft.com",
                  siteLabel: "priceyourcraft.com",
                  why: "You signed up.",
                  styles: {},
                },
              ],
            },
          ],
        },
      ],
    },
  ],
});

describe("a document saved by the first builder", () => {
  const doc = normalizeDoc(phase1());
  it("keeps every section, row and block, in order, under the same ids", () => {
    expect(doc.sections.map((s) => [s.id, s.name])).toEqual([
      ["s1", "Header"],
      ["s2", "Body"],
      ["s3", "Footer"],
    ]);
    expect(doc.sections.flatMap((s) => s.rows.map((r) => `${r.id}:${r.layout}`))).toEqual([
      "r1:1",
      "r2:1",
      "r3:1:2",
      "r4:1",
      "r5:1",
    ]);
    expect(allBlocks(doc).map((b) => b.id)).toEqual([
      "logo",
      "h",
      "img",
      "p",
      "btn",
      "div",
      "sp",
      "f",
    ]);
    expect(doc).toMatchObject({
      brand: "pyc",
      title: "Spring prices",
      meta: { subject: "Spring prices", previewText: "What changed" },
    });
    expect(findBlock(doc, "h")?.block).toMatchObject({ html: "New <b>prices</b>", level: 1 });
    expect(findBlock(doc, "btn")?.block).toMatchObject({
      label: "See prices",
      url: "https://www.priceyourcraft.com/prices",
    });
  });
  it("turns each single style into the computer's, the same on a phone", () => {
    expect(findBlock(doc, "p")?.block.styles).toEqual({
      background: "#d9bb8c",
      size: 17,
      sameForMobile: true,
      desktop: { padding: { top: 4, right: 40, bottom: 6, left: 40 } },
    });
    expect(findBlock(doc, "h")?.block.styles).toEqual({
      align: "center",
      color: "#c2462b",
      sameForMobile: true,
      desktop: {},
    });
    expect(findBlock(doc, "div")?.block.styles).toEqual(plainStyles());
    expect(doc.globalStyles.text.p).toEqual({
      font: "verdana",
      color: "#213838",
      letterSpacing: 0,
      align: "left",
      bold: false,
      italic: false,
      uppercase: false,
      sameForMobile: true,
      desktop: { size: 15, lineHeight: 1.6, spacing: 0 },
      mobile: { size: 15, lineHeight: 1.6, spacing: 0 },
    });
    expect(doc.globalStyles.text.h1).toMatchObject({
      font: "narrow",
      bold: true,
      uppercase: true,
      letterSpacing: 0.5,
      sameForMobile: true,
      desktop: { size: 36, lineHeight: 1.2 },
      mobile: { size: 36 },
    });
    expect(doc.globalStyles.text.h3).toMatchObject({
      font: "georgia",
      bold: false,
      uppercase: false,
      letterSpacing: 0,
      desktop: { size: 18 },
    });
    expect(doc.globalStyles.button).toMatchObject({
      shape: "round",
      bg: "#2f5e4f",
      color: "#f4f6f2",
      font: "verdana",
      bold: true,
      sameForMobile: true,
      desktop: {
        size: "large",
        align: "center",
        padding: { top: 18, right: 38, bottom: 18, left: 38 },
      },
    });
    expect(doc.globalStyles.button.mobile).toEqual(doc.globalStyles.button.desktop);
    expect(doc.globalStyles).toMatchObject({
      mobilePadding: 12,
      pageBgImage: "",
      link: { color: "#c2462b", underline: true, bold: false },
      divider: { color: "#d9bb8c", thickness: 2, style: "solid" },
      image: { radius: 0, border: { style: "none" } },
    });
    expect(
      doc.sections.every((s) => JSON.stringify(s.styles) === JSON.stringify(plainSectionStyles())),
    ).toBe(true);
    expect(doc.sections.flatMap((s) => s.rows).every((r) => r.stackOnMobile)).toBe(true);
  });
  it("makes the header's logo picture the email's logo, the size it was", () => {
    expect(findBlock(doc, "logo")?.block).toMatchObject({
      type: "image",
      role: "logo",
      styles: {
        sameForMobile: true,
        desktop: { padding: { top: 22, right: 32, bottom: 18, left: 32 } },
      },
    });
    expect(findBlock(doc, "logo")?.block.styles).not.toHaveProperty("align");
    expect(doc.globalStyles.logo).toEqual({
      src: "https://cdn.example.com/pyc.png",
      width: 257,
      align: "center",
      link: "https://www.priceyourcraft.com",
    });
    expect(findBlock(doc, "img")?.block).not.toHaveProperty("role");
  });
  it("looks as it did when it is sent", () => {
    const html = renderDocHtml(doc);
    expect(html).toContain(
      '<img src="https://cdn.example.com/pyc.png" alt="Price Your Craft" width="257"',
    );
    expect(html).toContain(
      "<h1 style=\"margin:0;font-family:'Arial Narrow', Arial, Helvetica, sans-serif;font-size:36px;line-height:1.2;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;color:#c2462b;text-align:center;\">New <b>prices</b></h1>",
    );
    expect(html).toContain(
      'style="padding:4px 40px 6px 40px;background:#d9bb8c;"><p style="margin:0;font-family:Verdana, Geneva, sans-serif;font-size:17px;line-height:1.6;color:#213838;text-align:left;">',
    );
    expect(html).toContain(
      '<a href="https://www.priceyourcraft.com/guide" style="color:#c2462b;text-decoration:underline;">the guide</a>',
    );
    expect(html).toContain(
      'bgcolor="#2f5e4f" style="background:#2f5e4f;border-radius:6px;"><a href="https://www.priceyourcraft.com/prices" style="display:inline-block;padding:18px 38px 18px 38px;font-family:Verdana, Geneva, sans-serif;font-size:18px;line-height:1.2;font-weight:bold;color:#f4f6f2;text-decoration:none;',
    );
    expect(html).toContain("border-top:2px solid #d9bb8c;");
    expect(html).toContain('<td class="eb-col" width="200" valign="top"');
    expect(html).toContain('height="30"');
    // The phone's side padding is the email's 12, as before.
    expect(sheet(html)).toContain("padding:4px 12px 6px 12px!important;");
  });
  it("is steady: reading what was read changes nothing, and the document it gives saves and reopens exactly", () => {
    expect(normalizeDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    expect(normalizeDoc(phase1())).toEqual(doc);
  });
  it("takes the brand's logo for its styles when the email has none in it", () => {
    const bare = phase1();
    bare.sections[0].rows = [];
    expect(
      normalizeDoc(bare, { logo: "https://cdn.example.com/found.png" }).globalStyles.logo,
    ).toMatchObject({ src: "https://cdn.example.com/found.png", width: 260 });
    expect(normalizeDoc(bare).globalStyles.logo.src).toBe("");
    expect(
      normalizeDoc(bare, { logo: "http://insecure.example/x.png" }).globalStyles.logo.src,
    ).toBe("");
  });
});

const para = (id: string, html = "Words"): Block =>
  ({ ...newBlock("paragraph"), id, html }) as Block;
const button = (id: string): Block =>
  ({ ...newBlock("button"), id, label: "Go", url: "https://tufttheworld.com/go" }) as Block;
const base = (
  blocks: Block[] = [
    para("p"),
    { ...newBlock("heading"), id: "h", html: "Title" } as Block,
    button("btn"),
  ],
): EmailDoc => ({
  ...defaultDoc("ttw"),
  sections: [
    {
      ...newSection(
        "Body",
        blocks.map((b) => newRow("1", [b])),
      ),
      id: "body",
    },
  ],
});
const globals = (doc: EmailDoc, patch: Partial<GlobalStyles>): EmailDoc =>
  reduceDoc(doc, { type: "setGlobalStyles", patch });

describe("sizes and spacing that differ on a phone", () => {
  it("writes nothing extra while everything is the same on both", () => {
    const html = renderDocHtml(base());
    expect(sheet(html)).toMatch(
      /^@media \(max-width:600px\)\{\.eb-col\{[^}]*\}(\.eb-m\d+\{padding:[^}]*!important;\})*\}$/,
    );
    expect(sheet(html)).not.toMatch(/font-size|line-height|margin/);
  });
  it("puts a text style's phone size, line height and spacing in the phone rules, each marked important", () => {
    const g = defaultGlobalStyles("ttw");
    const doc = globals(base(), {
      text: {
        ...g.text,
        p: {
          ...g.text.p,
          sameForMobile: false,
          desktop: { size: 18, lineHeight: 1.6, spacing: 10 },
          mobile: { size: 14, lineHeight: 1.4, spacing: 4 },
        },
      },
    });
    const html = renderDocHtml(doc);
    expect(html).toMatch(
      /<p class="eb-m\d+" style="margin:0 0 10px 0;font-family:Arial, Helvetica, sans-serif;font-size:18px;line-height:1.6;/,
    );
    expect(phoneRule(html, /<p class="(eb-m\d+)"/)).toBe(
      "font-size:14px!important;line-height:1.4!important;margin-bottom:4px!important;",
    );
    expect(html).not.toMatch(/<h2 class=/);
    expect(textLook(doc, findBlock(doc, "p")!.block as never, null, "mobile")).toMatchObject({
      size: 14,
      lineHeight: 1.4,
      spacing: 4,
    });
    expect(textLook(doc, findBlock(doc, "p")!.block as never, null, "desktop")).toMatchObject({
      size: 18,
      lineHeight: 1.6,
      spacing: 10,
    });
    // With "same" on again the phone values are kept but not used.
    const same = globals(doc, {
      text: { ...doc.globalStyles.text, p: { ...doc.globalStyles.text.p, sameForMobile: true } },
    });
    expect(renderDocHtml(same)).not.toMatch(/<p class=/);
    expect(same.globalStyles.text.p.mobile.size).toBe(14);
  });
  it("gives a block its own phone padding, margin and text size", () => {
    const doc = run(base(), {
      type: "updateBlockStyles",
      id: "p",
      patch: {
        size: 22,
        sameForMobile: false,
        desktop: {
          padding: { top: 30, right: 40, bottom: 30, left: 40 },
          margin: { top: 0, right: 0, bottom: 20, left: 0 },
        },
        mobile: {
          padding: { top: 5, right: 6, bottom: 7, left: 8 },
          margin: { top: 1, right: 2, bottom: 3, left: 4 },
          size: 13,
        },
      },
    });
    const html = renderDocHtml(doc);
    expect(html).toMatch(
      /<tr><td class="eb-m\d+" style="padding:0px 0px 20px 0px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="eb-m\d+" align="left" style="padding:30px 40px 30px 40px;"><p class="eb-m\d+" style="margin:0;[^"]*font-size:22px;/,
    );
    expect(phoneRule(html, /<tr><td class="(eb-m\d+)" style="padding:0px 0px 20px 0px;">/)).toBe(
      "padding:1px 2px 3px 4px!important;",
    );
    expect(
      phoneRule(html, /<td class="(eb-m\d+)" align="left" style="padding:30px 40px 30px 40px;">/),
    ).toBe("padding:5px 6px 7px 8px!important;");
    expect(phoneRule(html, /<p class="(eb-m\d+)"/)).toBe("font-size:13px!important;");
    expect(spacingOf(doc, findBlock(doc, "p")!.block, 1, "mobile")).toEqual({
      padding: { top: 5, right: 6, bottom: 7, left: 8 },
      margin: { top: 1, right: 2, bottom: 3, left: 4 },
    });
    // Every rule in the sheet is marked important, or the styles written on the elements would win.
    for (const declaration of sheet(html)
      .replace(/^@media[^{]*\{/, "")
      .match(/[a-z-]+:[^;{}]+;/g) ?? [])
      expect(declaration).toMatch(/!important;$/);
  });
  it("tightens the sides to the email's phone padding unless the block says otherwise", () => {
    const doc = globals(base(), { mobilePadding: 10 });
    expect(spacingOf(doc, findBlock(doc, "p")!.block, 1, "mobile").padding).toEqual({
      top: 8,
      right: 10,
      bottom: 8,
      left: 10,
    });
    expect(spacingOf(doc, findBlock(doc, "p")!.block, 1, "desktop").padding).toEqual({
      top: 8,
      right: 32,
      bottom: 8,
      left: 32,
    });
    const own = reduceDoc(doc, {
      type: "updateBlockStyles",
      id: "p",
      patch: { sameForMobile: false },
    });
    // Off, but with nothing set for the phone yet: it starts from what it was.
    expect(spacingOf(own, findBlock(own, "p")!.block, 1, "mobile").padding).toEqual({
      top: 8,
      right: 10,
      bottom: 8,
      left: 10,
    });
  });
  it("sizes, places and pads buttons differently on a phone", () => {
    const g = defaultGlobalStyles("ttw");
    const doc = globals(base(), {
      button: {
        ...g.button,
        sameForMobile: false,
        desktop: {
          size: "small",
          align: "left",
          padding: { top: 10, right: 22, bottom: 10, left: 22 },
        },
        mobile: {
          size: "large",
          align: "full",
          padding: { top: 20, right: 10, bottom: 20, left: 10 },
        },
      },
    });
    const html = renderDocHtml(doc);
    expect(html).toMatch(
      /<table class="eb-m\d+" role="presentation" cellpadding="0" cellspacing="0" border="0" align="left" style="margin:0;">/,
    );
    expect(
      phoneRule(
        html,
        /<table class="(eb-m\d+)" role="presentation" cellpadding="0" cellspacing="0" border="0" align="left"/,
      ),
    ).toBe("width:100%!important;");
    expect(phoneRule(html, /<a class="(eb-m\d+)" href="https:\/\/tufttheworld.com\/go"/)).toBe(
      "display:block!important;padding:20px 10px 20px 10px!important;font-size:18px!important;",
    );
    expect(html).toContain("display:inline-block;padding:10px 22px 10px 22px;");
    expect(buttonLook(doc, findBlock(doc, "btn")!.block as never, "mobile")).toMatchObject({
      align: "full",
      fontSize: 18,
    });
    const full = renderDocHtml(
      globals(base(), { button: { ...g.button, desktop: { ...g.button.desktop, align: "full" } } }),
    );
    expect(full).toContain('border="0" width="100%" style=""><tr>');
    expect(full).toContain("display:block;padding:14px 30px 14px 30px;");
  });
  it("keeps a row's columns side by side on a phone when it is told to", () => {
    const two = (stack: boolean) => {
      const row = { ...newRow("2", [button("a")]), id: "row" };
      row.columns[1].blocks = [button("b")];
      return reduceDoc(
        { ...defaultDoc("ttw"), sections: [{ ...newSection("Body", [row]), id: "body" }] },
        { type: "setRowStack", id: "row", stack },
      );
    };
    expect(renderDocHtml(two(true)).match(/<td class="eb-col"/g)).toHaveLength(2);
    expect(renderDocHtml(two(false))).not.toContain('class="eb-col"');
    expect(renderDocHtml(two(false))).toContain('<td width="300" valign="top"');
    expect(findRow(two(false), "row")?.row.stackOnMobile).toBe(false);
    const off = two(false);
    expect(reduceDoc(off, { type: "setRowStack", id: "row", stack: false })).toBe(off);
    expect(
      normalizeDoc(JSON.parse(JSON.stringify(two(false)))).sections[0].rows[0].stackOnMobile,
    ).toBe(false);
  });
});

describe("each style for the whole email", () => {
  const g = defaultGlobalStyles("ttw");
  it("background: colours, a picture with the colour behind it, and the phone's side padding", () => {
    const html = renderDocHtml(
      globals(base(), {
        contentBg: "#fafafa",
        pageBg: "#101010",
        pageBgImage: "https://cdn.example.com/bg.jpg",
        mobilePadding: 8,
      }),
    );
    expect(html).toContain('<body style="margin:0;padding:0;background:#101010;">');
    expect(html).toContain(
      'bgcolor="#101010" background="https://cdn.example.com/bg.jpg" style="background-color:#101010;background-image:url(\'https://cdn.example.com/bg.jpg\');background-size:cover;background-position:center top;"',
    );
    expect(html).toContain("max-width:600px;background:#fafafa;");
    expect(sheet(html)).toContain("padding:8px 8px 8px 8px!important;");
    expect(renderDocHtml(base())).not.toContain("background-image");
    expect(
      renderDocHtml(globals(base(), { pageBgImage: "http://insecure.example/bg.jpg" })),
    ).not.toContain("insecure.example");
  });
  it("text: font, letter spacing, alignment, bold, italic and colour, each of which a block can override where it has its own", () => {
    const doc = globals(base([para("p"), para("own")]), {
      text: {
        ...g.text,
        p: {
          ...g.text.p,
          font: "georgia",
          letterSpacing: 1.5,
          align: "right",
          bold: true,
          italic: true,
          uppercase: true,
          color: "#0051ff",
          desktop: { size: 20, lineHeight: 2, spacing: 12 },
        },
      },
    });
    const styled = reduceDoc(doc, {
      type: "updateBlockStyles",
      id: "own",
      patch: { align: "center", color: "#ff6229", size: 11 },
    });
    const html = renderDocHtml(styled);
    expect(html).toContain(
      "<p style=\"margin:0 0 12px 0;font-family:Georgia, 'Times New Roman', serif;font-size:20px;line-height:2;font-weight:bold;font-style:italic;text-transform:uppercase;letter-spacing:1.5px;color:#0051ff;text-align:right;\">Words</p>",
    );
    expect(html).toContain(
      'font-size:11px;line-height:2;font-weight:bold;font-style:italic;text-transform:uppercase;letter-spacing:1.5px;color:#ff6229;text-align:center;">Words</p>',
    );
    // Clearing the block's styles brings it back to the email's.
    expect(
      renderDocHtml(reduceDoc(styled, { type: "clearBlockStyles", id: "own" })).match(
        /color:#0051ff;text-align:right;/g,
      ),
    ).toHaveLength(2);
    const headings = renderDocHtml(
      globals(base(), {
        text: { ...g.text, h2: { ...g.text.h2, font: "courier", italic: true, align: "center" } },
      }),
    );
    expect(headings).toContain(
      "<h2 style=\"margin:0;font-family:'Courier New', Courier, monospace;font-size:24px;line-height:1.2;font-weight:normal;font-style:italic;color:#213838;text-align:center;\">Title</h2>",
    );
  });
  it("link: colour, underline and bold", () => {
    const doc = base([para("p", 'See <a href="https://tufttheworld.com/x">this</a>')]);
    expect(renderDocHtml(doc)).toContain(
      '<a href="https://tufttheworld.com/x" style="color:#0051ff;text-decoration:underline;">this</a>',
    );
    expect(
      renderDocHtml(globals(doc, { link: { color: "#ff6229", underline: false, bold: true } })),
    ).toContain(
      '<a href="https://tufttheworld.com/x" style="color:#ff6229;text-decoration:none;font-weight:bold;">this</a>',
    );
  });
  it("button: shape, colours, border, font, bold, italic, underline and letter spacing, with a block's own text colour and size on top", () => {
    const doc = globals(base([button("btn"), button("own")]), {
      button: {
        ...g.button,
        shape: "custom",
        radius: 9,
        bg: "#213838",
        color: "#ffe813",
        border: { style: "dashed", color: "#ff6229", width: 3 },
        font: "trebuchet",
        bold: false,
        italic: true,
        underline: true,
        letterSpacing: 2,
      },
    });
    const html = renderDocHtml(
      reduceDoc(doc, {
        type: "updateBlockStyles",
        id: "own",
        patch: { color: "#ffffff", size: 30, align: "right" },
      }),
    );
    expect(html).toContain(
      '<td align="center" bgcolor="#213838" style="background:#213838;border-radius:9px;border:3px dashed #ff6229;">',
    );
    expect(html).toContain(
      "font-family:'Trebuchet MS', Tahoma, sans-serif;font-size:16px;line-height:1.2;font-weight:normal;font-style:italic;letter-spacing:2px;color:#ffe813;text-decoration:underline;text-align:center;border-radius:9px;\">Go</a>",
    );
    expect(html).toContain('align="right" style="margin:0 0 0 auto;"');
    expect(html).toContain(
      "font-size:30px;line-height:1.2;font-weight:normal;font-style:italic;letter-spacing:2px;color:#ffffff;",
    );
    for (const [shape, radius] of [
      ["square", 0],
      ["round", 6],
      ["pill", 999],
    ] as const)
      expect(
        renderDocHtml(globals(base(), { button: { ...g.button, shape, radius: 40 } })),
      ).toContain(`border-radius:${radius}px;">Go</a>`);
  });
  it("divider: colour, thickness, style and the space around it, which a block can replace", () => {
    const doc = globals(
      base([
        { ...newBlock("divider"), id: "d" },
        { ...newBlock("divider"), id: "own" },
      ]),
      {
        divider: {
          color: "#0051ff",
          thickness: 4,
          style: "dotted",
          padding: { top: 2, right: 50, bottom: 3, left: 50 },
        },
      },
    );
    const html = renderDocHtml(
      reduceDoc(doc, {
        type: "updateBlockStyles",
        id: "own",
        patch: { desktop: { padding: { top: 9, right: 9, bottom: 9, left: 9 } } },
      }),
    );
    expect(html.match(/border-top:4px dotted #0051ff;/g)).toHaveLength(2);
    expect(html).toContain('style="padding:2px 50px 3px 50px;">');
    expect(html).toContain('style="padding:9px 9px 9px 9px;">');
  });
  it("image: corner rounding, border and the space around pictures", () => {
    const image = {
      ...newBlock("image"),
      id: "i",
      src: "https://cdn.example.com/a.jpg",
      alt: "A rug",
    } as Block;
    const doc = globals(base([image]), {
      image: {
        radius: 14,
        border: { style: "solid", color: "#213838", width: 2 },
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
      },
    });
    const html = renderDocHtml(doc);
    expect(html).toContain(
      '<td align="center" style="padding:0px 0px 0px 0px;"><img src="https://cdn.example.com/a.jpg" alt="A rug" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:2px solid #213838;border-radius:14px;margin:0 auto;">',
    );
    expect(renderDocHtml(base([image]))).toContain(
      'width="536" style="display:block;width:100%;max-width:536px;height:auto;border:0;margin:0 auto;">',
    );
    expect(
      renderDocHtml(
        reduceDoc(doc, {
          type: "updateBlockStyles",
          id: "i",
          patch: { desktop: { padding: { top: 5, right: 80, bottom: 5, left: 80 } } },
        }),
      ),
    ).toContain('width="440"');
  });
  it("logo: the picture, its width, place and link, used by the header's logo wherever it is", () => {
    const doc = defaultDoc("ttw", "shopify", { logo: "https://cdn.example.com/logo.png" });
    expect(renderDocHtml(doc)).toContain(
      '<td class="eb-m1" align="center" style="padding:22px 32px 18px 32px;"><a href="https://tufttheworld.com"><img src="https://cdn.example.com/logo.png" alt="Tuft the World" width="96"',
    );
    const changed = globals(doc, {
      logo: {
        src: "https://cdn.example.com/new.png",
        width: 200,
        align: "left",
        link: "https://tufttheworld.com/home",
      },
    });
    const html = renderDocHtml(changed);
    expect(html).toContain(
      'align="left" style="padding:22px 32px 18px 32px;"><a href="https://tufttheworld.com/home"><img src="https://cdn.example.com/new.png" alt="Tuft the World" width="200" style="display:block;width:100%;max-width:200px;height:auto;border:0;margin:0;">',
    );
    expect(html).not.toContain("logo.png");
    // An ordinary picture is not touched by the logo settings.
    expect(
      renderDocHtml(
        globals(
          base([{ ...newBlock("image"), id: "i", src: "https://cdn.example.com/a.jpg" } as Block]),
          { logo: { ...g.logo, src: "https://cdn.example.com/new.png" } },
        ),
      ),
    ).not.toContain("new.png");
  });
});

describe("sections", () => {
  const three = (): EmailDoc => ({
    ...defaultDoc("ttw"),
    sections: [
      { ...newSection("Header", [newRow("1", [para("a")])]), id: "top" },
      {
        ...newSection("Body", [
          { ...newRow("1", [para("b")]), id: "r1" },
          { ...newRow("2", [para("c")]), id: "r2" },
        ]),
        id: "body",
      },
      { ...newSection("Footer", [{ ...newRow("1", [para("d")]), id: "r3" }]), id: "foot" },
    ],
  });
  const names = (doc: EmailDoc) => doc.sections.map((s) => s.name).join(",");
  const order = (doc: EmailDoc) =>
    allBlocks(doc)
      .map((b) => b.id)
      .join("");

  it("are renamed, moved by a step or to any gap, and deleted down to the last one", () => {
    expect(names(reduceDoc(three(), { type: "renameSection", id: "body", name: "Offers" }))).toBe(
      "Header,Offers,Footer",
    );
    expect(names(reduceDoc(three(), { type: "moveSection", id: "foot", by: -1 }))).toBe(
      "Header,Footer,Body",
    );
    expect(names(reduceDoc(three(), { type: "moveSectionTo", id: "foot", index: 0 }))).toBe(
      "Footer,Header,Body",
    );
    expect(names(reduceDoc(three(), { type: "moveSectionTo", id: "top", index: 3 }))).toBe(
      "Body,Footer,Header",
    );
    expect(names(reduceDoc(three(), { type: "moveSectionTo", id: "top", index: 2 }))).toBe(
      "Body,Header,Footer",
    );
    const doc = three();
    // The gaps either side of a section are where it already is.
    for (const index of [1, 2])
      expect(reduceDoc(doc, { type: "moveSectionTo", id: "body", index })).toBe(doc);
    expect(reduceDoc(doc, { type: "moveSectionTo", id: "nope", index: 0 })).toBe(doc);
    expect(names(reduceDoc(doc, { type: "deleteSection", id: "body" }))).toBe("Header,Footer");
    const one = run(
      doc,
      { type: "deleteSection", id: "body" },
      { type: "deleteSection", id: "top" },
    );
    expect(reduceDoc(one, { type: "deleteSection", id: "foot" })).toBe(one);
  });
  it("are duplicated just below, with every id new and the styles carried over", () => {
    const styled = reduceDoc(three(), {
      type: "updateSectionStyles",
      id: "body",
      patch: { background: "#213838", padding: { top: 10, right: 20, bottom: 10, left: 20 } },
    });
    const doc = reduceDoc(styled, { type: "duplicateSection", id: "body", newId: "copy" });
    expect(names(doc)).toBe("Header,Body,Body copy,Footer");
    expect(doc.sections[2]).toMatchObject({
      id: "copy",
      styles: { background: "#213838", padding: { top: 10, right: 20, bottom: 10, left: 20 } },
    });
    expect(doc.sections[2].rows.map((r) => r.layout)).toEqual(["1", "2"]);
    const ids = [
      ...doc.sections.map((s) => s.id),
      ...doc.sections.flatMap((s) => s.rows.map((r) => r.id)),
      ...doc.sections.flatMap((s) => s.rows.flatMap((r) => r.columns.map((c) => c.id))),
      ...allBlocks(doc).map((b) => b.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(allBlocks(doc).filter((b) => b.type === "paragraph" && b.html === "Words")).toHaveLength(
      6,
    );
    expect(reduceDoc(doc, { type: "duplicateSection", id: "body", newId: "copy" })).toBe(doc);
    // Changing the copy leaves the original alone.
    const edited = reduceDoc(doc, {
      type: "updateBlock",
      id: doc.sections[2].rows[0].columns[0].blocks[0].id,
      patch: { html: "Changed" },
    });
    expect(findBlock(edited, "b")?.block).toMatchObject({ html: "Words" });
  });
  it("take a saved section anywhere, as a fresh copy each time", () => {
    const kept = normalizeSavedSections([
      { id: "k1", name: "Offer", section: three().sections[1] },
    ])[0];
    const first = cloneSection(kept.section);
    const second = cloneSection(kept.section);
    const doc = run(
      three(),
      { type: "addSection", section: { ...first, name: kept.name }, index: 1 },
      { type: "addSection", section: { ...second, name: kept.name } },
    );
    expect(names(doc)).toBe("Header,Offer,Body,Footer,Offer");
    const ids = allBlocks(doc).map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(reduceDoc(doc, { type: "addSection", section: { ...first, name: "Again" } })).toBe(doc);
  });
  it("have their own look: band and content backgrounds, text, link, padding and border", () => {
    const doc = reduceDoc(
      {
        ...three(),
        sections: [
          {
            ...newSection("Body", [
              newRow("1", [para("p", 'Read <a href="https://tufttheworld.com/x">this</a>')]),
              newRow("1", [{ ...newBlock("heading"), id: "h", html: "Title" } as Block]),
            ]),
            id: "body",
          },
        ],
      },
      {
        type: "updateSectionStyles",
        id: "body",
        patch: {
          background: "#213838",
          image: "https://cdn.example.com/band.jpg",
          contentBg: "#ffe813",
          textColor: "#0051ff",
          font: "courier",
          linkColor: "#ff6229",
          padding: { top: 10, right: 20, bottom: 30, left: 40 },
          border: { style: "solid", color: "#000000", width: 5 },
        },
      },
    );
    const html = renderDocHtml(doc);
    expect(html).toContain(
      '<tr><td align="center" bgcolor="#213838" background="https://cdn.example.com/band.jpg" style="background-color:#213838;background-image:url(\'https://cdn.example.com/band.jpg\');background-size:cover;background-position:center;">',
    );
    expect(html).toContain("max-width:600px;background:#ffe813;");
    expect(html).toContain(
      '<tr><td style="padding:10px 20px 30px 40px;border:5px solid #000000;">',
    );
    expect(html).toContain(
      "<p style=\"margin:0;font-family:'Courier New', Courier, monospace;font-size:16px;line-height:1.6;color:#0051ff;text-align:left;\">",
    );
    expect(html).toContain("<h2 style=\"margin:0;font-family:'Courier New', Courier, monospace;");
    expect(html).toContain('style="color:#ff6229;text-decoration:underline;">this</a>');
    // A block's own colour still wins over its section's.
    expect(
      renderDocHtml(
        reduceDoc(doc, { type: "updateBlockStyles", id: "p", patch: { color: "#111111" } }),
      ),
    ).toContain("line-height:1.6;color:#111111;");
    const cleared = reduceDoc(doc, { type: "clearSectionStyles", id: "body" });
    expect(cleared.sections[0].styles).toEqual(plainSectionStyles());
    expect(reduceDoc(cleared, { type: "clearSectionStyles", id: "body" })).toBe(cleared);
    expect(renderDocHtml(cleared)).not.toMatch(/band\.jpg|#ffe813|Courier/);
    expect(normalizeDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
    const unset = reduceDoc(doc, {
      type: "updateSectionStyles",
      id: "body",
      patch: { background: undefined, image: undefined },
    });
    expect(unset.sections[0].styles).not.toHaveProperty("background");
    expect(unset.sections[0].styles).toMatchObject({ contentBg: "#ffe813", padding: { left: 40 } });
  });
  it("narrow their columns by their own padding and border", () => {
    const image = { ...newBlock("image"), id: "i", src: "https://cdn.example.com/a.jpg" } as Block;
    const doc = reduceDoc(
      { ...three(), sections: [{ ...newSection("Body", [newRow("1", [image])]), id: "body" }] },
      {
        type: "updateSectionStyles",
        id: "body",
        patch: {
          padding: { top: 0, right: 50, bottom: 0, left: 50 },
          border: { style: "solid", color: "#000000", width: 10 },
        },
      },
    );
    // 600, less 100 of padding, 20 of border and the picture's own 64.
    expect(renderDocHtml(doc)).toContain('width="416"');
  });
  it("move a row to any gap, in its own section or another", () => {
    const rows = (doc: EmailDoc) =>
      doc.sections
        .map((s) =>
          s.rows.map((r) => (r.id.startsWith("r") && r.id.length === 2 ? r.id : "x")).join(""),
        )
        .join("|");
    expect(rows(three())).toBe("x|r1r2|r3");
    expect(
      rows(reduceDoc(three(), { type: "moveRowTo", id: "r2", sectionId: "body", index: 0 })),
    ).toBe("x|r2r1|r3");
    expect(
      rows(reduceDoc(three(), { type: "moveRowTo", id: "r1", sectionId: "body", index: 2 })),
    ).toBe("x|r2r1|r3");
    const across = reduceDoc(three(), { type: "moveRowTo", id: "r2", sectionId: "top", index: 0 });
    expect(rows(across)).toBe("r2x|r1|r3");
    expect(order(across)).toBe("cabd");
    expect(findRow(across, "r2")?.row).toMatchObject({ layout: "2" });
    expect(
      rows(reduceDoc(three(), { type: "moveRowTo", id: "r1", sectionId: "foot", index: 99 })),
    ).toBe("x|r2|r3r1");
    // The last row can leave a section, which is then empty but still there.
    expect(rows(run(three(), { type: "moveRowTo", id: "r3", sectionId: "body", index: 1 }))).toBe(
      "x|r1r3r2|",
    );
    const doc = three();
    for (const index of [0, 1])
      expect(reduceDoc(doc, { type: "moveRowTo", id: "r1", sectionId: "body", index })).toBe(doc);
    expect(reduceDoc(doc, { type: "moveRowTo", id: "r1", sectionId: "nope", index: 0 })).toBe(doc);
    expect(reduceDoc(doc, { type: "moveRowTo", id: "nope", sectionId: "body", index: 0 })).toBe(
      doc,
    );
  });
});

describe("saved sections", () => {
  const good = {
    id: "k1",
    name: "  Offer  ",
    section: {
      id: "s9",
      name: "Body",
      styles: { background: "#213838", contentBg: "red", padding: { top: 500 } },
      rows: [
        {
          layout: "2",
          columns: [
            {
              blocks: [
                { type: "paragraph", html: "Hi<script>alert(1)</script>" },
                { type: "button", label: "Go", url: "javascript:alert(1)" },
                { type: "image", src: "http://insecure.example/a.png" },
                { type: "mystery" },
              ],
            },
          ],
        },
      ],
    },
  };
  it("are checked exactly as a section inside an email is", () => {
    const [saved] = normalizeSavedSections([good]);
    expect(saved).toMatchObject({
      id: "k1",
      name: "Offer",
      section: {
        id: "s9",
        name: "Body",
        styles: {
          background: "#213838",
          padding: { top: 80, right: 0, bottom: 0, left: 0 },
          border: { style: "none" },
        },
      },
    });
    expect(saved.section.styles).not.toHaveProperty("contentBg");
    expect(saved.section.rows[0]).toMatchObject({ layout: "2", stackOnMobile: true });
    expect(saved.section.rows[0].columns).toHaveLength(2);
    expect(saved.section.rows[0].columns[0].blocks).toMatchObject([
      { type: "paragraph", html: "Hi", styles: plainStyles() },
      { type: "button", url: "" },
      { type: "image", src: "" },
    ]);
  });
  it("are read from the text kept in settings, dropping anything that is not a section", () => {
    expect(
      normalizeSavedSections(
        JSON.stringify([
          good,
          null,
          5,
          "x",
          { id: "k2", name: "No section" },
          { id: "k3", section: { name: "No rows" } },
          { section: { name: "Unnamed", rows: [] } },
        ]),
      ).map((s) => s.name),
    ).toEqual(["Offer", "Unnamed"]);
    for (const junk of ["", "not json", "{}", "null", null, undefined, 7, { a: 1 }])
      expect(normalizeSavedSections(junk)).toEqual([]);
    expect(normalizeSavedSections(Array.from({ length: 60 }, () => good))).toHaveLength(40);
  });
  it("store and read back exactly", () => {
    const list = normalizeSavedSections([
      good,
      { name: "Second", section: defaultDoc("history").sections[2] },
    ]);
    expect(normalizeSavedSections(JSON.stringify(list))).toEqual(list);
  });
});
