import type { SupabaseClient } from "@supabase/supabase-js";
import {
  addMonths,
  averageMonths,
  breakEven,
  budgetRows,
  cogsShare,
  periodMonths,
  withExpectedVariable,
  type BreakEven,
  type BudgetRow,
  type BudgetSettings,
  type BudgetSubject,
  type MonthSpend,
  type Period,
} from "./budget";
import { loadBudgetSettings, loadProfitSettings, loadRevenueSettings } from "./data";
import { averageCents, bookMonthOf, completeMonths, type BookMonth } from "./health";
import { profitByLine, type ExpenseGroup } from "./profit";
import { currentMonth } from "./range";
import { loadDebtBook, loadDebtPayments } from "./debt/data";
import { debtBudgetRows } from "./debt/figures";

/** Supabase hands back 1,000 rows at most; these are paged. */
const PAGE = 1000;
const PAGES = 20;

const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export type BudgetView = {
  month: string;
  period: Period;
  subject: BudgetSubject;
  months: string[];
  /** The complete months the average covers (for a single month). */
  averageOver: string[];
  current: string;
  settings: BudgetSettings;
  lines: { id: string; name: string }[];
  rows: BudgetRow[];
  breakEven: BreakEven | null;
  cogs: { share: number; from: "setting" | "books" } | null;
  /** Whole cents, from the books' profit and loss. */
  revenue: {
    period: number;
    average: number;
    lastMonth: number;
    /** False when the books have none of the period's months yet. */
    known: boolean;
  };
  hasExpenses: boolean;
};

/**
 * Everything the budget page shows for one month or a longer period, as the
 * member (row-level security applies). Nothing derived is stored: the
 * variance, averages and break-even are worked out here.
 */
export async function loadBudgetView(
  supabase: SupabaseClient,
  tenant: { id: string; timezone: string },
  ask: { month: string; period: Period; subject: BudgetSubject },
  now: Date = new Date(),
): Promise<BudgetView> {
  const [settings, revenueSettings] = await Promise.all([
    loadBudgetSettings(supabase, tenant.id),
    loadRevenueSettings(supabase, tenant.id),
  ]);
  const subject = ask.subject === "line" && revenueSettings.lines.length > 0 ? "line" : "account";
  const months = periodMonths(ask.period, ask.month);
  const averageOver = averageMonths(months[0], settings.average_months);
  const fromMonth = averageOver[0] < months[0] ? averageOver[0] : months[0];
  const from = `${fromMonth}-01`;
  const to = `${addMonths(months.at(-1)!, 1)}-01`;

  const paged = async (fn: string, args: Record<string, unknown>) => {
    const rows: Record<string, unknown>[] = [];
    for (let page = 0; page < PAGES; page++) {
      const { data, error } = await supabase
        .rpc(fn, args)
        .range(page * PAGE, page * PAGE + PAGE - 1);
      if (error) throw new Error(`Could not load the budget: ${error.message}`);
      const batch = (data as Record<string, unknown>[] | null) ?? [];
      rows.push(...batch);
      if (batch.length < PAGE) break;
    }
    return rows;
  };

  const spendByLine = async (): Promise<MonthSpend[]> => {
    const profitSettings = await loadProfitSettings(supabase, tenant.id);
    const groups = await paged("money_expense_totals", {
      p_tenant_id: tenant.id,
      p_from: from,
      p_to: to,
      p_grouping: "month",
    });
    const byMonth = new Map<string, ExpenseGroup[]>();
    for (const row of groups) {
      const month = String(row.period).slice(0, 7);
      const list = byMonth.get(month) ?? [];
      list.push({
        sort: (row.sort as ExpenseGroup["sort"]) ?? null,
        line: (row.line_id as string | null) ?? null,
        split: (row.split as Record<string, number> | null) ?? null,
        cents: Math.round(num(row.cents)),
      });
      byMonth.set(month, list);
    }
    // Each month's sorted expenses shared out as profit by line does it:
    // a line's own, its share of a split, its share of what's shared. The
    // monthly costs the books don't hold are left out: this is the books.
    const spend: MonthSpend[] = [];
    for (const [month, expenses] of byMonth) {
      const sum = profitByLine({
        lines: revenueSettings.lines,
        revenue: new Map(),
        cogs: null,
        expenses,
        settings: { ...profitSettings, monthly_costs: [] },
        parts: [],
      });
      for (const row of sum.rows) {
        if (row.direct + row.shared !== 0) {
          spend.push({ month, key: row.id, cents: row.direct + row.shared });
        }
      }
    }
    return spend;
  };

  const spendByAccount = async (): Promise<MonthSpend[]> =>
    (await paged("money_account_totals", { p_tenant_id: tenant.id, p_from: from, p_to: to })).map(
      (row) => ({
        month: String(row.month).slice(0, 7),
        key: String(row.account),
        cents: Math.round(num(row.cents)),
      }),
    );

  const [spend, budgets, books, anyExpense] = await Promise.all([
    subject === "line" ? spendByLine() : spendByAccount(),
    (async () => {
      const rows: Record<string, unknown>[] = [];
      for (let page = 0; page < PAGES; page++) {
        const { data, error } = await supabase
          .from("money_budgets")
          .select("subject_key, month, amount_cents")
          .eq("tenant_id", tenant.id)
          .eq("subject", subject)
          .gte("month", `${months[0]}-01`)
          .lt("month", to)
          .order("month")
          .order("subject_key")
          .range(page * PAGE, page * PAGE + PAGE - 1);
        if (error) throw new Error(`Could not load the budget: ${error.message}`);
        rows.push(...((data as Record<string, unknown>[] | null) ?? []));
        if ((data ?? []).length < PAGE) break;
      }
      return rows;
    })(),
    supabase
      .from("financial_snapshots")
      .select("period_start, data")
      .eq("tenant_id", tenant.id)
      .eq("kind", "profit_and_loss")
      .order("period_start", { ascending: true })
      .limit(PAGE),
    supabase
      .from("book_expenses")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant.id),
  ]);
  if (books.error) throw new Error(`Could not load the books: ${books.error.message}`);

  const current = currentMonth(now, tenant.timezone);
  const bookMonths: BookMonth[] = (
    (books.data as { period_start: string; data: Record<string, unknown> }[] | null) ?? []
  ).map((row) => bookMonthOf({ period_start: row.period_start, data: row.data ?? {} }));
  const byMonth = new Map(bookMonths.map((m) => [m.month, m]));
  const income = (month: string) => byMonth.get(month)?.income ?? 0;
  const cogs = cogsShare(settings, completeMonths(bookMonths, current));

  let rows = budgetRows({
    subject,
    spend,
    budgets: budgets.map((row) => ({
      month: String(row.month).slice(0, 7),
      key: String(row.subject_key),
      cents: Math.round(num(row.amount_cents)),
    })),
    months,
    settings,
    names:
      subject === "line"
        ? new Map(revenueSettings.lines.map((line) => [line.id, line.name]))
        : undefined,
  });
  // Debt payments as rows (owners and admins only: row-level security hands
  // nobody else a debt, so for them there are none and nothing else changes).
  // Allowed to fail: the budget stands without them.
  if (subject === "account") {
    try {
      const book = await loadDebtBook(supabase, tenant.id);
      const debts = book.debts;
      if (debts.length > 0) {
        // A covered debt's payments are its plan's (one row for the plan).
        const paid = await loadDebtPayments(supabase, tenant.id, `${months[0]}-01`, to, book);
        rows = [
          ...rows,
          ...debtBudgetRows({ debts, paid, months, current, warnPct: settings.warn_pct }),
        ];
      }
    } catch (err) {
      console.warn(`Debt rows left out: ${err instanceof Error ? err.message : err}`);
    }
  }
  const lastMonth = income(addMonths(months[0], -1));
  if (subject === "account" && months.length === 1) {
    rows = withExpectedVariable(rows, lastMonth, cogs?.share ?? null);
  }

  return {
    month: ask.month,
    period: ask.period,
    subject,
    months,
    averageOver,
    current,
    settings,
    lines: revenueSettings.lines,
    rows,
    breakEven: subject === "account" ? breakEven(rows, cogs?.share ?? null) : null,
    cogs,
    revenue: {
      period: months.reduce((sum, month) => sum + income(month), 0),
      average:
        months.length > 1
          ? averageCents(months.map(income))
          : averageCents(averageOver.map(income)),
      lastMonth,
      known: months.some((month) => byMonth.has(month)),
    },
    hasExpenses: (anyExpense.count ?? 0) > 0,
  };
}
