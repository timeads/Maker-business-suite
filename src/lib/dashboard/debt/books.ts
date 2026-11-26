import { toCents } from "../lines";
import type { DebtKind } from "./settings";

/**
 * Which of the books' liabilities are debts, and what kind. Pure.
 *
 * The balance sheet's liabilities hold debts to pay down (cards, loans,
 * lines of credit) beside things that aren't (bills owed to suppliers,
 * sales tax and payroll owed, gift cards, deposits). This decides by the
 * books' own account type and detail type (the chart of accounts:
 * `AccountType`, `AccountSubType`) or, where those weren't read, by the
 * balance sheet section the line sits in. NEVER by an account, bank or
 * lender name: what counts is the workspace's `books_debt_types` list.
 */

/** What counts by itself unless the workspace's setting says otherwise. */
export const DEFAULT_BOOKS_DEBT_TYPES = [
  "Credit Card",
  "Long Term Liability",
  "Line Of Credit",
  "Loan Payable",
  "Notes Payable",
] as const;

/**
 * The balance sheet report's liability sections and the account type each
 * holds, for a read where the chart of accounts couldn't be had. The fourth
 * holds debts and non-debts alike, so it only counts if the setting names
 * that whole type.
 */
export const SECTION_TYPES: Record<string, string> = {
  AP: "Accounts Payable",
  CreditCards: "Credit Card",
  OtherCurrentLiabilities: "Other Current Liability",
  LongTermLiabilities: "Long Term Liability",
};

/** Type names compared as letters and digits only: "Credit Card" = "CreditCard". */
export const typeKey = (value: string | null | undefined) =>
  (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** A liability line from the balance sheet report. */
export type SheetLiability = {
  /** The books' id for the account, where the report gave one. */
  id: string | null;
  name: string;
  cents: number;
  /** The report section it sat in (`CreditCards`, `LongTermLiabilities`, …). */
  section: string | null;
};

/** A liability account from the chart of accounts. */
export type ChartAccount = {
  id: string;
  name: string;
  type: string | null;
  subtype: string | null;
  /** The chart's own balance, used only when the balance sheet has no line for it. */
  cents: number | null;
};

/** One liability as the sync hands it over. */
export type BookLiability = {
  id: string | null;
  name: string;
  cents: number;
  /** The books' account type; null when the chart of accounts wasn't read. */
  type: string | null;
  subtype: string | null;
  section: string | null;
};

/** The type a liability has, or the one its section stands for. */
const typeOf = (l: Pick<BookLiability, "type" | "section">) =>
  l.type ?? (l.section ? (SECTION_TYPES[l.section] ?? null) : null);

/** Does the workspace's rule count this liability as a debt by itself? */
export function countsAsDebt(
  l: Pick<BookLiability, "type" | "subtype" | "section">,
  types: readonly string[],
): boolean {
  const wanted = new Set(types.map(typeKey).filter(Boolean));
  return [typeOf(l), l.subtype].some((t) => t !== null && wanted.has(typeKey(t)));
}

/** The kind of debt it would be, from its type. */
export function debtKindOf(l: Pick<BookLiability, "type" | "subtype" | "section">): DebtKind {
  const type = typeKey(typeOf(l));
  const sub = typeKey(l.subtype);
  if (sub === "lineofcredit") return "line_of_credit";
  if (type === "creditcard") return "card";
  if (type === "longtermliability" || sub === "loanpayable" || sub.endsWith("notespayable")) {
    return "loan";
  }
  return "other";
}

/** Words for a person: what the books call it. */
export function liabilityTypeWords(l: Pick<BookLiability, "type" | "subtype" | "section">) {
  const spaced = (value: string) =>
    value
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/\s+/g, " ")
      .trim();
  const type = typeOf(l);
  if (l.subtype && typeKey(l.subtype) !== typeKey(type)) return spaced(l.subtype);
  return type ? spaced(type) : "Something owed";
}

const nameKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/** How many accounts one read hands over at most (the database's own limit). */
export const MAX_LIABILITIES = 1000;

/**
 * The balance sheet's liability lines put together with the chart of
 * accounts (null when it couldn't be read, or wasn't read whole):
 *
 * - every liability account in the chart comes in, with its balance sheet
 *   line found by the books' id, else by name; an account with no line has
 *   the chart's own balance, else 0 (a balance sheet leaves accounts at zero
 *   out);
 * - a balance sheet line the chart doesn't explain still comes in, typed by
 *   its section;
 * - lines for the same account are added up.
 *
 * `complete` is true only with the whole chart, and only when the chart
 * explains every line of the sheet that carries an id (an empty chart beside
 * a sheet with lines is not believed): only then can an account missing from
 * the read be taken as gone from the books.
 */
export function bookLiabilities(
  sheet: readonly SheetLiability[],
  chart: readonly ChartAccount[] | null,
): { accounts: BookLiability[]; complete: boolean } {
  // The sheet's lines, added up per account.
  const lines = new Map<string, SheetLiability>();
  for (const line of sheet) {
    const key = line.id ? `id:${line.id}` : `name:${nameKey(line.name)}`;
    const seen = lines.get(key);
    lines.set(key, seen ? { ...seen, cents: seen.cents + line.cents } : { ...line });
  }
  const used = new Set<string>();
  const accounts: BookLiability[] = [];

  for (const account of chart ?? []) {
    let key = `id:${account.id}`;
    if (!lines.has(key)) key = `name:${nameKey(account.name)}`;
    const line = lines.get(key);
    if (line && !used.has(key)) used.add(key);
    accounts.push({
      id: account.id,
      name: account.name,
      cents: line?.cents ?? account.cents ?? 0,
      type: account.type,
      subtype: account.subtype,
      section: line?.section ?? null,
    });
  }
  for (const [key, line] of lines) {
    if (used.has(key)) continue;
    // A line whose id the chart has under another key was already used by name.
    if (line.id && chart?.some((a) => a.id === line.id)) continue;
    accounts.push({ ...line, type: null, subtype: null });
  }
  const chartIds = new Set((chart ?? []).map((a) => a.id));
  const believable =
    chart !== null &&
    !(chart.length === 0 && sheet.length > 0) &&
    sheet.every((line) => line.id === null || chartIds.has(line.id));
  return {
    accounts: accounts.slice(0, MAX_LIABILITIES),
    complete: believable && accounts.length <= MAX_LIABILITIES,
  };
}

/** What the database is handed: each liability with the rule's answer. */
export function withDebtRule(accounts: readonly BookLiability[], types: readonly string[]) {
  return accounts.map((l) => ({
    ...l,
    kind: debtKindOf(l),
    automatic: countsAsDebt(l, types),
  }));
}

/** A chart of accounts answer (`select * from Account …`), as accounts. Anything unclear is left out. */
export function parseChartAccounts(answer: unknown): ChartAccount[] {
  const list = (answer as { QueryResponse?: { Account?: unknown } } | null)?.QueryResponse?.Account;
  if (!Array.isArray(list)) return [];
  const text = (value: unknown, max: number) =>
    typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
  const out: ChartAccount[] = [];
  for (const row of list as Record<string, unknown>[]) {
    const id = text(row?.Id, 60);
    const name = text(row?.Name, 200);
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(id) || !name || row.Active === false) continue;
    if (row.Classification !== undefined && row.Classification !== "Liability") continue;
    const balance = row.CurrentBalance;
    out.push({
      id,
      name,
      type: text(row.AccountType, 60) || null,
      subtype: text(row.AccountSubType, 60) || null,
      cents: typeof balance === "number" || typeof balance === "string" ? toCents(balance) : null,
    });
  }
  return out;
}
