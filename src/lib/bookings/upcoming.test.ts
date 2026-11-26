import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SHOP_PAGE } from "./shop-page";
import {
  DEFAULT_UPCOMING,
  parseUpcoming,
  safeProductUrl,
  upcomingAnswer,
  upcomingSchema,
  upcomingSnippet,
  type UpcomingRow,
} from "./upcoming";

const rows: UpcomingRow[] = [
  {
    id: "s1",
    starts_at: "2027-03-06T15:00:00.000Z",
    ends_at: "2027-03-06T18:00:00.000Z",
    service: "Rug tufting",
    location: " Studio 2 ",
    seats_left: 3,
    product_url: "https://shop.example/products/rug-tufting",
  },
  {
    // After the clocks go forward: the label follows.
    id: "s2",
    starts_at: "2027-03-20T14:00:00.000Z",
    ends_at: "2027-03-20T16:00:00.000Z",
    service: "Punch needle",
    location: null,
    seats_left: 1,
    product_url: "javascript:alert(1)",
  },
];

describe("the upcoming classes list", () => {
  it("is off until switched on, and reads anything unusable as off", () => {
    expect(DEFAULT_UPCOMING.on).toBe(false);
    expect(parseUpcoming({ version: 1, on: "yes" }).on).toBe(false);
    expect(upcomingSchema.safeParse({ version: 1, max_dates: 99 }).success).toBe(false);
  });

  it("answers in words, with the zone label of each date and only safe links", () => {
    const answer = upcomingAnswer(
      { ...DEFAULT_UPCOMING, on: true },
      { accent: "#123456" },
      rows,
      "America/New_York",
    );
    expect(answer.accent).toBe("#123456");
    expect(answer.classes[0]).toEqual({
      id: "s1",
      service: "Rug tufting",
      day: "Sat, Mar 6",
      time: "10:00 AM – 1:00 PM ET",
      where: "Studio 2",
      seats_left: 3,
      url: "https://shop.example/products/rug-tufting",
    });
    expect(answer.classes[1].time).toBe("10:00 AM – 12:00 PM ET");
    expect(answer.classes[1].url).toBeNull();
  });

  it("leaves the places out when the business chose to, and keeps to its number", () => {
    const answer = upcomingAnswer(
      { ...DEFAULT_UPCOMING, on: true, show_seats_left: false, max_dates: 1 },
      DEFAULT_SHOP_PAGE,
      rows,
      "Europe/London",
    );
    expect(answer.classes).toHaveLength(1);
    expect(answer.classes[0]).not.toHaveProperty("seats_left");
    expect(answer.classes[0].time).toBe("3:00 PM – 6:00 PM GMT");
  });

  it("only links to plain https pages", () => {
    expect(safeProductUrl("https://tufttheworld.com/products/a?variant=1")).toBe(
      "https://tufttheworld.com/products/a?variant=1",
    );
    for (const bad of [
      "http://shop.example/products/a",
      "https://user:pw@shop.example/",
      "https://shop.example:8443/",
      "https://localhost/",
      "data:text/html,hi",
      42,
    ]) {
      expect(safeProductUrl(bad), String(bad)).toBeNull();
    }
  });
});

describe("the workshops page snippet", () => {
  const snippet = upcomingSnippet(
    { contact_url: "", contact_email: "hello@studio.example" },
    { slug: "alice-rugs", site: "https://app.example.com" },
  );

  it("names the workspace, keeps its box from the first paint and loads late", () => {
    expect(snippet).toContain('data-workspace="alice-rugs"');
    expect(snippet).toContain("min-height: 320px");
    expect(snippet).toContain('<script src="https://app.example.com/upcoming-classes.js" defer>');
  });

  it("waits with a plain message and a way to get in touch", () => {
    expect(snippet).toContain("We couldn't show the class dates just now.");
    expect(snippet).toContain('href="mailto:hello@studio.example"');
    expect(snippet).toContain("animation: mbs-fallback 0s linear 6s forwards");
  });
});

describe("the list's script", () => {
  const source = readFileSync(join(process.cwd(), "public", "upcoming-classes.js"), "utf8");

  it("stays small and plain: no libraries, no markup from outside", () => {
    expect(source.length).toBeLessThan(8000);
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    expect(source).not.toMatch(/\bimport\b|require\(/);
    expect(source).toContain('attachShadow({ mode: "open" })');
    expect(source).toContain('credentials: "omit"');
  });
});
