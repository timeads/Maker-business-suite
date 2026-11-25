import { z } from "zod";

/**
 * The help centre: public pages customers can read, drawn from the manual's
 * published help articles. Whether it is on, what it is called and how its
 * articles are grouped is a setting (`configs`, module "helpdesk", key
 * "help_centre"), parsed with this schema on every read. Nothing here knows
 * what a business sells.
 */
export const HELP_CENTRE_KEY = "help_centre";

const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(/^[^<>\n\r]*$/);

const categorySchema = z.object({
  /** What articles store: stays the same when the label is reworded. */
  id: z.string().regex(/^[a-z0-9-]{1,30}$/),
  label: line(40).min(1),
});
export type HelpCategory = z.infer<typeof categorySchema>;

export const helpCentreConfigSchema = z.object({
  version: z.literal(1),
  /** Off until an owner or admin switches it on: while off, every public page answers "not found". */
  on: z.boolean().default(false),
  /** The heading on the home page. Empty: "<Workspace> help". */
  title: line(60).default(""),
  /** A line under the heading. */
  intro: line(200).default(""),
  /** How articles are grouped on the home page, in this order. */
  categories: z
    .array(categorySchema)
    .max(12)
    .default([])
    .refine((list) => new Set(list.map((c) => c.id)).size === list.length),
  /** The sentence beside the contact address: "Still stuck? Write to us." */
  contact_line: line(160).default("Still stuck? Write to us and we'll help."),
  /** Where customers write. Empty: the workspace's own support address. */
  contact_email: z
    .union([z.literal(""), z.string().trim().toLowerCase().email().max(120)])
    .default(""),
  /** Asks search engines to leave the pages out. */
  noindex: z.boolean().default(false),
});
export type HelpCentreConfig = z.infer<typeof helpCentreConfigSchema>;

export const DEFAULT_HELP_CENTRE: HelpCentreConfig = helpCentreConfigSchema.parse({ version: 1 });

/** A stored setting, or the defaults (which are "off") when it isn't one. */
export function parseHelpCentre(body: unknown): HelpCentreConfig {
  const parsed = helpCentreConfigSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_HELP_CENTRE;
}

/** "Orders & delivery" -> "orders-delivery": a category's id from its label. */
export function categoryId(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30)
      .replace(/-+$/, "") || "category"
  );
}

/**
 * Category lines typed one per row, as categories. A line that was already
 * there (same label, any letter case) keeps its id, so its articles stay put.
 */
export function categoriesFrom(lines: string[], now: HelpCategory[]): HelpCategory[] {
  const out: HelpCategory[] = [];
  const used = new Set<string>();
  for (const raw of lines) {
    const label = raw.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!label || out.some((c) => c.label.toLowerCase() === label.toLowerCase())) continue;
    const kept = now.find((c) => c.label.toLowerCase() === label.toLowerCase())?.id;
    let id = kept && !used.has(kept) ? kept : categoryId(label);
    for (let n = 2; used.has(id); n += 1) id = `${categoryId(label).slice(0, 27)}-${n}`;
    used.add(id);
    out.push({ id, label });
  }
  return out.slice(0, 12);
}

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** What a person typed for an address, tidied the way the database would make one. */
export function tidySlug(typed: string): string {
  return typed
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
}

/** The address of a workspace's help centre, and of one article in it. */
export const helpCentrePath = (workspace: string, article?: string) =>
  `/help-centre/${workspace}${article ? `/${article}` : ""}`;
