import { describe, expect, it } from "vitest";
import { DEFAULT_AUTO_REPLIES, autoReplyWordsChanged, parseAutoReplies } from "./config";
import { clockOf, dayRows, hoursWords, minuteOf, previewWords, readAutoReplyForm } from "./form";

const form = (fields: Record<string, string>) => (name: string) => fields[name] ?? null;
const week = Object.fromEntries(
  [1, 2, 3, 4, 5].flatMap((day) => [
    [`day_${day}_open`, "1"],
    [`day_${day}_start`, "09:00"],
    [`day_${day}_end`, "17:00"],
  ]),
);
const facts = { businessName: "A Made Up Studio" };

describe("the automatic replies form", () => {
  it("reads into the setting", () => {
    const read = readAutoReplyForm(
      form({
        ...week,
        instagram_on: "1",
        instagram_when: "both",
        instagram_message: "  Hi {{first_name}}!\r\nWe got it.  ",
        instagram_away: "We're closed.",
        facebook_when: "always",
        email_when: "outside_hours",
        email_away: "Closed just now.",
        day_6_open: "1",
        day_6_start: "10:00",
        day_6_end: "23:59",
        quiet_hours: "12",
      }),
      facts,
    );
    expect(read).toEqual({
      ok: true,
      value: {
        version: 1,
        instagram: {
          on: true,
          when: "both",
          message: "Hi {{first_name}}!\nWe got it.",
          away_message: "We're closed.",
        },
        facebook: { on: false, when: "always", message: "", away_message: "" },
        // Words are kept while a channel is off, ready for when it is switched on.
        email: { on: false, when: "outside_hours", message: "", away_message: "Closed just now." },
        hours: [...DEFAULT_AUTO_REPLIES.hours, { weekday: 6, start_minute: 600, end_minute: 1440 }],
        quiet_hours: 12,
      },
    });
  });

  it("says what is wrong in words", () => {
    const problem = (fields: Record<string, string>) => {
      const read = readAutoReplyForm(form({ quiet_hours: "24", ...fields }), facts);
      return read.ok ? null : read.error;
    };
    expect(problem({})).toBeNull();
    expect(problem({ instagram_on: "1" })).toMatch(/Instagram messages: write the message/);
    expect(problem({ email_on: "1", email_when: "outside_hours" })).toMatch(
      /Email: write the away/,
    );
    expect(problem({ facebook_on: "1", facebook_when: "both", facebook_message: "Hi" })).toMatch(
      /Facebook messages: write the away/,
    );
    expect(problem({ quiet_hours: "0" })).toMatch(/quiet period/);
    expect(problem({ quiet_hours: "2.5" })).toMatch(/quiet period/);
    expect(problem({ quiet_hours: "lots" })).toMatch(/quiet period/);
    expect(problem({ instagram_message: "x".repeat(801) })).toMatch(/up to 800 characters/);
    expect(problem({ day_1_open: "1", day_1_start: "", day_1_end: "17:00" })).toMatch(/Monday/);
    expect(problem({ day_2_open: "1", day_2_start: "17:00", day_2_end: "09:00" })).toMatch(
      /Tuesday: the closing time is before/,
    );
    expect(problem({ instagram_when: "whenever" })).toMatch(/couldn't read/);
    // 800 two-byte letters fit our own limit but not one Instagram message (1,000 bytes).
    expect(problem({ instagram_on: "1", instagram_message: "é".repeat(600) })).toMatch(
      /Instagram messages: that is too long/,
    );
    expect(problem({ email_on: "1", email_message: "é".repeat(600) })).toBeNull();
    // Just under the limit until a long first name is filled in.
    expect(
      problem({ instagram_on: "1", instagram_message: `{{first_name}}${"a".repeat(985)}` }),
    ).toMatch(/up to 800|too long/);
  });

  it("shows a week, Monday first, and reads clock times", () => {
    const rows = dayRows(DEFAULT_AUTO_REPLIES.hours);
    expect(rows.map((row) => row.name)[0]).toBe("Monday");
    expect(rows.map((row) => row.open)).toEqual([true, true, true, true, true, false, false]);
    expect(rows[0]).toMatchObject({ start: "09:00", end: "17:00" });
    expect(hoursWords(DEFAULT_AUTO_REPLIES.hours)[0]).toBe("Monday: 9:00 am to 5:00 pm");
    expect(hoursWords(DEFAULT_AUTO_REPLIES.hours)[6]).toBe("Sunday: closed");
    expect(hoursWords([{ weekday: 1, start_minute: 0, end_minute: 1440 }])[0]).toBe(
      "Monday: 12:00 am to 11:59 pm",
    );
    expect(clockOf(0)).toBe("00:00");
    expect(clockOf(1440)).toBe("23:59");
    expect(minuteOf("09:30")).toBe(570);
    expect(minuteOf("24:00")).toBeNull();
    expect(minuteOf("9am")).toBeNull();
  });

  it("previews the words as a customer reads them", () => {
    expect(previewWords("Hi {{first_name}}, from {{business_name}}", "A Made Up Studio")).toBe(
      "Hi Sam, from A Made Up Studio",
    );
    expect(previewWords("Hi {{first_name}}", "S", "")).toBe("Hi there");
  });

  it("knows when the words differ, and only the words", () => {
    const saved = parseAutoReplies({ version: 1, instagram: { on: false, message: "Thanks!" } });
    const next = (over: object) => parseAutoReplies({ ...saved, ...over });
    expect(autoReplyWordsChanged(next({}), saved)).toBe(false);
    expect(
      autoReplyWordsChanged(
        next({
          instagram: { on: true, when: "both", message: "Thanks!" },
          quiet_hours: 3,
          hours: [],
        }),
        saved,
      ),
    ).toBe(false);
    expect(autoReplyWordsChanged(next({ instagram: { message: "Thanks." } }), saved)).toBe(true);
    expect(autoReplyWordsChanged(next({ email: { away_message: "Away" } }), saved)).toBe(true);
  });
});
