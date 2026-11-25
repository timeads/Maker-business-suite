import { z } from "zod";
import type { AvailabilityRule } from "../../bookings/slots";

/**
 * Automatic first replies (`configs`, module "helpdesk", key "auto_replies"):
 * a short message the help desk sends by itself when someone writes in.
 *
 * FIXED WORDS ONLY. What goes out is exactly what a person typed here, with
 * two placeholders filled in by code. Nothing on this path asks a model for
 * anything; `guard.test.ts` keeps it that way.
 */
export const AUTO_REPLIES_KEY = "auto_replies";

export const AUTO_REPLY_CHANNELS = ["instagram", "facebook", "email"] as const;
export type AutoReplyChannel = (typeof AUTO_REPLY_CHANNELS)[number];

/**
 * When a channel answers:
 *  - "always": the same message whenever someone writes.
 *  - "outside_hours": only when the business is closed (the away message).
 *  - "both": the usual message inside opening hours, the away message outside.
 */
export const AUTO_REPLY_WHEN = ["always", "outside_hours", "both"] as const;
export type AutoReplyWhen = (typeof AUTO_REPLY_WHEN)[number];

/** Instagram takes 1,000 bytes a message; a first reply is a few lines anyway. */
export const MAX_AUTO_REPLY_CHARS = 800;

const words = z
  .string()
  .max(MAX_AUTO_REPLY_CHARS)
  // Plain words: no control characters (line breaks and tabs are fine).
  .regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/)
  .default("");

export const autoReplyChannelSchema = z.object({
  on: z.boolean().default(false),
  when: z.enum(AUTO_REPLY_WHEN).default("always"),
  /** Sent for "always", and inside opening hours for "both". */
  message: words,
  /** Sent outside opening hours, for "outside_hours" and "both". */
  away_message: words,
});
export type AutoReplyChannelSettings = z.infer<typeof autoReplyChannelSchema>;

/** One stretch of a weekday the business is open: the Bookings weekly-hours shape. */
const hoursRuleSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    start_minute: z.number().int().min(0).max(1439),
    end_minute: z.number().int().min(1).max(1440),
  })
  .refine((rule) => rule.start_minute < rule.end_minute);

export const MIN_QUIET_HOURS = 1;
export const MAX_QUIET_HOURS = 168;

export const autoRepliesSchema = z.object({
  version: z.literal(1),
  instagram: autoReplyChannelSchema.default(() => OFF),
  facebook: autoReplyChannelSchema.default(() => OFF),
  email: autoReplyChannelSchema.default(() => OFF),
  /** Opening hours, on the workspace's own clocks. */
  hours: z
    .array(hoursRuleSchema)
    .max(21)
    .default(() => DEFAULT_HOURS),
  /** At most one automatic reply per person per channel in this many hours. */
  quiet_hours: z.number().int().min(MIN_QUIET_HOURS).max(MAX_QUIET_HOURS).default(24),
});
export type AutoReplies = z.infer<typeof autoRepliesSchema>;

const OFF: AutoReplyChannelSettings = {
  on: false,
  when: "always",
  message: "",
  away_message: "",
};

/** Monday to Friday, nine to five. */
export const DEFAULT_HOURS: AvailabilityRule[] = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  start_minute: 9 * 60,
  end_minute: 17 * 60,
}));

/** Everything off: a workspace sends nothing by itself until an owner or admin says so. */
export const DEFAULT_AUTO_REPLIES: AutoReplies = {
  version: 1,
  instagram: { ...OFF },
  facebook: { ...OFF },
  email: { ...OFF },
  hours: DEFAULT_HOURS,
  quiet_hours: 24,
};

export function parseAutoReplies(body: unknown): AutoReplies {
  const parsed = autoRepliesSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_AUTO_REPLIES;
}

/** The messages a channel's "when" really uses, so the screen can ask for the right ones. */
export function messagesNeeded(when: AutoReplyWhen): { message: boolean; away: boolean } {
  return { message: when !== "outside_hours", away: when !== "always" };
}
