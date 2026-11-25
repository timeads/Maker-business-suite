import type { SupabaseClient } from "@supabase/supabase-js";
import { localDay } from "@/lib/bookings/slots";
import { computeAging, type AgingResult } from "@/lib/stock/balance/aging";
import {
  auditStatements,
  computeVendorBalance,
  type LedgerEntryInput,
  type LedgerType,
  type StatementAudit,
  type VendorBalanceResult,
} from "@/lib/stock/balance/balance";
import type { EntrySource } from "@/lib/stock/balance/activity";
import { accountHistory, type AccountHistory } from "@/lib/stock/balance/history";
import { Money } from "@/lib/stock/balance/money";
import { gmailLink } from "@/lib/stock/mail/query";
import {
  STOCK_HIDDEN_NOTICES_KEY,
  STOCK_MODULE,
  STOCK_SETTINGS_KEY,
  parseHiddenNotices,
  parseStockSettings,
} from "@/lib/stock/config";
import { paidMarks, type PaidMarks } from "@/lib/stock/balance/paid-marks";
import { entrySource } from "@/lib/stock/balance/source";
import {
  combineSummaries,
  summarizeVendor,
  type CombinedSummary,
  type VendorSummary,
} from "@/lib/stock/balance/summary";

type SupplierRow = {
  id: string;
  name: string;
  payment_terms_days: number;
  archived_at: string | null;
};

type DbLedgerRow = {
  id: string;
  supplier_id: string;
  type: "statement" | "invoice" | "payment" | "adjustment";
  entry_date: string;
  amount: number | string;
  stated_balance: number | string | null;
  reference: string | null;
  description: string;
  payment_sent_at: string | null;
  created_at: string;
  created_by: string | null;
  source: EntrySource;
  /** Payments: whose word it is. It changes the balance, so it is read with the figures. */
  reported_by: "supplier" | "bank" | null;
};

/** What an emailed or uploaded entry carries beside the figures. */
type MailMark = {
  id: string;
  needs_review: boolean;
  review_note: string | null;
  mail_route: "gmail" | "forward" | null;
  mail_message_id: string | null;
};

/** One line of a supplier's account, ready to show. */
export type LedgerRow = {
  id: string;
  supplierId: string;
  supplierName: string;
  type: LedgerType;
  /** YYYY-MM-DD, as it was written down. */
  date: string;
  /** Signed only for an adjustment (negative is a credit). */
  amount: string;
  statedBalance: string | null;
  reference: string | null;
  description: string;
  createdAt: string;
  /** Read from the connected books rather than typed in. */
  fromBooks: boolean;
  /** Typed in, brought in from a spreadsheet, or read from the books. */
  source: EntrySource;
  /** The member who wrote it down, when that is known. */
  createdBy: string | null;
  /** Invoices: when someone ticked "Paid", or null. */
  paymentSentAt: string | null;
  /** Waiting for a person to look it over (it counts in the balance meanwhile). */
  needsReview: boolean;
  reviewNote: string | null;
  /** Read from Gmail: a plain link that opens the message there. */
  gmailLink: string | null;
  /** Arrived at the bills address. */
  forwarded: boolean;
};

/** A supplier's whole account: the entries and everything worked out from them. */
export type SupplierAccount = {
  supplierId: string;
  name: string;
  termsDays: number;
  archived: boolean;
  balance: VendorBalanceResult;
  aging: AgingResult;
  paid: PaidMarks;
  audits: StatementAudit[];
  summary: VendorSummary;
  /** The balance after each entry, and which payments cleared which bills. */
  history: AccountHistory;
  /** When the newest entry was written down (ISO), or null for an empty account. */
  updatedAt: string | null;
  /** Newest first. */
  ledger: LedgerRow[];
};

export type Balances = {
  /** Every supplier, by name; one with nothing written down has an empty ledger. */
  accounts: SupplierAccount[];
  /** Across the suppliers that have entries. */
  combined: CombinedSummary;
  /** The workspace's calendar day, YYYY-MM-DD. */
  today: string;
  /** Keys of the notices someone has hidden (lib/stock/balance/notices.ts). */
  hiddenNotices: string[];
  /** The workspace has asked for payments to be read from its books. */
  booksOn: boolean;
};

const PAGE = 1000;

/**
 * Reads every row of a query, a page at a time (the API hands back 1,000 at
 * most). Unlike the stock reader this one stops the page on an error: a
 * balance worked out from half the entries would be a wrong number.
 */
async function all<T>(
  what: string,
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
  limit = 100_000,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; from < limit; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`Could not load ${what}`);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

const TYPES: Record<DbLedgerRow["type"], LedgerType> = {
  statement: "STATEMENT",
  invoice: "INVOICE",
  payment: "PAYMENT",
  adjustment: "ADJUSTMENT",
};

/** A plain date as the UTC-midnight instant the balance maths works in. */
const dayDate = (day: string) => new Date(`${day.slice(0, 10)}T00:00:00.000Z`);

function toInput(row: DbLedgerRow, mark: MailMark | undefined): LedgerEntryInput {
  return {
    id: row.id,
    type: TYPES[row.type],
    entryDate: dayDate(row.entry_date),
    amount: new Money(row.amount),
    statedBalance: row.stated_balance === null ? null : new Money(row.stated_balance),
    reference: row.reference,
    description: row.description,
    source: entrySource(row),
    needsReview: mark?.needs_review ?? false,
    supersededById: null,
    paymentSentAt: row.payment_sent_at ? new Date(row.payment_sent_at) : null,
  };
}

function toAccount(
  supplier: SupplierRow,
  rows: DbLedgerRow[],
  today: string,
  now: Date,
  marks: Map<string, MailMark>,
): SupplierAccount {
  const asOf = dayDate(today);
  const inputs = rows.map((row) => toInput(row, marks.get(row.id)));
  // A payment the business wrote down itself is its own record of money sent,
  // so one dated just before a statement may not be in that statement yet.
  const balance = computeVendorBalance(inputs, asOf, { ownPaymentsAreOurs: true });
  const aging = computeAging(inputs, balance.estimatedBalance, asOf, supplier.payment_terms_days);
  const paid = paidMarks(inputs, aging, now);
  return {
    supplierId: supplier.id,
    name: supplier.name,
    termsDays: supplier.payment_terms_days,
    archived: Boolean(supplier.archived_at),
    balance,
    aging,
    paid,
    // Rows come newest first; the history wants them as they were written down.
    history: accountHistory([...inputs].reverse(), aging, asOf),
    updatedAt: rows.reduce<string | null>(
      (max, row) => (max === null || row.created_at > max ? row.created_at : max),
      null,
    ),
    audits: auditStatements(inputs),
    summary: summarizeVendor({
      supplierId: supplier.id,
      supplierName: supplier.name,
      paymentTermsDays: supplier.payment_terms_days,
      estimatedBalance: balance.estimatedBalance,
      aging,
      needsReviewCount: balance.needsReviewCount,
      entryCount: rows.length,
      markedPaid: paid.waitingTotal,
    }),
    ledger: rows.map((row, i) => ({
      id: row.id,
      supplierId: supplier.id,
      supplierName: supplier.name,
      type: TYPES[row.type],
      date: row.entry_date.slice(0, 10),
      amount: inputs[i].amount.toFixed(2),
      statedBalance: inputs[i].statedBalance?.toFixed(2) ?? null,
      reference: row.reference,
      description: row.description,
      createdAt: row.created_at,
      fromBooks: row.source === "books",
      source: row.source ?? "manual",
      createdBy: row.created_by ?? null,
      paymentSentAt: row.payment_sent_at,
      needsReview: marks.get(row.id)?.needs_review ?? false,
      reviewNote: marks.get(row.id)?.review_note ?? null,
      gmailLink: gmailLink(marks.get(row.id)?.mail_message_id ?? ""),
      forwarded: marks.get(row.id)?.mail_route === "forward",
    })),
  };
}

/**
 * What the workspace owes each supplier, read as the signed-in member. Only
 * owners and admins get any ledger rows back, so a page checks the role
 * first and never shows a member an account that merely looks empty.
 */
export async function loadBalances(
  supabase: SupabaseClient,
  tenant: { id: string; timezone: string },
  /** Only this supplier's account. */
  supplierId?: string,
): Promise<Balances> {
  const [suppliers, ledger, { data: configs }, markRows] = await Promise.all([
    all<SupplierRow>("suppliers", (from, to) => {
      const query = supabase
        .from("suppliers")
        .select("id, name, payment_terms_days, archived_at")
        .eq("tenant_id", tenant.id);
      return (supplierId ? query.eq("id", supplierId) : query)
        .order("name")
        .order("id")
        .range(from, to);
    }),
    all<DbLedgerRow>("supplier balances", (from, to) => {
      const query = supabase
        .from("supplier_ledger")
        .select(
          "id, supplier_id, type, entry_date, amount, stated_balance, reference, description, payment_sent_at, created_at, created_by, source, reported_by",
        )
        .eq("tenant_id", tenant.id);
      return (supplierId ? query.eq("supplier_id", supplierId) : query)
        .order("entry_date", { ascending: false })
        .order("created_at", { ascending: false })
        .order("id")
        .range(from, to);
    }),
    supabase
      .from("configs")
      .select("key, body")
      .eq("tenant_id", tenant.id)
      .eq("module", STOCK_MODULE)
      .in("key", [STOCK_HIDDEN_NOTICES_KEY, STOCK_SETTINGS_KEY]),
    // What emailed entries carry, read in a query of its own that is allowed
    // to fail: without it the balances still show, just without the marks.
    all<MailMark>("entry marks", (from, to) => {
      const query = supabase
        .from("supplier_ledger")
        .select("id, needs_review, review_note, mail_route, mail_message_id")
        .eq("tenant_id", tenant.id)
        .or("needs_review.eq.true,source.in.(email,upload)");
      return (supplierId ? query.eq("supplier_id", supplierId) : query).order("id").range(from, to);
    }).catch(() => [] as MailMark[]),
  ]);
  const marks = new Map(markRows.map((mark) => [mark.id, mark]));
  const config = (key: string) =>
    ((configs ?? []) as { key: string; body: unknown }[]).find((c) => c.key === key)?.body;
  const now = new Date();
  const today = localDay(now, tenant.timezone);
  const bySupplier = new Map<string, DbLedgerRow[]>();
  for (const row of ledger) {
    const rows = bySupplier.get(row.supplier_id);
    if (rows) rows.push(row);
    else bySupplier.set(row.supplier_id, [row]);
  }
  const accounts = suppliers.map((s) =>
    toAccount(s, bySupplier.get(s.id) ?? [], today, now, marks),
  );
  return {
    accounts,
    combined: combineSummaries(accounts.filter((a) => a.ledger.length > 0).map((a) => a.summary)),
    today,
    hiddenNotices: parseHiddenNotices(config(STOCK_HIDDEN_NOTICES_KEY)).keys,
    booksOn: parseStockSettings(config(STOCK_SETTINGS_KEY)).payments_from_books,
  };
}
