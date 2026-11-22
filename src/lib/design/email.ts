// Marketing emails as the writer returns them: a banner and a short list of blocks. This is the
// form the draft-email function produces and the form emails were saved in before the builder;
// the builder converts it to its own document (see email-doc.ts), which is what is edited and
// turned into HTML.
//
// Pure: no network and no Deno APIs.

import { BRANDS, kitFor, type BrandId } from "./brands";
import { normalizeDesign, type SlideDesign } from "./slide-design";

export interface EmailProduct {
  title: string;
  price: string;
  url: string;
  image: string;
}

/** Where the email will be sent from: it decides how the unsubscribe link is written. */
export type EmailPlatform = "shopify" | "other";
/** What stands in for the unsubscribe link until another platform's own tag is put there. */
export const UNSUBSCRIBE_PLACEHOLDER = "PASTE-YOUR-UNSUBSCRIBE-LINK-HERE";

export interface EmailSpec {
  v: 1;
  brand: BrandId;
  platform: EmailPlatform;
  subject: string;
  /** The line shown after the subject in the inbox. */
  preview: string;
  banner: {
    layout: "statement" | "sale";
    color: string;
    kicker: string;
    headline: string;
    body: string;
    badge: string;
  };
  /**
   * The banner as an editable slide, once the owner has changed it by hand in the slide editor.
   * Null while the banner is still built from the fields above.
   */
  bannerDesign: SlideDesign | null;
  /** Address of the rendered banner picture, once made. */
  bannerImage: string | null;
  /** Everything under the banner, in order. The owner can add, move and remove these. */
  blocks: EmailBlock[];
}

/**
 * One part of an email under its banner.
 * Text may carry links as [words](https://address) and bold as **words**.
 */
export type EmailBlock =
  | { id: string; type: "text"; heading: string; body: string }
  | { id: string; type: "note"; body: string }
  | { id: string; type: "image"; url: string; alt: string; link: string }
  | { id: string; type: "button"; label: string; url: string }
  | { id: string; type: "products"; items: EmailProduct[] }
  | { id: string; type: "divider" };

let blockCounter = 0;
export const blockId = () => `b${Date.now().toString(36)}${(blockCounter++).toString(36)}`;

/** The first button with somewhere to go: the banner picture links to the same place. */
export const mainButton = (spec: Pick<EmailSpec, "blocks">) =>
  spec.blocks.find(
    (b): b is Extract<EmailBlock, { type: "button" }> =>
      b.type === "button" && !!b.label && !!b.url,
  ) ?? null;

const productOf = (p: unknown): EmailProduct => {
  const x = (p ?? {}) as Record<string, unknown>;
  return {
    title: text(x.title, 120),
    price: text(x.price, 30),
    url: web(x.url),
    image: web(x.image),
  };
};
const shown = (p: EmailProduct) => !!(p.title && p.url && p.image);

/** One block made safe and bounded. Blocks being filled in by the owner are kept even when still empty. */
function blockOf(raw: unknown): EmailBlock | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const id = typeof r.id === "string" && /^[a-z0-9-]{1,40}$/i.test(r.id) ? r.id : blockId();
  switch (r.type) {
    case "text":
      return { id, type: "text", heading: text(r.heading, 100), body: text(r.body, 3000) };
    case "note":
      return { id, type: "note", body: text(r.body, 400) };
    case "image":
      return { id, type: "image", url: web(r.url), alt: text(r.alt, 200), link: web(r.link) };
    case "button":
      return { id, type: "button", label: text(r.label, 40), url: web(r.url) };
    case "products":
      return {
        id,
        type: "products",
        items: (Array.isArray(r.items) ? r.items : []).slice(0, 8).map(productOf).filter(shown),
      };
    case "divider":
      return { id, type: "divider" };
    default:
      return null;
  }
}

/** The blocks of an email written as sections, products, a button and a sign-off (how the writer returns it, and how early emails were saved). */
function blocksFromParts(r: Record<string, unknown>): EmailBlock[] {
  const btn = (r.button ?? {}) as Record<string, unknown>;
  const out: EmailBlock[] = [];
  (Array.isArray(r.sections) ? r.sections : []).slice(0, 5).forEach((sec, i) => {
    const x = (sec ?? {}) as Record<string, unknown>;
    const block = {
      id: `s${i + 1}`,
      type: "text" as const,
      heading: text(x.heading, 100),
      body: text(x.body, 3000),
    };
    if (block.heading || block.body) out.push(block);
  });
  const items = (Array.isArray(r.products) ? r.products : [])
    .slice(0, 6)
    .map(productOf)
    .filter(shown);
  if (items.length) out.push({ id: "products", type: "products", items });
  if (text(btn.label, 40) || web(btn.url))
    out.push({ id: "button", type: "button", label: text(btn.label, 40), url: web(btn.url) });
  if (text(r.signoff, 400)) out.push({ id: "signoff", type: "note", body: text(r.signoff, 400) });
  return out;
}

const text = (v: unknown, max: number) =>
  String(v ?? "")
    .trim()
    .slice(0, max);
const web = (v: unknown) => {
  const s = text(v, 500);
  return /^https:\/\/[^\s"'<>]+$/.test(s) ? s : "";
};

/** A hand-edited banner: always one slide in the banner shape. */
function bannerDesignOf(raw: unknown): SlideDesign | null {
  const design = normalizeDesign(raw);
  return design ? { v: 1, format: "3:2", slides: [design.slides[0]] } : null;
}

/** The words on a hand-edited banner, by what each is for, so the picture's description and the plain-text fallback stay true to it. */
export function bannerWords(
  design: SlideDesign,
): Pick<EmailSpec["banner"], "kicker" | "headline" | "body" | "badge"> {
  const layers = design.slides[0]?.layers ?? [];
  const by = (role: string) =>
    layers
      .filter((l) => l.role === role)
      .map((l) => l.text.trim())
      .filter(Boolean)
      .join(" ");
  const loose = layers
    .filter((l) => !l.role)
    .map((l) => l.text.trim())
    .filter(Boolean);
  return {
    kicker: by("kicker").slice(0, 60),
    headline: (by("headline") || loose[0] || "").slice(0, 90),
    body: [by("body"), by("accent"), by("footer"), ...loose.slice(by("headline") ? 0 : 1)]
      .filter(Boolean)
      .join(" ")
      .slice(0, 160),
    badge: by("badge").slice(0, 24),
  };
}

/** Accept an email from anywhere (the writer, the database, the editor) and return a complete, bounded one. */
export function normalizeEmail(raw: unknown): EmailSpec {
  const r = (raw ?? {}) as Record<string, unknown>;
  const b = (r.banner ?? {}) as Record<string, unknown>;
  const kit = kitFor(r.brand);
  const palette = kit.palette;
  return {
    v: 1,
    brand: kit.id,
    platform: r.platform === "other" ? "other" : "shopify",
    subject: text(r.subject, 120),
    preview: text(r.preview, 160),
    banner: {
      layout: b.layout === "sale" && kit.layouts.includes("sale") ? "sale" : "statement",
      color: Object.prototype.hasOwnProperty.call(palette, String(b.color))
        ? String(b.color)
        : THEMES[kit.id].banner,
      kicker: text(b.kicker, 60),
      headline: text(b.headline, 90),
      body: text(b.body, 160),
      badge: text(b.badge, 24),
    },
    bannerDesign: bannerDesignOf(r.bannerDesign),
    bannerImage: web(r.bannerImage) || null,
    blocks: Array.isArray(r.blocks)
      ? r.blocks
          .slice(0, 30)
          .map(blockOf)
          .filter((x): x is EmailBlock => x !== null)
      : blocksFromParts(r),
  };
}

/**
 * How each brand's email looks around the banner. Email programs only have a few typefaces, so
 * each brand gets the nearest safe ones to its own: a serif for Tuft the World and the History,
 * narrow capitals for Price Your Craft.
 */
export interface Theme {
  ink: string;
  paper: string;
  primary: string;
  onPrimary: string;
  accent: string;
  banner: string;
  heading: string;
  headingExtra: string;
  site: string;
  why: string;
}
export const THEMES: Record<BrandId, Theme> = {
  ttw: {
    ink: BRANDS.ttw.palette.charcoal,
    paper: BRANDS.ttw.palette.natural,
    primary: BRANDS.ttw.palette.royal,
    onPrimary: BRANDS.ttw.palette.natural,
    accent: BRANDS.ttw.palette.canary,
    banner: "royal",
    heading: "Georgia, 'Times New Roman', serif",
    headingExtra: "font-weight:normal;",
    site: "https://tufttheworld.com",
    why: "You are getting this because you signed up for news from Tuft the World.",
  },
  pyc: {
    ink: BRANDS.pyc.palette.ink,
    paper: BRANDS.pyc.palette.ground,
    primary: BRANDS.pyc.palette.mat,
    onPrimary: BRANDS.pyc.palette.ground,
    accent: BRANDS.pyc.palette.marigold,
    banner: "mat",
    heading: "'Arial Narrow', Arial, Helvetica, sans-serif",
    headingExtra: "font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;",
    site: "https://www.priceyourcraft.com",
    why: "You are getting this because you signed up for news from Price Your Craft.",
  },
  history: {
    ink: BRANDS.history.palette.board,
    paper: BRANDS.history.palette.stone,
    primary: BRANDS.history.palette.board,
    onPrimary: BRANDS.history.palette.stone,
    accent: BRANDS.history.palette.wheat,
    banner: "board",
    heading: "Georgia, 'Times New Roman', serif",
    headingExtra: "font-weight:bold;",
    site: "https://www.historyoftuftedrugs.com",
    why: "You are getting this because you signed up for news from A History of Tufted Rugs.",
  },
};

/**
 * What a social post says, for turning it into an email: its title, caption, the words on each
 * slide, when it goes out, and how its first slide looks (which the email's banner follows).
 */
export function postBrief(
  post: {
    title: string | null;
    copy: string | null;
    notes: string | null;
    scheduled_at: string | null;
    text_overlay_suggestions: unknown;
  },
  timeZone = "America/New_York",
): { text: string; banner: Partial<EmailSpec["banner"]> } {
  const studio = (post.text_overlay_suggestions ?? {}) as {
    kind?: string;
    design?: {
      slides?: { bg?: string; layout?: string; layers?: { role?: string; text?: string }[] }[];
    } | null;
  };
  const slides = studio.kind === "slide_studio" ? (studio.design?.slides ?? []) : [];
  const said = (s: (typeof slides)[number], role: string) =>
    (s.layers ?? []).find((l) => l.role === role)?.text?.trim() ?? "";
  const slideLines = slides
    .map((s, i) => {
      const parts = (s.layers ?? []).map((l) => (l.text ?? "").trim()).filter(Boolean);
      return parts.length ? `Slide ${i + 1}: ${parts.join(" / ")}` : "";
    })
    .filter(Boolean);
  const when =
    post.scheduled_at && !Number.isNaN(Date.parse(post.scheduled_at))
      ? new Intl.DateTimeFormat("en-US", {
          timeZone,
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
        }).format(new Date(post.scheduled_at))
      : "";
  const first = slides[0];
  const palette = kitFor((first as { brand?: string } | undefined)?.brand).palette;
  const color = first?.bg
    ? Object.keys(palette).find((n) => palette[n] === first.bg!.toLowerCase())
    : undefined;
  const banner: Partial<EmailSpec["banner"]> = first
    ? {
        ...(color ? { color } : {}),
        layout: first.layout === "sale" || said(first, "badge") ? "sale" : "statement",
        kicker: said(first, "kicker"),
        headline: said(first, "headline"),
        badge: said(first, "badge"),
      }
    : {};
  const text = [
    post.title ? `Title: ${post.title.trim()}` : "",
    when ? `The post goes out on ${when}.` : "",
    post.copy ? `Caption:\n${post.copy.trim().slice(0, 2500)}` : "",
    slideLines.length ? `On the slides:\n${slideLines.join("\n").slice(0, 2500)}` : "",
    // The reviewer's notes list what was left out of the post and which products it pictures.
    post.notes && /Not given in the prompt|Pictured from the website/.test(post.notes)
      ? `Notes on the post:\n${post.notes.trim().slice(0, 800)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return { text, banner };
}
