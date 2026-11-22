// An email as a document the owner builds by dragging blocks: sections hold rows, rows hold
// columns, columns hold blocks. This JSON is the only thing saved; the HTML that is pasted into
// Shopify Messaging is made from it each time (see email-doc-html.ts), every change to it goes
// through one reducer (see email-doc-reduce.ts), and saved emails are read by email-doc-read.ts.
//
// Pure: no network, no DOM and no Deno APIs, so the app, the tests and the edge functions share it.

import { kitFor, type BrandId } from "./brands";
import {
  bannerWords,
  THEMES,
  UNSUBSCRIBE_PLACEHOLDER,
  type EmailPlatform,
  type EmailProduct,
} from "./email";
import { luminance, newId, type SlideDesign } from "./slide-design";
import { buildSlide } from "./slide-layouts";

export type RowLayout = "1" | "2" | "3" | "1:2" | "2:1";
/** How a row's width is shared between its columns. */
export const LAYOUT_SHARES: Record<RowLayout, number[]> = {
  "1": [1],
  "2": [1, 1],
  "3": [1, 1, 1],
  "1:2": [1, 2],
  "2:1": [2, 1],
};
export const ROW_LAYOUTS = Object.keys(LAYOUT_SHARES) as RowLayout[];
export const LAYOUT_NAMES: Record<RowLayout, string> = {
  "1": "1 column",
  "2": "2 columns",
  "3": "3 columns",
  "1:2": "Narrow and wide",
  "2:1": "Wide and narrow",
};

/** Width of the email itself, in pixels. Email programs expect about this. */
export const CONTENT_WIDTH = 600;
/** Gmail cuts an email off beyond this many bytes. */
export const SIZE_LIMIT = 102 * 1024;

export type Align = "left" | "center" | "right";
export type Device = "desktop" | "mobile";
export interface Box {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
export const NO_SPACE: Box = { top: 0, right: 0, bottom: 0, left: 0 };
export type BorderStyle = "none" | "solid" | "dashed" | "dotted";
export interface Border {
  style: BorderStyle;
  color: string;
  width: number;
}
export const NO_BORDER: Border = { style: "none", color: "#d9d5d0", width: 1 };
/** Space inside a block's background (padding) and outside it (margin). Either may be left to the email's own. */
export interface Spacing {
  padding?: Box;
  margin?: Box;
}

/**
 * What the owner has changed on one block. Anything absent follows the email's styles.
 * `desktop` is how it is spaced on a computer; `mobile` only counts once `sameForMobile` is off.
 */
export interface BlockStyles {
  background?: string;
  align?: Align;
  color?: string;
  /** Text size, for blocks with words. */
  size?: number;
  sameForMobile: boolean;
  desktop: Spacing;
  mobile?: Spacing & { size?: number };
}
/** A block with no styles of its own. */
export const plainStyles = (): BlockStyles => ({ sameForMobile: true, desktop: {} });
export const isStyled = (styles: BlockStyles) =>
  JSON.stringify(styles) !== JSON.stringify(plainStyles());

/** Typefaces every email program has. Brand typefaces only appear inside the banner picture. */
export const FONTS = {
  arial: { label: "Arial", stack: "Arial, Helvetica, sans-serif" },
  narrow: { label: "Arial Narrow", stack: "'Arial Narrow', Arial, Helvetica, sans-serif" },
  georgia: { label: "Georgia", stack: "Georgia, 'Times New Roman', serif" },
  times: { label: "Times New Roman", stack: "'Times New Roman', Times, serif" },
  verdana: { label: "Verdana", stack: "Verdana, Geneva, sans-serif" },
  trebuchet: { label: "Trebuchet", stack: "'Trebuchet MS', Tahoma, sans-serif" },
  tahoma: { label: "Tahoma", stack: "Tahoma, Verdana, sans-serif" },
  courier: { label: "Courier", stack: "'Courier New', Courier, monospace" },
} as const;
export type FontId = keyof typeof FONTS;
export const FONT_IDS = Object.keys(FONTS) as FontId[];

/** The sizes of a kind of text that can differ between a computer and a phone. `spacing` is the gap left under it. */
export interface TextSizes {
  size: number;
  lineHeight: number;
  spacing: number;
}
export interface TextStyle {
  font: FontId;
  color: string;
  letterSpacing: number;
  align: Align;
  bold: boolean;
  italic: boolean;
  uppercase: boolean;
  sameForMobile: boolean;
  desktop: TextSizes;
  mobile: TextSizes;
}
export type ButtonShape = "square" | "round" | "pill" | "custom";
export type ButtonSize = "small" | "medium" | "large";
/** A button can also fill the width it is given. */
export type ButtonAlign = Align | "full";
export interface ButtonSizes {
  size: ButtonSize;
  align: ButtonAlign;
  padding: Box;
}
export type TextKind = "p" | "h1" | "h2" | "h3";
export const LINE_HEIGHTS = [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2];

/** The look of the whole email. Each block follows these unless it has its own styles. */
export interface GlobalStyles {
  contentBg: string;
  pageBg: string;
  /** A picture behind the whole email, or "". Many email programs ignore it, so the colour always shows through. */
  pageBgImage: string;
  /** Space left and right of the content on a phone. */
  mobilePadding: number;
  text: Record<TextKind, TextStyle>;
  link: { color: string; underline: boolean; bold: boolean };
  button: {
    shape: ButtonShape;
    /** Corner rounding when the shape is "custom". */
    radius: number;
    bg: string;
    color: string;
    border: Border;
    font: FontId;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    letterSpacing: number;
    sameForMobile: boolean;
    desktop: ButtonSizes;
    mobile: ButtonSizes;
  };
  divider: { color: string; thickness: number; style: "solid" | "dashed" | "dotted"; padding: Box };
  image: { radius: number; border: Border; padding: Box };
  /** The email's logo, used by the logo picture in the header. `width` is in pixels. */
  logo: { src: string; width: number; align: Align; link: string };
}

interface Base {
  id: string;
  styles: BlockStyles;
}
export type HeadingBlock = Base & { type: "heading"; level: 1 | 2 | 3; html: string };
export type ParagraphBlock = Base & { type: "paragraph"; html: string };
/** `width` is a percentage of the column. An image with the "logo" role shows the email's logo, as set in its styles. */
export type ImageBlock = Base & {
  type: "image";
  src: string;
  alt: string;
  link: string;
  width: number;
  role?: "logo";
};
export type ButtonBlock = Base & { type: "button"; label: string; url: string };
export type DividerBlock = Base & { type: "divider" };
export type SpacerBlock = Base & { type: "spacer"; height: number };
/** The designed graphic. `design` is what is edited; `image` is the picture made from it ("" until made). */
export type BannerBlock = Base & {
  type: "banner";
  design: SlideDesign;
  image: string;
  alt: string;
  link: string;
};
export type ProductsBlock = Base & { type: "products"; items: EmailProduct[] };
/** The small print every marketing email needs. The unsubscribe link is added when the HTML is made. */
export type FooterBlock = Base & { type: "footer"; site: string; siteLabel: string; why: string };
/** HTML the owner pasted in. It is only ever kept, shown and sent after sanitizeHtml has been over it. */
export type CodeBlock = Base & { type: "code"; html: string };

export const SOCIAL_NETWORKS = {
  instagram: "Instagram",
  tiktok: "TikTok",
  facebook: "Facebook",
  youtube: "YouTube",
  pinterest: "Pinterest",
  x: "X",
  website: "Website",
} as const;
export type SocialNetwork = keyof typeof SOCIAL_NETWORKS;
export interface SocialLink {
  network: SocialNetwork;
  url: string;
}
/** Links to the brand's social accounts, as words: plain links, or each in a rounded outline ("pills"). No icon pictures. */
export type SocialBlock = Base & { type: "social"; links: SocialLink[]; look: "links" | "pills" };
/** A picture with a play mark over it that opens a video. Email cannot play video, so it links to it. */
export type VideoBlock = Base & { type: "video"; url: string; thumbnail: string; alt: string };
/**
 * The brand's logo. `src` and `link` left empty use the ones in the email's styles; `width` is in
 * pixels, with `mobileWidth` used on a phone once the block's "same for mobile" is off.
 */
export type LogoBlock = Base & {
  type: "logo";
  src: string;
  alt: string;
  link: string;
  width: number;
  mobileWidth: number;
};

export type Block =
  | HeadingBlock
  | ParagraphBlock
  | ImageBlock
  | ButtonBlock
  | DividerBlock
  | SpacerBlock
  | BannerBlock
  | ProductsBlock
  | FooterBlock
  | CodeBlock
  | SocialBlock
  | VideoBlock
  | LogoBlock;
export type BlockType = Block["type"];
export const BLOCK_LABELS: Record<BlockType, string> = {
  image: "Image",
  heading: "Heading",
  paragraph: "Paragraph",
  button: "Button",
  divider: "Divider",
  spacer: "Spacer",
  banner: "Banner",
  products: "Products",
  footer: "Footer",
  code: "Code",
  social: "Social",
  video: "Video",
  logo: "Logo",
};

export interface Column {
  id: string;
  blocks: Block[];
}
export interface Row {
  id: string;
  layout: RowLayout;
  columns: Column[];
  stackOnMobile: boolean;
}
/**
 * How one section differs from the rest of the email. `background` and `image` fill the band
 * across the whole width; `contentBg` is the 600 pixel column in the middle.
 */
export interface SectionStyles {
  background?: string;
  image?: string;
  contentBg?: string;
  textColor?: string;
  font?: FontId;
  linkColor?: string;
  padding: Box;
  border: Border;
}
export const plainSectionStyles = (): SectionStyles => ({
  padding: { ...NO_SPACE },
  border: { ...NO_BORDER },
});
export interface Section {
  id: string;
  name: string;
  styles: SectionStyles;
  rows: Row[];
}
/** A section kept to use again in other emails. */
export interface SavedSection {
  id: string;
  name: string;
  section: Section;
}

export interface EmailDoc {
  v: 2;
  brand: BrandId;
  platform: EmailPlatform;
  title: string;
  meta: { subject: string; previewText: string };
  globalStyles: GlobalStyles;
  sections: Section[];
}

export const docId = (prefix = "e") => newId(prefix);

/* ---------- Text made safe ---------- */

const escText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const escapeHtml = escText;

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/y;
const ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]{1,30}|#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6});/y;
const KEPT = new Set(["b", "strong", "i", "em", "u"]);
// Elements whose insides are never words meant for the reader.
const DROPPED_WHOLE = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "noscript",
  "template",
  "svg",
  "math",
  "title",
  "head",
  "textarea",
]);
// Browsers wrap each typed line in one of these; in an email each becomes a line break.
const LINES = new Set(["div", "p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "blockquote"]);
const MAX_INLINE = 6000;

/** A link address that is allowed in an email: a secure web page or an email address. */
export function safeHref(v: unknown): string {
  const s = String(v ?? "")
    .trim()
    .slice(0, 500);
  return /^https:\/\/[^\s"'<>]+$/.test(s) || /^mailto:[^\s"'<>]{3,200}$/.test(s) ? s : "";
}
/** A secure web address, or nothing. Pictures and buttons take only these. */
export function safeUrl(v: unknown): string {
  const s = String(v ?? "")
    .trim()
    .slice(0, 500);
  return /^https:\/\/[^\s"'<>]+$/.test(s) ? s : "";
}

/** The tag Shopify swaps for each reader's own unsubscribe link when it sends. */
export const UNSUBSCRIBE_TAG = "{{ unsubscribe_link }}";
/** What stands for the unsubscribe link in an email for this platform: Shopify's tag, or the marker the owner replaces. */
export const unsubscribeHref = (platform: EmailPlatform) =>
  platform === "shopify" ? UNSUBSCRIBE_TAG : UNSUBSCRIBE_PLACEHOLDER;
const isUnsubscribe = (href: string) =>
  href === UNSUBSCRIBE_TAG || href === UNSUBSCRIBE_PLACEHOLDER;

function hrefIn(attrs: string): string {
  const m = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
  // Only the plain ampersand is decoded, so an address hidden behind other entities never passes.
  const href = m ? (m[1] ?? m[2] ?? m[3] ?? "").replace(/&amp;/gi, "&") : "";
  // Besides web and email addresses, a link in text may be the unsubscribe link, written exactly as the exporter knows it.
  return isUnsubscribe(href.trim()) ? href.trim() : safeHref(href);
}

/**
 * Text with a little formatting, made safe to show and to send. Bold, italic, underline, links to
 * https: or mailto: addresses and line breaks are kept; every other tag is removed, anything that
 * only looks like a tag is shown as the characters typed, and tags left open are closed.
 *
 * It reads the text one piece at a time and writes out only what it recognises, so nothing the
 * browser could run (scripts, event handlers, javascript: addresses) can come through.
 */
export function sanitizeInline(input: unknown): string {
  const s = String(input ?? "").slice(0, MAX_INLINE * 3);
  const out: string[] = [];
  const open: string[] = [];
  let i = 0;
  let wrote = false;
  const close = (name: string) => {
    const at = open.lastIndexOf(name);
    if (at < 0) return;
    while (open.length > at) out.push(`</${open.pop()}>`);
  };
  while (i < s.length) {
    const c = s[i];
    if (c === "<") {
      if (s.startsWith("<!--", i)) {
        const end = s.indexOf("-->", i + 4);
        i = end < 0 ? s.length : end + 3;
        continue;
      }
      TAG.lastIndex = i;
      const m = TAG.exec(s);
      if (!m) {
        out.push("&lt;");
        wrote = true;
        i += 1;
        continue;
      }
      i = TAG.lastIndex;
      const closing = m[1] === "/";
      const name = m[2].toLowerCase();
      if (DROPPED_WHOLE.has(name)) {
        if (!closing) {
          const end = new RegExp(`</${name}\\s*>`, "i").exec(s.slice(i));
          i = end ? i + end.index + end[0].length : s.length;
        }
      } else if (name === "br") {
        if (!closing) out.push("<br>");
      } else if (LINES.has(name)) {
        if (!closing && wrote && out[out.length - 1] !== "<br>") out.push("<br>");
      } else if (name === "a") {
        if (closing) close("a");
        else if (!open.includes("a")) {
          const href = hrefIn(m[3]);
          if (href) {
            out.push(`<a href="${escText(href)}">`);
            open.push("a");
          }
        }
      } else if (KEPT.has(name)) {
        if (closing) close(name);
        else if (open.length < 8) {
          out.push(`<${name}>`);
          open.push(name);
        }
      }
      continue;
    }
    if (c === "&") {
      ENTITY.lastIndex = i;
      const e = ENTITY.exec(s);
      if (e) {
        out.push(e[0]);
        i = ENTITY.lastIndex;
      } else {
        out.push("&amp;");
        i += 1;
      }
      wrote = true;
      continue;
    }
    // Control characters have no place in an email; line ends count as spaces, as they do in HTML.
    const code = c.charCodeAt(0);
    if (code < 32) out.push(c === "\n" || c === "\t" ? " " : "");
    else out.push(c === ">" ? "&gt;" : c === '"' ? "&quot;" : c);
    if (code > 32) wrote = true;
    i += 1;
  }
  while (open.length) out.push(`</${open.pop()}>`);
  // A browser leaves a line break behind in a box that has been emptied.
  while (out.length && (out[out.length - 1] === "<br>" || out[out.length - 1] === " ")) out.pop();
  const html = out.join("").trim();
  return html.length > MAX_INLINE
    ? sanitizeInline(escText(inlineText(html).slice(0, MAX_INLINE)))
    : html;
}

/** The words of formatted text, without the formatting. */
export function inlineText(html: string): string {
  return html
    .replace(/<br>/g, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim();
}

/** Formatted text from how emails were written before the builder: [words](https://address), **bold** and line ends. */
export function inlineFromMarkup(text: string): string {
  const html = escText(text.trim())
    .replace(
      /\[([^\]\n]{1,200})\]\((https:\/\/[^\s)"'<>]{1,500}|mailto:[^\s)"'<>]{3,200})\)/g,
      (_m, words, href) => `<a href="${href}">${words}</a>`,
    )
    .replace(/\*\*([^*\n]{1,300})\*\*/g, "<b>$1</b>")
    .replace(/\n/g, "<br>");
  return sanitizeInline(html);
}

/* ---------- Defaults ---------- */

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/;
/** A colour written as #rgb or #rrggbb, lower case, or the fallback. */
export function hexOr<T extends string | undefined>(v: unknown, fallback: T): string | T {
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  return HEX.test(s) ? s : fallback;
}

export const BUTTON_FONT: Record<ButtonSize, number> = { small: 14, medium: 16, large: 18 };
/** The space inside a button of each size. Choosing a size sets this; it can then be changed by hand. */
export const BUTTON_PADDING: Record<ButtonSize, Box> = {
  small: { top: 10, right: 22, bottom: 10, left: 22 },
  medium: { top: 14, right: 30, bottom: 14, left: 30 },
  large: { top: 18, right: 38, bottom: 18, left: 38 },
};
export const BUTTON_RADIUS: Record<Exclude<ButtonShape, "custom">, number> = {
  square: 0,
  round: 6,
  pill: 999,
};

/** The email's starting look for a brand: its own colours, and the nearest safe typefaces to its own. */
export function defaultGlobalStyles(brand: unknown, logo = ""): GlobalStyles {
  const kit = kitFor(brand);
  const t = THEMES[kit.id];
  const headingFont: FontId = FONT_IDS.find((f) => FONTS[f].stack === t.heading) ?? "georgia";
  const caps = /uppercase/.test(t.headingExtra);
  const sizes = (size: number, lineHeight: number): TextSizes => ({ size, lineHeight, spacing: 0 });
  const heading = (size: number): TextStyle => ({
    font: headingFont,
    color: t.ink,
    letterSpacing: caps ? 0.5 : 0,
    align: "left",
    bold: /font-weight:bold/.test(t.headingExtra),
    italic: false,
    uppercase: caps,
    sameForMobile: true,
    desktop: sizes(size, 1.2),
    mobile: sizes(size, 1.2),
  });
  const button: ButtonSizes = {
    size: "medium",
    align: "center",
    padding: { ...BUTTON_PADDING.medium },
  };
  return {
    contentBg: "#ffffff",
    pageBg: t.paper,
    pageBgImage: "",
    mobilePadding: 16,
    text: {
      p: {
        font: "arial",
        color: t.ink,
        letterSpacing: 0,
        align: "left",
        bold: false,
        italic: false,
        uppercase: false,
        sameForMobile: true,
        desktop: sizes(16, 1.6),
        mobile: sizes(16, 1.6),
      },
      h1: heading(34),
      h2: heading(24),
      h3: heading(19),
    },
    link: { color: t.primary, underline: true, bold: false },
    button: {
      shape: "pill",
      radius: 12,
      bg: t.primary,
      color: t.onPrimary,
      border: { style: "none", color: t.ink, width: 2 },
      font: "arial",
      bold: true,
      italic: false,
      underline: false,
      letterSpacing: 0,
      sameForMobile: true,
      desktop: button,
      mobile: { ...button, padding: { ...button.padding } },
    },
    divider: {
      color: "#d9d5d0",
      thickness: 1,
      style: "solid",
      padding: { top: 16, right: 32, bottom: 16, left: 32 },
    },
    image: {
      radius: 0,
      border: { ...NO_BORDER },
      padding: { top: 12, right: 32, bottom: 12, left: 32 },
    },
    logo: { src: logo, width: kit.wideLogo ? 260 : 96, align: "center", link: t.site },
  };
}

/** A new block of a kind, ready to fill in. */
export function newBlock(type: BlockType, brand: unknown = "ttw"): Block {
  const id = docId("b");
  const kit = kitFor(brand);
  const t = THEMES[kit.id];
  const styles = plainStyles();
  switch (type) {
    case "heading":
      return { id, type, level: 2, html: "", styles };
    case "paragraph":
      return { id, type, html: "", styles };
    case "image":
      return { id, type, src: "", alt: "", link: "", width: 100, styles };
    case "button":
      return { id, type, label: "Shop now", url: "", styles };
    case "divider":
      return { id, type, styles };
    case "spacer":
      return { id, type, height: 24, styles };
    case "banner":
      return {
        id,
        type,
        image: "",
        alt: "Your headline",
        link: t.site,
        styles,
        design: {
          v: 1,
          format: "3:2",
          slides: [
            buildSlide(
              "statement",
              { headline: "Your headline", color: t.banner, brand: kit.id },
              "3:2",
              "banner",
            ),
          ],
        },
      };
    case "products":
      return { id, type, items: [], styles };
    case "code":
      return { id, type, html: "", styles };
    case "social":
      return {
        id,
        type,
        look: "links",
        links: [
          { network: "instagram", url: "" },
          { network: "tiktok", url: "" },
          { network: "facebook", url: "" },
        ],
        styles,
      };
    case "video":
      return { id, type, url: "", thumbnail: "", alt: "", styles };
    case "logo":
      return {
        id,
        type,
        src: "",
        alt: kit.name,
        link: "",
        width: kit.wideLogo ? 260 : 96,
        mobileWidth: kit.wideLogo ? 200 : 80,
        styles,
      };
    default:
      return { id, type: "footer", site: t.site, siteLabel: kit.site, why: t.why, styles };
  }
}

/** A row with empty columns in the given arrangement. */
export function newRow(layout: RowLayout, blocks: Block[] = []): Row {
  return {
    id: docId("r"),
    layout,
    stackOnMobile: true,
    columns: LAYOUT_SHARES[layout].map((_s, i) => ({
      id: docId("c"),
      blocks: i === 0 ? blocks : [],
    })),
  };
}
export const newSection = (name: string, rows: Row[] = []): Section => ({
  id: docId("s"),
  name,
  styles: plainSectionStyles(),
  rows,
});

/** The picture in the header that shows the email's logo. What it shows is set under the email's styles. */
export function logoBlock(brand: unknown): ImageBlock {
  const kit = kitFor(brand);
  return {
    id: docId("b"),
    type: "image",
    role: "logo",
    src: "",
    alt: kit.name,
    link: "",
    width: 100,
    styles: {
      ...plainStyles(),
      desktop: { padding: { top: 22, right: 32, bottom: 18, left: 32 } },
    },
  };
}

/** A copy of a section with every id new, so it can sit in the same email as the one it was copied from. */
export function cloneSection(section: Section, id = docId("s")): Section {
  const copy = JSON.parse(JSON.stringify(section)) as Section;
  return {
    ...copy,
    id,
    rows: copy.rows.map((row) => ({
      ...row,
      id: docId("r"),
      columns: row.columns.map((c) => ({
        id: docId("c"),
        blocks: c.blocks.map((b) => ({ ...b, id: docId("b") })),
      })),
    })),
  };
}

/** What a new email starts as: a header with the logo, a picture, a headline, some text and a button, and the small print. */
export function defaultDoc(
  brand: unknown = "ttw",
  platform: unknown = "shopify",
  opts: { logo?: string | null } = {},
): EmailDoc {
  const kit = kitFor(brand);
  const logo = safeUrl(opts.logo);
  const heading = {
    ...newBlock("heading", kit.id),
    level: 1,
    html: "Your headline",
  } as HeadingBlock;
  const words = {
    ...newBlock("paragraph", kit.id),
    html: "Say what is new, and why it matters to the reader.",
  } as ParagraphBlock;
  return {
    v: 2,
    brand: kit.id,
    platform: platform === "other" ? "other" : "shopify",
    title: "Untitled email",
    meta: { subject: "", previewText: "" },
    globalStyles: defaultGlobalStyles(kit.id, logo),
    sections: [
      newSection("Header", [
        ...(logo ? [newRow("1", [logoBlock(kit.id)])] : []),
        newRow("1", [newBlock("divider", kit.id)]),
      ]),
      newSection("Body", [
        newRow("1", [newBlock("image", kit.id)]),
        newRow("1", [heading]),
        newRow("1", [words]),
        newRow("1", [newBlock("button", kit.id)]),
      ]),
      newSection("Footer", [newRow("1", [newBlock("footer", kit.id)])]),
    ],
  };
}

/* ---------- Finding things ---------- */

export interface Found {
  block: Block;
  section: Section;
  row: Row;
  column: Column;
  s: number;
  r: number;
  c: number;
  b: number;
}

export function findBlock(doc: EmailDoc, id: string): Found | null {
  for (let s = 0; s < doc.sections.length; s++) {
    const section = doc.sections[s];
    for (let r = 0; r < section.rows.length; r++) {
      const row = section.rows[r];
      for (let c = 0; c < row.columns.length; c++) {
        const b = row.columns[c].blocks.findIndex((x) => x.id === id);
        if (b >= 0)
          return {
            block: row.columns[c].blocks[b],
            section,
            row,
            column: row.columns[c],
            s,
            r,
            c,
            b,
          };
      }
    }
  }
  return null;
}

export function findRow(
  doc: EmailDoc,
  id: string,
): { row: Row; section: Section; s: number; r: number } | null {
  for (let s = 0; s < doc.sections.length; s++) {
    const r = doc.sections[s].rows.findIndex((x) => x.id === id);
    if (r >= 0) return { row: doc.sections[s].rows[r], section: doc.sections[s], s, r };
  }
  return null;
}

export const allBlocks = (doc: EmailDoc): Block[] =>
  doc.sections.flatMap((s) => s.rows.flatMap((r) => r.columns.flatMap((c) => c.blocks)));

export const findSection = (doc: EmailDoc, id: string): Section | null =>
  doc.sections.find((s) => s.id === id) ?? null;

/* ---------- How things look, worked out once for the canvas and the HTML ---------- */

/** The space inside a block when the owner has not set any. Columns side by side get less at the sides. */
export function defaultPadding(doc: EmailDoc, block: Block, columns: number): Box {
  const side = columns === 1 ? 32 : 12;
  const box = (top: number, bottom: number, sides = side): Box => ({
    top,
    right: sides,
    bottom,
    left: sides,
  });
  const narrowed = (given: Box): Box =>
    columns === 1
      ? given
      : { ...given, left: Math.min(given.left, side), right: Math.min(given.right, side) };
  switch (block.type) {
    case "heading":
      return box(20, 4);
    case "paragraph":
      return box(8, 8);
    case "image":
      return narrowed(doc.globalStyles.image.padding);
    case "button":
      return box(16, 16);
    case "divider":
      return narrowed(doc.globalStyles.divider.padding);
    case "products":
      return box(12, 0, columns === 1 ? 24 : 8);
    case "footer":
      return box(20, 28);
    case "code":
      return box(8, 8);
    case "social":
      return box(12, 12);
    case "video":
      return box(12, 12);
    case "logo":
      return box(22, 18);
    default:
      return box(0, 0, 0);
  }
}

/**
 * The space in and around a block on a computer or a phone. On a phone the sides tighten to the
 * email's phone padding, unless the block has been given phone spacing of its own.
 */
export function spacingOf(
  doc: EmailDoc,
  block: Block,
  columns: number,
  device: Device,
): { padding: Box; margin: Box } {
  const s = block.styles;
  const padding = s.desktop.padding ?? defaultPadding(doc, block, columns);
  const margin = s.desktop.margin ?? NO_SPACE;
  if (device === "desktop") return { padding, margin };
  const m = doc.globalStyles.mobilePadding;
  const tightened = {
    ...padding,
    left: Math.min(padding.left, m),
    right: Math.min(padding.right, m),
  };
  if (s.sameForMobile) return { padding: tightened, margin };
  return { padding: s.mobile?.padding ?? tightened, margin: s.mobile?.margin ?? margin };
}

/** Width of each column of a row, in pixels, on a computer. */
export const columnWidths = (layout: RowLayout, width = CONTENT_WIDTH): number[] => {
  const shares = LAYOUT_SHARES[layout];
  const total = shares.reduce((a, b) => a + b, 0);
  return shares.map((s) => Math.round((width * s) / total));
};

/** The width left for a section's rows once its own padding and border are taken off. */
export const sectionWidth = (section: Section, width = CONTENT_WIDTH): number => {
  const s = section.styles;
  const border = s.border.style === "none" ? 0 : s.border.width * 2;
  return Math.max(120, width - s.padding.left - s.padding.right - border);
};

export const borderCss = (b: Border) =>
  b.style === "none" || b.width === 0 ? "" : `${b.width}px ${b.style} ${b.color}`;

/** A block's own text size on this device, if it has one. */
const ownSize = (block: Block, device: Device) =>
  (device === "mobile" && !block.styles.sameForMobile ? block.styles.mobile?.size : undefined) ??
  block.styles.size;

export interface TextLook {
  font: string;
  size: number;
  lineHeight: number;
  spacing: number;
  color: string;
  bold: boolean;
  italic: boolean;
  uppercase: boolean;
  letterSpacing: number;
  align: Align;
}

/** The type settings a heading or paragraph ends up with: the email's, then the section's, then the block's own. */
export function textLook(
  doc: EmailDoc,
  block: HeadingBlock | ParagraphBlock,
  section: Section | null = null,
  device: Device = "desktop",
): TextLook {
  const g = doc.globalStyles.text[block.type === "heading" ? (`h${block.level}` as TextKind) : "p"];
  const sizes = device === "mobile" && !g.sameForMobile ? g.mobile : g.desktop;
  return {
    font: FONTS[section?.styles.font ?? g.font].stack,
    size: ownSize(block, device) ?? sizes.size,
    lineHeight: sizes.lineHeight,
    spacing: sizes.spacing,
    color: block.styles.color ?? section?.styles.textColor ?? g.color,
    bold: g.bold,
    italic: g.italic,
    uppercase: g.uppercase,
    letterSpacing: g.letterSpacing,
    align: block.styles.align ?? g.align,
  };
}

export interface ButtonLook {
  radius: number;
  bg: string;
  color: string;
  border: string;
  font: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  letterSpacing: number;
  padding: Box;
  align: ButtonAlign;
}

export function buttonLook(
  doc: EmailDoc,
  block: ButtonBlock,
  device: Device = "desktop",
): ButtonLook {
  const g = doc.globalStyles.button;
  const sizes = device === "mobile" && !g.sameForMobile ? g.mobile : g.desktop;
  return {
    radius: g.shape === "custom" ? g.radius : BUTTON_RADIUS[g.shape],
    bg: g.bg,
    color: block.styles.color ?? g.color,
    border: borderCss(g.border),
    font: FONTS[g.font].stack,
    fontSize: ownSize(block, device) ?? BUTTON_FONT[sizes.size],
    bold: g.bold,
    italic: g.italic,
    underline: g.underline,
    letterSpacing: g.letterSpacing,
    padding: sizes.padding,
    align: block.styles.align ?? sizes.align,
  };
}

export const linkLook = (doc: EmailDoc, section: Section | null = null) => ({
  ...doc.globalStyles.link,
  color: section?.styles.linkColor ?? doc.globalStyles.link.color,
});

/** What an image block shows. The logo picture takes its picture, width (in pixels), link and place from the email's styles. */
export function imageLook(
  doc: EmailDoc,
  block: ImageBlock,
): { src: string; link: string; align: Align; px: number | null; percent: number } {
  const logo = doc.globalStyles.logo;
  if (block.role === "logo")
    return {
      src: logo.src || block.src,
      link: logo.link || block.link,
      align: block.styles.align ?? logo.align,
      px: logo.width,
      percent: 100,
    };
  return {
    src: block.src,
    link: block.link,
    align: block.styles.align ?? "center",
    px: null,
    percent: block.width,
  };
}

/** Where a block sits across its column: its own choice, or what the email's styles say for its kind. */
export function alignOf(doc: EmailDoc, block: Block): Align {
  if (block.styles.align) return block.styles.align;
  if (block.type === "heading" || block.type === "paragraph") return textLook(doc, block).align;
  if (block.type === "image") return imageLook(doc, block).align;
  if (block.type === "logo") return logoLook(doc, block).align;
  if (block.type === "button") {
    const a = doc.globalStyles.button.desktop.align;
    return a === "full" ? "center" : a;
  }
  return "center";
}

/** The first button with somewhere to go, which is where the reader is being sent. */
export const firstButton = (doc: EmailDoc): ButtonBlock | null =>
  allBlocks(doc).find((b): b is ButtonBlock => b.type === "button" && !!b.label && !!b.url) ?? null;

/** A YouTube video's own still picture, worked out from its address alone. "" for any other address: nothing is fetched to find one. */
export function videoThumbnail(url: string): string {
  const m =
    /^https:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?:[?&#/]|$)/.exec(
      url.trim(),
    );
  return m ? `https://img.youtube.com/vi/${m[1]}/hqdefault.jpg` : "";
}

/** What a Logo block shows: its own picture and link, or the email's where it has none. */
export function logoLook(
  doc: EmailDoc,
  block: LogoBlock,
  device: Device = "desktop",
): { src: string; link: string; align: Align; width: number } {
  const g = doc.globalStyles.logo;
  return {
    src: block.src || g.src,
    link: block.link || g.link,
    align: block.styles.align ?? g.align,
    width: device === "mobile" && !block.styles.sameForMobile ? block.mobileWidth : block.width,
  };
}

/** How much one colour stands out from another, from 1 (the same) to 21 (black on white), as the accessibility guidelines measure it. */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) =>
    luminance(hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export { bannerWords };
