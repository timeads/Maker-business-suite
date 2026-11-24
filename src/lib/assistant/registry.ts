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
  DEFAULT_LINKS,
  DEFAULT_PLAN,
  LINKS_KEY,
  PLAN_KEY,
  SOCIAL_MODULE,
  WEEKDAY_NAMES,
  linkPageSchema,
  socialPlanSchema,
} from "../social/plan";
import { APPEARANCE_KEY, DEFAULT_APPEARANCE, appearanceSchema } from "../brand/appearance";
import { BRAND_MODULE, KIT_KEY, brandKitSchema } from "../brand/kit";
import {
  DEFAULT_SHIPPING_SETTINGS,
  DEFAULT_SLIP_LAYOUT,
  SHIPPING_MODULE,
  SHIPPING_SETTINGS_KEY,
  SLIP_LAYOUT_KEY,
  SLIP_SECTION_NAMES,
  shippingSettingsSchema,
  slipLayoutSchema,
} from "../shipping/config";
import { DEFAULT_SHIPPING_RULES, SHIPPING_RULES_KEY, shippingRulesSchema } from "../shipping/rules";
import {
  DEFAULT_SAVED_VIEWS,
  DEFAULT_STOCK_SETTINGS,
  STOCK_MODULE,
  STOCK_SETTINGS_KEY,
  STOCK_VIEWS_KEY,
  savedViewsSchema,
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
      "The lead time and days of cover used when a supplier doesn't say, how often orders are reviewed, whether busy seasons are planned for, whether checked-in deliveries are added to the shop's count, and the words in an item's name that mean it is never reordered (gift cards and the like).",
    schema: stockSettingsSchema,
    defaultBody: () => DEFAULT_STOCK_SETTINGS,
  },
  {
    module: STOCK_MODULE,
    key: STOCK_VIEWS_KEY,
    feature: "stock",
    name: "Saved views of the reorder list",
    description:
      "Named views of Stock's Everything list, shared by the whole workspace: which built-in view (all, onorder, nosales, hidden, atrisk, out, under, healthy, over, nosupplier), a search, the column it is sorted by and which way, the columns on show, and whether the list opens on it (opens_first, at most one). Each view needs a short id of lowercase letters and digits.",
    schema: savedViewsSchema,
    defaultBody: () => DEFAULT_SAVED_VIEWS,
  },
  {
    module: SHIPPING_MODULE,
    key: SHIPPING_SETTINGS_KEY,
    feature: "shipping",
    name: "Shipping and packing slips",
    description:
      "The address parcels are sent from (printed on packing slips and used as the return address on postage labels: name, street, town, state, postcode and phone), the country parcels leave from (anything going elsewhere counts as international), the usual carrier, whether recording a parcel also marks the order as sent in the shop and emails the customer, the order total from which a signature is asked for (signature_over), and whether packings are remembered for the same items or for the same products in other quantities (remember_packing).",
    schema: shippingSettingsSchema,
    defaultBody: () => DEFAULT_SHIPPING_SETTINGS,
  },
  {
    module: SHIPPING_MODULE,
    key: SHIPPING_RULES_KEY,
    feature: "shipping",
    name: "Shipping rules",
    description:
      "An ordered list of rules for orders waiting to ship. Each rule has an id, a name, enabled (on or off), conditions that must all match, and actions. A condition has a field (item_quantity, order_total, product_names, product_skus, destination_state, destination_country, shipping_service), an op (eq, gt, lt for the two numbers; includes_any, excludes, contains for the lists) and a value (a number, or names or codes with commas between). An action has a type and a value: set_package (a box's name exactly as in Shipping settings), require_signature (standard or adult), set_service (cheapest, fastest, or a service's name like UPS Ground), place_hold (a note saying why). For each kind of action the first matching rule from the top wins. A choice a person makes on an order always comes before a rule.",
    schema: shippingRulesSchema,
    defaultBody: () => DEFAULT_SHIPPING_RULES,
  },
  {
    module: SHIPPING_MODULE,
    key: SLIP_LAYOUT_KEY,
    feature: "shipping",
    name: "Packing slip layout",
    description:
      "Which sections a packing slip shows and in what order (ship-to address, shipping method, items, order note, thank-you message, order barcode), whether items show their code and price, the text size, the thank-you message and the footer line.",
    schema: slipLayoutSchema,
    defaultBody: () => DEFAULT_SLIP_LAYOUT,
  },
  {
    module: SOCIAL_MODULE,
    key: PLAN_KEY,
    feature: "social",
    name: "Social content plan",
    description:
      "The topics the business posts about, the times of the week it likes to post (each with its usual topic), and notes on its voice that drafts follow.",
    schema: socialPlanSchema,
    defaultBody: () => DEFAULT_PLAN,
  },
  {
    module: SOCIAL_MODULE,
    key: LINKS_KEY,
    feature: "social",
    name: "Link page",
    description:
      "The public page of links for a social profile: its heading, a short intro, the links (https only), whether recent posts show, and whether it is published.",
    schema: linkPageSchema,
    defaultBody: () => DEFAULT_LINKS,
  },
  {
    module: BRAND_MODULE,
    key: KIT_KEY,
    feature: "social",
    name: "Brand kit",
    description:
      "The brand's name, tagline, what it makes, its named colours (hex, main colour first, one dark and one light), its overall feel, and how it sounds: voice notes, words it likes and words it never uses. Drafts of posts and emails follow it.",
    schema: brandKitSchema,
    defaultBody: () => ({
      version: 1,
      name: "Your brand",
      colors: [
        { name: "ink", hex: "#1f2a2e" },
        { name: "paper", hex: "#f7f3ea" },
      ],
    }),
  },
  {
    module: BRAND_MODULE,
    key: APPEARANCE_KEY,
    feature: "social",
    name: "Appearance",
    description:
      "How the workspace looks to its team: mode is light (dark menu, light page), dark, or device (follows each person's device); brand_colors puts the brand kit's colours on the menu and main buttons.",
    schema: appearanceSchema,
    defaultBody: () => DEFAULT_APPEARANCE,
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
  if (entry.module === SOCIAL_MODULE && entry.key === PLAN_KEY) {
    const topics = list("topics") as { id: string; name: string }[];
    const slots = list("slots") as { weekday: number; time: string; topic: string | null }[];
    const notes = String(value.style_notes ?? "").replace(/\s+/g, " ");
    return [
      `Topics: ${topics.map((t) => t.name).join(", ") || "none yet"}`,
      ...slots.map(
        (slot) =>
          `${WEEKDAY_NAMES[slot.weekday]} ${slot.time}: ${topics.find((t) => t.id === slot.topic)?.name ?? "anything"}`,
      ),
      `Voice notes: ${notes ? `"${notes.slice(0, 120)}${notes.length > 120 ? "…" : ""}"` : "none"}`,
    ];
  }
  if (entry.module === SOCIAL_MODULE && entry.key === LINKS_KEY) {
    const links = list("links") as { label: string; url: string }[];
    return [
      value.published ? "Published" : "Not published",
      `Heading: ${value.heading || "(the business name)"}`,
      ...links.map((link) => `${link.label} → ${link.url}`),
      value.show_posts ? "Shows recent posts" : "Links only",
    ];
  }
  if (entry.module === SHIPPING_MODULE && entry.key === SLIP_LAYOUT_KEY) {
    const sections = list("sections") as { id: keyof typeof SLIP_SECTION_NAMES; on?: boolean }[];
    const clip = (text: unknown) => {
      const t = String(text ?? "").replace(/\s+/g, " ");
      return t ? `"${t.slice(0, 90)}${t.length > 90 ? "…" : ""}"` : "nothing";
    };
    return [
      `Shows, top to bottom: ${
        sections
          .filter((section) => section.on !== false)
          .map((section) => SLIP_SECTION_NAMES[section.id] ?? section.id)
          .join(", ") || "nothing"
      }`,
      `Items show: ${[value.show_sku ? "codes" : null, value.show_price ? "prices" : null].filter(Boolean).join(" and ") || "names only"}`,
      `Text size: ${value.text_size}`,
      `Thank-you message: ${clip(value.message)}`,
      `Footer: ${clip(value.footer)}`,
    ];
  }
  if (entry.module === SHIPPING_MODULE) {
    const from = (value.ship_from ?? {}) as Record<string, string>;
    return [
      `Slips and labels are from: ${
        [
          from.name,
          from.address1,
          [from.city, [from.region, from.postal_code].filter(Boolean).join(" ")]
            .filter(Boolean)
            .join(", ") || from.city_line,
        ]
          .filter(Boolean)
          .join(", ") || "no address yet"
      }`,
      `Parcels leave from: ${value.ship_from_country ?? "US"}`,
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
