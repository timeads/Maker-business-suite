import { z } from "zod";

/**
 * The Michaels connector's switches. Data, like every other setting: stored in
 * `configs` under module "michaels" and parsed on every read. Anything
 * missing or unreadable falls back to the defaults, which are deliberately
 * inert: nothing runs until `enabled`.
 *
 * This stage only watches. `mode` has one value, so a body that asks for
 * anything else doesn't parse and the connector reads as switched off. The
 * "go live" switch and the cut-over time come with the stage that can send;
 * they are not stored here yet, so nothing saved today can turn sending on
 * later by surprise.
 */
export const MICHAELS_MODULE = "michaels";
export const MICHAELS_SETTINGS_KEY = "settings";

const jobsSchema = z.object({
  /** Work out the stock each listing would be given. */
  stock: z.boolean().default(true),
  /** Work out the price each listing would be given. */
  prices: z.boolean().default(true),
  /** Read recent Michaels orders and show what bringing them in would make. */
  orders: z.boolean().default(true),
});

export const michaelsSettingsSchema = z.object({
  version: z.literal(1),
  /** Master switch. Off, the worker does nothing for this workspace. */
  enabled: z.boolean().default(false),
  /** Watch only: read and compare, record what would be sent, send nothing. */
  mode: z.literal("watch").default("watch"),
  /** Units kept back from Michaels per item, so two shops can't sell the last one. */
  units_held_back: z.number().int().min(0).max(1000).default(1),
  jobs: jobsSchema.default({ stock: true, prices: true, orders: true }),
});
export type MichaelsSettings = z.infer<typeof michaelsSettingsSchema>;

export const DEFAULT_MICHAELS_SETTINGS: MichaelsSettings = michaelsSettingsSchema.parse({
  version: 1,
});

export function parseMichaelsSettings(body: unknown): MichaelsSettings {
  const parsed = michaelsSettingsSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_MICHAELS_SETTINGS;
}

/** How often the worker looks, when switched on. The database holds the same hour. */
export const MICHAELS_CHECK_EVERY_MINUTES = 60;
