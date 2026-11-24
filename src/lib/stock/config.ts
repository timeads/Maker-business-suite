import { z } from "zod";

/**
 * How a workspace plans its stock. Data, like every other setting (CLAUDE.md
 * rule 4): stored in `configs` under module "stock" and parsed on every read.
 */
export const STOCK_MODULE = "stock";
export const STOCK_SETTINGS_KEY = "settings";

export const stockSettingsSchema = z.object({
  version: z.literal(1),
  /** Used for anything whose supplier (or lack of one) doesn't say. */
  default_lead_time_days: z.number().int().min(0).max(365).default(30),
  default_coverage_days: z.number().int().min(1).max(365).default(30),
  /** Slack between "should reorder" and "will run out": how often you sit down to order. */
  review_buffer_days: z.number().int().min(0).max(60).default(7),
  /** Order more ahead of the months that are busy every year. */
  seasonality: z.boolean().default(true),
  /** When a delivery is checked in, add it to the shop's own count too. */
  push_to_shop: z.boolean().default(false),
  /**
   * Never plan for an item whose name carries one of these (any capitals).
   * It works on read, so taking a word off brings the items straight back.
   */
  skip_words: z.array(z.string().trim().min(2).max(40)).max(20).default(["gift card"]),
});
export type StockSettings = z.infer<typeof stockSettingsSchema>;

export const DEFAULT_STOCK_SETTINGS: StockSettings = stockSettingsSchema.parse({ version: 1 });

export function parseStockSettings(body: unknown): StockSettings {
  const parsed = stockSettingsSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_STOCK_SETTINGS;
}

/**
 * Saved views of the reorder list: a view, a search, an order and the columns
 * on show, kept under a name for the whole workspace (as TuftStock keeps
 * them). One may be the view the list opens on.
 */
export const STOCK_VIEWS_KEY = "saved_views";
export const MAX_SAVED_VIEWS = 20;

export const savedViewSchema = z.object({
  id: z.string().regex(/^[a-z0-9]{6,16}$/),
  name: z.string().trim().min(1).max(40),
  /** One of the built-in views (lib/stock/views.ts); an unknown one opens "All". */
  view: z.string().max(20).default("all"),
  q: z.string().max(80).default(""),
  sort: z.string().max(20).default("orderBy"),
  dir: z.enum(["asc", "desc"]).default("asc"),
  /** The columns on show, by key. Empty means the usual ones. */
  columns: z.array(z.string().max(20)).max(30).default([]),
  /** The list opens on this view. */
  opens_first: z.boolean().default(false),
});
export type SavedView = z.infer<typeof savedViewSchema>;

export const savedViewsSchema = z.object({
  version: z.literal(1),
  views: z.array(savedViewSchema).max(MAX_SAVED_VIEWS).default([]),
});
export type SavedViews = z.infer<typeof savedViewsSchema>;
export const DEFAULT_SAVED_VIEWS: SavedViews = { version: 1, views: [] };

export function parseSavedViews(body: unknown): SavedViews {
  const parsed = savedViewsSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_SAVED_VIEWS;
}
