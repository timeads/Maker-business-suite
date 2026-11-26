import type { SupabaseClient } from "@supabase/supabase-js";
import { formatPercent } from "./format";
import {
  DEFAULT_REVENUE_SETTINGS,
  REVENUE_KEY,
  REVENUE_MODULE,
  factsOf,
  hasLines,
  lineFor,
  parseRevenueSettings,
  seriesByLine,
  totalsByLine,
  type LineGroup,
  type RevenueFigure,
  type RevenueSettings,
} from "./lines";
import {
  PROFIT_KEY,
  PROFIT_MODULE,
  monthParts,
  parseProfitSettings,
  profitByLine,
  type CogsSource,
  type ExpenseGroup,
  type LineProfit,
  type ProfitSettings,
  type ProfitSum,
} from "./profit";
import {
  localDate,
  periodKeys,
  periodLabel,
  startOfLocalDay,
  type Grouping,
  type ResolvedRange,
} from "./range";
import {
  DASHBOARD_KEY,
  DASHBOARD_MODULE,
  dashboardSchema,
  type DashboardConfig,
  type WidgetConfig,
} from "./schema";
import { DEFAULT_TEMPLATE, templateConfig, withLineWidgets } from "./templates";

export type Point = { key: string; label: string; longLabel: string; value: number | null };
export type RankedRow = { name: string; value: number; detail?: string };

export type WidgetData =
  | {
      type: "key_figures";
      figure: RevenueFigure;
      sales: number;
      orders: number;
      averageOrder: number | null;
      margin: number | null;
    }
  | {
      type: "sales_over_time";
      figure: RevenueFigure;
      points: Point[];
      total: number;
      grouping: Grouping;
    }
  | {
      type: "gross_margin";
      points: Point[];
      overall: number | null;
      source: "store" | "books";
      coverage: number | null;
    }
  | { type: "top_products"; rows: RankedRow[] }
  | { type: "sales_by_channel"; figure: RevenueFigure; rows: RankedRow[]; total: number }
  | { type: "cash_on_hand"; cash: number; asOf: string }
  | { type: "ar_aging"; rows: RankedRow[]; total: number; asOf: string }
  | {
      type: "revenue_by_line";
      figure: RevenueFigure;
      byClassDate: boolean;
      rows: RankedRow[];
      total: number;
    }
  | {
      type: "revenue_by_line_over_time";
      figure: RevenueFigure;
      byClassDate: boolean;
      grouping: Grouping;
      /** One per line, in the order the lines are set up. */
      series: { id: string; name: string; points: Point[]; total: number }[];
    }
  | {
      type: "deferred_revenue";
      figure: RevenueFigure;
      byClassDate: boolean;
      total: number;
      /** Places (seats) paid for. */
      places: number;
      rows: RankedRow[];
    }
  | {
      type: "profit_by_line";
      figure: RevenueFigure;
      byClassDate: boolean;
      cogs: CogsSource;
      /** In whole cents, each step of the sum. */
      rows: LineProfit[];
      profit: number;
      unsorted: number;
      setAside: number;
      sharedUnsplit: number;
      monthlyCosts: number;
    }
  | {
      type: "expenses_by_line";
      /** In whole cents. */
      rows: { id: string; name: string; direct: number; shared: number }[];
      unsorted: number;
      setAside: number;
      sharedUnsplit: number;
    }
  /** Nothing to show yet, and what would fill it: a connection, or lines set up in Settings. */
  | { type: "empty"; needs: "shopify" | "quickbooks" | "lines" };

export type LoadedDashboard = {
  config: DashboardConfig;
  /** saved: from the workspace's config. default: no config yet. invalid: the saved one didn't parse. */
  source: "saved" | "default" | "invalid";
};

/** The workspace's profit setting (Settings → Money → Profit by line), or nothing shared out yet. */
export async function loadProfitSettings(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<ProfitSettings> {
  const { data, error } = await supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", tenantId)
    .eq("module", PROFIT_MODULE)
    .eq("key", PROFIT_KEY)
    .maybeSingle();
  if (error) throw new Error(`Could not load the profit settings: ${error.message}`);
  return parseProfitSettings(data?.body);
}

/** A plain day, YYYY-MM-DD, as the books write it. */
const dayKey = (date: { year: number; month: number; day: number }) =>
  `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;

/** The workspace's revenue settings (Settings → Money), or today's behaviour when there are none. */
export async function loadRevenueSettings(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<RevenueSettings> {
  const { data, error } = await supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", tenantId)
    .eq("module", REVENUE_MODULE)
    .eq("key", REVENUE_KEY)
    .maybeSingle();
  if (error) throw new Error(`Could not load the revenue settings: ${error.message}`);
  return parseRevenueSettings(data?.body);
}

/**
 * The workspace's saved layout, or the standard one. A workspace that hasn't
 * chosen a layout and has its business lines set up gets the line widgets in
 * the standard one too; a saved layout is never changed.
 */
export async function loadDashboardConfig(
  supabase: SupabaseClient,
  tenantId: string,
  revenue: RevenueSettings = DEFAULT_REVENUE_SETTINGS,
): Promise<LoadedDashboard> {
  const standard = () => {
    const config = templateConfig(DEFAULT_TEMPLATE);
    return hasLines(revenue) ? withLineWidgets(config) : config;
  };
  const { data, error } = await supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", tenantId)
    .eq("module", DASHBOARD_MODULE)
    .eq("key", DASHBOARD_KEY)
    .maybeSingle();
  if (error) throw new Error(`Could not load the dashboard: ${error.message}`);
  if (!data) return { config: standard(), source: "default" };
  const parsed = dashboardSchema.safeParse(data.body);
  if (!parsed.success) return { config: standard(), source: "invalid" };
  return { config: parsed.data, source: "saved" };
}

type SalesRow = {
  period: string;
  order_count: number;
  net_sales: number;
  cost: number;
  costed_sales: number;
};
/** Sales under the workspace's revenue figure. */
type RevenueRow = { period: string; order_count: number; revenue: number };

/** Supabase hands back 1,000 rows at most; line groups are paged, up to this many pages. */
const GROUP_PAGE = 1000;
const GROUP_PAGES = 20;
/** How far ahead "paid for classes still to come" looks. */
const DEFERRED_YEARS = 5;
type Snapshot = { kind: string; period_start: string; data: Record<string, unknown> };

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Loads what every widget on the dashboard needs for one date range. All
 * queries run as the signed-in member, so row-level security applies.
 */
export async function loadDashboardData(
  supabase: SupabaseClient,
  tenant: { id: string; timezone: string },
  config: DashboardConfig,
  range: ResolvedRange,
  revenue: RevenueSettings = DEFAULT_REVENUE_SETTINGS,
  now: Date = new Date(),
): Promise<Record<string, WidgetData>> {
  const figure = revenue.figure;
  const window = {
    p_tenant_id: tenant.id,
    p_from: range.from.toISOString(),
    p_to: range.to.toISOString(),
  };
  const types = new Set(config.widgets.map((w) => w.type));
  const needs = (...wanted: WidgetConfig["type"][]) => wanted.some((t) => types.has(t));

  const salesFor = async (grouping: Grouping): Promise<SalesRow[]> => {
    const { data, error } = await supabase.rpc("dashboard_sales_by_period", {
      ...window,
      p_grouping: grouping,
      p_timezone: tenant.timezone,
    });
    if (error) throw new Error(`Could not load sales: ${error.message}`);
    return ((data as Record<string, unknown>[] | null) ?? []).map((row) => ({
      period: String(row.period),
      order_count: num(row.order_count),
      net_sales: num(row.net_sales),
      cost: num(row.cost),
      costed_sales: num(row.costed_sales),
    }));
  };

  // Order totals come from their own query; net sales from the earlier one,
  // so a workspace that never changes the setting sees exactly what it did.
  const revenueFor = async (grouping: Grouping): Promise<RevenueRow[]> => {
    if (figure === "net_sales") {
      return (await salesFor(grouping)).map((row) => ({
        period: row.period,
        order_count: row.order_count,
        revenue: row.net_sales,
      }));
    }
    const { data, error } = await supabase.rpc("money_sales_by_period", {
      ...window,
      p_grouping: grouping,
      p_timezone: tenant.timezone,
      p_figure: figure,
    });
    if (error) throw new Error(`Could not load sales: ${error.message}`);
    return ((data as Record<string, unknown>[] | null) ?? []).map((row) => ({
      period: String(row.period),
      order_count: num(row.order_count),
      revenue: num(row.revenue),
    }));
  };

  /** Revenue for every set of facts a line rule reads, paged past Supabase's 1,000 rows. */
  const lineGroups = async (args: {
    from: Date;
    to: Date;
    grouping: Grouping;
    datedOnly: boolean;
  }): Promise<LineGroup[]> => {
    const rows: LineGroup[] = [];
    for (let page = 0; page < GROUP_PAGES; page++) {
      const { data, error } = await supabase
        .rpc("money_line_revenue", {
          p_tenant_id: tenant.id,
          p_from: args.from.toISOString(),
          p_to: args.to.toISOString(),
          p_grouping: args.grouping,
          p_timezone: tenant.timezone,
          p_figure: figure,
          p_by_class_date: revenue.by_class_date,
          p_dated_only: args.datedOnly,
        })
        .range(page * GROUP_PAGE, page * GROUP_PAGE + GROUP_PAGE - 1);
      if (error) throw new Error(`Could not load revenue by line: ${error.message}`);
      const batch = (data as Record<string, unknown>[] | null) ?? [];
      for (const row of batch) {
        rows.push({
          period: String(row.period),
          order_tags: (row.order_tags as string[] | null) ?? null,
          product_external_id: (row.product_external_id as string | null) ?? null,
          product_tags: (row.product_tags as string[] | null) ?? null,
          product_type: (row.product_type as string | null) ?? null,
          workshop: row.workshop === true,
          dated: row.dated === true,
          revenue_cents: Math.round(num(row.revenue_cents)),
          units: Math.round(num(row.units)),
        });
      }
      if (batch.length < GROUP_PAGE) break;
    }
    return rows;
  };

  // Revenue under the page's figure, per grouping the widgets need.
  const revenueGroupings = new Set<Grouping>();
  if (needs("key_figures")) revenueGroupings.add("month");
  for (const widget of config.widgets) {
    if (widget.type === "sales_over_time") {
      revenueGroupings.add(widget.grouping === "auto" ? range.grouping : widget.grouping);
    }
  }
  // Net sales: margin is always worked out on them, whichever figure the page
  // shows, and under the net figure they are the revenue too.
  const groupings = new Set<Grouping>(figure === "net_sales" ? revenueGroupings : []);
  if (needs("key_figures", "gross_margin")) groupings.add("month");

  const lineGroupings = new Set<Grouping>();
  const wantsProfit = hasLines(revenue) && needs("profit_by_line", "expenses_by_line");
  if (hasLines(revenue)) {
    for (const widget of config.widgets) {
      if (widget.type === "revenue_by_line" || widget.type === "profit_by_line") {
        lineGroupings.add(range.grouping);
      }
      if (widget.type === "revenue_by_line_over_time") {
        lineGroupings.add(widget.grouping === "auto" ? range.grouping : widget.grouping);
      }
    }
  }
  const today = startOfLocalDay(localDate(now, tenant.timezone), tenant.timezone);
  const farAhead = new Date(today);
  farAhead.setUTCFullYear(farAhead.getUTCFullYear() + DEFERRED_YEARS);

  // Expenses and profit by line: the books' days in the workspace's timezone.
  const fromDay = dayKey(localDate(range.from, tenant.timezone));
  const toDay = dayKey(localDate(range.to, tenant.timezone));
  const profitSettings = wantsProfit ? await loadProfitSettings(supabase, tenant.id) : null;

  /** Sorted expenses added up per way of sorting, paged past Supabase's 1,000 rows. */
  const expenseGroups = async (): Promise<ExpenseGroup[]> => {
    const rows: ExpenseGroup[] = [];
    for (let page = 0; page < GROUP_PAGES; page++) {
      const { data, error } = await supabase
        .rpc("money_expense_totals", {
          p_tenant_id: tenant.id,
          p_from: fromDay,
          p_to: toDay,
          p_grouping: "month",
        })
        .range(page * GROUP_PAGE, page * GROUP_PAGE + GROUP_PAGE - 1);
      if (error) throw new Error(`Could not load expenses: ${error.message}`);
      const batch = (data as Record<string, unknown>[] | null) ?? [];
      for (const row of batch) {
        rows.push({
          sort: (row.sort as ExpenseGroup["sort"]) ?? null,
          line: (row.line_id as string | null) ?? null,
          split: (row.split as Record<string, number> | null) ?? null,
          cents: Math.round(num(row.cents)),
        });
      }
      if (batch.length < GROUP_PAGE) break;
    }
    return rows;
  };

  /** The shop's item costs per line, when the workspace counts cost of goods that way. */
  const itemCosts = async (): Promise<Map<string, number>> => {
    const out = new Map<string, number>();
    for (let page = 0; page < GROUP_PAGES; page++) {
      const { data, error } = await supabase
        .rpc("money_line_item_costs", {
          p_tenant_id: tenant.id,
          p_from: range.from.toISOString(),
          p_to: range.to.toISOString(),
        })
        .range(page * GROUP_PAGE, page * GROUP_PAGE + GROUP_PAGE - 1);
      if (error) throw new Error(`Could not load item costs: ${error.message}`);
      const batch = (data as Record<string, unknown>[] | null) ?? [];
      for (const row of batch) {
        const line = lineFor(
          revenue,
          factsOf({
            order_tags: (row.order_tags as string[] | null) ?? null,
            product_tags: (row.product_tags as string[] | null) ?? null,
            product_type: (row.product_type as string | null) ?? null,
            workshop: row.workshop === true,
          }),
        );
        if (line) out.set(line, (out.get(line) ?? 0) + Math.round(num(row.cost_cents)));
      }
      if (batch.length < GROUP_PAGE) break;
    }
    return out;
  };

  const [
    salesEntries,
    revenueEntries,
    lineEntries,
    deferredGroups,
    products,
    channels,
    snapshots,
    anyOrder,
    expenseRows,
    costsByLine,
    anyExpense,
  ] = await Promise.all([
    Promise.all([...groupings].map(async (g) => [g, await salesFor(g)] as const)),
    figure === "net_sales"
      ? Promise.resolve([] as (readonly [Grouping, RevenueRow[]])[])
      : Promise.all([...revenueGroupings].map(async (g) => [g, await revenueFor(g)] as const)),
    Promise.all(
      [...lineGroupings].map(
        async (g) =>
          [
            g,
            await lineGroups({ from: range.from, to: range.to, grouping: g, datedOnly: false }),
          ] as const,
      ),
    ),
    needs("deferred_revenue")
      ? lineGroups({ from: today, to: farAhead, grouping: "month", datedOnly: true })
      : Promise.resolve([] as LineGroup[]),
    needs("top_products")
      ? supabase.rpc("dashboard_top_products", {
          ...window,
          p_limit: Math.max(
            ...config.widgets.map((w) => (w.type === "top_products" ? w.limit : 0)),
            3,
          ),
        })
      : null,
    needs("sales_by_channel")
      ? figure === "net_sales"
        ? supabase.rpc("dashboard_sales_by_channel", window)
        : supabase.rpc("money_sales_by_channel", { ...window, p_figure: figure })
      : null,
    needs("gross_margin", "cash_on_hand", "ar_aging", "key_figures")
      ? supabase
          .from("financial_snapshots")
          .select("kind, period_start, data")
          .eq("tenant_id", tenant.id)
          .order("period_start", { ascending: true })
      : null,
    supabase.from("orders").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id),
    wantsProfit ? expenseGroups() : Promise.resolve([] as ExpenseGroup[]),
    profitSettings?.cost_of_goods === "shop_item_costs" ? itemCosts() : Promise.resolve(null),
    wantsProfit
      ? supabase
          .from("book_expenses")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenant.id)
      : Promise.resolve({ count: 0 }),
  ]);
  for (const result of [products, channels, snapshots]) {
    if (result?.error) throw new Error(`Could not load the dashboard: ${result.error.message}`);
  }

  const sales = new Map(salesEntries);
  const revenueRows = (grouping: Grouping): RevenueRow[] =>
    figure === "net_sales"
      ? (sales.get(grouping) ?? []).map((row) => ({
          period: row.period,
          order_count: row.order_count,
          revenue: row.net_sales,
        }))
      : (new Map(revenueEntries).get(grouping) ?? []);
  const lines = new Map(lineEntries);
  const hasOrders = (anyOrder.count ?? 0) > 0;
  const snaps = ((snapshots?.data as Snapshot[] | null) ?? []).map((s) => ({
    ...s,
    data: s.data ?? {},
  }));
  const latest = (kind: string) => snaps.filter((s) => s.kind === kind).at(-1) ?? null;
  const fromMonth = range.from.toISOString().slice(0, 7);
  const profitMonths = snaps.filter(
    (s) => s.kind === "profit_and_loss" && s.period_start.slice(0, 7) >= fromMonth,
  );

  const pointsFor = (grouping: Grouping, valueOf: (key: string) => number | null): Point[] =>
    periodKeys({ ...range, grouping }, tenant.timezone).map((key) => ({
      key,
      label: periodLabel(key, grouping),
      longLabel: periodLabel(key, grouping, true),
      value: valueOf(key),
    }));
  const series = (
    grouping: Grouping,
    valueOf: (row: SalesRow | undefined) => number | null,
  ): Point[] => {
    const byPeriod = new Map((sales.get(grouping) ?? []).map((row) => [row.period, row]));
    return pointsFor(grouping, (key) => valueOf(byPeriod.get(key)));
  };

  const storeMargin = (rows: SalesRow[]) => {
    const costed = rows.reduce((sum, r) => sum + r.costed_sales, 0);
    const cost = rows.reduce((sum, r) => sum + r.cost, 0);
    const all = rows.reduce((sum, r) => sum + r.net_sales, 0);
    return {
      overall: costed > 0 ? (costed - cost) / costed : null,
      coverage: all > 0 ? Math.min(1, costed / all) : null,
    };
  };
  const booksMargin = () => {
    const income = profitMonths.reduce((sum, s) => sum + num(s.data.income), 0);
    const gross = profitMonths.reduce((sum, s) => sum + num(s.data.gross_profit), 0);
    return income > 0 ? gross / income : null;
  };

  let profit: ProfitSum | null = null;
  if (wantsProfit && profitSettings) {
    profit = profitByLine({
      lines: revenue.lines,
      revenue: new Map(
        totalsByLine(revenue, lines.get(range.grouping) ?? []).map((line) => [line.id, line.cents]),
      ),
      cogs: costsByLine,
      expenses: expenseRows,
      settings: profitSettings,
      parts: monthParts(fromDay, toDay),
    });
  }
  const hasExpenses = (anyExpense.count ?? 0) > 0;

  const out: Record<string, WidgetData> = {};
  for (const widget of config.widgets) {
    switch (widget.type) {
      case "key_figures": {
        if (!hasOrders) {
          out[widget.id] = { type: "empty", needs: "shopify" };
          break;
        }
        const rows = sales.get("month") ?? [];
        const counted = revenueRows("month");
        const total = counted.reduce((sum, r) => sum + r.revenue, 0);
        const orders = counted.reduce((sum, r) => sum + r.order_count, 0);
        out[widget.id] = {
          type: "key_figures",
          figure,
          sales: total,
          orders,
          averageOrder: orders > 0 ? total / orders : null,
          margin: profitMonths.length > 0 ? booksMargin() : storeMargin(rows).overall,
        };
        break;
      }
      case "sales_over_time": {
        if (!hasOrders) {
          out[widget.id] = { type: "empty", needs: "shopify" };
          break;
        }
        const grouping = widget.grouping === "auto" ? range.grouping : widget.grouping;
        const byPeriod = new Map(revenueRows(grouping).map((row) => [row.period, row.revenue]));
        const points = pointsFor(grouping, (key) => byPeriod.get(key) ?? 0);
        out[widget.id] = {
          type: "sales_over_time",
          figure,
          points,
          grouping,
          total: points.reduce((sum, p) => sum + (p.value ?? 0), 0),
        };
        break;
      }
      case "gross_margin": {
        const useBooks =
          widget.source === "books" || (widget.source === "auto" && profitMonths.length > 0);
        if (useBooks) {
          if (profitMonths.length === 0) {
            out[widget.id] = { type: "empty", needs: "quickbooks" };
            break;
          }
          out[widget.id] = {
            type: "gross_margin",
            source: "books",
            coverage: null,
            overall: booksMargin(),
            points: profitMonths.map((s) => ({
              key: s.period_start,
              label: periodLabel(s.period_start, "month"),
              longLabel: periodLabel(s.period_start, "month", true),
              value: num(s.data.income) > 0 ? num(s.data.gross_profit) / num(s.data.income) : null,
            })),
          };
          break;
        }
        if (!hasOrders) {
          out[widget.id] = { type: "empty", needs: "shopify" };
          break;
        }
        const rows = sales.get("month") ?? [];
        out[widget.id] = {
          type: "gross_margin",
          source: "store",
          ...storeMargin(rows),
          points: series("month", (row) =>
            row && row.costed_sales > 0 ? (row.costed_sales - row.cost) / row.costed_sales : null,
          ),
        };
        break;
      }
      case "top_products": {
        const rows = ((products?.data as Record<string, unknown>[] | null) ?? []).slice(
          0,
          widget.limit,
        );
        out[widget.id] =
          rows.length === 0 && !hasOrders
            ? { type: "empty", needs: "shopify" }
            : {
                type: "top_products",
                rows: rows.map((row) => ({
                  name: String(row.title),
                  value: num(row.revenue),
                  detail: `${num(row.units)} sold`,
                })),
              };
        break;
      }
      case "sales_by_channel": {
        const rows = (channels?.data as Record<string, unknown>[] | null) ?? [];
        out[widget.id] =
          rows.length === 0 && !hasOrders
            ? { type: "empty", needs: "shopify" }
            : {
                type: "sales_by_channel",
                figure,
                total: rows.reduce((sum, row) => sum + num(row.net_sales ?? row.revenue), 0),
                rows: rows.map((row) => ({
                  name: String(row.channel),
                  value: num(row.net_sales ?? row.revenue),
                  detail: `${num(row.order_count)} ${num(row.order_count) === 1 ? "order" : "orders"}`,
                })),
              };
        break;
      }
      case "cash_on_hand": {
        const sheet = latest("balance_sheet");
        out[widget.id] = sheet
          ? { type: "cash_on_hand", cash: num(sheet.data.cash), asOf: sheet.period_start }
          : { type: "empty", needs: "quickbooks" };
        break;
      }
      case "revenue_by_line": {
        if (!hasLines(revenue)) {
          out[widget.id] = { type: "empty", needs: "lines" };
          break;
        }
        if (!hasOrders) {
          out[widget.id] = { type: "empty", needs: "shopify" };
          break;
        }
        const totals = totalsByLine(revenue, lines.get(range.grouping) ?? []);
        const sum = totals.reduce((acc, line) => acc + line.cents, 0);
        out[widget.id] = {
          type: "revenue_by_line",
          figure,
          byClassDate: revenue.by_class_date,
          total: sum / 100,
          rows: totals.map((line) => ({
            name: line.name,
            value: line.cents / 100,
            detail: [
              sum > 0 ? formatPercent(line.cents / sum) : null,
              line.isDefault ? "and anything no rule matched" : null,
            ]
              .filter(Boolean)
              .join(" "),
          })),
        };
        break;
      }
      case "revenue_by_line_over_time": {
        if (!hasLines(revenue)) {
          out[widget.id] = { type: "empty", needs: "lines" };
          break;
        }
        if (!hasOrders) {
          out[widget.id] = { type: "empty", needs: "shopify" };
          break;
        }
        const grouping = widget.grouping === "auto" ? range.grouping : widget.grouping;
        const keys = periodKeys({ ...range, grouping }, tenant.timezone);
        out[widget.id] = {
          type: "revenue_by_line_over_time",
          figure,
          byClassDate: revenue.by_class_date,
          grouping,
          series: seriesByLine(revenue, lines.get(grouping) ?? [], keys).map((line) => {
            const points = pointsFor(grouping, (key) => (line.cents.get(key) ?? 0) / 100);
            return {
              id: line.id,
              name: line.name,
              points,
              total: [...line.cents.values()].reduce((a, b) => a + b, 0) / 100,
            };
          }),
        };
        break;
      }
      case "deferred_revenue": {
        if (!hasOrders) {
          out[widget.id] = { type: "empty", needs: "shopify" };
          break;
        }
        const cents = deferredGroups.reduce((sum, g) => sum + g.revenue_cents, 0);
        out[widget.id] = {
          type: "deferred_revenue",
          figure,
          byClassDate: revenue.by_class_date,
          total: cents / 100,
          places: deferredGroups.reduce((sum, g) => sum + g.units, 0),
          rows: hasLines(revenue)
            ? totalsByLine(revenue, deferredGroups)
                .filter((line) => line.cents !== 0)
                .map((line) => ({
                  name: line.name,
                  value: line.cents / 100,
                  detail: `${line.units} ${line.units === 1 ? "place" : "places"}`,
                }))
            : [],
        };
        break;
      }
      case "profit_by_line": {
        if (!hasLines(revenue) || !profit || !profitSettings) {
          out[widget.id] = { type: "empty", needs: "lines" };
          break;
        }
        if (!hasExpenses && !hasOrders) {
          out[widget.id] = { type: "empty", needs: "quickbooks" };
          break;
        }
        out[widget.id] = {
          type: "profit_by_line",
          figure,
          byClassDate: revenue.by_class_date,
          cogs: profitSettings.cost_of_goods,
          rows: profit.rows,
          profit: profit.profit,
          unsorted: profit.unsorted,
          setAside: profit.setAside,
          sharedUnsplit: profit.sharedUnsplit,
          monthlyCosts: profitSettings.monthly_costs.length,
        };
        break;
      }
      case "expenses_by_line": {
        if (!hasLines(revenue) || !profit) {
          out[widget.id] = { type: "empty", needs: "lines" };
          break;
        }
        if (!hasExpenses) {
          out[widget.id] = { type: "empty", needs: "quickbooks" };
          break;
        }
        out[widget.id] = {
          type: "expenses_by_line",
          rows: profit.rows.map((row) => ({
            id: row.id,
            name: row.name,
            direct: row.direct,
            shared: row.shared,
          })),
          unsorted: profit.unsorted,
          setAside: profit.setAside,
          // Only the shared expenses here: monthly costs aren't in the books.
          sharedUnsplit: profit.sharedExpensesUnsplit,
        };
        break;
      }
      case "ar_aging": {
        const aging = latest("ar_aging");
        const buckets =
          (aging?.data.buckets as { label: string; amount: number }[] | undefined) ?? [];
        out[widget.id] = aging
          ? {
              type: "ar_aging",
              asOf: aging.period_start,
              total: num(aging.data.total),
              rows: buckets.map((b) => ({ name: agingLabel(b.label), value: num(b.amount) })),
            }
          : { type: "empty", needs: "quickbooks" };
        break;
      }
    }
  }
  return out;
}

/** "1 - 30" → "1–30 days late". */
export function agingLabel(label: string): string {
  const trimmed = label.trim();
  if (/^current$/i.test(trimmed)) return "Not due yet";
  const range = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
  if (range) return `${range[1]}–${range[2]} days late`;
  const over = trimmed.match(/^(\d+)\s+and\s+over$/i);
  if (over) return `${over[1]}+ days late`;
  return trimmed;
}
