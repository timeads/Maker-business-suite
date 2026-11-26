import { parseCsv } from "../../stock/import/csv";
import {
  TEXT_KINDS,
  textSettingsSchema,
  type TextKind,
  type TextSettings,
} from "../../texts/config";
import { DEFAULT_TEXTS, unknownTextFillIns } from "../../texts/words";
import { emailWordsSchema, unknownFillIns, type EmailWords, type MessageKey } from "../words";

/**
 * The fourth "Bring your bookings across" file: the earlier booking app's own
 * message wording (a key, a channel, a subject and a body per row), turned
 * into the suite's `bookings` / `email_words` and `bookings` / `texts`
 * configs. Pure: a look and the real thing read the file the same way, and
 * the page saves what this hands back through `save_config` (so every change
 * leaves a `config_versions` row).
 *
 * The earlier app's fill-ins are translated to the suite's by `translate`;
 * anything with no match is taken out and said so, never guessed. Its
 * messages map onto the suite's by `KEY_MAP`. The suite's own standard words
 * are never changed by this: only the business's own file is read.
 */

export type WordingChannel = "email" | "text";

/** The earlier app's message keys and where each goes in the suite. */
export const KEY_MAP: Record<string, { email: MessageKey[]; text: TextKind[] }> = {
  confirmation: { email: ["confirmation"], text: ["confirmation"] },
  reminder_48h: { email: ["reminder"], text: ["reminder"] },
  reminder_2h: { email: ["day_of"], text: ["day_of"] },
  followup_24h: { email: ["followup"], text: ["followup"] },
  // The earlier app sent one notice for any cancellation; here a person's
  // cancelling and a shop refund have one each.
  booking_cancelled: { email: ["booking_cancelled", "shop_cancelled"], text: ["cancelled"] },
  booking_rescheduled: { email: ["moved"], text: ["moved"] },
};
/** Known in the earlier app, with no place here: reported, not brought in. */
const NO_PLACE: Record<string, string> = {
  owner_new_booking:
    "The note to you about a new booking uses our own words here, so this one stays behind.",
};

/** The earlier app's fill-ins, and the suite's for each. */
export const FILL_MAP: Record<string, string> = {
  first_name: "first_name",
  full_name: "name",
  workshop_title: "workshop",
  session_date: "date",
  session_time: "time",
  location: "place",
  seats: "places",
};

export type Translated = { text: string; notes: string[] };

/**
 * One template in the suite's fill-ins. `{{seats}} seat(s)` becomes
 * `{{places}}` ("2 places"). `{{manage_link}}` is kept only in a
 * confirmation email, where the suite has the customer's own link; elsewhere
 * the earlier app filled it with a contact page, which the suite doesn't
 * have, so it is taken out and said so. Markup is taken out too: the suite's
 * messages are plain text.
 */
export function translate(
  template: string,
  where: { channel: WordingChannel; message: string },
): Translated {
  const notes: string[] = [];
  let text = template.replace(/\r\n?/g, "\n");
  if (/<[a-z][a-z0-9]*(\s[^>]*)?\/?>/i.test(text)) {
    text = text
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>\s*/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&");
    notes.push("It was written with markup; that was taken out, as messages here are plain text.");
  }
  text = text.replace(/\{\{\s*([A-Za-z_]+)\s*\}\}/g, (whole, name: string) => {
    const key = name.toLowerCase();
    if (key === "manage_link") {
      if (where.channel === "email" && where.message === "confirmation") return "{{manage_link}}";
      notes.push(
        "{{manage_link}} was a contact link in the earlier app; there is no such fill-in here, so it was taken out.",
      );
      return "";
    }
    if (key in FILL_MAP) return `{{${FILL_MAP[key]}}}`;
    notes.push(`{{${name}}} has no match here, so it was taken out.`);
    return "";
  });
  // "{{seats}} seat(s)": the suite's {{places}} already says "2 places".
  text = text.replace(/\{\{places\}\}\s*seat\(s\)/g, "{{places}}");
  return {
    text: text
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    notes: [...new Set(notes)],
  };
}

export type WordingRow = {
  line: number;
  key: string;
  channel: WordingChannel;
  /** Where it goes: the suite's message names. */
  into: string[];
  subject: string;
  body: string;
  notes: string[];
};

export type WordingRead =
  | { ok: false; error: string }
  | {
      ok: true;
      rows: WordingRow[];
      problems: { line: number; reason: string }[];
      emailWords: EmailWords;
      textSettings: TextSettings;
    };

const CHANNELS: Record<string, WordingChannel> = {
  email: "email",
  text: "text",
  sms: "text",
};

/**
 * Reads the file against the configs as they are now, and hands back both
 * configs with the file's words in, plus every row it left out and why.
 */
export function readWording(
  input: string,
  current: { emailWords: EmailWords; textSettings: TextSettings },
): WordingRead {
  const csv = parseCsv(input);
  if (!csv.ok) return { ok: false, error: csv.error };
  const has = (name: string, ...also: string[]) =>
    [name, ...also].find((heading) => csv.headers.includes(heading)) ?? null;
  const keyCol = has("key", "template_key", "message");
  const channelCol = has("channel");
  const subjectCol = has("subject");
  const bodyCol = has("body", "words");
  if (!keyCol || !channelCol || !bodyCol) {
    return {
      ok: false,
      error:
        "The file needs columns named key, channel, subject and body (subject only for emails).",
    };
  }
  const rows: WordingRow[] = [];
  const problems: { line: number; reason: string }[] = [];
  const messages = { ...current.emailWords.messages };
  const texts = Object.fromEntries(
    TEXT_KINDS.map((kind) => [kind, { ...current.textSettings.messages[kind] }]),
  ) as TextSettings["messages"];
  const seen = new Set<string>();

  for (const row of csv.rows) {
    const key = row.cells[keyCol].trim().toLowerCase();
    const channel = CHANNELS[row.cells[channelCol].trim().toLowerCase()];
    const subject = subjectCol ? row.cells[subjectCol].trim() : "";
    const raw = row.cells[bodyCol];
    if (key in NO_PLACE) {
      problems.push({ line: row.line, reason: NO_PLACE[key] });
      continue;
    }
    if (!(key in KEY_MAP)) {
      problems.push({ line: row.line, reason: `“${key || "(empty)"}” isn't a message we know.` });
      continue;
    }
    if (!channel) {
      problems.push({ line: row.line, reason: "The channel should be email or text." });
      continue;
    }
    if (!raw.trim()) {
      problems.push({ line: row.line, reason: "There are no words in this row." });
      continue;
    }
    if (seen.has(`${key}/${channel}`)) {
      problems.push({
        line: row.line,
        reason: "This message and channel came earlier in the file.",
      });
      continue;
    }
    seen.add(`${key}/${channel}`);
    const into = KEY_MAP[key][channel];
    const notes: string[] = [];
    let ok = true;
    if (channel === "email") {
      if (!subject) {
        problems.push({ line: row.line, reason: "An email needs a subject." });
        continue;
      }
      for (const message of into) {
        const body = translate(raw, { channel, message });
        const title = translate(subject, { channel, message });
        const oneLine = title.text.replace(/\s*\n\s*/g, " ");
        const unknown = unknownFillIns(message as MessageKey, `${oneLine}\n${body.text}`);
        if (
          unknown.length ||
          !body.text ||
          !oneLine ||
          body.text.length > 5000 ||
          oneLine.length > 200
        ) {
          ok = false;
          problems.push({
            line: row.line,
            reason: unknown.length
              ? `After translating, it uses fill-ins this message doesn't have: ${unknown.join(", ")}.`
              : "It's empty or too long once translated (200 characters a subject, 5,000 a body).",
          });
          break;
        }
        notes.push(...body.notes, ...title.notes);
        messages[message as MessageKey] = { subject: oneLine, body: body.text };
      }
    } else {
      for (const kind of into as TextKind[]) {
        const body = translate(raw, { channel, message: kind });
        const one = body.text.replace(/\s*\n\s*/g, " ");
        const unknown = unknownTextFillIns(one);
        if (unknown.length || !one || one.length > 600) {
          ok = false;
          problems.push({
            line: row.line,
            reason: unknown.length
              ? `After translating, it uses fill-ins texts don't have: ${unknown.join(", ")}.`
              : "It's empty or longer than 600 characters once translated.",
          });
          break;
        }
        notes.push(...body.notes);
        texts[kind] = { ...texts[kind], body: one === DEFAULT_TEXTS[kind] ? "" : one };
      }
    }
    if (!ok) continue;
    rows.push({
      line: row.line,
      key,
      channel,
      into,
      subject: channel === "email" ? (messages[into[0] as MessageKey]?.subject ?? "") : "",
      body:
        channel === "email"
          ? (messages[into[0] as MessageKey]?.body ?? "")
          : texts[into[0] as TextKind].body || DEFAULT_TEXTS[into[0] as TextKind],
      notes: [...new Set(notes)],
    });
  }

  const emailWords = emailWordsSchema.safeParse({ ...current.emailWords, messages });
  const textSettings = textSettingsSchema.safeParse({ ...current.textSettings, messages: texts });
  if (!emailWords.success || !textSettings.success) {
    return {
      ok: false,
      error: "Those words don't fit the settings once translated. Nothing was changed.",
    };
  }
  return {
    ok: true,
    rows,
    problems,
    emailWords: emailWords.data as EmailWords,
    textSettings: textSettings.data as TextSettings,
  };
}
