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
    expect(decideExpense(rules, LINES, facts({ payee: null, accounts: ["Rent deposit"] }))).toBe(
      null,
    );
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
    ).toEqual({ payee: null, accounts: ["Fees", "Rent"], memo: "x", descriptions: ["October"] });
  });

  it("says each way of sorting in words", () => {
    const name = (id: string) => ({ shop: "Shop", classes: "Classes" })[id] ?? id;
    expect(actionWords({ sort: "split", split: { shop: 70, classes: 30 } }, name)).toBe(
      "70% Shop, 30% Classes",
    );
    expect(actionWords({ sort: "set_aside" }, name)).toBe("Not a business expense");
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
