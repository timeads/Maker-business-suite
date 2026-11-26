import type { Debt, DebtGroup } from "./figures";

/**
 * Debts paid through a plan ("consolidated" debts). A business pays one
 * amount a month to a company that pays several of its cards; in the books
 * the cards still carry the debt. Here the plan is ONE debt, and the debts
 * it covers are folded under it before anything is worked out, so the
 * totals, the payoff plan, cash health, the budget, the home card, the
 * what-if and the recommended order all see one debt and never the cards on
 * their own. The engine needs no rule of its own for it: a plan is a debt on
 * the `fixed` plan with its one payment. Pure; the database only stores who
 * covers what (`money_debts.covered_by`) and where a plan's balance comes
 * from, never a sum.
 */

export const PLAN_BALANCE_FROM = ["covered", "account", "typed"] as const;
export type PlanBalanceFrom = (typeof PLAN_BALANCE_FROM)[number];

export const PLAN_BALANCE_WORDS: Record<PlanBalanceFrom, string> = {
  covered: "The debts it pays, added up",
  account: "An account in your books",
  typed: "I'll type it in",
};

/** One of the books' liability accounts, as the fold needs it. */
export type FoldAccount = {
  id: string;
  name: string;
  /** Signed as the books show it: owed is positive, in credit is negative. */
  balance: number;
  asOf: string | null;
  gone: boolean;
};

export type DebtFold = {
  /** The debts as everything else sees them: plans whole, covered debts gone from the list. */
  debts: Debt[];
  /** Each debt folded into a plan, and that plan. */
  into: Map<string, string>;
  /** Plans with an account of their own: their payments are the moves into it alone. */
  ownPayments: Set<string>;
};

const later = (a: string | null, b: string | null) => (a && (!b || a > b) ? a : b);

/**
 * Folds covered debts (and a plan's own account, if the books counted it as
 * a debt by itself) into their plans. A plan's balance is its covered open
 * debts added up, its account's balance, or what was typed in; a covered
 * debt gone from the books (closed) drops out of the sum. Debts not covered
 * pass through untouched, in the same order.
 */
export function foldDebts(all: readonly Debt[], accounts: readonly FoldAccount[] = []): DebtFold {
  const plans = new Map(all.filter((d) => d.consolidated).map((d) => [d.id, d]));
  const byAccount = new Map(accounts.map((a) => [a.id, a]));
  const planOfAccount = new Map(
    [...plans.values()].filter((p) => p.planAccountId).map((p) => [p.planAccountId!, p.id]),
  );
  const into = new Map<string, string>();
  const covers = new Map<string, Debt[]>();
  const accountDebts = new Map<string, Debt>();
  for (const d of all) {
    if (d.consolidated) continue;
    if (d.coveredBy && plans.has(d.coveredBy)) {
      into.set(d.id, d.coveredBy);
      covers.set(d.coveredBy, [...(covers.get(d.coveredBy) ?? []), d]);
    } else if (d.bookAccountId && planOfAccount.has(d.bookAccountId)) {
      const plan = planOfAccount.get(d.bookAccountId)!;
      into.set(d.id, plan);
      accountDebts.set(plan, d);
    }
  }

  const debts: Debt[] = [];
  const ownPayments = new Set<string>();
  for (const d of all) {
    if (into.has(d.id)) continue;
    if (!d.consolidated) {
      debts.push(d);
      continue;
    }
    debts.push(foldPlan(d, covers.get(d.id) ?? [], accountDebts.get(d.id) ?? null, byAccount));
    if (d.planAccountId) ownPayments.add(d.id);
  }
  return { debts, into, ownPayments };
}

function foldPlan(
  plan: Debt,
  covered: Debt[],
  accountDebt: Debt | null,
  accounts: ReadonlyMap<string, FoldAccount>,
): Debt {
  const from = plan.planBalanceFrom ?? "covered";
  const open = covered.filter((d) => d.status !== "closed");
  const gone = covered.filter((d) => d.status === "closed");
  const known = open.filter((d) => d.balance !== null);
  const coveredSum = known.reduce((s, d) => s + Math.max(0, d.balance ?? 0), 0);
  const account = plan.planAccountId ? (accounts.get(plan.planAccountId) ?? null) : null;

  let balance = plan.balance;
  let balanceAsOf = plan.balanceAsOf;
  let balanceFrom = plan.balanceFrom;
  if (from === "covered") {
    balance = known.length > 0 ? coveredSum : null;
    balanceAsOf = known.reduce<string | null>((at, d) => later(d.balanceAsOf, at), null);
    balanceFrom =
      known.length === 0
        ? null
        : known.every((d) => d.balanceFrom === "books")
          ? "books"
          : "person";
  } else if (from === "account") {
    const live = account && !account.gone && account.asOf ? account : null;
    balance = live ? Math.max(0, live.balance) : null;
    balanceAsOf = live?.asOf ?? null;
    balanceFrom = live ? "books" : null;
  }
  const openings = open.filter((d) => d.opening !== null);
  const group: DebtGroup = {
    balanceFrom: from,
    account: account ? { id: account.id, name: account.name } : null,
    covers: [...open, ...gone],
    coveredSum,
    gone,
    accountDebt,
    differs: from !== "covered" && known.length > 0 && balance !== null && balance !== coveredSum,
  };
  return {
    ...plan,
    plan: "fixed",
    balance,
    balanceAsOf,
    balanceFrom,
    opening:
      plan.opening ??
      (openings.length > 0 ? openings.reduce((s, d) => s + (d.opening ?? 0), 0) : null),
    credit: 0,
    group,
  };
}

/**
 * Payments as the folded debts see them: a covered debt's are its plan's,
 * unless the plan has an account of its own, whose moves are then the
 * plan's payments (the moves into the cards are the plan company paying
 * them, never the business, so counting them too would count twice).
 */
export function foldPayments<T extends { debtId: string }>(
  rows: readonly T[],
  fold: Pick<DebtFold, "into" | "ownPayments">,
): T[] {
  const out: T[] = [];
  for (const row of rows) {
    const plan = fold.into.get(row.debtId);
    if (!plan) out.push(row);
    else if (!fold.ownPayments.has(plan)) out.push({ ...row, debtId: plan });
  }
  return out;
}

/** Every books account the debts already show, folded ones and plans' accounts too. */
export function shownAccountIds(debts: readonly Debt[]): Set<string> {
  const out = new Set<string>();
  const add = (d: Debt) => {
    if (d.bookAccountId) out.add(d.bookAccountId);
    if (d.planAccountId) out.add(d.planAccountId);
  };
  for (const d of debts) {
    add(d);
    d.group?.covers.forEach(add);
    if (d.group?.accountDebt) add(d.group.accountDebt);
  }
  return out;
}

/** "Covers 3 cards · their books balances add up to $X", for the plan's row. */
export function coverWords(group: DebtGroup, money: (cents: number) => string): string {
  const open = group.covers.length - group.gone.length;
  if (group.covers.length === 0) return "Doesn't pay any debts yet";
  const kinds = new Set(group.covers.map((d) => d.kind));
  const noun =
    kinds.size === 1 && kinds.has("card")
      ? open === 1
        ? "card"
        : "cards"
      : open === 1
        ? "debt"
        : "debts";
  const sum = group.covers.every((d) => d.source === "books")
    ? `their books balances add up to ${money(group.coveredSum)}`
    : `their balances add up to ${money(group.coveredSum)}`;
  return open === 0
    ? "The debts it paid have all left your books"
    : `Covers ${open} ${noun} · ${sum}`;
}
