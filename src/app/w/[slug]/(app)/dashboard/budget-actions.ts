"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { blanksFromAverage, isMonth } from "@/lib/dashboard/budget";
import { loadBudgetView } from "@/lib/dashboard/budget-data";
import { toCents } from "@/lib/dashboard/lines";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

export type BudgetActionState = { error?: string; message?: string };

/** Owners and admins, on a plan that can still change things. */
async function budgetContext(slug: string) {
  const user = await requireUser(`/w/${slug}/dashboard/budget`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx || !canManage(ctx.role)) {
    return { error: "Only owners and admins can change the budget." } as const;
  }
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.canWrite || !entitlements.can("module.dashboard")) {
    return { error: "Your plan doesn't include changing Money right now." } as const;
  }
  const supabase = await createClient();
  return { tenant: ctx.tenant, supabase } as const;
}

const refresh = (slug: string) => revalidatePath(`/w/${slug}/dashboard`, "layout");
const subjectSchema = z.enum(["account", "line"]);
const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

const entrySchema = z.object({
  key: z.string().trim().min(1).max(200),
  /** As typed: blank clears the budget. */
  amount: z.string().max(20),
});

/**
 * One month's budgets as typed into the table. A blank box clears that
 * budget; anything that isn't an amount is refused in words.
 */
export async function saveBudgets(
  slug: string,
  month: string,
  subject: string,
  entries: unknown,
): Promise<BudgetActionState> {
  const ctx = await budgetContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  const who = subjectSchema.safeParse(subject);
  const list = z.array(entrySchema).max(500).safeParse(entries);
  if (!isMonth(month) || !who.success || !list.success) {
    return { error: "Something in there doesn't look right. Reload the page and try again." };
  }
  const rows: { subject: string; key: string; amount_cents: number | null }[] = [];
  for (const entry of list.data) {
    const text = entry.amount.replace(/[,$\s]/g, "");
    if (text === "") {
      rows.push({ subject: who.data, key: entry.key, amount_cents: null });
      continue;
    }
    if (!/^\d+(\.\d{1,2})?$/.test(text)) {
      return { error: `“${entry.amount}” isn't an amount. Use numbers like 250 or 99.50.` };
    }
    rows.push({ subject: who.data, key: entry.key, amount_cents: toCents(text) });
  }
  const { error } = await ctx.supabase.rpc("set_money_budgets", {
    p_tenant_id: ctx.tenant.id,
    p_month: `${month}-01`,
    p_rows: rows,
  });
  if (error) {
    return {
      error: error.message.includes("accounts or lines")
        ? "One of those lines isn't set up any more. Reload the page and try again."
        : "We couldn't save that. Try again in a moment.",
    };
  }
  refresh(slug);
  return { message: "Budget saved." };
}

/** "Copy last month's": replaces this month's budgets for the same accounts or lines. */
export async function copyLastMonth(slug: string, month: string): Promise<BudgetActionState> {
  const ctx = await budgetContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!isMonth(month)) return { error: "Pick a month first." };
  const { data, error } = await ctx.supabase.rpc("copy_money_budget_month", {
    p_tenant_id: ctx.tenant.id,
    p_month: `${month}-01`,
  });
  if (error) return { error: "We couldn't copy that. Try again in a moment." };
  refresh(slug);
  const n = Number(data ?? 0);
  return n === 0
    ? { error: "Last month has no budget to copy yet." }
    : { message: `Copied ${plural(n, "budget", "budgets")} from last month.` };
}

/** "Fill the rest of the year": this month's budgets onto later months that have none. */
export async function fillYear(slug: string, month: string): Promise<BudgetActionState> {
  const ctx = await budgetContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!isMonth(month)) return { error: "Pick a month first." };
  const { data, error } = await ctx.supabase.rpc("fill_money_budget_year", {
    p_tenant_id: ctx.tenant.id,
    p_month: `${month}-01`,
  });
  if (error) return { error: "We couldn't fill the year. Try again in a moment." };
  refresh(slug);
  const n = Number(data ?? 0);
  return n === 0
    ? { message: "Every later month this year already has these budgets." }
    : { message: `Added ${plural(n, "budget", "budgets")} to the rest of the year.` };
}

/**
 * "Fill blanks from the average": every row with no budget this month gets
 * its usual spend, worked out again here from the books, never taken from
 * the browser.
 */
export async function fillBlanks(
  slug: string,
  month: string,
  subject: string,
): Promise<BudgetActionState> {
  const ctx = await budgetContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  const who = subjectSchema.safeParse(subject);
  if (!isMonth(month) || !who.success) return { error: "Pick a month first." };
  const view = await loadBudgetView(ctx.supabase, ctx.tenant, {
    month,
    period: "month",
    subject: who.data,
  });
  const blanks = blanksFromAverage(view.rows);
  if (blanks.length === 0) {
    return { message: "Nothing to fill: every row with spending already has a budget." };
  }
  const { error } = await ctx.supabase.rpc("set_money_budgets", {
    p_tenant_id: ctx.tenant.id,
    p_month: `${month}-01`,
    p_rows: blanks.map((row) => ({
      subject: view.subject,
      key: row.key,
      amount_cents: row.cents,
    })),
  });
  if (error) return { error: "We couldn't fill those in. Try again in a moment." };
  refresh(slug);
  return { message: `Filled ${plural(blanks.length, "budget", "budgets")} from the average.` };
}
