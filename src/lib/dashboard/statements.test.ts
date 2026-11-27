import { describe, expect, it } from "vitest";
import { balanceSheet, incomeStatement } from "./statements";

const month = (m: string, data: Record<string, unknown>) => ({ month: m, data });

describe("the income statement, line by line", () => {
  it("adds each account up across the months, with the books' own totals", () => {
    const s = incomeStatement([
      month("2026-10", {
        income: 1000,
        cogs: 400,
        gross_profit: 600,
        expenses: 250.5,
        net_income: 349.5,
        other_income_cents: 0,
        other_expenses_cents: 0,
        lines: [
          { section: "Income", name: "Class income", depth: 0, cents: 100000 },
          { section: "COGS", name: "Wool", depth: 0, cents: 40000 },
          { section: "Expenses", name: "Studio:Rent", depth: 1, cents: 25050 },
        ],
      }),
      month("2026-11", {
        income: 500,
        cogs: 0,
        gross_profit: 500,
        expenses: 100,
        net_income: 400,
        other_income_cents: 1234,
        other_expenses_cents: 0,
        lines: [
          { section: "Income", name: "Class income", depth: 0, cents: 50000 },
          { section: "Expenses", name: "Studio:Rent", depth: 1, cents: 10000 },
          { section: "OtherIncome", name: "Interest", depth: 0, cents: 1234 },
        ],
      }),
    ]);
    expect(s.sections.map((x) => [x.key, x.total, x.lines.map((l) => [l.name, l.cents])])).toEqual([
      ["Income", 150000, [["Class income", 150000]]],
      ["COGS", 40000, [["Wool", 40000]]],
      ["Expenses", 35050, [["Studio:Rent", 35050]]],
      ["OtherIncome", 1234, [["Interest", 1234]]],
    ]);
    expect(s).toMatchObject({
      grossProfit: 110000,
      operating: 74950,
      netIncome: 74950,
      totalsOnly: [],
    });
    expect(s.grossShare).toBeCloseTo(110000 / 150000);
  });

  it("says which months only have totals, and doesn't call other income zero when it isn't known", () => {
    const s = incomeStatement([month("2026-01", { income: 10, gross_profit: 10, net_income: 10 })]);
    expect(s.totalsOnly).toEqual(["2026-01"]);
    expect(s.otherIncome).toBeNull();
    expect(s.sections.map((x) => x.key)).toEqual(["Income"]);
  });
});

describe("the balance sheet", () => {
  it("lays out each section's lines as the books do", () => {
    const b = balanceSheet({
      total_assets: 9000,
      lines: [
        { section: "TotalAssets", name: "Checking", depth: 1, cents: 500000 },
        { section: "Liabilities", name: "Studio card", depth: 1, cents: 120000 },
        { section: "Equity", name: "Retained earnings", depth: 0, cents: 380000 },
      ],
    });
    expect(b.totalsOnly).toBe(false);
    expect(b.totalAssets).toBe(900000);
    expect(b.sections.map((s) => [s.name, s.lines.length])).toEqual([
      ["What the business owns", 1],
      ["What it owes", 1],
      ["Equity", 1],
    ]);
    expect(balanceSheet({ total_assets: 1 }).totalsOnly).toBe(true);
  });
});
