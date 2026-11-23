import { z } from "zod";
import { emailRoles } from "./email";
import { contrast, luminance, type BrandKitConfig } from "./kit";

/**
 * How a workspace looks to its own team: a light page, a dark one, or
 * whatever each person's device is set to, and whether the menu and buttons
 * wear the brand's colours. A setting like any other (`configs`, module
 * "brand").
 */
export const APPEARANCE_KEY = "appearance";

export const appearanceSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["light", "dark", "device"]).default("light"),
  brand_colors: z.boolean().default(false),
});
export type Appearance = z.infer<typeof appearanceSchema>;
export const DEFAULT_APPEARANCE: Appearance = { version: 1, mode: "light", brand_colors: false };

export function parseAppearance(body: unknown): Appearance {
  const parsed = appearanceSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_APPEARANCE;
}

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
/** A colour moved part of the way toward another. */
export function mix(from: string, to: string, amount: number): string {
  const a = channels(from);
  const b = channels(to);
  return `#${a
    .map((value, i) =>
      Math.round(value + (b[i] - value) * amount)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Steps a colour toward black or white until text of that colour reads on the background. */
function readable(color: string, background: string, toward: string): string {
  let out = color;
  for (let step = 0; step < 12 && contrast(out, background) < 4.5; step++) {
    out = mix(out, toward, 0.15);
  }
  return out;
}

/**
 * The brand's colours as the handful of variables the interface is drawn
 * from: the menu, and the one filled button. Everything else (page, cards,
 * text, warnings) stays the house style so screens remain readable whatever
 * colours a brand has. Returns nothing when the kit has no colours to use.
 */
export function brandThemeVars(kit: BrandKitConfig | null): Record<string, string> {
  if (!kit) return {};
  const roles = emailRoles(kit);
  const vars: Record<string, string> = {};

  // The menu wants a dark ground with light words on it.
  const menu = luminance(roles.dark) <= 0.12 ? roles.dark : mix(roles.dark, "#000000", 0.6);
  if (contrast(menu, "#f3efe9") >= 7) {
    vars["--tuft-teal"] = menu;
    vars["--tuft-teal-2"] = mix(menu, "#ffffff", 0.08);
    vars["--tuft-teal-3"] = mix(menu, "#ffffff", 0.16);
    vars["--tuft-teal-ink"] = mix(menu, "#000000", 0.2);
  }

  // The filled button: the brand's liveliest colour, with words that read on it.
  const button =
    roles.accent !== roles.dark && roles.accent !== roles.light ? roles.accent : roles.primary;
  if (button !== roles.light && contrast(button, "#ffffff") >= 1.6) {
    const on = contrast(button, "#1a2c2c") >= contrast(button, "#ffffff") ? "#1a2c2c" : "#ffffff";
    vars["--tuft-ochre"] = button;
    vars["--tuft-ochre-hover"] = mix(button, "#000000", 0.12);
    vars["--tuft-on-ochre"] = on;
    // The same colour used as text (links, the active tab) on a light page.
    vars["--tuft-ochre-text"] = readable(button, "#ffffff", "#000000");
    vars["--tuft-ochre-soft"] = mix(button, "#ffffff", 0.85);
  }
  return vars;
}

/** The same, adjusted for a dark page, where text colours must go lighter instead. */
export function brandThemeVarsDark(kit: BrandKitConfig | null): Record<string, string> {
  const vars = brandThemeVars(kit);
  if (vars["--tuft-ochre"]) {
    vars["--tuft-ochre-text"] = readable(vars["--tuft-ochre"], "#211f1d", "#ffffff");
    vars["--tuft-ochre-soft"] = mix(vars["--tuft-ochre"], "#1a1918", 0.8);
  }
  return vars;
}
