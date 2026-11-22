import { dashboardSchema, type DashboardConfig } from "./schema";

export type TemplateKey = "maker_basics" | "wholesale_retail";

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
};

export const TEMPLATE_ORDER: readonly TemplateKey[] = ["maker_basics", "wholesale_retail"];
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
