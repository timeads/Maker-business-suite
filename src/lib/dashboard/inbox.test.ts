import { describe, expect, it } from "vitest";
import { inboxHref, likePattern, monthBounds, monthName, parseInboxQuery } from "./inbox";

describe("the expense inbox's address", () => {
  it("reads what it understands and falls back for the rest", () => {
    expect(parseInboxQuery({})).toEqual({ view: "to_sort", q: "", month: null, page: 1 });
    expect(
      parseInboxQuery({ view: "sorted", q: "  yarn   barn ", month: "2026-10", page: "3" }),
    ).toEqual({ view: "sorted", q: "yarn barn", month: "2026-10", page: 3 });
    expect(parseInboxQuery({ view: "everything", month: "2026-13", page: "-2" })).toEqual({
      view: "to_sort",
      q: "",
      month: null,
      page: 1,
    });
    expect(parseInboxQuery({ view: ["all", "sorted"] }).view).toBe("all");
  });

  it("writes only what differs from the start, back to the first page on a new filter", () => {
    const base = "/w/rugs/dashboard/expenses";
    const query = parseInboxQuery({ view: "sorted", q: "rent", month: "2026-10", page: "4" });
    expect(inboxHref(base, query, {})).toBe(`${base}?view=sorted&q=rent&month=2026-10`);
    expect(inboxHref(base, query, { page: 5 })).toBe(
      `${base}?view=sorted&q=rent&month=2026-10&page=5`,
    );
    expect(inboxHref(base, query, { view: "to_sort", q: "", month: null })).toBe(base);
  });

  it("gives a month's first day and the next month's", () => {
    expect(monthBounds("2026-10")).toEqual({ from: "2026-10-01", to: "2026-11-01" });
    expect(monthBounds("2026-12")).toEqual({ from: "2026-12-01", to: "2027-01-01" });
    expect(monthName("2026-10")).toBe("October 2026");
  });

  it("takes wildcards in the search words literally", () => {
    expect(likePattern("50% Off_Sale")).toBe("%50\\% off\\_sale%");
    expect(likePattern("a\\b")).toBe("%a\\\\b%");
  });
});
