import { z } from "zod";
import { COUNTRY_KEYS, type CountryKey } from "./phone";

/**
 * Text reminders for bookings (config "bookings" / "texts"). Everything is
 * off until the business switches it on, and each message separately. The
 * words are the business's own, FIXED WORDS ONLY: what a person typed, with
 * fill-ins filled by code (`textFor` in words.ts). No model is ever asked to
 * write or change one, and the assistant may not propose them.
 *
 * The database reads `on`, `messages.<kind>.on` and the three hour counts
 * itself (`private.booking_text_on`, `private.booking_text_hours`), so keep
 * those names as they are.
 */
export const TEXTS_KEY = "texts";

export const TEXT_KINDS = [
  "confirmation",
  "reminder",
  "day_of",
  "followup",
  "cancelled",
  "moved",
] as const;
export type TextKind = (typeof TEXT_KINDS)[number];

export const TEXT_INFO: Record<TextKind, { name: string; when: string }> = {
  confirmation: { name: "You're booked", when: "As soon as someone books." },
  reminder: { name: "Reminder", when: "Ahead of the date, at the time you choose below." },
  day_of: { name: "Day-of reminder", when: "On the day, a few hours before." },
  followup: { name: "Thank-you", when: "After the date." },
  cancelled: {
    name: "Cancelled by a shop refund",
    when: "When a refund or cancellation in your shop takes a booking off the list.",
  },
  moved: { name: "Moved to another date", when: "When you move someone to another date." },
};

/** The earlier booking app's line, kept as it was. */
export const DEFAULT_CONSENT_WORDS =
  "Text me booking reminders & updates (optional). Msg & data rates may apply; reply STOP to opt out.";
export const DEFAULT_OPT_OUT_LINE = "Reply STOP to opt out.";

const words = z.string().trim().max(600);

const message = z.object({
  on: z.boolean().default(false),
  /** Empty: the standard words. */
  body: words.default(""),
});

export const textSettingsSchema = z.object({
  version: z.literal(1),
  /** Texts at all. Off until switched on; nothing goes without Twilio connected. */
  on: z.boolean().default(false),
  /** Numbers typed without a country code are read as this country's. */
  default_country: z.enum(COUNTRY_KEYS as [CountryKey, ...CountryKey[]]).default("US"),
  /** The words beside the tick box in the picker and on the booking page. */
  consent_words: z.string().trim().min(10).max(300).default(DEFAULT_CONSENT_WORDS),
  /** Added to the end of every text that doesn't already say STOP. */
  opt_out_line: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .refine((line) => /\bSTOP\b/.test(line), "The line must tell people to reply STOP")
    .default(DEFAULT_OPT_OUT_LINE),
  reminder_hours: z.number().int().min(1).max(336).default(48),
  day_of_hours: z.number().int().min(1).max(24).default(2),
  followup_hours: z.number().int().min(1).max(168).default(24),
  messages: z
    .object(
      Object.fromEntries(
        TEXT_KINDS.map((kind) => [kind, message.default({ on: false, body: "" })]),
      ),
    )
    .default(
      Object.fromEntries(TEXT_KINDS.map((kind) => [kind, { on: false, body: "" }])) as never,
    ),
});

export type TextMessage = { on: boolean; body: string };
export type TextSettings = Omit<z.infer<typeof textSettingsSchema>, "messages"> & {
  messages: Record<TextKind, TextMessage>;
};

export const DEFAULT_TEXT_SETTINGS = textSettingsSchema.parse({ version: 1 }) as TextSettings;

export function parseTextSettings(body: unknown): TextSettings {
  const parsed = textSettingsSchema.safeParse(body);
  return (parsed.success ? parsed.data : DEFAULT_TEXT_SETTINGS) as TextSettings;
}

/** Whether any message's words differ between two settings: only a person may change them. */
export function textWordsChanged(next: TextSettings, current: TextSettings): boolean {
  return (
    next.opt_out_line !== current.opt_out_line ||
    next.consent_words !== current.consent_words ||
    TEXT_KINDS.some((kind) => next.messages[kind].body !== current.messages[kind].body)
  );
}

/** Whether the picker and booking pages should ask for a number at all. */
export const textsAsked = (settings: TextSettings) =>
  settings.on && TEXT_KINDS.some((kind) => settings.messages[kind].on);
