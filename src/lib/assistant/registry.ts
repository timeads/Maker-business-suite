import { z } from "zod";
import {
  BOOKINGS_MODULE,
  DEFAULT_EMAILS,
  EMAILS_KEY,
  DEFAULT_FORM,
  FORM_KEY,
  bookingEmailsSchema,
  bookingFormSchema,
} from "../bookings/config";
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
import {
  DEFAULT_SHIPPING_SETTINGS,
  SHIPPING_MODULE,
  SHIPPING_SETTINGS_KEY,
  shippingSettingsSchema,
} from "../shipping/config";
import {
  DEFAULT_STOCK_SETTINGS,
  STOCK_MODULE,
  STOCK_SETTINGS_KEY,
  stockSettingsSchema,
} from "../stock/config";

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
    name: "Help desk rules for new email",
    description:
      "Words to look for in incoming email, and what each match does: add a tag, set the priority (low, high, urgent), or both.",
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
  {
    module: BOOKINGS_MODULE,
    key: EMAILS_KEY,
    feature: "bookings",
    name: "Booking emails",
    description:
      "How many hours ahead the reminder goes out, whether a thank-you is sent afterwards, and the business's own note added to the confirmation, reminder and thank-you emails.",
    schema: bookingEmailsSchema,
    defaultBody: () => DEFAULT_EMAILS,
  },
  {
    module: STOCK_MODULE,
    key: STOCK_SETTINGS_KEY,
    feature: "stock",
    name: "Stock planning",
    description:
      "The lead time and days of cover used when a supplier doesn't say, how often orders are reviewed, whether busy seasons are planned for, and whether checked-in deliveries are added to the shop's count.",
    schema: stockSettingsSchema,
    defaultBody: () => DEFAULT_STOCK_SETTINGS,
  },
  {
    module: SHIPPING_MODULE,
    key: SHIPPING_SETTINGS_KEY,
    feature: "shipping",
    name: "Shipping and packing slips",
    description:
      "The return address and note printed on packing slips, the usual carrier, and whether recording a parcel also marks the order as sent in the shop and emails the customer.",
    schema: shippingSettingsSchema,
    defaultBody: () => DEFAULT_SHIPPING_SETTINGS,
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
    const rules = list("rules") as {
      contains: string;
      where: string;
      tag?: string;
      priority?: string;
      assign_to?: string;
    }[];
    const place: Record<string, string> = {
      anywhere: "subject or message",
      body: "message",
      subject: "subject",
      from: "sender's address",
    };
    return rules.length
      ? rules.map(
          (r) =>
            `"${r.contains}" in the ${place[r.where] ?? r.where} → ${[
              r.tag ? `tag "${r.tag}"` : "",
              r.priority ? `mark ${r.priority}` : "",
              r.assign_to ? "hand to a teammate" : "",
            ]
              .filter(Boolean)
              .join(", ")}`,
        )
      : ["No rules"];
  }
  if (entry.module === SHIPPING_MODULE) {
    const from = (value.ship_from ?? {}) as Record<string, string>;
    const clip = (text: unknown) => {
      const t = String(text ?? "").replace(/\s+/g, " ");
      return t ? `"${t.slice(0, 90)}${t.length > 90 ? "…" : ""}"` : "nothing";
    };
    return [
      `Slips are from: ${[from.name, from.address1, from.city_line].filter(Boolean).join(", ") || "no address yet"}`,
      `Note at the bottom of each slip: ${clip(value.slip_note)}`,
      value.slip_show_sku ? "Slips show item codes" : "Slips leave item codes off",
      `Usual carrier: ${value.default_carrier}`,
      value.mark_sent_in_shop
        ? `Parcels are marked as sent in the shop${value.notify_customer ? ", and the shop emails the customer" : ""}`
        : "Orders are marked as sent in the shop by hand",
    ];
  }
  if (entry.module === STOCK_MODULE) {
    return [
      `Lead time when a supplier doesn't say: ${value.default_lead_time_days} days`,
      `Each order should cover: ${value.default_coverage_days} days of sales`,
      `Orders are reviewed every ${value.review_buffer_days} days`,
      value.seasonality ? "Plans ahead for busy seasons" : "Doesn't adjust for seasons",
      value.push_to_shop
        ? "Checked-in deliveries are added to the shop's count"
        : "The shop's count is kept by hand",
    ];
  }
  if (entry.key === EMAILS_KEY) {
    const clip = (text: unknown) => {
      const t = String(text ?? "").replace(/\s+/g, " ");
      return t ? `"${t.slice(0, 90)}${t.length > 90 ? "…" : ""}"` : "nothing added";
    };
    return [
      `Reminder goes out ${value.reminder_hours} hours before`,
      value.followup_on
        ? `Thank-you goes out ${value.followup_hours} hours after`
        : "No thank-you email afterwards",
      `Added to the confirmation: ${clip(value.confirmation_note)}`,
      `Added to the reminder: ${clip(value.reminder_note)}`,
      `Thank-you message: ${clip(value.followup_message)}`,
    ];
  }
  const questions = list("questions") as { label: string; required: boolean }[];
  return questions.length
    ? questions.map((q) => `${q.label}${q.required ? " (must be answered)" : " (optional)"}`)
    : ["No extra questions"];
}
