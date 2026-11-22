import { z } from "zod";
import { BOOKINGS_MODULE, DEFAULT_FORM, FORM_KEY, bookingFormSchema } from "../bookings/config";
import { DASHBOARD_KEY, DASHBOARD_MODULE, dashboardSchema } from "../dashboard/schema";
import { DEFAULT_TEMPLATE, templateConfig } from "../dashboard/templates";
import {
  DEFAULT_RULES,
  DEFAULT_TEMPLATES,
  HELPDESK_MODULE,
  RULES_KEY,
  TEMPLATES_KEY,
  autoTagRulesSchema,
  replyTemplatesSchema,
} from "../helpdesk/config";
import type { ModuleKey } from "../modules";

/**
 * Every setting the assistant may read or propose a change to. Anything not
 * listed here doesn't exist as far as it is concerned, and a proposal is only
 * filed once its body passes the same Zod schema the app reads it with.
 */
export type ConfigEntry = {
  module: string;
  key: string;
  /** The tool the setting belongs to, for plan checks. */
  feature: ModuleKey;
  name: string;
  description: string;
  schema: z.ZodType;
  defaultBody: () => unknown;
};

export const CONFIG_REGISTRY: readonly ConfigEntry[] = [
  {
    module: DASHBOARD_MODULE,
    key: DASHBOARD_KEY,
    feature: "dashboard",
    name: "Money dashboard",
    description:
      "Which charts and figures appear on the Money page, in what order and size, and the default date range.",
    schema: dashboardSchema,
    defaultBody: () => templateConfig(DEFAULT_TEMPLATE),
  },
  {
    module: HELPDESK_MODULE,
    key: TEMPLATES_KEY,
    feature: "helpdesk",
    name: "Help desk saved replies",
    description: "Reusable reply texts the team can drop into an email to a customer.",
    schema: replyTemplatesSchema,
    defaultBody: () => DEFAULT_TEMPLATES,
  },
  {
    module: HELPDESK_MODULE,
    key: RULES_KEY,
    feature: "helpdesk",
    name: "Help desk auto-tag rules",
    description: "Words to look for in incoming email and the tag each one adds.",
    schema: autoTagRulesSchema,
    defaultBody: () => DEFAULT_RULES,
  },
  {
    module: BOOKINGS_MODULE,
    key: FORM_KEY,
    feature: "bookings",
    name: "Booking form questions",
    description:
      "Extra questions customers answer when they book (name and email are always asked).",
    schema: bookingFormSchema,
    defaultBody: () => DEFAULT_FORM,
  },
];

export function findConfig(module: unknown, key: unknown): ConfigEntry | null {
  return CONFIG_REGISTRY.find((entry) => entry.module === module && entry.key === key) ?? null;
}

/** The shape a setting must have, in a form the model can read. */
export function configJsonSchema(entry: ConfigEntry): unknown {
  return z.toJSONSchema(entry.schema, { io: "input", unrepresentable: "any" });
}

/** Checks a proposed body. Returns the cleaned value or the problems, in words. */
export function validateConfig(
  entry: ConfigEntry,
  body: unknown,
): { ok: true; body: Record<string, unknown> } | { ok: false; problems: string[] } {
  const parsed = entry.schema.safeParse(body);
  if (parsed.success) return { ok: true, body: parsed.data as Record<string, unknown> };
  return {
    ok: false,
    problems: parsed.error.issues
      .slice(0, 10)
      .map((issue) => `${issue.path.join(".") || "(top level)"}: ${issue.message}`),
  };
}

const WIDGET_NAMES: Record<string, string> = {
  key_figures: "Key figures",
  sales_over_time: "Sales over time",
  gross_margin: "Gross margin",
  top_products: "Top products",
  sales_by_channel: "Sales by channel",
  cash_on_hand: "Cash on hand",
  ar_aging: "Money you're owed",
};

/**
 * A setting's value as plain lines a maker can read, for the before/after
 * preview. Falls back to the default when the stored value is missing.
 */
export function describeConfig(entry: ConfigEntry, body: unknown): string[] {
  const parsed = entry.schema.safeParse(body);
  const value = (parsed.success ? parsed.data : entry.defaultBody()) as Record<string, unknown>;
  const list = (name: string) => (Array.isArray(value[name]) ? (value[name] as never[]) : []);

  if (entry.module === DASHBOARD_MODULE) {
    const widgets = list("widgets") as {
      type: string;
      title?: string;
      size?: string;
      limit?: number;
    }[];
    return [
      `Default range: ${String(value.range ?? "").replace(/_/g, " ")}`,
      ...widgets.map(
        (w, i) =>
          `${i + 1}. ${w.title ?? WIDGET_NAMES[w.type] ?? w.type}${w.title ? ` (${WIDGET_NAMES[w.type] ?? w.type})` : ""}, ${w.size === "full" ? "full width" : "half width"}${w.limit ? `, top ${w.limit}` : ""}`,
      ),
    ];
  }
  if (entry.key === TEMPLATES_KEY) {
    const templates = list("templates") as { name: string; body: string }[];
    return templates.length
      ? templates.map(
          (t) =>
            `${t.name}: ${t.body.replace(/\s+/g, " ").slice(0, 90)}${t.body.length > 90 ? "…" : ""}`,
        )
      : ["No saved replies"];
  }
  if (entry.key === RULES_KEY) {
    const rules = list("rules") as { contains: string; where: string; tag: string }[];
    return rules.length
      ? rules.map(
          (r) =>
            `"${r.contains}" in the ${r.where === "anywhere" ? "subject or message" : r.where === "body" ? "message" : "subject"} → tag "${r.tag}"`,
        )
      : ["No rules"];
  }
  const questions = list("questions") as { label: string; required: boolean }[];
  return questions.length
    ? questions.map((q) => `${q.label}${q.required ? " (must be answered)" : " (optional)"}`)
    : ["No extra questions"];
}
