"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { AI_EXHAUSTED, getAiUsage } from "@/lib/ai/usage";
import { addMonths } from "@/lib/dashboard/budget";
import { formatMoney, formatPercent } from "@/lib/dashboard/format";
import { currentMonth } from "@/lib/dashboard/range";
import { askForSummary, summaryFigures, tidySummary } from "@/lib/dashboard/summary";
import { loadSummaryInput } from "@/lib/dashboard/summary-data";
import { getEntitlements } from "@/lib/entitlements";
import { getAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

export type SummaryState = { error?: string; message?: string };

/**
 * "Write this month's summary" / "Write it again": a person's press, owners
 * and admins only. Code works out every figure for the last complete month;
 * Claude only chooses which to mention and words the sentences around them
 * (`lib/dashboard/summary.ts`); what passes the check is kept for the month,
 * through the one function that writes it. Counts against the AI allowance.
 */
export async function writeMoneySummary(slug: string): Promise<SummaryState> {
  const user = await requireUser(`/w/${slug}/dashboard`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx || !canManage(ctx.role)) {
    return { error: "Only owners and admins can have the monthly summary written." };
  }
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.dashboard") || !entitlements.canWrite) {
    return { error: "Your plan doesn't include changing Money right now." };
  }
  if (!process.env.ANTHROPIC_API_KEY || !process.env.SUPABASE_SECRET_KEY) {
    return { error: "Summaries aren't switched on for this environment yet." };
  }
  const supabase = await createClient();
  const usage = await getAiUsage(supabase, ctx.tenant.id, entitlements.limit("ai_credits"));
  if (usage.state === "exhausted") return { error: AI_EXHAUSTED };

  const { tenant } = ctx;
  const now = new Date();
  const month = addMonths(currentMonth(now, tenant.timezone), -1);
  const input = await loadSummaryInput(supabase, tenant, month, now);
  if (!input.revenue && !input.books && input.accounts.length === 0) {
    return { error: "There aren't any figures for last month yet to sum up." };
  }
  const figures = summaryFigures(input, {
    money: (cents) => formatMoney(cents / 100, tenant.currency),
    percent: formatPercent,
  });
  try {
    const result = await askForSummary(input.monthWords, figures);
    const admin = getAdminClient();
    const { error: usageError } = await admin.rpc("record_usage", {
      p_tenant_id: tenant.id,
      p_type: "ai_tokens",
      p_quantity: result.tokens,
    });
    if (usageError) console.error(`Could not record AI usage: ${usageError.message}`);
    if (!result.ok) return { error: "Claude couldn't sum this month up. Try again in a while." };
    const sections = tidySummary(result.answer, figures);
    if (sections.length === 0) {
      return {
        error: "Claude's summary didn't stick to your figures, so nothing was kept. Try again.",
      };
    }
    const { error } = await admin.rpc("save_money_summary", {
      p_tenant_id: tenant.id,
      p_month: `${month}-01`,
      p_sections: sections,
      p_written_by: user.id,
    });
    if (error) return { error: "We couldn't keep the summary. Try again in a moment." };
  } catch (err) {
    console.error(`Monthly summary failed: ${err instanceof Error ? err.message : "unknown"}`);
    return { error: "Claude isn't answering right now. Try again in a minute." };
  }
  revalidatePath(`/w/${slug}/dashboard`);
  return { message: `Written. Check it against your figures before acting on it.` };
}
