// Reading an email from wherever it was kept: the database, the writer, or the builder itself.
// Whatever arrives, a complete and bounded document comes out. Emails saved by earlier versions
// of the builder, and emails written before the builder existed, are brought up to date here
// without losing anything in them.
//
// Pure: no network, no DOM and no Deno APIs.

import { kitFor, type BrandId } from "./brands";
import { mainButton, normalizeEmail, THEMES, type EmailProduct, type EmailSpec } from "./email";
import {
  BUTTON_PADDING,
  CONTENT_WIDTH,
  FONT_IDS,
  SOCIAL_NETWORKS,
  LAYOUT_SHARES,
  ROW_LAYOUTS,
  defaultGlobalStyles,
  docId,
  hexOr,
  inlineFromMarkup,
  logoBlock,
  newBlock,
  newRow,
  newSection,
  plainSectionStyles,
  plainStyles,
  safeHref,
  safeUrl,
  sanitizeInline,
  escapeHtml,
  type Align,
  type BannerBlock,
  type Block,
  type BlockStyles,
  type Border,
  type Box,
  type ButtonAlign,
  type ButtonSize,
  type ButtonSizes,
  type Column,
  type EmailDoc,
  type FontId,
  type GlobalStyles,
  type Row,
  type RowLayout,
  type SavedSection,
  type SocialNetwork,
  type Section,
  type SectionStyles,
  type Spacing,
  type TextSizes,
  type TextStyle,
} from "./email-doc";
import { sanitizeHtml } from "./html-sanitize";
import { normalizeDesign, type SlideDesign } from "./slide-design";
import { buildSlide } from "./slide-layouts";

type Raw = Record<string, unknown>;
const part = (v: unknown): Raw => (v && typeof v === "object" ? (v as Raw) : {});
const has = (r: Raw, key: string) => Object.prototype.hasOwnProperty.call(r, key);
const number = (v: unknown) =>
  typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
const num = (v: unknown, min: number, max: number, fallback: number) => {
  const n = number(v);
  return Number.isFinite(n) ? Math.round(Math.min(max, Math.max(min, n))) : fallback;
};
/** A number kept to one decimal place, for line heights and letter spacing. */
const dec = (v: unknown, min: number, max: number, fallback: number) => {
  const n = number(v);
  return Number.isFinite(n) ? Math.round(Math.min(max, Math.max(min, n)) * 10) / 10 : fallback;
};
const text = (v: unknown, max: number) =>
  String(v ?? "")
    .trim()
    .slice(0, max);
const idOf = (v: unknown, prefix: string) =>
  typeof v === "string" && /^[a-z0-9-]{1,40}$/i.test(v) ? v : docId(prefix);
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const alignOr = <T>(v: unknown, fallback: T): Align | T =>
  v === "left" || v === "center" || v === "right" ? v : fallback;
const fontOr = <T>(v: unknown, fallback: T): FontId | T =>
  FONT_IDS.includes(v as FontId) ? (v as FontId) : fallback;

function boxOf(v: unknown, max = 80): Box | undefined {
  if (!v || typeof v !== "object") return undefined;
  const p = v as Raw;
  return {
    top: num(p.top, 0, max, 0),
    right: num(p.right, 0, max, 0),
    bottom: num(p.bottom, 0, max, 0),
    left: num(p.left, 0, max, 0),
  };
}

function borderOf(v: unknown, fallback: Border): Border {
  const b = part(v);
  const style =
    b.style === "none" || b.style === "solid" || b.style === "dashed" || b.style === "dotted"
      ? b.style
      : fallback.style;
  return {
    style,
    color: hexOr(b.color, fallback.color),
    width: num(b.width, 0, 20, fallback.width),
  };
}

function spacingIn(v: unknown): Spacing {
  const s = part(v);
  const out: Spacing = {};
  const padding = boxOf(s.padding);
  const margin = boxOf(s.margin);
  if (padding) out.padding = padding;
  if (margin) out.margin = margin;
  return out;
}

function stylesOf(raw: unknown): BlockStyles {
  const r = part(raw);
  const out = plainStyles();
  const background = hexOr(r.background, undefined);
  if (background) out.background = background;
  const color = hexOr(r.color, undefined);
  if (color) out.color = color;
  const align = alignOr(r.align, undefined);
  if (align) out.align = align;
  if (r.size !== undefined && r.size !== null) out.size = num(r.size, 10, 72, 16);
  out.sameForMobile = bool(r.sameForMobile, true);
  out.desktop = spacingIn(r.desktop);
  // The first builder kept one padding for both devices, straight on the styles.
  const old = boxOf(r.padding);
  if (old && !out.desktop.padding) out.desktop.padding = old;
  if (r.mobile && typeof r.mobile === "object") {
    const mobile: BlockStyles["mobile"] = spacingIn(r.mobile);
    const size = part(r.mobile).size;
    if (size !== undefined && size !== null) mobile.size = num(size, 10, 72, 16);
    if (Object.keys(mobile).length) out.mobile = mobile;
  }
  return out;
}

const productOf = (p: unknown): EmailProduct => {
  const x = part(p);
  return {
    title: text(x.title, 120),
    price: text(x.price, 30),
    url: safeUrl(x.url),
    image: safeUrl(x.image),
  };
};

function bannerDesignOf(raw: unknown): SlideDesign | null {
  const design = normalizeDesign(raw);
  return design ? { v: 1, format: "3:2", slides: [design.slides[0]] } : null;
}

function blockOf(raw: unknown, brand: BrandId): Block | null {
  const r = part(raw);
  const base = { id: idOf(r.id, "b"), styles: stylesOf(r.styles) };
  const t = THEMES[brand];
  switch (r.type) {
    case "heading":
      return {
        ...base,
        type: "heading",
        level: r.level === 1 || r.level === 3 ? r.level : 2,
        html: sanitizeInline(r.html),
      };
    case "paragraph":
      return { ...base, type: "paragraph", html: sanitizeInline(r.html) };
    case "image":
      return {
        ...base,
        type: "image",
        src: safeUrl(r.src),
        alt: text(r.alt, 200),
        link: safeHref(r.link),
        width: num(r.width, 10, 100, 100),
        ...(r.role === "logo" ? { role: "logo" as const } : {}),
      };
    case "button":
      return { ...base, type: "button", label: text(r.label, 60), url: safeHref(r.url) };
    case "divider":
      return { ...base, type: "divider" };
    case "spacer":
      return { ...base, type: "spacer", height: num(r.height, 4, 200, 24) };
    case "banner": {
      const design = bannerDesignOf(r.design);
      return design
        ? {
            ...base,
            type: "banner",
            design,
            image: safeUrl(r.image),
            alt: text(r.alt, 300),
            link: safeHref(r.link),
          }
        : null;
    }
    case "products":
      return {
        ...base,
        type: "products",
        items: (Array.isArray(r.items) ? r.items : [])
          .slice(0, 8)
          .map(productOf)
          .filter((p) => p.title && p.url && p.image),
      };
    case "code":
      return { ...base, type: "code", html: sanitizeHtml(r.html).html };
    case "social":
      return {
        ...base,
        type: "social",
        look: r.look === "pills" ? "pills" : "links",
        links: (Array.isArray(r.links) ? r.links : [])
          .slice(0, 8)
          .map(part)
          .filter((l) => has(SOCIAL_NETWORKS, String(l.network)))
          .map((l) => ({ network: l.network as SocialNetwork, url: safeUrl(l.url) })),
      };
    case "video":
      return {
        ...base,
        type: "video",
        url: safeUrl(r.url),
        thumbnail: safeUrl(r.thumbnail),
        alt: text(r.alt, 200),
      };
    case "logo": {
      const width = num(r.width, 24, CONTENT_WIDTH, kitFor(brand).wideLogo ? 260 : 96);
      return {
        ...base,
        type: "logo",
        src: safeUrl(r.src),
        alt: text(r.alt, 200),
        link: safeHref(r.link),
        width,
        mobileWidth: num(r.mobileWidth, 24, 375, Math.min(width, 200)),
      };
    }
    case "footer":
      return {
        ...base,
        type: "footer",
        site: safeUrl(r.site) || t.site,
        siteLabel: text(r.siteLabel, 80) || kitFor(brand).site,
        why: text(r.why, 300),
      };
    default:
      return null;
  }
}

function rowOf(raw: unknown, brand: BrandId): Row {
  const r = part(raw);
  const layout: RowLayout = ROW_LAYOUTS.includes(r.layout as RowLayout)
    ? (r.layout as RowLayout)
    : "1";
  const given = Array.isArray(r.columns) ? r.columns : [];
  const columns: Column[] = LAYOUT_SHARES[layout].map((_s, i) => {
    const c = part(given[i]);
    const blocks = (Array.isArray(c.blocks) ? c.blocks : [])
      .slice(0, 40)
      .map((b) => blockOf(b, brand))
      .filter((b): b is Block => b !== null);
    return { id: idOf(c.id, "c"), blocks };
  });
  return { id: idOf(r.id, "r"), layout, stackOnMobile: bool(r.stackOnMobile, true), columns };
}

function sectionStylesOf(raw: unknown): SectionStyles {
  const r = part(raw);
  const out = plainSectionStyles();
  const background = hexOr(r.background, undefined);
  if (background) out.background = background;
  const image = safeUrl(r.image);
  if (image) out.image = image;
  const contentBg = hexOr(r.contentBg, undefined);
  if (contentBg) out.contentBg = contentBg;
  const textColor = hexOr(r.textColor, undefined);
  if (textColor) out.textColor = textColor;
  const font = fontOr(r.font, undefined);
  if (font) out.font = font;
  const linkColor = hexOr(r.linkColor, undefined);
  if (linkColor) out.linkColor = linkColor;
  out.padding = boxOf(r.padding) ?? out.padding;
  out.border = borderOf(r.border, out.border);
  return out;
}

/** One section made complete and bounded, whoever it came from. */
export function sectionOf(raw: unknown, brand: unknown = "ttw"): Section {
  const x = part(raw);
  const kit = kitFor(brand);
  return {
    id: idOf(x.id, "s"),
    name: text(x.name, 40) || "Section",
    styles: sectionStylesOf(x.styles),
    rows: (Array.isArray(x.rows) ? x.rows : []).slice(0, 60).map((row) => rowOf(row, kit.id)),
  };
}

/**
 * The owner's saved sections, as kept in their settings (a JSON list). Anything that is not a
 * section is dropped, and what is left is checked exactly as a section inside an email is.
 */
export function normalizeSavedSections(raw: unknown): SavedSection[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: SavedSection[] = [];
  for (const item of list.slice(0, 40)) {
    const x = part(item);
    if (!x.section || typeof x.section !== "object" || !Array.isArray(part(x.section).rows))
      continue;
    const section = sectionOf(x.section);
    out.push({ id: idOf(x.id, "k"), name: text(x.name, 40) || section.name, section });
  }
  return out;
}

function globalStylesOf(raw: unknown, brand: BrandId): GlobalStyles {
  const d = defaultGlobalStyles(brand);
  const r = part(raw);
  const sizesOf = (v: unknown, f: TextSizes, oldSize?: unknown): TextSizes => {
    const x = part(v);
    return {
      size: num(x.size ?? oldSize, 10, 72, f.size),
      lineHeight: dec(x.lineHeight, 1, 3, f.lineHeight),
      spacing: num(x.spacing, 0, 60, f.spacing),
    };
  };
  const textOf = (v: unknown, f: TextStyle): TextStyle => {
    const x = part(v);
    const uppercase = bool(x.uppercase, f.uppercase);
    // The first builder kept one size, straight on the style, and spaced capitals out by half a pixel.
    const desktop = sizesOf(x.desktop, f.desktop, x.size);
    return {
      font: fontOr(x.font, f.font),
      color: hexOr(x.color, f.color),
      letterSpacing: dec(
        x.letterSpacing,
        0,
        10,
        has(x, "desktop") ? f.letterSpacing : uppercase ? 0.5 : 0,
      ),
      align: alignOr(x.align, f.align),
      bold: bool(x.bold, f.bold),
      italic: bool(x.italic, f.italic),
      uppercase,
      sameForMobile: bool(x.sameForMobile, true),
      desktop,
      mobile: x.mobile ? sizesOf(x.mobile, desktop) : { ...desktop },
    };
  };
  const t = part(r.text);
  const text: GlobalStyles["text"] = {
    p: textOf(t.p, d.text.p),
    h1: textOf(t.h1, d.text.h1),
    h2: textOf(t.h2, d.text.h2),
    h3: textOf(t.h3, d.text.h3),
  };

  const b = part(r.button);
  const sizeOf = (v: unknown, f: ButtonSize): ButtonSize =>
    v === "small" || v === "medium" || v === "large" ? v : f;
  const buttonSizes = (v: unknown, f: ButtonSizes, oldSize?: unknown): ButtonSizes => {
    const x = part(v);
    const size = sizeOf(x.size ?? oldSize, f.size);
    const align: ButtonAlign = x.align === "full" ? "full" : alignOr(x.align, f.align);
    return {
      size,
      align,
      padding:
        boxOf(x.padding) ??
        (has(x, "size") || oldSize !== undefined ? { ...BUTTON_PADDING[size] } : { ...f.padding }),
    };
  };
  const desktop = buttonSizes(b.desktop, d.button.desktop, has(b, "desktop") ? undefined : b.size);
  const divider = part(r.divider);
  const image = part(r.image);
  const logo = part(r.logo);
  return {
    contentBg: hexOr(r.contentBg, d.contentBg),
    pageBg: hexOr(r.pageBg, d.pageBg),
    pageBgImage: safeUrl(r.pageBgImage),
    mobilePadding: num(r.mobilePadding, 0, 40, d.mobilePadding),
    text,
    link: {
      color: hexOr(part(r.link).color, d.link.color),
      underline: bool(part(r.link).underline, d.link.underline),
      bold: bool(part(r.link).bold, d.link.bold),
    },
    button: {
      shape:
        b.shape === "square" || b.shape === "round" || b.shape === "pill" || b.shape === "custom"
          ? b.shape
          : d.button.shape,
      radius: num(b.radius, 0, 60, d.button.radius),
      bg: hexOr(b.bg, d.button.bg),
      color: hexOr(b.color, d.button.color),
      border: borderOf(b.border, d.button.border),
      // Buttons used to take the paragraph's typeface, so an email from then keeps it.
      font: fontOr(b.font, has(b, "desktop") ? d.button.font : text.p.font),
      bold: bool(b.bold, d.button.bold),
      italic: bool(b.italic, d.button.italic),
      underline: bool(b.underline, d.button.underline),
      letterSpacing: dec(b.letterSpacing, 0, 10, d.button.letterSpacing),
      sameForMobile: bool(b.sameForMobile, true),
      desktop,
      mobile: b.mobile
        ? buttonSizes(b.mobile, desktop)
        : { ...desktop, padding: { ...desktop.padding } },
    },
    divider: {
      color: hexOr(divider.color, d.divider.color),
      thickness: num(divider.thickness, 1, 12, d.divider.thickness),
      style: divider.style === "dashed" || divider.style === "dotted" ? divider.style : "solid",
      padding: boxOf(divider.padding) ?? d.divider.padding,
    },
    image: {
      radius: num(image.radius, 0, 60, d.image.radius),
      border: borderOf(image.border, d.image.border),
      padding: boxOf(image.padding) ?? d.image.padding,
    },
    logo: {
      src: safeUrl(logo.src),
      width: num(logo.width, 24, CONTENT_WIDTH, d.logo.width),
      align: alignOr(logo.align, d.logo.align),
      link: safeHref(logo.link) || d.logo.link,
    },
  };
}

/** An email written before the builder (banner on top, a list of blocks under it) as a document. Nothing in it is lost. */
function fromSpec(spec: EmailSpec, opts: { logo?: string | null }): EmailDoc {
  const kit = kitFor(spec.brand);
  const t = THEMES[kit.id];
  const logo = safeUrl(opts.logo);
  const b = spec.banner;
  const design: SlideDesign = spec.bannerDesign ?? {
    v: 1,
    format: "3:2",
    slides: [
      buildSlide(
        b.layout,
        {
          kicker: b.kicker,
          headline: b.headline,
          body: b.body,
          badge: b.layout === "sale" ? b.badge : "",
          color: b.color,
          brand: kit.id,
        },
        "3:2",
        "banner",
      ),
    ],
  };
  const banner: BannerBlock = {
    id: docId("b"),
    type: "banner",
    design,
    image: spec.bannerImage ?? "",
    styles: plainStyles(),
    alt: [b.kicker, b.headline, b.badge].filter(Boolean).join(". "),
    link: mainButton(spec)?.url || t.site,
  };
  const body: Block[] = [banner];
  for (const block of spec.blocks) {
    const base = () => ({ id: docId("b"), styles: plainStyles() });
    switch (block.type) {
      case "text":
        if (block.heading)
          body.push({
            ...base(),
            type: "heading",
            level: 2,
            html: sanitizeInline(escapeHtml(block.heading)),
          });
        if (block.body || !block.heading)
          body.push({ ...base(), type: "paragraph", html: inlineFromMarkup(block.body) });
        break;
      case "note": {
        const html = inlineFromMarkup(block.body);
        body.push({ ...base(), type: "paragraph", html: html ? `<i>${html}</i>` : "" });
        break;
      }
      case "image":
        body.push({
          ...base(),
          type: "image",
          src: block.url,
          alt: block.alt,
          link: block.link,
          width: 100,
        });
        break;
      case "button":
        body.push({ ...base(), type: "button", label: block.label, url: block.url });
        break;
      case "products":
        body.push({ ...base(), type: "products", items: block.items });
        break;
      default:
        body.push({ ...base(), type: "divider" });
    }
  }
  return {
    v: 2,
    brand: kit.id,
    platform: spec.platform,
    title: spec.subject || "Untitled email",
    meta: { subject: spec.subject, previewText: spec.preview },
    globalStyles: defaultGlobalStyles(kit.id, logo),
    sections: [
      newSection("Header", logo ? [newRow("1", [logoBlock(kit.id)])] : []),
      newSection(
        "Body",
        body.map((x) => newRow("1", [x])),
      ),
      newSection("Footer", [newRow("1", [newBlock("footer", kit.id)])]),
    ],
  };
}

/** True for an email kept in the form used before the builder, which `normalizeDoc` converts. */
export const isEarlierForm = (raw: unknown) => part(raw).v !== 2;

/**
 * Accept an email from anywhere (the database, the writer, the builder) and return a complete,
 * bounded document. An email saved before the builder existed is converted, and one saved by
 * the first builder gains the newer settings with the look it had. `opts.logo` is the brand's
 * logo, used where the email has none of its own yet.
 */
export function normalizeDoc(raw: unknown, opts: { logo?: string | null } = {}): EmailDoc {
  const r = part(raw);
  if (isEarlierForm(raw)) return fromSpec(normalizeEmail(raw), opts);
  const kit = kitFor(r.brand);
  const meta = part(r.meta);
  const sections: Section[] = (Array.isArray(r.sections) ? r.sections : [])
    .slice(0, 20)
    .map((s) => sectionOf(s, kit.id));
  const globalStyles = globalStylesOf(r.globalStyles, kit.id);
  if (!has(part(r.globalStyles), "logo")) {
    // The first builder put the logo in the header as an ordinary picture. It becomes the email's logo, looking as it did.
    const first = sections[0]?.rows[0]?.columns[0]?.blocks[0];
    if (
      first?.type === "image" &&
      first.src &&
      first.alt === kit.name &&
      first.link === THEMES[kit.id].site
    ) {
      const sides =
        (first.styles.desktop.padding?.left ?? 32) + (first.styles.desktop.padding?.right ?? 32);
      globalStyles.logo = {
        src: first.src,
        width: Math.max(24, Math.round(((CONTENT_WIDTH - sides) * first.width) / 100)),
        align: first.styles.align ?? "center",
        link: first.link,
      };
      first.role = "logo";
      // Its place now comes from the email's logo settings, where it was just copied to.
      delete first.styles.align;
    }
  }
  if (!globalStyles.logo.src) globalStyles.logo.src = safeUrl(opts.logo);
  return {
    v: 2,
    brand: kit.id,
    platform: r.platform === "other" ? "other" : "shopify",
    title: text(r.title, 120) || "Untitled email",
    meta: { subject: text(meta.subject, 120), previewText: text(meta.previewText, 160) },
    globalStyles,
    // A document always has somewhere to put things.
    sections: sections.length ? sections : [newSection("Body")],
  };
}
