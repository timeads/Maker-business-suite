import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { bookingsHomeLines, loadBookingsHomeFacts, type BookingsHomeFacts } from "./home-summary";

const facts = (over: Partial<BookingsHomeFacts> = {}): BookingsHomeFacts => ({
  bookingsThisMonth: 12,
  placesThisMonth: 18,
  bookingsLastMonthToDate: 10,
  upcoming: { taken: 30, capacity: 40, dates: 5, full: 2 },
  returningThisMonth: 4,
  ...over,
});

describe("Bookings on the home card", () => {
  it("says the good news, most useful first", () => {
    expect(bookingsHomeLines(facts())).toEqual([
      "12 bookings this month (18 places), up 20% on last month at this point",
      "the next 30 days are 75% booked",
      "2 classes full",
      "4 people came back to book again",
    ]);
  });

  it("never says a fall, a quiet stretch or a zero", () => {
    expect(
      bookingsHomeLines(
        facts({
          bookingsThisMonth: 8,
          bookingsLastMonthToDate: 10,
          upcoming: { taken: 10, capacity: 40, dates: 5, full: 0 },
          returningThisMonth: 0,
        }),
      ),
    ).toEqual(["8 bookings this month (18 places)"]);
    expect(
      bookingsHomeLines(
        facts({
          bookingsThisMonth: 0,
          upcoming: { taken: 0, capacity: 0, dates: 0, full: 0 },
          returningThisMonth: 0,
        }),
      ),
    ).toEqual([]);
  });

  it("speaks of one in the singular and never rounds a gap up to 100%", () => {
    expect(
      bookingsHomeLines(
        facts({
          bookingsThisMonth: 1,
          placesThisMonth: 1,
          bookingsLastMonthToDate: 0,
          upcoming: { taken: 199, capacity: 200, dates: 1, full: 1 },
          returningThisMonth: 1,
        }),
      ),
    ).toEqual([
      "1 booking this month (1 place)",
      "the next 30 days are 99% booked",
      "1 class full",
      "1 person came back to book again",
    ]);
  });
});

/** A stand-in that records the time windows each query asks for. */
function recorder() {
  const asked: Record<string, string>[] = [];
  const chain = (table: string) => {
    const seen: Record<string, string> = { table };
    asked.push(seen);
    const q: Record<string, unknown> = {};
    for (const name of ["select", "eq", "is", "in", "limit"]) q[name] = () => q;
    q.gte = (col: string, v: string) => ((seen[`${col}>=`] = v), q);
    q.lt = (col: string, v: string) => ((seen[`${col}<`] = v), q);
    q.then = (resolve: (v: unknown) => void) => resolve({ data: [], count: 0, error: null });
    return q;
  };
  return { supabase: { from: chain } as unknown as SupabaseClient, asked };
}

describe("the month the card counts", () => {
  it("starts at midnight on the 1st on the workspace's clocks, across a clock change", async () => {
    const { supabase, asked } = recorder();
    // 15 March 2027, 9:30 in New York (daylight time since the 14th).
    await loadBookingsHomeFacts(
      supabase,
      { id: "t", timezone: "America/New_York" },
      new Date("2027-03-15T13:30:00Z"),
    );
    // 1 March was still on standard time: midnight is 05:00 UTC.
    expect(asked[0]["created_at>="]).toBe("2027-03-01T05:00:00.000Z");
    // Last month at this point: 15 February, 9:30 on the clocks (standard time).
    expect(asked[1]["created_at>="]).toBe("2027-02-01T05:00:00.000Z");
    expect(asked[1]["created_at<"]).toBe("2027-02-15T14:30:00.000Z");
  });
});
