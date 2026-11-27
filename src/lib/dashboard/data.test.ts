import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { loadDashboardConfig, loadDashboardData, type WidgetData } from "./data";
import { revenueSettingsSchema, type RevenueSettings } from "./lines";
import { resolveRange } from "./range";
import { dashboardSchema } from "./schema";
import { DEFAULT_TEMPLATE, templateConfig, withLineWidgets } from "./templates";

type Call = { fn: string; args: Record<string, unknown>; range?: [number, number] };

/**
 * A stand-in for the member's Supabase client: answers each database
 * function from `answers` (a function of the call, so paging can be seen)
 * and records every call.
 */
function fakeSupabase(
  answers: Record<string, (call: Call) => unknown[]>,
  options: {
    orders?: number;
    config?: unknown;
    /** Config bodies by key, for loaders that read more than one. */
    configs?: Record<string, unknown>;
    snapshots?: { kind: string; period_start: string; data: Record<string, unknown> }[];
    /** Rows other tables hand back (what row-level security would let through). */
    tables?: Record<string, unknown[]>;
  } = {},
) {
  const calls: Call[] = [];
  const rpc = (fn: string, args: Record<string, unknown>) => {
    const call: Call = { fn, args };
    calls.push(call);
    const result = () => Promise.resolve({ data: answers[fn]?.(call) ?? [], error: null });
    return {
      range(from: number, to: number) {
        call.range = [from, to];
        return result();
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        result().then(resolve, reject),
    };
  };
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    let kinds: string[] | null = null;
    const snapshots = () =>
      (options.snapshots ?? []).filter(
        (row) =>
          (kinds === null || kinds.includes(row.kind)) &&
          (filters.kind === undefined || row.kind === filters.kind),
      );
    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return chain;
      },
      in: (column: string, values: string[]) => {
        if (column === "kind") kinds = values;
        return chain;
      },
      is: () => chain,
      gte: () => chain,
      lt: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => {
        if (table === "financial_snapshots") {
          const rows = snapshots().sort((a, b) => b.period_start.localeCompare(a.period_start));
          return Promise.resolve({ data: rows[0] ?? null, error: null });
        }
        const body =
          table === "configs" && filters.key !== undefined && options.configs
            ? options.configs[String(filters.key)]
            : options.config;
        return Promise.resolve({
          data: body === undefined ? null : { body },
          error: null,
        });
      },
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(
          table === "orders"
            ? { count: options.orders ?? 1, data: null, error: null }
            : table === "financial_snapshots"
              ? {
                  data: snapshots().sort((a, b) => a.period_start.localeCompare(b.period_start)),
                  error: null,
                }
              : { data: options.tables?.[table] ?? [], error: null },
        ).then(resolve),
    };
    return chain;
  };
  return { supabase: { rpc, from } as unknown as SupabaseClient, calls };
}

const TENANT = { id: "t1", timezone: "America/New_York" };
const NOW = new Date("2026-11-21T17:00:00Z");
const RANGE = resolveRange("last_6_months", NOW, TENANT.timezone);

const LINES: RevenueSettings = revenueSettingsSchema.parse({
  version: 1,
  lines: [
    { id: "shop", name: "Shop" },
    { id: "classes", name: "Classes" },
  ],
  default_line: "shop",
  rules: [{ id: "w", match: "workshop", line: "classes" }],
});

const config = (widgets: unknown[]) => dashboardSchema.parse({ version: 1, name: "Test", widgets });

const group = (over: Record<string, unknown>) => ({
  period: "2026-11-01",
  order_tags: [],
  product_external_id: "1",
  product_tags: [],
  product_type: null,
  workshop: false,
  dated: false,
  revenue_cents: "0",
  units: "0",
  ...over,
});

describe("loading Money's figures", () => {
  it("asks the same queries as before for net sales, so nothing changes", async () => {
    const { supabase, calls } = fakeSupabase({
      dashboard_sales_by_period: () => [
        { period: "2026-11-01", order_count: 2, net_sales: 150, cost: 0, costed_sales: 0 },
      ],
      dashboard_sales_by_channel: () => [
        { channel: "Online Store", order_count: 2, net_sales: 150 },
      ],
    });
    const data = await loadDashboardData(
      supabase,
      TENANT,
      config([
        { id: "f", type: "key_figures" },
        { id: "s", type: "sales_over_time" },
        { id: "c", type: "sales_by_channel" },
      ]),
      RANGE,
    );
    expect(calls.map((c) => c.fn).sort()).toEqual([
      "dashboard_sales_by_channel",
      "dashboard_sales_by_period",
    ]);
    expect(data.f).toMatchObject({
      type: "key_figures",
      figure: "net_sales",
      sales: 150,
      orders: 2,
    });
    expect(data.s).toMatchObject({ type: "sales_over_time", figure: "net_sales", total: 150 });
    expect(data.c).toMatchObject({ type: "sales_by_channel", total: 150 });
  });

  it("counts order totals from their own queries, and margin still on net sales", async () => {
    const { supabase, calls } = fakeSupabase({
      dashboard_sales_by_period: () => [
        { period: "2026-11-01", order_count: 2, net_sales: 150, cost: 30, costed_sales: 100 },
      ],
      money_sales_by_period: () => [{ period: "2026-11-01", order_count: 1, revenue: 162 }],
      money_sales_by_channel: () => [{ channel: "Online Store", order_count: 1, revenue: 162 }],
    });
    const revenue = revenueSettingsSchema.parse({ version: 1, figure: "order_totals" });
    const data = await loadDashboardData(
      supabase,
      TENANT,
      config([
        { id: "f", type: "key_figures" },
        { id: "c", type: "sales_by_channel" },
      ]),
      RANGE,
      revenue,
    );
    expect(data.f).toMatchObject({
      figure: "order_totals",
      sales: 162,
      orders: 1,
      averageOrder: 162,
      margin: 0.7,
    });
    expect(data.c).toMatchObject({ figure: "order_totals", total: 162 });
    expect(calls.find((c) => c.fn === "money_sales_by_period")?.args.p_figure).toBe("order_totals");
  });

  it("sorts sales into lines, pages past a thousand rows, and shows each line over time", async () => {
    const { supabase, calls } = fakeSupabase({
      money_line_revenue: (call) => {
        if (call.args.p_dated_only) {
          return [
            group({
              product_external_id: "9",
              workshop: true,
              revenue_cents: "4500",
              units: "1",
              dated: true,
            }),
          ];
        }
        const [start] = call.range ?? [0, 0];
        if (start === 0) {
          // A full first page: 999 empty rows and one real sale.
          return [
            ...Array.from({ length: 999 }, () => group({})),
            group({ period: "2026-10-01", workshop: true, revenue_cents: "9000", units: "2" }),
          ];
        }
        return [group({ revenue_cents: "1234", units: "1" })];
      },
    });
    const data = await loadDashboardData(
      supabase,
      TENANT,
      config([
        { id: "l", type: "revenue_by_line" },
        { id: "t", type: "revenue_by_line_over_time", grouping: "month" },
        { id: "d", type: "deferred_revenue" },
      ]),
      RANGE,
      { ...LINES, by_class_date: true },
      NOW,
    );
    const lineCalls = calls.filter((c) => c.fn === "money_line_revenue" && !c.args.p_dated_only);
    expect(lineCalls.map((c) => c.range)).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(lineCalls[0].args).toMatchObject({ p_by_class_date: true, p_figure: "net_sales" });
    expect(data.l).toMatchObject({
      type: "revenue_by_line",
      total: 102.34,
      rows: [
        { name: "Shop", value: 12.34, detail: "12.1% and anything no rule matched" },
        { name: "Classes", value: 90, detail: "87.9%" },
      ],
    });
    const overTime = data.t as Extract<typeof data.t, { type: "revenue_by_line_over_time" }>;
    expect(overTime.series.map((s) => s.name)).toEqual(["Shop", "Classes"]);
    expect(overTime.series[1].points.find((p) => p.key === "2026-10-01")?.value).toBe(90);
    expect(overTime.series[1].points).toHaveLength(6);
    // Deferred: from the start of today in New York, classes only.
    const deferredCall = calls.find((c) => c.args.p_dated_only);
    expect(deferredCall?.args.p_from).toBe("2026-11-21T05:00:00.000Z");
    expect(data.d).toMatchObject({
      type: "deferred_revenue",
      total: 45,
      places: 1,
      rows: [{ name: "Classes", value: 45, detail: "1 place" }],
    });
  });

  it("asks for lines to be set up before splitting anything", async () => {
    const { supabase, calls } = fakeSupabase({});
    const data = await loadDashboardData(
      supabase,
      TENANT,
      config([{ id: "l", type: "revenue_by_line" }]),
      RANGE,
    );
    expect(data.l).toEqual({ type: "empty", needs: "lines" });
    expect(calls.some((c) => c.fn === "money_line_revenue")).toBe(false);
  });
});

describe("the standard layout", () => {
  it("gains the line widgets only where lines are set up, and never on a saved layout", async () => {
    const plain = await loadDashboardConfig(fakeSupabase({}).supabase, "t1");
    expect(plain.config.widgets.some((w) => w.type === "revenue_by_line")).toBe(false);

    const withLines = await loadDashboardConfig(fakeSupabase({}).supabase, "t1", LINES);
    const types = withLines.config.widgets.map((w) => w.type);
    expect(types.indexOf("revenue_by_line_over_time")).toBe(types.indexOf("sales_over_time") + 1);
    expect(types).toContain("deferred_revenue");

    const saved = templateConfig(DEFAULT_TEMPLATE);
    const kept = await loadDashboardConfig(
      fakeSupabase({}, { config: saved }).supabase,
      "t1",
      LINES,
    );
    expect(kept.config).toEqual(saved);
  });

  it("adds each line widget once", () => {
    const once = withLineWidgets(templateConfig(DEFAULT_TEMPLATE));
    expect(withLineWidgets(once)).toEqual(once);
  });
});

describe("profit and expenses by line", () => {
  const PROFIT = {
    version: 1,
    cost_of_goods: "in_expenses",
    shared_split: { shop: 50, classes: 50 },
    monthly_costs: [
      { id: "rent", name: "Studio rent", how: "amount", amount_cents: 10000, split: { shop: 100 } },
    ],
  };

  it("works each line's profit out from its revenue, its expenses and its shares", async () => {
    const { supabase, calls } = fakeSupabase(
      {
        money_line_revenue: () => [
          group({ revenue_cents: "50000" }),
          group({ product_external_id: "9", workshop: true, revenue_cents: "30000" }),
        ],
        money_expense_totals: () => [
          { period: "2026-10-01", sort: "line", line_id: "shop", split: null, cents: "12000" },
          { period: "2026-10-01", sort: "shared", line_id: null, split: null, cents: "1001" },
          { period: "2026-11-01", sort: null, line_id: null, split: null, cents: "700" },
        ],
      },
      { config: PROFIT },
    );
    const data = await loadDashboardData(
      supabase,
      TENANT,
      config([
        { id: "p", type: "profit_by_line" },
        { id: "e", type: "expenses_by_line" },
      ]),
      RANGE,
      LINES,
      NOW,
    );
    const totals = calls.find((call) => call.fn === "money_expense_totals")!;
    // The books' plain days in the workspace's timezone, the end not included.
    expect(totals.args).toMatchObject({ p_from: "2026-06-01", p_to: "2026-11-22" });
    const profit = data.p;
    if (profit.type !== "profit_by_line") throw new Error(profit.type);
    const shop = profit.rows.find((row) => row.id === "shop")!;
    // Six months of rent: five whole, and November to the 21st.
    const rent = 5 * 10000 + Math.round((10000 * 21) / 30);
    expect(shop).toMatchObject({ revenue: 50000, direct: 12000, shared: 501, monthly: rent });
    expect(shop.profit).toBe(50000 - 12000 - 501 - rent);
    expect(profit.rows.find((row) => row.id === "classes")).toMatchObject({
      revenue: 30000,
      shared: 500,
    });
    expect(profit.unsorted).toBe(700);
    const expenses = data.e;
    if (expenses.type !== "expenses_by_line") {
      // No expenses stored in the fake: it asks for the books.
      expect(expenses).toEqual({ type: "empty", needs: "quickbooks" });
    }
  });

  it("takes a month's own cost and revenue typed in, and says which accounts feed each line", async () => {
    const { supabase } = fakeSupabase(
      { money_line_revenue: () => [group({ revenue_cents: "50000" })] },
      {
        configs: {
          profit: PROFIT,
          expenses: {
            version: 1,
            accounts: [
              { ref: "7", name: "Studio supplies", action: { sort: "line", line: "shop" } },
            ],
          },
        },
        tables: {
          money_line_entries: [
            { kind: "cost", month: "2026-10-01", subject: "rent", amount_cents: 0 },
            { kind: "revenue", month: "2026-10-01", subject: "classes", amount_cents: 2500 },
          ],
        },
      },
    );
    const data = await loadDashboardData(
      supabase,
      TENANT,
      config([{ id: "p", type: "profit_by_line" }]),
      RANGE,
      LINES,
      NOW,
    );
    const profit = data.p as Extract<typeof data.p, { type: "profit_by_line" }>;
    const rent = 4 * 10000 + Math.round((10000 * 21) / 30);
    expect(profit.rows.find((r) => r.id === "shop")?.monthly).toBe(rent);
    expect(profit.rows.find((r) => r.id === "classes")?.revenue).toBe(2500);
    expect(profit.sources.find((r) => r.id === "classes")?.typed).toBe(2500);
    expect(profit.changedMonths).toBe(1);
    expect(profit.feeds.find((f) => f.id === "shop")?.lines[0]).toBe(
      "Shop takes everything in Studio supplies.",
    );
  });

  it("adds the books' paid invoices and other income where the setting says, once", async () => {
    const withBooks = revenueSettingsSchema.parse({
      ...LINES,
      books: {
        invoices: true,
        other_income: true,
        accounts: [
          { ref: "79", name: "Class income", choice: { line: "classes" } },
          { ref: "5", name: "Sales", choice: { skip: "shop" } },
        ],
      },
    });
    const { supabase, calls } = fakeSupabase(
      {
        money_line_revenue: () => [group({ revenue_cents: "50000" })],
        money_invoice_revenue: () => [
          { period: "2026-10-01", account_ref: "79", account: "Class income", cents: "7000" },
          { period: "2026-10-01", account_ref: "5", account: "Sales", cents: "50000" },
          { period: "2026-11-01", account_ref: "81", account: "Rentals", cents: "1500" },
        ],
      },
      {
        configs: { profit: PROFIT },
        snapshots: [
          {
            kind: "profit_and_loss",
            period_start: "2026-10-01",
            data: { income: 0, other_income_cents: 300 },
          },
          { kind: "profit_and_loss", period_start: "2026-11-01", data: { income: 0 } },
        ],
      },
    );
    const data = await loadDashboardData(
      supabase,
      TENANT,
      config([
        { id: "k", type: "key_figures" },
        { id: "l", type: "revenue_by_line" },
        { id: "t", type: "revenue_by_line_over_time", grouping: "month" },
        { id: "p", type: "profit_by_line" },
      ]),
      RANGE,
      withBooks,
      NOW,
    );
    expect(calls.find((c) => c.fn === "money_invoice_revenue")?.args).toMatchObject({
      p_from: "2026-06-01",
      p_to: "2026-11-22",
    });
    // The shop's own sales on the books' "Sales" account are never counted again.
    expect(data.k).toMatchObject({ type: "key_figures", fromBooks: 7300 });
    expect(data.l).toMatchObject({
      type: "revenue_by_line",
      total: 573,
      books: { invoices: 7000, otherIncome: 300, otherUnplaced: 300, waiting: 1500 },
    });
    const rows = (data.l as Extract<typeof data.l, { type: "revenue_by_line" }>).rows;
    expect(rows.map((r) => [r.name, r.value])).toEqual([
      ["Shop", 500],
      ["Classes", 70],
      ["Other revenue", 3],
    ]);
    const overTime = data.t as Extract<typeof data.t, { type: "revenue_by_line_over_time" }>;
    expect(overTime.series[1].points.find((p) => p.key === "2026-10-01")?.value).toBe(70);
    const profit = data.p as Extract<typeof data.p, { type: "profit_by_line" }>;
    expect(profit.rows.find((r) => r.id === "classes")?.revenue).toBe(7000);
    expect(profit.sources.find((r) => r.id === "classes")).toEqual({
      id: "classes",
      shop: 0,
      books: 7000,
      typed: 0,
    });
  });

  it("asks for lines first", async () => {
    const { supabase } = fakeSupabase({});
    const data = await loadDashboardData(
      supabase,
      TENANT,
      config([{ id: "p", type: "profit_by_line" }]),
      RANGE,
      undefined,
      NOW,
    );
    expect(data.p).toEqual({ type: "empty", needs: "lines" });
  });
});

describe("cash health from the books", () => {
  const pnl = (month: string, income: number, cogs: number, expenses: number, extra = {}) => ({
    kind: "profit_and_loss",
    period_start: `${month}-01`,
    data: { income, cogs, expenses, gross_profit: income - cogs, net_income: 0, ...extra },
  });
  const cash = (month: string, operating: number) => ({
    kind: "cash_flow",
    period_start: `${month}-01`,
    data: {
      operating_cents: operating,
      investing_cents: 0,
      financing_cents: 0,
      net_change_cents: operating,
    },
  });
  const sheet = (day: string, dollars: number) => ({
    kind: "balance_sheet",
    period_start: day,
    data: {
      cash: dollars,
      bank_accounts: [{ name: "Checking", cents: Math.round(dollars * 100) }],
    },
  });
  const snapshots = [
    pnl("2026-05", 1000, 300, 500),
    pnl("2026-06", 1000, 300, 500),
    pnl("2026-07", 1000, 300, 500),
    pnl("2026-08", 1100, 330, 500, { other_income_cents: 50000, other_expenses_cents: 0 }),
    pnl("2026-09", 1100, 330, 500, { other_income_cents: 0, other_expenses_cents: 0 }),
    pnl("2026-10", 1100, 330, 500, { other_income_cents: 0, other_expenses_cents: 1000 }),
    // The month in progress: partly booked, left out of the health check.
    pnl("2026-11", 10, 0, 900),
    cash("2026-08", -20000),
    cash("2026-09", -30000),
    cash("2026-10", -40000),
    cash("2026-11", -999999),
    // Years of daily balance sheets: only the latest one counts.
    sheet("2025-01-01", 1),
    sheet("2026-11-20", 1500),
    sheet("2026-11-21", 1800),
  ];
  const widgets = [
    { id: "h", type: "health_check" },
    { id: "r", type: "runway" },
    { id: "g", type: "revenue_growth" },
    { id: "c", type: "cash_flow" },
    { id: "o", type: "operating_profit" },
    { id: "m", type: "cash_on_hand" },
  ];

  it("works out runway, growth and margin from complete months only", async () => {
    const { supabase } = fakeSupabase({}, { snapshots });
    const data = await loadDashboardData(supabase, TENANT, config(widgets), RANGE, undefined, NOW);
    // Burn: the average of the last three complete months' operating cash, $300.
    expect(data.r).toMatchObject({
      type: "runway",
      cash: 180000,
      asOf: "2026-11-21",
      burn: { cents: 30000, source: "cash_flow", months: ["2026-08", "2026-09", "2026-10"] },
      months: 6,
      standing: "watch",
      accounts: [{ name: "Checking", cents: 180000 }],
    });
    expect(data.m).toMatchObject({ type: "cash_on_hand", cash: 1800 });
    const growth = data.g;
    if (growth.type !== "revenue_growth") throw new Error(growth.type);
    expect(growth.growth).toBeCloseTo(0.1);
    expect(growth.standing).toBe("good");
    expect(growth.points.map((p) => p.key)).toEqual([
      "2026-05-01",
      "2026-06-01",
      "2026-07-01",
      "2026-08-01",
      "2026-09-01",
      "2026-10-01",
    ]);
    const health = data.h;
    if (health.type !== "health_check") throw new Error(health.type);
    expect(health.through).toBe("2026-10");
    expect(health.partial).toBe("2026-11");
    expect(health.margin?.gross).toBeCloseTo(0.7);
    expect(health.runway).toMatchObject({ months: 6, standing: "watch" });
  });

  it("charts cash flow and operating profit for the page's months", async () => {
    const { supabase } = fakeSupabase({}, { snapshots });
    const lastMonth = resolveRange("last_month", NOW, TENANT.timezone);
    const data = await loadDashboardData(
      supabase,
      TENANT,
      config(widgets),
      lastMonth,
      undefined,
      NOW,
    );
    expect(data.c).toMatchObject({
      type: "cash_flow",
      points: [{ key: "2026-10-01", value: -400 }],
      months: [{ key: "2026-10", operating: -40000, net: -40000 }],
    });
    expect(data.o).toMatchObject({
      type: "operating_profit",
      revenue: 110000,
      profit: 110000 - 33000 - 50000,
      otherIncome: 0,
      otherExpenses: 1000,
      partial: null,
    });
  });

  it("says so when the books' history doesn't have other income yet", async () => {
    const { supabase } = fakeSupabase({}, { snapshots });
    const data = await loadDashboardData(supabase, TENANT, config(widgets), RANGE, undefined, NOW);
    // June and July were stored before other income was read.
    expect(data.o).toMatchObject({ otherIncome: null, partial: "2026-11" });
  });

  it("follows the workspace's own thresholds", async () => {
    const { supabase } = fakeSupabase(
      {},
      {
        snapshots,
        configs: { health: { version: 1, runway_good_months: 4, runway_watch_months: 2 } },
      },
    );
    const data = await loadDashboardData(supabase, TENANT, config(widgets), RANGE, undefined, NOW);
    expect(data.r).toMatchObject({ months: 6, standing: "good" });
  });

  it("adds the two debt tiles and their notes only where the database hands over debts", async () => {
    // What an owner or admin is handed.
    const owner = fakeSupabase(
      {
        money_debt_current: () => [
          { debt_id: "d1", balance_cents: 330000, as_of: "2026-11-20", source: "books" },
        ],
      },
      {
        snapshots,
        tables: {
          money_debts: [
            {
              id: "d1",
              name: "Card",
              kind: "card",
              plan: "pool",
              status: "active",
              rate_bp: 1999,
              minimum_cents: 5000,
              payment_cents: 10000,
              revolving_bp: null,
              due_day: null,
              priority: 1,
              opening_cents: null,
              books_account: null,
              note: null,
            },
          ],
        },
      },
    );
    const data = await loadDashboardData(
      owner.supabase,
      TENANT,
      config(widgets),
      RANGE,
      undefined,
      NOW,
    );
    const health = data.h;
    if (health.type !== "health_check") throw new Error(health.type);
    // 3,300.00 owed on 6,300.00 of revenue over the complete months.
    expect(health.debt?.owed).toBe(330000);
    expect(health.debt?.toRevenue?.share).toBeCloseTo(330000 / 630000);
    expect(health.debt?.monthly).toBe(10000);
    expect(health.notes.some((n) => n.key.startsWith("debt-"))).toBe(true);

    // Everyone else: the database hands over no debts, so nothing about debt appears.
    const member = fakeSupabase({}, { snapshots });
    const theirs = await loadDashboardData(
      member.supabase,
      TENANT,
      config(widgets),
      RANGE,
      undefined,
      NOW,
    );
    const memberHealth = theirs.h;
    if (memberHealth.type !== "health_check") throw new Error(memberHealth.type);
    expect(memberHealth.debt).toBeNull();
    expect(memberHealth.notes.some((n) => n.key.startsWith("debt-"))).toBe(false);
    const withoutDebt = { ...memberHealth, debt: undefined };
    expect({ ...health, debt: undefined, notes: memberHealth.notes }).toEqual(withoutDebt);
  });

  it("asks for the books when there are none", async () => {
    const { supabase } = fakeSupabase({});
    const data = await loadDashboardData(supabase, TENANT, config(widgets), RANGE, undefined, NOW);
    for (const id of ["h", "r", "g", "c", "o", "m"]) {
      expect(data[id]).toEqual({ type: "empty", needs: "quickbooks" });
    }
  });
});

describe("the month so far, the books' summary and shipping", () => {
  it("runs this month on to its end against last month's running costs", async () => {
    const { supabase, calls } = fakeSupabase(
      {
        dashboard_sales_by_period: (call) =>
          call.args.p_from === "2026-10-01T04:00:00.000Z"
            ? [
                {
                  period: "2026-10-01",
                  order_count: 5,
                  net_sales: "800.00",
                  cost: 0,
                  costed_sales: 0,
                },
              ]
            : [
                {
                  period: "2026-11-01",
                  order_count: 7,
                  net_sales: "1000.00",
                  cost: 0,
                  costed_sales: 0,
                },
              ],
      },
      {
        snapshots: [
          {
            kind: "profit_and_loss",
            period_start: "2026-10-01",
            data: { income: 900, expenses: 1500 },
          },
        ],
      },
    );
    const data = await loadDashboardData(
      supabase,
      TENANT,
      config([{ id: "k", type: "key_figures" }]),
      resolveRange("this_month", NOW, TENANT.timezone),
      undefined,
      NOW,
    );
    // Ten days in, 21 of 30: $1,000 so far runs on to $1,428.57.
    expect(data.k).toMatchObject({
      type: "key_figures",
      pace: { projected: 142857, target: 150000, onPace: false, short: 7143 },
      againstLastMonth: 0.25,
    });
    const last = calls.find((c) => c.args.p_from === "2026-10-01T04:00:00.000Z");
    expect(last?.args.p_to).toBe("2026-10-22T04:00:00.000Z");
  });

  it("adds up the books' months in range and asks Shipping for its margin", async () => {
    const { supabase } = fakeSupabase(
      {
        money_shipping_by_month: () => [
          { month: "2026-10-01", orders: 3, collected_cents: 3000, cost_cents: 2400, costed: 3 },
        ],
      },
      {
        snapshots: [
          {
            kind: "profit_and_loss",
            period_start: "2026-10-01",
            data: { income: 900, cogs: 100, expenses: 500, gross_profit: 800, net_income: 300.25 },
          },
          {
            kind: "balance_sheet",
            period_start: "2026-11-20",
            data: { cash: 1, total_assets: 5000 },
          },
        ],
      },
    );
    const data = await loadDashboardData(
      supabase,
      TENANT,
      config([
        { id: "b", type: "books_summary" },
        { id: "s", type: "shipping_margin" },
      ]),
      RANGE,
      undefined,
      NOW,
    );
    expect(data.b).toMatchObject({
      type: "books_summary",
      grossProfit: 80000,
      netIncome: 30025,
      totalAssets: 500000,
      assetsAsOf: "2026-11-20",
    });
    const books = data.b as Extract<typeof data.b, { type: "books_summary" }>;
    expect(books.costs.find((p) => p.key === "2026-10-01")?.value).toBe(600);
    expect(data.s).toMatchObject({ type: "shipping_margin", net: 600, share: 0.2, uncosted: 0 });
  });
});

describe("closed months from the books", () => {
  // Made-up figures: the shop sells in June, September, October and
  // November; the books have June to October.
  const settings = revenueSettingsSchema.parse({
    ...LINES,
    closed_months: "books",
    books: {
      invoices: true,
      other_income: true,
      accounts: [{ ref: "79", name: "Class income", choice: { line: "classes" } }],
    },
  });
  const salesRows = [
    { period: "2026-06-01", order_count: 1, net_sales: 100, cost: 0, costed_sales: 0 },
    { period: "2026-09-01", order_count: 3, net_sales: 300, cost: 0, costed_sales: 0 },
    { period: "2026-10-01", order_count: 4, net_sales: 400, cost: 0, costed_sales: 0 },
    { period: "2026-11-01", order_count: 2, net_sales: 250, cost: 0, costed_sales: 0 },
  ];
  const lineRows = [
    group({ period: "2026-06-01", revenue_cents: "10000" }),
    group({ period: "2026-09-01", revenue_cents: "20000" }),
    group({ period: "2026-09-01", workshop: true, revenue_cents: "10000" }),
    group({ period: "2026-10-01", revenue_cents: "30000" }),
    group({ period: "2026-10-01", workshop: true, revenue_cents: "10000" }),
    group({ period: "2026-11-01", revenue_cents: "25000" }),
  ];
  const pnl = (month: string, income: number, other?: number) => ({
    kind: "profit_and_loss",
    period_start: `${month}-01`,
    data: { income, ...(other === undefined ? {} : { other_income_cents: other }) },
  });
  const load = async (widgets: unknown[], revenue = settings) => {
    const { supabase } = fakeSupabase(
      {
        dashboard_sales_by_period: () => salesRows,
        money_line_revenue: () => lineRows,
        money_invoice_revenue: () => [
          { period: "2026-10-01", account_ref: "79", account: "Class income", cents: "5000" },
          { period: "2026-11-01", account_ref: "79", account: "Class income", cents: "700" },
        ],
      },
      {
        configs: { profit: { version: 1 } },
        snapshots: [
          pnl("2026-06", 999, 0),
          pnl("2026-07", 50, 0),
          pnl("2026-08", 60, 0),
          pnl("2026-09", 330.01, 100),
          pnl("2026-10", 500, 0),
        ],
      },
    );
    return loadDashboardData(supabase, TENANT, config(widgets), RANGE, revenue, NOW);
  };
  const ALL = [
    { id: "k", type: "key_figures" },
    { id: "s", type: "sales_over_time", grouping: "month" },
    { id: "l", type: "revenue_by_line" },
    { id: "t", type: "revenue_by_line_over_time", grouping: "month" },
    { id: "p", type: "profit_by_line" },
  ];

  it("takes complete months from the books, and the rest from the shop", async () => {
    const data = await load(ALL);
    // November is still going: the shop's. June to October: the books' income
    // (October's invoice is inside it).
    const sales = 999 + 50 + 60 + 330.01 + 500 + 250;
    const k = data.k as Extract<WidgetData, { type: "key_figures" }>;
    expect(k.sales).toBeCloseTo(sales, 6);
    // Beside: November's invoice and September's other income only.
    expect(k.fromBooks).toBe(700 + 100);
    expect(k.closedNote).toMatch(/Jun 2026 to Oct 2026 are from your books/);
    expect(k.closedNote).toMatch(/Nov 2026 so far/);

    const s = data.s as Extract<WidgetData, { type: "sales_over_time" }>;
    expect(s.points.map((p) => p.value)).toEqual([999, 50, 60, 330.01, 500, 250]);
    expect(s.total).toBeCloseTo(sales, 6);

    const l = data.l as Extract<WidgetData, { type: "revenue_by_line" }>;
    const lineSum = l.rows.reduce((a, r) => a + r.value, 0);
    // The range total is the months' sum and the lines' sum, with what the books add beside.
    expect(l.total).toBeCloseTo(sales + 7 + 1, 6);
    expect(lineSum).toBeCloseTo(l.total, 6);
    // July and August had no shop sales to share by: other revenue from the books.
    expect(l.rows.find((r) => r.name === "Other revenue")?.value).toBeCloseTo(110 + 1, 6);
    // October: the class invoice first, then 450 shared 3:1 by the shop's own split.
    // September: 330.01 shared 2:1.
    const classes = l.rows.find((r) => r.name === "Classes")?.value ?? 0;
    expect(classes).toBeCloseTo(50 + 112.5 + 110 + 7, 6);

    const t = data.t as Extract<WidgetData, { type: "revenue_by_line_over_time" }>;
    const overTime = t.series.reduce((a, line) => a + line.total, 0);
    // July and August's books income no line could take is its own series
    // beside the lines; only September's other income (with no line) is left out.
    expect(t.series.at(-1)).toMatchObject({ beside: true, total: 110 });
    expect(overTime).toBeCloseTo(lineSum - 1, 6);

    const p = data.p as Extract<WidgetData, { type: "profit_by_line" }>;
    const revenue = p.rows.reduce((a, r) => a + r.revenue, 0);
    expect(revenue).toBe(Math.round(lineSum * 100) - 11100);
    for (const source of p.sources) {
      const row = p.rows.find((r) => r.id === source.id);
      expect(source.shop + source.books + source.typed).toBe(row?.revenue);
    }
  });

  it("draws a range of books months by month, from the key figures' own table", async () => {
    // Last quarter (July to September), every month closed and in the books;
    // the charts are asked for by week and by the range's own grouping.
    const quarter = resolveRange("last_quarter", NOW, TENANT.timezone);
    expect(quarter.grouping).toBe("week");
    const { supabase } = fakeSupabase(
      {
        dashboard_sales_by_period: () => salesRows,
        money_line_revenue: () => lineRows,
        dashboard_sales_by_channel: () => [],
        dashboard_top_products: () => [],
        money_invoice_revenue: () => [],
      },
      {
        snapshots: [pnl("2026-07", 50, 0), pnl("2026-08", 60, 0), pnl("2026-09", 330.01, 0)],
      },
    );
    const data = await loadDashboardData(
      supabase,
      TENANT,
      config([
        { id: "k", type: "key_figures" },
        { id: "s", type: "sales_over_time", grouping: "week" },
        { id: "t", type: "revenue_by_line_over_time" },
        { id: "c", type: "sales_by_channel" },
        { id: "b", type: "top_products" },
      ]),
      quarter,
      revenueSettingsSchema.parse({ ...settings, books: { invoices: false, other_income: false } }),
      NOW,
    );
    const cents = (dollars: number) => Math.round(dollars * 100);
    const k = data.k as Extract<WidgetData, { type: "key_figures" }>;
    expect(cents(k.sales)).toBe(44001);
    expect(k.ordersFromShop).toBe(true);

    const s = data.s as Extract<WidgetData, { type: "sales_over_time" }>;
    expect(s.grouping).toBe("month");
    expect(s.points.map((p) => p.key)).toEqual(["2026-07-01", "2026-08-01", "2026-09-01"]);
    expect(cents(s.total)).toBe(cents(k.sales));
    expect(s.points.reduce((a, p) => a + cents(p.value ?? 0), 0)).toBe(cents(k.sales));
    expect(s.closedNote).toMatch(/Every month here is from your books/);
    expect(s.marker ?? null).toBeNull();
    expect(s.points.some((p) => /from your shop/.test(p.longLabel))).toBe(false);

    const t = data.t as Extract<WidgetData, { type: "revenue_by_line_over_time" }>;
    expect(t.grouping).toBe("month");
    // July and August had no shop sales to share by: beside the lines, so it all adds up.
    expect(t.series.map((line) => line.name)).toEqual([
      "Shop",
      "Classes",
      "Other revenue, from your books",
    ]);
    expect(t.series.reduce((a, line) => a + cents(line.total), 0)).toBe(cents(k.sales));
    for (const line of t.series) {
      expect(line.points.reduce((a, p) => a + cents(p.value ?? 0), 0)).toBe(cents(line.total));
    }

    // Shop-only tiles say so, with the shop's own total.
    expect(data.c).toMatchObject({ type: "sales_by_channel", fromShop: true, total: 0 });
    expect(data.b).toMatchObject({ type: "top_products", fromShop: true });
  });

  it("marks the month still on the shop's figure in a mixed range", async () => {
    const data = await load([
      { id: "k", type: "key_figures" },
      { id: "s", type: "sales_over_time", grouping: "week" },
      { id: "t", type: "revenue_by_line_over_time", grouping: "week" },
    ]);
    const k = data.k as Extract<WidgetData, { type: "key_figures" }>;
    const s = data.s as Extract<WidgetData, { type: "sales_over_time" }>;
    expect(s.grouping).toBe("month");
    expect(Math.round(s.total * 100)).toBe(Math.round(k.sales * 100));
    expect(s.marker).toEqual({ key: "2026-11-01", label: "So far, from your shop" });
    const november = s.points.find((p) => p.key === "2026-11-01");
    expect(november?.longLabel).toMatch(/\(so far, from your shop\)$/);
    expect(november?.value).toBe(250);
    expect(s.points.find((p) => p.key === "2026-10-01")?.longLabel).not.toMatch(/shop/);

    const t = data.t as Extract<WidgetData, { type: "revenue_by_line_over_time" }>;
    expect(t.grouping).toBe("month");
    for (const line of t.series) {
      expect(line.marker).toEqual(s.marker);
      expect(line.points.find((p) => p.key === "2026-11-01")?.longLabel).toMatch(/so far/);
    }
  });

  it("keeps the shop's own chart, and says so, for a range too short for a closed month", async () => {
    const thisMonth = resolveRange("this_month", NOW, TENANT.timezone);
    const { supabase } = fakeSupabase(
      { dashboard_sales_by_period: () => [], money_line_revenue: () => [] },
      { snapshots: [pnl("2026-10", 500, 0)] },
    );
    const data = await loadDashboardData(
      supabase,
      TENANT,
      config([
        { id: "k", type: "key_figures" },
        { id: "s", type: "sales_over_time" },
      ]),
      thisMonth,
      settings,
      NOW,
    );
    const s = data.s as Extract<WidgetData, { type: "sales_over_time" }>;
    expect(s.grouping).toBe("day");
    expect(s.closedNote).toMatch(/your shop's sales/);
    expect((data.k as Extract<WidgetData, { type: "key_figures" }>).ordersFromShop).toBe(false);
  });

  it("changes nothing while the setting is the shop's", async () => {
    const shopOnly = revenueSettingsSchema.parse({ ...settings, closed_months: "shop" });
    const data = await load(ALL, shopOnly);
    const k = data.k as Extract<WidgetData, { type: "key_figures" }>;
    expect(k.sales).toBe(1050);
    expect(k.closedNote).toBeNull();
  });
});
