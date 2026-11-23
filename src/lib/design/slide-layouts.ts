/**
 * The Tuft the World design system for slides: the palette's colour pairings and a set of
 * layouts that turn plain content (a headline, a price, some photos) into a designed slide.
 *
 * A layout only produces ordinary slide parts (text, framed photos, decoration), so everything
 * it makes stays editable in the slide editor. No DOM access: the app, the tests and the MCP
 * tools share it. Text cannot be measured here, so sizes are fitted from character counts.
 */
import {
  FORMATS,
  luminance,
  newId,
  type Pic,
  type Plate,
  type Slide,
  type SlideFont,
  type SlideFormat,
  type TextAlign,
  type TextLayer,
  type TextRole,
} from "./slide-design";

import { BRANDS, kitFor, schemeFor, type BrandId, type BrandKit, type LayoutId } from "./brands";

export { paceColors, pickLogo, schemeFor, type LayoutId, type Scheme } from "./brands";
/** Tuft the World's palette, kept under its old name. */
export const PALETTE = BRANDS.ttw.palette as Record<
  "charcoal" | "natural" | "royal" | "canary" | "pepper" | "ochre" | "green" | "blush" | "grey",
  string
>;
export type ColorName = keyof typeof PALETTE;
export const COLOR_NAMES = Object.keys(PALETTE) as ColorName[];

export const LAYOUTS: { id: LayoutId; name: string; use: string; photos: number }[] = [
  {
    id: "statement",
    name: "Statement",
    use: "A big headline on colour with the hand-drawn grid. Hooks and single ideas.",
    photos: 0,
  },
  {
    id: "sale",
    name: "Sale",
    use: "An offer: a burst sticker for the discount, a headline and the dates. Optional photo.",
    photos: 1,
  },
  {
    id: "product",
    name: "Product",
    use: "One framed product photo with its name, a price tag and a line about it.",
    photos: 1,
  },
  {
    id: "split",
    name: "Split",
    use: "Photo on the top half, text on a colour block below.",
    photos: 1,
  },
  {
    id: "grid",
    name: "Photo grid",
    use: "Two to four photos together with a headline: a range, a collection, steps.",
    photos: 4,
  },
  { id: "photo", name: "Full photo", use: "One photo edge to edge with text over it.", photos: 1 },
  {
    id: "note",
    name: "Note",
    use: "A tip or a quote, centred, with a handwritten aside.",
    photos: 0,
  },
  {
    id: "closing",
    name: "Closing",
    use: "The last slide: what to do next and the web address on a pill.",
    photos: 0,
  },
  {
    id: "tag",
    name: "Price tag",
    use: "A kraft price tag on the cutting mat: line items with their amounts and a total.",
    photos: 0,
  },
];
export const LAYOUT_IDS = LAYOUTS.map((l) => l.id);
/** The layouts a brand uses, in the order they are offered. */
export const layoutsFor = (brand?: unknown) =>
  kitFor(brand).layouts.map((id) => LAYOUTS.find((l) => l.id === id)!);

export interface SlideContent {
  kicker?: string;
  headline?: string;
  body?: string;
  footer?: string;
  /** A few words for a sticker or price tag: "20% OFF", "$28", "New". */
  badge?: string;
  /** A short handwritten aside, about 20 characters at most. */
  accent?: string;
  photos?: string[];
  /** Palette name or hex. */
  color?: string;
  /** A logo image to place on the closing slide. */
  logo?: string | null;
  /** A built-in brand by id, or a workspace's own kit as the kit itself. */
  brand?: BrandId | BrandKit;
}

// Average character width as a share of the font size, per font, for fitting without measuring.
const CHAR: Record<string, number> = { display: 0.5, body: 0.5, label: 0.62, hand: 0.3, mono: 0.6 };
// The kit in use while a slide is being built: its display and label faces have their own widths.
let fitKit: BrandKit = BRANDS.ttw;
const charOf = (font: string) =>
  font === "display"
    ? fitKit.display.char
    : font === "label"
      ? fitKit.labelChar
      : (CHAR[font] ?? 0.54);

function linesFor(
  text: string,
  font: string,
  size: number,
  widthPct: number,
  upper = false,
): number {
  const perLine = Math.max(
    3,
    Math.floor(
      ((widthPct / 100) * 1080) / (size * charOf(font) * (upper && font !== "display" ? 1.08 : 1)),
    ),
  );
  // Wrap word by word, as the canvas does: a long word that does not fit starts a new line.
  let lines = 0;
  for (const para of text.split("\n")) {
    let used = 0;
    lines += 1;
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const need = used ? used + 1 + word.length : word.length;
      if (need <= perLine) used = need;
      else {
        if (used) lines += 1;
        lines += Math.floor((word.length - 1) / perLine);
        used = ((word.length - 1) % perLine) + 1;
      }
    }
  }
  return lines;
}

/** The largest size from `max` down to `min` at which the text takes no more than `maxLines`. */
function fit(
  text: string,
  font: string,
  widthPct: number,
  max: number,
  min: number,
  maxLines: number,
  upper = false,
): number {
  let size = max;
  while (size > min && linesFor(text, font, size, widthPct, upper) > maxLines) size -= 4;
  return size;
}

interface Block {
  role: TextRole;
  text: string;
  font: SlideFont;
  size: number;
  weight: TextLayer["weight"];
  color: string;
  x: number;
  w: number;
  align?: TextAlign;
  lineHeight?: number;
  uppercase?: boolean;
  plate?: Plate;
  plateColor?: string;
  scribble?: string;
  /** Extra space below, as a percentage of the slide height. */
  gap?: number;
}

class Builder {
  layers: TextLayer[] = [];
  private H: number;
  constructor(
    private slideId: string,
    format: SlideFormat,
  ) {
    this.H = FORMATS[format].h;
  }
  /** Height of a block as a percentage of the slide. */
  height(b: Block): number {
    const lh = b.lineHeight ?? 1.2;
    return (
      ((linesFor(b.text, b.font, b.size, b.w, b.uppercase) * b.size * lh) / this.H) * 100 +
      (b.scribble ? (b.size * 0.3 * 100) / this.H : 0)
    );
  }
  place(b: Block, y: number): number {
    if (!b.text.trim()) return y;
    this.layers.push({
      id: `${this.slideId}-${b.role}`,
      text: b.text.trim(),
      x: b.x,
      y: Math.round(Math.min(96, Math.max(0, y)) * 10) / 10,
      w: b.w,
      size: b.size,
      font: b.font,
      weight: b.weight,
      color: b.color,
      align: b.align ?? "left",
      lineHeight: b.lineHeight ?? 1.2,
      uppercase: b.uppercase ?? false,
      role: b.role,
      ...(b.plate ? { plate: b.plate, plateColor: b.plateColor } : {}),
      ...(b.scribble ? { scribble: b.scribble } : {}),
    });
    return y + this.height(b) + (b.gap ?? 2.5);
  }
  /** Place blocks one under another from `y`, then return where the stack ended. */
  stack(blocks: Block[], y: number): number {
    for (const b of blocks) y = this.place(b, y);
    return y;
  }
  /** Total height of a stack, for centring it. */
  total(blocks: Block[]): number {
    const live = blocks.filter((b) => b.text.trim());
    return live.reduce(
      (sum, b, i) => sum + this.height(b) + (i < live.length - 1 ? (b.gap ?? 2.5) : 0),
      0,
    );
  }
}

const pic = (
  slideId: string,
  n: number,
  url: string,
  x: number,
  y: number,
  w: number,
  h: number,
  radius = 0,
  contain = false,
): Pic => ({
  id: `${slideId}-p${n}`,
  url,
  x,
  y,
  w,
  h,
  radius,
  focusY: 50,
  contain,
});

/** Build a designed slide from content. A layout that needs photos it was not given falls back to one that does not. */
export function buildSlide(
  layout: LayoutId,
  content: SlideContent,
  format: SlideFormat = "4:5",
  id: string = newId("s"),
): Slide {
  const photos = (content.photos ?? []).filter((u) => /^https?:\/\//.test(u));
  let chosen: LayoutId = LAYOUT_IDS.includes(layout) ? layout : "statement";
  if (chosen === "grid" && photos.length < 2) chosen = photos.length ? "product" : "statement";
  if ((chosen === "product" || chosen === "split" || chosen === "photo") && photos.length === 0)
    chosen = "statement";
  const kit = kitFor(content.brand);
  fitKit = kit;
  // A layout the brand does not use becomes its nearest relative.
  if (!kit.layouts.includes(chosen))
    chosen =
      chosen === "sale" || chosen === "tag"
        ? "statement"
        : chosen === "product"
          ? "split"
          : "statement";
  if (chosen === "split" && photos.length === 0) chosen = "statement";

  // The kit itself, not its id: a workspace's own kit borrows a built-in id.
  const c = schemeFor(content.color, kit);
  const D = kit.display;
  const light = kit.palette[kit.light];
  const pop = kit.palette[kit.overPhoto];
  const sized = (n: number) => Math.round(n * D.scale);
  const t = {
    kicker: (content.kicker ?? "").trim(),
    headline: (content.headline ?? "").trim(),
    body: (content.body ?? "").trim(),
    footer: (content.footer ?? "").trim(),
    badge: (content.badge ?? "").trim(),
    accent: (content.accent ?? "").trim(),
  };
  const b = new Builder(id, format);
  const slide: Slide = {
    id,
    bg: c.bg,
    image: null,
    imageDim: 0,
    imageY: 50,
    layers: b.layers,
    pics: [],
    grid: null,
    wave: null,
    layout: chosen,
    ...(kit.id !== "ttw" ? { brand: kit.id } : {}),
  };
  const tall = format === "9:16";
  const M = 8; // side margin, %

  const quiet = c.accent === light || luminance(c.accent) > 0.7 === luminance(c.bg) > 0.7;
  const kicker = (
    color = quiet ? c.ink : c.accent,
    x = M,
    w = 84,
    align: TextAlign = "left",
  ): Block => ({
    role: "kicker",
    text: t.kicker,
    font: "label",
    size: 34,
    weight: 700,
    color,
    x,
    w,
    align,
    uppercase: true,
    gap: 2,
  });
  const headline = (
    w: number,
    max: number,
    min: number,
    lines: number,
    extra: Partial<Block> = {},
  ): Block => ({
    role: "headline",
    text: t.headline,
    font: "display",
    size: fit(t.headline, "display", w, sized(max), sized(min), lines),
    weight: D.weight,
    color: c.ink,
    x: M,
    w,
    lineHeight: D.lineHeight,
    uppercase: D.uppercase,
    gap: 3.5,
    ...extra,
  });
  const body = (w: number, size = 38, extra: Partial<Block> = {}): Block => ({
    role: "body",
    text: t.body,
    font: "body",
    size,
    weight: 400,
    color: c.ink,
    x: M,
    w,
    lineHeight: 1.35,
    gap: 3,
    ...extra,
  });
  const footer = (extra: Partial<Block> = {}): Block => ({
    role: "footer",
    text: t.footer,
    font: "label",
    size: 30,
    weight: 700,
    color: c.ink,
    x: M,
    w: 84,
    uppercase: true,
    ...extra,
  });
  const accent = (extra: Partial<Block> = {}): Block => ({
    role: "accent",
    text: kit.hand ? t.accent : "",
    font: "hand",
    size: 96,
    weight: 400,
    color: quiet ? c.ink : c.accent,
    x: M,
    w: 84,
    lineHeight: 1,
    ...extra,
    ...(kit.hand ? {} : { text: "" }),
  });
  const R = kit.photoRadius;
  const underline = kit.underline ? { scribble: quiet ? c.ink : c.accent } : {};
  const badge = (extra: Partial<Block> = {}): Block => ({
    role: "badge",
    text: t.badge,
    font: "label",
    size: 44,
    weight: 800,
    color: c.onAccent,
    x: M,
    w: 30,
    align: "center",
    uppercase: true,
    lineHeight: 1.05,
    plate: "pill",
    plateColor: c.accent,
    ...extra,
  });

  switch (chosen) {
    case "statement": {
      if (kit.grid) slide.grid = c.ink;
      const stack = [
        kicker(),
        headline(84, 136, 68, 5, { ...underline, gap: kit.underline ? 6.5 : 3.5 }),
        body(80, 40),
        accent(),
      ];
      // Sit the stack a little above centre; long text starts higher.
      const y = Math.max(9, Math.min(26, (84 - b.total(stack)) / 2));
      b.stack(stack, y);
      b.place(footer(), 91);
      break;
    }
    case "sale": {
      // The burst sits top right, turned into a sticker; the headline takes the left.
      const size = fit(t.badge, "label", 24, 64, 34, 2, true);
      b.place(badge({ plate: kit.sticker, size, x: 64, w: 24 }), 12);
      // In the wide banner shape the sticker sits beside the headline, so the headline keeps clear of it.
      const beside = format === "3:2" && !!t.badge;
      const top = [
        kicker(undefined, M, 50),
        headline(beside ? 58 : 84, photos.length ? 104 : 148, 64, photos.length ? 3 : 4),
      ];
      let y = b.stack(top, beside ? 12 : t.badge ? 26 : 12);
      if (photos.length) {
        const h = Math.max(22, 84 - y);
        slide.pics.push(pic(id, 1, photos[0], M, y, 84, h, R));
        if (t.body) b.place(body(84, 34, { size: 34 }), Math.min(88, y + h + 2));
      } else {
        // The banner shape is short: keep the line under the headline clear of the wave.
        if (format === "3:2") y = Math.min(y, 68);
        y = b.place(body(80, 40), y);
        // The handwritten aside only goes in when there is room above the footer.
        if (y < 66) y = b.place(accent(), y + 1);
        if (kit.wave) slide.wave = c.accent;
        b.place(
          footer({ plate: "pill", plateColor: c.ink, color: c.bg, x: M + 2.5, w: 80, size: 38 }),
          Math.min(86, Math.max(81, y + 2)),
        );
        break;
      }
      b.place(
        footer({ plate: "pill", plateColor: c.ink, color: c.bg, x: M + 2.5, w: 80, size: 30 }),
        t.body ? 94 : 90,
      );
      break;
    }
    case "product": {
      const picH = tall ? 52 : format === "1:1" ? 52 : 58;
      slide.pics.push(pic(id, 1, photos[0], M, 7, 84, picH, R));
      // The price tag overlaps the foot of the photo.
      b.place(badge({ x: M + 4, w: 40, align: "left", size: 42 }), 7 + picH - 4.5);
      const y = b.stack([kicker(undefined), headline(84, 80, 48, 2), body(84, 36)], 7 + picH + 4.5);
      b.place(footer(), Math.max(92, Math.min(94, y)));
      break;
    }
    case "split": {
      const picH = tall ? 46 : 50;
      slide.pics.push(pic(id, 1, photos[0], 0, 0, 100, picH, 0));
      if (t.badge)
        b.place(
          badge({
            x: 60,
            w: 30,
            plate: "circle",
            size: fit(t.badge, "label", 22, 48, 30, 2, true),
          }),
          picH - 9,
        );
      b.stack([kicker(), headline(84, 92, 52, 3), body(84, 36), accent({ size: 80 })], picH + 5);
      b.place(footer(), 92);
      break;
    }
    case "grid": {
      const shots = photos.slice(0, 4);
      const top = 7;
      const h = tall ? 50 : 54;
      const gap = 2;
      const gapY = (gap * FORMATS[format].w) / FORMATS[format].h;
      const half = (84 - gap) / 2;
      if (shots.length === 2) {
        shots.forEach((u, i) =>
          slide.pics.push(pic(id, i + 1, u, M + i * (half + gap), top, half, h, R)),
        );
      } else if (shots.length === 3) {
        slide.pics.push(pic(id, 1, shots[0], M, top, half, h, R));
        const hh = (h - gapY) / 2;
        slide.pics.push(pic(id, 2, shots[1], M + half + gap, top, half, hh, R));
        slide.pics.push(pic(id, 3, shots[2], M + half + gap, top + hh + gapY, half, hh, R));
      } else {
        const hh = (h - gapY) / 2;
        shots.forEach((u, i) =>
          slide.pics.push(
            pic(
              id,
              i + 1,
              u,
              M + (i % 2) * (half + gap),
              top + Math.floor(i / 2) * (hh + gapY),
              half,
              hh,
              R,
            ),
          ),
        );
      }
      if (t.badge) b.place(badge({ x: M + 4, w: 40, align: "left", size: 40 }), top + h - 4);
      b.stack([kicker(), headline(84, 80, 48, 2), body(84, 34)], top + h + 5);
      b.place(footer(), 92);
      break;
    }
    case "photo": {
      slide.image = photos[0];
      slide.imageDim = 0.42;
      const ink = light;
      b.place(kicker(pop), 8);
      if (t.badge)
        b.place(
          badge({
            x: 64,
            w: 26,
            plate: "circle",
            plateColor: pop,
            color: kit.palette[kit.dark],
            size: fit(t.badge, "label", 22, 48, 30, 2, true),
          }),
          9,
        );
      const stack = [
        headline(84, 112, 60, 4, { color: ink }),
        body(84, 38, { color: ink }),
        accent({ color: pop, size: 88 }),
      ];
      // Text sits in the lower part of the photo, above the footer.
      b.stack(stack, Math.max(30, 86 - b.total(stack)));
      b.place(footer({ color: ink }), 91);
      break;
    }
    case "note": {
      if (kit.grid) slide.grid = c.ink;
      const centred = { x: 10, w: 80, align: "center" as TextAlign };
      const stack = [
        kit.hand
          ? accent({ ...centred, text: t.accent || t.kicker, size: 104, gap: 3 })
          : kicker(undefined, 10, 80, "center"),
        headline(80, 96, 52, 6, { ...centred, lineHeight: 1.12 }),
        body(76, 36, { x: 12, w: 76, align: "center" }),
      ];
      b.stack(stack, Math.max(10, (88 - b.total(stack)) / 2));
      b.place(footer({ ...centred }), 91);
      break;
    }
    case "tag": {
      // A kraft price tag on the cutting mat. Body lines of "Label: amount" become ruled rows.
      const tagInk = kit.palette[kit.dark];
      slide.grid = c.ink;
      const rows = t.body
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 6);
      const rowSize = 30;
      const perLine = Math.floor((0.72 * 1080) / (rowSize * CHAR.mono));
      const ruled = rows.map((line) => {
        const m = line.match(/^(.*?)[\s.·:]+((?:[$£€]|\d)[^\s]*)$/);
        if (!m) return line.slice(0, perLine);
        const label = m[1].replace(/[\s.·:]+$/, "").slice(0, perLine - m[2].length - 5);
        return `${label} ${".".repeat(Math.max(3, perLine - label.length - m[2].length - 2))} ${m[2]}`;
      });
      const head = headline(72, 84, 52, 2, { x: 14, color: tagInk });
      const lines: Block = {
        role: "body",
        text: ruled.join("\n"),
        font: "mono",
        size: rowSize,
        weight: 400,
        color: tagInk,
        x: 14,
        w: 72,
        lineHeight: 1.7,
        gap: 3,
      };
      const inner = [kicker(tagInk, 14, 72), head, lines];
      const tall2 = b.total(inner) + (t.badge ? 11 : 4);
      const top = Math.max(10, (86 - tall2) / 2 - 2);
      slide.panel = {
        x: M,
        y: top,
        w: 84,
        h: Math.min(84 - top, tall2 + 8),
        color: kit.palette.kraft ?? light,
        radius: 2,
      };
      const y = b.stack(inner, top + 4.5);
      if (t.badge)
        b.place(
          badge({
            x: 46,
            w: 38,
            align: "right",
            size: 52,
            font: "mono",
            weight: 600,
            plate: "pill",
            plateColor: kit.palette.marigold ?? c.accent,
            color: tagInk,
            uppercase: false,
          }),
          y + 1.5,
        );
      b.place(footer(), 92);
      break;
    }
    case "closing": {
      if (kit.wave) slide.wave = c.accent;
      const centred = { x: 10, w: 80, align: "center" as TextAlign };
      const stack = [
        kicker(undefined, 10, 80, "center"),
        headline(80, 112, 60, 4, { ...centred }),
        body(72, 38, { x: 14, w: 72, align: "center", gap: 6 }),
        footer({ ...centred, size: 34, plate: "pill", plateColor: c.accent, color: c.onAccent }),
      ];
      const room = content.logo ? 64 : 84;
      const y = b.stack(stack, Math.max(10, (room - b.total(stack)) / 2));
      if (content.logo && kit.wideLogo)
        slide.pics.push(
          pic(id, 1, content.logo, 22, Math.min(80, Math.max(y + 4, 70)), 56, 9, 0, true),
        );
      else if (content.logo)
        slide.pics.push(
          pic(id, 1, content.logo, 34, Math.min(70, Math.max(y + 3, 62)), 32, 21, 0, true),
        );
      break;
    }
  }
  return slide;
}

/** Read a slide back into plain content, by what each text is for. Texts without a role are guessed from their order. */
export function contentOf(slide: Slide): SlideContent {
  const out: SlideContent = {
    color: slide.bg,
    ...(slide.brand ? { brand: kitFor(slide.brand).id } : {}),
  };
  const loose: string[] = [];
  for (const l of slide.layers) {
    if (l.role && out[l.role] === undefined)
      out[l.role] =
        slide.layout === "tag" && l.role === "body" ? l.text.replace(/ \.{3,} /g, ": ") : l.text;
    else loose.push(l.text);
  }
  for (const text of loose) {
    if (out.headline === undefined) out.headline = text;
    else if (out.body === undefined) out.body = text;
    else if (out.footer === undefined) out.footer = text;
    else out.body = `${out.body}\n${text}`;
  }
  const logo = slide.pics.find((p) => p.contain);
  out.photos = [
    ...(slide.image ? [slide.image] : []),
    ...slide.pics.filter((p) => !p.contain).map((p) => p.url),
  ];
  if (logo) out.logo = logo.url;
  return out;
}

/** Lay an existing slide out again in another layout, keeping its words, photos and colour. */
export function relayout(
  slide: Slide,
  layout: LayoutId,
  format: SlideFormat,
  color?: string,
): Slide {
  return buildSlide(layout, { ...contentOf(slide), ...(color ? { color } : {}) }, format, slide.id);
}

/** Change a slide's colour and carry its text, shapes and decoration over to the colours that go with the new one. */
export function recolor(slide: Slide, color: string, brand: unknown = slide.brand): Slide {
  const from = schemeFor(slide.bg, brand);
  const to = schemeFor(color, brand);
  // Over a full photo the text stays light whatever the colour underneath.
  if (slide.image) return { ...slide, bg: to.bg };
  const swap = (hex: string | undefined | null): string | undefined => {
    if (!hex) return hex ?? undefined;
    if (hex === from.accent) return to.accent;
    if (hex === from.ink) return to.ink;
    if (hex === from.bg) return to.bg;
    if (hex === from.onAccent) return to.onAccent;
    return hex;
  };
  return {
    ...slide,
    bg: to.bg,
    grid: slide.grid ? (swap(slide.grid) ?? null) : null,
    wave: slide.wave ? (swap(slide.wave) ?? null) : null,
    layers: slide.layers.map((l) => {
      const plateColor = l.plate ? swap(l.plateColor) : l.plateColor;
      // Text on a shape follows the shape; other text follows the background.
      const colour = l.plate
        ? l.color === from.bg
          ? to.bg
          : l.color === from.onAccent && l.plateColor === from.accent
            ? to.onAccent
            : swap(l.color)!
        : swap(l.color)!;
      return {
        ...l,
        color: colour,
        ...(l.plate ? { plateColor } : {}),
        ...(l.scribble ? { scribble: swap(l.scribble) } : {}),
      };
    }),
  };
}

/** Add a photo to a slide by laying it out again with a layout that has room for it. */
export function withPhoto(slide: Slide, url: string, format: SlideFormat): Slide {
  const content = contentOf(slide);
  const photos = [...(content.photos ?? []), url].slice(-4);
  const current = slide.layout as LayoutId | undefined;
  const layout: LayoutId =
    photos.length >= 2
      ? "grid"
      : current && ["product", "split", "sale", "photo"].includes(current)
        ? current
        : "split";
  return buildSlide(layout, { ...content, photos }, format, slide.id);
}

/** Take a framed photo off a slide. A slide built from a layout is laid out again without it. */
export function withoutPic(slide: Slide, picId: string, format: SlideFormat): Slide {
  const pics = slide.pics.filter((p) => p.id !== picId);
  if (!slide.layout) return { ...slide, pics };
  const content = contentOf({ ...slide, pics });
  return buildSlide(slide.layout as LayoutId, content, format, slide.id);
}
