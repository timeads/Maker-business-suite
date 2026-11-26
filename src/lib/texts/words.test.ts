import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPT_OUT_LINE,
  DEFAULT_TEXT_SETTINGS,
  TEXT_KINDS,
  parseTextSettings,
  textSettingsSchema,
  textWordsChanged,
  textsAsked,
} from "./config";
import { DEFAULT_TEXTS, textFor, unknownTextFillIns, withOptOut } from "./words";

const booking = {
  customer_name: "Sam Shopper",
  service_name: "Rug Tufting",
  workspace_name: "Wild Thread",
  // 2 p.m. in New York on a winter's day.
  starts_at: "2027-01-16T19:00:00.000Z",
  ends_at: "2027-01-16T21:00:00.000Z",
  timezone: "America/New_York",
  seats: 2,
  location: "Studio 3",
  service_kind: "workshop" as const,
};

describe("the words of a booking text", () => {
  it("is off until switched on, message by message", () => {
    expect(DEFAULT_TEXT_SETTINGS.on).toBe(false);
    expect(TEXT_KINDS.every((kind) => !DEFAULT_TEXT_SETTINGS.messages[kind].on)).toBe(true);
    expect(textsAsked(DEFAULT_TEXT_SETTINGS)).toBe(false);
    const one = parseTextSettings({ version: 1, on: true, messages: { reminder: { on: true } } });
    expect(textsAsked(one)).toBe(true);
    expect(one.messages.confirmation).toEqual({ on: false, body: "" });
  });

  it("fills in the booking, on the workspace's clock, and ends with the opt-out line", () => {
    expect(textFor("confirmation", booking, DEFAULT_TEXT_SETTINGS)).toBe(
      `Wild Thread: you're booked for Rug Tufting on Saturday, January 16 at 2:00 PM ET, 2 places reserved. See you at Studio 3! ${DEFAULT_OPT_OUT_LINE}`,
    );
    // No place said: nothing dangling.
    expect(textFor("reminder", { ...booking, location: "" }, DEFAULT_TEXT_SETTINGS)).toBe(
      `Reminder from Wild Thread: Rug Tufting is coming up on Saturday, January 16 at 2:00 PM ET. See you soon! ${DEFAULT_OPT_OUT_LINE}`,
    );
  });

  it("says the zone the same way on both sides of a clock change", () => {
    const summer = {
      ...booking,
      starts_at: "2027-07-17T18:00:00.000Z",
      ends_at: "2027-07-17T20:00:00.000Z",
    };
    // 2 p.m. in New York in July (daylight time) and in January (standard time).
    expect(textFor("day_of", summer, DEFAULT_TEXT_SETTINGS)).toContain("at 2:00 PM ET today");
    expect(textFor("day_of", booking, DEFAULT_TEXT_SETTINGS)).toContain("at 2:00 PM ET today");
    // The day after the spring change, early: still the right hour.
    const march = {
      ...booking,
      starts_at: "2027-03-14T14:00:00.000Z",
      ends_at: "2027-03-14T16:00:00.000Z",
    };
    expect(textFor("reminder", march, DEFAULT_TEXT_SETTINGS)).toContain(
      "Sunday, March 14 at 10:00 AM ET",
    );
  });

  it("uses the business's own words when it wrote some, on one line, and never adds STOP twice", () => {
    const own = parseTextSettings({
      version: 1,
      messages: {
        day_of: { on: true, body: "Hi {{first_name}}!\nSee you at {{time}}. Reply STOP to stop." },
      },
    });
    expect(textFor("day_of", booking, own)).toBe(
      "Hi Sam! See you at 2:00 PM ET. Reply STOP to stop.",
    );
    expect(withOptOut("Hello", "Text STOP to end.")).toBe("Hello Text STOP to end.");
  });

  it("has standard words for every message, using only fill-ins texts have", () => {
    for (const kind of TEXT_KINDS) {
      expect(DEFAULT_TEXTS[kind]).toBeTruthy();
      expect(unknownTextFillIns(DEFAULT_TEXTS[kind]), kind).toEqual([]);
    }
    expect(unknownTextFillIns("Hi {{manage_link}} {{ First }}")).toEqual(["manage_link", "First"]);
  });

  it("keeps the opt-out line telling people to reply STOP", () => {
    expect(
      textSettingsSchema.safeParse({ version: 1, opt_out_line: "Text us to stop" }).success,
    ).toBe(false);
    expect(
      textSettingsSchema.safeParse({ version: 1, opt_out_line: "Reply STOP to end" }).success,
    ).toBe(true);
  });

  it("notices a change of words, apart from the switches and timing", () => {
    const on = parseTextSettings({ version: 1, on: true, reminder_hours: 24 });
    expect(textWordsChanged(on, DEFAULT_TEXT_SETTINGS)).toBe(false);
    const worded = parseTextSettings({ version: 1, messages: { followup: { body: "Thanks!" } } });
    expect(textWordsChanged(worded, DEFAULT_TEXT_SETTINGS)).toBe(true);
    const consent = parseTextSettings({
      version: 1,
      consent_words: "Text me about my booking please",
    });
    expect(textWordsChanged(consent, DEFAULT_TEXT_SETTINGS)).toBe(true);
  });
});
