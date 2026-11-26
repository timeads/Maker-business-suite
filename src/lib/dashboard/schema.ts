import { z } from "zod";

/**
 * Dashboards are data (CLAUDE.md rule 4): an ordered list of widget configs,
 * stored in `configs` under module "dashboard". Everything read from there is
 * parsed with these schemas before it is used.
 */

export const RANGE_PRESETS = [
  "last_30_days",
  "last_90_days",
  "last_6_months",
  "last_12_months",
  "this_year",
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export const RANGE_LABELS: Record<RangePreset, string> = {
  last_30_days: "30 days",
  last_90_days: "90 days",
  last_6_months: "6 months",
  last_12_months: "12 months",
  this_year: "This year",
};

const base = {
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  title: z.string().trim().min(1).max(60).optional(),
  size: z.enum(["half", "full"]).default("half"),
};

export const widgetSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("key_figures") }),
  z.object({
    ...base,
    type: z.literal("sales_over_time"),
    grouping: z.enum(["auto", "day", "week", "month"]).default("auto"),
  }),
  z.object({
    ...base,
    type: z.literal("gross_margin"),
    // auto: your books when QuickBooks is connected, otherwise item costs from the store.
    source: z.enum(["auto", "store", "books"]).default("auto"),
  }),
  z.object({
    ...base,
    type: z.literal("top_products"),
    limit: z.number().int().min(3).max(15).default(5),
  }),
  z.object({ ...base, type: z.literal("sales_by_channel") }),
  z.object({ ...base, type: z.literal("cash_on_hand") }),
  z.object({ ...base, type: z.literal("ar_aging") }),
  // Revenue split into the workspace's own business lines (Settings → Money).
  z.object({ ...base, type: z.literal("revenue_by_line") }),
  z.object({
    ...base,
    type: z.literal("revenue_by_line_over_time"),
    grouping: z.enum(["auto", "day", "week", "month"]).default("auto"),
  }),
  // What's already paid for classes still to come.
  z.object({ ...base, type: z.literal("deferred_revenue") }),
  // Each line's revenue less its costs, step by step (Settings → Money → Profit by line).
  z.object({ ...base, type: z.literal("profit_by_line") }),
  // The books' expenses as sorted into lines.
  z.object({ ...base, type: z.literal("expenses_by_line") }),
]);
export type WidgetConfig = z.infer<typeof widgetSchema>;
export type WidgetType = WidgetConfig["type"];

export const dashboardSchema = z
  .object({
    version: z.literal(1),
    name: z.string().trim().min(1).max(60),
    range: z.enum(RANGE_PRESETS).default("last_12_months"),
    widgets: z.array(widgetSchema).min(1).max(24),
  })
  .refine((d) => new Set(d.widgets.map((w) => w.id)).size === d.widgets.length, {
    message: "Each widget needs its own id",
  });
export type DashboardConfig = z.infer<typeof dashboardSchema>;

export const DASHBOARD_MODULE = "dashboard";
export const DASHBOARD_KEY = "main";
