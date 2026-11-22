// Templates: an email's structure and look, kept to start other emails from. The owner's own are
// stored in their settings; the starters here are built from each brand's kit, in its colours,
// and need no pictures from anywhere.
//
// Pure: no network, no DOM and no Deno APIs.

import { BRANDS, kitFor, type BrandId } from "./brands";
import { THEMES, type EmailPlatform } from "./email";
import {
  cloneSection,
  defaultGlobalStyles,
  docId,
  newBlock,
  newRow,
  newSection,
  safeUrl,
  type Block,
  type BlockType,
  type EmailDoc,
  type GlobalStyles,
  type Row,
  type Section,
} from "./email-doc";
import { normalizeDoc } from "./email-doc-read";
import { buildSlide, type LayoutId } from "./slide-layouts";

export interface EmailTemplate {
  id: string;
  name: string;
  /** One line on what it is for, shown in the chooser. */
  about: string;
  brand: BrandId;
  globalStyles: GlobalStyles;
  sections: Section[];
}

export const MAX_TEMPLATES = 20;

/** An email as a template: its sections and styles under a name. The subject and the rest stay with the email. */
export function templateFrom(doc: EmailDoc, name: string): EmailTemplate {
  const clean = normalizeDoc(doc);
  return {
    id: docId("t"),
    name: name.trim().slice(0, 60) || clean.title,
    about: "",
    brand: clean.brand,
    globalStyles: clean.globalStyles,
    sections: clean.sections.map((s) => cloneSection(s)),
  };
}

/** A new email from a template, for a platform. The brand's logo is used where the template has none of its own. */
export function docFromTemplate(
  template: EmailTemplate,
  platform: unknown = "shopify",
  opts: { logo?: string | null } = {},
): EmailDoc {
  const logo = template.globalStyles.logo.src || safeUrl(opts.logo);
  return {
    v: 2,
    brand: template.brand,
    platform: (platform === "other" ? "other" : "shopify") as EmailPlatform,
    title: "Untitled email",
    meta: { subject: "", previewText: "" },
    globalStyles: { ...template.globalStyles, logo: { ...template.globalStyles.logo, src: logo } },
    sections: template.sections.map((s) => cloneSection(s)),
  };
}

/** The owner's saved templates as kept in their settings (a JSON list), each checked exactly as an email is. */
export function normalizeTemplates(raw: unknown): EmailTemplate[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: EmailTemplate[] = [];
  for (const item of list.slice(0, MAX_TEMPLATES)) {
    const x = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    if (!Array.isArray(x.sections) || x.sections.length === 0) continue;
    const doc = normalizeDoc({
      v: 2,
      brand: x.brand,
      globalStyles: x.globalStyles,
      sections: x.sections,
    });
    const id = typeof x.id === "string" && /^[a-z0-9-]{1,40}$/i.test(x.id) ? x.id : docId("t");
    out.push({
      id,
      name:
        String(x.name ?? "")
          .trim()
          .slice(0, 60) || "Untitled template",
      about: String(x.about ?? "")
        .trim()
        .slice(0, 160),
      brand: doc.brand,
      globalStyles: doc.globalStyles,
      sections: doc.sections,
    });
  }
  return out;
}

/* ---------- The starters ---------- */

const STARTERS: { key: string; name: string; about: string }[] = [
  {
    key: "announcement",
    name: "Announcement",
    about: "One piece of news, said clearly, with a button.",
  },
  {
    key: "product",
    name: "Product feature",
    about: "A product with its picture, what makes it good, and where to get it.",
  },
  {
    key: "newsletter",
    name: "Newsletter",
    about: "Several short stories, each with its own heading and link.",
  },
  { key: "sale", name: "Sale", about: "An offer, when it ends, and a big button." },
];

/** The four starter templates for a brand. Their ids are fixed, so the same starter is the same thing each time. */
export function builtInTemplates(brand: unknown): EmailTemplate[] {
  const kit = kitFor(brand);
  const t = THEMES[kit.id];
  const g = defaultGlobalStyles(kit.id);
  const block = (type: BlockType, more: Record<string, unknown> = {}) =>
    ({ ...newBlock(type, kit.id), ...more }) as Block;
  const row = (...blocks: Block[]) => newRow("1", blocks);
  const columns = (layout: "2" | "1:2" | "2:1", left: Block[], right: Block[]): Row => {
    const r = newRow(layout, left);
    r.columns[1].blocks = right;
    return r;
  };
  const centred = (
    type: "heading" | "paragraph",
    html: string,
    more: Record<string, unknown> = {},
  ) => block(type, { html, ...more, styles: { ...newBlock(type).styles, align: "center" } });
  const banner = (
    layout: LayoutId,
    words: { kicker?: string; headline: string; body?: string; badge?: string },
    color = t.banner,
  ) =>
    block("banner", {
      alt: [words.kicker, words.headline, words.badge].filter(Boolean).join(". "),
      design: {
        v: 1,
        format: "3:2",
        slides: [buildSlide(layout, { ...words, color, brand: kit.id }, "3:2", "banner")],
      },
    });
  const header = () => newSection("Header", [row(block("logo"))]);
  const footer = () => newSection("Footer", [row(block("social")), row(block("footer"))]);
  // A band in the brand's main colour, with its text in the colour that reads on it.
  const band = (name: string, rows: Row[]): Section => ({
    ...newSection(name, rows),
    styles: {
      ...newSection("x").styles,
      contentBg: t.primary,
      textColor: t.onPrimary,
      linkColor: t.onPrimary,
      padding: { top: 12, right: 0, bottom: 12, left: 0 },
    },
  });
  const story = (title: string) => [
    row(block("heading", { level: 2, html: title })),
    row(
      block("paragraph", {
        html: `A few sentences on this. Say what happened and why it matters to the reader, then <a href="${t.site}">link to the rest</a>.`,
      }),
    ),
    row(block("divider")),
  ];

  const bodies: Record<string, Section[]> = {
    announcement: [
      header(),
      newSection("Body", [
        row(banner("statement", { kicker: "News", headline: "Your announcement" })),
        row(block("heading", { level: 1, html: "Say it in one line" })),
        row(
          block("paragraph", {
            html: "Then say what it means for the reader, in two or three sentences. Keep the most important thing first.",
          }),
        ),
        row(block("button", { label: "Find out more", url: t.site })),
      ]),
      footer(),
    ],
    product: [
      header(),
      newSection("Body", [
        row(centred("heading", "Meet the product", { level: 1 })),
        row(block("image")),
        row(centred("paragraph", "One or two sentences on what it is and who it is for.")),
        columns(
          "2",
          [
            block("heading", { level: 3, html: "What makes it good" }),
            block("paragraph", {
              html: "The detail that matters most to the people who will use it.",
            }),
          ],
          [
            block("heading", { level: 3, html: "How to use it" }),
            block("paragraph", { html: "A tip, or what it goes well with." }),
          ],
        ),
        row(block("button", { label: "See it in the shop", url: t.site })),
      ]),
      footer(),
    ],
    newsletter: [
      newSection("Header", [
        row(block("logo")),
        row(centred("paragraph", "<b>The monthly letter</b>")),
      ]),
      newSection("Body", [
        row(block("heading", { level: 1, html: "This month" })),
        row(
          block("paragraph", {
            html: "A short hello: what this letter covers, in a sentence or two.",
          }),
        ),
        row(block("divider")),
        ...story("The first story"),
        ...story("The second story"),
        ...story("The third story"),
        row(block("button", { label: "Read more on the site", url: t.site })),
      ]),
      footer(),
    ],
    sale: [
      header(),
      newSection("Body", [
        row(
          banner(
            kit.layouts.includes("sale") ? "sale" : "statement",
            { kicker: "This week only", headline: "The sale is on", badge: "20% off" },
            kit.id === "ttw" ? "canary" : t.banner,
          ),
        ),
        row(centred("heading", "20% off everything", { level: 1 })),
        row(
          centred(
            "paragraph",
            "Say what is in the sale and any code needed. Keep it short: the button does the rest.",
          ),
        ),
        row(block("button", { label: "Shop the sale", url: t.site })),
        row(block("spacer", { height: 12 })),
      ]),
      band("Ends", [row(centred("heading", "Ends Sunday at midnight", { level: 3 }))]),
      footer(),
    ],
  };
  return STARTERS.map(({ key, name, about }) => ({
    id: `starter-${kit.id}-${key}`,
    name,
    about,
    brand: kit.id,
    globalStyles: g,
    sections: bodies[key],
  }));
}

export const TEMPLATE_BRANDS = Object.keys(BRANDS) as BrandId[];
