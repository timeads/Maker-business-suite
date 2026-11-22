import { describe, expect, it } from "vitest";
import {
  linkPageSchema,
  linksFromText,
  monthReview,
  openSlots,
  socialPlanSchema,
  type PlannedPost,
} from "./plan";

const plan = socialPlanSchema.parse({
  version: 1,
  topics: [
    { id: "process", name: "In the studio" },
    { id: "new", name: "New work" },
  ],
  slots: [
    { weekday: 2, time: "10:00", topic: "process" },
    { weekday: 5, time: "17:30", topic: "new" },
  ],
});
// Monday 2 November 2026, 09:00 in New York (clocks went back the day before).
const NOW = new Date("2026-11-02T14:00:00Z");
const TZ = "America/New_York";

describe("open posting times", () => {
  it("lists the plan's times that have nothing lined up, on the workspace's clock", () => {
    const open = openSlots(plan, [], NOW, 7, TZ);
    expect(open).toEqual([
      { day: "2026-11-03", time: "10:00", topic: "process", at: "2026-11-03T15:00:00.000Z" },
      { day: "2026-11-06", time: "17:30", topic: "new", at: "2026-11-06T22:30:00.000Z" },
    ]);
  });

  it("a post at that time, or on that day for the same topic, fills the slot", () => {
    const posts: PlannedPost[] = [
      {
        status: "scheduled",
        scheduled_for: "2026-11-03T15:00:00Z",
        planned_for: null,
        topic: null,
      },
      { status: "draft", scheduled_for: null, planned_for: "2026-11-06T14:00:00Z", topic: "new" },
    ];
    expect(openSlots(plan, posts, NOW, 7, TZ)).toEqual([]);
  });

  it("a post that failed doesn't count, and times already past are left out", () => {
    const failed: PlannedPost[] = [
      { status: "failed", scheduled_for: "2026-11-03T15:00:00Z", planned_for: null, topic: null },
    ];
    expect(openSlots(plan, failed, NOW, 2, TZ)).toHaveLength(1);
    const lateTuesday = new Date("2026-11-03T16:00:00Z");
    expect(openSlots(plan, [], lateTuesday, 1, TZ)).toEqual([]);
  });
});

describe("the month in review", () => {
  it("counts what went out per topic against what the plan asks for", () => {
    const review = monthReview(plan, [
      { status: "published", topic: "process", channels: ["instagram", "facebook"] },
      { status: "published", topic: "process", channels: ["instagram"] },
      { status: "published", topic: null, channels: ["facebook"] },
      { status: "failed", topic: "new", channels: ["instagram"] },
      { status: "draft", topic: "new", channels: [] },
    ]);
    expect(review.posted).toBe(3);
    expect(review.failed).toBe(1);
    expect(review.topics).toEqual([
      { id: "process", name: "In the studio", posted: 2, planned: 4 },
      { id: "new", name: "New work", posted: 0, planned: 4 },
    ]);
    expect(review.other).toBe(1);
    expect(review.channels).toEqual([
      ["instagram", 2],
      ["facebook", 2],
    ]);
  });
});

describe("link page", () => {
  it("reads links typed one per line, adding https and a label where missing", () => {
    expect(
      linksFromText("Shop | https://wildthread.example/shop\nwildthread.example/classes\n\n"),
    ).toEqual({
      links: [
        { id: "l1", label: "Shop", url: "https://wildthread.example/shop" },
        {
          id: "l2",
          label: "wildthread.example/classes",
          url: "https://wildthread.example/classes",
        },
      ],
    });
  });

  it("refuses anything that isn't an ordinary web link", () => {
    expect(linksFromText("Click | javascript:alert(1)")).toEqual({
      error: "Line 1 needs a web address starting with https://",
    });
    expect(
      linkPageSchema.safeParse({
        version: 1,
        links: [{ id: "l1", label: "x", url: "http://plain.example" }],
      }).success,
    ).toBe(false);
  });
});
