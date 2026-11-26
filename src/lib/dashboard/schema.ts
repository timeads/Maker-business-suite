import { z } from "zod";

/**
 * Dashboards are data (CLAUDE.md rule 4): an ordered list of widget configs,
 * stored in `configs` under module "dashboard". Everything read from there is
 * parsed with these schemas before it is used.
 */

export const RANGE_PRESETS = [
  "this_month",
  "last_month",
  "last_30_days",
  "last_90_days",
  "this_quarter",
  "last_quarter",
  "last_6_months",
  "last_12_months",
  "this_year",
  "last_year",
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export const RANGE_LABELS: Record<RangePreset, string> = {
  this_month: "This month",
  last_month: "Last month",
  last_30_days: "30 days",
  last_90_days: "90 days",
  this_quarter: "This quarter",
  last_quarter: "Last quarter",
  last_6_months: "6 months",
  last_12_months: "12 months",
  this_year: "Year to date",
  last_year: "Last year",
};

/** The range in a sentence: "over the last 30 days", "last month", "this quarter so far". */
export const RANGE_PHRASES: Record<RangePreset, string> = {
  this_month: "this month so far",
  last_month: "last month",
  last_30_days: "over the last 30 days",
  last_90_days: "over the last 90 days",
  this_quarter: "this quarter so far",
  last_quarter: "last quarter",
  last_6_months: "over the last 6 months",
  last_12_months: "over the last 12 months",
  this_year: "this year so far",
  last_year: "last year",
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
  // Cash health, from the books (Settings → Money → Cash health).
  z.object({ ...base, type: z.literal("health_check") }),
  z.object({ ...base, type: z.literal("runway") }),
  z.object({ ...base, type: z.literal("revenue_growth") }),
  z.object({ ...base, type: z.literal("cash_flow") }),
  z.object({ ...base, type: z.literal("operating_profit") }),
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
