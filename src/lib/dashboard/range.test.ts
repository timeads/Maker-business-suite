import { describe, expect, it } from "vitest";
import {
  currentMonth,
  localDate,
  pageRange,
  parsePeriod,
  periodChoices,
  periodKeys,
  periodLabel,
  periodName,
  periodPhrase,
  periodRange,
  periodValue,
  rangeMonths,
  resolveRange,
  startOfLocalDay,
} from "./range";

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

  it("runs this month and this quarter from their first day to the end of today", () => {
    const month = resolveRange("this_month", now, NY);
    expect(month.from.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(month.to.toISOString()).toBe("2026-11-22T05:00:00.000Z");
    expect(month.grouping).toBe("day");
    expect(periodKeys(month, NY)).toHaveLength(21);
    // The clocks went back on Nov 1: the month still starts at local midnight.
    const quarter = resolveRange("this_quarter", now, NY);
    expect(quarter.from.toISOString()).toBe("2026-10-01T04:00:00.000Z");
    expect(quarter.grouping).toBe("week");
  });

  it("ends last month, last quarter and last year where the next one starts", () => {
    const month = resolveRange("last_month", now, NY);
    expect(month.from.toISOString()).toBe("2026-10-01T04:00:00.000Z");
    expect(month.to.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(periodKeys(month, NY)).toHaveLength(31);
    expect(periodKeys(month, NY).at(-1)).toBe("2026-10-31");

    const quarter = resolveRange("last_quarter", now, NY);
    expect(quarter.from.toISOString()).toBe("2026-07-01T04:00:00.000Z");
    expect(quarter.to.toISOString()).toBe("2026-10-01T04:00:00.000Z");

    const year = resolveRange("last_year", now, NY);
    expect(year.from.toISOString()).toBe("2025-01-01T05:00:00.000Z");
    expect(year.to.toISOString()).toBe("2026-01-01T05:00:00.000Z");
    expect(periodKeys(year, NY)).toHaveLength(12);
  });

  it("goes back across a year end and a spring clock change", () => {
    // Jan 3: last month is December of the year before.
    const january = resolveRange("last_month", new Date("2027-01-03T12:00:00Z"), NY);
    expect(january.from.toISOString()).toBe("2026-12-01T05:00:00.000Z");
    expect(january.to.toISOString()).toBe("2027-01-01T05:00:00.000Z");
    const lastQuarter = resolveRange("last_quarter", new Date("2027-01-03T12:00:00Z"), NY);
    expect(lastQuarter.from.toISOString()).toBe("2026-10-01T04:00:00.000Z");
    // March 2026 had its clocks go forward on the 8th: the month is still 31 days.
    const march = resolveRange("last_month", new Date("2026-04-02T12:00:00Z"), NY);
    expect(march.from.toISOString()).toBe("2026-03-01T05:00:00.000Z");
    expect(march.to.toISOString()).toBe("2026-04-01T04:00:00.000Z");
    expect(periodKeys(march, NY)).toHaveLength(31);
  });

  it("knows this month by the workspace's clock at a month's edge", () => {
    // 02:00 UTC on Dec 1 is still Nov 30 in New York, already Dec 1 in Tokyo.
    const edge = new Date("2026-12-01T02:00:00Z");
    expect(resolveRange("this_month", edge, NY).from.toISOString()).toBe(
      "2026-11-01T04:00:00.000Z",
    );
    expect(resolveRange("this_month", edge, "Asia/Tokyo").from.toISOString()).toBe(
      "2026-11-30T15:00:00.000Z",
    );
    expect(currentMonth(edge, NY)).toBe("2026-11");
    expect(currentMonth(edge, "Asia/Tokyo")).toBe("2026-12");
  });

  it("lists the calendar months a range touches, in the workspace's timezone", () => {
    expect(rangeMonths(resolveRange("last_quarter", now, NY), NY)).toEqual([
      "2026-07",
      "2026-08",
      "2026-09",
    ]);
    expect(rangeMonths(resolveRange("this_month", now, NY), NY)).toEqual(["2026-11"]);
    // Local midnight on Jan 1 in Berlin is still Dec 31 in UTC: it's January.
    expect(
      rangeMonths(
        resolveRange("last_month", new Date("2026-02-10T12:00:00Z"), "Europe/Berlin"),
        "Europe/Berlin",
      ),
    ).toEqual(["2026-01"]);
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

describe("a month, quarter or year picked by hand", () => {
  it("reads and writes the address", () => {
    expect(parsePeriod("m-2026-03")).toEqual({ kind: "month", year: 2026, n: 3 });
    expect(parsePeriod("q-2025-4")).toEqual({ kind: "quarter", year: 2025, n: 4 });
    expect(parsePeriod("y-2024")).toEqual({ kind: "year", year: 2024, n: 1 });
    for (const bad of ["m-2026-13", "q-2026-5", "y-26", "last_month", null]) {
      expect(parsePeriod(bad)).toBeNull();
    }
    expect(periodValue({ kind: "month", year: 2026, n: 3 })).toBe("m-2026-03");
  });

  it("runs between local midnights, across a clock change", () => {
    const march = periodRange({ kind: "month", year: 2026, n: 3 }, "America/New_York");
    // Standard time on the 1st, daylight saving from the 8th.
    expect(march.from.toISOString()).toBe("2026-03-01T05:00:00.000Z");
    expect(march.to.toISOString()).toBe("2026-04-01T04:00:00.000Z");
    expect(march.grouping).toBe("day");
    const q4 = periodRange({ kind: "quarter", year: 2026, n: 4 }, "America/New_York");
    expect(q4.from.toISOString()).toBe("2026-10-01T04:00:00.000Z");
    expect(q4.to.toISOString()).toBe("2027-01-01T05:00:00.000Z");
    expect(periodRange({ kind: "year", year: 2025, n: 1 }, "UTC").grouping).toBe("month");
  });

  it("names itself in a maker's words", () => {
    expect(periodName({ kind: "month", year: 2026, n: 3 })).toBe("March 2026");
    expect(periodName({ kind: "quarter", year: 2026, n: 2 })).toBe("April to June 2026");
    expect(periodPhrase({ kind: "year", year: 2025, n: 1 })).toBe("in 2025");
  });

  it("offers months, quarters and years from three Januaries back up to now", () => {
    const choices = periodChoices(new Date("2026-11-21T17:00:00Z"), "America/New_York");
    const months = choices.filter((c) => c.kind === "month");
    expect(months[0]).toEqual({ kind: "month", value: "m-2026-11", label: "November 2026" });
    expect(months.at(-1)?.value).toBe("m-2023-01");
    expect(choices.filter((c) => c.kind === "quarter")[0].label).toBe("Q4 2026 (Oct–Dec)");
    expect(choices.filter((c) => c.kind === "year").map((c) => c.value)).toEqual([
      "y-2026",
      "y-2025",
      "y-2024",
      "y-2023",
    ]);
  });

  it("falls back to a preset, and ends a period still running with today", () => {
    const now = new Date("2026-11-21T17:00:00Z");
    expect(pageRange("nonsense", "last_month", now, "America/New_York")).toMatchObject({
      preset: "last_month",
      period: null,
      phrase: "last month",
    });
    const picked = pageRange("m-2026-11", "last_month", now, "America/New_York");
    expect(picked.range.to.toISOString()).toBe("2026-11-22T05:00:00.000Z");
    expect(picked).toMatchObject({ preset: null, label: "November 2026", value: "m-2026-11" });
  });
});
