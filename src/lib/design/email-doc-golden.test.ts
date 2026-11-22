import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  defaultDoc,
  defaultGlobalStyles,
  newBlock,
  newRow,
  newSection,
  normalizeDoc,
  reduceDoc,
  renderDocHtml,
  type Block,
  type DocAction,
  type EmailDoc,
} from "./index";

// The exported HTML of emails that use nothing new must not change by a single byte when the
// builder gains features: these emails are already saved, and some already sent. Each email
// below is fixed, and so is the fingerprint of what it exports to. A fingerprint only changes
// here on purpose, with the reason said in the change that does it.
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const run = (doc: EmailDoc, ...actions: DocAction[]) => actions.reduce(reduceDoc, doc);

/** An email as it was written before the builder. */
const written = {
  brand: "ttw",
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

/** An email as the first builder saved it. */
const firstBuilder = {
  v: 2,
  brand: "pyc",
  platform: "other",
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
};

/** An email using what the second builder added: phone values, section styles, every global style. */
function styled(): EmailDoc {
  const g = defaultGlobalStyles("history");
  const block = (
    type: Parameters<typeof newBlock>[0],
    id: string,
    more: Record<string, unknown> = {},
  ) => ({ ...newBlock(type, "history"), id, ...more }) as Block;
  const two = {
    ...newRow("2:1", [
      block("paragraph", "p", { html: 'Side by <a href="mailto:hello@example.com">side</a>' }),
    ]),
    id: "two",
  };
  two.columns[1].blocks = [
    block("button", "b", { label: "Read on", url: "https://www.historyoftuftedrugs.com/chapters" }),
  ];
  const doc: EmailDoc = {
    ...defaultDoc("history", "shopify", { logo: "https://cdn.example.com/history.png" }),
    title: "Chapter nine",
    meta: { subject: "Chapter nine is out", previewText: "Where the gun came from" },
    sections: [
      {
        ...newSection("Header", [
          newRow("1", [{ ...block("image", "logo"), role: "logo" } as Block]),
        ]),
        id: "top",
      },
      {
        ...newSection("Body", [
          newRow("1", [block("heading", "h", { level: 1, html: "Chapter <i>nine</i>" })]),
          two,
          newRow("1", [
            block("image", "i", {
              src: "https://cdn.example.com/gun.jpg",
              alt: "A tufting gun",
              width: 60,
            }),
          ]),
          newRow("1", [block("divider", "d"), block("spacer", "s", { height: 18 })]),
        ]),
        id: "body",
      },
      { ...newSection("Footer", [newRow("1", [block("footer", "f")])]), id: "foot" },
    ],
  };
  return run(
    doc,
    {
      type: "setGlobalStyles",
      patch: {
        pageBgImage: "https://cdn.example.com/paper.jpg",
        mobilePadding: 10,
        text: {
          ...g.text,
          p: {
            ...g.text.p,
            font: "georgia",
            letterSpacing: 0.5,
            sameForMobile: false,
            mobile: { size: 14, lineHeight: 1.4, spacing: 6 },
          },
          h1: { ...g.text.h1, italic: true, align: "center" },
        },
        link: { color: "#7a2e2a", underline: false, bold: true },
        button: {
          ...g.button,
          shape: "custom",
          radius: 4,
          border: { style: "solid", color: "#1e2421", width: 2 },
          underline: true,
          sameForMobile: false,
          mobile: {
            size: "large",
            align: "full",
            padding: { top: 16, right: 12, bottom: 16, left: 12 },
          },
        },
        divider: {
          color: "#7a2e2a",
          thickness: 2,
          style: "dashed",
          padding: { top: 10, right: 20, bottom: 10, left: 20 },
        },
        image: {
          radius: 8,
          border: { style: "solid", color: "#1e2421", width: 1 },
          padding: { top: 6, right: 16, bottom: 6, left: 16 },
        },
      },
    },
    {
      type: "updateBlockStyles",
      id: "h",
      patch: {
        background: "#e6e9e4",
        sameForMobile: false,
        desktop: {
          padding: { top: 30, right: 30, bottom: 10, left: 30 },
          margin: { top: 0, right: 0, bottom: 12, left: 0 },
        },
        mobile: { size: 22, padding: { top: 12, right: 12, bottom: 6, left: 12 } },
      },
    },
    {
      type: "updateSectionStyles",
      id: "body",
      patch: {
        background: "#1e2421",
        contentBg: "#e6e9e4",
        textColor: "#253b5f",
        font: "times",
        linkColor: "#2f6b52",
        padding: { top: 12, right: 8, bottom: 12, left: 8 },
        border: { style: "solid", color: "#a87a22", width: 3 },
      },
    },
    { type: "setRowStack", id: "two", stack: false },
  );
}

describe("emails that use nothing new export exactly as they did", () => {
  it.each([
    [
      "written before the builder, with a logo",
      () => normalizeDoc(written, { logo: "https://cdn.example.com/logo.png" }),
      "a78957eb091614d8",
    ],
    [
      "written before the builder, no banner picture, another platform",
      () => normalizeDoc({ ...written, platform: "other", bannerImage: null }),
      "d687065272e7de8a",
    ],
    ["saved by the first builder", () => normalizeDoc(firstBuilder), "056b2fbbd205e039"],
    [
      "the starting email of each brand",
      () =>
        (["ttw", "pyc", "history"] as const).map((b) =>
          defaultDoc(b, "shopify", { logo: `https://cdn.example.com/${b}.png` }),
        ),
      "58d3ab7ab93851b0",
    ],
    ["styled with everything the second builder added", styled, "150789bd5d466c94"],
  ] as const)("%s", (_name, make, fingerprint) => {
    const made = make();
    const html = (Array.isArray(made) ? made : [made]).map((doc) => renderDocHtml(doc)).join("\n");
    expect(sha(html)).toBe(fingerprint);
  });
});
