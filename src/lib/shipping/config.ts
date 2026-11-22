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
  /** A line or two at the bottom of the slip: a thank-you, care notes, how to return. */
  slip_note: z.string().trim().max(600).default(""),
  /** Show item codes on the slip, for the person picking. */
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
