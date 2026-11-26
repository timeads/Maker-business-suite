import { describe, expect, it } from "vitest";
import { breakEven, blanksFromAverage } from "../budget";
import type { BookMonth } from "../health";
import {
  afterDebt,
  bankKey,
  pickedBanks,
  debtBudgetRows,
  debtHealth,
  debtHomeLine,
  debtTotals,
  emergencyFund,
  isPaidOff,
  matchPayments,
  paymentWords,
  scheduleLength,
  toPlanDebt,
  usualMonthlyExpenses,
  type Debt,
} from "./figures";
import {
  DEFAULT_DEBT_SETTINGS,
  bpWords,
  debtSettingsSchema,
  parseDebtSettings,
  percentToBp,
  type DebtSettings,
} from "./settings";

const debt = (over: Partial<Debt> & Pick<Debt, "id">): Debt => ({
  name: over.id,
  kind: "card",
  plan: "pool",
  status: "active",
  rateBp: 0,
  minimum: 0,
  payment: null,
  revolvingBp: null,
  dueDay: null,
  priority: null,
  opening: null,
  booksAccount: null,
  source: "person",
  bookAccountId: null,
  needsRate: false,
  note: null,
  balance: null,
  balanceAsOf: null,
  balanceFrom: null,
  consolidated: false,
  coveredBy: null,
  planAccountId: null,
  planBalanceFrom: null,
  credit: 0,
  ...over,
});

const month = (
  m: string,
  income: number,
  cogs: number,
  expenses: number,
  other: number | null = 0,
): BookMonth => ({
  month: m,
  income,
  cogs,
  expenses,
  netIncome: income - cogs - expenses,
  otherIncome: 0,
  otherExpenses: other,
});

describe("the settings", () => {
  it("default to the dashboard's choices, with the target as six months of expenses", () => {
    expect(DEFAULT_DEBT_SETTINGS).toMatchObject({
      strategy: "avalanche",
      hybrid_threshold_cents: 100_000,
      revenue_share_pct: 7,
      emergency_target: "months",
      emergency_months: 6,
      emergency_split_pct: 30,
      emergency_monthly_cents: 0,
      debt_revenue_good_pct: 30,
      debt_revenue_watch_pct: 60,
      coverage_good_x100: 150,
      coverage_watch_x100: 110,
    });
  });

  it("refuse thresholds the wrong way round and fall back when unreadable", () => {
    expect(
      debtSettingsSchema.safeParse({
        version: 1,
        debt_revenue_good_pct: 70,
        debt_revenue_watch_pct: 60,
      }).success,
    ).toBe(false);
    expect(parseDebtSettings({ version: 2 })).toEqual(DEFAULT_DEBT_SETTINGS);
  });

  it("read a rate with up to two decimals as basis points, and say it back", () => {
    expect(percentToBp("22.99")).toBe(2_299);
    expect(percentToBp(" 18 %")).toBe(1_800);
    expect(percentToBp("0.5")).toBe(50);
    expect(percentToBp("1.234")).toBeNull();
    expect(percentToBp("abc")).toBeNull();
    expect(percentToBp("1001")).toBeNull();
    expect(bpWords(2_299)).toBe("22.99%");
    expect(bpWords(2_290)).toBe("22.9%");
    expect(bpWords(1_800)).toBe("18%");
    expect(bpWords(5)).toBe("0.05%");
  });
});

describe("the totals", () => {
  const debts = [
    debt({ id: "a", balance: 40_000, opening: 100_000, minimum: 2_500, payment: 5_000 }),
    debt({ id: "b", balance: 10_000, minimum: 1_000 }),
    debt({ id: "c", balance: 0, opening: 20_000, minimum: 3_000 }),
    debt({ id: "x", status: "closed", balance: 9_999, opening: 9_999, minimum: 700 }),
  ];
  it("add up what's owed, what's been paid off and the monthly payments", () => {
    expect(debtTotals(debts)).toEqual({
      owed: 50_000,
      paidOff: 60_000 + 20_000 + 0,
      monthly: 5_000 + 1_000,
    });
  });
  it("hand the plan a debt's balance, never below zero, and whether it counts", () => {
    expect(toPlanDebt(debt({ id: "p", balance: -5, status: "paused" }))).toMatchObject({
      balance: 0,
      active: false,
    });
  });
});

describe("the emergency fund", () => {
  const books = [
    month("2026-08", 0, 0, 100_000, 20_000),
    month("2026-09", 0, 0, 110_000, null),
    month("2026-10", 0, 0, 90_001, 0),
  ];
  it("knows the usual month: expenses and other expenses over complete months", () => {
    // (120,000 + 110,000 + 90,001) ÷ 3 = 106,667
    expect(usualMonthlyExpenses(books)).toBe(106_667);
  });

  it("aims at months of that, from the chosen bank accounts", () => {
    const fund = emergencyFund(
      {
        ...DEFAULT_DEBT_SETTINGS,
        emergency_months: 3,
        emergency_accounts: ["Savings  Reserve", "Gone"],
      },
      books,
      [
        { name: "savings reserve", cents: 150_000 },
        { name: "Operating", cents: 999_999 },
      ],
    );
    expect(fund).toMatchObject({
      target: 320_001,
      targetFrom: "months",
      current: 150_000,
      currentFrom: "books",
      missing: ["Gone"],
    });
    expect(fund.progress).toBeCloseTo(150_000 / 320_001);
  });

  it("reads picked accounts by the books' id, so a renamed account keeps counting", () => {
    const fund = emergencyFund(
      {
        ...DEFAULT_DEBT_SETTINGS,
        emergency_picks: [
          { id: "35", name: "Rainy Day" },
          { id: null, name: "Tin Box" },
        ],
        // Named the earlier way, and the same as a pick: counted once.
        emergency_accounts: ["rainy day", "Old Name"],
      },
      books,
      [
        { name: "Rainy Day Renamed", cents: 200_000, id: "35" },
        { name: "Rainy Day", cents: 5, id: "36" },
        { name: "Tin Box", cents: -30_000 },
      ],
    );
    expect(fund).toMatchObject({
      current: 230_000,
      currentFrom: "books",
      accounts: ["Rainy Day Renamed", "Tin Box"],
      missing: ["Old Name"],
    });
  });

  it("ticks the picked accounts in the picker, each once", () => {
    const banks = [
      { name: "Rainy Day", cents: 1, id: "35" },
      { name: "Tin Box", cents: 2 },
    ];
    const settings = {
      ...DEFAULT_DEBT_SETTINGS,
      emergency_picks: [{ id: "35", name: "Old" }],
      emergency_accounts: ["tin  box", "Tin Box"],
    };
    expect(pickedBanks(settings, banks).map(bankKey)).toEqual(["id:35", "name:Tin Box"]);
  });

  it("never guesses between two accounts of the same name", () => {
    const fund = emergencyFund(
      { ...DEFAULT_DEBT_SETTINGS, emergency_picks: [{ id: null, name: "Savings" }] },
      books,
      [
        { name: "Savings", cents: 100, id: "1" },
        { name: "Savings", cents: 200, id: "2" },
      ],
    );
    expect(fund).toMatchObject({ current: 0, missing: ["Savings"] });
  });

  it("uses a typed target and a typed amount when no account is chosen", () => {
    const settings: DebtSettings = {
      ...DEFAULT_DEBT_SETTINGS,
      emergency_target: "amount",
      emergency_target_cents: 500_000,
      emergency_current_cents: 600_000,
    };
    expect(emergencyFund(settings, books, null)).toMatchObject({
      target: 500_000,
      usualMonth: null,
      current: 600_000,
      currentFrom: "typed",
      progress: 1,
    });
    expect(
      emergencyFund({ ...settings, emergency_current_cents: null }, books, null),
    ).toMatchObject({
      current: 0,
      currentFrom: "none",
    });
  });
});

describe("the cash health tiles and notes", () => {
  const books = Array.from({ length: 12 }, (_, i) =>
    month(`2025-${String(i + 1).padStart(2, "0")}`, 1_000_000, 400_000, 400_000),
  );
  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const debts = [
    debt({ id: "a", balance: 3_000_000, minimum: 50_000, payment: 100_000 }),
    debt({ id: "b", plan: "fixed", balance: 3_000_000, payment: 100_000 }),
  ];
  const health = debtHealth({
    debts,
    complete: books,
    compareMonths: 3,
    operatingMargin: 0.2,
    settings: DEFAULT_DEBT_SETTINGS,
    money,
  });

  it("works debt to a year's revenue and how well profit covers the payments", () => {
    // 60,000.00 owed on 120,000.00 of revenue.
    expect(health.toRevenue).toEqual({ share: 0.5, revenue: 12_000_000, standing: "watch" });
    // (2,000.00 profit + 2,000.00 payments) ÷ 2,000.00.
    expect(health.coverage).toEqual({ times: 2, profit: 200_000, standing: "good" });
  });

  it("writes the dashboard's notes in plain words", () => {
    expect(health.notes.map((n) => [n.tone, n.key])).toEqual([
      ["win", "debt-coverage"],
      ["action", "debt-plan"],
      ["action", "debt-extra"],
    ]);
    expect(health.notes[1].text).toContain("$500.00 a month");
  });

  it("calls nothing to pay healthy, and debt with no revenue unknown", () => {
    const none = debtHealth({
      debts: [],
      complete: [],
      compareMonths: 3,
      operatingMargin: null,
      settings: DEFAULT_DEBT_SETTINGS,
      money,
    });
    expect(none.toRevenue).toBeNull();
    expect(none.coverage).toMatchObject({ times: null, standing: "good" });
    expect(none.notes).toEqual([]);
  });

  it("says what profit looks like once the plan's minimums are freed", () => {
    expect(afterDebt({ debts, complete: books, compareMonths: 3, monthsToFreedom: 31 })).toEqual({
      months: 31,
      freed: 50_000,
      profitNow: 200_000,
      profitAfter: 250_000,
      shareOfRevenue: 0.2,
    });
  });
});

describe("debt rows in the budget", () => {
  const debts = [
    debt({ id: "a", name: "Card", balance: 10_000, minimum: 2_500, payment: 4_000 }),
    debt({ id: "b", name: "Loan", balance: 0, minimum: 3_000 }),
    debt({ id: "c", name: "Gone", status: "closed", balance: 0, minimum: 3_000 }),
    debt({ id: "d", name: "Waiting", status: "paused", balance: 50_000, minimum: 1_000 }),
  ];
  const rows = debtBudgetRows({
    debts,
    paid: [
      { debtId: "a", month: "2026-10", cents: 4_500 },
      { debtId: "b", month: "2026-10", cents: 3_000 },
    ],
    months: ["2026-10", "2026-11", "2026-12"],
    current: "2026-11",
    warnPct: 15,
  });

  it("use what was booked, else the usual payment marked as an estimate for months begun", () => {
    const card = rows.find((r) => r.key === "debt:a")!;
    expect(card).toMatchObject({
      group: "Debt payments",
      name: "Card",
      average: 4_000,
      budget: 12_000,
      actual: 4_500 + 4_000,
      debt: { estimatedMonths: 1 },
      variable: false,
    });
    // Paid off: no budget, but what was booked still shows.
    expect(rows.find((r) => r.key === "debt:b")).toMatchObject({ budget: 0, actual: 3_000 });
  });

  it("leave out closed debts and ones with nothing paid and nothing budgeted", () => {
    expect(rows.map((r) => r.key)).toEqual(["debt:a", "debt:b"]);
  });

  it("count as fixed costs in break-even and are never filled from the average", () => {
    expect(breakEven(rows, 0.5).fixed).toBe(12_000);
    expect(blanksFromAverage(rows.map((r) => ({ ...r, budgeted: 0 })))).toEqual([]);
  });
});

describe("payments from the books", () => {
  it("match a move to the debt whose account it went into, by the account's name", () => {
    const matched = matchPayments(
      [
        { account: "Card  Account", cents: 1 },
        { account: "Somewhere else", cents: 2 },
        { account: null, cents: 3 },
      ],
      [
        { id: "a", booksAccount: "card account" },
        { id: "b", booksAccount: null },
      ],
    );
    expect(matched).toEqual([{ account: "Card  Account", cents: 1, debtId: "a" }]);
  });
});

describe("the schedule's length", () => {
  const plan = [
    5, 4, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ].map((total) => ({ total }));
  it("is 24 months, or every month to payoff and at least a year", () => {
    expect(scheduleLength(plan, false)).toBe(24);
    expect(scheduleLength(plan, true)).toBe(12);
    const long = Array.from({ length: 60 }, (_, i) => ({ total: i < 40 ? 1 : 0 }));
    expect(scheduleLength(long, true)).toBe(41);
  });
});

describe("the home card's debt line", () => {
  const money = (cents: number) => `$${(cents / 100).toFixed(0)}`;
  it("says what's owed, what's paid off and the next in line", () => {
    expect(
      debtHomeLine(
        [
          debt({ id: "a", name: "Loan", balance: 50_000, opening: 80_000, priority: 2 }),
          debt({ id: "b", name: "Card", balance: 10_000, priority: 1 }),
          debt({ id: "c", name: "Held", status: "paused", balance: 5_000, priority: 0 }),
        ],
        money,
      ),
    ).toBe("$650 of debt to go · $300 paid off so far · next to clear: Card");
  });
  it("says nothing with nothing owed", () => {
    expect(debtHomeLine([], money)).toBeNull();
    expect(debtHomeLine([debt({ id: "a", balance: 0 })], money)).toBeNull();
  });
});

describe("how a debt sits on Money → Debts", () => {
  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  it("folds away a debt from the books at nothing owed, paid off or in credit", () => {
    expect(isPaidOff(debt({ id: "a", source: "books", balance: 0 }))).toBe(true);
    expect(isPaidOff(debt({ id: "b", source: "books", balance: 0, credit: 1200 }))).toBe(true);
    expect(isPaidOff(debt({ id: "c", source: "books", balance: 1 }))).toBe(false);
    // No balance yet isn't paid off; nor is a typed-in debt, a plan or a closed one.
    expect(isPaidOff(debt({ id: "d", source: "books", balance: null }))).toBe(false);
    expect(isPaidOff(debt({ id: "e", source: "person", balance: 0 }))).toBe(false);
    expect(isPaidOff(debt({ id: "f", source: "books", balance: 0, status: "closed" }))).toBe(false);
    expect(isPaidOff(debt({ id: "g", source: "books", balance: 0, consolidated: true }))).toBe(
      false,
    );
  });

  it("says what is paid a month, a share of sales, or that nothing is paid for now", () => {
    const opts = { revenueSharePct: 12, averageRevenue: 1_000_000, money };
    expect(paymentWords(debt({ id: "a", minimum: 2500 }), opts)).toBe(money(2500));
    expect(paymentWords(debt({ id: "b", minimum: 2500, status: "paused" }), opts)).toBe(
      "No payments for now",
    );
    expect(paymentWords(debt({ id: "c", plan: "revenue_share" }), opts)).toBe(
      `A share of sales (12%, about ${money(120000)})`,
    );
    expect(
      paymentWords(debt({ id: "d", plan: "revenue_share" }), { ...opts, averageRevenue: 0 }),
    ).toBe("A share of sales (12%)");
    expect(paymentWords(debt({ id: "e", plan: "revenue_share", payment: 9000 }), opts)).toBe(
      `A share of sales, counted as ${money(9000)}`,
    );
  });
});
