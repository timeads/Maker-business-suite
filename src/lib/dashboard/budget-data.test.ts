import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { loadBudgetView } from "./budget-data";

/**
 * A stand-in for the member's Supabase client: database functions answer
 * from `rpcs`, tables from `tables` (configs by key), and every call is kept.
 */
function fake(options: {
  rpcs?: Record<string, Record<string, unknown>[]>;
  tables?: Record<string, Record<string, unknown>[]>;
  configs?: Record<string, unknown>;
  expenses?: number;
}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc = (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    return {
      range: (from: number) =>
        Promise.resolve({ data: from === 0 ? (options.rpcs?.[fn] ?? []) : [], error: null }),
    };
  };
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    let first = 0;
    const result = () => {
      if (table === "book_expenses")
        return { count: options.expenses ?? 1, data: null, error: null };
      const rows = (options.tables?.[table] ?? []).filter((row) =>
        Object.entries(filters).every(([k, v]) => k === "tenant_id" || row[k] === v),
      );
      return { data: first === 0 ? rows : [], error: null };
    };
    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return chain;
      },
      gte: () => chain,
      lt: () => chain,
      order: () => chain,
      limit: () => chain,
      range: (start: number) => {
        first = start;
        return Promise.resolve(result());
      },
      maybeSingle: () => {
        const body = options.configs?.[String(filters.key)];
        return Promise.resolve({ data: body === undefined ? null : { body }, error: null });
      },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return chain;
  };
  return { supabase: { rpc, from } as unknown as SupabaseClient, calls };
}

const TENANT = { id: "t1", timezone: "America/New_York" };
const NOW = new Date("2026-11-21T17:00:00Z");
const pnl = (month: string, income: number, cogs: number) => ({
  kind: "profit_and_loss",
  period_start: `${month}-01`,
  data: { income, cogs, expenses: 0 },
});

describe("the budget page's figures", () => {
  it("reads the period and the months before it, and works out break-even", async () => {
    const { supabase, calls } = fake({
      rpcs: {
        money_account_totals: [
          { month: "2026-08-01", account: "Rent", cents: 100000 },
          { month: "2026-09-01", account: "Rent", cents: 100000 },
          { month: "2026-10-01", account: "Rent", cents: 100000 },
          { month: "2026-11-01", account: "Rent", cents: 50000 },
          { month: "2026-10-01", account: "Stock to resell", cents: 30000 },
        ],
      },
      tables: {
        money_budgets: [
          { subject: "account", subject_key: "Rent", month: "2026-11-01", amount_cents: 100000 },
          {
            subject: "account",
            subject_key: "Stock to resell",
            month: "2026-11-01",
            amount_cents: 40000,
          },
        ],
        financial_snapshots: [pnl("2026-09", 1000, 400), pnl("2026-10", 1500, 600)],
      },
      configs: { budget: { version: 1, variable_accounts: ["stock to resell"] } },
    });
    const view = await loadBudgetView(
      supabase,
      TENANT,
      { month: "2026-11", period: "month", subject: "account" },
      NOW,
    );
    expect(calls.find((c) => c.fn === "money_account_totals")?.args).toMatchObject({
      p_from: "2026-08-01",
      p_to: "2026-12-01",
    });
    const rent = view.rows.find((row) => row.key === "Rent")!;
    expect(rent).toMatchObject({
      average: 100000,
      budget: 100000,
      actual: 50000,
      standing: "under",
    });
    // Last month's revenue × the books' cost of goods share (40%).
    expect(view.rows.find((row) => row.key === "Stock to resell")?.average).toBe(60000);
    expect(view.cogs).toEqual({ share: 0.4, from: "books" });
    expect(view.breakEven).toEqual({ fixed: 100000, variable: 40000, share: 0.4, revenue: 166667 });
    expect(view.revenue).toMatchObject({ lastMonth: 150000, known: false });
  });

  it("shares a line's sorted and shared expenses out as profit by line does", async () => {
    const { supabase } = fake({
      rpcs: {
        money_expense_totals: [
          { period: "2026-11-01", sort: "line", line_id: "classes", split: null, cents: 5000 },
          { period: "2026-11-01", sort: "shared", line_id: null, split: null, cents: 1000 },
          { period: "2026-11-01", sort: null, line_id: null, split: null, cents: 777 },
        ],
      },
      tables: {
        money_budgets: [
          { subject: "line", subject_key: "classes", month: "2026-11-01", amount_cents: 6000 },
        ],
      },
      configs: {
        revenue: {
          version: 1,
          lines: [
            { id: "shop", name: "Shop" },
            { id: "classes", name: "Classes" },
          ],
          default_line: "shop",
          rules: [],
        },
        profit: { version: 1, shared_split: { shop: 50, classes: 50 } },
      },
    });
    const view = await loadBudgetView(
      supabase,
      TENANT,
      { month: "2026-11", period: "month", subject: "line" },
      NOW,
    );
    expect(view.subject).toBe("line");
    expect(view.breakEven).toBeNull();
    expect(view.rows.map((row) => [row.name, row.actual, row.budget])).toEqual([
      ["Classes", 5500, 6000],
      ["Shop", 500, 0],
    ]);
  });

  it("falls back to accounts when no lines are set up", async () => {
    const { supabase } = fake({});
    const view = await loadBudgetView(
      supabase,
      TENANT,
      { month: "2026-11", period: "quarter", subject: "line" },
      NOW,
    );
    expect(view.subject).toBe("account");
    expect(view.months).toEqual(["2026-10", "2026-11", "2026-12"]);
  });
});
