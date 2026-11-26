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
  options: { orders?: number; config?: unknown } = {},
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
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      maybeSingle: () =>
        Promise.resolve({
          data: options.config === undefined ? null : { body: options.config },
          error: null,
        }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve(
          table === "orders"
            ? { count: options.orders ?? 1, data: null, error: null }
            : { data: [], error: null },
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
