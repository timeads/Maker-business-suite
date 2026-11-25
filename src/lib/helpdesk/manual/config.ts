import { z } from "zod";
import { TAG_PATTERN } from "../config";

/**
 * The manual: topics written up from finished conversations, and hand-written
 * articles beside them. What it is called, what its topics are sorted by,
 * which conversations feed it and how often it is brought up to date are all
 * a setting (`configs`, module "helpdesk", key "manual"), parsed with this
 * schema on every read. Nothing here knows what a business makes or mends:
 * a workspace that fixes machines calls it "Repair manual" and sorts by
 * "Machine"; another calls it "Care guide" and sorts by "Fabric".
 */
export const MANUAL_KEY = "manual";

const label = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^<>\n\r]*$/);

const facetSchema = z.object({
  /** What topics store: stays the same when the label is reworded. */
  id: z.string().regex(/^[a-z0-9-]{1,20}$/),
  /** What people read: "Machine", "Symptom". */
  label: label(30),
});
export type ManualFacet = z.infer<typeof facetSchema>;

const sourcesSchema = z.object({
  /** Conversations filed in any of these folders. */
  folders: z.array(z.string().uuid()).max(10).default([]),
  /** Conversations a saved view would show (its status and "mine" conditions are left out). */
  views: z
    .array(z.string().regex(/^[a-z0-9-]{1,40}$/))
    .max(10)
    .default([]),
  /** Conversations carrying any of these tags. */
  tags: z.array(z.string().trim().toLowerCase().regex(TAG_PATTERN)).max(10).default([]),
});
export type ManualSources = z.infer<typeof sourcesSchema>;

/** The most conversations a month a workspace can ask to have read. */
export const MAX_MONTHLY_CAP = 1000;

export const manualConfigSchema = z.object({
  version: z.literal(1),
  /** The name on the menu and at the top of the page. */
  name: label(40).default("Manual"),
  /** The name of the first tab: "Topics", "Repair topics". */
  topics_label: label(30).default("Topics"),
  /** In a sentence, what belongs in it. Told to Claude so it knows what is worth writing down. */
  about: z
    .string()
    .trim()
    .max(300)
    .regex(/^[^<>]*$/)
    .default(""),
  /** What topics are sorted and filtered by. */
  facets: z
    .array(facetSchema)
    .max(4)
    .default([
      { id: "product", label: "Product" },
      { id: "problem", label: "Problem" },
    ])
    .refine((list) => new Set(list.map((f) => f.id)).size === list.length),
  /** The headings a topic is written under, in order. */
  sections: z
    .array(label(40))
    .min(1)
    .max(8)
    .default(["What people notice", "Likely causes", "What to do", "Parts & tools", "Notes"])
    .refine((list) => new Set(list.map((s) => s.toLowerCase())).size === list.length),
  sources: sourcesSchema.default({ folders: [], views: [], tags: [] }),
  /** Whether the worker reads new source conversations without being asked. */
  auto: z.boolean().default(false),
  every: z.enum(["day", "week"]).default("day"),
  /** The most conversations read in a calendar month, by itself or on "Update now". 0 reads none. */
  monthly_cap: z.number().int().min(0).max(MAX_MONTHLY_CAP).default(100),
  /** Whether the customer's photos are shown to Claude with their conversation. */
  read_photos: z.boolean().default(true),
  /** Whether published topics are handed to the "AI" reply draft as reference. */
  use_in_drafts: z.boolean().default(true),
});
export type ManualConfig = z.infer<typeof manualConfigSchema>;

export const DEFAULT_MANUAL: ManualConfig = manualConfigSchema.parse({ version: 1 });

export function parseManual(body: unknown): ManualConfig {
  const parsed = manualConfigSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_MANUAL;
}

/** Whether anything at all has been chosen to feed the manual. */
export const hasSources = (sources: ManualSources): boolean =>
  sources.folders.length + sources.views.length + sources.tags.length > 0;

/** "Search topics, machines and symptoms": the search box's hint, from the workspace's own words. */
export function searchHint(config: ManualConfig): string {
  const words = [
    config.topics_label.toLowerCase(),
    ...config.facets.map((f) => f.label.toLowerCase()),
  ];
  return `Search ${words.join(", ")}`;
}

/** A topic's facet values as stored: which facet, and the value typed for it. */
export const topicFacetsSchema = z
  .array(
    z.object({
      facet: z.string().regex(/^[a-z0-9-]{1,20}$/),
      value: z
        .string()
        .trim()
        .min(1)
        .max(60)
        .regex(/^[^<>\n\r]*$/),
    }),
  )
  .max(16);
export type TopicFacets = z.infer<typeof topicFacetsSchema>;

export function parseTopicFacets(value: unknown): TopicFacets {
  const parsed = topicFacetsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** Values typed in one box ("Model A, Model B") as facet rows, without repeats. */
export function facetValues(facet: string, typed: string): TopicFacets {
  const seen = new Set<string>();
  const out: TopicFacets = [];
  for (const part of typed.split(/[,\n]/)) {
    const value = part.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    out.push({ facet, value });
  }
  return out.slice(0, 6);
}
