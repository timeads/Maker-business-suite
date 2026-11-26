import { dashboardSchema, type DashboardConfig, type WidgetConfig } from "./schema";

export type TemplateKey = "maker_basics" | "wholesale_retail" | "lines_and_profit";

const raw: Record<TemplateKey, { blurb: string; config: unknown }> = {
  maker_basics: {
    blurb: "Sales, margin, best sellers and cash. A good start for most studios.",
    config: {
      version: 1,
      name: "Maker basics",
      range: "last_12_months",
      widgets: [
        { id: "figures", type: "key_figures", size: "full" },
        { id: "sales", type: "sales_over_time", size: "full" },
        { id: "margin", type: "gross_margin" },
        { id: "products", type: "top_products", limit: 5 },
        { id: "channels", type: "sales_by_channel" },
        { id: "cash", type: "cash_on_hand" },
        { id: "owed", type: "ar_aging", size: "full" },
      ],
    },
  },
  wholesale_retail: {
    blurb: "Leads with where sales come from and who owes you, for shops that sell both ways.",
    config: {
      version: 1,
      name: "Wholesale + retail",
      range: "last_12_months",
      widgets: [
        { id: "figures", type: "key_figures", size: "full" },
        { id: "channels", type: "sales_by_channel" },
        { id: "owed", type: "ar_aging" },
        { id: "sales", type: "sales_over_time", size: "full" },
        { id: "cash", type: "cash_on_hand" },
        { id: "margin", type: "gross_margin" },
        { id: "products", type: "top_products", limit: 10, size: "full" },
      ],
    },
  },
  lines_and_profit: {
    blurb:
      "Your business lines side by side: what each brings in, what it costs and what it makes.",
    config: {
      version: 1,
      name: "Lines and profit",
      range: "last_12_months",
      widgets: [
        { id: "figures", type: "key_figures", size: "full" },
        { id: "profit", type: "profit_by_line", size: "full" },
        { id: "lines-over-time", type: "revenue_by_line_over_time", size: "full" },
        { id: "lines", type: "revenue_by_line" },
        { id: "expenses", type: "expenses_by_line" },
        { id: "classes-ahead", type: "deferred_revenue" },
        { id: "cash", type: "cash_on_hand" },
        { id: "margin", type: "gross_margin" },
        { id: "owed", type: "ar_aging" },
      ],
    },
  },
};

export const TEMPLATE_ORDER: readonly TemplateKey[] = [
  "maker_basics",
  "wholesale_retail",
  "lines_and_profit",
];
export const DEFAULT_TEMPLATE: TemplateKey = "maker_basics";

export function isTemplateKey(value: unknown): value is TemplateKey {
  return typeof value === "string" && value in raw;
}

/** A template's dashboard, parsed like any stored config would be. */
export function templateConfig(key: TemplateKey): DashboardConfig {
  return dashboardSchema.parse(raw[key].config);
}

export function templateBlurb(key: TemplateKey): string {
  return raw[key].blurb;
}

/** The business-line widgets a standard layout gains once lines are set up. */
const LINE_WIDGETS: WidgetConfig[] = [
  { id: "lines-over-time", type: "revenue_by_line_over_time", size: "full", grouping: "auto" },
  { id: "lines", type: "revenue_by_line", size: "half" },
  { id: "classes-ahead", type: "deferred_revenue", size: "half" },
];

/**
 * A starting layout with the business-line widgets placed after the sales
 * chart (or after the first widget when there is none). Widgets already
 * there, by type or id, aren't added twice.
 */
export function withLineWidgets(config: DashboardConfig): DashboardConfig {
  const types = new Set(config.widgets.map((w) => w.type));
  const ids = new Set(config.widgets.map((w) => w.id));
  const adding = LINE_WIDGETS.filter((w) => !types.has(w.type) && !ids.has(w.id));
  if (adding.length === 0) return config;
  const after = config.widgets.findIndex((w) => w.type === "sales_over_time");
  const at = (after >= 0 ? after : 0) + 1;
  const widgets = [...config.widgets.slice(0, at), ...adding, ...config.widgets.slice(at)];
  return dashboardSchema.parse({ ...config, widgets: widgets.slice(0, 24) });
}
