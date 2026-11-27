import { describe, expect, it } from "vitest";
import type { WidgetData } from "./data";
import {
  amount,
  budgetTable,
  cell,
  csvText,
  debtsTable,
  expensesTable,
  figuresTable,
  fileSlug,
  profitTable,
} from "./export";
import { dashboardSchema } from "./schema";
import type { Debt } from "./debt/figures";

describe("a spreadsheet cell", () => {
  it("quotes what needs quoting and never lets a formula run", () => {
    expect(cell("plain")).toBe("plain");
    expect(cell('Say "hi", then')).toBe('"Say ""hi"", then"');
    expect(cell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(cell("-5 off")).toBe("'-5 off");
    expect(cell(-12.5)).toBe("-12.5");
    expect(cell(null)).toBe("");
    expect(amount(-1250)).toBe(-12.5);
    expect(
      csvText([
        ["a", 1],
        [null, "b"],
      ]),
    ).toBe("a,1\r\n,b\r\n");
    expect(fileSlug("Year to date")).toBe("year-to-date");
    expect(fileSlug("!!")).toBe("money");
  });
});

const profit: Extract<WidgetData, { type: "profit_by_line" }> = {
  type: "profit_by_line",
  figure: "net_sales",
  byClassDate: false,
  cogs: "in_expenses",
  rows: [
    {
      id: "shop",
      name: "Shop",
      revenue: 50000,
      cogs: null,
      direct: 12000,
      shared: 501,
      monthly: 900,
      profit: 36599,
    },
    {
      id: "classes",
      name: "Classes",
      revenue: 30000,
      cogs: null,
      direct: 0,
      shared: 500,
      monthly: 0,
      profit: 29500,
    },
  ],
  profit: 66099,
  unsorted: 700,
  setAside: 0,
  sharedUnsplit: 0,
  monthlyCosts: 1,
  sources: [
    { id: "shop", shop: 50000, books: 0, typed: 0 },
    { id: "classes", shop: 25000, books: 3000, typed: 2000 },
  ],
  books: { invoices: 3000, otherIncome: 0, otherUnplaced: 0, waiting: 1500, otherUnknown: false },
  changedMonths: 0,
  feeds: [],
};

describe("Money's tables", () => {
  it("lists every figure on the page, card by card, leaving empty cards out", () => {
    const config = dashboardSchema.parse({
      version: 1,
      name: "Test",
      widgets: [
        { id: "k", type: "key_figures" },
        { id: "c", type: "cash_on_hand" },
        { id: "p", type: "profit_by_line" },
      ],
    });
    const rows = figuresTable(
      config.widgets,
      {
        k: {
          type: "key_figures",
          figure: "net_sales",
          sales: 1234.5,
          orders: 10,
          averageOrder: 123.45,
          margin: 0.4567,
          fromBooks: null,
          pace: null,
          againstLastMonth: null,
        },
        c: { type: "empty", needs: "quickbooks" },
        p: profit,
      },
      (w) => w.type,
    );
    expect(rows[0]).toEqual(["Card", "Figure", "Amount", "In"]);
    expect(rows).toContainEqual(["key_figures", "Sales", 1234.5, "dollars"]);
    expect(rows).toContainEqual(["key_figures", "Gross margin", 45.7, "percent"]);
    expect(rows).toContainEqual(["profit_by_line", "Shop", 365.99, "dollars"]);
    expect(rows.some((r) => r[0] === "cash_on_hand")).toBe(false);
  });

  it("writes profit by line step by step, with where revenue came from", () => {
    const rows = profitTable(profit);
    expect(rows[2]).toEqual(["Classes", 300, 250, 30, 20, null, 0, 5, 0, 295]);
    expect(rows[3]).toEqual(["All lines", 800, 750, 30, 20, null, 120, 10.01, 9, 660.99]);
    expect(rows).toContainEqual(["Paid invoices waiting for a line", 15]);
  });

  it("writes the budget without the hidden accounts", () => {
    const row = {
      key: "k",
      group: "Office",
      name: "Software",
      average: 1000,
      budget: 1200,
      budgeted: 1,
      actual: 1500,
      variance: 300,
      share: 0.25,
      standing: "over" as const,
      variable: false,
      hidden: false,
    };
    expect(budgetTable([row, { ...row, key: "h", hidden: true }], "account")).toEqual([
      [
        "Group",
        "Account",
        "Average a month",
        "Budget",
        "Actual",
        "Over (+) or under (−)",
        "Over or under, %",
      ],
      ["Office", "Software", 10, 12, 15, 3, 25],
    ]);
  });

  it("writes expenses and debts as they're shown", () => {
    expect(
      expensesTable([
        {
          txn_date: "2026-10-05",
          payee: "Yarn Barn",
          account: "Supplies",
          memo: "",
          amount_cents: 12345,
          sorted: "Shop",
        },
      ])[1],
    ).toEqual(["2026-10-05", "Yarn Barn", "Supplies", "", 123.45, "Shop"]);
    const debt = {
      id: "d1",
      name: "Studio card",
      source: "books",
      balance: 250000,
      needsRate: false,
      rateBp: 2299,
      minimum: 3500,
      payment: null,
      status: "active",
    } as unknown as Debt;
    expect(
      debtsTable([debt, { ...debt, id: "d2", needsRate: true }], new Map([["d1", "Nov 2027"]])),
    ).toEqual([
      ["Debt", "From", "Owed", "Rate, %", "Minimum", "Usual payment", "Status", "Paid off in"],
      ["Studio card", "Your books", 2500, 22.99, 35, null, "active", "Nov 2027"],
      ["Studio card", "Your books", 2500, null, 35, null, "active", ""],
    ]);
  });
});
