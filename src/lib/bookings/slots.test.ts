import { describe, expect, it } from "vitest";
import {
  formatMinutes,
  formatWhen,
  generateSlots,
  isOfferedSlot,
  localDay,
  parseClock,
  zonedTimeToUtc,
} from "./slots";

const NY = "America/New_York";

describe("zonedTimeToUtc", () => {
  it("follows the timezone's offset on either side of a clock change", () => {
    expect(zonedTimeToUtc("2027-01-15", 9 * 60, NY)?.toISOString()).toBe(
      "2027-01-15T14:00:00.000Z",
    );
    expect(zonedTimeToUtc("2027-07-15", 9 * 60, NY)?.toISOString()).toBe(
      "2027-07-15T13:00:00.000Z",
    );
  });

  it("has no answer for the hour skipped when clocks go forward", () => {
    // 14 March 2027, 2:00 → 3:00 in New York.
    expect(zonedTimeToUtc("2027-03-14", 2 * 60 + 30, NY)).toBeNull();
    expect(zonedTimeToUtc("2027-03-14", 3 * 60, NY)?.toISOString()).toBe(
      "2027-03-14T07:00:00.000Z",
    );
    expect(zonedTimeToUtc("2027-03-14", 60, NY)?.toISOString()).toBe("2027-03-14T06:00:00.000Z");
  });

  it("picks the first of the two when clocks go back", () => {
    // 7 November 2027, 1:30 happens twice in New York.
    expect(zonedTimeToUtc("2027-11-07", 90, NY)?.toISOString()).toBe("2027-11-07T05:30:00.000Z");
    expect(zonedTimeToUtc("2027-11-07", 9 * 60, NY)?.toISOString()).toBe(
      "2027-11-07T14:00:00.000Z",
    );
  });

  it("handles zones ahead of UTC and half-hour offsets", () => {
    expect(zonedTimeToUtc("2027-05-01", 0, "Asia/Kolkata")?.toISOString()).toBe(
      "2027-04-30T18:30:00.000Z",
    );
    expect(zonedTimeToUtc("2027-05-01", 600, "Pacific/Auckland")?.toISOString()).toBe(
      "2027-04-30T22:00:00.000Z",
    );
  });
});

describe("generateSlots", () => {
  // Saturday 13 March 2027, 08:00 in New York.
  const now = new Date("2027-03-13T13:00:00Z");
  const weekend = [
    { weekday: 6, start_minute: 540, end_minute: 720 },
    { weekday: 0, start_minute: 60, end_minute: 240 },
  ];

  it("offers back-to-back times in local hours, across a clock change", () => {
    const slots = generateSlots({
      rules: weekend,
      durationMinutes: 60,
      timeZone: NY,
      now,
      days: 2,
      busy: [],
    });
    expect(slots.map((s) => s.startsAt)).toEqual([
      // Saturday 10:00 and 11:00 EST (9:00 is inside the two hours' notice)
      "2027-03-13T15:00:00.000Z",
      "2027-03-13T16:00:00.000Z",
      // Sunday 1:00 EST; 2:00 doesn't exist; 3:00 EDT
      "2027-03-14T06:00:00.000Z",
      "2027-03-14T07:00:00.000Z",
    ]);
    expect(slots[2].day).toBe("2027-03-14");
  });

  it("leaves out times that overlap something already booked", () => {
    const slots = generateSlots({
      rules: weekend,
      durationMinutes: 60,
      timeZone: NY,
      now,
      days: 1,
      busy: [{ starts_at: "2027-03-13T15:30:00Z", ends_at: "2027-03-13T16:00:00Z" }],
    });
    expect(slots.map((s) => s.startsAt)).toEqual(["2027-03-13T16:00:00.000Z"]);
  });

  it("only accepts start times the opening hours really offer", () => {
    const input = { rules: weekend, durationMinutes: 60, timeZone: NY, now, busy: [] };
    expect(isOfferedSlot("2027-03-20T14:00:00.000Z", input)).toBe(true);
    expect(isOfferedSlot("2027-03-20T14:30:00.000Z", input)).toBe(false);
    expect(isOfferedSlot("2027-03-12T14:00:00.000Z", input)).toBe(false);
    expect(isOfferedSlot("not a date", input)).toBe(false);
  });
});

describe("formatting", () => {
  it("shows times in the workspace's zone with its abbreviation", () => {
    expect(formatWhen("2027-07-10T14:00:00Z", "2027-07-10T16:00:00Z", NY)).toBe(
      "Sat, Jul 10, 10:00 AM – 12:00 PM EDT",
    );
    expect(localDay(new Date("2027-07-11T02:00:00Z"), NY)).toBe("2027-07-10");
  });

  it("reads and writes clock times", () => {
    expect(parseClock("09:30")).toBe(570);
    expect(parseClock("24:00")).toBe(1440);
    expect(parseClock("24:30")).toBeNull();
    expect(parseClock("9am")).toBeNull();
    expect(formatMinutes(570)).toBe("9:30 AM");
    expect(formatMinutes(720)).toBe("12:00 PM");
  });
});
