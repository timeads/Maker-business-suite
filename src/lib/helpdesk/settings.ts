import { z } from "zod";

/**
 * How the desk behaves for a workspace: a setting like any other (`configs`,
 * module "helpdesk"), parsed with this schema every time it is read.
 */
export const DESK_SETTINGS_KEY = "desk_settings";

const address = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$/);

export const UNDO_SECONDS = [0, 5, 10, 20] as const;

export const deskSettingsSchema = z.object({
  version: z.literal(1),
  /**
   * The business's own support addresses (the ones it forwards to the desk).
   * "Reply all" never copies them in, or the reply would come straight back.
   */
  own_addresses: z.array(address).max(10).default([]),
  /** How long a sent email waits before it really goes, so it can be taken back. 0 sends at once. */
  undo_seconds: z
    .number()
    .int()
    .refine((value) => (UNDO_SECONDS as readonly number[]).includes(value))
    .default(5),
  /** After closing a conversation: the next one, back to the list, or stay on it. */
  after_close: z.enum(["next", "list", "stay"]).default("next"),
  /** On a wide screen, open the first conversation in the list by itself. */
  auto_open: z.boolean().default(true),
});
export type DeskSettings = z.infer<typeof deskSettingsSchema>;

export const DEFAULT_DESK_SETTINGS: DeskSettings = {
  version: 1,
  own_addresses: [],
  undo_seconds: 5,
  after_close: "next",
  auto_open: true,
};

export function parseDeskSettings(body: unknown): DeskSettings {
  const parsed = deskSettingsSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_DESK_SETTINGS;
}
