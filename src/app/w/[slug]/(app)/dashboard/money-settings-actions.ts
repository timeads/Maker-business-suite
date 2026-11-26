"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { loadRevenueSettings } from "@/lib/dashboard/data";
import {
  EXPENSES_KEY,
  EXPENSES_MODULE,
  accountChoiceSchema,
  actionFits,
  expenseSortingSchema,
  parseExpenseSorting,
} from "@/lib/dashboard/expenses";
import { z } from "zod";
import { BUDGET_KEY, budgetSettingsSchema } from "@/lib/dashboard/budget";
import { HEALTH_KEY, healthSettingsSchema } from "@/lib/dashboard/health";
import { PROFIT_KEY, PROFIT_MODULE, profitSettingsSchema } from "@/lib/dashboard/profit";
import { CUTTER_KEY, cutterSettingsSchema } from "@/lib/dashboard/recurring";
import { DEBT_KEY, debtSettingsSchema } from "@/lib/dashboard/debt/settings";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

export type MoneySettingsState = { error?: string; message?: string };

/** Owners and admins, on a plan that can still change things. */
async function settingsContext(slug: string, path: string) {
  const user = await requireUser(`/w/${slug}/settings/money/${path}`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx || !canManage(ctx.role)) {
    return { error: "Only owners and admins can change how Money works things out." } as const;
  }
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.canWrite || !entitlements.can("module.dashboard")) {
    return { error: "Your plan doesn't include changing Money right now." } as const;
  }
  const supabase = await createClient();
  return { tenant: ctx.tenant, supabase } as const;
}

function readBody(formData: FormData): unknown {
  try {
    return JSON.parse(String(formData.get("body") ?? "{}"));
  } catch {
    return null;
  }
}

async function save(
  ctx: Exclude<Awaited<ReturnType<typeof settingsContext>>, { error: string }>,
  slug: string,
  key: string,
  body: unknown,
  done: string,
): Promise<MoneySettingsState> {
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: key === EXPENSES_KEY ? EXPENSES_MODULE : PROFIT_MODULE,
    p_key: key,
    p_body: body,
  });
  if (error) return { error: "We couldn't save that. Try again in a moment." };
  revalidatePath(`/w/${slug}/dashboard`, "layout");
  revalidatePath(`/w/${slug}/settings`, "layout");
  return { message: done };
}

/** The expense sorting setting as stored, so one part can change without the other. */
async function storedSorting(
  ctx: Exclude<Awaited<ReturnType<typeof settingsContext>>, { error: string }>,
) {
  const { data, error } = await ctx.supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", ctx.tenant.id)
    .eq("module", EXPENSES_MODULE)
    .eq("key", EXPENSES_KEY)
    .maybeSingle();
  if (error) return null;
  return parseExpenseSorting(data?.body);
}

/** Payee defaults and rules, handed over as one JSON field by the editor. The account choices stay. */
export async function saveExpenseSorting(
  slug: string,
  _prev: MoneySettingsState,
  formData: FormData,
): Promise<MoneySettingsState> {
  const ctx = await settingsContext(slug, "expenses");
  if ("error" in ctx) return { error: ctx.error };
  const stored = await storedSorting(ctx);
  if (!stored) return { error: "We couldn't read your setting. Try again in a moment." };
  const sent = (readBody(formData) ?? {}) as Record<string, unknown>;
  const parsed = expenseSortingSchema.safeParse({
    version: 1,
    vendors: sent.vendors,
    rules: sent.rules,
    accounts: stored.accounts,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Something in there doesn't look right." };
  }
  const revenue = await loadRevenueSettings(ctx.supabase, ctx.tenant.id);
  const lineIds = new Set(revenue.lines.map((line) => line.id));
  const actions = [...parsed.data.vendors, ...parsed.data.rules].map((one) => one.action);
  if (!actions.every((action) => actionFits(action, lineIds))) {
    return { error: "Each rule has to point at one of your lines." };
  }
  return save(
    ctx,
    slug,
    EXPENSES_KEY,
    parsed.data,
    "Saved. New expenses from your books are sorted this way; press “Apply my rules to what's waiting” in the inbox for the ones already there.",
  );
}

const accountListSchema = z.array(accountChoiceSchema).max(1000);

/**
 * One choice per account in the books, handed over as one JSON list by the
 * account sorter. Saved beside the payee defaults and rules, then applied to
 * every expense in those accounts at once, in the database.
 */
export async function saveAccountSorting(
  slug: string,
  _prev: MoneySettingsState,
  formData: FormData,
): Promise<MoneySettingsState> {
  const ctx = await settingsContext(slug, "expenses");
  if ("error" in ctx) return { error: ctx.error };
  const stored = await storedSorting(ctx);
  if (!stored) return { error: "We couldn't read your setting. Try again in a moment." };
  const list = accountListSchema.safeParse(
    (readBody(formData) as { accounts?: unknown })?.accounts,
  );
  if (!list.success) {
    return { error: list.error.issues[0]?.message ?? "Something in there doesn't look right." };
  }
  const parsed = expenseSortingSchema.safeParse({ ...stored, accounts: list.data });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Something in there doesn't look right." };
  }
  const revenue = await loadRevenueSettings(ctx.supabase, ctx.tenant.id);
  const lineIds = new Set(revenue.lines.map((line) => line.id));
  if (
    !parsed.data.accounts.every(
      (choice) => choice.action.sort === "each" || actionFits(choice.action, lineIds),
    )
  ) {
    return { error: "Each account has to go to one of your lines." };
  }
  const saved = await save(ctx, slug, EXPENSES_KEY, parsed.data, "");
  if (saved.error) return saved;
  const { data, error } = await ctx.supabase.rpc("apply_expense_accounts", {
    p_tenant_id: ctx.tenant.id,
  });
  if (error) {
    return {
      message:
        "Saved. Your expenses will follow these choices at the next sync with your books (we couldn't apply them just now).",
    };
  }
  const counts = (data ?? {}) as { sorted?: number; inbox?: number };
  const sorted = Number(counts.sorted ?? 0);
  const inbox = Number(counts.inbox ?? 0);
  const n = (count: number, one: string, many: string) =>
    `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
  return {
    message:
      sorted === 0 && inbox === 0
        ? "Saved. Every expense already matched these choices."
        : `Saved. ${[
            sorted ? `${n(sorted, "expense", "expenses")} sorted by their account` : "",
            inbox ? `${n(inbox, "expense is", "expenses are")} waiting in the inbox for you` : "",
          ]
            .filter(Boolean)
            .join(", and ")}.`,
  };
}

/** Cost of goods, the shared split and the monthly costs, handed over as one JSON field. */
export async function saveProfitSettings(
  slug: string,
  _prev: MoneySettingsState,
  formData: FormData,
): Promise<MoneySettingsState> {
  const ctx = await settingsContext(slug, "profit");
  if ("error" in ctx) return { error: ctx.error };
  const parsed = profitSettingsSchema.safeParse({ version: 1, ...(readBody(formData) ?? {}) });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Something in there doesn't look right." };
  }
  const revenue = await loadRevenueSettings(ctx.supabase, ctx.tenant.id);
  const lineIds = new Set(revenue.lines.map((line) => line.id));
  const splits = [parsed.data.shared_split, ...parsed.data.monthly_costs.map((c) => c.split)];
  if (!splits.every((split) => Object.keys(split).every((id) => lineIds.has(id)))) {
    return { error: "Each share has to go to one of your lines." };
  }
  return save(
    ctx,
    slug,
    PROFIT_KEY,
    parsed.data,
    "Saved. Profit by line on Money uses these from now on, for every date range.",
  );
}

/** One of the settings held as plain figures and lists, handed over as one JSON field. */
async function saveFigures(
  slug: string,
  formData: FormData,
  how: {
    path: string;
    key: string;
    schema:
      | typeof healthSettingsSchema
      | typeof budgetSettingsSchema
      | typeof cutterSettingsSchema
      | typeof debtSettingsSchema;
    done: string;
  },
): Promise<MoneySettingsState> {
  const ctx = await settingsContext(slug, how.path);
  if ("error" in ctx) return { error: ctx.error };
  const parsed = how.schema.safeParse({ version: 1, ...(readBody(formData) ?? {}) });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Something in there doesn't look right." };
  }
  return save(ctx, slug, how.key, parsed.data, how.done);
}

/** Settings → Money → Cash health. */
export async function saveHealthSettings(
  slug: string,
  _prev: MoneySettingsState,
  formData: FormData,
): Promise<MoneySettingsState> {
  return saveFigures(slug, formData, {
    path: "health",
    key: HEALTH_KEY,
    schema: healthSettingsSchema,
    done: "Saved. Money's cash health figures use these from now on.",
  });
}

/** Settings → Money → Budget and break-even. */
export async function saveBudgetSettings(
  slug: string,
  _prev: MoneySettingsState,
  formData: FormData,
): Promise<MoneySettingsState> {
  return saveFigures(slug, formData, {
    path: "budget",
    key: BUDGET_KEY,
    schema: budgetSettingsSchema,
    done: "Saved. The budget and break-even use these from now on.",
  });
}

/** Settings → Money → Cost cutter. */
export async function saveCutterSettings(
  slug: string,
  _prev: MoneySettingsState,
  formData: FormData,
): Promise<MoneySettingsState> {
  return saveFigures(slug, formData, {
    path: "cost-cutter",
    key: CUTTER_KEY,
    schema: cutterSettingsSchema,
    done: "Saved. The cost cutter looks for recurring charges this way from now on.",
  });
}

/** Settings → Money → Debt payoff and emergency fund (owners and admins only). */
export async function saveDebtSettings(
  slug: string,
  _prev: MoneySettingsState,
  formData: FormData,
): Promise<MoneySettingsState> {
  return saveFigures(slug, formData, {
    path: "debts",
    key: DEBT_KEY,
    schema: debtSettingsSchema,
    done: "Saved. Your payoff plan and emergency fund are worked out this way from now on.",
  });
}
