/**
 * Brand kits: the colours, type and decoration that make a slide belong to one of the owner's
 * brands. Tuft the World follows its brand guidelines; Price Your Craft and A History of Tufted
 * Rugs have no written guide, so their kits are taken from the look of their websites (the same
 * colours and typefaces, used the same way).
 *
 * Pure data and colour helpers, shared by the app, the tests, the MCP tools and the edge functions.
 */

/** Relative luminance of a hex colour, 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export type BrandId = "ttw" | "pyc" | "history";
export type LayoutId =
  "statement" | "sale" | "product" | "split" | "grid" | "photo" | "note" | "closing" | "tag";

export interface BrandKit {
  /** A workspace's own kit borrows a built-in id for the email themes; `own` tells them apart. */
  id: BrandId;
  own?: boolean;
  name: string;
  /** Web address as it is written on a slide. */
  site: string;
  /** One line on what the brand looks like, for the writer and the editor. */
  look: string;
  palette: Record<string, string>;
  /** For each background: the text colour and the one accent that goes with it, by palette name. */
  pairings: Record<string, { ink: string; accent: string }>;
  /** The order colours are tried in when one has to be swapped. */
  rotation: string[];
  /** Calm colours. A full-colour logo sits on these. */
  neutrals: string[];
  /** Palette names of the dark and light text colours, and the accent used over photos. */
  dark: string;
  light: string;
  overPhoto: string;
  display: {
    weight: 400 | 600 | 700 | 800;
    uppercase: boolean;
    lineHeight: number;
    char: number;
    scale: number;
  };
  /** Character width of the label face, as a share of its size. */
  labelChar: number;
  /** Whether the brand has a handwritten face for short asides. */
  hand: boolean;
  /** Size multiplier for the handwritten face. */
  handScale: number;
  grid: "hand" | "ruled" | null;
  wave: boolean;
  underline: "scribble" | "bar" | null;
  sticker: "burst" | "circle" | "pill";
  /** Corner rounding of framed photos. */
  photoRadius: number;
  layouts: LayoutId[];
  /** True when the logo is a wide wordmark rather than a compact badge. */
  wideLogo: boolean;
  /** Library tags of the brand's logos. */
  logos: { badge?: string; dark: string; light: string };
}

const TTW: BrandKit = {
  id: "ttw",
  name: "Tuft the World",
  site: "tufttheworld.com",
  look: "Playful and bold: bright yarn colours, an elegant display serif, hand-drawn scribbles, a grid and a wave.",
  palette: {
    charcoal: "#213838",
    natural: "#f5edeb",
    royal: "#0051ff",
    canary: "#ffe813",
    pepper: "#ff6229",
    ochre: "#c78c2b",
    green: "#b4eaba",
    blush: "#edc2ff",
    grey: "#b4b098",
  },
  pairings: {
    charcoal: { ink: "natural", accent: "canary" },
    natural: { ink: "charcoal", accent: "pepper" },
    royal: { ink: "natural", accent: "canary" },
    canary: { ink: "charcoal", accent: "royal" },
    pepper: { ink: "charcoal", accent: "natural" },
    ochre: { ink: "charcoal", accent: "natural" },
    green: { ink: "charcoal", accent: "royal" },
    blush: { ink: "charcoal", accent: "royal" },
    grey: { ink: "charcoal", accent: "natural" },
  },
  rotation: ["charcoal", "natural", "royal", "canary", "pepper", "green", "blush", "ochre"],
  neutrals: ["natural", "charcoal", "grey"],
  dark: "charcoal",
  light: "natural",
  overPhoto: "canary",
  display: { weight: 600, uppercase: false, lineHeight: 1.04, char: 0.5, scale: 1 },
  labelChar: 0.62,
  hand: true,
  handScale: 1,
  grid: "hand",
  wave: true,
  underline: "scribble",
  sticker: "burst",
  photoRadius: 3,
  layouts: ["statement", "sale", "product", "split", "grid", "photo", "note", "closing"],
  wideLogo: false,
  logos: { badge: "logo-badge", dark: "logo", light: "logo-light" },
};

const PYC: BrandKit = {
  id: "pyc",
  name: "Price Your Craft",
  site: "priceyourcraft.com",
  look: "A maker's workbench: cutting-mat green with a ruled grid, kraft price tags, marigold totals, tall condensed capitals and typewriter figures.",
  palette: {
    mat: "#2f5e4f",
    ground: "#f4f6f2",
    marigold: "#f0b23e",
    kraft: "#d9bb8c",
    ink: "#213838",
    pepper: "#c2462b",
    teal: "#1f7a7a",
    lilac: "#6e5aa6",
    rose: "#b4466f",
    royal: "#085ede",
  },
  pairings: {
    mat: { ink: "ground", accent: "marigold" },
    ground: { ink: "ink", accent: "mat" },
    marigold: { ink: "ink", accent: "mat" },
    kraft: { ink: "ink", accent: "mat" },
    ink: { ink: "ground", accent: "marigold" },
    pepper: { ink: "ground", accent: "marigold" },
    teal: { ink: "ground", accent: "marigold" },
    lilac: { ink: "ground", accent: "marigold" },
    rose: { ink: "ground", accent: "marigold" },
    royal: { ink: "ground", accent: "marigold" },
  },
  rotation: [
    "mat",
    "ground",
    "marigold",
    "ink",
    "kraft",
    "teal",
    "pepper",
    "lilac",
    "rose",
    "royal",
  ],
  neutrals: ["ground", "kraft"],
  dark: "ink",
  light: "ground",
  overPhoto: "marigold",
  display: { weight: 800, uppercase: true, lineHeight: 0.96, char: 0.4, scale: 1.2 },
  labelChar: 0.62,
  hand: false,
  handScale: 1,
  grid: "ruled",
  wave: false,
  underline: "bar",
  sticker: "pill",
  photoRadius: 1,
  layouts: ["statement", "tag", "note", "split", "photo", "grid", "closing"],
  wideLogo: true,
  logos: { dark: "logo-pyc", light: "logo-pyc-light" },
};

const HISTORY: BrandKit = {
  id: "history",
  name: "A History of Tufted Rugs",
  site: "historyoftuftedrugs.com",
  look: "A museum catalogue: quiet stone and near-black grounds, deep cloth colours, heavy narrow headlines, a bookish serif, plain rules and captions.",
  palette: {
    stone: "#e6e9e4",
    board: "#1e2421",
    oxblood: "#7a2e2a",
    navy: "#253b5f",
    jade: "#2f6b52",
    ochre: "#a87a22",
    indigo: "#3a3f78",
    rust: "#9a4a26",
    plum: "#5a3e6b",
    teal: "#1e6767",
    wheat: "#d3a44b",
  },
  pairings: {
    stone: { ink: "board", accent: "oxblood" },
    board: { ink: "stone", accent: "wheat" },
    oxblood: { ink: "stone", accent: "wheat" },
    navy: { ink: "stone", accent: "wheat" },
    jade: { ink: "stone", accent: "wheat" },
    ochre: { ink: "board", accent: "stone" },
    indigo: { ink: "stone", accent: "wheat" },
    rust: { ink: "stone", accent: "wheat" },
    plum: { ink: "stone", accent: "wheat" },
    teal: { ink: "stone", accent: "wheat" },
    wheat: { ink: "board", accent: "oxblood" },
  },
  rotation: [
    "stone",
    "board",
    "oxblood",
    "navy",
    "jade",
    "ochre",
    "indigo",
    "rust",
    "plum",
    "teal",
  ],
  neutrals: ["stone", "board"],
  dark: "board",
  light: "stone",
  overPhoto: "wheat",
  display: { weight: 700, uppercase: false, lineHeight: 1.04, char: 0.44, scale: 1 },
  labelChar: 0.56,
  hand: false,
  handScale: 1,
  grid: null,
  wave: false,
  underline: "bar",
  sticker: "pill",
  photoRadius: 0,
  layouts: ["statement", "product", "split", "grid", "photo", "note", "closing"],
  wideLogo: true,
  logos: { dark: "logo-history", light: "logo-history-light" },
};

export const BRANDS: Record<BrandId, BrandKit> = { ttw: TTW, pyc: PYC, history: HISTORY };
export const BRAND_IDS = Object.keys(BRANDS) as BrandId[];

/**
 * The kit for a brand. A workspace's own kit is passed as the kit itself
 * (built from its settings by `toDesignKit`); the three ids are the built-in
 * ones. Anything unknown is Tuft the World.
 */
export function kitFor(brand: unknown): BrandKit {
  if (brand && typeof brand === "object" && "palette" in brand && "pairings" in brand) {
    return brand as BrandKit;
  }
  return BRANDS[brand as BrandId] ?? TTW;
}

export interface Scheme {
  bg: string;
  ink: string;
  accent: string;
  /** Text colour that reads on the accent. */
  onAccent: string;
}

/** The palette name of a colour given by name or hex, if it is one of the brand's. */
export function colorName(color: string | undefined, brand?: unknown): string | undefined {
  const kit = kitFor(brand);
  const lower = (color ?? "").toLowerCase();
  if (Object.prototype.hasOwnProperty.call(kit.palette, lower)) return lower;
  return Object.keys(kit.palette).find((n) => kit.palette[n] === lower);
}

/** The colour scheme for a background given by palette name or hex. Off-palette colours get a readable pairing. */
export function schemeFor(color: string | undefined, brand?: unknown): Scheme {
  const kit = kitFor(brand);
  const dark = kit.palette[kit.dark];
  const light = kit.palette[kit.light];
  const on = (hex: string) => (luminance(hex) > 0.2 ? dark : light);
  const name = colorName(color, brand);
  if (name) {
    const pair = kit.pairings[name] ?? {
      ink: luminance(kit.palette[name]) > 0.2 ? kit.dark : kit.light,
      accent: kit.overPhoto,
    };
    const accent = kit.palette[pair.accent];
    return { bg: kit.palette[name], ink: kit.palette[pair.ink], accent, onAccent: on(accent) };
  }
  const lower = (color ?? "").toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(lower)) {
    const ink = on(lower);
    const accent = ink === light ? kit.palette[kit.overPhoto] : schemeFor(kit.light, brand).accent;
    return { bg: lower, ink, accent, onAccent: on(accent) };
  }
  return schemeFor(kit.rotation[0], brand);
}

/**
 * The same colour never appears twice in a row. Swap a repeated background for the next colour
 * in the brand's rotation; a colour that is not the brand's is replaced by one that is.
 */
export function paceColors(colors: (string | undefined)[], brand?: unknown): string[] {
  const { rotation } = kitFor(brand);
  const out: string[] = [];
  colors.forEach((c, i) => {
    let name = colorName(c, brand) ?? rotation[i % rotation.length];
    if (i > 0 && name === out[i - 1]) {
      const next = colorName(colors[i + 1], brand);
      const start = rotation.indexOf(name);
      for (let k = 1; k <= rotation.length; k++) {
        const candidate = rotation[(start + k) % rotation.length];
        if (candidate !== out[i - 1] && candidate !== next) {
          name = candidate;
          break;
        }
      }
    }
    out.push(name);
  });
  return out;
}

/**
 * Which logo goes on a slide of the given colour. A full-colour badge is preferred and sits on
 * the neutral colours; elsewhere the plain mark is used, the light copy when the slide's text is
 * light. A logo that is not available is left off rather than swapped for one that would not read.
 */
export function pickLogo(
  color: string,
  logos: { badge?: string | null; dark?: string | null; light?: string | null },
  brand?: unknown,
): string | null {
  const kit = kitFor(brand);
  const s = schemeFor(color, brand);
  const neutral = kit.neutrals.some((n) => kit.palette[n] === s.bg) || s.bg === "#ffffff";
  const mark = s.ink === kit.palette[kit.light] ? logos.light : logos.dark;
  return (neutral ? (logos.badge ?? mark) : mark) ?? null;
}
