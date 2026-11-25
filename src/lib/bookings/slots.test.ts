import { describe, expect, it } from "vitest";
import {
  formatMinutes,
  formatWhen,
  generateSlots,
  isOfferedSlot,
  localDay,
  parseClock,
  zoneLabel,
  zonedTimeToUtc,
} from "./slots";
import { formatMonth, monthGrid } from "./slots";

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

describe("monthGrid", () => {
  it("lays a month out in whole weeks starting on Sunday", () => {
    const grid = monthGrid("2027-02");
    // February 2027 starts on a Monday and ends on a Sunday.
    expect(grid.days[0]).toEqual([
      "2027-01-31",
      "2027-02-01",
      "2027-02-02",
      "2027-02-03",
      "2027-02-04",
      "2027-02-05",
      "2027-02-06",
    ]);
    expect(grid.days.at(-1)?.[0]).toBe("2027-02-28");
    expect(grid.days.every((week) => week.length === 7)).toBe(true);
  });

  it("steps across the year end", () => {
    expect(monthGrid("2026-12").next).toBe("2027-01");
    expect(monthGrid("2027-01").previous).toBe("2026-12");
    expect(formatMonth("2026-12")).toBe("December 2026");
  });
});

describe("zoneLabel", () => {
  it("says ET, CT, MT and PT all year, on either side of a clock change", () => {
    // US clocks went forward on 8 Mar 2026 and back on 1 Nov 2026, at 2am local.
    const moments = [
      "2026-03-08T06:59:00Z", // 1:59am EST, the last minute of winter time
      "2026-03-08T07:00:00Z", // 3:00am EDT
      "2026-07-04T16:00:00Z",
      "2026-11-01T05:59:00Z", // 1:59am EDT, the last minute of summer time
      "2026-11-01T06:00:00Z", // 1:00am EST
      "2026-12-25T16:00:00Z",
    ];
    for (const at of moments) {
      expect(zoneLabel("America/New_York", at), at).toBe("ET");
      expect(zoneLabel("America/Chicago", at), at).toBe("CT");
      expect(zoneLabel("America/Denver", at), at).toBe("MT");
      expect(zoneLabel("America/Los_Angeles", at), at).toBe("PT");
    }
    expect(zoneLabel("America/Toronto", new Date("2026-07-04T16:00:00Z"))).toBe("ET");
    expect(zoneLabel("America/Vancouver", "2026-01-04T16:00:00Z")).toBe("PT");
  });

  it("elsewhere uses the name people there use, which follows the clock change", () => {
    // UK clocks: forward 29 Mar 2026 at 01:00 UTC, back 25 Oct 2026 at 01:00 UTC.
    expect(zoneLabel("Europe/London", "2026-03-29T00:59:00Z")).toBe("GMT");
    expect(zoneLabel("Europe/London", "2026-03-29T01:00:00Z")).toBe("BST");
    expect(zoneLabel("Europe/London", "2026-10-25T00:59:00Z")).toBe("BST");
    expect(zoneLabel("Europe/London", "2026-10-25T01:00:00Z")).toBe("GMT");
    expect(zoneLabel("Europe/Berlin", "2026-07-04T10:00:00Z")).toBe("CEST");
    expect(zoneLabel("Europe/Berlin", "2026-01-04T10:00:00Z")).toBe("CET");
    expect(zoneLabel("Australia/Sydney", "2026-01-04T10:00:00Z")).toBe("AEDT");
    expect(zoneLabel("Australia/Sydney", "2026-07-04T10:00:00Z")).toBe("AEST");
    expect(zoneLabel("UTC", "2026-07-04T10:00:00Z")).toBe("UTC");
  });

  it("falls back to an offset where there is no short name, and to nothing for a bad zone", () => {
    expect(zoneLabel("Asia/Tokyo", "2026-07-04T10:00:00Z")).toBe("GMT+9");
    expect(zoneLabel("Not/AZone", "2026-07-04T10:00:00Z")).toBe("");
  });
});
