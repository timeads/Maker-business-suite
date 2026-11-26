import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { applyDebtBasics } from "../dashboard/debt/apply";
import { DEBT_COLUMNS, basicsWords, debtBasicsSchema } from "../dashboard/debt/basics";
import { formatMoney } from "../dashboard/format";

/**
 * The assistant's proposals that aren't settings (`action_proposals`): the
 * preview a person sees, and applying one, which is always the existing
 * checked function called AS the owner or admin who pressed "Apply". The
 * body is checked again here before anything is called. Server only.
 */

export type ActionRow = {
  id: string;
  kind: string;
  target: string;
  body: unknown;
  summary: string;
};

export type ActionPreview = {
  id: string;
  source: "action";
  name: string;
  summary: string;
  before: string[];
  after: string[];
};

const coverBody = z.object({ plan_id: z.string().uuid().nullable() }).strict();
const choiceBody = z.object({ choice: z.enum(["debt", "not_debt", "rule"]) }).strict();
const hideBody = z.object({ hidden: z.boolean() }).strict();

const CHOICE_WORDS = {
  debt: "Counted as a debt",
  not_debt: "Not a debt",
  rule: "Your debt setting decides",
} as const;

async function debtRow(supabase: SupabaseClient, tenantId: string, id: string) {
  const { data } = await supabase
    .from("money_debts")
    .select(DEBT_COLUMNS + ", covered_by")
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

async function accountRow(supabase: SupabaseClient, tenantId: string, id: string) {
  const { data } = await supabase
    .from("money_book_accounts")
    .select("id, name, choice, hidden_at")
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

/** Before and after, in plain lines; null when the member can't see what it's about. */
export async function previewAction(
  supabase: SupabaseClient,
  tenant: { id: string; currency: string },
  row: ActionRow,
): Promise<ActionPreview | null> {
  const money = (cents: number) => formatMoney(cents / 100, tenant.currency);
  const base = { id: row.id, source: "action" as const, summary: row.summary };
  if (row.kind === "money.debt_details") {
    const debt = await debtRow(supabase, tenant.id, row.target);
    const change = debtBasicsSchema.safeParse(row.body);
    if (!debt || !change.success) return null;
    return { ...base, name: `Debt: ${debt.name}`, ...basicsWords(debt, change.data, money) };
  }
  if (row.kind === "money.debt_cover") {
    const debt = await debtRow(supabase, tenant.id, row.target);
    const body = coverBody.safeParse(row.body);
    if (!debt || !body.success) return null;
    const planName = async (id: unknown) =>
      typeof id === "string" ? ((await debtRow(supabase, tenant.id, id))?.name ?? "a plan") : null;
    const now = await planName(debt.covered_by);
    const next = await planName(body.data.plan_id);
    return {
      ...base,
      name: `Debt: ${debt.name}`,
      before: [now ? `Paid through ${now}` : "Counted on its own"],
      after: [next ? `Paid through ${next}` : "Counted on its own"],
    };
  }
  if (row.kind === "money.liability_choice" || row.kind === "money.liability_hide") {
    const account = await accountRow(supabase, tenant.id, row.target);
    if (!account) return null;
    const name = `In your books: ${account.name}`;
    if (row.kind === "money.liability_hide") {
      const body = hideBody.safeParse(row.body);
      if (!body.success) return null;
      const shown = (hidden: boolean) =>
        hidden ? "Hidden from “Also in your books”" : "Listed in “Also in your books”";
      return {
        ...base,
        name,
        before: [shown(account.hidden_at !== null)],
        after: [shown(body.data.hidden)],
      };
    }
    const body = choiceBody.safeParse(row.body);
    if (!body.success) return null;
    const now =
      account.choice === "debt" || account.choice === "not_debt" ? account.choice : "rule";
    return {
      ...base,
      name,
      before: [CHOICE_WORDS[now as keyof typeof CHOICE_WORDS]],
      after: [CHOICE_WORDS[body.data.choice]],
    };
  }
  return null;
}

/** Applies a claimed proposal as the person, through the checked function. */
export async function applyAction(
  supabase: SupabaseClient,
  tenantId: string,
  row: { kind: string; target: string; body: unknown },
): Promise<{ error?: string }> {
  const plain = (error: { message: string } | null) =>
    error ? { error: "That didn't apply. Please try again." } : {};
  switch (row.kind) {
    case "money.debt_details": {
      const change = debtBasicsSchema.safeParse(row.body);
      if (!change.success) return { error: "This suggestion doesn't fit any more." };
      return applyDebtBasics(supabase, tenantId, row.target, change.data);
    }
    case "money.debt_cover": {
      const body = coverBody.safeParse(row.body);
      if (!body.success) return { error: "This suggestion doesn't fit any more." };
      const { error } = await supabase.rpc("cover_money_debt", {
        p_tenant_id: tenantId,
        p_debt_id: row.target,
        p_plan_id: body.data.plan_id,
      });
      return error?.code === "22023" ? { error: `${error.message}.` } : plain(error);
    }
    case "money.liability_choice": {
      const body = choiceBody.safeParse(row.body);
      if (!body.success) return { error: "This suggestion doesn't fit any more." };
      const { error } = await supabase.rpc("choose_book_liability", {
        p_tenant_id: tenantId,
        p_account_id: row.target,
        p_choice: body.data.choice,
      });
      return plain(error);
    }
    case "money.liability_hide": {
      const body = hideBody.safeParse(row.body);
      if (!body.success) return { error: "This suggestion doesn't fit any more." };
      const { error } = await supabase.rpc("hide_book_liability", {
        p_tenant_id: tenantId,
        p_account_id: row.target,
        p_hidden: body.data.hidden,
      });
      return plain(error);
    }
  }
  return { error: "That kind of suggestion can't be applied here." };
}
