import { z } from "zod";
import type { BrandKit, LayoutId } from "../design/brands";

/**
 * A workspace's brand kit: what it's called, how it looks and how it sounds.
 * Data like every other setting (`configs`, module "brand"). Claude reads it
 * before drafting anything, and the email and slide designs are drawn from
 * it.
 */
export const BRAND_MODULE = "brand";
export const KIT_KEY = "kit";

export const FEELS = ["playful", "minimal", "classic", "bold", "earthy"] as const;
export type Feel = (typeof FEELS)[number];
export const FEEL_LABELS: Record<Feel, string> = {
  playful: "Playful: bright, hand-drawn, a bit of fun",
  minimal: "Minimal: calm, lots of space, quiet type",
  classic: "Classic: bookish, traditional, timeless",
  bold: "Bold: big type, strong colour, confident",
  earthy: "Earthy: natural tones, soft, handmade",
};

const hex = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform((value) => value.toLowerCase());
const colorName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9-]{0,19}$/);
const word = z.string().trim().min(1).max(40);
/** A file in the workspace's own folder of the public media bucket. */
const logoPath = z
  .string()
  .regex(/^[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,80}$/)
  .nullable()
  .default(null);

export const brandKitSchema = z.object({
  version: z.literal(1),
  name: z.string().trim().min(1).max(80),
  /** Web address as you'd write it on a flyer: yourshop.com */
  site: z
    .string()
    .trim()
    .max(80)
    .regex(/^([a-z0-9-]+\.)+[a-z]{2,}(\/[^\s]*)?$|^$/i)
    .default(""),
  tagline: z.string().trim().max(120).default(""),
  /** What you make and who it's for. */
  about: z.string().trim().max(800).default(""),
  /** How the brand looks, in a sentence or two. */
  look: z.string().trim().max(400).default(""),
  /** How the brand sounds. */
  voice: z.string().trim().max(2000).default(""),
  words_to_use: z.array(word).max(15).default([]),
  words_to_avoid: z.array(word).max(15).default([]),
  feel: z.enum(FEELS).default("minimal"),
  /** Two to ten named colours. The first is the main one. */
  colors: z
    .array(z.object({ name: colorName, hex }))
    .min(2)
    .max(10)
    .refine((colors) => new Set(colors.map((c) => c.name)).size === colors.length, {
      message: "Each colour needs its own name",
    }),
  logo_on_light: logoPath,
  logo_on_dark: logoPath,
});
export type BrandKitConfig = z.infer<typeof brandKitSchema>;

export function parseBrandKit(body: unknown): BrandKitConfig | null {
  const parsed = brandKitSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

/** Relative luminance of a hex colour, 0 (black) to 1 (white). */
export function luminance(color: string): number {
  const c = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
  const lin = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** How colourful a colour is, 0 (grey) to 1. */
export function saturation(color: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

const DECORATION: Record<
  Feel,
  Pick<
    BrandKit,
    "display" | "hand" | "grid" | "wave" | "underline" | "sticker" | "photoRadius" | "layouts"
  >
> = {
  playful: {
    display: { weight: 600, uppercase: false, lineHeight: 1.04, char: 0.5, scale: 1 },
    hand: true,
    grid: "hand",
    wave: true,
    underline: "scribble",
    sticker: "burst",
    photoRadius: 3,
    layouts: ["statement", "sale", "product", "split", "grid", "photo", "note", "closing"],
  },
  minimal: {
    display: { weight: 600, uppercase: false, lineHeight: 1.06, char: 0.5, scale: 0.95 },
    hand: false,
    grid: null,
    wave: false,
    underline: null,
    sticker: "pill",
    photoRadius: 1,
    layouts: ["statement", "product", "split", "photo", "note", "closing"],
  },
  classic: {
    display: { weight: 700, uppercase: false, lineHeight: 1.04, char: 0.44, scale: 1 },
    hand: false,
    grid: null,
    wave: false,
    underline: "bar",
    sticker: "pill",
    photoRadius: 0,
    layouts: ["statement", "product", "split", "grid", "photo", "note", "closing"],
  },
  bold: {
    display: { weight: 800, uppercase: true, lineHeight: 0.96, char: 0.4, scale: 1.2 },
    hand: false,
    grid: "ruled",
    wave: false,
    underline: "bar",
    sticker: "burst",
    photoRadius: 1,
    layouts: ["statement", "sale", "tag", "split", "photo", "grid", "closing"],
  },
  earthy: {
    display: { weight: 600, uppercase: false, lineHeight: 1.05, char: 0.48, scale: 1 },
    hand: true,
    grid: null,
    wave: true,
    underline: "scribble",
    sticker: "circle",
    photoRadius: 4,
    layouts: ["statement", "product", "split", "grid", "photo", "note", "closing"],
  },
};

/**
 * Turns a workspace's settings into the kit the design engine draws with.
 * Nobody is asked which text colour goes on which background: for each
 * colour, the text is whichever of the kit's darkest and lightest reads
 * best on it, and the accent is the most colourful other colour that still
 * stands out.
 */
export function toDesignKit(config: BrandKitConfig): BrandKit {
  const palette = Object.fromEntries(config.colors.map((c) => [c.name, c.hex]));
  const names = config.colors.map((c) => c.name);
  const byLight = [...names].sort((a, b) => luminance(palette[a]) - luminance(palette[b]));
  const dark = byLight[0];
  const light = byLight[byLight.length - 1];
  const pairings: BrandKit["pairings"] = {};
  for (const bg of names) {
    const ink =
      contrast(palette[bg], palette[dark]) >= contrast(palette[bg], palette[light]) ? dark : light;
    const others = names.filter((n) => n !== bg && n !== ink);
    const accent =
      others
        .filter((n) => contrast(palette[bg], palette[n]) >= 2.2)
        .sort((a, b) => saturation(palette[b]) - saturation(palette[a]))[0] ??
      others.sort(
        (a, b) => contrast(palette[bg], palette[b]) - contrast(palette[bg], palette[a]),
      )[0] ??
      ink;
    pairings[bg] = { ink, accent };
  }
  const neutrals = names.filter((n) => saturation(palette[n]) < 0.25);
  const bright = names
    .filter((n) => luminance(palette[n]) > 0.35)
    .sort((a, b) => saturation(palette[b]) - saturation(palette[a]))[0];
  return {
    id: "ttw",
    own: true,
    name: config.name,
    site: config.site.replace(/^https?:\/\//, ""),
    look: config.look || FEEL_LABELS[config.feel],
    palette,
    pairings,
    rotation: names,
    neutrals: neutrals.length ? neutrals : [light, dark],
    dark,
    light,
    overPhoto: bright ?? light,
    ...DECORATION[config.feel],
    layouts: DECORATION[config.feel].layouts as LayoutId[],
    labelChar: 0.6,
    handScale: 1,
    wideLogo: true,
    logos: { dark: "logo", light: "logo-light" },
  };
}

/**
 * The brand in words, for Claude to read before it drafts anything. Wrapped
 * as data by the caller: it is a description to follow in tone, never an
 * instruction to obey.
 */
export function brandBrief(config: BrandKitConfig | null): string {
  if (!config) return "";
  return [
    `Brand: ${config.name}${config.tagline ? ` (${config.tagline})` : ""}`,
    config.about && `What it is: ${config.about}`,
    config.voice && `How it sounds: ${config.voice}`,
    config.words_to_use.length > 0 && `Words it likes: ${config.words_to_use.join(", ")}`,
    config.words_to_avoid.length > 0 && `Words it never uses: ${config.words_to_avoid.join(", ")}`,
    config.site && `Website: ${config.site}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** A colour name made safe: "Deep Teal!" becomes "deep-teal". */
export const tidyColorName = (value: string, index: number) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+|-+$/g, "")
    .slice(0, 20) || `colour-${index + 1}`;

/** "#abc", "ABCDEF" or "#AaBbCc" as a full lowercase hex, or null. */
export function tidyHex(value: string): string | null {
  const raw = value.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw
      .split("")
      .map((c) => c + c)
      .join("")
      .toLowerCase()}`;
  }
  return /^[0-9a-fA-F]{6}$/.test(raw) ? `#${raw.toLowerCase()}` : null;
}
