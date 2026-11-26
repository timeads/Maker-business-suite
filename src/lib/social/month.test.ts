import { describe, expect, it } from "vitest";
import {
  MAX_CAROUSEL,
  chooseCarousel,
  comingReviewDay,
  freshPhotos,
  monthDue,
  monthEnd,
  monthSlots,
  nthWeekday,
  planProjects,
  projectTopic,
  reviewDayFor,
  reviewDayWords,
  spread,
  upcomingMonth,
  usedPhotos,
  type MonthProject,
  type ProjectPhoto,
} from "./month";
import { socialPlanSchema } from "./plan";

// Ported from the Content Hub's drafting tests (review days, carousels and the
// month's plan), with the suite's own brands and clock. Every name is invented.

const FIRST_MONDAY = { week: 1, weekday: 1, lead_days: 10 };
const MAIN = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", is_default: true };
const SIDE = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", is_default: false };
const TZ = "America/New_York";

describe("review days", () => {
  it("finds the nth weekday of a month", () => {
    expect(nthWeekday("2026-12-15", 1, 1)).toBe("2026-12-07");
    expect(nthWeekday("2027-01-20", 1, 1)).toBe("2027-01-04");
    expect(nthWeekday("2026-11-01", 1, 1)).toBe("2026-11-02");
    expect(nthWeekday("2026-11-01", 4, 5)).toBe("2026-11-27");
    expect(nthWeekday("2026-11-01", 1, 0)).toBe("2026-11-01");
  });

  it("names the coming review day, today included, and the month it starts", () => {
    expect(comingReviewDay("2026-11-28", FIRST_MONDAY)).toBe("2026-12-07");
    expect(comingReviewDay("2026-12-07", FIRST_MONDAY)).toBe("2026-12-07");
    expect(comingReviewDay("2026-12-08", FIRST_MONDAY)).toBe("2027-01-04");
    expect(monthEnd("2026-12-07", FIRST_MONDAY)).toBe("2027-01-03");
    const day = { brand_id: null, auto: false, ...FIRST_MONDAY };
    expect(upcomingMonth("2026-11-28", day)).toEqual({ start: "2026-12-07", end: "2027-01-03" });
    expect(reviewDayWords(day)).toBe("the first Monday of the month");
  });

  it("is due once the lead time before the review day has begun, and on the day", () => {
    expect(monthDue("2026-11-26", FIRST_MONDAY)).toBeNull();
    expect(monthDue("2026-11-27", FIRST_MONDAY)).toBe("2026-12-07");
    expect(monthDue("2026-12-07", FIRST_MONDAY)).toBe("2026-12-07");
    // Lead 0: only on the review day itself.
    expect(monthDue("2026-12-06", { ...FIRST_MONDAY, lead_days: 0 })).toBeNull();
    expect(monthDue("2026-12-07", { ...FIRST_MONDAY, lead_days: 0 })).toBe("2026-12-07");
    // The day after: the next month is a long way off.
    expect(monthDue("2026-12-08", FIRST_MONDAY)).toBeNull();
  });

  it("gives each brand its own day; the main brand's names no brand", () => {
    const plan = socialPlanSchema.parse({
      version: 1,
      review_days: [
        { brand_id: null, week: 1, weekday: 1 },
        { brand_id: SIDE.id, week: 2, weekday: 3, auto: true },
      ],
    });
    expect(reviewDayFor(plan, MAIN)).toMatchObject({ week: 1, weekday: 1, auto: false });
    expect(reviewDayFor(plan, SIDE)).toMatchObject({ week: 2, weekday: 3, auto: true });
    expect(reviewDayFor(socialPlanSchema.parse({ version: 1 }), MAIN)).toBeNull();
  });

  it("refuses two review days for one brand, and keeps the run off by default", () => {
    expect(
      socialPlanSchema.safeParse({
        version: 1,
        review_days: [{ brand_id: null }, { brand_id: null, week: 2 }],
      }).success,
    ).toBe(false);
    const plan = socialPlanSchema.parse({ version: 1, review_days: [{}] });
    expect(plan.review_days[0]).toEqual({
      brand_id: null,
      week: 1,
      weekday: 1,
      lead_days: 0,
      auto: false,
    });
  });
});

describe("the month's open times", () => {
  const plan = socialPlanSchema.parse({
    version: 1,
    topics: [
      { id: "work", name: "Work in progress", from: "projects" },
      { id: "tips", name: "Tips" },
    ],
    slots: [
      { weekday: 1, time: "10:00", topic: "tips" },
      { weekday: 4, time: "10:00", topic: "work" },
      { weekday: 6, time: "09:00", topic: null, brand_id: SIDE.id },
    ],
  });
  const now = new Date("2027-02-25T12:00:00Z");

  it("lists the brand's times on its clock, across the change to summer time", () => {
    // Clocks go forward on Sunday 14 March 2027 in New York.
    const slots = monthSlots(plan, { start: "2027-03-08", end: "2027-03-21" }, MAIN, [], now, TZ);
    expect(slots.map((s) => [s.at, s.kind])).toEqual([
      ["2027-03-08T15:00:00.000Z", "topic"],
      ["2027-03-11T15:00:00.000Z", "project"],
      ["2027-03-15T14:00:00.000Z", "topic"],
      ["2027-03-18T14:00:00.000Z", "project"],
    ]);
  });

  it("leaves the times another brand has, and ones already lined up for this brand", () => {
    const taken = [
      {
        status: "draft",
        scheduled_for: null,
        planned_for: "2027-03-01T15:00:00Z",
        brand_id: MAIN.id,
      },
      // Another brand's post at the same time doesn't fill this brand's time.
      {
        status: "scheduled",
        scheduled_for: "2027-03-04T15:00:00Z",
        planned_for: null,
        brand_id: SIDE.id,
      },
      // A post that didn't go out doesn't hold a time.
      {
        status: "failed",
        scheduled_for: "2027-03-08T14:00:00Z",
        planned_for: null,
        brand_id: MAIN.id,
      },
    ];
    const main = monthSlots(plan, { start: "2027-03-01", end: "2027-03-14" }, MAIN, taken, now, TZ);
    expect(main.map((s) => s.day)).toEqual(["2027-03-04", "2027-03-08", "2027-03-11"]);
    const side = monthSlots(plan, { start: "2027-03-01", end: "2027-03-14" }, SIDE, [], now, TZ);
    expect(side.map((s) => [s.day, s.time])).toEqual([
      ["2027-03-06", "09:00"],
      ["2027-03-13", "09:00"],
    ]);
  });

  it("never offers a time already past", () => {
    const later = new Date("2027-03-05T00:00:00Z");
    const slots = monthSlots(plan, { start: "2027-03-01", end: "2027-03-08" }, MAIN, [], later, TZ);
    expect(slots.map((s) => s.day)).toEqual(["2027-03-08"]);
  });
});

const photo = (
  id: string,
  projectId: string | null,
  day: number,
  over: Partial<ProjectPhoto> = {},
) =>
  ({
    id,
    projectId,
    createdAt: `2026-11-${String(day).padStart(2, "0")}T10:00:00Z`,
    mimeType: "image/jpeg",
    tags: [],
    hidden: false,
    ...over,
  }) satisfies ProjectPhoto;

describe("carousels", () => {
  it("spreads evenly and keeps the first and the last", () => {
    expect(spread([1, 2, 3, 4, 5, 6, 7, 8, 9], 4)).toEqual([1, 4, 6, 9]);
    expect(spread([1, 2], 4)).toEqual([1, 2]);
    expect(spread([1, 2, 3], 1)).toEqual([1]);
  });

  it("keeps photos in the order they were added and leaves out used, hidden, artwork and video", () => {
    const photos = [
      photo("c", "p", 3),
      photo("a", "p", 1),
      photo("used", "p", 2),
      photo("hid", "p", 4, { hidden: true }),
      photo("art", "p", 5, { tags: ["Designed"] }),
      photo("logo", "p", 6, { tags: ["logo"] }),
      photo("clip", "p", 7, { mimeType: "video/mp4" }),
      photo("b", "p", 2),
    ];
    expect(freshPhotos(photos, new Set(["used"])).map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("thins a long project to six, and gives nothing when fewer than two are new", () => {
    const many = Array.from({ length: 12 }, (_, i) => photo(`p${i + 1}`, "p", i + 1));
    const chosen = chooseCarousel(many, new Set());
    expect(chosen).toHaveLength(MAX_CAROUSEL);
    expect(chosen[0].id).toBe("p1");
    expect(chosen.at(-1)?.id).toBe("p12");
    expect(chooseCarousel([photo("x", "p", 1)], new Set())).toEqual([]);
  });

  it("counts every photo on any post as used", () => {
    expect([
      ...usedPhotos([
        { asset_id: "a", asset_ids: ["a", "b"] },
        { asset_id: null, asset_ids: null },
      ]),
    ]).toEqual(["a", "b"]);
  });
});

describe("planning the month's project posts", () => {
  const plan = socialPlanSchema.parse({
    version: 1,
    topics: [
      { id: "rugs", name: "Rugs", from: "projects" },
      { id: "classes", name: "Classes", from: "projects" },
      { id: "tips", name: "Tips" },
    ],
  });
  const project = (id: string, topic: string | null): MonthProject => ({
    id,
    name: id,
    note: "",
    topic,
  });
  const fox = project("fox", "rugs");
  const owl = project("owl", "rugs");
  const night = project("night-class", "classes");
  const photos = [
    ...[1, 2, 3, 4].map((d) => photo(`fox${d}`, "fox", d)),
    ...[5, 6, 7].map((d) => photo(`owl${d}`, "owl", d)),
    ...[8, 9].map((d) => photo(`class${d}`, "night-class", d)),
  ];

  it("files a project under its own topic, else the first project topic", () => {
    expect(projectTopic(night, plan)).toBe("classes");
    expect(projectTopic(project("loose", null), plan)).toBe("rugs");
    expect(projectTopic(project("odd", "tips"), plan)).toBe("rugs");
  });

  it("fills each time from its topic, takes turns, and never reuses a photo", () => {
    const picks = planProjects(plan, [fox, owl, night], photos, new Set(), [
      { topic: "rugs" },
      { topic: "rugs" },
      { topic: "classes" },
      { topic: "rugs" },
    ]);
    // Newest photos first: the owl, then the fox; the class on its own topic.
    expect(picks.map((p) => p?.project.id ?? null)).toEqual(["owl", "fox", "night-class", null]);
    const ids = picks.flatMap((p) => p?.photos.map((x) => x.id) ?? []);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("leaves a time empty when its topic has no project with new photos", () => {
    const used = new Set(["class8"]);
    expect(planProjects(plan, [night], photos, used, [{ topic: "classes" }])).toEqual([null]);
  });

  it("lets a project go twice only when no other can", () => {
    const big = Array.from({ length: 4 }, (_, i) => photo(`big${i}`, "fox", i + 1));
    const picks = planProjects(plan, [fox], big, new Set(), [{ topic: "rugs" }, { topic: "rugs" }]);
    expect(picks.map((p) => p?.photos.map((x) => x.id) ?? null)).toEqual([
      ["big0", "big1", "big2", "big3"],
      null,
    ]);
  });
});
