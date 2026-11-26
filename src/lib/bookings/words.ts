import { z } from "zod";
import { formatMoney } from "../dashboard/format";
import type { BookingEmails } from "./config";
import type { BookingDetails, Email } from "./emails";
import { formatTime, formatWhen, localDay, zonedTimeToUtc } from "./slots";

/**
 * The business's own words in every booking email (config "bookings" /
 * "email_words"). Each message has a subject and a plain-text body with
 * fill-ins such as `{{first_name}}` that code fills in; nothing typed here is
 * ever read as markup, and no model is involved anywhere on the way out.
 *
 * A message the business hasn't changed uses `DEFAULT_WORDS`, which put
 * together exactly the words the emails had before they could be edited
 * (`words.test.ts` holds them against `emails.ts` line for line).
 *
 * Two rules keep the words tidy whatever is filled in:
 *  - a line that is only a fill-in with nothing to say ("{{where_line}}" for
 *    a workshop with no place) is left out;
 *  - blank lines never stack up, and none start or end the email.
 * Both apply to the template's own lines, never to the inside of what is
 * filled in, so a note keeps its own spacing.
 */
export const WORDS_KEY = "email_words";

export const MESSAGE_KEYS = [
  "confirmation",
  "reminder",
  "day_of",
  "followup",
  "booking_cancelled",
  "session_cancelled",
  "shop_cancelled",
  "moved",
  "date_changed",
] as const;
export type MessageKey = (typeof MESSAGE_KEYS)[number];

export const MESSAGE_INFO: Record<MessageKey, { name: string; when: string }> = {
  confirmation: {
    name: "You're booked",
    when: "As soon as someone books, and when you send the confirmation again.",
  },
  reminder: { name: "Reminder", when: "Ahead of the date, at the time you chose." },
  day_of: { name: "Day-of reminder", when: "On the day, when it's switched on." },
  followup: { name: "Thank-you", when: "After the date, when it's switched on." },
  booking_cancelled: {
    name: "Booking cancelled",
    when: "When you cancel one person's booking and tick to email them.",
  },
  session_cancelled: {
    name: "Date cancelled",
    when: "To everyone booked when you cancel a whole date.",
  },
  shop_cancelled: {
    name: "Cancelled by a shop refund",
    when: "When a refund or cancellation in your shop takes a booking off the list.",
  },
  moved: { name: "Moved to another date", when: "When you move someone to another date." },
  date_changed: {
    name: "Date's time changed",
    when: "When you change a date's day or time and tick to email everyone.",
  },
};

/** Every fill-in, what it says, and which messages offer it (all when not listed). */
export const FILL_INS: {
  name: string;
  says: string;
  only?: MessageKey[];
}[] = [
  { name: "first_name", says: "Their first name (“there” when we don't have one)" },
  { name: "name", says: "Their whole name" },
  { name: "workshop", says: "The workshop or appointment" },
  { name: "business_name", says: "Your business's name" },
  { name: "when", says: "Day, start and end time, with the time zone" },
  { name: "date", says: "The day, like “Saturday, March 14”" },
  { name: "time", says: "The start time, with the time zone" },
  { name: "place", says: "Where it happens (empty when you haven't said)" },
  { name: "where_line", says: "“Where: …” on its own line, only when you've said where" },
  { name: "places", says: "How many places, like “2 places”" },
  { name: "places_line", says: "“Places: …” on its own line, for workshops" },
  { name: "paid", says: "What they paid (empty when nothing)" },
  { name: "paid_line", says: "“Paid: …” on its own line, only when they paid" },
  {
    name: "note",
    says: "Your note from the timing settings (for the thank-you: its words, or a simple thank-you)",
    only: ["confirmation", "reminder", "day_of", "followup"],
  },
  {
    name: "manage_link",
    says: "Their own link to change or cancel",
    only: ["confirmation"],
  },
  {
    name: "payment_line",
    says: "What happens about a payment: you'll be in touch, or nothing to do",
    only: ["booking_cancelled", "session_cancelled"],
  },
  { name: "old_when", says: "The time it was before", only: ["date_changed"] },
];

export function fillInsFor(key: MessageKey): string[] {
  return FILL_INS.filter((f) => !f.only || f.only.includes(key)).map((f) => f.name);
}

const FILL = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** The fill-ins a text uses that this message doesn't have. */
export function unknownFillIns(key: MessageKey, text: string): string[] {
  const allowed = new Set(fillInsFor(key));
  const unknown = new Set<string>();
  for (const match of text.matchAll(FILL)) if (!allowed.has(match[1])) unknown.add(match[1]);
  // A brace pair that isn't a fill-in at all ("{{ First Name }}") is a typo worth saying.
  for (const match of text.matchAll(/\{\{([^}]*)\}\}/g)) {
    if (!/^\s*[a-z_]+\s*$/.test(match[1])) unknown.add(match[1].trim() || "(empty)");
  }
  return [...unknown];
}

const message = z.object({
  subject: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\r\n]*$/),
  body: z.string().trim().min(1).max(5000),
});
export type MessageWords = z.infer<typeof message>;

export const emailWordsSchema = z
  .object({
    version: z.literal(1),
    /** Where customers' replies go. Empty: the mail service's own address. */
    reply_to: z.union([z.literal(""), z.string().trim().email().max(200)]).default(""),
    /** Only the messages the business changed; the rest use our words. */
    messages: z
      .object(Object.fromEntries(MESSAGE_KEYS.map((key) => [key, message.optional()])))
      .partial()
      .default({}),
  })
  .superRefine((value, ctx) => {
    for (const key of MESSAGE_KEYS) {
      const words = (value.messages as Partial<Record<MessageKey, MessageWords>>)[key];
      if (!words) continue;
      const unknown = unknownFillIns(key, `${words.subject}\n${words.body}`);
      if (unknown.length) {
        ctx.addIssue({
          code: "custom",
          path: ["messages", key],
          message: `Unknown fill-in: ${unknown.join(", ")}`,
        });
      }
    }
  });
export type EmailWords = {
  version: 1;
  reply_to: string;
  messages: Partial<Record<MessageKey, MessageWords>>;
};

export const DEFAULT_EMAIL_WORDS: EmailWords = { version: 1, reply_to: "", messages: {} };

export function parseEmailWords(body: unknown): EmailWords {
  const parsed = emailWordsSchema.safeParse(body);
  return parsed.success ? (parsed.data as EmailWords) : DEFAULT_EMAIL_WORDS;
}

/** Whether any message's words differ between two settings (the reply-to aside). */
export function messageWordsChanged(next: EmailWords, current: EmailWords): boolean {
  return MESSAGE_KEYS.some((key) => {
    const a = next.messages[key];
    const b = current.messages[key];
    return (a?.subject ?? null) !== (b?.subject ?? null) || (a?.body ?? null) !== (b?.body ?? null);
  });
}

/** The words each email had before they could be edited. */
export const DEFAULT_WORDS: Record<MessageKey, MessageWords> = {
  confirmation: {
    subject: "You're booked: {{workshop}} with {{business_name}}",
    body: [
      "Hi {{first_name}},",
      "",
      "You're booked in for {{workshop}} with {{business_name}}.",
      "",
      "When: {{when}}",
      "{{where_line}}",
      "{{places_line}}",
      "{{paid_line}}",
      "",
      "{{note}}",
      "",
      "Need to change or cancel? Use your booking link:",
      "{{manage_link}}",
      "",
      "See you then!",
    ].join("\n"),
  },
  reminder: {
    subject: "Reminder: {{workshop}} with {{business_name}}",
    body: [
      "Hi {{first_name}},",
      "",
      "A quick reminder that {{workshop}} with {{business_name}} is coming up.",
      "",
      "When: {{when}}",
      "{{where_line}}",
      "",
      "{{note}}",
      "",
      "If you can't make it, the link in your confirmation email lets you change or cancel.",
    ].join("\n"),
  },
  day_of: {
    subject: "Nearly time: {{workshop}} with {{business_name}}",
    body: [
      "Hi {{first_name}},",
      "",
      "{{workshop}} with {{business_name}} starts soon.",
      "",
      "When: {{when}}",
      "{{where_line}}",
      "",
      "{{note}}",
      "",
      "See you there!",
    ].join("\n"),
  },
  followup: {
    subject: "Thanks for coming to {{workshop}}",
    body: ["Hi {{first_name}},", "", "{{note}}", "", "{{business_name}}"].join("\n"),
  },
  booking_cancelled: {
    subject: "Your booking was cancelled: {{workshop}} with {{business_name}}",
    body: [
      "Hi {{first_name}},",
      "",
      "{{business_name}} has cancelled your booking for {{workshop}} on {{when}}.",
      "",
      "{{payment_line}}",
    ].join("\n"),
  },
  session_cancelled: {
    subject: "Cancelled: {{workshop}} with {{business_name}}",
    body: [
      "Hi {{first_name}},",
      "",
      "We're sorry: {{workshop}} on {{when}} has been cancelled by {{business_name}}.",
      "",
      "{{payment_line}}",
    ].join("\n"),
  },
  shop_cancelled: {
    subject: "Your booking was cancelled: {{workshop}} with {{business_name}}",
    body: [
      "Hi {{first_name}},",
      "",
      "Your booking for {{workshop}} on {{when}} has been cancelled.",
      "",
      "If that wasn't expected, or you'd like to book another date, just reply to {{business_name}} and they'll help.",
    ].join("\n"),
  },
  moved: {
    subject: "Your booking has moved: {{workshop}} with {{business_name}}",
    body: [
      "Hi {{first_name}},",
      "",
      "{{business_name}} has moved your booking for {{workshop}}.",
      "",
      "New time: {{when}}",
      "{{where_line}}",
      "",
      "If that doesn't work for you, reply to {{business_name}} and they'll sort it out.",
    ].join("\n"),
  },
  date_changed: {
    subject: "New time: {{workshop}} with {{business_name}}",
    body: [
      "Hi {{first_name}},",
      "",
      "{{business_name}} has changed the time of {{workshop}}. Your place is kept.",
      "",
      "New time: {{when}}",
      "{{where_line}}",
      "It was: {{old_when}}",
      "",
      "If the new time doesn't work for you, reply to {{business_name}} and they'll sort it out.",
    ].join("\n"),
  },
};

/** The words a message goes out with: the business's own, or ours. */
export function wordsFor(key: MessageKey, words: EmailWords): MessageWords {
  return words.messages[key] ?? DEFAULT_WORDS[key];
}

/** What one email is about, beyond the booking itself. */
export type Extras = {
  /** The customer's own link (the confirmation only). */
  link?: string | null;
  /** The time before a date was moved (date changed only). */
  was?: { starts_at: string; ends_at: string };
  /** The note from the timing settings, for the messages that carry one. */
  note?: string;
};

type About = Pick<
  BookingDetails,
  | "customer_name"
  | "service_name"
  | "workspace_name"
  | "starts_at"
  | "ends_at"
  | "timezone"
  | "location"
> &
  Partial<Pick<BookingDetails, "seats" | "amount_cents" | "currency" | "service_kind">>;

const firstName = (name: string) => name.trim().split(/\s+/)[0] || "there";

/** The value of every fill-in for one email. */
export function fillValues(key: MessageKey, d: About, extras: Extras = {}): Record<string, string> {
  const place = d.location?.trim() ?? "";
  const seats = d.seats ?? 0;
  const places = seats === 1 ? "1 place" : `${seats} places`;
  const paid =
    (d.amount_cents ?? 0) > 0 ? formatMoney((d.amount_cents ?? 0) / 100, d.currency ?? "USD") : "";
  const note = extras.note?.trim() ?? "";
  const values: Record<string, string> = {
    first_name: firstName(d.customer_name),
    name: d.customer_name.trim(),
    workshop: d.service_name,
    business_name: d.workspace_name,
    when: formatWhen(d.starts_at, d.ends_at, d.timezone),
    date: new Intl.DateTimeFormat("en-US", {
      timeZone: d.timezone,
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(new Date(d.starts_at)),
    time: formatTime(d.starts_at, d.timezone, true),
    place,
    where_line: place ? `Where: ${place}` : "",
    places: d.seats === undefined ? "" : places,
    places_line: d.service_kind === "workshop" && d.seats !== undefined ? `Places: ${places}` : "",
    paid,
    paid_line: paid ? `Paid: ${paid}` : "",
    note:
      key === "followup"
        ? note ||
          `Thank you for joining ${d.service_name} with ${d.workspace_name}. We hope you enjoyed it and we'd love to see you again.`
        : note,
    manage_link: extras.link ?? "",
    payment_line:
      (d.amount_cents ?? 0) > 0
        ? `${d.workspace_name} will be in touch about your payment.`
        : "There's nothing you need to do.",
    old_when: extras.was ? formatWhen(extras.was.starts_at, extras.was.ends_at, d.timezone) : "",
  };
  const allowed = new Set(fillInsFor(key));
  return Object.fromEntries(Object.entries(values).filter(([name]) => allowed.has(name)));
}

const fill = (text: string, values: Record<string, string>) =>
  text.replace(FILL, (whole, name: string) => (name in values ? values[name] : whole));

/** A template with its fill-ins filled, under the two tidy rules above. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  const lines: string[] = [];
  for (const line of template.replace(/\r\n?/g, "\n").split("\n")) {
    const lone = /^\s*\{\{\s*([a-z_]+)\s*\}\}\s*$/.exec(line);
    if (lone && lone[1] in values && values[lone[1]].trim() === "") continue;
    const blank = line.trim() === "";
    if (blank && (lines.length === 0 || lines[lines.length - 1].trim() === "")) continue;
    lines.push(blank ? "" : line);
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => fill(line, values)).join("\n");
}

/** One booking email, in the business's words, ready to send. */
export function bookingEmail(
  key: MessageKey,
  d: About & { customer_email: string },
  words: EmailWords,
  extras: Extras = {},
): Email {
  const chosen = wordsFor(key, words);
  const values = fillValues(key, d, extras);
  return {
    to: d.customer_email,
    subject: fill(chosen.subject, values).replace(/[\r\n]+/g, " "),
    text: fillTemplate(chosen.body, values),
    ...(words.reply_to ? { replyTo: words.reply_to } : {}),
  };
}

/** The note a message carries from the timing settings. */
export function noteFor(key: MessageKey, emails: BookingEmails): string {
  if (key === "confirmation") return emails.confirmation_note;
  if (key === "reminder") return emails.reminder_note;
  if (key === "day_of") return emails.day_of_note;
  if (key === "followup") return emails.followup_message;
  return "";
}

/** A made-up booking for the preview and for "send me a test". */
export function sampleBooking(input: {
  workspaceName: string;
  timezone: string;
  serviceName?: string;
  location?: string;
  startsAt: string;
}): About & { customer_email: string; seats: number } {
  const ends = new Date(Date.parse(input.startsAt) + 3 * 3_600_000).toISOString();
  return {
    customer_name: "Jordan Rivera",
    customer_email: "jordan@example.com",
    service_name: input.serviceName || "Beginner workshop",
    workspace_name: input.workspaceName,
    starts_at: input.startsAt,
    ends_at: ends,
    timezone: input.timezone,
    location: input.location ?? "",
    seats: 2,
    amount_cents: 15000,
    currency: "USD",
    service_kind: "workshop",
  };
}

/** A week from now at 1pm on the workspace's clocks: a believable time for the sample. */
export function sampleStartsAt(now: Date, timeZone: string): string {
  const day = localDay(new Date(now.getTime() + 7 * 86_400_000), timeZone);
  return (zonedTimeToUtc(day, 13 * 60, timeZone) ?? now).toISOString();
}

/** The sample's extras for each message. */
export function sampleExtras(
  key: MessageKey,
  sample: Pick<About, "starts_at" | "ends_at">,
  site: string,
  note: string,
): Extras {
  const week = 7 * 86_400_000;
  const earlier = (at: string) => new Date(Date.parse(at) - week).toISOString();
  return {
    link: key === "confirmation" ? `${site}/booking/sample-link` : null,
    was:
      key === "date_changed"
        ? { starts_at: earlier(sample.starts_at), ends_at: earlier(sample.ends_at) }
        : undefined,
    note,
  };
}
