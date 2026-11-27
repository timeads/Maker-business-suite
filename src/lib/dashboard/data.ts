import type { SupabaseClient } from "@supabase/supabase-js";
import { bookRevenue, bookRevenueTotal, type BookRevenue, type InvoiceGroup } from "./book-revenue";
import { formatMoney, formatPercent } from "./format";
import { BUDGET_KEY, parseBudgetSettings } from "./budget";
import { CUTTER_KEY, parseCutterSettings } from "./recurring";
import {
  HEALTH_KEY,
  bookMonthOf,
  cashMonthOf,
  healthCheck,
  parseHealthSettings,
  type Burn,
  type HealthNote,
  type Standing,
} from "./health";
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
  currentMonth,
  localDate,
  periodKeys,
  periodLabel,
  rangeMonths,
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
import { loadDebtSettings, loadDebts } from "./debt/data";
import { debtHealth, type DebtHealth } from "./debt/figures";

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
      /** Whole cents the books add beside the shop (paid invoices, other income), when counted. */
      fromBooks: number | null;
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
      /** What the books add, in whole cents, when the setting counts them. */
      books: BooksPart | null;
    }
  | {
      type: "revenue_by_line_over_time";
      figure: RevenueFigure;
      byClassDate: boolean;
      grouping: Grouping;
      /** One per line, in the order the lines are set up. */
      series: { id: string; name: string; points: Point[]; total: number }[];
      /** The books' invoices are in the series; other income only by month. */
      withBooks: boolean;
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
      /** Each line's revenue by where it came from, whole cents. */
      sources: { id: string; shop: number; books: number; typed: number }[];
      books: BooksPart | null;
    }
  | {
      type: "expenses_by_line";
      /** In whole cents. */
      rows: { id: string; name: string; direct: number; shared: number }[];
      unsorted: number;
      setAside: number;
      sharedUnsplit: number;
    }
  | {
      type: "health_check";
      /** The last complete month the figures run to, `YYYY-MM`. */
      through: string | null;
      partial: string | null;
      runway: { months: number | null; standing: Standing; burn: Burn } | null;
      growth: { value: number; standing: Standing; window: number } | null;
      margin: { gross: number; operating: number | null; standing: Standing } | null;
      concentration: { share: number; name: string; standing: Standing } | null;
      /** Lines are set up: a missing concentration means no revenue yet, not no lines. */
      hasLines: boolean;
      notes: HealthNote[];
      /**
       * The two debt tiles. Only ever set for owners and admins: the
       * database hands nobody else a debt, so for them there is nothing to
       * work these out from and the tiles are simply absent.
       */
      debt: Pick<DebtHealth, "owed" | "monthly" | "toRevenue" | "coverage"> | null;
    }
  | {
      type: "runway";
      /** In whole cents. */
      cash: number;
      asOf: string;
      accounts: { name: string; cents: number }[];
      burn: Burn | null;
      months: number | null;
      standing: Standing | null;
    }
  | {
      type: "revenue_growth";
      growth: number | null;
      standing: Standing | null;
      window: number;
      /** Whole cents a month. */
      recentAverage: number;
      priorAverage: number;
      points: Point[];
    }
  | {
      type: "cash_flow";
      points: Point[];
      /** One row per month in the range, whole cents. */
      months: {
        key: string;
        label: string;
        operating: number;
        investing: number;
        financing: number;
        net: number;
      }[];
    }
  | {
      type: "operating_profit";
      points: Point[];
      /** Whole cents over the range. */
      revenue: number;
      profit: number;
      margin: number | null;
      otherIncome: number | null;
      otherExpenses: number | null;
      partial: string | null;
    }
  /** Nothing to show yet, and what would fill it: a connection, or lines set up in Settings. */
  | { type: "empty"; needs: "shopify" | "quickbooks" | "lines" };

/** What the books add to revenue for a range, for the words beside the figures. */
export type BooksPart = {
  invoices: number;
  otherIncome: number;
  /** Other income with no line, shown beside the lines. */
  otherUnplaced: number;
  /** Paid invoices on accounts nobody has chosen for: counted nowhere yet. */
  waiting: number;
  otherUnknown: boolean;
};

const booksPart = (b: BookRevenue): BooksPart => ({
  invoices: [...b.invoicesByLine.values()].reduce((x, y) => x + y, 0),
  otherIncome: b.otherIncome,
  otherUnplaced: b.otherUnplaced,
  waiting: b.waiting,
  otherUnknown: b.otherUnknown,
});

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

/** One of Money's settings, parsed; its defaults when there is none or it doesn't parse. */
async function loadMoneySetting<T>(
  supabase: SupabaseClient,
  tenantId: string,
  key: string,
  parse: (body: unknown) => T,
  what: string,
): Promise<T> {
  const { data, error } = await supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", tenantId)
    .eq("module", DASHBOARD_MODULE)
    .eq("key", key)
    .maybeSingle();
  if (error) throw new Error(`Could not load the ${what} settings: ${error.message}`);
  return parse(data?.body);
}

/** The workspace's cash health thresholds (Settings → Money → Cash health), or the defaults. */
export const loadHealthSettings = (supabase: SupabaseClient, tenantId: string) =>
  loadMoneySetting(supabase, tenantId, HEALTH_KEY, parseHealthSettings, "cash health");

/** Settings → Money → Budget and break-even. */
export const loadBudgetSettings = (supabase: SupabaseClient, tenantId: string) =>
  loadMoneySetting(supabase, tenantId, BUDGET_KEY, parseBudgetSettings, "budget");

/** Settings → Money → Cost cutter. */
export const loadCutterSettings = (supabase: SupabaseClient, tenantId: string) =>
  loadMoneySetting(supabase, tenantId, CUTTER_KEY, parseCutterSettings, "cost cutter");

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
  tenant: { id: string; timezone: string; currency?: string },
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

  /** Paid invoices per period and income account, paged past Supabase's 1,000 rows. */
  const invoiceGroups = async (grouping: Grouping): Promise<InvoiceGroup[]> => {
    const rows: InvoiceGroup[] = [];
    for (let page = 0; page < GROUP_PAGES; page++) {
      const { data, error } = await supabase
        .rpc("money_invoice_revenue", {
          p_tenant_id: tenant.id,
          p_from: fromDay,
          p_to: toDay,
          p_grouping: grouping,
        })
        .range(page * GROUP_PAGE, page * GROUP_PAGE + GROUP_PAGE - 1);
      if (error) throw new Error(`Could not load invoices: ${error.message}`);
      const batch = (data as Record<string, unknown>[] | null) ?? [];
      for (const row of batch) {
        rows.push({
          period: String(row.period),
          account_ref: (row.account_ref as string | null) ?? null,
          account: (row.account as string | null) ?? null,
          cents: Math.round(num(row.cents)),
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
  // The books' revenue beside the shop's, when the setting counts it.
  const books = revenue.books;
  const wantsBooks =
    (books.invoices || books.other_income) &&
    needs("key_figures", "revenue_by_line", "revenue_by_line_over_time", "profit_by_line");
  const invoiceGroupings = new Set<Grouping>(
    wantsBooks && books.invoices
      ? [...lineGroupings, ...(needs("key_figures") ? (["month"] as const) : [])]
      : [],
  );
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

  // Cash health reads the books' complete months; concentration reads each
  // line's revenue over the same recent months.
  const wantsHealth = needs("health_check", "runway", "revenue_growth");
  const healthSettings = wantsHealth ? await loadHealthSettings(supabase, tenant.id) : null;
  const thisMonth = currentMonth(now, tenant.timezone);
  const monthStart = (month: string) => {
    const [year, m] = month.split("-").map(Number);
    return startOfLocalDay({ year, month: m, day: 1 }, tenant.timezone);
  };
  const recentLines =
    healthSettings && hasLines(revenue) && needs("health_check")
      ? (() => {
          const [year, m] = thisMonth.split("-").map(Number);
          const back = new Date(Date.UTC(year, m - 1 - healthSettings.compare_months, 1));
          return lineGroups({
            from: monthStart(
              `${back.getUTCFullYear()}-${String(back.getUTCMonth() + 1).padStart(2, "0")}`,
            ),
            to: monthStart(thisMonth),
            grouping: "month",
            datedOnly: false,
          });
        })()
      : Promise.resolve(null);

  // The books' monthly reports (a few years of months at most), and only the
  // latest of the reports kept by day, so a long history never crowds them out.
  const wantsMonths =
    (wantsBooks && books.other_income) ||
    needs(
      "gross_margin",
      "key_figures",
      "health_check",
      "runway",
      "revenue_growth",
      "cash_flow",
      "operating_profit",
    );
  const latestOf = (kind: string) =>
    supabase
      .from("financial_snapshots")
      .select("kind, period_start, data")
      .eq("tenant_id", tenant.id)
      .eq("kind", kind)
      .order("period_start", { ascending: false })
      .limit(1)
      .maybeSingle();

  // Debts for the two debt tiles and their notes: row-level security hands
  // them to owners and admins only. Allowed to fail: cash health stands
  // without them.
  const debtsFor = needs("health_check")
    ? Promise.all([loadDebts(supabase, tenant.id), loadDebtSettings(supabase, tenant.id)]).catch(
        (err) => {
          console.warn(`Debt tiles left out: ${err instanceof Error ? err.message : err}`);
          return null;
        },
      )
    : Promise.resolve(null);

  const [
    salesEntries,
    revenueEntries,
    lineEntries,
    deferredGroups,
    products,
    channels,
    monthly,
    balance,
    aging,
    anyOrder,
    expenseRows,
    costsByLine,
    anyExpense,
    healthLines,
    invoiceEntries,
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
    wantsMonths
      ? supabase
          .from("financial_snapshots")
          .select("kind, period_start, data")
          .eq("tenant_id", tenant.id)
          .in("kind", ["profit_and_loss", "cash_flow"])
          .order("period_start", { ascending: true })
          .limit(1000)
      : null,
    needs("cash_on_hand", "runway", "health_check") ? latestOf("balance_sheet") : null,
    needs("ar_aging") ? latestOf("ar_aging") : null,
    supabase.from("orders").select("id", { count: "exact", head: true }).eq("tenant_id", tenant.id),
    wantsProfit ? expenseGroups() : Promise.resolve([] as ExpenseGroup[]),
    profitSettings?.cost_of_goods === "shop_item_costs" ? itemCosts() : Promise.resolve(null),
    wantsProfit
      ? supabase
          .from("book_expenses")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenant.id)
      : Promise.resolve({ count: 0 }),
    recentLines,
    Promise.all([...invoiceGroupings].map(async (g) => [g, await invoiceGroups(g)] as const)),
  ]);
  for (const result of [products, channels, monthly, balance, aging]) {
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
  const snaps = ((monthly?.data as Snapshot[] | null) ?? []).map((s) => ({
    ...s,
    data: s.data ?? {},
  }));
  const asSnapshot = (row: unknown): Snapshot | null =>
    row ? { ...(row as Snapshot), data: (row as Snapshot).data ?? {} } : null;
  const latestSheet = asSnapshot(balance?.data);
  const latestAging = asSnapshot(aging?.data);
  // The calendar months the range touches, in the workspace's timezone.
  const inRange = new Set(rangeMonths(range, tenant.timezone));
  const profitMonths = snaps.filter(
    (s) => s.kind === "profit_and_loss" && inRange.has(s.period_start.slice(0, 7)),
  );
  const bookMonths = snaps.filter((s) => s.kind === "profit_and_loss").map(bookMonthOf);
  const cashMonths = snaps.filter((s) => s.kind === "cash_flow").map(cashMonthOf);
  const cashCents = latestSheet ? Math.round(num(latestSheet.data.cash) * 100) : null;
  const health =
    healthSettings && bookMonths.length > 0
      ? healthCheck(
          {
            books: bookMonths,
            cash: cashMonths,
            current: thisMonth,
            cashOnHand: cashCents,
            lines: healthLines
              ? totalsByLine(revenue, healthLines).map((line) => ({
                  name: line.name,
                  cents: line.cents,
                }))
              : null,
            settings: healthSettings,
          },
          (cents) => formatMoney(cents / 100, tenant.currency ?? "USD"),
        )
      : null;
  const debtBits = await debtsFor;
  const debt =
    health && healthSettings && debtBits && debtBits[0].length > 0
      ? debtHealth({
          debts: debtBits[0],
          complete: health.complete,
          compareMonths: healthSettings.compare_months,
          operatingMargin: health.margins.operating,
          settings: debtBits[1],
          money: (cents) => formatMoney(cents / 100, tenant.currency ?? "USD"),
        })
      : null;
  const monthPoint = (month: string, value: number | null): Point => ({
    key: `${month}-01`,
    label: periodLabel(`${month}-01`, "month"),
    longLabel: periodLabel(`${month}-01`, "month", true),
    value,
  });

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

  // Other income from the books' months the range touches; invoices per grouping.
  const otherIncomeMonths = profitMonths.map((s) => ({
    month: s.period_start.slice(0, 7),
    cents:
      typeof s.data.other_income_cents === "number" ? Math.round(s.data.other_income_cents) : null,
  }));
  const invoicesBy = new Map(invoiceEntries);
  const booksFor = (grouping: Grouping): BookRevenue | null =>
    wantsBooks ? bookRevenue(revenue, invoicesBy.get(grouping) ?? [], otherIncomeMonths) : null;

  let profit: ProfitSum | null = null;
  const profitBooks = wantsProfit ? booksFor(range.grouping) : null;
  const shopByLine = new Map(
    totalsByLine(revenue, lines.get(range.grouping) ?? []).map((line) => [line.id, line.cents]),
  );
  if (wantsProfit && profitSettings) {
    profit = profitByLine({
      lines: revenue.lines,
      revenue: new Map(
        revenue.lines.map((line) => [
          line.id,
          (shopByLine.get(line.id) ?? 0) + (profitBooks?.byLine.get(line.id) ?? 0),
        ]),
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
          fromBooks: (() => {
            const b = booksFor("month");
            return b ? bookRevenueTotal(b) : null;
          })(),
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
        const sheet = latestSheet;
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
        const b = booksFor(range.grouping);
        const totals = totalsByLine(revenue, lines.get(range.grouping) ?? []).map((line) => ({
          ...line,
          cents: line.cents + (b?.byLine.get(line.id) ?? 0),
        }));
        const other = b?.otherUnplaced ?? 0;
        const sum = totals.reduce((acc, line) => acc + line.cents, 0) + other;
        out[widget.id] = {
          type: "revenue_by_line",
          figure,
          byClassDate: revenue.by_class_date,
          total: sum / 100,
          books: b ? booksPart(b) : null,
          rows: [
            ...totals.map((line) => ({
              name: line.name,
              value: line.cents / 100,
              detail: [
                sum > 0 ? formatPercent(line.cents / sum) : null,
                line.isDefault ? "and anything no rule matched" : null,
              ]
                .filter(Boolean)
                .join(" "),
            })),
            ...(other !== 0
              ? [
                  {
                    name: "Other revenue",
                    value: other / 100,
                    detail: [sum > 0 ? formatPercent(other / sum) : null, "from your books"]
                      .filter(Boolean)
                      .join(" "),
                  },
                ]
              : []),
          ],
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
        const b = booksFor(grouping);
        // Other income is kept by month in the books, so it joins a chart by month only.
        const otherLine =
          b && grouping === "month" && books.other_income_line ? books.other_income_line : null;
        out[widget.id] = {
          type: "revenue_by_line_over_time",
          figure,
          byClassDate: revenue.by_class_date,
          grouping,
          withBooks: b !== null,
          series: seriesByLine(revenue, lines.get(grouping) ?? [], keys).map((line) => {
            for (const [period, cents] of b?.invoicesByPeriod.get(line.id) ?? []) {
              if (line.cents.has(period)) {
                line.cents.set(period, (line.cents.get(period) ?? 0) + cents);
              }
            }
            if (otherLine === line.id) {
              for (const month of otherIncomeMonths) {
                const key = `${month.month}-01`;
                if (month.cents !== null && line.cents.has(key)) {
                  line.cents.set(key, (line.cents.get(key) ?? 0) + month.cents);
                }
              }
            }
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
          sources: revenue.lines.map((line) => ({
            id: line.id,
            shop: shopByLine.get(line.id) ?? 0,
            books: profitBooks?.byLine.get(line.id) ?? 0,
            typed: 0,
          })),
          books: profitBooks ? booksPart(profitBooks) : null,
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
      case "health_check": {
        if (!health || !healthSettings) {
          out[widget.id] = { type: "empty", needs: "quickbooks" };
          break;
        }
        out[widget.id] = {
          type: "health_check",
          through: health.complete.at(-1)?.month ?? null,
          partial: health.partial,
          runway: health.runway && health.burn ? { ...health.runway, burn: health.burn } : null,
          growth:
            health.growth.growth !== null && health.growth.standing
              ? {
                  value: health.growth.growth,
                  standing: health.growth.standing,
                  window: healthSettings.compare_months,
                }
              : null,
          margin:
            health.margins.gross !== null && health.margins.standing
              ? {
                  gross: health.margins.gross,
                  operating: health.margins.operating,
                  standing: health.margins.standing,
                }
              : null,
          concentration: health.concentration,
          hasLines: hasLines(revenue),
          notes: [...health.notes, ...(debt?.notes ?? [])],
          debt: debt
            ? {
                owed: debt.owed,
                monthly: debt.monthly,
                toRevenue: debt.toRevenue,
                coverage: debt.coverage,
              }
            : null,
        };
        break;
      }
      case "runway": {
        if (!latestSheet || cashCents === null) {
          out[widget.id] = { type: "empty", needs: "quickbooks" };
          break;
        }
        const accounts = Array.isArray(latestSheet.data.bank_accounts)
          ? (latestSheet.data.bank_accounts as { name: unknown; cents: unknown }[])
              .filter((a) => typeof a.name === "string")
              .map((a) => ({ name: String(a.name), cents: Math.round(num(a.cents)) }))
          : [];
        out[widget.id] = {
          type: "runway",
          cash: cashCents,
          asOf: latestSheet.period_start,
          accounts,
          burn: health?.burn ?? null,
          months: health?.runway?.months ?? null,
          standing: health?.runway?.standing ?? null,
        };
        break;
      }
      case "revenue_growth": {
        if (!health || !healthSettings) {
          out[widget.id] = { type: "empty", needs: "quickbooks" };
          break;
        }
        const shown = health.complete.slice(-2 * healthSettings.compare_months);
        out[widget.id] = {
          type: "revenue_growth",
          growth: health.growth.growth,
          standing: health.growth.standing,
          window: healthSettings.compare_months,
          recentAverage: health.growth.recentAverage,
          priorAverage: health.growth.priorAverage,
          points: shown.map((m) => monthPoint(m.month, m.income / 100)),
        };
        break;
      }
      case "cash_flow": {
        const months = cashMonths.filter((m) => inRange.has(m.month));
        if (cashMonths.length === 0) {
          out[widget.id] = { type: "empty", needs: "quickbooks" };
          break;
        }
        const byMonth = new Map(months.map((m) => [m.month, m]));
        const keys = [...inRange].sort();
        out[widget.id] = {
          type: "cash_flow",
          points: keys.map((month) => {
            const m = byMonth.get(month);
            return monthPoint(month, m ? m.netChange / 100 : null);
          }),
          months: keys
            .filter((month) => byMonth.has(month))
            .map((month) => {
              const m = byMonth.get(month)!;
              return {
                key: month,
                label: periodLabel(`${month}-01`, "month", true),
                operating: m.operating,
                investing: m.investing,
                financing: m.financing,
                net: m.netChange,
              };
            }),
        };
        break;
      }
      case "operating_profit": {
        if (bookMonths.length === 0) {
          out[widget.id] = { type: "empty", needs: "quickbooks" };
          break;
        }
        const months = bookMonths.filter((m) => inRange.has(m.month));
        const byMonth = new Map(months.map((m) => [m.month, m]));
        const revenueCents = months.reduce((sum, m) => sum + m.income, 0);
        const profitCents = months.reduce((sum, m) => sum + (m.income - m.cogs - m.expenses), 0);
        const known = (pick: (m: (typeof months)[number]) => number | null) =>
          months.length > 0 && months.every((m) => pick(m) !== null)
            ? months.reduce((sum, m) => sum + (pick(m) ?? 0), 0)
            : null;
        out[widget.id] = {
          type: "operating_profit",
          points: [...inRange].sort().map((month) => {
            const m = byMonth.get(month);
            return monthPoint(month, m ? (m.income - m.cogs - m.expenses) / 100 : null);
          }),
          revenue: revenueCents,
          profit: profitCents,
          margin: revenueCents > 0 ? profitCents / revenueCents : null,
          otherIncome: known((m) => m.otherIncome),
          otherExpenses: known((m) => m.otherExpenses),
          partial: byMonth.has(thisMonth) ? thisMonth : null,
        };
        break;
      }
      case "ar_aging": {
        const aging = latestAging;
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
