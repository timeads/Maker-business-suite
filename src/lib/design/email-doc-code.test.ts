import { describe, expect, it } from "vitest";
import {
  allBlocks,
  defaultDoc,
  docLinks,
  findBlock,
  localStatus,
  newBlock,
  newRow,
  newSection,
  normalizeDoc,
  reduceDoc,
  renderBlockHtml,
  renderDocHtml,
  type Block,
  type EmailDoc,
} from "./index";

const block = (
  type: Parameters<typeof newBlock>[0],
  id: string,
  more: Record<string, unknown> = {},
) => ({ ...newBlock(type), id, ...more }) as Block;
const doc = (blocks: Block[], platform: "shopify" | "other" = "shopify"): EmailDoc => ({
  ...defaultDoc("ttw", platform),
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
const NASTY =
  '<table width="100%"><tr><td style="color:red;position:fixed" onclick="alert(1)"><a href="javascript:alert(1)">bad</a> <a href="https://tufttheworld.com/ok">good</a><script>alert(2)</script><img src="https://cdn.example.com/a.png" onerror="alert(3)"></td></tr></table>';
const CLEAN =
  '<table width="100%"><tr><td style="color:red"><a>bad</a> <a href="https://tufttheworld.com/ok">good</a><img src="https://cdn.example.com/a.png"></td></tr></table>';

describe("the Code block", () => {
  it("starts empty, and is left out of the email until it has something in it", () => {
    const empty = doc([block("code", "c")]);
    expect(findBlock(empty, "c")?.block).toMatchObject({ type: "code", html: "" });
    expect(renderDocHtml(empty)).not.toContain('width="600"');
    expect(renderBlockHtml(empty, "c")).toEqual({ html: "", phoneCss: "" });
  });
  it("is cleaned when it is edited, so the document never holds what was pasted", () => {
    const edited = reduceDoc(doc([block("code", "c")]), {
      type: "updateBlock",
      id: "c",
      patch: { html: NASTY },
    });
    expect(findBlock(edited, "c")?.block).toMatchObject({ html: CLEAN });
    expect(JSON.stringify(edited)).not.toMatch(/alert|onclick|javascript:|position:fixed|<script/);
    // Text blocks still get their own, stricter cleaning.
    const text = reduceDoc(doc([block("paragraph", "p")]), {
      type: "updateBlock",
      id: "p",
      patch: { html: NASTY },
    });
    expect(findBlock(text, "p")?.block).toMatchObject({
      html: 'bad <a href="https://tufttheworld.com/ok">good</a>',
    });
  });
  it("is cleaned again when a saved email is read", () => {
    const stored = JSON.parse(JSON.stringify(doc([block("code", "c")])));
    stored.sections[0].rows[0].columns[0].blocks[0].html = NASTY;
    expect(allBlocks(normalizeDoc(stored))[0]).toMatchObject({ type: "code", html: CLEAN });
  });
  it("is cleaned again when the email is exported, whatever the document holds", () => {
    // A document put together by hand, skipping the reducer and the reader.
    const forged = doc([{ ...block("code", "c"), html: NASTY } as Block]);
    const html = renderDocHtml(forged);
    expect(html).toContain(
      `<tr><td class="eb-m1" align="left" style="padding:8px 32px 8px 32px;">${CLEAN}</td></tr>`,
    );
    expect(html).not.toMatch(/alert|onclick|onerror|javascript:|position:fixed|<script/);
    expect(renderBlockHtml(forged, "c")).toEqual({
      html: `<tr><td class="eb-m1" align="left" style="padding:8px 32px 8px 32px;">${CLEAN}</td></tr>`,
      phoneCss: ".eb-m1{padding:8px 16px 8px 16px!important;}",
    });
  });
  it("takes the block's own background and spacing like any other block, and reopens exactly", () => {
    const styled = [
      { type: "updateBlock", id: "c", patch: { html: "<p>Hello</p>" } } as const,
      {
        type: "updateBlockStyles",
        id: "c",
        patch: {
          background: "#ffe813",
          desktop: { padding: { top: 1, right: 2, bottom: 3, left: 4 } },
        },
      } as const,
    ].reduce(reduceDoc, doc([block("code", "c")]));
    expect(renderDocHtml(styled)).toContain(
      '<tr><td align="left" style="padding:1px 2px 3px 4px;background:#ffe813;"><p>Hello</p></td></tr>',
    );
    expect(normalizeDoc(JSON.parse(JSON.stringify(styled)))).toEqual(styled);
  });
});

describe("a block's own HTML, for its Code tab", () => {
  const email = doc([
    block("heading", "h", { html: "Title" }),
    block("button", "b", { label: "Go", url: "https://tufttheworld.com/go" }),
    block("button", "nolink", { label: "Later" }),
    block("image", "i"),
  ]);
  it("is exactly the part of the exported email that the block makes", () => {
    const whole = renderDocHtml(email);
    for (const id of ["h", "b"]) {
      const part = renderBlockHtml(email, id);
      expect(part.html.startsWith("<tr><td")).toBe(true);
      expect(part.html.endsWith("</td></tr>")).toBe(true);
      expect(whole).toContain(part.html);
    }
    expect(renderBlockHtml(email, "h").html).toContain(">Title</h2>");
    expect(renderBlockHtml(email, "b").html).toContain('href="https://tufttheworld.com/go"');
  });
  it("carries the phone rules that apply to it", () => {
    expect(renderBlockHtml(email, "h")).toMatchObject({
      phoneCss: ".eb-m1{padding:20px 16px 4px 16px!important;}",
    });
    // Only its own rules, under the names the whole email gives them.
    expect(renderBlockHtml(email, "b").phoneCss).toBe(
      ".eb-m2{padding:16px 16px 16px 16px!important;}",
    );
    const fixed = reduceDoc(email, {
      type: "updateBlockStyles",
      id: "h",
      patch: { desktop: { padding: { top: 0, right: 0, bottom: 0, left: 0 } } },
    });
    expect(renderBlockHtml(fixed, "h").phoneCss).toBe("");
  });
  it("is empty for a block left out of the email, and for one that is not there", () => {
    expect(renderBlockHtml(email, "nolink").html).toBe("");
    expect(renderBlockHtml(email, "i").html).toBe("");
    expect(renderBlockHtml(email, "nope")).toEqual({ html: "", phoneCss: "" });
  });
});

describe("the links in an email", () => {
  const email = (platform: "shopify" | "other" = "shopify") =>
    ({
      ...doc([], platform),
      globalStyles: {
        ...defaultDoc("ttw").globalStyles,
        logo: {
          src: "https://cdn.example.com/logo.png",
          width: 96,
          align: "center" as const,
          link: "https://tufttheworld.com",
        },
      },
      sections: [
        {
          ...newSection("Header", [
            newRow("1", [{ ...block("image", "logo"), role: "logo" } as Block]),
          ]),
          id: "top",
        },
        {
          ...newSection("Body", [
            newRow("1", [
              block("banner", "ban", {
                image: "https://cdn.example.com/b.png",
                link: "https://tufttheworld.com/sale",
              }),
            ]),
            newRow("1", [
              block("heading", "h", {
                html: 'Read <a href="https://tufttheworld.com/a?x=1&amp;y=2">the <b>guide</b></a>',
              }),
            ]),
            newRow("1", [
              block("paragraph", "p", {
                html: 'Write to <a href="mailto:hello@tufttheworld.com">us</a> or see <a href="https://tufttheworld.com/b">this</a>.',
              }),
            ]),
            newRow("1", [
              block("image", "pic", {
                src: "https://cdn.example.com/rug.jpg",
                alt: "A blue rug",
                link: "https://tufttheworld.com/rugs",
              }),
              block("image", "plain", { src: "https://cdn.example.com/x.jpg" }),
              block("image", "nopic", { link: "https://tufttheworld.com/unused" }),
            ]),
            newRow("1", [
              block("button", "b1", {
                label: "Shop the sale",
                url: "https://tufttheworld.com/collections/yarn",
              }),
              block("button", "b2", { label: "Coming soon", url: "" }),
              block("button", "b3", { label: "Old", url: "http://tufttheworld.com/old" }),
            ]),
            newRow("1", [
              block("products", "prod", {
                items: [
                  {
                    title: "Reflect Wool",
                    price: "$18",
                    url: "https://tufttheworld.com/products/wool",
                    image: "https://cdn.example.com/wool.jpg",
                  },
                ],
              }),
            ]),
            newRow("1", [
              block("code", "code", {
                html: '<a href="https://tufttheworld.com/code"><img src="https://cdn.example.com/c.png" alt="x"></a> <a href="tel:+15551234567">Call</a> <a>no address</a>',
              }),
            ]),
            newRow("1", [block("divider", "d"), block("spacer", "s")]),
          ]),
          id: "body",
        },
        { ...newSection("Footer", [newRow("1", [block("footer", "f")])]), id: "foot" },
      ],
    }) as EmailDoc;

  it("are all listed, in reading order, each with the block it is in", () => {
    expect(docLinks(email()).map((l) => [l.blockId, l.label, l.url])).toEqual([
      ["logo", "Logo", "https://tufttheworld.com"],
      ["ban", "Banner", "https://tufttheworld.com/sale"],
      ["h", "Link in text: the guide", "https://tufttheworld.com/a?x=1&y=2"],
      ["p", "Link in text: us", "mailto:hello@tufttheworld.com"],
      ["p", "Link in text: this", "https://tufttheworld.com/b"],
      ["pic", "Picture: A blue rug", "https://tufttheworld.com/rugs"],
      ["b1", "Button: Shop the sale", "https://tufttheworld.com/collections/yarn"],
      ["b2", "Button: Coming soon", ""],
      ["b3", "Button: Old", "http://tufttheworld.com/old"],
      ["prod", "Product: Reflect Wool", "https://tufttheworld.com/products/wool"],
      ["code", "Link in code: picture", "https://tufttheworld.com/code"],
      ["code", "Link in code: Call", "tel:+15551234567"],
      ["f", "Website: tufttheworld.com", "https://tufttheworld.com"],
      ["f", "Unsubscribe", "{{ unsubscribe_link }}"],
    ]);
    expect(docLinks(email())[1]).toMatchObject({ blockType: "banner", sectionName: "Body" });
    expect(docLinks(email("other")).pop()).toMatchObject({
      label: "Unsubscribe",
      url: "PASTE-YOUR-UNSUBSCRIBE-LINK-HERE",
    });
    expect(docLinks(doc([]))).toEqual([]);
  });
  it("can each be judged from the address alone, or marked as needing a look", () => {
    const told = docLinks(email()).map((l) => localStatus(l.url)?.status ?? "fetch");
    expect(told).toEqual([
      "fetch",
      "fetch",
      "fetch",
      "cant-check",
      "fetch",
      "fetch",
      "fetch",
      "empty",
      "not-https",
      "fetch",
      "fetch",
      "cant-check",
      "fetch",
      "cant-check",
    ]);
    expect(localStatus(docLinks(email("other")).pop()!.url)?.status).toBe("placeholder");
  });
  it("show what was typed, even where the email itself would leave it out", () => {
    const typed = reduceDoc(email(), {
      type: "updateBlock",
      id: "b1",
      patch: { url: "javascript:alert(1)" },
    });
    const link = docLinks(typed).find((l) => l.blockId === "b1")!;
    expect(link.url).toBe("javascript:alert(1)");
    expect(localStatus(link.url)?.status).toBe("unsafe");
    expect(renderDocHtml(typed)).not.toContain("javascript:");
  });
});
