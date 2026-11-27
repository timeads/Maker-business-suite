import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFIT_SETTINGS,
  NO_ENTRIES,
  WEEKS_PER_MONTH,
  costInMonth,
  monthEntries,
  monthParts,
  monthlyCostSchema,
  typedRevenue,
  monthlyCostCents,
  parseProfitSettings,
  profitByLine,
  profitSettingsSchema,
  proratedCents,
  type MonthlyCost,
  type ProfitSettings,
} from "./profit";

const LINES = [
  { id: "classes", name: "Classes" },
  { id: "shop", name: "Shop" },
  { id: "commissions", name: "Commissions" },
];

const cost = (over: Partial<MonthlyCost>): MonthlyCost => ({
  id: "c-1",
  name: "Cost",
  how: "amount",
  amount_cents: 0,
  rate_cents: 0,
  hours_per_week: 0,
  hours_per_session: 0,
  sessions_per_month: 0,
  split: { shop: 100 },
  ...over,
});

const settings = (over: Partial<ProfitSettings> = {}): ProfitSettings =>
  profitSettingsSchema.parse({ version: 1, ...over });

describe("the profit setting", () => {
  it("starts with nothing to share out, and falls back to that when it can't be read", () => {
    expect(parseProfitSettings(null)).toEqual(DEFAULT_PROFIT_SETTINGS);
    expect(parseProfitSettings({ version: 1, shared_split: { shop: 50 } })).toEqual(
      DEFAULT_PROFIT_SETTINGS,
    );
  });

  it("wants the shares of shared costs and of each monthly cost to add up to 100", () => {
    expect(
      profitSettingsSchema.safeParse({ version: 1, shared_split: { shop: 60, classes: 40 } })
        .success,
    ).toBe(true);
    expect(
      profitSettingsSchema.safeParse({ version: 1, shared_split: { shop: 60, classes: 30 } })
        .success,
    ).toBe(false);
    expect(
      profitSettingsSchema.safeParse({
        version: 1,
        monthly_costs: [cost({ split: { shop: 90 } })],
      }).success,
    ).toBe(false);
    expect(
      profitSettingsSchema.safeParse({ version: 1, monthly_costs: [cost({}), cost({})] }).success,
    ).toBe(false);
  });
});

describe("monthly costs", () => {
  it("works a month out three ways, the dashboard's way", () => {
    expect(monthlyCostCents(cost({ how: "amount", amount_cents: 150000 }))).toBe(150000);
    // An hourly rate × hours a week × the weeks in a month.
    expect(
      monthlyCostCents(cost({ how: "weekly_hours", rate_cents: 1800, hours_per_week: 4 })),
    ).toBe(Math.round(1800 * 4 * WEEKS_PER_MONTH));
    // An hourly rate × hours a class × classes a month.
    expect(
      monthlyCostCents(
        cost({ how: "sessions", rate_cents: 2500, hours_per_session: 4, sessions_per_month: 2 }),
      ),
    ).toBe(20000);
  });

  it("counts whole months in full and part months by the day", () => {
    expect(monthParts("2026-10-01", "2026-12-01")).toEqual([
      { month: "2026-10", days: 31, daysInMonth: 31 },
      { month: "2026-11", days: 30, daysInMonth: 30 },
    ]);
    expect(monthParts("2026-02-15", "2026-03-03")).toEqual([
      { month: "2026-02", days: 14, daysInMonth: 28 },
      { month: "2026-03", days: 2, daysInMonth: 31 },
    ]);
    expect(proratedCents(3100, monthParts("2026-10-01", "2026-12-01"))).toBe(6200);
    expect(proratedCents(3100, monthParts("2026-11-01", "2026-11-16"))).toBe(1550);
    expect(proratedCents(1000, monthParts("2026-11-01", "2026-11-01"))).toBe(0);
  });

  it("isn't thrown by the clocks changing: months are plain calendar days", () => {
    // Daylight saving ends on the first of November in New York.
    expect(monthParts("2026-10-31", "2026-11-02")).toEqual([
      { month: "2026-10", days: 1, daysInMonth: 31 },
      { month: "2026-11", days: 1, daysInMonth: 30 },
    ]);
  });
});

describe("profit by line", () => {
  const october = monthParts("2026-10-01", "2026-11-01");

  it("follows the dashboard's sum, step by step, in whole cents", () => {
    const sum = profitByLine({
      lines: LINES,
      revenue: new Map([
        ["classes", 500000],
        ["shop", 900000],
        ["commissions", 300000],
      ]),
      cogs: null,
      expenses: [
        { sort: "line", line: "shop", split: null, cents: 120000 },
        { sort: "split", line: null, split: { shop: 60, commissions: 40 }, cents: 10001 },
        { sort: "shared", line: null, split: null, cents: 30000 },
        { sort: "set_aside", line: null, split: null, cents: 99999 },
        { sort: null, line: null, split: null, cents: 4500 },
        // Sorted to a line since removed: back to "not sorted".
        { sort: "line", line: "gone", split: null, cents: 500 },
      ],
      settings: settings({
        shared_split: { classes: 20, shop: 50, commissions: 30 },
        monthly_costs: [
          cost({
            id: "rent",
            how: "amount",
            amount_cents: 200000,
            split: { shop: 60, commissions: 40 },
          }),
          cost({
            id: "teacher",
            how: "sessions",
            rate_cents: 2500,
            hours_per_session: 4,
            sessions_per_month: 1,
            split: { classes: 100 },
          }),
        ],
      }),
      parts: october,
    });
    const by = Object.fromEntries(sum.rows.map((row) => [row.id, row]));
    expect(by.shop).toEqual({
      id: "shop",
      name: "Shop",
      revenue: 900000,
      cogs: null,
      direct: 120000 + 6001,
      shared: 15000,
      monthly: 120000,
      profit: 900000 - 126001 - 15000 - 120000,
    });
    expect(by.commissions.direct).toBe(4000);
    expect(by.classes).toMatchObject({ direct: 0, shared: 6000, monthly: 10000 });
    expect(sum.unsorted).toBe(5000);
    expect(sum.setAside).toBe(99999);
    expect(sum.sharedUnsplit).toBe(0);
    expect(sum.profit).toBe(sum.rows.reduce((a, row) => a + row.profit, 0));
  });

  it("takes off cost of goods only when it's counted from the shop", () => {
    const sum = profitByLine({
      lines: LINES,
      revenue: new Map([["shop", 10000]]),
      cogs: new Map([["shop", 2500]]),
      expenses: [],
      settings: settings(),
      parts: october,
    });
    expect(sum.rows.find((row) => row.id === "shop")).toMatchObject({ cogs: 2500, profit: 7500 });
    expect(sum.rows.find((row) => row.id === "classes")).toMatchObject({ cogs: 0, profit: 0 });
  });

  it("keeps shared costs apart until there's a split to share them by", () => {
    const sum = profitByLine({
      lines: LINES,
      revenue: new Map(),
      cogs: null,
      expenses: [{ sort: "shared", line: null, split: null, cents: 30000 }],
      settings: settings({
        monthly_costs: [cost({ amount_cents: 1000, split: { removed: 100 } })],
      }),
      parts: october,
    });
    expect(sum.sharedUnsplit).toBe(31000);
    expect(sum.rows.every((row) => row.shared === 0 && row.monthly === 0)).toBe(true);
  });

  it("shares the shared pool once, the odd cents to the largest share", () => {
    const sum = profitByLine({
      lines: LINES,
      revenue: new Map(),
      cogs: null,
      expenses: [
        { sort: "shared", line: null, split: null, cents: 1 },
        { sort: "shared", line: null, split: null, cents: 1 },
        { sort: "shared", line: null, split: null, cents: 1 },
      ],
      settings: settings({ shared_split: { classes: 34, shop: 33, commissions: 33 } }),
      parts: october,
    });
    // 3 cents: 1 by its 34%, nothing by the 33%s, and the 2 left over to the largest share.
    expect(sum.rows.map((row) => row.shared)).toEqual([3, 0, 0]);
  });
});

describe("month-by-month entries", () => {
  const help: MonthlyCost = monthlyCostSchema.parse({
    id: "help",
    name: "Studio help",
    how: "amount",
    amount_cents: 80000,
    split: { shop: 100 },
  });

  it("uses a month's own figure for a monthly cost, by the day for part of a month", () => {
    const entries = monthEntries([
      { kind: "cost", month: "2026-10-01", subject: "help", amount_cents: 95000 },
      { kind: "revenue", month: "2026-11-01", subject: "classes", amount_cents: 3000 },
      { kind: "other", month: "2026-11-01", subject: "x", amount_cents: 1 },
    ]);
    expect(costInMonth(help, "2026-10", entries)).toBe(95000);
    expect(costInMonth(help, "2026-09", entries)).toBe(80000);
    const parts = monthParts("2026-10-01", "2026-11-16");
    const sum = profitByLine({
      lines: [{ id: "shop", name: "Shop" }],
      revenue: new Map(),
      cogs: null,
      expenses: [],
      settings: { ...DEFAULT_PROFIT_SETTINGS, monthly_costs: [help] },
      parts,
      entries,
    });
    expect(sum.rows[0].monthly).toBe(95000 + Math.round((80000 * 15) / 30));
    expect(typedRevenue(entries, parts)).toEqual(new Map([["classes", 1500]]));
  });

  it("changes nothing without entries", () => {
    const parts = monthParts("2026-10-01", "2026-11-01");
    const input = {
      lines: [{ id: "shop", name: "Shop" }],
      revenue: new Map(),
      cogs: null,
      expenses: [],
      settings: { ...DEFAULT_PROFIT_SETTINGS, monthly_costs: [help] },
      parts,
    };
    expect(profitByLine(input)).toEqual(profitByLine({ ...input, entries: NO_ENTRIES }));
    expect(profitByLine(input).rows[0].monthly).toBe(80000);
  });
});
