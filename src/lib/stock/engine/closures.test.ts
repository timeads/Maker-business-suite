import { describe, expect, it } from "vitest";
import {
  closedOn,
  closedSpans,
  dayNumber,
  daysApart,
  earliestArrival,
  latestOrderDay,
  nextClosure,
  planBuildAhead,
  shiftDay,
  type Closure,
} from "./closures";

// Made-up dates in the shape of a real year: a month shut in winter.
const festival: Closure = { name: "Spring Festival", startsOn: "2027-01-25", endsOn: "2027-02-21" };

describe("calendar days", () => {
  it("counts in whole days, whatever the clocks do", () => {
    // Across the days the clocks change in New York (Mar 14 and Nov 7, 2027).
    expect(shiftDay("2027-03-13", 2)).toBe("2027-03-15");
    expect(daysApart("2027-03-13", "2027-03-15")).toBe(2);
    expect(shiftDay("2027-11-06", 2)).toBe("2027-11-08");
    expect(daysApart("2027-11-06", "2027-11-08")).toBe(2);
    // Month ends, a leap day, and the turn of the year.
    expect(shiftDay("2028-02-28", 1)).toBe("2028-02-29");
    expect(shiftDay("2027-02-28", 1)).toBe("2027-03-01");
    expect(shiftDay("2027-01-01", -1)).toBe("2026-12-31");
    expect(daysApart("2026-12-31", "2027-01-01")).toBe(1);
    expect(daysApart("2027-01-10", "2027-01-01")).toBe(-9);
  });

  it("gives the same answers whichever timezone the server runs in", () => {
    const before = process.env.TZ;
    try {
      for (const zone of ["Pacific/Kiritimati", "Pacific/Pago_Pago", "America/New_York", "UTC"]) {
        process.env.TZ = zone;
        expect(shiftDay("2027-01-24", 1)).toBe("2027-01-25");
        expect(daysApart("2027-01-24", "2027-02-22")).toBe(29);
        expect(
          latestOrderDay({ needBy: "2027-02-10", leadDays: 30, closures: [festival] }).orderBy,
        ).toBe("2026-12-25");
      }
    } finally {
      process.env.TZ = before;
    }
  });

  it("knows a real day from a made-up one", () => {
    expect(dayNumber("2027-02-30")).toBeNull();
    expect(dayNumber("27-2-3")).toBeNull();
    expect(dayNumber("2027-02-03T00:00:00Z")).toBeNull();
    expect(dayNumber("2028-02-29")).not.toBeNull();
    expect(dayNumber("2027-02-29")).toBeNull();
  });
});

describe("closures as unbroken stretches", () => {
  it("joins closures that overlap or sit back to back, and names both", () => {
    const spans = closedSpans([
      { name: "Stocktake", startsOn: "2027-02-22", endsOn: "2027-02-24" },
      festival,
      { name: "Summer break", startsOn: "2027-08-01", endsOn: "2027-08-14" },
      { name: "Lantern day", startsOn: "2027-02-10", endsOn: "2027-02-12" },
    ]);
    expect(spans.map((s) => [s.startsOn, s.endsOn, s.name])).toEqual([
      ["2027-01-25", "2027-02-24", "Spring Festival, Lantern day and Stocktake"],
      ["2027-08-01", "2027-08-14", "Summer break"],
    ]);
  });

  it("keeps them apart when there is even one open day between", () => {
    const spans = closedSpans([
      festival,
      { name: "Stocktake", startsOn: "2027-02-23", endsOn: "2027-02-24" },
    ]);
    expect(spans).toHaveLength(2);
  });

  it("leaves out dates that make no sense, and takes a one-day closure", () => {
    const spans = closedSpans([
      { name: "Backwards", startsOn: "2027-03-10", endsOn: "2027-03-01" },
      { name: "Not a day", startsOn: "2027-02-30", endsOn: "2027-03-02" },
      { name: "Fire drill", startsOn: "2027-05-05", endsOn: "2027-05-05" },
      { name: "  ", startsOn: "2027-06-01", endsOn: "2027-06-02" },
    ]);
    expect(spans.map((s) => s.name)).toEqual(["Fire drill", "a closure"]);
    expect(closedSpans([])).toEqual([]);
  });

  it("says whether a supplier is shut on a day, ends included", () => {
    expect(closedOn("2027-01-24", [festival])).toBeNull();
    expect(closedOn("2027-01-25", [festival])?.name).toBe("Spring Festival");
    expect(closedOn("2027-02-21", [festival])?.name).toBe("Spring Festival");
    expect(closedOn("2027-02-22", [festival])).toBeNull();
    expect(nextClosure("2027-01-24", [festival])?.name).toBe("Spring Festival");
    // Once it has begun it is no longer "coming".
    expect(nextClosure("2027-01-25", [festival])).toBeNull();
  });
});

describe("the last day to order", () => {
  const ask = (needBy: string, leadDays: number, closures: Closure[] = [festival]) =>
    latestOrderDay({ needBy, leadDays, closures });

  it("is simply the lead time back when nothing is in the way", () => {
    expect(ask("2027-06-30", 30, [])).toEqual({
      orderBy: "2027-05-31",
      arrives: "2027-06-30",
      closure: null,
      daysEarlier: 0,
    });
    // Needed, and so arriving, the day before they shut: untouched.
    expect(ask("2027-01-24", 30)).toMatchObject({ orderBy: "2026-12-25", closure: null });
    // Ordered the day they reopen: untouched.
    expect(ask("2027-03-24", 30)).toMatchObject({ orderBy: "2027-02-22", closure: null });
  });

  it("moves before the closure when the lead time would run through it", () => {
    // Needed mid-closure: has to have landed the day before they shut.
    const mid = ask("2027-02-10", 30);
    expect(mid).toMatchObject({ orderBy: "2026-12-25", arrives: "2027-01-24", daysEarlier: 17 });
    expect(mid.closure?.name).toBe("Spring Festival");
    // Needed a week after they reopen: the 30 days would start inside the closure.
    expect(ask("2027-03-01", 30)).toMatchObject({ orderBy: "2026-12-25", daysEarlier: 36 });
    // Arriving on the very first closed day is already running through it.
    expect(ask("2027-01-25", 30)).toMatchObject({ orderBy: "2026-12-25", daysEarlier: 1 });
    // The last need-by date that is pushed: ordering the last closed day.
    expect(ask("2027-03-23", 30)).toMatchObject({ orderBy: "2026-12-25", daysEarlier: 58 });
  });

  it("treats back-to-back closures as one", () => {
    const backToBack = [
      festival,
      { name: "Stocktake", startsOn: "2027-02-22", endsOn: "2027-02-28" },
    ];
    // After the festival alone this would be fine (order Feb 22); the stocktake starts that day.
    const moved = ask("2027-03-24", 30, backToBack);
    expect(moved.orderBy).toBe("2026-12-25");
    expect(moved.closure?.name).toBe("Spring Festival and Stocktake");
    expect(moved.closure?.endsOn).toBe("2027-02-28");
    // Clear of both.
    expect(ask("2027-03-31", 30, backToBack)).toMatchObject({
      orderBy: "2027-03-01",
      closure: null,
    });
  });

  it("goes before both closures when the gap between them is shorter than the lead time", () => {
    const two = [festival, { name: "Qingming", startsOn: "2027-03-10", endsOn: "2027-03-14" }];
    // The gap is Feb 22 to Mar 9: sixteen days, no room for thirty.
    const moved = ask("2027-03-12", 30, two);
    expect(moved.orderBy).toBe("2026-12-25");
    expect(moved.arrives).toBe("2027-01-24");
    expect(moved.closure?.name).toBe("Spring Festival");
    // A ten-day lead time does fit in the gap: land the day before the second.
    const fits = ask("2027-03-12", 10, two);
    expect(fits).toMatchObject({ orderBy: "2027-02-27", arrives: "2027-03-09" });
    expect(fits.closure?.name).toBe("Qingming");
    // A lead time of exactly the gap's length doesn't fit (order day + 15 more).
    expect(ask("2027-03-12", 15, two)).toMatchObject({ orderBy: "2027-02-22" });
    expect(ask("2027-03-12", 16, two)).toMatchObject({ orderBy: "2027-01-08" });
  });

  it("copes with no lead time, a negative one and a need-by that isn't a day", () => {
    // Same-day supply: only the day itself has to be open.
    expect(ask("2027-02-10", 0)).toMatchObject({ orderBy: "2027-01-24", daysEarlier: 17 });
    expect(ask("2027-02-22", 0)).toMatchObject({ orderBy: "2027-02-22", closure: null });
    expect(ask("2027-06-30", -5, [])).toMatchObject({ orderBy: "2027-06-30" });
    expect(ask("soon", 30)).toEqual({
      orderBy: "soon",
      arrives: "soon",
      closure: null,
      daysEarlier: 0,
    });
  });

  it("can land in the past when the closure is already under way", () => {
    // Today is Feb 1; something runs out Feb 20. The honest answer is a date that has gone.
    const late = ask("2027-02-20", 30);
    expect(late.orderBy).toBe("2026-12-25");
    expect(daysApart("2027-02-01", late.orderBy)).toBeLessThan(0);
  });
});

describe("when an order placed today arrives", () => {
  const ask = (orderDay: string, leadDays: number, closures: Closure[] = [festival]) =>
    earliestArrival({ orderDay, leadDays, closures });

  it("is the lead time on when nothing is in the way", () => {
    expect(ask("2026-12-25", 30)).toEqual({
      startsOn: "2026-12-25",
      arrives: "2027-01-24",
      closure: null,
    });
    expect(ask("2027-02-22", 30)).toMatchObject({ arrives: "2027-03-24", closure: null });
  });

  it("is counted from the day they reopen when it would run through a closure", () => {
    const late = ask("2026-12-26", 30);
    expect(late).toMatchObject({ startsOn: "2027-02-22", arrives: "2027-03-24" });
    expect(late.closure?.name).toBe("Spring Festival");
    // Placed while they are shut.
    expect(ask("2027-02-01", 30)).toMatchObject({ startsOn: "2027-02-22", arrives: "2027-03-24" });
  });

  it("waits out a second closure too when the gap is shorter than the lead time", () => {
    const two = [festival, { name: "Qingming", startsOn: "2027-03-10", endsOn: "2027-03-14" }];
    const late = ask("2027-01-10", 30, two);
    expect(late).toMatchObject({ startsOn: "2027-03-15", arrives: "2027-04-14" });
    expect(late.closure?.name).toBe("Qingming");
    expect(ask("2027-01-10", 10, two)).toMatchObject({
      startsOn: "2027-01-10",
      arrives: "2027-01-20",
    });
    expect(ask("2027-01-16", 10, two)).toMatchObject({
      startsOn: "2027-02-22",
      arrives: "2027-03-04",
    });
  });
});

describe("ordering ahead of a closure", () => {
  it("gives the last day to order and how long the order must last", () => {
    const plan = planBuildAhead({ today: "2026-12-01", leadDays: 30, closures: [festival] })!;
    expect(plan.closure.name).toBe("Spring Festival");
    expect(plan.orderBefore).toBe("2026-12-25");
    expect(plan.missed).toBe(false);
    // The first order after they reopen (Feb 22) arrives Mar 24.
    expect(plan.nextArrival).toBe("2027-03-24");
    // From the day it lands (Jan 24) to that next arrival: the 28 closed days
    // plus one lead time, and a day. From today that is 113 days.
    expect(daysApart("2027-01-24", plan.nextArrival)).toBe(28 + 30 + 1);
    expect(plan.daysToCover).toBe(113);
  });

  it("says so when the last day has gone by but they haven't shut yet", () => {
    const plan = planBuildAhead({ today: "2027-01-10", leadDays: 30, closures: [festival] })!;
    expect(plan).toMatchObject({
      orderBefore: "2026-12-25",
      missed: true,
      nextArrival: "2027-03-24",
    });
    expect(plan.daysToCover).toBe(73);
    // On the last day itself there is still time.
    expect(
      planBuildAhead({ today: "2026-12-25", leadDays: 30, closures: [festival] })!.missed,
    ).toBe(false);
  });

  it("has nothing to plan once the closure is under way or over, or when none is set", () => {
    expect(planBuildAhead({ today: "2027-01-25", leadDays: 30, closures: [festival] })).toBeNull();
    expect(planBuildAhead({ today: "2027-03-01", leadDays: 30, closures: [festival] })).toBeNull();
    expect(planBuildAhead({ today: "2026-12-01", leadDays: 30, closures: [] })).toBeNull();
  });

  it("looks past a closure under way to the next one", () => {
    const two = [festival, { name: "Summer break", startsOn: "2027-08-01", endsOn: "2027-08-14" }];
    const plan = planBuildAhead({ today: "2027-02-01", leadDays: 30, closures: two })!;
    expect(plan.closure.name).toBe("Summer break");
    expect(plan.orderBefore).toBe("2027-07-01");
  });

  it("covers a second closure too when the lead time is longer than the gap after the first", () => {
    const two = [festival, { name: "Qingming", startsOn: "2027-03-10", endsOn: "2027-03-14" }];
    const plan = planBuildAhead({ today: "2026-12-01", leadDays: 30, closures: two })!;
    expect(plan.closure.name).toBe("Spring Festival");
    expect(plan.orderBefore).toBe("2026-12-25");
    // Nothing ordered in the sixteen-day gap would arrive: the next is after Qingming.
    expect(plan.nextArrival).toBe("2027-04-14");
    // And an order ahead of the *second* closure can't be placed in the gap either.
    const second = planBuildAhead({ today: "2027-02-23", leadDays: 30, closures: two })!;
    expect(second.closure.name).toBe("Qingming");
    expect(second).toMatchObject({ orderBefore: "2026-12-25", missed: true });
  });
});
