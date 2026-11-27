import { describe, expect, it } from "vitest";
import {
  booksRevenueExplained,
  invoicesExplained,
  expenseSortExplained,
  liabilityExplained,
  lineExpensesExplained,
  orderExplained,
  profitExplained,
  revenueExplained,
  invoiceLineExplained,
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

describe("booksRevenueExplained", () => {
  it("says only the shop counts until the books are switched on", () => {
    expect(booksRevenueExplained(LINES)).toEqual([
      "Only sales from your shop count as revenue here. Invoices and other income in your books aren't added.",
    ]);
  });

  it("names the accounts, the one holding the shop's sales and where other income goes", () => {
    const words = booksRevenueExplained({
      ...LINES,
      books: {
        invoices: true,
        other_income: true,
        other_income_line: "shop",
        accounts: [
          { ref: "79", name: "Class income", choice: { line: "classes" } },
          { ref: null, name: "Sales", choice: { skip: "shop" } },
        ],
        customers: [{ ref: "7", name: "Maple Library", choice: { line: "classes" } }],
      },
    });
    expect(words.join(" ")).toContain("Class income → Classes");
    expect(words.join(" ")).toContain("your own choice for that invoice");
    expect(words.join(" ")).toContain("Invoices to Maple Library go where you chose");
    expect(words.join(" ")).toContain(
      "Sales holds your shop's own sales, so it's left out: those sales already count from the shop.",
    );
    expect(words.at(-1)).toBe(
      "Your books' other income (interest, one-off income) is added to Shop. It never holds shop sales.",
    );
  });

  it("explains an invoice's standing beside the list", () => {
    expect(invoicesExplained(LINES)[1]).toMatch(/overdue once its due day has gone by/);
  });
});

describe("why one invoice counts where it does", () => {
  const base = {
    state: "sorted" as const,
    split: false,
    shop: false,
    customer: "Maple Library",
    paid: true,
    counting: true,
  };
  it("names who decided, strongest first", () => {
    expect(invoiceLineExplained({ ...base, by: "person" })[0]).toMatch(
      /chose this for this invoice yourself/,
    );
    expect(invoiceLineExplained({ ...base, by: "customer" })[0]).toMatch(
      /invoices to Maple Library/,
    );
    expect(invoiceLineExplained({ ...base, by: "account" })[0]).toMatch(
      /income account is pointed/,
    );
    expect(invoiceLineExplained({ ...base, by: "account", state: "waiting" })[0]).toMatch(
      /counts nowhere yet/,
    );
  });
  it("says how a split and the shop's own sales are counted, and when it will count", () => {
    const words = invoiceLineExplained({
      ...base,
      by: "person",
      split: true,
      paid: false,
    }).join(" ");
    expect(words).toMatch(/to the cent/);
    expect(words).toMatch(/counts once it's paid/);
    expect(invoiceLineExplained({ ...base, by: "person", shop: true }).join(" ")).toMatch(
      /never counts twice/,
    );
    expect(invoiceLineExplained({ ...base, by: "account", counting: false }).join(" ")).toMatch(
      /switch on/,
    );
  });
});
