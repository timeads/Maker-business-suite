import { BRANDS } from "../design/brands";
import type { EmailDoc } from "../design/email-doc";
import { builtInTemplates, docFromTemplate, type EmailTemplate } from "../design/email-templates";
import { contrast, luminance, saturation, type BrandKitConfig } from "./kit";

/**
 * Emails in a workspace's own colours. The starter templates are drawn once
 * in the built-in look and then recoloured: every built-in colour is swapped
 * for the workspace's colour that does the same job, and the built-in name
 * and web address for the workspace's own. Nothing here is stored; a saved
 * email keeps its own styles.
 */

type Roles = { dark: string; light: string; primary: string; accent: string };

/** Which of the kit's colours does which job in an email. */
export function emailRoles(kit: BrandKitConfig): Roles {
  const byLight = [...kit.colors].sort((a, b) => luminance(a.hex) - luminance(b.hex));
  const dark = byLight[0].hex;
  const light = byLight[byLight.length - 1].hex;
  const primary = kit.colors[0].hex;
  const accent =
    kit.colors
      .map((c) => c.hex)
      .filter((hex) => hex !== primary && hex !== dark && hex !== light)
      .sort((a, b) => saturation(b) - saturation(a))[0] ?? (primary === dark ? light : dark);
  return { dark, light, primary, accent };
}

const readableOn = (bg: string, roles: Roles) =>
  contrast(bg, roles.dark) >= contrast(bg, roles.light) ? roles.dark : roles.light;

const TTW = BRANDS.ttw.palette;

function recolour<T>(value: T, kit: BrandKitConfig, roles: Roles): T {
  const swap: Record<string, string> = {
    [TTW.charcoal]: roles.dark,
    [TTW.natural]: roles.light,
    [TTW.royal]: roles.primary,
    [TTW.canary]: roles.accent,
  };
  const site = kit.site ? `https://${kit.site}` : "";
  const text = JSON.stringify(value)
    .replace(/#[0-9a-fA-F]{6}\b/g, (hex) => swap[hex.toLowerCase()] ?? hex)
    .replaceAll("https://tufttheworld.com", site)
    .replaceAll("tufttheworld.com", kit.site)
    // The name goes into JSON text, so it is escaped as JSON.
    .replaceAll("Tuft the World", JSON.stringify(kit.name).slice(1, -1));
  return JSON.parse(text) as T;
}

/** The starter templates in the workspace's colours, without the banner pictures. */
export function workspaceTemplates(kit: BrandKitConfig): EmailTemplate[] {
  const roles = emailRoles(kit);
  return builtInTemplates("ttw").map((template) => {
    const out = recolour(template, kit, roles);
    out.sections = out.sections
      .map((section) => ({
        ...section,
        // A banner is a drawn picture in the built-in look; a workspace starts without one.
        rows: section.rows.filter(
          (row) => !row.columns.some((col) => col.blocks.some((block) => block.type === "banner")),
        ),
      }))
      .filter((section) => section.rows.length > 0);
    // Words on a coloured band or button must be readable whatever the main colour is.
    for (const section of out.sections) {
      const bg = section.styles.contentBg;
      if (bg && /^#[0-9a-f]{6}$/i.test(bg)) {
        const ink = readableOn(bg, roles);
        if (section.styles.textColor) section.styles.textColor = ink;
        if (section.styles.linkColor) section.styles.linkColor = ink;
      }
    }
    const button = out.globalStyles.button;
    if (/^#[0-9a-f]{6}$/i.test(button.bg)) button.color = readableOn(button.bg, roles);
    return out;
  });
}

/** A new email for the workspace from one of its starters (the first when the id isn't one). */
export function newWorkspaceEmail(
  kit: BrandKitConfig,
  templateId: string | null,
  logo: string | null = null,
): EmailDoc {
  const templates = workspaceTemplates(kit);
  const template = templates.find((t) => t.id === templateId) ?? templates[0];
  return docFromTemplate(template, "other", { logo });
}
