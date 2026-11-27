import type { SupabaseClient } from "@supabase/supabase-js";
import { addMonths } from "./budget";
import { loadBudgetView } from "./budget-data";
import { loadDashboardData, loadRevenueSettings, type WidgetData } from "./data";
import { loadDebtView } from "./debt/data";
import { bookMonthOf } from "./health";
import { DECISION_WORDS } from "./recurring";
import { loadRecurringCharges } from "./recurring-data";
import { periodLabel, startOfLocalDay } from "./range";
import { dashboardSchema } from "./schema";
import type { SummaryInput } from "./summary";

/**
 * The figures the monthly summary is written from, for one complete month,
 * as the signed-in owner or admin (row-level security applies). Every
 * figure comes from the loaders the pages use, so the summary says what the
 * pages say: revenue and lines through `loadDashboardData` (closed months
 * from the books when that setting is on), accounts through the budget,
 * recurring charges through the cost cutter, debts through the payoff plan.
 * Parts that can't be read are left out, never guessed.
 */
export async function loadSummaryInput(
  supabase: SupabaseClient,
  tenant: { id: string; timezone: string; currency?: string },
  month: string,
  now: Date = new Date(),
): Promise<SummaryInput> {
  const startOf = (m: string) => {
    const [year, mm] = m.split("-").map(Number);
    return startOfLocalDay({ year, month: mm, day: 1 }, tenant.timezone);
  };
  const first = addMonths(month, -12);
  const revenue = await loadRevenueSettings(supabase, tenant.id);
  const layout = dashboardSchema.parse({
    version: 1,
    name: "Summary",
    widgets: [
      { id: "sales", type: "sales_over_time", grouping: "month" },
      { id: "lines", type: "revenue_by_line_over_time", grouping: "month" },
      { id: "runway", type: "runway" },
    ],
  });
  const soft = <T>(promise: Promise<T>): Promise<T | null> =>
    promise.catch((err) => {
      console.warn(`Summary figure left out: ${err instanceof Error ? err.message : err}`);
      return null;
    });

  const [data, pnl, budget, charges, debts] = await Promise.all([
    loadDashboardData(
      supabase,
      tenant,
      layout,
      { from: startOf(first), to: startOf(addMonths(month, 1)), grouping: "month" },
      revenue,
      now,
    ),
    supabase
      .from("financial_snapshots")
      .select("period_start, data")
      .eq("tenant_id", tenant.id)
      .eq("kind", "profit_and_loss")
      .gte("period_start", `${first}-01`)
      .lt("period_start", `${addMonths(month, 1)}-01`)
      .order("period_start")
      .limit(100),
    soft(loadBudgetView(supabase, tenant, { month, period: "month", subject: "account" }, now)),
    soft(loadRecurringCharges(supabase, tenant, now)),
    soft(loadDebtView(supabase, tenant, now)),
  ]);

  const key = `${month}-01`;
  const sales = data.sales as Extract<WidgetData, { type: "sales_over_time" }> | undefined;
  const at = (points: { key: string; value: number | null }[] | undefined, k: string) => {
    const value = points?.find((p) => p.key === k)?.value;
    return value === null || value === undefined ? null : Math.round(value * 100);
  };
  const monthRevenue = sales?.type === "sales_over_time" ? at(sales.points, key) : null;
  const before = [1, 2, 3].map((n) => at(sales?.points, `${addMonths(month, -n)}-01`));
  const known = before.filter((v): v is number => v !== null);
  const closedNote = sales?.closedNote ?? null;

  const lines = data.lines as
    Extract<WidgetData, { type: "revenue_by_line_over_time" }> | undefined;
  const months = (
    (pnl.data ?? []) as { period_start: string; data: Record<string, unknown> }[]
  ).map((row) => bookMonthOf({ period_start: row.period_start, data: row.data ?? {} }));
  const thisBooks = months.find((m) => m.month === month) ?? null;
  const priorBooks = months.filter((m) => m.month < month).slice(-12);
  const margin = (m: { income: number; cogs: number }) =>
    m.income > 0 ? (m.income - m.cogs) / m.income : null;
  const priorIncome = priorBooks.reduce((s, m) => s + m.income, 0);
  const runway = data.runway as WidgetData | undefined;

  return {
    month,
    monthWords: periodLabel(key, "month", true),
    revenue:
      monthRevenue === null
        ? null
        : {
            month: monthRevenue,
            previous: before[0],
            average:
              known.length > 0 ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : null,
            sameMonthLastYear: at(sales?.points, `${first}-01`),
            from: closedNote && revenue.closed_months === "books" && thisBooks ? "books" : "shop",
          },
    lines:
      lines?.type === "revenue_by_line_over_time"
        ? lines.series.map((line) => ({
            name: line.name,
            cents: at(line.points, key) ?? 0,
            previous: at(line.points, `${addMonths(month, -1)}-01`),
          }))
        : [],
    books: thisBooks
      ? {
          grossMargin: margin(thisBooks),
          grossMarginAverage:
            priorIncome > 0
              ? (priorIncome - priorBooks.reduce((s, m) => s + m.cogs, 0)) / priorIncome
              : null,
          netIncome: thisBooks.netIncome,
          expenses: thisBooks.expenses,
          expensesAverage:
            priorBooks.length > 0
              ? Math.round(
                  priorBooks.slice(-3).reduce((s, m) => s + m.expenses, 0) /
                    priorBooks.slice(-3).length,
                )
              : null,
        }
      : null,
    accounts: (budget?.rows ?? [])
      .filter((row) => !row.hidden && !row.debt && row.actual > 0)
      .map((row) => ({
        name: row.name === row.group || !row.group ? row.name : `${row.group}: ${row.name}`,
        actual: row.actual,
        average: row.average > 0 ? row.average : null,
        budget: row.budgeted > 0 ? row.budget : null,
      })),
    charges: (charges?.charges ?? [])
      .map((charge) => ({ charge, decision: charges?.decisions.get(charge.key)?.decision ?? null }))
      .filter(({ decision }) => decision !== "cancelled")
      .map(({ charge, decision }) => ({
        payee: charge.payee,
        monthly: charge.monthly,
        trend: charge.trend,
        decision: decision ? DECISION_WORDS[decision] : null,
      })),
    cash: runway?.type === "runway" ? { onHand: runway.cash, runwayMonths: runway.months } : null,
    debts:
      debts && debts.debts.length > 0
        ? {
            owed: debts.totals.owed,
            monthly: debts.totals.monthly,
            debtFree: debts.result.chosen.capped
              ? null
              : periodLabel(`${debts.result.chosen.payoffMonth}-01`, "month", true),
          }
        : null,
  };
}
