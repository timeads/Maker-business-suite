import { describe, expect, it } from "vitest";
import { localDate, periodKeys, periodLabel, resolveRange, startOfLocalDay } from "./range";

const NY = "America/New_York";

describe("local days", () => {
  it("knows the date somewhere else", () => {
    // 02:30 UTC on Nov 1 is still Oct 31 in New York.
    expect(localDate(new Date("2026-11-01T02:30:00Z"), NY)).toEqual({
      year: 2026,
      month: 10,
      day: 31,
    });
    expect(localDate(new Date("2026-11-01T02:30:00Z"), "UTC")).toEqual({
      year: 2026,
      month: 11,
      day: 1,
    });
  });

  it("finds midnight on both sides of a clock change", () => {
    // US clocks go back on Nov 1, 2026: UTC-4 before, UTC-5 after.
    expect(startOfLocalDay({ year: 2026, month: 11, day: 1 }, NY).toISOString()).toBe(
      "2026-11-01T04:00:00.000Z",
    );
    expect(startOfLocalDay({ year: 2026, month: 11, day: 2 }, NY).toISOString()).toBe(
      "2026-11-02T05:00:00.000Z",
    );
    // And forward on Mar 8, 2026.
    expect(startOfLocalDay({ year: 2026, month: 3, day: 8 }, NY).toISOString()).toBe(
      "2026-03-08T05:00:00.000Z",
    );
    expect(startOfLocalDay({ year: 2026, month: 3, day: 9 }, NY).toISOString()).toBe(
      "2026-03-09T04:00:00.000Z",
    );
  });
});

describe("resolveRange", () => {
  const now = new Date("2026-11-21T15:00:00Z");

  it("covers twelve whole months ending today, in the workspace's timezone", () => {
    const range = resolveRange("last_12_months", now, NY);
    expect(range.from.toISOString()).toBe("2025-12-01T05:00:00.000Z");
    expect(range.to.toISOString()).toBe("2026-11-22T05:00:00.000Z");
    expect(range.grouping).toBe("month");
    expect(periodKeys(range, NY)).toHaveLength(12);
    expect(periodKeys(range, NY)[0]).toBe("2025-12-01");
    expect(periodKeys(range, NY).at(-1)).toBe("2026-11-01");
  });

  it("uses days for a month and weeks for a quarter", () => {
    const month = resolveRange("last_30_days", now, NY);
    expect(month.grouping).toBe("day");
    expect(periodKeys(month, NY)).toHaveLength(30);
    expect(periodKeys(month, NY).at(-1)).toBe("2026-11-21");

    const quarter = resolveRange("last_90_days", now, NY);
    expect(quarter.grouping).toBe("week");
    const weeks = periodKeys(quarter, NY);
    // Weeks start on Monday, like the database's date_trunc.
    for (const week of weeks) expect(new Date(`${week}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(weeks.at(-1)).toBe("2026-11-16");
  });

  it("starts 'this year' on January 1 local time", () => {
    const range = resolveRange("this_year", now, NY);
    expect(range.from.toISOString()).toBe("2026-01-01T05:00:00.000Z");
    expect(periodKeys(range, NY)).toHaveLength(11);
  });

  it("uses the workspace's 'today', not UTC's", () => {
    // 01:00 UTC on the 22nd is still the 21st in New York.
    const late = resolveRange("last_30_days", new Date("2026-11-22T01:00:00Z"), NY);
    expect(periodKeys(late, NY).at(-1)).toBe("2026-11-21");
  });
});

describe("periodLabel", () => {
  it("labels months and days briefly", () => {
    expect(periodLabel("2026-11-01", "month")).toBe("Nov");
    expect(periodLabel("2026-11-09", "week")).toBe("Nov 9");
    expect(periodLabel("2026-11-01", "month", true)).toBe("Nov 2026");
  });
});
