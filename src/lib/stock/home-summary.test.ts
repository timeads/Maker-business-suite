import { describe, expect, it } from "vitest";
import {
  lastMonthSamePoint,
  stockHomeLines,
  upOnLastMonth,
  type StockHomeFacts,
} from "./home-summary";

// TuftStock's rules for its hub cards (hub-summary/cards.test.ts): only good news.
const facts: StockHomeFacts = {
  activeItems: 200,
  inStockItems: 183,
  receivedUnitsThisMonth: 240,
  receivedOrdersThisMonth: 3,
  receivedUnitsLastMonthToDate: 200,
  arriving: { units: 96, orders: 2 },
  topSeller: { name: "Wool rug · Large", units: 41 },
};

describe("Stock on the home page", () => {
  it("says what is due, what's in stock, what came in and the best seller", () => {
    expect(stockHomeLines(facts)).toEqual([
      "96 units due in the next 14 days on 2 orders",
      "91.5% of items in stock (183 of 200)",
      "240 units checked in this month, up 20% on last month at this point",
      "best seller in 30 days: Wool rug · Large (41)",
    ]);
  });

  it("never rounds one empty shelf up to 100%, and keeps a poor rate to itself", () => {
    expect(stockHomeLines({ ...facts, activeItems: 1000, inStockItems: 999 })[1]).toBe(
      "99.9% of items in stock (999 of 1,000)",
    );
    expect(
      stockHomeLines({ ...facts, inStockItems: 80 }).some((line) => line.includes("in stock")),
    ).toBe(false);
  });

  it("says nothing where there is nothing good to say", () => {
    expect(
      stockHomeLines({
        activeItems: 0,
        inStockItems: 0,
        receivedUnitsThisMonth: 0,
        receivedOrdersThisMonth: 0,
        receivedUnitsLastMonthToDate: 50,
        arriving: { units: 0, orders: 0 },
        topSeller: null,
      }),
    ).toEqual([]);
  });

  it("compares with last month only when it is up or level", () => {
    expect(upOnLastMonth(118, 100)).toBe("up 18% on last month at this point");
    expect(upOnLastMonth(100, 100)).toBe("level with last month at this point");
    expect(upOnLastMonth(90, 100)).toBeNull();
    expect(upOnLastMonth(90, 0)).toBeNull();
    expect(stockHomeLines({ ...facts, receivedUnitsLastMonthToDate: 900 })[2]).toBe(
      "240 units checked in this month",
    );
  });

  it("finds the same point of last month, taking all of a shorter month", () => {
    expect(lastMonthSamePoint("2026-10-22")).toEqual({ start: "2026-09-01", day: "2026-09-22" });
    expect(lastMonthSamePoint("2026-01-15")).toEqual({ start: "2025-12-01", day: "2025-12-15" });
    // Mar 31: February has no 31st, so the whole of February counts.
    expect(lastMonthSamePoint("2026-03-31")).toEqual({ start: "2026-02-01", day: "2026-03-01" });
  });
});
