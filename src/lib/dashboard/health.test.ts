import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEALTH_SETTINGS,
  averageCents,
  bookMonthOf,
  cashMonthOf,
  completeMonths,
  concentration,
  concentrationStanding,
  growthStanding,
  healthCheck,
  healthSettingsSchema,
  marginStanding,
  marginsOver,
  monthlyBurn,
  operatingProfit,
  parseHealthSettings,
  revenueGrowth,
  runwayMonths,
  runwayStanding,
  type BookMonth,
  type CashMonth,
} from "./health";

const S = DEFAULT_HEALTH_SETTINGS;
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const book = (month: string, income: number, cogs = 0, expenses = 0, extra = {}): BookMonth => ({
  month,
  income,
  cogs,
  expenses,
  netIncome: income - cogs - expenses,
  otherIncome: 0,
  otherExpenses: 0,
  ...extra,
});
const flow = (month: string, operating: number): CashMonth => ({
  month,
  operating,
  investing: 0,
  financing: 0,
  netChange: operating,
});

describe("the settings", () => {
  it("default to the earlier dashboard's thresholds", () => {
    expect(S).toMatchObject({
      compare_months: 3,
      runway_good_months: 12,
      runway_watch_months: 6,
      growth_good_pct: 5,
      growth_bad_pct: -5,
      gross_margin_good_pct: 50,
      gross_margin_watch_pct: 35,
      concentration_watch_pct: 50,
    });
  });

  it("refuse thresholds the wrong way round, and fall back when unreadable", () => {
    expect(
      healthSettingsSchema.safeParse({ version: 1, runway_good_months: 3, runway_watch_months: 6 })
        .success,
    ).toBe(false);
    expect(healthSettingsSchema.safeParse({ version: 1, growth_bad_pct: 10 }).success).toBe(false);
    expect(parseHealthSettings({ version: 2 })).toEqual(S);
    expect(parseHealthSettings(null)).toEqual(S);
  });
});

describe("reading the stored reports", () => {
  it("turns the profit and loss into cents without losing a cent", () => {
    const m = bookMonthOf({
      period_start: "2026-10-01",
      data: { income: 1234.56, cogs: 0.1, expenses: "99.99", net_income: 1134.47 },
    });
    expect(m).toEqual({
      month: "2026-10",
      income: 123456,
      cogs: 10,
      expenses: 9999,
      netIncome: 113447,
      // Stored before other income was read: not known, not zero.
      otherIncome: null,
      otherExpenses: null,
    });
    expect(
      bookMonthOf({ period_start: "2026-10-01", data: { other_income_cents: 5000 } }).otherIncome,
    ).toBe(5000);
  });

  it("reads a cash flow month, adding up the net change when it wasn't given", () => {
    expect(
      cashMonthOf({
        period_start: "2026-10-01",
        data: { operating_cents: -500, investing_cents: -200, financing_cents: 1000 },
      }),
    ).toEqual({
      month: "2026-10",
      operating: -500,
      investing: -200,
      financing: 1000,
      netChange: 300,
    });
  });

  it("keeps only finished months, once each, in order", () => {
    const rows = [book("2026-11", 1), book("2026-09", 2), book("2026-10", 3), book("2026-12", 4)];
    expect(completeMonths(rows, "2026-11").map((m) => m.month)).toEqual(["2026-09", "2026-10"]);
  });
});

describe("the figures", () => {
  it("averages cents to the nearest cent, halves away from zero", () => {
    expect(averageCents([1, 2])).toBe(2);
    expect(averageCents([-1, -2])).toBe(-2);
    expect(averageCents([100, 100, 101])).toBe(100);
    expect(averageCents([])).toBe(0);
  });

  it("leaves other income and expenses out of operating profit", () => {
    const m = book("2026-10", 100000, 30000, 50000, { otherIncome: 900000, otherExpenses: 1000 });
    expect(operatingProfit(m)).toBe(20000);
    const over = marginsOver([m, book("2026-09", 100000, 40000, 50000)]);
    expect(over.operatingProfit).toBe(30000);
    expect(over.gross).toBeCloseTo(0.65);
    expect(over.operating).toBeCloseTo(0.15);
    expect(over.otherIncome).toBe(900000);
    // A month stored before other income was read makes the amount unknown.
    expect(
      marginsOver([m, book("2026-09", 1, 0, 0, { otherIncome: null })]).otherIncome,
    ).toBeNull();
  });

  it("works out burn from the cash flow statement's last three months", () => {
    const burn = monthlyBurn(
      [book("2026-10", 1)],
      [
        flow("2026-07", 999999),
        flow("2026-08", -30000),
        flow("2026-09", -60000),
        flow("2026-10", -90000),
      ],
      3,
    );
    expect(burn).toEqual({
      cents: 60000,
      source: "cash_flow",
      months: ["2026-08", "2026-09", "2026-10"],
    });
  });

  it("falls back to expenses less revenue when there is no cash flow statement", () => {
    const burn = monthlyBurn(
      [
        book("2026-08", 100000, 0, 150000),
        book("2026-09", 100000, 0, 120000),
        book("2026-10", 100000, 0, 90000),
      ],
      [],
      3,
    );
    expect(burn).toMatchObject({ cents: 20000, source: "books" });
    expect(monthlyBurn([], [], 3)).toBeNull();
  });

  it("gives runway as cash over burn, and no limit while cash grows", () => {
    expect(runwayMonths(600000, 100000)).toBe(6);
    expect(runwayMonths(600000, 0)).toBeNull();
    expect(runwayMonths(600000, -5000)).toBeNull();
    expect(runwayMonths(-100, 100)).toBe(0);
  });

  it("compares the last three complete months with the three before", () => {
    const months = [
      book("2026-04", 100000),
      book("2026-05", 100000),
      book("2026-06", 100000),
      book("2026-07", 110000),
      book("2026-08", 110000),
      book("2026-09", 110000),
    ];
    const g = revenueGrowth(months, 3);
    expect(g.growth).toBeCloseTo(0.1);
    expect(g.recent).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(g.prior).toEqual(["2026-04", "2026-05", "2026-06"]);
    // Not a full run before: no growth figure rather than a made-up one.
    expect(revenueGrowth(months.slice(1), 3).growth).toBeNull();
    expect(
      revenueGrowth(
        [...months.slice(0, 3).map((m) => ({ ...m, income: 0 })), ...months.slice(3)],
        3,
      ).growth,
    ).toBeNull();
  });

  it("finds the biggest line's share", () => {
    expect(
      concentration([
        { name: "Shop", cents: 7000 },
        { name: "Classes", cents: 3000 },
      ]),
    ).toEqual({ share: 0.7, name: "Shop" });
    expect(concentration([{ name: "Shop", cents: 100 }])).toBeNull();
    expect(
      concentration([
        { name: "Shop", cents: 0 },
        { name: "Classes", cents: 0 },
      ]),
    ).toBeNull();
  });
});

describe("where each stands", () => {
  it("rates runway 12 months and over healthy, 6 to 12 watch, under 6 needs attention", () => {
    expect(runwayStanding(null, S)).toBe("good");
    expect(runwayStanding(12, S)).toBe("good");
    expect(runwayStanding(11.9, S)).toBe("watch");
    expect(runwayStanding(6, S)).toBe("watch");
    expect(runwayStanding(5.9, S)).toBe("bad");
  });

  it("rates growth within 5% either way as watch", () => {
    expect(growthStanding(0.051, S)).toBe("good");
    expect(growthStanding(0.05, S)).toBe("watch");
    expect(growthStanding(-0.049, S)).toBe("watch");
    expect(growthStanding(-0.05, S)).toBe("bad");
  });

  it("rates gross margin over 50% healthy and over 35% watch", () => {
    expect(marginStanding(0.51, S)).toBe("good");
    expect(marginStanding(0.5, S)).toBe("watch");
    expect(marginStanding(0.36, S)).toBe("watch");
    expect(marginStanding(0.35, S)).toBe("bad");
  });

  it("never calls concentration worse than worth watching", () => {
    expect(concentrationStanding(0.49, S)).toBe("good");
    expect(concentrationStanding(0.99, S)).toBe("watch");
  });

  it("follows the workspace's own thresholds", () => {
    const strict = { ...S, runway_good_months: 24, runway_watch_months: 12 };
    expect(runwayStanding(18, strict)).toBe("watch");
  });
});

describe("the health check", () => {
  const history = (incomes: number[], cogsShare = 0.3, expenses = 0) =>
    incomes.map((income, i) =>
      book(
        `2026-${String(i + 1).padStart(2, "0")}`,
        income,
        Math.round(income * cogsShare),
        expenses,
      ),
    );

  it("leaves the month in progress out of every figure", () => {
    const books = [
      ...history([100000, 100000, 100000, 100000, 100000, 100000]),
      book("2026-07", 1),
    ];
    const report = healthCheck(
      { books, cash: [], current: "2026-07", cashOnHand: 0, lines: null, settings: S },
      money,
    );
    expect(report.partial).toBe("2026-07");
    expect(report.complete.at(-1)?.month).toBe("2026-06");
    expect(report.growth.growth).toBe(0);
  });

  it("writes the wins, watches and actions from fixed rules", () => {
    const books = history([100000, 100000, 100000, 120000, 120000, 120000], 0.2, 10000);
    const report = healthCheck(
      {
        books,
        cash: books.map((m) => flow(m.month, 5000)),
        current: "2026-07",
        cashOnHand: 500000,
        lines: [
          { name: "Shop", cents: 90 },
          { name: "Classes", cents: 10 },
        ],
        settings: S,
      },
      money,
    );
    const keys = (tone: string) => report.notes.filter((n) => n.tone === tone).map((n) => n.key);
    expect(keys("win")).toEqual(["margin", "growth", "runway"]);
    expect(report.notes.find((n) => n.key === "runway")?.text).toContain("$50.00 a month more");
    expect(keys("watch")).toEqual(["concentration"]);
    expect(keys("action")).toEqual(["lines"]);
    expect(report.runway).toEqual({ months: null, standing: "good" });
    expect(report.concentration).toMatchObject({ name: "Shop", standing: "watch" });
  });

  it("warns of a short runway and a thin margin, and works out the margin lift", () => {
    const books = history([100000, 100000, 100000, 80000, 80000, 80000], 0.6, 40000);
    const report = healthCheck(
      {
        books,
        cash: books.map((m) => flow(m.month, -100000)),
        current: "2026-07",
        cashOnHand: 300000,
        lines: null,
        settings: S,
      },
      money,
    );
    expect(report.runway).toEqual({ months: 3, standing: "bad" });
    const keys = report.notes.map((n) => `${n.tone}:${n.key}`);
    expect(keys).toEqual(["watch:growth", "watch:thin-margin", "watch:runway", "action:cogs"]);
    // 5 points of the recent months' average revenue, for a year: 800.00 × 12 × 5%.
    expect(report.notes.at(-1)?.text).toContain("$480.00");
  });

  it("has no runway without a balance sheet, and no concentration without lines", () => {
    const report = healthCheck(
      {
        books: history([1, 1, 1]),
        cash: [],
        current: "2026-07",
        cashOnHand: null,
        lines: null,
        settings: S,
      },
      money,
    );
    expect(report.runway).toBeNull();
    expect(report.concentration).toBeNull();
    expect(report.growth.standing).toBeNull();
  });
});
