import { accountChoiceFor, type AccountChoice, type ExpenseSorting } from "./expenses";

/**
 * The books' expense accounts as the account sorter lists them (Settings →
 * Money → Sorting expenses), from `money_expense_accounts`. Pure.
 */

export type BookAccount = {
  /** The books' own id for the account, when the expenses carry one. */
  ref: string | null;
  /** The latest name the books used; null for expenses filed under no account. */
  name: string | null;
  /** In the last twelve months. */
  recent: number;
  recentCents: number;
  all: number;
  /** Waiting in the inbox. */
  toSort: number;
  /** Sorted by the account's choice. */
  byAccount: number;
  /** Sorted some other way by a person, a rule or a payee default. */
  exceptions: number;
  lastDay: string | null;
};

const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
};

/** The database's rows, read. */
export function readAccountRows(rows: readonly Record<string, unknown>[]): BookAccount[] {
  return rows.map((row) => ({
    ref: typeof row.account_ref === "string" && row.account_ref ? row.account_ref : null,
    name: typeof row.account === "string" && row.account.trim() ? row.account : null,
    recent: num(row.recent),
    recentCents: num(row.recent_cents),
    all: num(row.all_count),
    toSort: num(row.to_sort),
    byAccount: num(row.by_account),
    exceptions: num(row.exceptions),
    lastDay: typeof row.last_day === "string" ? row.last_day.slice(0, 10) : null,
  }));
}

/**
 * One row per account: expenses read before the books' ids were kept are
 * listed under their name, and folded into the account of the same name
 * that has an id (only when exactly one such account has it, never a guess
 * between two). Biggest first over the last twelve months, then by name.
 */
export function mergeAccounts(rows: readonly BookAccount[]): BookAccount[] {
  const withId = rows.filter((row) => row.ref !== null).map((row) => ({ ...row }));
  const out: BookAccount[] = [...withId];
  for (const row of rows) {
    if (row.ref !== null) continue;
    const same = row.name === null ? [] : withId.filter((a) => a.name === row.name);
    if (same.length === 1) {
      const into = same[0];
      into.recent += row.recent;
      into.recentCents += row.recentCents;
      into.all += row.all;
      into.toSort += row.toSort;
      into.byAccount += row.byAccount;
      into.exceptions += row.exceptions;
      if (row.lastDay && (!into.lastDay || row.lastDay > into.lastDay)) into.lastDay = row.lastDay;
    } else {
      out.push({ ...row });
    }
  }
  return out.sort(
    (a, b) =>
      b.recentCents - a.recentCents ||
      b.recent - a.recent ||
      (a.name ?? "").localeCompare(b.name ?? ""),
  );
}

/** The key the sorter's form and the setting use for an account. */
export const accountKey = (account: { ref: string | null; name: string | null }) =>
  account.ref ? `r:${account.ref}` : `n:${account.name ?? ""}`;

/** The stored choice for a listed account, if any. */
export const choiceOf = (
  settings: Pick<ExpenseSorting, "accounts">,
  account: BookAccount,
): AccountChoice | null => accountChoiceFor(settings, account);

export type AccountsSummary = {
  /** Accounts in the books. */
  accounts: number;
  /** Accounts with no choice yet: counted as shared. */
  automatic: number;
  /** Accounts set to "decide each one". */
  eachOne: number;
  /** Expenses waiting in the inbox. */
  waiting: number;
};

export function accountsSummary(
  settings: Pick<ExpenseSorting, "accounts">,
  accounts: readonly BookAccount[],
): AccountsSummary {
  let automatic = 0;
  let eachOne = 0;
  for (const account of accounts) {
    const choice = choiceOf(settings, account);
    if (!choice) automatic++;
    else if (choice.action.sort === "each") eachOne++;
  }
  return {
    accounts: accounts.length,
    automatic,
    eachOne,
    waiting: accounts.reduce((sum, a) => sum + a.toSort, 0),
  };
}

/**
 * The account list as the sorter saves it: the choices made on screen for
 * the accounts listed (`null`: back to the automatic default), and every
 * stored choice for an account not listed (one the books no longer use)
 * kept as it was.
 */
export function nextAccountChoices(
  stored: readonly AccountChoice[],
  listed: readonly BookAccount[],
  picked: ReadonlyMap<string, AccountChoice["action"] | null>,
): AccountChoice[] {
  const settings = { accounts: [...stored] };
  const shown = new Set<AccountChoice>();
  const out: AccountChoice[] = [];
  for (const account of listed) {
    if (!account.name) continue;
    const existing = accountChoiceFor(settings, account);
    if (existing) shown.add(existing);
    const key = accountKey(account);
    const action = picked.has(key) ? picked.get(key)! : (existing?.action ?? null);
    if (action) out.push({ ref: account.ref, name: account.name, action });
  }
  for (const choice of stored) if (!shown.has(choice)) out.push(choice);
  return out;
}

/** The day twelve months before a local day, `YYYY-MM-DD` (29 February goes to the 28th). */
export function yearBefore(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  const last = new Date(Date.UTC(year - 1, month, 0)).getUTCDate();
  return `${year - 1}-${String(month).padStart(2, "0")}-${String(Math.min(date, last)).padStart(2, "0")}`;
}
