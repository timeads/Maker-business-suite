import { z } from "zod";

/**
 * The owner's daily email settings (config "bookings" / "daily_email"), apart
 * from the sending code so a page or the assistant can read them without
 * pulling in the server's mail and database helpers.
 */
export const DAILY_KEY = "daily_email";

export const dailyEmailSchema = z.object({
  version: z.literal(1),
  on: z.boolean().default(false),
  /** The hour on the workspace's clocks it goes out, 0 to 23. */
  hour: z.number().int().min(0).max(23).default(7),
  /** Who gets it: members' user ids, chosen by an owner or admin. */
  recipients: z
    .array(z.string().regex(/^[0-9a-f-]{36}$/i))
    .max(20)
    .default([]),
});
export type DailyEmailSettings = z.infer<typeof dailyEmailSchema>;

export const DEFAULT_DAILY_EMAIL: DailyEmailSettings = dailyEmailSchema.parse({ version: 1 });

export function parseDailyEmail(body: unknown): DailyEmailSettings {
  const parsed = dailyEmailSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_DAILY_EMAIL;
}

/** "7 a.m.", "noon", "5 p.m." */
export function hourWords(hour: number): string {
  if (hour === 0) return "midnight";
  if (hour === 12) return "noon";
  return hour < 12 ? `${hour} a.m.` : `${hour - 12} p.m.`;
}
