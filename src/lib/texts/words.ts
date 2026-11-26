import type { BookingDetails } from "../bookings/emails";
import { formatTime, zoneLabel } from "../bookings/slots";
import { fillTemplate, fillValues } from "../bookings/words";
import type { TextKind, TextSettings } from "./config";

/**
 * The words of each text: the business's own, or ours (the earlier booking
 * app's text wording, made to fit any business). Fill-ins are filled by code
 * from the booking, the same way as the booking emails (`fillValues`), and
 * the opt-out line goes on the end. FIXED WORDS ONLY: nothing here, or on
 * the way to Twilio, asks a model anything (`guard.test.ts` checks).
 */

/** The fill-ins a text may use, and what each says. */
export const TEXT_FILL_INS: { name: string; says: string }[] = [
  { name: "first_name", says: "Their first name (“there” when we don't have one)" },
  { name: "name", says: "Their whole name" },
  { name: "workshop", says: "The workshop or appointment" },
  { name: "business_name", says: "Your business's name" },
  { name: "date", says: "The day, like “Saturday, March 14”" },
  { name: "time", says: "The start time, with the time zone" },
  { name: "when", says: "Day, start and end time, with the time zone" },
  { name: "place", says: "Where it happens (empty when you haven't said)" },
  { name: "at_place", says: "“ at …” with the place, or nothing when you haven't said where" },
  { name: "places", says: "How many places, like “2 places”" },
];
const ALLOWED = new Set(TEXT_FILL_INS.map((fill) => fill.name));

export const DEFAULT_TEXTS: Record<TextKind, string> = {
  confirmation:
    "{{business_name}}: you're booked for {{workshop}} on {{date}} at {{time}}, {{places}} reserved. See you{{at_place}}!",
  reminder:
    "Reminder from {{business_name}}: {{workshop}} is coming up on {{date}} at {{time}}{{at_place}}. See you soon!",
  day_of:
    "Starting soon! {{workshop}} with {{business_name}} at {{time}} today{{at_place}}. See you shortly!",
  followup:
    "Thanks for coming to {{workshop}} with {{business_name}}! We hope you loved it. Come back anytime!",
  cancelled:
    "{{business_name}}: your {{workshop}} booking on {{date}} at {{time}} is cancelled. Questions? Get in touch with {{business_name}}.",
  moved:
    "{{business_name}}: your {{workshop}} booking has moved to {{date}} at {{time}}. See you then!",
};

const FILL = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** The fill-ins a text uses that texts don't have, and brace pairs that aren't fill-ins. */
export function unknownTextFillIns(text: string): string[] {
  const unknown = new Set<string>();
  for (const match of text.matchAll(FILL)) if (!ALLOWED.has(match[1])) unknown.add(match[1]);
  for (const match of text.matchAll(/\{\{([^}]*)\}\}/g)) {
    if (!/^\s*[a-z_]+\s*$/.test(match[1])) unknown.add(match[1].trim() || "(empty)");
  }
  return [...unknown];
}

type About = Pick<
  BookingDetails,
  "customer_name" | "service_name" | "workspace_name" | "starts_at" | "ends_at" | "timezone"
> &
  Partial<Pick<BookingDetails, "seats" | "location" | "service_kind">>;

/** The value of every fill-in for one text. */
export function textValues(d: About): Record<string, string> {
  // The email fill-ins already say the day, time and place on the workspace's clock.
  const values = fillValues("reminder", { ...d, location: d.location ?? "" });
  const place = (d.location ?? "").trim();
  // The plain zone label ("ET", "PT", "BST"), as the earlier app's texts had it.
  const zone = zoneLabel(d.timezone, d.starts_at);
  const time = `${formatTime(d.starts_at, d.timezone)}${zone ? ` ${zone}` : ""}`;
  const all: Record<string, string> = {
    ...values,
    time,
    at_place: place ? ` at ${place}` : "",
  };
  return Object.fromEntries(Object.entries(all).filter(([name]) => ALLOWED.has(name)));
}

/** The words a text goes out with: the business's own, or ours. */
export const textTemplate = (kind: TextKind, settings: TextSettings) =>
  settings.messages[kind].body.trim() || DEFAULT_TEXTS[kind];

/** Adds the opt-out line, unless the words already tell people to reply STOP. */
export function withOptOut(text: string, line: string): string {
  return /\bSTOP\b/.test(text) ? text : `${text} ${line}`.trim();
}

/** One text, ready to send: words filled in, on one line, with the opt-out line. */
export function textFor(kind: TextKind, d: About, settings: TextSettings): string {
  const filled = fillTemplate(textTemplate(kind, settings), textValues(d));
  return withOptOut(filled.replace(/\s*\n\s*/g, " ").trim(), settings.opt_out_line);
}

/** A made-up booking for the preview and the test text. */
export function sampleBooking(workspaceName: string, timezone: string): About {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 2);
  start.setUTCHours(17, 0, 0, 0);
  return {
    customer_name: "Jordan Rivera",
    service_name: "Beginner workshop",
    workspace_name: workspaceName,
    starts_at: start.toISOString(),
    ends_at: new Date(start.getTime() + 2 * 3600_000).toISOString(),
    timezone,
    seats: 2,
    location: "the studio",
    service_kind: "workshop",
  };
}
