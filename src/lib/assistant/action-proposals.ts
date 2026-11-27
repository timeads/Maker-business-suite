import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { applyDebtBasics } from "../dashboard/debt/apply";
import { DEBT_COLUMNS, basicsWords, debtBasicsSchema } from "../dashboard/debt/basics";
import { formatMoney } from "../dashboard/format";
import { loadRevenueSettings } from "../dashboard/data";
import { actionSchema, actionWords, type SortAction } from "../dashboard/expenses";
import { DECISIONS, DECISION_WORDS } from "../dashboard/recurring";
import { placeInvoice } from "../dashboard/book-revenue";
import { invoiceSortArgs, invoiceSortSchema, placeWords } from "../dashboard/invoices";

/**
 * The assistant's proposals that aren't settings (`action_proposals`): the
 * preview a person sees, and applying one, which is always the existing
 * checked function called AS the owner or admin who pressed "Apply". The
 * body is checked again here before anything is called. Server only.
 */

export type ActionRow = {
  id: string;
  kind: string;
  target: string | null;
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

/** One month's budget amounts: an account by its name in the books, or a line by its id. */
export const budgetBody = z
  .object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    subject: z.enum(["account", "line"]),
    rows: z
      .array(
        z.object({
          key: z.string().trim().min(1).max(200),
          amount_cents: z.number().int().min(0).max(100_000_000_000).nullable(),
        }),
      )
      .min(1)
      .max(100),
  })
  .strict();

/** A cost cutter decision about one recurring charge (null clears it). */
export const chargeBody = z
  .object({
    key: z.string().trim().min(1).max(200),
    payee: z.string().max(200),
    decision: z.enum(DECISIONS).nullable(),
    note: z.string().max(500).default(""),
    monthly_cents: z.number().int().min(0).max(100_000_000_000),
  })
  .strict();

/** Which business line some invoices count in (up to 20, by id; the model used `I1`…). */
export const invoiceSortBody = z
  .object({
    invoices: z.array(z.string().uuid()).min(1).max(20),
    choice: invoiceSortSchema,
  })
  .strict();

const monthWords = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, 1)));
};

/** An expense's sorting as it's stored, as an action (null: not sorted). */
function storedAction(row: Record<string, unknown>): SortAction | null {
  const parsed = actionSchema.safeParse(
    row.sort === "line"
      ? { sort: "line", line: row.line_id }
      : row.sort === "split"
        ? { sort: "split", split: row.split }
        : { sort: row.sort },
  );
  return parsed.success ? parsed.data : null;
}

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
  if (row.kind === "money.expense_sort" && row.target) {
    const change = actionSchema.safeParse(row.body);
    const { data } = await supabase
      .from("book_expenses")
      .select("id, txn_date, amount_cents, payee, account, sort, line_id, split")
      .eq("tenant_id", tenant.id)
      .eq("id", row.target)
      .maybeSingle();
    if (!data || !change.success) return null;
    const revenue = await loadRevenueSettings(supabase, tenant.id);
    const lineName = (id: string) =>
      revenue.lines.find((l) => l.id === id)?.name ?? "a line since removed";
    const now = storedAction(data as Record<string, unknown>);
    const expense = data as Record<string, unknown>;
    return {
      ...base,
      name: `Expense: ${expense.payee ?? expense.account ?? "no payee"}, ${money(Number(expense.amount_cents))} on ${expense.txn_date}`,
      before: [now ? actionWords(now, lineName) : "Not sorted yet"],
      after: [actionWords(change.data, lineName)],
    };
  }
  if (row.kind === "money.invoice_sort") {
    const body = invoiceSortBody.safeParse(row.body);
    if (!body.success) return null;
    const [{ data }, revenue] = await Promise.all([
      supabase
        .from("book_invoices")
        .select("id, doc_number, customer, customer_ref, txn_date, lines, sort, line_id, split")
        .eq("tenant_id", tenant.id)
        .in("id", body.data.invoices)
        .is("removed_at", null),
      loadRevenueSettings(supabase, tenant.id),
    ]);
    const found = (data ?? []) as Record<string, unknown>[];
    if (found.length === 0) return null;
    const lineName = (id: string) =>
      revenue.lines.find((l) => l.id === id)?.name ?? "a line since removed";
    const choice = body.data.choice;
    // What each would be after: worked out by the same rule as every figure.
    const after =
      choice.sort === "none"
        ? { sort: null, line_id: null, split: null }
        : {
            sort: choice.sort,
            line_id: choice.sort === "line" ? choice.line : null,
            split: choice.sort === "split" ? choice.split : null,
          };
    const words = (r: Record<string, unknown>, facts: Record<string, unknown>) => {
      const place = placeWords(
        placeInvoice(revenue, {
          sort: (facts.sort as string | null) ?? null,
          line_id: (facts.line_id as string | null) ?? null,
          split: facts.split ?? null,
          customer_ref: (r.customer_ref as string | null) ?? null,
          customer: (r.customer as string | null) ?? null,
          lines: (Array.isArray(r.lines) ? (r.lines as Record<string, unknown>[]) : []).map(
            (l) => ({
              account_ref: (l.account_ref as string | null) ?? null,
              account: (l.account as string | null) ?? null,
              cents: Number(l.cents ?? 0) || 0,
            }),
          ),
        }),
        lineName,
      );
      return `${place.line} (${place.why.toLowerCase()})`;
    };
    const label = (r: Record<string, unknown>) =>
      `Invoice ${r.doc_number ?? "with no number"} to ${r.customer ?? "no customer"}, ${r.txn_date}`;
    return {
      ...base,
      name: found.length === 1 ? label(found[0]) : `${found.length} invoices from your books`,
      before: found.map((r) => `${label(r)}: ${words(r, r)}`),
      after: found.map((r) => `${label(r)}: ${words(r, after)}`),
    };
  }
  if (row.kind === "money.budget") {
    const body = budgetBody.safeParse(row.body);
    if (!body.success) return null;
    const revenue = await loadRevenueSettings(supabase, tenant.id);
    const label = (key: string) =>
      body.data.subject === "line" ? (revenue.lines.find((l) => l.id === key)?.name ?? key) : key;
    const { data } = await supabase
      .from("money_budgets")
      .select("subject_key, amount_cents")
      .eq("tenant_id", tenant.id)
      .eq("subject", body.data.subject)
      .eq("month", `${body.data.month}-01`)
      .in(
        "subject_key",
        body.data.rows.map((r) => r.key),
      );
    const now = new Map(
      ((data ?? []) as { subject_key: string; amount_cents: number }[]).map((r) => [
        r.subject_key,
        Number(r.amount_cents),
      ]),
    );
    const words = (cents: number | null | undefined) =>
      cents === null || cents === undefined ? "no budget" : money(cents);
    return {
      ...base,
      name: `Budget for ${monthWords(body.data.month)}`,
      before: body.data.rows.map((r) => `${label(r.key)}: ${words(now.get(r.key))}`),
      after: body.data.rows.map((r) => `${label(r.key)}: ${words(r.amount_cents)}`),
    };
  }
  if (row.kind === "money.charge") {
    const body = chargeBody.safeParse(row.body);
    if (!body.success) return null;
    const { data } = await supabase
      .from("money_charge_decisions")
      .select("decision, note")
      .eq("tenant_id", tenant.id)
      .eq("charge_key", body.data.key)
      .maybeSingle();
    const now = (data as { decision?: string; note?: string | null } | null) ?? null;
    const words = (decision: string | null | undefined, note: string | null | undefined) =>
      decision
        ? `${DECISION_WORDS[decision as keyof typeof DECISION_WORDS] ?? decision}${note ? `: “${note}”` : ""}`
        : "Not decided";
    return {
      ...base,
      name: `Cost cutter: ${body.data.payee}`,
      before: [words(now?.decision, now?.note)],
      after: [words(body.data.decision, body.data.note)],
    };
  }
  if (!row.target) return null;
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
  row: { kind: string; target: string | null; body: unknown },
): Promise<{ error?: string }> {
  const plain = (error: { message: string } | null) =>
    error ? { error: "That didn't apply. Please try again." } : {};
  const misfit = { error: "This suggestion doesn't fit any more." };
  switch (row.kind) {
    case "money.expense_sort": {
      const change = actionSchema.safeParse(row.body);
      if (!change.success || !row.target) return misfit;
      const { data, error } = await supabase.rpc("sort_book_expenses", {
        p_tenant_id: tenantId,
        p_ids: [row.target],
        p_sort: change.data.sort,
        p_line: change.data.sort === "line" ? change.data.line : null,
        p_split: change.data.sort === "split" ? change.data.split : null,
      });
      if (error?.code === "22023") return { error: `${error.message}.` };
      if (!error && data === 0) return { error: "That expense is gone from your books." };
      return plain(error);
    }
    case "money.invoice_sort": {
      const body = invoiceSortBody.safeParse(row.body);
      if (!body.success) return misfit;
      const { data, error } = await supabase.rpc("sort_book_invoices", {
        p_tenant_id: tenantId,
        p_ids: body.data.invoices,
        ...invoiceSortArgs(body.data.choice),
      });
      if (error?.code === "22023") return { error: `${error.message}.` };
      if (!error && data === 0 && body.data.choice.sort !== "none") {
        return { error: "Those invoices are gone from your books." };
      }
      return plain(error);
    }
    case "money.budget": {
      const body = budgetBody.safeParse(row.body);
      if (!body.success) return misfit;
      const { error } = await supabase.rpc("set_money_budgets", {
        p_tenant_id: tenantId,
        p_month: `${body.data.month}-01`,
        p_rows: body.data.rows.map((r) => ({ subject: body.data.subject, ...r })),
      });
      return error?.code === "22023" ? { error: `${error.message}.` } : plain(error);
    }
    case "money.charge": {
      const body = chargeBody.safeParse(row.body);
      if (!body.success) return misfit;
      const { error } = await supabase.rpc("decide_money_charge", {
        p_tenant_id: tenantId,
        p_key: body.data.key,
        p_decision: body.data.decision,
        p_note: body.data.note,
        p_payee: body.data.payee,
        p_monthly_cents: body.data.monthly_cents,
      });
      return plain(error);
    }
  }
  if (!row.target) return { error: "That kind of suggestion can't be applied here." };
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
