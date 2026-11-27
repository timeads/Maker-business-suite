import { describe, expect, it } from "vitest";
import { booksMonths, mixNote, monthFigure, rangeRevenue, type MonthFacts } from "./closed-months";
import { parseRevenueSettings } from "./lines";

// Made-up figures in whole cents: nothing here is a real business's.
const LINES = ["goods", "classes"];
const facts = (
  month: string,
  shop: Record<string, number>,
  books: number | null,
  invoices: Record<string, number> = {},
): MonthFacts => ({
  month,
  shop: Object.values(shop).reduce((a, b) => a + b, 0),
  shopLines: new Map(Object.entries(shop)),
  invoiceLines: new Map(Object.entries(invoices)),
  books,
});

describe("closed months from the books", () => {
  it("defaults to the shop, so nothing changes until a person switches it", () => {
    expect(parseRevenueSettings({ version: 1 }).closed_months).toBe("shop");
    expect(parseRevenueSettings({ version: 1, closed_months: "books" }).closed_months).toBe(
      "books",
    );
    expect(
      booksMonths({
        closed: "shop",
        whole: ["2026-09"],
        current: "2026-11",
        income: new Map([["2026-09", 100]]),
      }).size,
    ).toBe(0);
  });

  it("takes only complete, whole months the books have", () => {
    const picked = booksMonths({
      closed: "books",
      whole: ["2026-08", "2026-09", "2026-10", "2026-11"],
      current: "2026-11",
      income: new Map([
        ["2026-08", 1],
        ["2026-10", 1],
        ["2026-11", 1],
      ]),
    });
    // September isn't in the books; November is still going.
    expect([...picked]).toEqual(["2026-08", "2026-10"]);
  });

  it("shares a books month by the shop's own split, to the cent", () => {
    const m = monthFigure(facts("2026-10", { goods: 6000, classes: 3000 }, 10001), LINES);
    expect(m.source).toBe("books");
    expect(m.total).toBe(10001);
    expect([...m.byLine.values()].reduce((a, b) => a + b, 0)).toBe(10001);
    expect(m.byLine.get("goods")).toBe(6667);
    expect(m.byLine.get("classes")).toBe(3334);
    expect(m.unplaced).toBe(0);
  });

  it("puts invoices pointed at a line first, out of the books' income, never on top", () => {
    const m = monthFigure(
      facts("2026-10", { goods: 5000, classes: 5000 }, 20000, { classes: 4000 }),
      LINES,
    );
    expect(m.total).toBe(20000);
    expect(m.byLine.get("classes")).toBe(4000 + 8000);
    expect(m.byLine.get("goods")).toBe(8000);
  });

  it("keeps a books month whose shop sold nothing beside the lines", () => {
    const m = monthFigure(facts("2026-10", {}, 7000), LINES);
    expect(m.unplaced).toBe(7000);
    expect(m.total).toBe(7000);
    expect([...m.byLine.values()]).toEqual([0, 0]);
  });

  it("leaves a shop month as before: the shop's sales plus invoices in their lines", () => {
    const m = monthFigure(facts("2026-11", { goods: 900 }, null, { classes: 100 }), LINES);
    expect(m).toMatchObject({ source: "shop", shop: 900, books: 100, total: 1000, unplaced: 0 });
    expect(Object.fromEntries(m.byLine)).toEqual({ goods: 900, classes: 100 });
  });

  it("adds a range up so the total is the months' sum and the lines' sum", () => {
    const all = [
      facts("2026-09", { goods: 1234, classes: 777 }, 3333, { goods: 100 }),
      facts("2026-10", {}, 4000),
      facts("2026-11", { goods: 501, classes: 499 }, null, { classes: 50 }),
    ];
    const r = rangeRevenue(all, LINES);
    const lines = [...r.byLine.values()].reduce((a, b) => a + b, 0);
    expect(r.total).toBe(r.months.reduce((s, m) => s + m.total, 0));
    expect(r.total).toBe(lines + r.unplaced);
    expect(r.total).toBe(r.shop + r.books);
    expect(r.total).toBe(3333 + 4000 + 1000 + 50);
    expect(r.fromBooks).toEqual(["2026-09", "2026-10"]);
    expect(r.fromShop).toEqual(["2026-11"]);
  });

  it("says when a range mixes the books and the shop", () => {
    const words = (m: string) =>
      ({ "2026-09": "September", "2026-10": "October", "2026-11": "November" })[m] ?? m;
    expect(mixNote(["2026-09", "2026-10"], ["2026-11"], words, "2026-11")).toBe(
      "September and October are from your books; November so far is your shop's sales.",
    );
    expect(mixNote(["2026-09"], [], words, "2026-11")).toBeNull();
    expect(mixNote([], ["2026-11"], words, "2026-11")).toBeNull();
  });
});
