/**
 * Slide designs: carousel slides stored as editable layers instead of flat images.
 *
 * This module has no dependencies and no DOM access at import time, so the browser editor,
 * the canvas renderer and the MCP tools (bundled into the edge function) all share it.
 *
 * Storage: the whole "studio" record lives in posts.text_overlay_suggestions (jsonb). It holds
 * the current design, the version Claude first proposed (so later edits can be compared), and
 * which rendered images belong to the design.
 */

export type SlideFormat = "4:5" | "1:1" | "9:16" | "3:2";
export type SlideFont = "display" | "body" | "label" | "hand" | "ui" | "read" | "serif" | "mono";
export type TextAlign = "left" | "center" | "right";
export type TextRole = "kicker" | "headline" | "body" | "footer" | "badge" | "accent";
/** A filled shape drawn behind a text block: a price pill, a sale burst, a round sticker. */
export type Plate = "none" | "pill" | "burst" | "circle";

const FONTS: readonly SlideFont[] = [
  "display",
  "body",
  "label",
  "hand",
  "ui",
  "read",
  "serif",
  "mono",
];
const ROLES: readonly TextRole[] = ["kicker", "headline", "body", "footer", "badge", "accent"];
const PLATES: readonly Plate[] = ["none", "pill", "burst", "circle"];

export const FORMATS: Record<SlideFormat, { w: number; h: number; label: string }> = {
  "4:5": { w: 1080, h: 1350, label: "4:5 · Feed" },
  "1:1": { w: 1080, h: 1080, label: "1:1 · Square" },
  "9:16": { w: 1080, h: 1920, label: "9:16 · Story" },
  "3:2": { w: 1080, h: 720, label: "3:2 · Email banner" },
};

/**
 * The Tuft the World palette, from the brand guidelines (colour names and hex values as listed in
 * "Brand hex to pantone colors"). Fixed hex, so a saved design never shifts with the app theme.
 * Charcoal stands in for black; Natural for white.
 */
export const BRAND_COLORS: { name: string; hex: string }[] = [
  { name: "Charcoal", hex: "#213838" },
  { name: "Natural", hex: "#f5edeb" },
  { name: "Royal", hex: "#0051ff" },
  { name: "Canary", hex: "#ffe813" },
  { name: "Pepper", hex: "#ff6229" },
  { name: "Ochre", hex: "#c78c2b" },
  { name: "Green", hex: "#b4eaba" },
  { name: "Blush", hex: "#edc2ff" },
  { name: "Grey", hex: "#b4b098" },
  { name: "White", hex: "#ffffff" },
];

export const FONT_LABELS: Record<SlideFont, string> = {
  display: "Display (Larken)",
  body: "Body (Roboto)",
  label: "Label (Brother 1816)",
  hand: "Handwritten",
  ui: "App sans",
  read: "App reading",
  serif: "Serif",
  mono: "Mono",
};

export interface TextLayer {
  id: string;
  text: string;
  /** Left edge, top edge and width, each as a percentage of the slide. */
  x: number;
  y: number;
  w: number;
  /** Font size in px on a 1080-wide slide. */
  size: number;
  font: SlideFont;
  weight: 400 | 600 | 700 | 800;
  color: string;
  align: TextAlign;
  lineHeight: number;
  uppercase: boolean;
  /** What the text is on the slide. Lets a slide be laid out again in another layout. */
  role?: TextRole;
  /** Shape behind the text, in `plateColor`. */
  plate?: Plate;
  plateColor?: string;
  /** Colour of a hand-drawn line under the text, when there is one. */
  scribble?: string;
}

/** A framed photo on the slide, as opposed to the one photo that fills it. Percentages of the slide. */
export interface Pic {
  id: string;
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Corner rounding, 0 (square) to 50 (fully round), as a percentage of the shorter side. */
  radius: number;
  /** Vertical focus when the photo is cropped to fill its frame, 0 to 100. */
  focusY: number;
  /** Show the whole picture inside the frame instead of filling it. Used for logos. */
  contain: boolean;
}

export interface Slide {
  id: string;
  bg: string;
  image: string | null;
  /** Darkening over the photo, 0 to 0.85. */
  imageDim: number;
  /** Vertical focus of a cover-fitted photo, 0 (top) to 100 (bottom). */
  imageY: number;
  layers: TextLayer[];
  /** Framed photos, drawn over the background and under the text. */
  pics: Pic[];
  /** Colour of the hand-drawn grid texture over the background, or null for none. */
  grid: string | null;
  /** Colour of the wavy line along the foot of the slide, or null for none. */
  wave: string | null;
  /** The layout the slide was built with, if any. */
  layout?: string;
  /** Set once the text has been measured in its real typeface and put right if it did not fit. */
  fit?: 1;
  /** The brand kit the slide is styled with. Absent means Tuft the World. */
  brand?: string;
  /** One filled panel behind the text, such as a price tag. Percentages of the slide. */
  panel?: { x: number; y: number; w: number; h: number; color: string; radius: number };
}

export interface SlideDesign {
  v: 1;
  format: SlideFormat;
  slides: Slide[];
}

export interface StudioOriginal {
  title?: string | null;
  copy?: string | null;
  platform_captions?: Record<string, string> | null;
  design?: SlideDesign | null;
  at?: string;
}

export interface Studio {
  kind: "slide_studio";
  v: 1;
  design: SlideDesign | null;
  /** What Claude first proposed. Never changed by the in-app editor. */
  original?: StudioOriginal;
  /** Images produced from the design, and the design key they were produced from. */
  rendered?: { key: string; urls: string[] };
}

export const STUDIO_KIND = "slide_studio";

const ROLE_PRESETS: Record<TextRole, Omit<TextLayer, "id" | "text" | "color">> = {
  kicker: {
    x: 8,
    y: 8,
    w: 84,
    size: 30,
    font: "ui",
    weight: 700,
    align: "left",
    lineHeight: 1.2,
    uppercase: true,
  },
  headline: {
    x: 8,
    y: 30,
    w: 84,
    size: 92,
    font: "ui",
    weight: 800,
    align: "left",
    lineHeight: 1.05,
    uppercase: false,
  },
  body: {
    x: 8,
    y: 58,
    w: 84,
    size: 42,
    font: "read",
    weight: 400,
    align: "left",
    lineHeight: 1.35,
    uppercase: false,
  },
  footer: {
    x: 8,
    y: 90,
    w: 84,
    size: 28,
    font: "ui",
    weight: 600,
    align: "left",
    lineHeight: 1.2,
    uppercase: false,
  },
  badge: {
    x: 62,
    y: 9,
    w: 28,
    size: 50,
    font: "label",
    weight: 800,
    align: "center",
    lineHeight: 1.05,
    uppercase: true,
  },
  accent: {
    x: 8,
    y: 78,
    w: 70,
    size: 64,
    font: "hand",
    weight: 700,
    align: "left",
    lineHeight: 1,
    uppercase: false,
  },
};

let idCounter = 0;
export function newId(prefix = "l"): string {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.min(max, Math.max(min, v));
}

function isHex(v: unknown): v is string {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
}

/** Relative luminance of a hex colour, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** Ink that reads on the given background: white on dark or photo slides, charcoal on light. */
export function readableInk(bg: string, hasImage: boolean): string {
  if (hasImage) return "#ffffff";
  return luminance(bg) > 0.2 ? "#213838" : "#ffffff";
}

function normalizeLayer(raw: unknown, slideBg: string, hasImage: boolean): TextLayer | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const text = typeof r.text === "string" ? r.text : "";
  const givenRole = ROLES.includes(r.role as TextRole) ? (r.role as TextRole) : undefined;
  const p = ROLE_PRESETS[givenRole ?? "body"];
  const plate =
    PLATES.includes(r.plate as Plate) && r.plate !== "none" ? (r.plate as Plate) : undefined;
  const plateColor = plate
    ? isHex(r.plateColor)
      ? r.plateColor.toLowerCase()
      : readableInk(slideBg, hasImage)
    : undefined;
  const weight = [400, 600, 700, 800].includes(r.weight as number)
    ? (r.weight as TextLayer["weight"])
    : p.weight;
  const font = FONTS.includes(r.font as SlideFont) ? (r.font as SlideFont) : p.font;
  const align = (["left", "center", "right"] as const).includes(r.align as TextAlign)
    ? (r.align as TextAlign)
    : p.align;
  const w = clamp(r.w, 10, 100, p.w);
  return {
    id: typeof r.id === "string" && r.id ? r.id : newId("l"),
    text: text.slice(0, 1000),
    x: clamp(r.x, 0, 100 - w, Math.min(p.x, 100 - w)),
    y: clamp(r.y, 0, 98, p.y),
    w,
    size: clamp(r.size, 12, 320, p.size),
    font,
    weight,
    color: isHex(r.color)
      ? r.color.toLowerCase()
      : plateColor
        ? readableInk(plateColor, false)
        : readableInk(slideBg, hasImage),
    align,
    lineHeight: clamp(r.lineHeight, 0.8, 2.5, p.lineHeight),
    uppercase: typeof r.uppercase === "boolean" ? r.uppercase : p.uppercase,
    ...(givenRole ? { role: givenRole } : {}),
    ...(plate ? { plate, plateColor } : {}),
    ...(isHex(r.scribble) ? { scribble: r.scribble.toLowerCase() } : {}),
  };
}

function normalizePic(raw: unknown): Pic | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.url !== "string" || !/^https?:\/\//.test(r.url)) return null;
  const w = clamp(r.w, 4, 100, 84);
  const h = clamp(r.h, 4, 100, 50);
  return {
    id: typeof r.id === "string" && r.id ? r.id : newId("p"),
    url: r.url,
    x: clamp(r.x, 0, 100 - w, Math.min(8, 100 - w)),
    y: clamp(r.y, 0, 100 - h, Math.min(8, 100 - h)),
    w,
    h,
    radius: clamp(r.radius, 0, 50, 0),
    focusY: clamp(r.focusY, 0, 100, 50),
    contain: r.contain === true,
  };
}

function normalizeSlide(raw: unknown): Slide | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const bg = isHex(r.bg) ? r.bg.toLowerCase() : "#213838";
  const image = typeof r.image === "string" && /^https?:\/\//.test(r.image) ? r.image : null;
  const rp = r.panel && typeof r.panel === "object" ? (r.panel as Record<string, unknown>) : null;
  const panel =
    rp && isHex(rp.color)
      ? {
          x: clamp(rp.x, 0, 96, 8),
          y: clamp(rp.y, 0, 96, 8),
          w: clamp(rp.w, 4, 100, 84),
          h: clamp(rp.h, 4, 100, 60),
          color: rp.color.toLowerCase(),
          radius: clamp(rp.radius, 0, 50, 2),
        }
      : null;
  const rawLayers = Array.isArray(r.layers) ? r.layers : [];
  const layers = rawLayers
    .slice(0, 12)
    .map((l) => normalizeLayer(l, bg, !!image))
    .filter((l): l is TextLayer => l !== null);
  return {
    id: typeof r.id === "string" && r.id ? r.id : newId("s"),
    bg,
    image,
    imageDim: clamp(r.imageDim, 0, 0.85, image ? 0.35 : 0),
    imageY: clamp(r.imageY, 0, 100, 50),
    layers,
    pics: (Array.isArray(r.pics) ? r.pics : [])
      .slice(0, 8)
      .map(normalizePic)
      .filter((p): p is Pic => p !== null),
    grid: isHex(r.grid) ? r.grid.toLowerCase() : null,
    wave: isHex(r.wave) ? r.wave.toLowerCase() : null,
    ...(typeof r.layout === "string" && r.layout ? { layout: r.layout.slice(0, 24) } : {}),
    ...(typeof r.brand === "string" && /^[a-z]{2,12}$/.test(r.brand) ? { brand: r.brand } : {}),
    ...(panel ? { panel } : {}),
    ...(r.fit === 1 ? { fit: 1 as const } : {}),
  };
}

/**
 * Accept a design from anywhere (the database, the editor, an MCP call) and return a complete,
 * clamped one. Layers may be given with just `text` and a `role`; positions and sizes are filled
 * from the role preset. Returns null when there is nothing usable.
 */
export function normalizeDesign(raw: unknown): SlideDesign | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rawSlides = Array.isArray(r.slides) ? r.slides : [];
  const slides = rawSlides
    .slice(0, 20)
    .map(normalizeSlide)
    .filter((s): s is Slide => s !== null);
  if (slides.length === 0) return null;
  const format: SlideFormat =
    r.format === "1:1" || r.format === "9:16" || r.format === "3:2" ? r.format : "4:5";
  return { v: 1, format, slides };
}

/** Read the studio record out of posts.text_overlay_suggestions. Null for anything else stored there. */
export function readStudio(raw: unknown): Studio | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== STUDIO_KIND) return null;
  const studio: Studio = { kind: STUDIO_KIND, v: 1, design: normalizeDesign(r.design) };
  if (r.original && typeof r.original === "object") {
    const o = r.original as Record<string, unknown>;
    // A field Claude never set stays undefined, so it is not compared later.
    studio.original = {
      ...(typeof o.title === "string" ? { title: o.title } : {}),
      ...(typeof o.copy === "string" ? { copy: o.copy } : {}),
      ...(o.platform_captions && typeof o.platform_captions === "object"
        ? { platform_captions: o.platform_captions as Record<string, string> }
        : {}),
      ...(o.design !== undefined ? { design: normalizeDesign(o.design) } : {}),
      ...(typeof o.at === "string" ? { at: o.at } : {}),
    };
  }
  if (r.rendered && typeof r.rendered === "object") {
    const rr = r.rendered as Record<string, unknown>;
    if (typeof rr.key === "string" && Array.isArray(rr.urls)) {
      studio.rendered = {
        key: rr.key,
        urls: rr.urls.filter((u): u is string => typeof u === "string"),
      };
    }
  }
  return studio;
}

export function starterSlide(bg = "#213838"): Slide {
  return {
    id: newId("s"),
    bg,
    image: null,
    imageDim: 0,
    imageY: 50,
    pics: [],
    grid: null,
    wave: null,
    layers: [
      {
        id: newId("l"),
        text: "Your headline",
        color: readableInk(bg, false),
        ...ROLE_PRESETS.headline,
      },
      {
        id: newId("l"),
        text: "Supporting line goes here.",
        color: readableInk(bg, false),
        ...ROLE_PRESETS.body,
      },
    ],
  };
}

export function starterDesign(): SlideDesign {
  return { v: 1, format: "4:5", slides: [starterSlide()] };
}

export function newTextLayer(slide: Slide): TextLayer {
  return {
    id: newId("l"),
    text: "New text",
    color: readableInk(slide.bg, !!slide.image),
    ...ROLE_PRESETS.body,
    y: Math.min(80, 20 + slide.layers.length * 12),
  };
}

/**
 * Stack a slide's text top to bottom so blocks do not overlap. Used when a design arrives without
 * positions (from an MCP call), where text cannot be measured: heights are estimated from
 * character counts, which is close enough for a starting layout the editor then refines.
 * Layers listed in `pinned` keep the position they were given.
 */
export function flowLayers(
  slide: Slide,
  format: SlideFormat,
  pinned: Set<string> = new Set(),
): Slide {
  const { w: W, h: H } = FORMATS[format];
  const estimate = (l: TextLayer) => {
    const perLine = Math.max(4, Math.floor(((l.w / 100) * W) / (l.size * 0.54)));
    const lines = l.text
      .split("\n")
      .reduce((n, para) => n + Math.max(1, Math.ceil(para.length / perLine)), 0);
    return ((lines * l.size * l.lineHeight) / H) * 100;
  };
  const free = slide.layers.filter((l) => !pinned.has(l.id));
  if (free.length === 0) return slide;
  // The last free layer sits at the foot when there are three or more; the rest stack from the top.
  const footer = free.length >= 3 ? free[free.length - 1] : null;
  const stack = footer ? free.slice(0, -1) : free;
  const gap = 3.5;
  const total = stack.reduce((sum, l) => sum + estimate(l), 0) + gap * (stack.length - 1);
  const floor = footer ? 86 : 92;
  let y = Math.max(7, Math.min(22, (floor - total) / 2));
  const placed = new Map<string, number>();
  for (const l of stack) {
    placed.set(l.id, Math.min(y, 94));
    y += estimate(l) + gap;
  }
  if (footer) placed.set(footer.id, Math.max(Math.min(y, 94), 96 - estimate(footer) - 4));
  return {
    ...slide,
    layers: slide.layers.map((l) =>
      placed.has(l.id) ? { ...l, y: Math.round(placed.get(l.id)! * 10) / 10 } : l,
    ),
  };
}

/** Stable fingerprint of a design's visible content, used to tell when rendered images are stale. */
export function designKey(design: SlideDesign | null): string {
  if (!design) return "none";
  const visible = {
    f: design.format,
    // Decoration is appended only where a slide has some, so designs made before it keep their key.
    s: design.slides.map((s) => [
      s.bg,
      s.image,
      s.imageDim,
      s.imageY,
      s.layers.map((l) => [
        l.text,
        l.x,
        l.y,
        l.w,
        l.size,
        l.font,
        l.weight,
        l.color,
        l.align,
        l.lineHeight,
        l.uppercase,
        ...(l.plate || l.scribble ? [l.plate ?? "", l.plateColor ?? "", l.scribble ?? ""] : []),
      ]),
      ...(s.pics.length || s.grid || s.wave || s.panel || s.brand
        ? [
            s.pics.map((p) => [p.url, p.x, p.y, p.w, p.h, p.radius, p.focusY, p.contain]),
            s.grid,
            s.wave,
            s.brand ?? "",
            s.panel ?? "",
          ]
        : []),
    ]),
  };
  const str = JSON.stringify(visible);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return `${h.toString(36)}-${str.length.toString(36)}`;
}

// ---------------------------------------------------------------------------------------------
// Layout and drawing
// ---------------------------------------------------------------------------------------------

export type Measure = (text: string) => number;

/** Wrap text to a width. Keeps explicit line breaks; breaks a single over-long word by character. */
export function wrapLines(text: string, maxWidth: number, measure: Measure): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      if (measure(word) <= maxWidth) {
        line = word;
        continue;
      }
      let chunk = "";
      for (const ch of word) {
        if (chunk && measure(chunk + ch) > maxWidth) {
          out.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      line = chunk;
    }
    out.push(line);
  }
  return out;
}

export type FontResolver = (font: SlideFont) => string;

export const fallbackFontResolver: FontResolver = (font) =>
  font === "serif"
    ? 'Georgia, "Times New Roman", serif'
    : font === "mono"
      ? 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'
      : font === "display"
        ? 'Georgia, "Times New Roman", serif'
        : font === "hand"
          ? '"Segoe Print", "Bradley Hand", cursive'
          : 'system-ui, -apple-system, "Segoe UI", sans-serif';

export function canvasFont(layer: TextLayer, px: number, resolve: FontResolver): string {
  return `${layer.weight} ${px}px ${resolve(layer.font)}`;
}

export interface LayerBox {
  lines: string[];
  x: number;
  y: number;
  w: number;
  h: number;
  fontPx: number;
  lineH: number;
}

/** Where a layer lands on a slide drawn W by H px. `measure` must already be set to the layer's font. */
export function layoutLayer(layer: TextLayer, W: number, H: number, measure: Measure): LayerBox {
  const fontPx = (layer.size * W) / 1080;
  const w = (layer.w / 100) * W;
  const text = layer.uppercase ? layer.text.toUpperCase() : layer.text;
  const lines = wrapLines(text, w, measure);
  const lineH = fontPx * layer.lineHeight;
  return {
    lines,
    x: (layer.x / 100) * W,
    y: (layer.y / 100) * H,
    w,
    h: Math.max(lineH, lines.length * lineH),
    fontPx,
    lineH,
  };
}

interface Ctx2D {
  fillStyle: unknown;
  font: string;
  textBaseline: unknown;
  textAlign: unknown;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  drawImage(
    image: unknown,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
}

/** The path-drawing part of a canvas, needed only for slides with framed photos or decoration. */
interface PathCtx extends Ctx2D {
  strokeStyle: unknown;
  lineWidth: number;
  lineCap: unknown;
  lineJoin: unknown;
  globalAlpha: number;
  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  clip(): void;
  fill(): void;
  stroke(): void;
}

export interface DrawableImage {
  width: number;
  height: number;
}

/** A repeatable wobble in -1..1, so hand-drawn lines look the same every time a slide is drawn. */
function wobble(n: number): number {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return (v - Math.floor(v)) * 2 - 1;
}

function roundedRect(ctx: PathCtx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** The brand's hand-drawn grid: evenly spaced lines that waver slightly, edge to edge. */
function drawGrid(ctx: PathCtx, color: string, W: number, H: number, ruled = false): void {
  // Ruled: the straight, finer grid of a cutting mat.
  const step = W / (ruled ? 12 : 8);
  const amp = ruled ? 0 : W * 0.0035;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = ruled ? 0.3 : 0.22;
  ctx.lineWidth = Math.max(1, W * (ruled ? 0.0018 : 0.0028));
  ctx.lineCap = "round";
  const line = (n: number, vertical: boolean, at: number, length: number) => {
    ctx.beginPath();
    const parts = 6;
    for (let i = 0; i <= parts; i++) {
      const along = (length * i) / parts;
      const off = at + wobble(n * 13 + i) * amp;
      if (i === 0) ctx.moveTo(vertical ? off : along, vertical ? along : off);
      else ctx.lineTo(vertical ? off : along, vertical ? along : off);
    }
    ctx.stroke();
  };
  let n = 0;
  for (let x = step / 2; x < W; x += step) line(n++, true, x, H);
  for (let y = step / 2; y < H; y += step) line(n++, false, y, W);
  ctx.restore();
}

/** The brand wave: one thick wavy line along the foot of the slide. */
function drawWave(ctx: PathCtx, color: string, W: number, H: number): void {
  const y = H - W * 0.055;
  const amp = W * 0.014;
  const half = W / 11;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = W * 0.013;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(-half / 2, y);
  for (let i = 0, x = -half / 2; x < W + half; i++, x += half) {
    ctx.quadraticCurveTo(x + half / 2, y + (i % 2 ? amp : -amp) * 2, x + half, y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawPic(
  ctx: PathCtx,
  pic: Pic,
  W: number,
  H: number,
  image: DrawableImage | null | undefined,
): void {
  const x = (pic.x / 100) * W;
  const y = (pic.y / 100) * H;
  const w = (pic.w / 100) * W;
  const h = (pic.h / 100) * H;
  const usable = image && image.width > 0 && image.height > 0 ? image : null;
  if (pic.contain) {
    // A logo or cut-out: shown whole, with nothing behind it.
    if (!usable) return;
    const scale = Math.min(w / usable.width, h / usable.height);
    const dw = usable.width * scale;
    const dh = usable.height * scale;
    ctx.drawImage(
      usable,
      0,
      0,
      usable.width,
      usable.height,
      x + (w - dw) / 2,
      y + (h - dh) / 2,
      dw,
      dh,
    );
    return;
  }
  ctx.save();
  roundedRect(ctx, x, y, w, h, (pic.radius / 100) * Math.min(w, h));
  ctx.clip();
  if (usable) {
    const scale = Math.max(w / usable.width, h / usable.height);
    const sw = w / scale;
    const sh = h / scale;
    ctx.drawImage(
      usable,
      (usable.width - sw) / 2,
      (usable.height - sh) * (pic.focusY / 100),
      sw,
      sh,
      x,
      y,
      w,
      h,
    );
  } else {
    // The photo has not loaded yet (or could not be): hold its place.
    ctx.fillStyle = "#b4b098";
    ctx.fillRect(x, y, w, h);
  }
  ctx.restore();
}

function drawPlate(
  ctx: PathCtx,
  layer: TextLayer,
  left: number,
  top: number,
  textW: number,
  textH: number,
  fontPx: number,
): void {
  ctx.fillStyle = layer.plateColor ?? "#213838";
  const cx = left + textW / 2;
  const cy = top + textH / 2;
  if (layer.plate === "pill") {
    const padX = fontPx * 0.62;
    const padY = fontPx * 0.3;
    roundedRect(
      ctx,
      left - padX,
      top - padY,
      textW + padX * 2,
      textH + padY * 2,
      (textH + padY * 2) / 2,
    );
    ctx.fill();
    return;
  }
  const r = Math.max(Math.hypot(textW, textH) / 2 + fontPx * 0.35, fontPx * 1.2);
  ctx.beginPath();
  if (layer.plate === "circle") {
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  } else {
    // A sale burst: a many-pointed star.
    const points = 14;
    const outer = r * 1.16;
    for (let i = 0; i < points * 2; i++) {
      const a = (Math.PI * i) / points - Math.PI / 2;
      const rad = i % 2 === 0 ? outer : r;
      if (i === 0) ctx.moveTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
      else ctx.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
    }
  }
  ctx.closePath();
  ctx.fill();
}

/** A quick hand-drawn double underline. */
function drawScribble(
  ctx: PathCtx,
  color: string,
  left: number,
  y: number,
  width: number,
  fontPx: number,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, fontPx * 0.07);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const lift = fontPx * 0.09;
  ctx.beginPath();
  ctx.moveTo(left, y + lift);
  ctx.quadraticCurveTo(left + width * 0.45, y - lift * 0.9, left + width, y + lift * 0.3);
  ctx.quadraticCurveTo(left + width * 0.6, y + lift * 1.2, left + width * 0.12, y + lift * 2.6);
  ctx.quadraticCurveTo(left + width * 0.5, y + lift * 1.7, left + width * 0.9, y + lift * 2.4);
  ctx.stroke();
  ctx.restore();
}

/** Whether a slide uses anything beyond a background, one photo and plain text. */
export function hasDecoration(slide: Slide): boolean {
  return (
    slide.pics.length > 0 ||
    !!slide.grid ||
    !!slide.wave ||
    !!slide.panel ||
    slide.layers.some((l) => !!l.plate || !!l.scribble)
  );
}

/**
 * Draw one slide at W by H px. The same function paints the editor preview and the final image.
 * `pics` maps a framed photo's URL to its loaded image.
 */
export function drawSlide(
  ctx: Ctx2D,
  slide: Slide,
  W: number,
  H: number,
  image: DrawableImage | null,
  resolveFont: FontResolver = fallbackFontResolver,
  pics: Record<string, DrawableImage | null | undefined> = {},
): void {
  ctx.fillStyle = slide.bg;
  ctx.fillRect(0, 0, W, H);

  if (image && image.width > 0 && image.height > 0) {
    const scale = Math.max(W / image.width, H / image.height);
    const sw = W / scale;
    const sh = H / scale;
    const sx = (image.width - sw) / 2;
    const sy = (image.height - sh) * (slide.imageY / 100);
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, W, H);
    if (slide.imageDim > 0) {
      ctx.fillStyle = `rgba(0,0,0,${slide.imageDim})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  // Shapes need the path part of a canvas; a slide without them never touches it.
  const path =
    hasDecoration(slide) && typeof (ctx as Partial<PathCtx>).beginPath === "function"
      ? (ctx as PathCtx)
      : null;
  const handless = !!slide.brand && slide.brand !== "ttw";
  if (path) {
    // Tuft the World draws by hand; the other brands rule their lines.
    if (slide.grid) drawGrid(path, slide.grid, W, H, handless);
    if (slide.panel) {
      const p = slide.panel;
      path.fillStyle = p.color;
      roundedRect(
        path,
        (p.x / 100) * W,
        (p.y / 100) * H,
        (p.w / 100) * W,
        (p.h / 100) * H,
        (p.radius / 100) * W,
      );
      path.fill();
    }
    for (const pic of slide.pics) drawPic(path, pic, W, H, pics[pic.url]);
    if (slide.wave) drawWave(path, slide.wave, W, H);
  }

  ctx.textBaseline = "top";
  for (const layer of slide.layers) {
    const fontPx = (layer.size * W) / 1080;
    ctx.font = canvasFont(layer, fontPx, resolveFont);
    const box = layoutLayer(layer, W, H, (t) => ctx.measureText(t).width);
    if (path && (layer.plate || layer.scribble) && layer.text.trim()) {
      // Shapes hug the words themselves, not the (often wider) text box.
      const textW = Math.min(
        box.w,
        Math.max(...box.lines.map((line) => ctx.measureText(line).width)),
      );
      const left =
        layer.align === "left"
          ? box.x
          : layer.align === "center"
            ? box.x + (box.w - textW) / 2
            : box.x + box.w - textW;
      if (layer.plate) drawPlate(path, layer, left, box.y, textW, box.h, fontPx);
      if (layer.scribble && handless) {
        // A plain short bar under the text.
        path.fillStyle = layer.scribble;
        path.fillRect(
          left,
          box.y + box.h + fontPx * 0.14,
          Math.min(textW, fontPx * 1.6),
          Math.max(3, fontPx * 0.09),
        );
      } else if (layer.scribble)
        drawScribble(path, layer.scribble, left, box.y + box.h + fontPx * 0.04, textW, fontPx);
    }
    ctx.fillStyle = layer.color;
    ctx.textAlign = layer.align;
    const anchorX =
      layer.align === "left" ? box.x : layer.align === "center" ? box.x + box.w / 2 : box.x + box.w;
    // Centre the glyphs in their line box so line height changes move text evenly.
    const inset = (box.lineH - box.fontPx) / 2;
    box.lines.forEach((line, i) => ctx.fillText(line, anchorX, box.y + i * box.lineH + inset));
  }
}

// ---------------------------------------------------------------------------------------------
// Comparing Claude's proposal with what was approved
// ---------------------------------------------------------------------------------------------

export interface SlideChange {
  slide: number;
  change: string;
  before?: unknown;
  after?: unknown;
}

export interface EditSummary {
  changed: boolean;
  fields: string[];
  title?: { before: string | null; after: string | null };
  copy?: { before: string | null; after: string | null };
  platform_captions?: Record<string, { before: string | null; after: string | null }>;
  slides?: SlideChange[];
}

const LAYER_STYLE_KEYS = [
  "size",
  "font",
  "weight",
  "color",
  "align",
  "uppercase",
  "lineHeight",
  "plate",
  "plateColor",
  "scribble",
] as const;

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function diffDesigns(before: SlideDesign | null, after: SlideDesign | null): SlideChange[] {
  const changes: SlideChange[] = [];
  if (!before && !after) return changes;
  if (!before || !after) {
    changes.push({ slide: 0, change: before ? "design removed" : "design added" });
    return changes;
  }
  if (before.format !== after.format)
    changes.push({ slide: 0, change: "format", before: before.format, after: after.format });

  const beforeIds = before.slides.map((s) => s.id);
  const afterIds = after.slides.map((s) => s.id);
  before.slides.forEach((s, i) => {
    if (!afterIds.includes(s.id)) {
      changes.push({ slide: i + 1, change: "slide removed", before: s.layers.map((l) => l.text) });
    }
  });
  const kept = afterIds.filter((id) => beforeIds.includes(id));
  const keptBefore = beforeIds.filter((id) => afterIds.includes(id));
  if (kept.join() !== keptBefore.join()) {
    changes.push({
      slide: 0,
      change: "slides reordered",
      before: keptBefore.map((id) => beforeIds.indexOf(id) + 1),
      after: kept.map((id) => beforeIds.indexOf(id) + 1),
    });
  }

  after.slides.forEach((s, i) => {
    const n = i + 1;
    const b = before.slides.find((x) => x.id === s.id);
    if (!b) {
      changes.push({ slide: n, change: "slide added", after: s.layers.map((l) => l.text) });
      return;
    }
    if (b.bg !== s.bg)
      changes.push({ slide: n, change: "background colour", before: b.bg, after: s.bg });
    if (b.image !== s.image)
      changes.push({ slide: n, change: "photo", before: b.image, after: s.image });
    if (s.image && round(b.imageDim) !== round(s.imageDim))
      changes.push({
        slide: n,
        change: "photo darkening",
        before: round(b.imageDim),
        after: round(s.imageDim),
      });
    if ((b.layout ?? "") !== (s.layout ?? ""))
      changes.push({
        slide: n,
        change: "layout",
        before: b.layout ?? null,
        after: s.layout ?? null,
      });
    const picUrls = (x: Slide) => x.pics.map((p) => p.url);
    if (picUrls(b).join("|") !== picUrls(s).join("|"))
      changes.push({ slide: n, change: "framed photos", before: picUrls(b), after: picUrls(s) });
    if (b.grid !== s.grid || b.wave !== s.wave)
      changes.push({
        slide: n,
        change: "decoration",
        before: { grid: b.grid, wave: b.wave },
        after: { grid: s.grid, wave: s.wave },
      });
    if (s.image && Math.abs(b.imageY - s.imageY) >= 2)
      changes.push({
        slide: n,
        change: "photo focus",
        before: round(b.imageY),
        after: round(s.imageY),
      });

    for (const bl of b.layers) {
      if (!s.layers.some((l) => l.id === bl.id))
        changes.push({ slide: n, change: "text removed", before: bl.text });
    }
    for (const l of s.layers) {
      const bl = b.layers.find((x) => x.id === l.id);
      if (!bl) {
        changes.push({ slide: n, change: "text added", after: l.text });
        continue;
      }
      if (bl.text !== l.text)
        changes.push({ slide: n, change: "text", before: bl.text, after: l.text });
      const style: Record<string, { before: unknown; after: unknown }> = {};
      for (const k of LAYER_STYLE_KEYS)
        if (bl[k] !== l[k]) style[k] = { before: bl[k], after: l[k] };
      if (Object.keys(style).length)
        changes.push({ slide: n, change: `style of "${l.text.slice(0, 40)}"`, after: style });
      if (Math.abs(bl.x - l.x) >= 1 || Math.abs(bl.y - l.y) >= 1 || Math.abs(bl.w - l.w) >= 1) {
        changes.push({
          slide: n,
          change: `position of "${l.text.slice(0, 40)}"`,
          before: { x: round(bl.x), y: round(bl.y), w: round(bl.w) },
          after: { x: round(l.x), y: round(l.y), w: round(l.w) },
        });
      }
    }
  });
  return changes;
}

/** What changed between Claude's proposal and the post as it stands now. */
export function summarizeEdits(
  original: StudioOriginal | undefined,
  current: {
    title?: string | null;
    copy?: string | null;
    platform_captions?: Record<string, string> | null;
    design?: SlideDesign | null;
  },
): EditSummary {
  const summary: EditSummary = { changed: false, fields: [] };
  if (!original) return summary;

  if (original.title !== undefined && (original.title ?? "") !== (current.title ?? "")) {
    summary.title = { before: original.title ?? null, after: current.title ?? null };
    summary.fields.push("title");
  }
  if (original.copy !== undefined && (original.copy ?? "") !== (current.copy ?? "")) {
    summary.copy = { before: original.copy ?? null, after: current.copy ?? null };
    summary.fields.push("copy");
  }
  if (original.platform_captions !== undefined) {
    const before = original.platform_captions ?? {};
    const after = current.platform_captions ?? {};
    const captionChanges: Record<string, { before: string | null; after: string | null }> = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if ((before[key] ?? "") !== (after[key] ?? ""))
        captionChanges[key] = { before: before[key] ?? null, after: after[key] ?? null };
    }
    if (Object.keys(captionChanges).length) {
      summary.platform_captions = captionChanges;
      summary.fields.push("platform_captions");
    }
  }
  if (original.design !== undefined) {
    const slideChanges = diffDesigns(original.design ?? null, current.design ?? null);
    if (slideChanges.length) {
      summary.slides = slideChanges;
      summary.fields.push("slides");
    }
  }
  summary.changed = summary.fields.length > 0;
  return summary;
}
