import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  dailyEmail,
  dailyEmailSchema,
  drainDailyEmails,
  hourWords,
  loadDailyFacts,
  parseDailyEmail,
  type DailyFacts,
} from "./daily-email";

const facts: DailyFacts = {
  business: "Alice Rugs",
  timezone: "America/New_York",
  day: "2027-03-14",
  today: [
    {
      service: "Rug tufting",
      starts_at: "2027-03-14T14:00:00Z",
      ends_at: "2027-03-14T17:00:00Z",
      taken: 8,
      capacity: 10,
      cancelled: false,
    },
    {
      service: "Punch needle",
      starts_at: "2027-03-14T19:00:00Z",
      ends_at: "2027-03-14T21:00:00Z",
      taken: 7,
      capacity: 6,
      cancelled: false,
    },
    {
      service: "Called off",
      starts_at: "2027-03-14T20:00:00Z",
      ends_at: "2027-03-14T21:00:00Z",
      taken: 0,
      capacity: 6,
      cancelled: true,
    },
  ],
  tomorrow: [],
  newBookings: [
    {
      name: "Pat Example",
      service: "Rug tufting",
      starts_at: "2027-03-21T14:00:00Z",
      ends_at: "2027-03-21T17:00:00Z",
      seats: 2,
    },
  ],
  oversold: 1,
  needsDate: 2,
  link: "https://app.example/w/alice/bookings",
};

describe("the daily email's words", () => {
  const email = dailyEmail(facts, "alice@a.test");

  it("leads with today: how many classes and people", () => {
    expect(email.to).toBe("alice@a.test");
    expect(email.subject).toBe("Today at Alice Rugs: 2 classes, 15 people booked");
  });

  it("lists today's and tomorrow's classes, how full, on the workspace's clock", () => {
    expect(email.text).toContain("Today, Sunday, March 14");
    // The clocks went forward that morning: the label says so.
    expect(email.text).toContain(
      "• Rug tufting, Sun, Mar 14, 10:00 AM – 1:00 PM EDT: 8 of 10 places booked",
    );
    expect(email.text).toContain("7 of 6 places booked (over its limit)");
    expect(email.text).not.toContain("Called off");
    expect(email.text).toContain("Tomorrow, Monday, March 15\nNothing on.");
  });

  it("says what's new and what needs someone", () => {
    expect(email.text).toContain("New bookings in the last day: 1");
    expect(email.text).toContain("• Pat Example, Rug tufting on Sun, Mar 21, 10:00 AM");
    expect(email.text).toContain("(2 places)");
    expect(email.text).toContain("• 1 booking is over a date's limit.");
    expect(email.text).toContain("• 2 shop orders paid for a workshop with no date.");
    expect(email.text).toContain("See everything: https://app.example/w/alice/bookings");
  });

  it("is calm on a quiet day", () => {
    const quiet = dailyEmail(
      { ...facts, today: [], newBookings: [], oversold: 0, needsDate: 0 },
      "a@a.test",
    );
    expect(quiet.subject).toBe("Your bookings at Alice Rugs: Sunday, March 14");
    expect(quiet.text).toContain("No new bookings in the last day.");
    expect(quiet.text).not.toContain("Needs you");
  });
});

describe("the daily email's settings", () => {
  it("are off by default, at 7 a.m., to nobody", () => {
    expect(parseDailyEmail(undefined)).toEqual({ version: 1, on: false, hour: 7, recipients: [] });
    expect(dailyEmailSchema.safeParse({ version: 1, hour: 24 }).success).toBe(false);
    expect(dailyEmailSchema.safeParse({ version: 1, recipients: ["pat@x"] }).success).toBe(false);
    expect(hourWords(0)).toBe("midnight");
    expect(hourWords(7)).toBe("7 a.m.");
    expect(hourWords(12)).toBe("noon");
    expect(hourWords(17)).toBe("5 p.m.");
  });
});

function fakeAdmin(claims: object[]) {
  const finished: Record<string, unknown>[] = [];
  const admin = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "claim_booking_daily_emails") return { data: claims, error: null };
      finished.push(args);
      return { data: "sent", error: null };
    },
  } as unknown as SupabaseClient;
  return { admin, finished };
}

const claim = (id: string, tenant = "t1") => ({
  send_id: id,
  tenant_id: tenant,
  user_id: "u",
  email: `${id}@a.test`,
  day: "2027-03-14",
});
const tenant = async (id: string) => ({ id, name: "Alice Rugs", slug: "alice", timezone: "UTC" });

describe("sending the daily emails", () => {
  it("claims nothing while email isn't set up", async () => {
    const { admin, finished } = fakeAdmin([claim("a")]);
    expect(await drainDailyEmails(admin, { configured: () => false })).toBe(0);
    expect(finished).toEqual([]);
  });

  it("works the facts out once per workspace and day, and writes down each send", async () => {
    const { admin, finished } = fakeAdmin([claim("a"), claim("b")]);
    let reads = 0;
    const sent: string[] = [];
    const n = await drainDailyEmails(admin, {
      configured: () => true,
      open: async () => true,
      tenant,
      facts: async () => {
        reads += 1;
        return facts;
      },
      deliver: async (email) => {
        sent.push(email.to);
        return { outcome: "sent", detail: "" };
      },
      site: () => "https://app.example",
    });
    expect(n).toBe(2);
    expect(reads).toBe(1);
    expect(sent).toEqual(["a@a.test", "b@a.test"]);
    expect(finished.map((f) => f.p_outcome)).toEqual(["sent", "sent"]);
  });

  it("skips a workspace whose plan no longer has bookings, and never asks the mail service", async () => {
    const { admin, finished } = fakeAdmin([claim("a")]);
    await drainDailyEmails(admin, {
      configured: () => true,
      open: async () => false,
      tenant,
      deliver: async () => {
        throw new Error("must not be reached");
      },
    });
    expect(finished[0]).toMatchObject({ p_outcome: "skipped" });
  });

  it("a crash before the mail service is asked is a refusal, tried again later", async () => {
    const { admin, finished } = fakeAdmin([claim("a")]);
    await drainDailyEmails(admin, {
      configured: () => true,
      open: async () => true,
      tenant,
      facts: async () => {
        throw new Error("database blip");
      },
      deliver: async () => {
        throw new Error("must not be reached");
      },
    });
    expect(finished[0]).toMatchObject({ p_outcome: "refused" });
  });

  it("passes on an unsure send as unsure", async () => {
    const { admin, finished } = fakeAdmin([claim("a")]);
    await drainDailyEmails(admin, {
      configured: () => true,
      open: async () => true,
      tenant,
      facts: async () => facts,
      deliver: async () => ({ outcome: "unsure", detail: "We never heard back." }),
    });
    expect(finished[0]).toMatchObject({ p_outcome: "unsure", p_detail: "We never heard back." });
  });
});

describe("the days the email covers", () => {
  it("are the workspace's own calendar days, across the spring clock change", async () => {
    const asked: Record<string, string>[] = [];
    const chain = () => {
      const seen: Record<string, string> = {};
      asked.push(seen);
      const q: Record<string, unknown> = {};
      for (const name of ["select", "eq", "is", "gt", "order", "limit"]) q[name] = () => q;
      q.gte = (col: string, v: string) => ((seen[`${col}>=`] = v), q);
      q.lt = (col: string, v: string) => ((seen[`${col}<`] = v), q);
      q.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
      return q;
    };
    const admin = { from: chain } as unknown as SupabaseClient;
    const out = await loadDailyFacts(
      admin,
      {
        id: "0b0e0f9a-1111-4222-8333-944455556666",
        name: "A",
        slug: "a",
        timezone: "America/New_York",
      },
      "2027-03-14",
      "https://app.example",
      new Date("2027-03-14T11:05:00Z"),
    );
    // Midnight on the 14th is still standard time; midnight on the 16th is daylight time.
    expect(asked[0]["starts_at>="]).toBe("2027-03-14T05:00:00.000Z");
    expect(asked[0]["starts_at<"]).toBe("2027-03-16T04:00:00.000Z");
    expect(asked[1]["created_at>="]).toBe("2027-03-13T11:05:00.000Z");
    expect(out.link).toBe("https://app.example/w/a/bookings");
  });
});
