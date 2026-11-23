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
import { Money } from "@/lib/stock/balance/money";
import { paidMarks, type PaidMarks } from "@/lib/stock/balance/paid-marks";
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

function toInput(row: DbLedgerRow): LedgerEntryInput {
  return {
    id: row.id,
    type: TYPES[row.type],
    entryDate: dayDate(row.entry_date),
    amount: new Money(row.amount),
    statedBalance: row.stated_balance === null ? null : new Money(row.stated_balance),
    reference: row.reference,
    description: row.description,
    source: "MANUAL",
    needsReview: false,
    supersededById: null,
    paymentSentAt: row.payment_sent_at ? new Date(row.payment_sent_at) : null,
  };
}

function toAccount(
  supplier: SupplierRow,
  rows: DbLedgerRow[],
  today: string,
  now: Date,
): SupplierAccount {
  const asOf = dayDate(today);
  const inputs = rows.map(toInput);
  const balance = computeVendorBalance(inputs, asOf);
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
    audits: auditStatements(inputs),
    summary: summarizeVendor({
      supplierId: supplier.id,
      supplierName: supplier.name,
      paymentTermsDays: supplier.payment_terms_days,
      estimatedBalance: balance.estimatedBalance,
      aging,
      needsReviewCount: 0,
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
  const [suppliers, ledger] = await Promise.all([
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
          "id, supplier_id, type, entry_date, amount, stated_balance, reference, description, payment_sent_at, created_at",
        )
        .eq("tenant_id", tenant.id);
      return (supplierId ? query.eq("supplier_id", supplierId) : query)
        .order("entry_date", { ascending: false })
        .order("created_at", { ascending: false })
        .order("id")
        .range(from, to);
    }),
  ]);
  const now = new Date();
  const today = localDay(now, tenant.timezone);
  const bySupplier = new Map<string, DbLedgerRow[]>();
  for (const row of ledger) {
    const rows = bySupplier.get(row.supplier_id);
    if (rows) rows.push(row);
    else bySupplier.set(row.supplier_id, [row]);
  }
  const accounts = suppliers.map((s) => toAccount(s, bySupplier.get(s.id) ?? [], today, now));
  return {
    accounts,
    combined: combineSummaries(accounts.filter((a) => a.ledger.length > 0).map((a) => a.summary)),
    today,
  };
}
