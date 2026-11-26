"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { loadRevenueSettings } from "@/lib/dashboard/data";
import {
  SUGGEST_LIMIT,
  askForSuggestions,
  tidySuggestions,
  type SuggestExpense,
} from "@/lib/dashboard/expense-suggest";
import {
  EXPENSES_KEY,
  EXPENSES_MODULE,
  actionColumns,
  actionSchema,
  decisionPayload,
  factsOfRow,
  parseExpenseSorting,
} from "@/lib/dashboard/expenses";
import { getEntitlements } from "@/lib/entitlements";
import { getAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

export type ExpenseActionState = { error?: string; message?: string };

const ids = z.array(z.string().uuid()).min(1).max(500);
const choiceSchema = z.union([actionSchema, z.object({ sort: z.literal("none") })]);

/** Owners and admins, on a plan that can still change things. */
async function sortContext(slug: string) {
  const user = await requireUser(`/w/${slug}/dashboard/expenses`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx || !canManage(ctx.role)) {
    return { error: "Only owners and admins can sort expenses." } as const;
  }
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.canWrite || !entitlements.can("module.dashboard")) {
    return { error: "Your plan doesn't include changing Money right now." } as const;
  }
  const supabase = await createClient();
  return { tenant: ctx.tenant, supabase, entitlements } as const;
}

const refresh = (slug: string) => revalidatePath(`/w/${slug}/dashboard`, "layout");

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * A person's choice for the ticked expenses: a line, a split, shared, set
 * aside, or back in the inbox. No rule or later sync changes it.
 */
export async function sortExpenses(
  slug: string,
  expenseIds: string[],
  choice: unknown,
): Promise<ExpenseActionState> {
  const ctx = await sortContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  const picked = ids.safeParse(expenseIds);
  const how = choiceSchema.safeParse(choice);
  if (!picked.success) return { error: "Tick between 1 and 500 expenses first." };
  if (!how.success) {
    return { error: how.error.issues[0]?.message ?? "Choose where these go." };
  }
  const columns =
    how.data.sort === "none" ? { sort: "none", line: null, split: null } : actionColumns(how.data);
  const { data, error } = await ctx.supabase.rpc("sort_book_expenses", {
    p_tenant_id: ctx.tenant.id,
    p_ids: picked.data,
    p_sort: columns.sort,
    p_line: columns.line,
    p_split: columns.split,
  });
  if (error) {
    return {
      error: error.message.includes("sorted")
        ? "That line or split isn't one of yours any more. Reload the page and try again."
        : "We couldn't save that. Try again in a moment.",
    };
  }
  refresh(slug);
  const n = Number(data ?? 0);
  return {
    message:
      how.data.sort === "none"
        ? `${plural(n, "expense is", "expenses are")} back in the inbox. Your rules will leave ${n === 1 ? "it" : "them"} alone.`
        : `Sorted ${plural(n, "expense", "expenses")}.`,
  };
}

/** Rows read for the rules at most, a thousand at a time. */
const RULE_PAGE = 1000;
const RULE_PAGES = 10;

/**
 * "Apply my rules to what's waiting": the workspace's payee defaults and
 * rules, run over every expense nobody has sorted (and nobody put back).
 */
export async function applyRulesToWaiting(slug: string): Promise<ExpenseActionState> {
  const ctx = await sortContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  const [revenue, config] = await Promise.all([
    loadRevenueSettings(ctx.supabase, ctx.tenant.id),
    ctx.supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", ctx.tenant.id)
      .eq("module", EXPENSES_MODULE)
      .eq("key", EXPENSES_KEY)
      .maybeSingle(),
  ]);
  if (config.error) return { error: "We couldn't read your rules. Try again in a moment." };
  const settings = parseExpenseSorting(config.data?.body);
  if (settings.vendors.length === 0 && settings.rules.length === 0) {
    return { error: "You haven't set any payee defaults or rules yet." };
  }
  const lineIds = new Set(revenue.lines.map((line) => line.id));
  const decisions: Record<string, unknown>[] = [];
  for (let page = 0; page < RULE_PAGES; page++) {
    const { data, error } = await ctx.supabase
      .from("book_expenses")
      .select("id, payee, account, memo, lines")
      .eq("tenant_id", ctx.tenant.id)
      .is("sort", null)
      .is("removed_at", null)
      .eq("is_move", false)
      .eq("rules_off", false)
      .order("txn_date", { ascending: false })
      .order("id")
      .range(page * RULE_PAGE, page * RULE_PAGE + RULE_PAGE - 1);
    if (error) return { error: "We couldn't read what's waiting. Try again in a moment." };
    const rows = (data ?? []) as {
      id: string;
      payee: string | null;
      account: string | null;
      memo: string;
      lines: { account: string | null; description: string }[];
    }[];
    for (const row of rows) {
      const payload = decisionPayload(settings, lineIds, factsOfRow(row));
      if (payload.auto || payload.suggest) decisions.push({ id: row.id, ...payload });
    }
    if (rows.length < RULE_PAGE) break;
  }
  let sorted = 0;
  let suggested = 0;
  for (let start = 0; start < decisions.length; start += 500) {
    const { data, error } = await ctx.supabase.rpc("note_expense_decisions", {
      p_tenant_id: ctx.tenant.id,
      p_rows: decisions.slice(start, start + 500),
    });
    if (error) return { error: "We couldn't apply your rules. Try again in a moment." };
    const counts = (data ?? {}) as { sorted?: number; suggested?: number };
    sorted += Number(counts.sorted ?? 0);
    suggested += Number(counts.suggested ?? 0);
  }
  refresh(slug);
  if (sorted === 0 && suggested === 0) {
    return { message: "None of your rules matched anything waiting to be sorted." };
  }
  return {
    message: [
      sorted ? `Sorted ${plural(sorted, "expense", "expenses")}` : null,
      suggested ? `suggested a line for ${plural(suggested, "more", "more")}` : null,
    ]
      .filter(Boolean)
      .join(", ")
      .replace(/^./, (c) => c.toUpperCase())
      .concat("."),
  };
}

/**
 * "Suggest lines for these": Claude suggests a line for each of the ticked
 * (or shown) expenses still to sort. Only ever a suggestion: a person
 * presses "Use this" to apply one. Counted against the plan's AI allowance.
 */
export async function suggestLines(
  slug: string,
  expenseIds: string[],
): Promise<ExpenseActionState> {
  const ctx = await sortContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!process.env.ANTHROPIC_API_KEY || !process.env.SUPABASE_SECRET_KEY) {
    return { error: "Suggestions from Claude aren't switched on for this environment yet." };
  }
  const picked = ids.safeParse(expenseIds.slice(0, SUGGEST_LIMIT));
  if (!picked.success) return { error: "There's nothing here to suggest a line for." };
  const revenue = await loadRevenueSettings(ctx.supabase, ctx.tenant.id);
  if (revenue.lines.length === 0) return { error: "Set up your business lines first." };

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const [{ data: usage }, { data, error }] = await Promise.all([
    ctx.supabase
      .from("usage_events")
      .select("quantity")
      .eq("tenant_id", ctx.tenant.id)
      .eq("type", "ai_tokens")
      .gte("occurred_at", monthStart.toISOString()),
    ctx.supabase
      .from("book_expenses")
      .select("id, txn_date, amount_cents, payee, account, memo, lines")
      .eq("tenant_id", ctx.tenant.id)
      .in("id", picked.data)
      .is("sort", null)
      .is("removed_at", null)
      .eq("is_move", false)
      .order("txn_date", { ascending: false }),
  ]);
  if (error) return { error: "We couldn't read those expenses. Try again in a moment." };
  const used = (usage ?? []).reduce((sum, row) => sum + Number(row.quantity), 0);
  if (used >= ctx.entitlements.limit("ai_credits")) {
    return {
      error:
        "You've used this month's AI allowance. It resets next month, or you can upgrade your plan for more.",
    };
  }
  const expenses: SuggestExpense[] = (
    (data ?? []) as {
      id: string;
      txn_date: string;
      amount_cents: number | string;
      payee: string | null;
      account: string | null;
      memo: string;
      lines: { account: string | null; description: string }[];
    }[]
  ).map((row) => ({
    id: row.id,
    date: row.txn_date,
    amount_cents: Number(row.amount_cents),
    payee: row.payee,
    account: row.account,
    memo: row.memo,
    lines: Array.isArray(row.lines) ? row.lines : [],
  }));
  if (expenses.length === 0) return { error: "Those are all sorted already." };

  try {
    const result = await askForSuggestions(revenue.lines, expenses, ctx.tenant.currency);
    const { error: usageError } = await getAdminClient().rpc("record_usage", {
      p_tenant_id: ctx.tenant.id,
      p_type: "ai_tokens",
      p_quantity: result.tokens,
    });
    if (usageError) console.error(`Could not record AI usage: ${usageError.message}`);
    if (!result.ok) return { error: "Claude couldn't suggest lines for these. Try a few others." };
    const suggestions = tidySuggestions(
      result.answer,
      expenses.map((e) => e.id),
      revenue.lines.map((line) => line.id),
    );
    if (suggestions.size === 0) {
      return { message: "Claude wasn't sure about any of these. They're yours to sort." };
    }
    const rows = [...suggestions].map(([id, suggestion]) => ({
      id,
      suggest: {
        ...actionColumns(suggestion.action),
        source: "ai",
        sure: suggestion.sure,
        reason: suggestion.reason,
      },
    }));
    const { error: saveError } = await ctx.supabase.rpc("note_expense_decisions", {
      p_tenant_id: ctx.tenant.id,
      p_rows: rows,
    });
    if (saveError) return { error: "We couldn't keep those suggestions. Try again in a moment." };
    refresh(slug);
    return {
      message: `Claude suggested a line for ${plural(suggestions.size, "expense", "expenses")}. Nothing is sorted until you press "Use this".`,
    };
  } catch (err) {
    console.error(`Expense suggestions failed: ${err instanceof Error ? err.message : "unknown"}`);
    return { error: "Claude isn't answering right now. Try again in a minute." };
  }
}
