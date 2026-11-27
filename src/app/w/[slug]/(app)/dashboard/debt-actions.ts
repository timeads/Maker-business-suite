"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { loadDebtSettings, loadDebtView, sheetBanks } from "@/lib/dashboard/debt/data";
import { findBank } from "@/lib/dashboard/debt/figures";
import {
  IMPORT_FIELD_WORDS,
  detailWords,
  planDebtImport,
  readDebtFile,
  type ImportDebt,
} from "@/lib/dashboard/debt/import";
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
import { applyDebtBasics } from "@/lib/dashboard/debt/apply";
import { debtPlanFieldsSchema } from "@/lib/dashboard/debt/plans";
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
 * Makes a plan that pays other debts (a consolidated debt), or changes one
 * (`id` set): its own rate, one monthly payment, where its balance comes
 * from, and every debt it pays (a debt left unticked is no longer covered,
 * and comes back just as it was). A typed balance is noted for today.
 */
export async function saveDebtPlan(
  slug: string,
  _prev: DebtActionState,
  formData: FormData,
): Promise<DebtActionState> {
  const ctx = await debtContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  for (const name of ["payment", "opening", "balance"] as const) {
    if (!moneyOk(text(formData, name)))
      return { error: `The ${name} doesn't look like an amount.` };
  }
  const rateText = text(formData, "rate");
  const rate = rateText === "" ? null : percentToBp(rateText);
  if (rate === null && rateText !== "")
    return { error: "Give the rate as a percent, like 0 or 6.5." };
  const payment = money(text(formData, "payment"));
  if (payment === null) return { error: "Give the one payment you make to the plan each month." };
  const parsed = debtPlanFieldsSchema.safeParse({
    name: text(formData, "name"),
    status: text(formData, "status") || "active",
    rate_bp: rate,
    payment_cents: payment,
    due_day: whole(text(formData, "due_day")),
    priority: whole(text(formData, "priority")),
    opening_cents: money(text(formData, "opening")),
    note: text(formData, "note") || null,
    balance_from: text(formData, "balance_from") || "covered",
    plan_account_id: text(formData, "plan_account_id") || null,
    covers: formData.getAll("covers").map(String),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Something in there doesn't look right." };
  }
  const id = text(formData, "id") || null;
  if (id !== null && !z.string().uuid().safeParse(id).success)
    return { error: "Which plan is this?" };
  const { data, error } = await ctx.supabase.rpc("save_money_debt_plan", {
    p_tenant_id: ctx.tenant.id,
    p_debt_id: id,
    p_fields: parsed.data,
  });
  if (error || typeof data !== "string") {
    // The database's own words, where they're about what was asked.
    if (error?.code === "22023" && /already paid through|can't pay another/i.test(error.message)) {
      return { error: `${error.message}.` };
    }
    if (error?.message.includes("money_debts_plan_account_idx")) {
      return { error: "Another plan already uses that account in your books." };
    }
    return { error: "We couldn't save that. Try again in a moment." };
  }
  const balance = money(text(formData, "balance"));
  if (balance !== null && parsed.data.balance_from === "typed") {
    if (balance < 0) return { error: "A balance can't be below zero." };
    const { error: balanceError } = await ctx.supabase.rpc("note_money_debt_balance", {
      p_tenant_id: ctx.tenant.id,
      p_debt_id: data,
      p_as_of: today(ctx.tenant.timezone),
      p_balance_cents: balance,
    });
    if (balanceError) return { error: "The plan is saved, but we couldn't note its balance." };
  }
  refresh(slug);
  const count = parsed.data.covers.length;
  return {
    message: id
      ? "Saved."
      : `${parsed.data.name} is added${count ? `, paying ${count} ${count === 1 ? "debt" : "debts"}` : ""}. They count as one debt now.`,
  };
}

/** Puts one debt under a plan, or (`planId` null) back on its own, exactly as it was. */
export async function coverDebt(
  slug: string,
  debtId: string,
  planId: string | null,
): Promise<DebtActionState> {
  const ctx = await debtContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!z.string().uuid().safeParse(debtId).success) return { error: "Which debt is this?" };
  if (planId !== null && !z.string().uuid().safeParse(planId).success) {
    return { error: "Which plan is this?" };
  }
  const { error } = await ctx.supabase.rpc("cover_money_debt", {
    p_tenant_id: ctx.tenant.id,
    p_debt_id: debtId,
    p_plan_id: planId,
  });
  if (error) {
    if (error.code === "22023") return { error: `${error.message}.` };
    return { error: "We couldn't change that. Try again in a moment." };
  }
  refresh(slug);
  return {
    message: planId
      ? "Done. It's paid through the plan now."
      : "Done. It counts on its own again, just as you left it.",
  };
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

/**
 * "Hide" / "Show again" for one of the books' other liabilities on Money →
 * Debts. Only the list changes: whether it counts as a debt never does.
 */
export async function hideBookLiability(
  slug: string,
  accountId: string,
  hidden: boolean,
): Promise<DebtActionState> {
  const ctx = await debtContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!z.string().uuid().safeParse(accountId).success) return { error: "Which account is this?" };
  const { error } = await ctx.supabase.rpc("hide_book_liability", {
    p_tenant_id: ctx.tenant.id,
    p_account_id: accountId,
    p_hidden: hidden === true,
  });
  if (error) return { error: "We couldn't change that. Try again in a moment." };
  refresh(slug);
  return {
    message: hidden ? "Hidden. It stays out of this list after each sync." : "Back on the list.",
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
      strategy: view.strategy,
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

const picksSchema = z
  .array(z.object({ id: z.string().max(60).nullable(), name: z.string().trim().min(1).max(200) }))
  .max(10);

/**
 * The emergency fund's accounts, ticked from the latest balance sheet. Kept
 * by the books' id where the sheet gives one, else by the name; only
 * accounts the sheet really has are kept. Replaces names typed in earlier.
 */
export async function chooseEmergencyAccounts(
  slug: string,
  picks: unknown,
): Promise<DebtActionState> {
  const ctx = await debtContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  const parsed = picksSchema.safeParse(picks);
  if (!parsed.success) return { error: "Tick up to ten accounts." };
  const [current, sheet] = await Promise.all([
    loadDebtSettings(ctx.supabase, ctx.tenant.id),
    ctx.supabase
      .from("financial_snapshots")
      .select("data")
      .eq("tenant_id", ctx.tenant.id)
      .eq("kind", "balance_sheet")
      .order("period_start", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (sheet.error) return { error: "We couldn't read your balance sheet. Try again in a moment." };
  const banks = sheetBanks((sheet.data as { data?: Record<string, unknown> } | null)?.data) ?? [];
  const kept = parsed.data.flatMap((pick) => {
    const found = findBank(banks, { id: pick.id || null, name: pick.name });
    return found ? [{ id: found.id ?? null, name: found.name }] : [];
  });
  if (kept.length < parsed.data.length) {
    return {
      error: "Your latest balance sheet doesn't have one of those. Reload the page and try again.",
    };
  }
  const body = debtSettingsSchema.parse({
    ...current,
    emergency_picks: kept,
    emergency_accounts: [],
  });
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: DEBT_MODULE,
    p_key: DEBT_KEY,
    p_body: body,
  });
  if (error) return { error: "We couldn't save that. Try again in a moment." };
  refresh(slug);
  revalidatePath(`/w/${slug}/settings`, "layout");
  return {
    message:
      kept.length === 0
        ? "Saved. No account is chosen for the fund now."
        : "Saved. The fund's balance is read from your books each time they sync.",
  };
}

/** "Use this order": the plan's strategy, saved in its setting (a new version, as any change). */
export async function chooseStrategy(slug: string, strategy: string): Promise<DebtActionState> {
  const ctx = await debtContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  const picked = z.enum(STRATEGIES).safeParse(strategy);
  if (!picked.success) return { error: "That isn't one of the orders." };
  const current = await loadDebtSettings(ctx.supabase, ctx.tenant.id);
  const body = debtSettingsSchema.parse({
    ...current,
    strategy: picked.data,
    strategy_from: "person",
  });
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: DEBT_MODULE,
    p_key: DEBT_KEY,
    p_body: body,
  });
  if (error) return { error: "We couldn't save that. Try again in a moment." };
  refresh(slug);
  revalidatePath(`/w/${slug}/settings`, "layout");
  return { message: "Saved: the plan uses this order now, until you change it." };
}

/**
 * Moves a debt to a place in "your own order" (1 is first; the others shift
 * around it) through the one checked function, and then follows that order
 * as "Use this order" on "Your own order" would, if the plan wasn't already.
 */
export async function moveDebt(
  slug: string,
  debtId: string,
  position: number,
): Promise<DebtActionState & { place?: number }> {
  const ctx = await debtContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!z.string().uuid().safeParse(debtId).success) return { error: "Which debt is this?" };
  if (!Number.isInteger(position) || position < 1 || position > 999) {
    return { error: "Pick a place from the list." };
  }
  const { data, error } = await ctx.supabase.rpc("move_money_debt", {
    p_tenant_id: ctx.tenant.id,
    p_debt_id: debtId,
    p_position: position,
  });
  if (error || typeof data !== "number") {
    if (error?.code === "22023") {
      return { error: "Only debts paid down from the pool take a place in your own order." };
    }
    return { error: "We couldn't move that. Try again in a moment." };
  }
  const current = await loadDebtSettings(ctx.supabase, ctx.tenant.id);
  let switched = false;
  if (current.strategy_from !== "person" || current.strategy !== "custom") {
    const body = debtSettingsSchema.parse({
      ...current,
      strategy: "custom",
      strategy_from: "person",
    });
    const saved = await ctx.supabase.rpc("save_config", {
      p_tenant_id: ctx.tenant.id,
      p_module: DEBT_MODULE,
      p_key: DEBT_KEY,
      p_body: body,
    });
    if (saved.error) {
      refresh(slug);
      return {
        place: data,
        error: "Moved, but we couldn't switch the plan to your own order. Try “Use this order”.",
      };
    }
    switched = true;
    revalidatePath(`/w/${slug}/settings`, "layout");
  }
  refresh(slug);
  return {
    place: data,
    message: switched
      ? `Moved to number ${data}. The plan follows your own order now.`
      : `Moved to number ${data}.`,
  };
}

/** "Follow the recommended order": back to the order that saves the most, worked out afresh. */
export async function followRecommended(slug: string): Promise<DebtActionState> {
  const ctx = await debtContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  const current = await loadDebtSettings(ctx.supabase, ctx.tenant.id);
  const body = debtSettingsSchema.parse({ ...current, strategy_from: "recommended" });
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: DEBT_MODULE,
    p_key: DEBT_KEY,
    p_body: body,
  });
  if (error) return { error: "We couldn't save that. Try again in a moment." };
  refresh(slug);
  revalidatePath(`/w/${slug}/settings`, "layout");
  return { message: "Saved: the plan follows the recommended order from now on." };
}

export type DebtImportPreview = {
  error?: string;
  message?: string;
  /** What would be filled, in words, one line per debt. */
  fills?: { line: number; debt: string; words: string[]; kept: string[] }[];
  /** Plans that pay other debts, to be made, in words. */
  plans?: { line: number; name: string; words: string[] }[];
  /** Debts to be put under a plan. */
  covers?: { line: number; debt: string; plan: string }[];
  skipped?: { line: number; text: string }[];
  problems?: { line: number; text: string }[];
};

const IMPORT_TEXT_MAX = 200_000;

/** The file read and matched to this workspace's debts, as the member (owners and admins). */
async function planImport(
  ctx: Exclude<Awaited<ReturnType<typeof debtContext>>, { error: string }>,
  text: string,
) {
  if (typeof text !== "string" || text.length > IMPORT_TEXT_MAX) {
    return { error: "That file is too big. Save only the debts' rows and try again." } as const;
  }
  const file = readDebtFile(text);
  if (!file.ok) return { error: file.error } as const;
  const { data, error } = await ctx.supabase
    .from("money_debts")
    .select(
      "id, name, books_account, rate_bp, minimum_cents, payment_cents, plan, priority, due_day, note, updated_by, consolidated, covered_by",
    )
    .eq("tenant_id", ctx.tenant.id)
    .is("left_out_at", null)
    .limit(500);
  if (error) return { error: "We couldn't read your debts. Try again in a moment." } as const;
  // The books' accounts, for linking a new plan to its own account by name.
  const accounts = await ctx.supabase
    .from("money_book_accounts")
    .select("id, name")
    .eq("tenant_id", ctx.tenant.id)
    .is("gone_at", null)
    .limit(1000);
  if (accounts.error)
    return { error: "We couldn't read your books. Try again in a moment." } as const;
  const debts: ImportDebt[] = ((data as Record<string, unknown>[] | null) ?? []).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    booksAccount: (row.books_account as string | null) ?? null,
    rateBp: row.rate_bp === null || row.rate_bp === undefined ? null : Number(row.rate_bp),
    minimum: Number(row.minimum_cents ?? 0),
    payment:
      row.payment_cents === null || row.payment_cents === undefined
        ? null
        : Number(row.payment_cents),
    plan: String(row.plan),
    priority: row.priority === null || row.priority === undefined ? null : Number(row.priority),
    dueDay: row.due_day === null || row.due_day === undefined ? null : Number(row.due_day),
    note: (row.note as string | null) ?? null,
    savedByPerson: row.updated_by !== null && row.updated_by !== undefined,
    consolidated: row.consolidated === true,
    coveredBy: (row.covered_by as string | null) ?? null,
  }));
  const bookAccounts = ((accounts.data as { id: string; name: string }[] | null) ?? []).map(
    (a) => ({ id: String(a.id), name: String(a.name) }),
  );
  return { file, plan: planDebtImport(file.rows, debts, bookAccounts) } as const;
}

/** "Bring your debt details across", for a look: what would be filled, and what wouldn't. */
export async function previewDebtImport(slug: string, text: string): Promise<DebtImportPreview> {
  const ctx = await debtContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  const planned = await planImport(ctx, text);
  if ("error" in planned) return { error: planned.error };
  const money = (cents: number) => formatMoney(cents / 100, ctx.tenant.currency);
  return {
    fills: planned.plan.fills.map((fill) => ({
      line: fill.line,
      debt: fill.debtName,
      words: detailWords(fill.details, money),
      kept: fill.kept.map((field) => IMPORT_FIELD_WORDS[field]),
    })),
    plans: planned.plan.plans.map((plan) => ({
      line: plan.line,
      name: plan.name,
      words: [
        ...detailWords(plan.details, money),
        plan.account ? `its own account in your books, “${plan.account.name}”` : "",
      ].filter(Boolean),
    })),
    covers: planned.plan.covers.map((cover) => ({
      line: cover.line,
      debt: cover.debtName,
      plan: cover.planName,
    })),
    skipped: planned.plan.skipped,
    problems: planned.file.problems,
  };
}

/**
 * "Bring these across": the same file, matched again, through the one
 * checked function. The request key makes a second press change nothing.
 */
export async function confirmDebtImport(
  slug: string,
  text: string,
  requestKey: string,
  /** A second key for the plans' part (each part is once per press). */
  planKey?: string,
): Promise<DebtActionState> {
  const ctx = await debtContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!z.string().uuid().safeParse(requestKey).success) {
    return { error: "Look at the file again first." };
  }
  const planned = await planImport(ctx, text);
  if ("error" in planned) return { error: planned.error };
  const { fills, plans, covers } = planned.plan;
  if (fills.length === 0 && plans.length === 0 && covers.length === 0) {
    return { message: "Nothing to bring across: it's all set." };
  }
  // Plans first: they're made, and debts put under them, before details fill.
  let planWords = "";
  if (plans.length > 0 || covers.length > 0) {
    if (!planKey || !z.string().uuid().safeParse(planKey).success || planKey === requestKey) {
      return { error: "Look at the file again first." };
    }
    const { data: made, error: planError } = await ctx.supabase.rpc("import_money_debt_plans", {
      p_tenant_id: ctx.tenant.id,
      p_request_key: planKey,
      p_plans: plans.map((plan) => ({
        name: plan.name,
        ...plan.details,
        plan_account_id: plan.account?.id ?? null,
      })),
      p_covers: covers.map((cover) => ({ debt_id: cover.debtId, plan_name: cover.planName })),
    });
    if (planError) return { error: "We couldn't bring those across. Nothing was changed." };
    const r = (made ?? {}) as { plans?: number; covered?: number };
    const n = Number(r.plans ?? 0);
    const c = Number(r.covered ?? 0);
    planWords = [
      n > 0 ? `Made ${n} ${n === 1 ? "plan" : "plans"}` : "",
      c > 0 ? `put ${c} ${c === 1 ? "debt" : "debts"} under ${n === 1 ? "it" : "a plan"}` : "",
    ]
      .filter(Boolean)
      .join(" and ");
  }
  if (fills.length === 0) {
    refresh(slug);
    revalidatePath(`/w/${slug}/settings`, "layout");
    return { message: planWords ? `${planWords}.` : "Already brought across." };
  }
  const { data, error } = await ctx.supabase.rpc("import_money_debt_details", {
    p_tenant_id: ctx.tenant.id,
    p_request_key: requestKey,
    p_rows: planned.plan.fills.map((fill) => ({ debt_id: fill.debtId, ...fill.details })),
  });
  if (error) return { error: "We couldn't bring those across. Nothing was changed." };
  refresh(slug);
  revalidatePath(`/w/${slug}/settings`, "layout");
  const result = (data ?? {}) as { debts?: number; fields?: number; again?: boolean };
  const debts = Number(result.debts ?? 0);
  const filled = result.again
    ? "Already brought across. Nothing changed the second time."
    : debts === 0
      ? "Nothing needed filling: it's all set."
      : `Filled in ${Number(result.fields ?? 0)} details on ${debts} ${debts === 1 ? "debt" : "debts"}. Anything you'd already set is just as you left it.`;
  return { message: planWords ? `${planWords}. ${filled}` : filled };
}

/**
 * Money → Set up: one debt's rate, minimum and usual payment, changed on
 * their own (everything else stays as it is). Blank rate: not given yet.
 */
export async function saveDebtBasics(
  slug: string,
  debtId: string,
  _prev: DebtActionState,
  formData: FormData,
): Promise<DebtActionState> {
  const ctx = await debtContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!z.string().uuid().safeParse(debtId).success) return { error: "Which debt is this?" };
  const rateText = text(formData, "rate");
  const rate = rateText === "" ? null : percentToBp(rateText);
  if (rate === null && rateText !== "") return { error: "Give the rate as a percent, like 22.99." };
  for (const name of ["minimum", "payment"] as const) {
    if (!moneyOk(text(formData, name)))
      return { error: `The ${name} doesn't look like an amount.` };
  }
  const minimum = money(text(formData, "minimum")) ?? 0;
  const payment = money(text(formData, "payment"));
  if (minimum < 0 || (payment !== null && payment < 0)) {
    return { error: "An amount can't be below zero." };
  }
  const done = await applyDebtBasics(ctx.supabase, ctx.tenant.id, debtId, {
    rate_bp: rate,
    minimum_cents: minimum,
    payment_cents: payment,
  });
  if (done.error) return { error: done.error };
  refresh(slug);
  return { message: "Saved." };
}
