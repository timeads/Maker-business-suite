import type { AvailabilityRule } from "../../bookings/slots";
import { textFits } from "../social/channels";
import {
  AUTO_REPLY_CHANNELS,
  AUTO_REPLY_WHEN,
  autoRepliesSchema,
  type AutoReplies,
  type AutoReplyChannel,
} from "./config";
import { channelProblem, fillWords } from "./rules";

/**
 * The settings screen's side of automatic replies: reading what the form
 * sent into the setting, and the words for each part of it. Pure.
 */

export const AUTO_REPLY_LABELS: Record<AutoReplyChannel, string> = {
  instagram: "Instagram messages",
  facebook: "Facebook messages",
  email: "Email",
};

export const WHEN_LABELS: Record<(typeof AUTO_REPLY_WHEN)[number], string> = {
  always: "Whenever someone writes",
  outside_hours: "Only outside opening hours",
  both: "One message when open, another when closed",
};

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
/** The order a week is shown in: Monday first. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** A sample customer for the preview. Never anyone real. */
export const SAMPLE_FIRST_NAME = "Sam";

const pad = (n: number) => String(n).padStart(2, "0");
/** Minutes past midnight as a clock time for a time box ("09:00"; midnight at the day's end is "23:59"). */
export const clockOf = (minute: number) =>
  minute >= 1440 ? "23:59" : `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
/** A time box's value as minutes past midnight, or null. */
export function minuteOf(clock: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(clock.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** One line per weekday for the screen: the first stretch of each day (the screen edits one a day). */
export function dayRows(hours: readonly AvailabilityRule[]) {
  return WEEK_ORDER.map((weekday) => {
    const rule = hours.find((one) => one.weekday === weekday);
    return {
      weekday,
      name: WEEKDAYS[weekday],
      open: Boolean(rule),
      start: clockOf(rule?.start_minute ?? 9 * 60),
      end: clockOf(rule?.end_minute ?? 17 * 60),
    };
  });
}

/** "Mon to Fri 9:00 am to 5:00 pm"-style lines for a summary of the week. */
export function hoursWords(hours: readonly AvailabilityRule[]): string[] {
  const time = (minute: number) => {
    const clock = minute >= 1440 ? 23 * 60 + 59 : minute;
    const h = Math.floor(clock / 60);
    const m = clock % 60;
    return `${h % 12 === 0 ? 12 : h % 12}:${pad(m)} ${h < 12 ? "am" : "pm"}`;
  };
  return dayRows(hours).map((day) =>
    day.open
      ? `${day.name}: ${time(minuteOf(day.start) ?? 0)} to ${time(minuteOf(day.end) ?? 0)}`
      : `${day.name}: closed`,
  );
}

export type ReadForm = { ok: true; value: AutoReplies } | { ok: false; error: string };

/**
 * The form as the setting, or what is wrong with it in words. `get` reads a
 * field by name. A message that wouldn't fit one Instagram or Facebook
 * message once the names are filled in is refused here, not at send time.
 */
export function readAutoReplyForm(
  get: (name: string) => string | null,
  facts: { businessName: string },
): ReadForm {
  const hours: AvailabilityRule[] = [];
  for (const weekday of WEEK_ORDER) {
    if (get(`day_${weekday}_open`) !== "1") continue;
    const start = minuteOf(get(`day_${weekday}_start`) ?? "");
    const end = minuteOf(get(`day_${weekday}_end`) ?? "");
    if (start === null || end === null) {
      return { ok: false, error: `${WEEKDAYS[weekday]}: give an opening and a closing time.` };
    }
    // "23:59" in the closing box means open until the day ends.
    const until = end === 23 * 60 + 59 ? 1440 : end;
    if (until <= start) {
      return { ok: false, error: `${WEEKDAYS[weekday]}: the closing time is before the opening.` };
    }
    hours.push({ weekday, start_minute: start, end_minute: until });
  }
  const channel = (name: AutoReplyChannel) => ({
    on: get(`${name}_on`) === "1",
    when: get(`${name}_when`) ?? "always",
    message: (get(`${name}_message`) ?? "").replace(/\r\n?/g, "\n").trim(),
    away_message: (get(`${name}_away`) ?? "").replace(/\r\n?/g, "\n").trim(),
  });
  const parsed = autoRepliesSchema.safeParse({
    version: 1,
    instagram: channel("instagram"),
    facebook: channel("facebook"),
    email: channel("email"),
    hours,
    quiet_hours: Number(get("quiet_hours") ?? "24"),
  });
  if (!parsed.success) {
    const where = String(parsed.error.issues[0]?.path[0] ?? "");
    if (where === "quiet_hours") {
      return { ok: false, error: "The quiet period is a whole number of hours, from 1 to 168." };
    }
    const field = String(parsed.error.issues[0]?.path[1] ?? "");
    if (
      AUTO_REPLY_CHANNELS.some((one) => one === where) &&
      (field === "message" || field === "away_message")
    ) {
      return {
        ok: false,
        error: `${AUTO_REPLY_LABELS[where as AutoReplyChannel]}: a message can be up to 800 characters of plain words.`,
      };
    }
    return { ok: false, error: "We couldn't read that. Check the fields and try again." };
  }
  const value = parsed.data;
  for (const name of AUTO_REPLY_CHANNELS) {
    const problem = channelProblem(AUTO_REPLY_LABELS[name], value[name]);
    if (problem) return { ok: false, error: problem };
    if (name === "email") continue;
    // The longest it can come out: the longest first name we'd ever fill in.
    const longest = { firstName: "W".repeat(30), businessName: facts.businessName };
    for (const text of [value[name].message, value[name].away_message]) {
      if (text && !textFits(name, fillWords(text, longest))) {
        return {
          ok: false,
          error: `${AUTO_REPLY_LABELS[name]}: that is too long for one message there. Shorten it a little.`,
        };
      }
    }
  }
  return { ok: true, value };
}

/** A message exactly as a customer will read it, for the preview and the test email. */
export function previewWords(text: string, businessName: string, firstName = SAMPLE_FIRST_NAME) {
  return fillWords(text, { firstName, businessName });
}
