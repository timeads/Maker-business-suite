import { describe, expect, it } from "vitest";
import {
  expenseSortExplained,
  liabilityExplained,
  lineExpensesExplained,
  orderExplained,
  profitExplained,
  revenueExplained,
} from "./explain";
import { DEFAULT_REVENUE_SETTINGS, type RevenueSettings } from "./lines";
import { DEFAULT_PROFIT_SETTINGS } from "./profit";
import type { Recommendation } from "./debt/recommend";

const LINES: RevenueSettings = {
  ...DEFAULT_REVENUE_SETTINGS,
  figure: "order_totals",
  by_class_date: true,
  lines: [
    { id: "shop", name: "Shop" },
    { id: "classes", name: "Classes" },
  ],
  default_line: "shop",
  rules: [
    { id: "r1", match: "order_tag", words: ["class", "workshop"], line: "classes" },
    { id: "r2", match: "workshop", words: [], line: "classes" },
  ],
};
const lineName = (id: string) => (id === "shop" ? "Shop" : id === "classes" ? "Classes" : "?");
const money = (cents: number) => `$${(cents / 100).toFixed(0)}`;

describe("revenueExplained", () => {
  it("says which figure and that there's one business before lines", () => {
    expect(revenueExplained(DEFAULT_REVENUE_SETTINGS)).toEqual([
      "Revenue is net sales: what items sold for after discounts and refunds, before tax and shipping. Cancelled and test orders never count.",
      "A class counts in the month it was bought.",
      "There are no business lines yet, so every sale counts as one business.",
    ]);
  });

  it("reads the workspace's own lines and rules back, in order", () => {
    const words = revenueExplained(LINES);
    expect(words[0]).toMatch(/^Revenue is order totals/);
    expect(words[1]).toBe("A class counts in the month it runs, not the month it was bought.");
    expect(words).toContain("Sales are sorted into 2 lines: Shop and Classes.");
    expect(words).toContain("If the order has a tag “class” and “workshop”, it goes to Classes.");
    expect(words.at(-1)).toMatch(/Anything no rule matches goes to Shop\.$/);
  });
});

describe("lineExpensesExplained", () => {
  it("names the accounts that feed a line, whole and in part", () => {
    const sorting = {
      accounts: [
        { ref: "1", name: "Studio supplies", action: { sort: "line" as const, line: "classes" } },
        {
          ref: "2",
          name: "Rent",
          action: { sort: "split" as const, split: { classes: 30, shop: 70 } },
        },
        { ref: "3", name: "Postage", action: { sort: "line" as const, line: "shop" } },
      ],
    };
    expect(lineExpensesExplained(sorting, "classes", "Classes")).toEqual([
      "Classes takes everything in Studio supplies.",
      "It takes a share of Rent (30%).",
      "Your own choice on a single expense, and your payee defaults and rules, come first.",
    ]);
    expect(lineExpensesExplained({ accounts: [] }, "classes", "Classes")[0]).toMatch(
      /No account in your books is pointed at Classes yet/,
    );
  });
});

describe("profitExplained", () => {
  it("follows the setting", () => {
    expect(profitExplained(DEFAULT_PROFIT_SETTINGS, lineName)).toContain(
      "Shared expenses aren't split between lines yet, so they're shown apart.",
    );
    const set = profitExplained(
      { ...DEFAULT_PROFIT_SETTINGS, shared_split: { shop: 60, classes: 40 } },
      lineName,
    );
    expect(set).toContain("Shared expenses are split 60% Shop, 40% Classes.");
  });
});

describe("liabilityExplained", () => {
  it("says whose word decided, and what the books call it", () => {
    expect(liabilityExplained({ typeWords: "Credit Card", choice: null, byRule: true })).toBe(
      "QuickBooks lists this as Credit Card, and your setting counts that kind of account as a debt.",
    );
    expect(
      liabilityExplained({ typeWords: "Sales Tax Payable", choice: null, byRule: false }),
    ).toMatch(/doesn't count as a debt by itself/);
    expect(liabilityExplained({ typeWords: "X", choice: "not_debt", byRule: true })).toMatch(
      /You said this isn't a debt/,
    );
    expect(liabilityExplained({ typeWords: "X", choice: "debt", byRule: false })).toMatch(
      /You counted this as a debt yourself/,
    );
  });
});

describe("expenseSortExplained", () => {
  it("names what sorted it", () => {
    const line = { sort: "line" as const, line: "classes" };
    expect(expenseSortExplained("person", line, lineName)).toMatch(/You sorted this one yourself/);
    expect(expenseSortExplained("rule", line, lineName)).toBe(
      "One of your rules sorted it: Classes.",
    );
    expect(expenseSortExplained("vendor", line, lineName)).toMatch(/payee/);
    expect(expenseSortExplained("account", { sort: "shared" }, lineName)).toMatch(
      /set to shared across lines/,
    );
    expect(expenseSortExplained(null, null, lineName)).toMatch(/waits for you/);
    expect(expenseSortExplained(null, { sort: "shared" }, lineName)).toMatch(/counts as shared/);
  });
});

describe("orderExplained", () => {
  const rec: Recommendation = {
    strategy: "avalanche",
    ranked: ["avalanche", "snowball", "hybrid", "custom"],
    savedVsMinimums: 50000,
    monthsSoonerVsMinimums: 4,
    next: { strategy: "snowball", moreInterest: 1200, monthsLater: 0 },
  };
  it("says the plan follows the cheapest order, and why", () => {
    const words = orderExplained({
      from: "recommended",
      strategy: "avalanche",
      recommendation: rec,
      money,
    });
    expect(words[0]).toMatch(/least interest.*avalanche/);
    expect(words[1]).toMatch(/saves about \$500 in interest and finishes 4 months sooner/);
  });
  it("keeps to a person's own order, and mentions a cheaper one", () => {
    const words = orderExplained({
      from: "person",
      strategy: "snowball",
      recommendation: rec,
      money,
    });
    expect(words[0]).toMatch(/You chose snowball/);
    expect(words[1]).toMatch(/avalanche/);
  });
  it("has little to say with nothing to pay down", () => {
    expect(
      orderExplained({ from: "recommended", strategy: "avalanche", recommendation: null, money }),
    ).toEqual(["With nothing owing at a rate, there's no order to choose yet."]);
  });
});
