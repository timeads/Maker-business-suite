import { toCents } from "../../dashboard/lines";
import type { BookExpenseRow } from "../types";

/**
 * Money going out, as QuickBooks records it, for Money's expense inbox and
 * profit by line. Pure: the questions to ask and how to read the answers.
 * Read-only: nothing is ever written to the books.
 *
 * Read the way the earlier finance dashboard reads them:
 * - purchases (cash, cheque and card): the whole purchase, filed under the
 *   account of its first line; a card refund (`Credit`) is money back, so it
 *   is kept as a negative amount;
 * - bills: the whole bill on its own date;
 * - journal entries: the debit side only, every debit line added up;
 * - transfers and card payments: money moving between the business's own
 *   accounts (paying down a card or a loan, say). They are NOT expenses: kept
 *   marked as moves, never in the inbox and never counted, for the later debt
 *   work.
 */

export const EXPENSE_ENTITIES = [
  "Purchase",
  "Bill",
  "JournalEntry",
  "Transfer",
  "CreditCardPayment",
] as const;
export type ExpenseEntity = (typeof EXPENSE_ENTITIES)[number];

/** How many records one question asks for, and the most questions per kind in one sync. */
export const EXPENSE_PAGE = 500;
export const EXPENSE_PAGES = 40;

/** Kept short: a memo or line description is a note, not a document. */
const MAX_TEXT = 300;
const MAX_LINES = 50;

/**
 * How far back the books are read: from the first of January last year,
 * as the earlier dashboard reads from the start of the year before this one.
 */
export function expensesSince(today: Date): string {
  return `${today.getUTCFullYear() - 1}-01-01`;
}

/** QuickBooks' query language: records of one kind dated on or after a day, a page at a time. */
export function expensesQuery(entity: ExpenseEntity, since: string, page: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error("since must be a plain day");
  if (!(EXPENSE_ENTITIES as readonly string[]).includes(entity)) throw new Error("unknown kind");
  const start = Math.max(0, Math.trunc(page)) * EXPENSE_PAGE + 1;
  return `select * from ${entity} where TxnDate >= '${since}' orderby TxnDate startposition ${start} maxresults ${EXPENSE_PAGE}`;
}

type Ref = { value?: unknown; name?: unknown; type?: unknown } | null | undefined;
type QboLine = {
  Amount?: unknown;
  Description?: unknown;
  DetailType?: unknown;
  AccountBasedExpenseLineDetail?: { AccountRef?: Ref } | null;
  ItemBasedExpenseLineDetail?: { ItemAccountRef?: Ref } | null;
  JournalEntryLineDetail?: {
    PostingType?: unknown;
    AccountRef?: Ref;
    Entity?: { EntityRef?: Ref } | null;
  } | null;
};
type QboRecord = {
  Id?: unknown;
  TxnDate?: unknown;
  TotalAmt?: unknown;
  Amount?: unknown;
  PrivateNote?: unknown;
  Memo?: unknown;
  PaymentType?: unknown;
  Credit?: unknown;
  EntityRef?: Ref;
  VendorRef?: Ref;
  FromAccountRef?: Ref;
  ToAccountRef?: Ref;
  BankAccountRef?: Ref;
  CreditCardAccountRef?: Ref;
  Line?: unknown;
};
export type ExpensesResponse = { QueryResponse?: Record<string, unknown> | null };

const text = (value: unknown, max = 200) =>
  typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
const name = (ref: Ref) => text(ref?.name) || null;
/** The books' own id in a reference, when it looks like one. */
const refId = (ref: Ref) => {
  const value = typeof ref?.value === "string" ? ref.value.trim() : "";
  return /^[A-Za-z0-9_-]{1,60}$/.test(value) ? value : null;
};
const amountCents = (value: unknown) =>
  typeof value === "number" || typeof value === "string" ? toCents(value) : 0;

function expenseLines(record: QboRecord) {
  const lines = Array.isArray(record.Line) ? (record.Line as QboLine[]) : [];
  return lines
    .filter(
      (line) =>
        line &&
        (line.DetailType === "AccountBasedExpenseLineDetail" ||
          line.DetailType === "ItemBasedExpenseLineDetail"),
    )
    .map((line) => ({
      account:
        name(line.AccountBasedExpenseLineDetail?.AccountRef) ??
        name(line.ItemBasedExpenseLineDetail?.ItemAccountRef),
      amount_cents: amountCents(line.Amount),
      description: text(line.Description, MAX_TEXT),
    }));
}

function debitLines(record: QboRecord) {
  const lines = Array.isArray(record.Line) ? (record.Line as QboLine[]) : [];
  return lines
    .filter(
      (line) =>
        line &&
        line.DetailType === "JournalEntryLineDetail" &&
        line.JournalEntryLineDetail?.PostingType === "Debit",
    )
    .map((line) => ({
      account: name(line.JournalEntryLineDetail?.AccountRef),
      payee: name(line.JournalEntryLineDetail?.Entity?.EntityRef),
      amount_cents: amountCents(line.Amount),
      description: text(line.Description, MAX_TEXT),
    }));
}

const KINDS: Record<ExpenseEntity, BookExpenseRow["kind"]> = {
  Purchase: "purchase",
  Bill: "bill",
  JournalEntry: "journal",
  Transfer: "transfer",
  CreditCardPayment: "card_payment",
};

/** One record as a row for Money, or null when it isn't one (or isn't clear). */
export function parseExpense(entity: ExpenseEntity, record: QboRecord): BookExpenseRow | null {
  if (!record || typeof record !== "object") return null;
  const id = text(record.Id, 40);
  const date = text(record.TxnDate).slice(0, 10);
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const memo = text(record.PrivateNote, MAX_TEXT) || text(record.Memo, MAX_TEXT);
  const base = { entity, external_id: id, kind: KINDS[entity], date, memo };

  switch (entity) {
    case "Purchase":
    case "Bill": {
      const lines = expenseLines(record).slice(0, MAX_LINES);
      const total = amountCents(record.TotalAmt);
      // A card refund is money coming back.
      const refund = entity === "Purchase" && record.Credit === true;
      return {
        ...base,
        payment_type: entity === "Purchase" ? text(record.PaymentType, 40) || null : null,
        amount_cents: refund ? -Math.abs(total) : total,
        account: lines.find((line) => line.account)?.account ?? null,
        payee: name(entity === "Bill" ? record.VendorRef : record.EntityRef),
        from_account: null,
        lines,
      };
    }
    case "JournalEntry": {
      const debits = debitLines(record);
      if (debits.length === 0) return null;
      return {
        ...base,
        payment_type: null,
        amount_cents: debits.reduce((sum, line) => sum + line.amount_cents, 0),
        account: debits.find((line) => line.account)?.account ?? null,
        payee: debits.find((line) => line.payee)?.payee ?? null,
        from_account: null,
        lines: debits.slice(0, MAX_LINES).map(({ account, amount_cents, description }) => ({
          account,
          amount_cents,
          description,
        })),
      };
    }
    case "Transfer":
    case "CreditCardPayment": {
      const toRef = entity === "Transfer" ? record.ToAccountRef : record.CreditCardAccountRef;
      const to = name(toRef);
      if (!to) return null;
      return {
        ...base,
        payment_type: null,
        amount_cents: amountCents(record.Amount),
        account: to,
        // The books' id for the account paid into: a renamed account keeps its payments.
        account_ref: refId(toRef),
        payee: null,
        from_account: name(entity === "Transfer" ? record.FromAccountRef : record.BankAccountRef),
        lines: [],
      };
    }
  }
}

/** The records of one kind in an answer, as rows. Anything unclear is left out. */
export function parseExpenses(entity: ExpenseEntity, response: ExpensesResponse): BookExpenseRow[] {
  const list = response.QueryResponse?.[entity];
  if (!Array.isArray(list)) return [];
  return (list as QboRecord[])
    .map((record) => parseExpense(entity, record))
    .filter((row): row is BookExpenseRow => row !== null);
}

/** How many records an answer held, to know whether to ask for another page. */
export const expenseAnswerSize = (entity: ExpenseEntity, response: ExpensesResponse) => {
  const list = response.QueryResponse?.[entity];
  return Array.isArray(list) ? list.length : 0;
};
