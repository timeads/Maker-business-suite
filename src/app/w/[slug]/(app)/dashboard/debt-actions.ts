"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { loadDebtSettings, loadDebtView } from "@/lib/dashboard/debt/data";
import {
  QUESTION_MAX,
  WHAT_IF_DEBTS,
  askWhatIf,
  changeWords,
  tidyWhatIf,
  whatIfChangesSchema,
  whatIfFigures,
  type WhatIfChanges,
  type WhatIfFigures,
} from "@/lib/dashboard/debt/what-if";
import { STRATEGIES } from "@/lib/dashboard/debt/engine";
import {
  DEBT_KEY,
  DEBT_MODULE,
  debtFieldsSchema,
  debtSettingsSchema,
  percentToBp,
} from "@/lib/dashboard/debt/settings";
import { formatMoney } from "@/lib/dashboard/format";
import { toCents } from "@/lib/dashboard/lines";
import { localDate } from "@/lib/dashboard/range";
import { AI_EXHAUSTED, getAiUsage } from "@/lib/ai/usage";
import { getEntitlements } from "@/lib/entitlements";
import { getAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

export type DebtActionState = { error?: string; message?: string };

const NOT_YOURS = "Only owners and admins can see or change the debts.";

/** Owners and admins only, on a plan that has Money. `write`: one that can still change things. */
async function debtContext(slug: string, write = true) {
  const user = await requireUser(`/w/${slug}/dashboard/debts`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx || !canManage(ctx.role)) return { error: NOT_YOURS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.dashboard") || (write && !entitlements.canWrite)) {
    return { error: "Your plan doesn't include changing Money right now." } as const;
  }
  const supabase = await createClient();
  return { tenant: ctx.tenant, supabase, entitlements } as const;
}

const refresh = (slug: string) => {
  revalidatePath(`/w/${slug}/dashboard`, "layout");
  revalidatePath(`/w/${slug}`, "page");
};

const text = (formData: FormData, name: string) => String(formData.get(name) ?? "").trim();
const money = (raw: string) => (raw === "" ? null : toCents(raw.replace(/[,$\s]/g, "")));
const moneyOk = (raw: string) => raw === "" || /^-?[$]?\s*[\d,]*(\.\d{0,2})?$/.test(raw);
const whole = (raw: string) => (raw === "" ? null : Number(raw));

function today(timezone: string): string {
  const d = localDate(new Date(), timezone);
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

/** Adds a debt, or changes one (`id` set). A balance typed in is noted for today. */
export async function saveDebt(
  slug: string,
  _prev: DebtActionState,
  formData: FormData,
): Promise<DebtActionState> {
  const ctx = await debtContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  const amounts = ["minimum", "payment", "opening", "balance"] as const;
  for (const name of amounts) {
    if (!moneyOk(text(formData, name)))
      return { error: `The ${name} doesn't look like an amount.` };
  }
  // Blank is "not given yet": the pages say the debt needs a rate.
  const rateText = text(formData, "rate");
  const rate = rateText === "" ? null : percentToBp(rateText);
  if (rate === null && rateText !== "") return { error: "Give the rate as a percent, like 22.99." };
  const revolvingText = text(formData, "revolving");
  const revolving = revolvingText === "" ? null : percentToBp(revolvingText);
  if (revolving === null && revolvingText !== "") {
    return { error: "Give the least payment as a percent of the balance, like 1.8." };
  }
  const parsed = debtFieldsSchema.safeParse({
    name: text(formData, "name"),
    kind: text(formData, "kind"),
    plan: text(formData, "plan"),
    status: text(formData, "status") || "active",
    rate_bp: rate,
    minimum_cents: money(text(formData, "minimum")) ?? 0,
    payment_cents: money(text(formData, "payment")),
    revolving_bp: revolving,
    due_day: whole(text(formData, "due_day")),
    priority: whole(text(formData, "priority")),
    opening_cents: money(text(formData, "opening")),
    books_account: text(formData, "books_account") || null,
    note: text(formData, "note") || null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Something in there doesn't look right." };
  }
  const id = text(formData, "id") || null;
  if (id !== null && !z.string().uuid().safeParse(id).success)
    return { error: "Which debt is this?" };
  const { data, error } = await ctx.supabase.rpc("save_money_debt", {
    p_tenant_id: ctx.tenant.id,
    p_debt_id: id,
    p_fields: parsed.data,
  });
  if (error || typeof data !== "string")
    return { error: "We couldn't save that. Try again in a moment." };
  const balance = money(text(formData, "balance"));
  if (balance !== null) {
    if (balance < 0) return { error: "A balance can't be below zero." };
    const { error: balanceError } = await ctx.supabase.rpc("note_money_debt_balance", {
      p_tenant_id: ctx.tenant.id,
      p_debt_id: data,
      p_as_of: today(ctx.tenant.timezone),
      p_balance_cents: balance,
    });
    if (balanceError) return { error: "The debt is saved, but we couldn't note its balance." };
  }
  refresh(slug);
  return { message: id ? "Saved." : `${parsed.data.name} is added.` };
}

/**
 * "Count this as a debt", "Not a debt", or back to what the rule says, for
 * one of the books' liability accounts. Sticks across syncs.
 */
export async function chooseBookLiability(
  slug: string,
  accountId: string,
  choice: "debt" | "not_debt" | "rule",
): Promise<DebtActionState> {
  const ctx = await debtContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!z.string().uuid().safeParse(accountId).success) return { error: "Which account is this?" };
  if (!["debt", "not_debt", "rule"].includes(choice)) return { error: "Which way is it?" };
  const { error } = await ctx.supabase.rpc("choose_book_liability", {
    p_tenant_id: ctx.tenant.id,
    p_account_id: accountId,
    p_choice: choice,
  });
  if (error) return { error: "We couldn't change that. Try again in a moment." };
  refresh(slug);
  return {
    message:
      choice === "debt"
        ? "Counted. It's with your debts now."
        : choice === "not_debt"
          ? "Done. It stays out of your debts, even after the next sync."
          : "Done. It follows your setting again.",
  };
}

export async function removeDebt(slug: string, debtId: string): Promise<DebtActionState> {
  const ctx = await debtContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!z.string().uuid().safeParse(debtId).success) return { error: "Which debt is this?" };
  const { error } = await ctx.supabase.rpc("remove_money_debt", {
    p_tenant_id: ctx.tenant.id,
    p_debt_id: debtId,
  });
  if (error) return { error: "We couldn't remove that. Try again in a moment." };
  refresh(slug);
  return { message: "Removed." };
}

/** A balance a person gives for a day. */
export async function noteBalance(
  slug: string,
  _prev: DebtActionState,
  formData: FormData,
): Promise<DebtActionState> {
  const ctx = await debtContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  const debtId = text(formData, "debt_id");
  const asOf = text(formData, "as_of") || today(ctx.tenant.timezone);
  const raw = text(formData, "balance");
  if (!z.string().uuid().safeParse(debtId).success) return { error: "Which debt is this?" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return { error: "Give the day the balance was." };
  if (raw === "" || !moneyOk(raw)) return { error: "Give the balance as an amount." };
  const { error } = await ctx.supabase.rpc("note_money_debt_balance", {
    p_tenant_id: ctx.tenant.id,
    p_debt_id: debtId,
    p_as_of: asOf,
    p_balance_cents: money(raw),
  });
  if (error) return { error: "We couldn't note that balance. Check the day and the amount." };
  refresh(slug);
  return { message: "Balance noted." };
}

export async function removeBalance(slug: string, balanceId: string): Promise<DebtActionState> {
  const ctx = await debtContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!z.string().uuid().safeParse(balanceId).success) return { error: "Which balance is this?" };
  const { error } = await ctx.supabase.rpc("remove_money_debt_balance", {
    p_tenant_id: ctx.tenant.id,
    p_balance_id: balanceId,
  });
  if (error) return { error: "That balance can't be taken back." };
  refresh(slug);
  return { message: "Taken back." };
}

const monthRows = z
  .array(
    z.object({
      month: z.string().regex(/^\d{4}-\d{2}$/),
      pool: z.string().max(20),
      emergency: z.string().max(20),
    }),
  )
  .min(1)
  .max(120);

/**
 * The schedule's months set by hand: an amount for the pool or the
 * emergency fund, or both blank to go back to worked out.
 */
export async function setPlanMonths(slug: string, rows: unknown): Promise<DebtActionState> {
  const ctx = await debtContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  const parsed = monthRows.safeParse(rows);
  if (!parsed.success) return { error: "Something in there doesn't look right." };
  for (const row of parsed.data) {
    if (!moneyOk(row.pool.trim()) || !moneyOk(row.emergency.trim())) {
      return { error: "Each amount should look like 250 or 250.00." };
    }
  }
  const { error } = await ctx.supabase.rpc("set_money_debt_plan_months", {
    p_tenant_id: ctx.tenant.id,
    p_rows: parsed.data.map((row) => ({
      month: `${row.month}-01`,
      pool_cents: money(row.pool.trim()),
      emergency_cents: money(row.emergency.trim()),
    })),
  });
  if (error) return { error: "We couldn't save those months. Amounts can't be below zero." };
  refresh(slug);
  return { message: parsed.data.length === 1 ? "Saved." : `Saved ${parsed.data.length} months.` };
}

export type WhatIfReply =
  | { error: string }
  | {
      question: string;
      understood: boolean;
      summary: string;
      tried: string[];
      changes: WhatIfChanges;
      figures: WhatIfFigures | null;
    };

/**
 * A person's what-if: Claude only picks which figures the question changes;
 * the engine works out both plans; nothing is saved.
 */
export async function askDebtWhatIf(slug: string, question: string): Promise<WhatIfReply> {
  const ctx = await debtContext(slug, false);
  if ("error" in ctx) return { error: ctx.error ?? NOT_YOURS };
  if (!process.env.ANTHROPIC_API_KEY || !process.env.SUPABASE_SECRET_KEY) {
    return { error: "What-ifs aren't switched on for this environment yet." };
  }
  const asked = String(question ?? "")
    .trim()
    .slice(0, QUESTION_MAX);
  if (asked.length < 3)
    return { error: "Ask a question first, like “What if I paid 200 more a month?”" };
  const usage = await getAiUsage(ctx.supabase, ctx.tenant.id, ctx.entitlements.limit("ai_credits"));
  if (usage.state === "exhausted") return { error: AI_EXHAUSTED };

  const view = await loadDebtView(ctx.supabase, ctx.tenant);
  const debts = view.input.debts.filter((d) => d.active && d.balance > 0).slice(0, WHAT_IF_DEBTS);
  if (debts.length === 0) return { error: "Add your debts and their balances first." };
  try {
    const result = await askWhatIf(debts, asked, {
      currency: ctx.tenant.currency,
      strategy: view.settings.strategy,
    });
    const { error: usageError } = await getAdminClient().rpc("record_usage", {
      p_tenant_id: ctx.tenant.id,
      p_type: "ai_tokens",
      p_quantity: result.tokens,
    });
    if (usageError) console.error(`Could not record AI usage: ${usageError.message}`);
    if (!result.ok) return { error: "Claude couldn't help with that one. Try asking another way." };
    const tidy = tidyWhatIf(
      result.answer,
      debts.map((d) => d.id),
    );
    const names = new Map(view.debts.map((d) => [d.id, d.name]));
    const format = (cents: number) => formatMoney(cents / 100, ctx.tenant.currency);
    return {
      question: asked,
      understood: tidy.understood,
      summary: tidy.summary,
      tried: changeWords(tidy.changes, names, format),
      changes: tidy.changes,
      figures: tidy.understood ? whatIfFigures(view.input, tidy.changes) : null,
    };
  } catch (err) {
    console.error(`Debt what-if failed: ${err instanceof Error ? err.message : "unknown"}`);
    return { error: "Claude isn't answering right now. Try again in a minute." };
  }
}

/** Keeps a what-if: the question, the changes, and the engine's figures worked out again here. */
export async function keepWhatIf(
  slug: string,
  question: string,
  changes: unknown,
): Promise<DebtActionState> {
  const ctx = await debtContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  const parsed = whatIfChangesSchema.safeParse(changes);
  const asked = String(question ?? "")
    .trim()
    .slice(0, QUESTION_MAX);
  if (!parsed.success || !asked) return { error: "That what-if can't be kept." };
  const view = await loadDebtView(ctx.supabase, ctx.tenant);
  const known = new Set(view.debts.map((d) => d.id));
  if (!parsed.data.debts.every((d) => known.has(d.id)))
    return { error: "That what-if can't be kept." };
  const figures = whatIfFigures(view.input, parsed.data);
  const { error } = await ctx.supabase.rpc("save_money_debt_scenario", {
    p_tenant_id: ctx.tenant.id,
    p_question: asked,
    p_changes: parsed.data,
    p_figures: figures,
  });
  if (error) return { error: "We couldn't keep that. Try again in a moment." };
  refresh(slug);
  return { message: "Kept. It's listed below with today's figures." };
}

export async function removeWhatIf(slug: string, id: string): Promise<DebtActionState> {
  const ctx = await debtContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!z.string().uuid().safeParse(id).success) return { error: "Which what-if is this?" };
  const { error } = await ctx.supabase.rpc("remove_money_debt_scenario", {
    p_tenant_id: ctx.tenant.id,
    p_scenario_id: id,
  });
  if (error) return { error: "We couldn't remove that. Try again in a moment." };
  refresh(slug);
  return { message: "Removed." };
}

/** "Use this order": the plan's strategy, saved in its setting (a new version, as any change). */
export async function chooseStrategy(slug: string, strategy: string): Promise<DebtActionState> {
  const ctx = await debtContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  const picked = z.enum(STRATEGIES).safeParse(strategy);
  if (!picked.success) return { error: "That isn't one of the orders." };
  const current = await loadDebtSettings(ctx.supabase, ctx.tenant.id);
  const body = debtSettingsSchema.parse({ ...current, strategy: picked.data });
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: DEBT_MODULE,
    p_key: DEBT_KEY,
    p_body: body,
  });
  if (error) return { error: "We couldn't save that. Try again in a moment." };
  refresh(slug);
  revalidatePath(`/w/${slug}/settings`, "layout");
  return { message: "Saved: the plan uses this order now." };
}
