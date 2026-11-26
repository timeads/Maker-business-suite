import type Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadRevenueSettings } from "../dashboard/data";
import { debtBasicsSchema, type DebtBasics } from "../dashboard/debt/basics";
import { DEBT_KIND_WORDS, bpWords, percentToBp, type DebtKind } from "../dashboard/debt/settings";
import { liabilityTypeWords } from "../dashboard/debt/books";
import { mergeAccounts, readAccountRows, yearBefore } from "../dashboard/expense-accounts";
import { MONEY_TOOL, moneySetupItems } from "../dashboard/setup";
import { loadMoneySetupFacts } from "../dashboard/setup-data";
import { loadNotNow } from "../setup/data";
import { sortItems } from "../setup/items";
import type { Proposal, ToolContext, ToolOutcome } from "./tools";

/**
 * The assistant's reach into Money beyond its settings (CLAUDE.md rule 5).
 * Reads run as the member. The only writes are proposals
 * (`propose_action`): a debt's basics, which plan pays a debt, whether a
 * liability in the books is a debt or hidden. A person sees a preview and an
 * owner or admin applies it, through the same checked function a page uses.
 *
 * Debts are for owners and admins only: the debt tools aren't offered to
 * anyone else, refuse if called, and row-level security hands them nothing
 * anyway. The model never sees an id: debts and the books' accounts are
 * `D1…` / `L1…`, mapped back here from a fresh read.
 */

export const MONEY_TOOLS: Anthropic.Tool[] = [
  {
    name: "money_setup_status",
    description:
      "What's still left to set up in Money for this workspace, each with why it matters and the page (inside the workspace) where it's done. Use it when someone asks what to fine-tune, why a figure looks off, or where to change something.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_expense_accounts",
    description:
      "The books' expense accounts, biggest over the last twelve months first: each one's ref (the books' own id, or null) and exact name, as the 'Money: sorting expenses into lines' setting needs them in its accounts list. Call it before proposing an account choice such as 'sort the rent account as shared'.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

/** Owners and admins only. */
export const DEBT_TOOLS: Anthropic.Tool[] = [
  {
    name: "list_debts",
    description:
      "The business's debts (cards, loans, lines of credit, plans that pay other debts), each as a reference D1, D2… with what's owed, its rate, minimum and usual payment, and the liabilities in the books as L1, L2… with whether each counts as a debt. References last for this conversation turn: call this before proposing anything about a debt.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "propose_debt_change",
    description:
      'Proposes a debt\'s rate, minimum, usual payment or due day ("my line of credit is 10%"). Only give what changes. Nothing changes until an owner or admin applies it. Not for a plan that pays other debts.',
    input_schema: {
      type: "object",
      properties: {
        debt: { type: "string", description: "The debt's reference from list_debts, like D2." },
        rate_percent: {
          type: ["number", "null"],
          description: "Yearly rate as a percent, like 22.99; null for 'not known'.",
        },
        minimum: { type: "number", description: "Minimum payment a month, in dollars." },
        payment: {
          type: ["number", "null"],
          description: "Usual payment a month in dollars if more than the minimum; null clears it.",
        },
        due_day: { type: ["integer", "null"], description: "Day of the month it's due, 1–31." },
        summary: { type: "string", description: "One plain sentence for the person approving." },
      },
      required: ["debt", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_debt_cover",
    description:
      "Proposes that a plan (a debt marked as a plan in list_debts, a company that pays several debts) pays a debt, or that a debt stops being paid through its plan (plan null).",
    input_schema: {
      type: "object",
      properties: {
        debt: { type: "string", description: "The debt's reference, like D3." },
        plan: { type: ["string", "null"], description: "The plan's reference, or null." },
        summary: { type: "string" },
      },
      required: ["debt", "plan", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_liability_choice",
    description:
      "Proposes, for one liability in the books (L1…): count it as a debt, say it isn't a debt, let the debt setting decide again, or hide it from / show it on the 'Also in your books' list (hiding changes nothing else).",
    input_schema: {
      type: "object",
      properties: {
        account: { type: "string", description: "The liability's reference, like L4." },
        choice: { type: "string", enum: ["debt", "not_debt", "rule", "hide", "show"] },
        summary: { type: "string" },
      },
      required: ["account", "choice", "summary"],
      additionalProperties: false,
    },
  },
];

export const MONEY_TOOL_NAMES = new Set([...MONEY_TOOLS, ...DEBT_TOOLS].map((t) => t.name));
const DEBT_TOOL_NAMES = new Set(DEBT_TOOLS.map((t) => t.name));

const json = (value: unknown) => JSON.stringify(value);
const fail = (message: string): ToolOutcome => ({ content: message, isError: true });
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

type RefDebt = {
  id: string;
  name: string;
  kind: string;
  plan: string;
  status: string;
  rate_bp: number | null;
  minimum_cents: number;
  payment_cents: number | null;
  due_day: number | null;
  source: string;
  consolidated: boolean;
  covered_by: string | null;
  book_account_id: string | null;
};
type RefAccount = {
  id: string;
  name: string;
  type: string;
  balance: number;
  choice: string | null;
  hidden: boolean;
};

/** Debts and the books' liabilities, in the order their references are given. */
export async function loadDebtRefs(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<{ debts: RefDebt[]; accounts: RefAccount[] }> {
  const [debts, accounts] = await Promise.all([
    supabase
      .from("money_debts")
      .select(
        "id, name, kind, plan, status, rate_bp, minimum_cents, payment_cents, due_day, source, consolidated, covered_by, book_account_id",
      )
      .eq("tenant_id", tenantId)
      .is("left_out_at", null)
      .order("name")
      .order("id")
      .limit(200),
    supabase
      .from("money_book_accounts")
      .select("id, name, account_type, account_subtype, section, balance_cents, choice, hidden_at")
      .eq("tenant_id", tenantId)
      .is("gone_at", null)
      .order("name")
      .order("id")
      .limit(200),
  ]);
  if (debts.error || accounts.error) throw new Error("Could not read the debts");
  return {
    debts: ((debts.data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      kind: String(r.kind),
      plan: String(r.plan),
      status: String(r.status),
      rate_bp: num(r.rate_bp),
      minimum_cents: num(r.minimum_cents) ?? 0,
      payment_cents: num(r.payment_cents),
      due_day: num(r.due_day),
      source: String(r.source),
      consolidated: r.consolidated === true,
      covered_by: (r.covered_by as string | null) ?? null,
      book_account_id: (r.book_account_id as string | null) ?? null,
    })),
    accounts: ((accounts.data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      type: liabilityTypeWords({
        type: (r.account_type as string | null) ?? null,
        subtype: (r.account_subtype as string | null) ?? null,
        section: (r.section as string | null) ?? null,
      }),
      balance: num(r.balance_cents) ?? 0,
      choice: (r.choice as string | null) ?? null,
      hidden: r.hidden_at !== null && r.hidden_at !== undefined,
    })),
  };
}

const refOf = <T extends { id: string }>(
  prefix: "D" | "L",
  list: readonly T[],
  ref: unknown,
): T | null => {
  const match = typeof ref === "string" ? /^([DL])(\d{1,3})$/.exec(ref.trim().toUpperCase()) : null;
  if (!match || match[1] !== prefix) return null;
  return list[Number(match[2]) - 1] ?? null;
};

/** Dollars from the model, as whole cents; null when it isn't an amount. */
const dollars = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 1e9
    ? Math.round(value * 100)
    : null;

async function propose(
  ctx: ToolContext,
  kind: string,
  target: string,
  body: Record<string, unknown>,
  summary: string,
  name: string,
): Promise<ToolOutcome> {
  const { data, error } = await ctx.supabase.rpc("propose_action", {
    p_tenant_id: ctx.tenant.id,
    p_kind: kind,
    p_target: target,
    p_body: body,
    p_summary: summary,
  });
  if (error || typeof data !== "string") return fail("The proposal couldn't be saved.");
  const proposal: Proposal = {
    id: data,
    source: "action",
    module: "money",
    key: kind,
    name,
    summary: summary.slice(0, 500),
  };
  return {
    content:
      "Proposal filed. Nothing has changed yet: the person now sees a preview and an owner or admin decides whether to apply it. Tell them briefly what you proposed.",
    proposal,
  };
}

/** One Money tool; undefined when the name isn't one of them. */
export async function runMoneyTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome | undefined> {
  if (!MONEY_TOOL_NAMES.has(name)) return undefined;
  // For anyone but owners and admins, the debt tools don't exist.
  if (DEBT_TOOL_NAMES.has(name) && !ctx.manager) return fail(`There is no tool called ${name}.`);
  if (!ctx.can("dashboard")) return fail("Money isn't part of this workspace's plan.");
  const summary = typeof args.summary === "string" ? args.summary.trim() : "";

  switch (name) {
    case "money_setup_status": {
      const revenue = await loadRevenueSettings(ctx.supabase, ctx.tenant.id);
      const [facts, notNow] = await Promise.all([
        loadMoneySetupFacts(ctx.supabase, ctx.tenant, { manager: ctx.manager, revenue }),
        ctx.manager ? loadNotNow(ctx.supabase, ctx.tenant.id, MONEY_TOOL) : Promise.resolve([]),
      ]);
      const { open, resting } = sortItems(moneySetupItems(facts), notNow);
      const shown = (item: (typeof open)[number]) => ({
        what: item.title,
        why: item.why,
        where: `/w/${ctx.tenant.slug ?? "<workspace>"}/${item.to}`,
        link_words: item.action,
      });
      return {
        content: json({
          open: open.map(shown),
          said_not_now: resting.map((i) => i.title),
          guided_setup: `/w/${ctx.tenant.slug ?? "<workspace>"}/dashboard/setup`,
          note: open.length === 0 ? "Nothing left to set up." : undefined,
        }),
      };
    }

    case "list_expense_accounts": {
      const now = new Date().toISOString().slice(0, 10);
      const { data, error } = await ctx.supabase.rpc("money_expense_accounts", {
        p_tenant_id: ctx.tenant.id,
        p_since: yearBefore(now),
      });
      if (error) return fail("The accounts couldn't be read just now.");
      const accounts = mergeAccounts(readAccountRows((data as Record<string, unknown>[]) ?? []))
        .filter((a) => a.name !== null)
        .slice(0, 80);
      return {
        content: json({
          currency: ctx.tenant.currency,
          accounts: accounts.map((a) => ({
            ref: a.ref,
            name: a.name,
            last_twelve_months: (a.recentCents / 100).toFixed(2),
            expenses: a.recent,
          })),
        }),
      };
    }

    case "list_debts": {
      const { debts, accounts } = await loadDebtRefs(ctx.supabase, ctx.tenant.id);
      const debtRef = new Map(debts.map((d, i) => [d.id, `D${i + 1}`]));
      const counted = new Set(debts.map((d) => d.book_account_id).filter(Boolean));
      return {
        content: json({
          currency: ctx.tenant.currency,
          debts: debts.map((d) => ({
            ref: debtRef.get(d.id),
            name: d.name,
            kind: d.consolidated
              ? "a plan that pays other debts"
              : (DEBT_KIND_WORDS[d.kind as DebtKind] ?? d.kind),
            status: d.status,
            from_books: d.source === "books",
            rate: d.rate_bp === null ? "not given" : bpWords(d.rate_bp),
            minimum: (d.minimum_cents / 100).toFixed(2),
            usual_payment: d.payment_cents === null ? null : (d.payment_cents / 100).toFixed(2),
            due_day: d.due_day,
            paid_through_plan: d.covered_by ? (debtRef.get(d.covered_by) ?? "a plan") : null,
          })),
          liabilities_in_books: accounts.map((a, i) => ({
            ref: `L${i + 1}`,
            name: a.name,
            books_call_it: a.type,
            balance: (a.balance / 100).toFixed(2),
            counts_as_debt: counted.has(a.id),
            person_said:
              a.choice === "not_debt" ? "not a debt" : a.choice === "debt" ? "a debt" : null,
            hidden_from_list: a.hidden,
          })),
          note: "Balances come from the books and can't be changed here.",
        }),
      };
    }

    case "propose_debt_change": {
      if (!summary) return fail("Add a one-sentence summary of what would change.");
      const { debts } = await loadDebtRefs(ctx.supabase, ctx.tenant.id);
      const debt = refOf("D", debts, args.debt);
      if (!debt) return fail("There's no such debt. Call list_debts for the references.");
      if (debt.consolidated) {
        return fail(
          "That's a plan that pays other debts; its details are changed on Money → Debts.",
        );
      }
      const change: Record<string, unknown> = {};
      if ("rate_percent" in args) {
        if (args.rate_percent === null) change.rate_bp = null;
        else {
          const bp =
            typeof args.rate_percent === "number" ? percentToBp(String(args.rate_percent)) : null;
          if (bp === null) return fail("Give the rate as a percent, like 22.99.");
          change.rate_bp = bp;
        }
      }
      if ("minimum" in args) {
        const c = dollars(args.minimum);
        if (c === null) return fail("Give the minimum in dollars, like 35.");
        change.minimum_cents = c;
      }
      if ("payment" in args) {
        if (args.payment === null) change.payment_cents = null;
        else {
          const c = dollars(args.payment);
          if (c === null) return fail("Give the payment in dollars, like 150.");
          change.payment_cents = c;
        }
      }
      if ("due_day" in args) change.due_day = args.due_day;
      const checked = debtBasicsSchema.safeParse(change);
      if (!checked.success)
        return fail("That doesn't change anything, or a figure is out of range.");
      return propose(
        ctx,
        "money.debt_details",
        debt.id,
        checked.data as DebtBasics,
        summary,
        `Debt: ${debt.name}`,
      );
    }

    case "propose_debt_cover": {
      if (!summary) return fail("Add a one-sentence summary of what would change.");
      const { debts } = await loadDebtRefs(ctx.supabase, ctx.tenant.id);
      const debt = refOf("D", debts, args.debt);
      if (!debt || debt.consolidated) {
        return fail("Name a debt that isn't itself a plan. Call list_debts for the references.");
      }
      const plan = args.plan === null ? null : refOf("D", debts, args.plan);
      if (args.plan !== null && (!plan || !plan.consolidated)) {
        return fail("That isn't a plan. Plans are marked in list_debts.");
      }
      return propose(
        ctx,
        "money.debt_cover",
        debt.id,
        { plan_id: plan?.id ?? null },
        summary,
        `Debt: ${debt.name}`,
      );
    }

    case "propose_liability_choice": {
      if (!summary) return fail("Add a one-sentence summary of what would change.");
      const { accounts } = await loadDebtRefs(ctx.supabase, ctx.tenant.id);
      const account = refOf("L", accounts, args.account);
      if (!account) return fail("There's no such liability. Call list_debts for the references.");
      const choice = String(args.choice);
      if (!["debt", "not_debt", "rule", "hide", "show"].includes(choice)) {
        return fail("Choose debt, not_debt, rule, hide or show.");
      }
      const hide = choice === "hide" || choice === "show";
      return propose(
        ctx,
        hide ? "money.liability_hide" : "money.liability_choice",
        account.id,
        hide ? { hidden: choice === "hide" } : { choice },
        summary,
        `In your books: ${account.name}`,
      );
    }
  }
  return undefined;
}
