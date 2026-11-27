import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { loadDashboardConfig, loadDashboardData } from "./data";
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
