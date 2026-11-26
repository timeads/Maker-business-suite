import { z } from "zod";
import { DASHBOARD_MODULE } from "./schema";

/**
 * Sorting the books' expenses into the business's own lines.
 *
 * An expense can be put on one line, split across lines by percent, marked
 * shared (overhead, shared out by the profit setting's split), or set aside
 * (not a business expense, or personal). Mostly that follows the books' own
 * ACCOUNT: one choice per account sorts every expense in it, past and
 * future, and an account with no choice yet counts as shared. Payee defaults
 * and rules (this config, `dashboard` / `expenses`) make exceptions, and a
 * person's own choice in the expense inbox beats everything. Only an account
 * set to "decide each one" fills the inbox.
 *
 * Nothing about any one business lives here: payees, accounts and words are
 * all the workspace's own setting. Pure: no network, no database.
 */
export const EXPENSES_MODULE = DASHBOARD_MODULE;
export const EXPENSES_KEY = "expenses";

const id = z.string().regex(/^[a-z0-9-]{1,40}$/);

export const SORTS = ["line", "split", "shared", "set_aside"] as const;
export type Sort = (typeof SORTS)[number];

/** Whole percents per line id, at least two lines, adding up to 100. */
export const splitSchema = z
  .record(id, z.number().int().min(1).max(100))
  .refine((split) => Object.keys(split).length >= 2, {
    message: "A split needs at least two lines",
  })
  .refine((split) => Object.values(split).reduce((a, b) => a + b, 0) === 100, {
    message: "The shares of a split must add up to 100%",
  });
export type Split = z.infer<typeof splitSchema>;

export const actionSchema = z.discriminatedUnion("sort", [
  z.object({ sort: z.literal("line"), line: id }),
  z.object({ sort: z.literal("split"), split: splitSchema }),
  z.object({ sort: z.literal("shared") }),
  z.object({ sort: z.literal("set_aside") }),
]);
export type SortAction = z.infer<typeof actionSchema>;

export const RULE_FIELDS = ["payee", "account", "memo", "class", "location"] as const;
export type RuleField = (typeof RULE_FIELDS)[number];

/** What each kind of rule looks at, in a maker's words. */
export const RULE_WORDS: Record<RuleField, { label: string; hint: string }> = {
  payee: { label: "The payee's name contains", hint: "A word or part of a name" },
  account: { label: "The QuickBooks account is", hint: "The account's name, as QuickBooks has it" },
  memo: {
    label: "The memo or a line's description contains",
    hint: "A word that turns up in the memo",
  },
  class: { label: "The QuickBooks class is", hint: "The class's name, as QuickBooks has it" },
  location: {
    label: "The QuickBooks location is",
    hint: "The location's name, as QuickBooks has it",
  },
};

const words = z.string().trim().min(1).max(120);

export const vendorDefaultSchema = z.object({
  id,
  /** The payee's name as the books have it; capitals and spacing don't matter. */
  payee: words,
  action: actionSchema,
  /** On: new expenses from this payee are sorted by themselves. Off: only suggested. */
  fill_in: z.boolean().default(true),
});
export type VendorDefault = z.infer<typeof vendorDefaultSchema>;

export const expenseRuleSchema = z.object({
  id,
  field: z.enum(RULE_FIELDS),
  words,
  action: actionSchema,
  fill_in: z.boolean().default(true),
  /**
   * Checked before the payee defaults, for the times one payee has two kinds
   * of charge (a card that is also a loan, say). Otherwise rules come after.
   */
  firm: z.boolean().default(false),
});
export type ExpenseRule = z.infer<typeof expenseRuleSchema>;

/** What an account's expenses do: one way of sorting, or "decide each one" (the inbox). */
export const accountActionSchema = z.union([actionSchema, z.object({ sort: z.literal("each") })]);
export type AccountAction = z.infer<typeof accountActionSchema>;

/** The books' own id for an account, as the sync keeps it. */
export const ACCOUNT_REF = /^[A-Za-z0-9_-]{1,60}$/;

export const accountChoiceSchema = z.object({
  /** The books' own id for the account, where the books gave one: the key. */
  ref: z.string().regex(ACCOUNT_REF).nullable().default(null),
  /** The account's name as the books have it: shown to people, and the key without an id. */
  name: z.string().trim().min(1).max(200),
  action: accountActionSchema,
});
export type AccountChoice = z.infer<typeof accountChoiceSchema>;

export const expenseSortingSchema = z
  .object({
    version: z.literal(1),
    vendors: z.array(vendorDefaultSchema).max(300).default([]),
    /** Checked from the top; the first that matches decides. */
    rules: z.array(expenseRuleSchema).max(100).default([]),
    /**
     * One choice per account in the books. An account not listed counts as
     * shared. Applied in the database (`private.money_follow_accounts`), the
     * twin of `decideExpense`'s last step.
     */
    accounts: z.array(accountChoiceSchema).max(1000).default([]),
  })
  .superRefine((value, ctx) => {
    const refs = value.accounts.flatMap((a) => (a.ref ? [a.ref] : []));
    const names = value.accounts.flatMap((a) => (a.ref ? [] : [a.name]));
    if (new Set(refs).size !== refs.length || new Set(names).size !== names.length) {
      ctx.addIssue({
        code: "custom",
        path: ["accounts"],
        message: "Each account can have only one choice",
      });
    }
    const ids = [...value.vendors.map((v) => v.id), ...value.rules.map((r) => r.id)];
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", path: ["rules"], message: "Each rule needs its own id" });
    }
    const payees = value.vendors.map((v) => sameName(v.payee));
    if (new Set(payees).size !== payees.length) {
      ctx.addIssue({
        code: "custom",
        path: ["vendors"],
        message: "Each payee can have only one default",
      });
    }
  });
export type ExpenseSorting = z.infer<typeof expenseSortingSchema>;

export const DEFAULT_EXPENSE_SORTING: ExpenseSorting = {
  version: 1,
  vendors: [],
  rules: [],
  accounts: [],
};

export function parseExpenseSorting(body: unknown): ExpenseSorting {
  const parsed = expenseSortingSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_EXPENSE_SORTING;
}

/** How names and words are compared: capitals, outer spaces and runs of spaces don't matter. */
export function sameName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Which way an expense goes
// ---------------------------------------------------------------------------

/** What a rule can look at on one expense. */
export type ExpenseFacts = {
  payee: string | null;
  /** The main account and every line's. */
  accounts: readonly (string | null)[];
  memo: string | null;
  descriptions: readonly string[];
  /** The books' id for the main account (the first line's), when known. */
  accountRef?: string | null;
  /** The books' class on each line (QuickBooks' own tracking), where there is one. */
  classes?: readonly (string | null)[];
  /** The books' location for the whole record, where there is one. */
  location?: string | null;
};

/** Does every line an action names still exist? An action on a removed line is skipped. */
export function actionFits(action: SortAction, lineIds: ReadonlySet<string>): boolean {
  if (action.sort === "line") return lineIds.has(action.line);
  if (action.sort === "split") return Object.keys(action.split).every((key) => lineIds.has(key));
  return true;
}

function ruleMatches(rule: ExpenseRule, facts: ExpenseFacts): boolean {
  const wanted = sameName(rule.words);
  if (!wanted) return false;
  switch (rule.field) {
    case "payee":
      return facts.payee !== null && sameName(facts.payee).includes(wanted);
    case "account":
      return facts.accounts.some((account) => account !== null && sameName(account) === wanted);
    case "memo":
      return [facts.memo ?? "", ...facts.descriptions].some((text) =>
        sameName(text).includes(wanted),
      );
    case "class":
      return (facts.classes ?? []).some((name) => name !== null && sameName(name) === wanted);
    case "location":
      return facts.location != null && sameName(facts.location) === wanted;
  }
}

/**
 * The choice stored for an account: by the books' id where both sides have
 * one, else by the exact name (where either side has no id). Null when the
 * account has no choice yet.
 */
export function accountChoiceFor(
  settings: Pick<ExpenseSorting, "accounts">,
  account: { ref: string | null; name: string | null },
): AccountChoice | null {
  const name = account.name?.trim() ?? "";
  const byRef = account.ref
    ? settings.accounts.find((choice) => choice.ref === account.ref)
    : undefined;
  if (byRef) return byRef;
  if (!name) return null;
  return (
    settings.accounts.find(
      (choice) => (choice.ref === null || account.ref === null) && choice.name === name,
    ) ?? null
  );
}

/** An account with no choice yet counts as shared. */
export const ACCOUNT_DEFAULT: SortAction = { sort: "shared" };

export type Decision = {
  action: SortAction;
  source: "rule" | "vendor" | "account";
  /** The rule or default that decided. */
  ruleId: string;
  /** Sort it now, or only suggest. */
  fillIn: boolean;
  reason: string;
};

/**
 * Which way an expense goes: firm rules first, then the payee's default,
 * then the other rules, each list from the top, then the account's choice
 * (an account with no choice yet: shared). A rule pointing at a line that no
 * longer exists is passed over, and so is an account's choice (it falls back
 * to shared). Null when the account is set to "decide each one" and nothing
 * else matches: the expense waits in the inbox.
 *
 * Only ever used for expenses no person has sorted: a person's own choice
 * always beats all of this, and the database re-checks that under the row.
 */
export function decideExpense(
  settings: ExpenseSorting,
  lineIds: ReadonlySet<string>,
  facts: ExpenseFacts,
): Decision | null {
  const byRule = (rule: ExpenseRule): Decision => ({
    action: rule.action,
    source: "rule",
    ruleId: rule.id,
    fillIn: rule.fill_in,
    reason: `${RULE_WORDS[rule.field].label} “${rule.words}”`,
  });
  const usable = settings.rules.filter((rule) => actionFits(rule.action, lineIds));
  const firm = usable.find((rule) => rule.firm && ruleMatches(rule, facts));
  if (firm) return byRule(firm);
  if (facts.payee) {
    const payee = sameName(facts.payee);
    const vendor = settings.vendors.find(
      (v) => sameName(v.payee) === payee && actionFits(v.action, lineIds),
    );
    if (vendor) {
      return {
        action: vendor.action,
        source: "vendor",
        ruleId: vendor.id,
        fillIn: vendor.fill_in,
        reason: `Your default for ${vendor.payee}`,
      };
    }
  }
  const soft = usable.find((rule) => !rule.firm && ruleMatches(rule, facts));
  if (soft) return byRule(soft);
  return decideByAccount(settings, lineIds, facts);
}

/** The last step on its own: what the account's choice says. */
export function decideByAccount(
  settings: Pick<ExpenseSorting, "accounts">,
  lineIds: ReadonlySet<string>,
  facts: Pick<ExpenseFacts, "accounts" | "accountRef">,
): Decision | null {
  const name = facts.accounts[0] ?? null;
  const choice = accountChoiceFor(settings, { ref: facts.accountRef ?? null, name });
  const words = name ? `the account ${name}` : "an expense with no account";
  if (choice?.action.sort === "each") return null;
  if (choice && actionFits(choice.action, lineIds)) {
    return {
      action: choice.action,
      source: "account",
      ruleId: choice.ref ?? choice.name.slice(0, 40),
      fillIn: true,
      reason: `Your choice for ${words}`,
    };
  }
  return {
    action: ACCOUNT_DEFAULT,
    source: "account",
    ruleId: "",
    fillIn: true,
    reason: `Shared, until you choose for ${words}`,
  };
}

// ---------------------------------------------------------------------------
// Shares in whole cents
// ---------------------------------------------------------------------------

/**
 * Shares an amount by whole percents in whole cents that add back up
 * exactly: each share gets its rounded-down part, and the cents left over go
 * to the largest share (the first one listed when two are equal). Works the
 * same way for a negative amount (a refund).
 */
export function splitByPercent(
  cents: number,
  shares: readonly (readonly [string, number])[],
): Map<string, number> {
  const out = new Map<string, number>();
  const clean = shares.filter(([, pct]) => Number.isFinite(pct) && pct > 0);
  const total = clean.reduce((sum, [, pct]) => sum + pct, 0);
  if (clean.length === 0 || total <= 0) return out;
  const sign = cents < 0 ? -1 : 1;
  const whole = Math.abs(Math.trunc(cents));
  let given = 0;
  for (const [key, pct] of clean) {
    const part = Math.floor((whole * pct) / total);
    out.set(key, (out.get(key) ?? 0) + part);
    given += part;
  }
  let largest = clean[0];
  for (const share of clean) if (share[1] > largest[1]) largest = share;
  out.set(largest[0], (out.get(largest[0]) ?? 0) + (whole - given));
  if (sign < 0) for (const [key, value] of out) out.set(key, value === 0 ? 0 : -value);
  return out;
}

/** An action in words, with the workspace's line names. */
export function actionWords(action: SortAction, lineName: (id: string) => string): string {
  switch (action.sort) {
    case "line":
      return lineName(action.line);
    case "split":
      return Object.entries(action.split)
        .map(([line, pct]) => `${pct}% ${lineName(line)}`)
        .join(", ");
    case "shared":
      return "Shared across lines";
    case "set_aside":
      return "Not a business expense";
  }
}

/** What the database stores for an action: its sort, line and split. */
export function actionColumns(action: SortAction): {
  sort: Sort;
  line: string | null;
  split: Split | null;
} {
  return {
    sort: action.sort,
    line: action.sort === "line" ? action.line : null,
    split: action.sort === "split" ? action.split : null,
  };
}

/** A short id for a new rule or default. */
export function newRuleId(prefix: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n++) {
    const candidate = `${prefix}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** An expense as the sync reads it, for the rules. */
export function factsOfRow(row: {
  payee: string | null;
  account: string | null;
  memo: string | null;
  account_ref?: string | null;
  location?: string | null;
  lines: readonly { account: string | null; description: string; class?: string | null }[];
}): ExpenseFacts {
  const lines = Array.isArray(row.lines) ? row.lines : [];
  return {
    payee: row.payee,
    accounts: [row.account, ...lines.map((line) => line.account)],
    memo: row.memo,
    descriptions: lines.map((line) => line.description ?? ""),
    accountRef: row.account_ref ?? null,
    classes: lines.map((line) => line.class ?? null),
    location: row.location ?? null,
  };
}

/**
 * What to hand the database with one expense: `auto` to sort it by a rule or
 * a payee default (only ever applied to an expense no person sorted), or
 * `suggest` to note a suggestion. Nothing when only the account decides: the
 * database applies the account's choice itself, so a worker on earlier code
 * gets it too.
 */
export function decisionPayload(
  settings: ExpenseSorting,
  lineIds: ReadonlySet<string>,
  facts: ExpenseFacts,
): { auto?: Record<string, unknown>; suggest?: Record<string, unknown> } {
  const decision = decideExpense(settings, lineIds, facts);
  if (!decision || decision.source === "account") return {};
  const body = {
    ...actionColumns(decision.action),
    source: decision.source,
    rule: decision.ruleId,
    reason: decision.reason,
  };
  return decision.fillIn ? { auto: body } : { suggest: body };
}
