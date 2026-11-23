import { z } from "zod";

/**
 * How a workspace packs and posts. Data, like every other setting: stored in
 * `configs` under module "shipping" and parsed on every read.
 */
export const SHIPPING_MODULE = "shipping";
export const SHIPPING_SETTINGS_KEY = "settings";

const line = z.string().trim().max(120);

export const shippingSettingsSchema = z.object({
  version: z.literal(1),
  /** Printed at the top of every packing slip. */
  ship_from: z
    .object({
      name: line.default(""),
      address1: line.default(""),
      address2: line.default(""),
      city_line: line.default(""),
      country: line.default(""),
    })
    .default({ name: "", address1: "", address2: "", city_line: "", country: "" }),
  /** Where parcels leave from, as a two-letter country code. Anything going elsewhere is international. */
  ship_from_country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/)
    .default("US"),
  /**
   * Older: the note and item-code switch from before slips had their own
   * layout (`slip_layout`). Read only until a workspace saves a layout.
   */
  slip_note: z.string().trim().max(600).default(""),
  slip_show_sku: z.boolean().default(true),
  /** The carrier picked for you when you record a parcel. */
  default_carrier: z.string().trim().max(60).default("USPS"),
  /** When a parcel is recorded, mark the order as sent in the shop too. */
  mark_sent_in_shop: z.boolean().default(false),
  /** ...and have the shop email the customer their tracking number. */
  notify_customer: z.boolean().default(true),
});
export type ShippingSettings = z.infer<typeof shippingSettingsSchema>;

export const DEFAULT_SHIPPING_SETTINGS: ShippingSettings = shippingSettingsSchema.parse({
  version: 1,
});

export function parseShippingSettings(body: unknown): ShippingSettings {
  const parsed = shippingSettingsSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_SHIPPING_SETTINGS;
}

/**
 * What a packing slip shows and in what order. Its own config, so the layout
 * can change without touching how parcels are recorded.
 */
export const SLIP_LAYOUT_KEY = "slip_layout";

export const SLIP_SECTIONS = ["shipto", "method", "items", "note", "message", "barcode"] as const;
export type SlipSection = (typeof SLIP_SECTIONS)[number];

export const SLIP_SECTION_NAMES: Record<SlipSection, string> = {
  shipto: "Ship-to address",
  method: "Shipping method",
  items: "Items",
  note: "Order note",
  message: "Thank-you message",
  barcode: "Order barcode",
};

export const SLIP_TEXT_SIZES = ["small", "normal", "large"] as const;

const ALL_SECTIONS = SLIP_SECTIONS.map((id) => ({ id, on: true }));

export const slipLayoutSchema = z.object({
  version: z.literal(1),
  /** Top to bottom. A section left out of the list is added at the end, switched on. */
  sections: z
    .array(z.object({ id: z.enum(SLIP_SECTIONS), on: z.boolean().default(true) }))
    .max(SLIP_SECTIONS.length)
    .refine((list) => new Set(list.map((section) => section.id)).size === list.length, {
      message: "Each section can only be listed once.",
    })
    .default(ALL_SECTIONS),
  /** Item codes, for whoever is picking. */
  show_sku: z.boolean().default(true),
  /** What the shopper paid for each line. Leave off for gifts. */
  show_price: z.boolean().default(false),
  text_size: z.enum(SLIP_TEXT_SIZES).default("normal"),
  /** A thank-you, care notes: printed under the items. */
  message: z.string().trim().max(600).default(""),
  /** One small line at the very bottom: a web address, how to return. */
  footer: z.string().trim().max(120).default(""),
});
export type SlipLayout = z.infer<typeof slipLayoutSchema>;

export const DEFAULT_SLIP_LAYOUT: SlipLayout = slipLayoutSchema.parse({ version: 1 });

/** Every section exactly once, in the saved order, with any new ones at the end. */
export function slipSections(layout: Pick<SlipLayout, "sections">): SlipLayout["sections"] {
  const seen = new Set(layout.sections.map((section) => section.id));
  return [...layout.sections, ...ALL_SECTIONS.filter((section) => !seen.has(section.id))];
}

/**
 * The saved layout. A workspace that hasn't saved one yet keeps what its
 * older shipping settings said (the note at the bottom, item codes).
 */
export function parseSlipLayout(body: unknown, settings?: ShippingSettings): SlipLayout {
  const parsed = slipLayoutSchema.safeParse(body);
  if (parsed.success) return { ...parsed.data, sections: slipSections(parsed.data) };
  return {
    ...DEFAULT_SLIP_LAYOUT,
    message: settings?.slip_note ?? "",
    show_sku: settings?.slip_show_sku ?? true,
  };
}
