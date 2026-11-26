import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPENSE_SORTING,
  actionWords,
  decideExpense,
  decisionPayload,
  expenseSortingSchema,
  factsOfRow,
  parseExpenseSorting,
  splitByPercent,
  type ExpenseFacts,
  type ExpenseSorting,
} from "./expenses";

const LINES = new Set(["shop", "classes", "commissions"]);

const facts = (over: Partial<ExpenseFacts> = {}): ExpenseFacts => ({
  payee: "Yarn Barn",
  accounts: ["Supplies"],
  memo: "",
  descriptions: [],
  ...over,
});

const settings = (body: Partial<ExpenseSorting>): ExpenseSorting =>
  expenseSortingSchema.parse({ version: 1, ...body });

describe("the expense sorting setting", () => {
  it("starts empty and falls back to empty when it can't be read", () => {
    expect(parseExpenseSorting(undefined)).toEqual(DEFAULT_EXPENSE_SORTING);
    expect(parseExpenseSorting({ version: 2 })).toEqual(DEFAULT_EXPENSE_SORTING);
  });

  it("wants splits in whole percents adding up to 100, over at least two lines", () => {
    const rule = (split: unknown) => ({
      version: 1,
      rules: [{ id: "r-1", field: "payee", words: "x", action: { sort: "split", split } }],
    });
    expect(expenseSortingSchema.safeParse(rule({ shop: 60, classes: 40 })).success).toBe(true);
    expect(expenseSortingSchema.safeParse(rule({ shop: 60, classes: 30 })).success).toBe(false);
    expect(expenseSortingSchema.safeParse(rule({ shop: 100 })).success).toBe(false);
    expect(expenseSortingSchema.safeParse(rule({ shop: 50.5, classes: 49.5 })).success).toBe(false);
  });

  it("allows one default per payee, whatever the capitals", () => {
    const vendors = [
      { id: "v-1", payee: "Yarn Barn", action: { sort: "shared" } },
      { id: "v-2", payee: " yarn  barn", action: { sort: "set_aside" } },
    ];
    expect(expenseSortingSchema.safeParse({ version: 1, vendors }).success).toBe(false);
  });
});

describe("which way an expense goes", () => {
  const rules = settings({
    vendors: [
      { id: "v-1", payee: "Yarn Barn", action: { sort: "line", line: "shop" }, fill_in: true },
      { id: "v-2", payee: "Card Co", action: { sort: "line", line: "shop" }, fill_in: true },
    ],
    rules: [
      {
        id: "r-firm",
        field: "memo",
        words: "loan repayment",
        action: { sort: "set_aside" },
        fill_in: true,
        firm: true,
      },
      {
        id: "r-acct",
        field: "account",
        words: "Rent",
        action: { sort: "split", split: { shop: 60, commissions: 40 } },
        fill_in: true,
        firm: false,
      },
      {
        id: "r-payee",
        field: "payee",
        words: "studio",
        action: { sort: "shared" },
        fill_in: false,
        firm: false,
      },
      {
        id: "r-gone",
        field: "payee",
        words: "barn",
        action: { sort: "line", line: "removed-line" },
        fill_in: true,
        firm: true,
      },
    ],
  });

  it("uses the payee's default", () => {
    expect(decideExpense(rules, LINES, facts())).toMatchObject({
      action: { sort: "line", line: "shop" },
      source: "vendor",
      ruleId: "v-1",
      fillIn: true,
    });
    expect(decideExpense(rules, LINES, facts({ payee: "  YARN barn " }))?.ruleId).toBe("v-1");
  });

  it("checks firm rules before the payee's default, and the rest after", () => {
    const repayment = facts({ payee: "Card Co", descriptions: ["Loan repayment 12"] });
    expect(decideExpense(rules, LINES, repayment)?.ruleId).toBe("r-firm");
    expect(decideExpense(rules, LINES, facts({ payee: "Card Co" }))?.ruleId).toBe("v-2");
    expect(
      decideExpense(rules, LINES, facts({ payee: "Landlord", accounts: ["Utilities", "rent"] }))
        ?.ruleId,
    ).toBe("r-acct");
  });

  it("matches an account by its whole name, payees and memos by a part", () => {
    // No rule matches "Rent deposit": the account decides, and it has no choice yet.
    expect(
      decideExpense(rules, LINES, facts({ payee: null, accounts: ["Rent deposit"] })),
    ).toMatchObject({ source: "account", action: { sort: "shared" } });
    expect(decideExpense(rules, LINES, facts({ payee: "The Studio Shop" }))?.ruleId).toBe(
      "r-payee",
    );
  });

  it("passes over a rule that points at a line no longer there", () => {
    // "r-gone" is firm and matches "barn", but its line was removed.
    expect(decideExpense(rules, LINES, facts())?.ruleId).toBe("v-1");
  });

  it("only suggests when the rule says so", () => {
    expect(decisionPayload(rules, LINES, facts({ payee: "Studio Lights" }))).toEqual({
      suggest: {
        sort: "shared",
        line: null,
        split: null,
        source: "rule",
        rule: "r-payee",
        reason: "The payee's name contains “studio”",
      },
    });
    expect(decisionPayload(rules, LINES, facts())).toMatchObject({
      auto: { sort: "line", line: "shop", source: "vendor" },
    });
    expect(decisionPayload(rules, LINES, facts({ payee: "Nobody" }))).toEqual({});
  });

  it("reads the facts of a row from the books, line accounts and descriptions included", () => {
    expect(
      factsOfRow({
        payee: null,
        account: "Fees",
        memo: "x",
        lines: [{ account: "Rent", description: "October" }],
      }),
    ).toEqual({
      payee: null,
      accounts: ["Fees", "Rent"],
      memo: "x",
      descriptions: ["October"],
      accountRef: null,
      classes: [null],
      location: null,
    });
    expect(
      factsOfRow({
        payee: "A",
        account: "Fees",
        account_ref: "71",
        location: "Studio",
        memo: "",
        lines: [{ account: "Fees", description: "", class: "Workshops" }],
      }),
    ).toMatchObject({ accountRef: "71", classes: ["Workshops"], location: "Studio" });
  });

  it("says each way of sorting in words", () => {
    const name = (id: string) => ({ shop: "Shop", classes: "Classes" })[id] ?? id;
    expect(actionWords({ sort: "split", split: { shop: 70, classes: 30 } }, name)).toBe(
      "70% Shop, 30% Classes",
    );
    expect(actionWords({ sort: "set_aside" }, name)).toBe("Not a business expense");
  });
});

describe("sorting by the books' accounts", () => {
  const byAccount = settings({
    vendors: [
      { id: "v-1", payee: "Yarn Barn", action: { sort: "line", line: "shop" }, fill_in: true },
      { id: "v-2", payee: "Maybe Co", action: { sort: "shared" }, fill_in: false },
    ],
    rules: [
      {
        id: "r-class",
        field: "class",
        words: "workshops",
        action: { sort: "line", line: "classes" },
        fill_in: true,
        firm: false,
      },
      {
        id: "r-loc",
        field: "location",
        words: "Market Stall",
        action: { sort: "line", line: "commissions" },
        fill_in: true,
        firm: false,
      },
    ],
    accounts: [
      { ref: "61", name: "Supplies", action: { sort: "line", line: "shop" } },
      { ref: null, name: "Rent", action: { sort: "split", split: { shop: 50, classes: 50 } } },
      { ref: "63", name: "Owner Draws", action: { sort: "set_aside" } },
      { ref: "64", name: "Odds and Ends", action: { sort: "each" } },
      { ref: "65", name: "Old Line", action: { sort: "line", line: "removed-line" } },
    ],
  });
  const at = (
    account: string | null,
    accountRef: string | null,
    over: Partial<ExpenseFacts> = {},
  ) => facts({ payee: "Someone New", accounts: [account], accountRef, ...over });

  it("follows the account's choice when no rule or default speaks first", () => {
    expect(decideExpense(byAccount, LINES, at("Supplies", "61"))).toMatchObject({
      source: "account",
      action: { sort: "line", line: "shop" },
      fillIn: true,
    });
    expect(decideExpense(byAccount, LINES, at("Owner Draws", "63"))?.action).toEqual({
      sort: "set_aside",
    });
  });

  it("finds an account by the books' id, so a renamed account keeps its choice", () => {
    expect(decideExpense(byAccount, LINES, at("Supplies and Yarn", "61"))?.action).toEqual({
      sort: "line",
      line: "shop",
    });
    // Same name, but the books say it's a different account: no choice for it yet.
    expect(decideExpense(byAccount, LINES, at("Supplies", "99"))?.action).toEqual({
      sort: "shared",
    });
  });

  it("falls back to the exact name where either side has no id", () => {
    expect(decideExpense(byAccount, LINES, at("Supplies", null))?.action).toMatchObject({
      sort: "line",
    });
    expect(decideExpense(byAccount, LINES, at("Rent", "70"))?.action).toMatchObject({
      sort: "split",
    });
    expect(decideExpense(byAccount, LINES, at("rent", null))?.action).toEqual({ sort: "shared" });
  });

  it("counts an account with no choice yet as shared, and says so", () => {
    expect(decideExpense(byAccount, LINES, at("Bank Fees", "80"))).toMatchObject({
      source: "account",
      action: { sort: "shared" },
      reason: "Shared, until you choose for the account Bank Fees",
    });
    expect(decideExpense(DEFAULT_EXPENSE_SORTING, LINES, at(null, null))?.action).toEqual({
      sort: "shared",
    });
  });

  it("leaves an account set to decide each one in the inbox", () => {
    expect(decideExpense(byAccount, LINES, at("Odds and Ends", "64"))).toBeNull();
  });

  it("treats a choice pointing at a removed line as no choice", () => {
    expect(decideExpense(byAccount, LINES, at("Old Line", "65"))?.action).toEqual({
      sort: "shared",
    });
  });

  it("lets a payee default, a class or a location rule make an exception", () => {
    expect(
      decideExpense(byAccount, LINES, at("Owner Draws", "63", { payee: "Yarn Barn" })),
    ).toMatchObject({ source: "vendor", action: { sort: "line", line: "shop" } });
    expect(
      decideExpense(byAccount, LINES, at("Supplies", "61", { classes: [null, "Workshops"] })),
    ).toMatchObject({ ruleId: "r-class" });
    expect(
      decideExpense(byAccount, LINES, at("Supplies", "61", { location: "market  stall" })),
    ).toMatchObject({ ruleId: "r-loc" });
    // A suggestion-only default keeps it in the inbox with the suggestion beside it.
    expect(
      decisionPayload(byAccount, LINES, at("Supplies", "61", { payee: "Maybe Co" })),
    ).toMatchObject({ suggest: { source: "vendor" } });
  });

  it("hands the database nothing when only the account decides: it applies that itself", () => {
    expect(decisionPayload(byAccount, LINES, at("Supplies", "61"))).toEqual({});
    expect(decisionPayload(byAccount, LINES, at("Odds and Ends", "64"))).toEqual({});
  });

  it("keeps one choice per account", () => {
    const twice = (accounts: unknown[]) =>
      expenseSortingSchema.safeParse({ version: 1, accounts }).success;
    expect(
      twice([
        { ref: "1", name: "A", action: { sort: "shared" } },
        { ref: "1", name: "B", action: { sort: "each" } },
      ]),
    ).toBe(false);
    expect(
      twice([
        { ref: null, name: "A", action: { sort: "shared" } },
        { ref: null, name: "A", action: { sort: "each" } },
      ]),
    ).toBe(false);
    expect(
      twice([
        { ref: "1", name: "A", action: { sort: "shared" } },
        { ref: null, name: "A", action: { sort: "each" } },
      ]),
    ).toBe(true);
    // An earlier setting with no accounts still reads.
    expect(parseExpenseSorting({ version: 1, vendors: [], rules: [] }).accounts).toEqual([]);
  });
});

describe("shares in whole cents", () => {
  const total = (map: Map<string, number>) => [...map.values()].reduce((a, b) => a + b, 0);

  it("adds back up exactly, the odd cents going to the largest share", () => {
    const parts = splitByPercent(10001, [
      ["shop", 30],
      ["classes", 50],
      ["commissions", 20],
    ]);
    expect(Object.fromEntries(parts)).toEqual({ shop: 3000, classes: 5001, commissions: 2000 });
    expect(total(parts)).toBe(10001);
  });

  it("gives a tie's leftover to the first share listed", () => {
    expect(
      Object.fromEntries(
        splitByPercent(101, [
          ["a", 50],
          ["b", 50],
        ]),
      ),
    ).toEqual({ a: 51, b: 50 });
    expect(
      Object.fromEntries(
        splitByPercent(100, [
          ["a", 34],
          ["b", 33],
          ["c", 33],
        ]),
      ),
    ).toEqual({ a: 34, b: 33, c: 33 });
    expect(
      Object.fromEntries(
        splitByPercent(1, [
          ["a", 34],
          ["b", 33],
          ["c", 33],
        ]),
      ),
    ).toEqual({ a: 1, b: 0, c: 0 });
  });

  it("works the same way for money coming back", () => {
    const parts = splitByPercent(-10001, [
      ["shop", 30],
      ["classes", 50],
      ["commissions", 20],
    ]);
    expect(Object.fromEntries(parts)).toEqual({
      shop: -3000,
      classes: -5001,
      commissions: -2000,
    });
  });

  it("always adds back up, whatever the amount and shares", () => {
    const shares: [string, number][] = [
      ["a", 7],
      ["b", 13],
      ["c", 41],
      ["d", 39],
    ];
    for (const cents of [0, 1, 3, 99, 12345, 999999, -7, -123457]) {
      expect(total(splitByPercent(cents, shares))).toBe(cents);
    }
  });
});
