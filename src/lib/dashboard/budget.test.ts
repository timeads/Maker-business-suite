import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET_SETTINGS,
  addMonths,
  averageMonths,
  blanksFromAverage,
  breakEven,
  budgetRows,
  budgetSettingsSchema,
  cogsShare,
  isMonth,
  parseBudgetSettings,
  periodMonths,
  sameAccount,
  splitAccount,
  varianceStanding,
  withExpectedVariable,
  type BudgetSettings,
} from "./budget";

const S: BudgetSettings = {
  ...DEFAULT_BUDGET_SETTINGS,
  variable_accounts: ["Supplies for Resale"],
  hidden_accounts: ["Owner Draws"],
};

describe("the settings", () => {
  it("default to a 15% warning, a three-month average and the books' own cost of goods", () => {
    expect(DEFAULT_BUDGET_SETTINGS).toEqual({
      version: 1,
      cogs_pct: null,
      variable_accounts: [],
      hidden_accounts: [],
      warn_pct: 15,
      average_months: 3,
    });
    expect(parseBudgetSettings({ version: 1, cogs_pct: 120 })).toEqual(DEFAULT_BUDGET_SETTINGS);
    expect(budgetSettingsSchema.safeParse({ version: 1, cogs_pct: 40 }).success).toBe(true);
  });

  it("compares account names without regard to capitals or spacing", () => {
    expect(sameAccount(" supplies  for resale", "Supplies for Resale")).toBe(true);
    expect(sameAccount("Supplies", "Supplies for Resale")).toBe(false);
  });
});

describe("months and periods", () => {
  it("steps months across year ends", () => {
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-11", 2)).toBe("2027-01");
    expect(averageMonths("2026-02", 3)).toEqual(["2025-11", "2025-12", "2026-01"]);
  });

  it("covers a month, its quarter, the year so far and the whole year", () => {
    expect(periodMonths("month", "2026-05")).toEqual(["2026-05"]);
    expect(periodMonths("quarter", "2026-05")).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(periodMonths("ytd", "2026-03")).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(periodMonths("year", "2026-03")).toHaveLength(12);
  });

  it("only takes a real month from an address", () => {
    expect(isMonth("2026-11")).toBe(true);
    expect(isMonth("2026-13")).toBe(false);
    expect(isMonth("26-11")).toBe(false);
    expect(isMonth(undefined)).toBe(false);
  });

  it("splits QuickBooks sub-accounts into group and name", () => {
    expect(splitAccount("Rent or Lease:Studio")).toEqual({
      group: "Rent or Lease",
      name: "Studio",
    });
    expect(splitAccount("Advertising")).toEqual({ group: "Advertising", name: "Advertising" });
    expect(splitAccount("A:B:C")).toEqual({ group: "A", name: "B › C" });
  });
});

describe("budget against actual", () => {
  const spend = [
    { month: "2026-07", key: "Advertising", cents: 30000 },
    { month: "2026-08", key: "Advertising", cents: 30000 },
    { month: "2026-09", key: "Advertising", cents: 30001 },
    { month: "2026-10", key: "Advertising", cents: 40000 },
    { month: "2026-10", key: "Supplies for Resale", cents: 90000 },
    { month: "2026-09", key: "Supplies for Resale", cents: 60000 },
    { month: "2026-10", key: "Owner Draws", cents: 500000 },
  ];
  const budgets = [
    { month: "2026-10", key: "Advertising", cents: 30000 },
    { month: "2026-10", key: "Supplies for Resale", cents: 60000 },
    { month: "2026-09", key: "Advertising", cents: 1 },
    { month: "2026-10", key: "Software", cents: 5000 },
  ];

  it("puts the average of the months before beside this month's budget and actual", () => {
    const rows = budgetRows({
      subject: "account",
      spend,
      budgets,
      months: ["2026-10"],
      settings: S,
    });
    const ads = rows.find((row) => row.key === "Advertising")!;
    expect(ads).toMatchObject({
      average: 30000,
      budget: 30000,
      budgeted: 1,
      actual: 40000,
      variance: 10000,
      standing: "over",
      variable: false,
      hidden: false,
    });
    expect(ads.share).toBeCloseTo(1 / 3);
    // A budget with nothing spent yet is still a row.
    expect(rows.find((row) => row.key === "Software")).toMatchObject({
      actual: 0,
      variance: -5000,
      standing: "under",
    });
    expect(rows.find((row) => row.key === "Supplies for Resale")).toMatchObject({
      variable: true,
      standing: "over",
    });
    expect(rows.find((row) => row.key === "Owner Draws")?.hidden).toBe(true);
  });

  it("adds a longer period's months up, with its own monthly average", () => {
    const rows = budgetRows({
      subject: "account",
      spend,
      budgets,
      months: periodMonths("quarter", "2026-08"),
      settings: S,
    });
    const ads = rows.find((row) => row.key === "Advertising")!;
    expect(ads).toMatchObject({ actual: 90001, average: 30000, budget: 1, budgeted: 1 });
  });

  it("names a line by its name", () => {
    const rows = budgetRows({
      subject: "line",
      spend: [{ month: "2026-10", key: "classes", cents: 100 }],
      budgets: [],
      months: ["2026-10"],
      settings: S,
      names: new Map([
        ["classes", "Classes"],
        ["shop", "Shop"],
      ]),
    });
    expect(rows.map((row) => [row.key, row.name, row.actual])).toEqual([
      ["classes", "Classes", 100],
      ["shop", "Shop", 0],
    ]);
  });

  it("calls within the warning share 'on', and nothing without a budget", () => {
    expect(varianceStanding(115, 100, 15)).toBe("on");
    expect(varianceStanding(116, 100, 15)).toBe("over");
    expect(varianceStanding(85, 100, 15)).toBe("on");
    expect(varianceStanding(84, 100, 15)).toBe("under");
    expect(varianceStanding(50, 0, 15)).toBeNull();
  });
});

describe("cost of goods and break-even", () => {
  it("takes the share from the setting, else the books' last twelve months", () => {
    expect(cogsShare({ ...S, cogs_pct: 40 }, [])).toEqual({ share: 0.4, from: "setting" });
    const books = [
      ...Array.from({ length: 6 }, () => ({ income: 1, cogs: 1 })),
      ...Array.from({ length: 12 }, () => ({ income: 1000, cogs: 300 })),
    ];
    expect(cogsShare(S, books)).toEqual({ share: 0.3, from: "books" });
    expect(cogsShare(S, [])).toBeNull();
  });

  it("expects last month's revenue × the share across the variable accounts, to the cent", () => {
    const rows = budgetRows({
      subject: "account",
      spend: [
        { month: "2026-09", key: "Supplies for Resale", cents: 200 },
        { month: "2026-09", key: "Freight In", cents: 100 },
        { month: "2026-09", key: "Rent", cents: 999 },
      ],
      budgets: [],
      months: ["2026-10"],
      settings: {
        ...S,
        average_months: 1,
        variable_accounts: ["Supplies for Resale", "freight in"],
      },
    });
    const expected = withExpectedVariable(rows, 100001, 0.3);
    const avg = (key: string) => expected.find((row) => row.key === key)!.average;
    // 30,000.30 → 30,000 cents, two thirds and one third, leftover to the largest.
    expect(avg("Supplies for Resale") + avg("Freight In")).toBe(30000);
    expect(avg("Supplies for Resale")).toBe(20000);
    expect(avg("Rent")).toBe(999);
    expect(withExpectedVariable(rows, 100001, null)).toEqual(rows);
  });

  it("works out break-even as fixed costs ÷ (1 − the share)", () => {
    const rows = budgetRows({
      subject: "account",
      spend: [],
      budgets: [
        { month: "2026-10", key: "Rent", cents: 300000 },
        { month: "2026-10", key: "Software", cents: 30000 },
        { month: "2026-10", key: "Supplies for Resale", cents: 999999 },
        { month: "2026-10", key: "Owner Draws", cents: 777777 },
      ],
      months: ["2026-10"],
      settings: S,
    });
    expect(breakEven(rows, 0.4)).toEqual({
      fixed: 330000,
      variable: 999999,
      share: 0.4,
      revenue: 550000,
    });
    expect(breakEven(rows, null).revenue).toBeNull();
  });

  it("fills blank budgets from the average, in whole units", () => {
    const rows = budgetRows({
      subject: "account",
      spend: [
        { month: "2026-09", key: "Advertising", cents: 12345 },
        { month: "2026-09", key: "Owner Draws", cents: 99999 },
        { month: "2026-09", key: "Software", cents: 3000 },
      ],
      budgets: [{ month: "2026-10", key: "Software", cents: 1000 }],
      months: ["2026-10"],
      settings: { ...S, average_months: 1 },
    });
    expect(blanksFromAverage(rows)).toEqual([{ key: "Advertising", cents: 12300 }]);
  });
});
