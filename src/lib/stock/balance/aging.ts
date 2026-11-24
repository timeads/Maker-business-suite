import { Money } from "./money";
import type { LedgerEntryInput } from "./balance";

/**
 * Bill aging for an open account (pure, unit-tested).
 *
 * The owner pays Kestrel against a running balance, not invoice by invoice, so no bill is
 * ever explicitly "paid". The standard convention (and how Kestrel's statements read)
 * is first-in-first-out: every payment clears the OLDEST bills first. So whatever is
 * still owed is made of the MOST RECENT invoices — walk invoices newest first,
 * allocating the current balance until it's used up. Each of those bills is then
 * aged against the payment terms (net 30).
 */

const DAY = 86400000;

export interface OpenBill {
  id: string;
  reference: string | null;
  date: string; // YYYY-MM-DD, invoice (shipping) date
  amount: string; // full invoice amount
  open: string; // portion still unpaid
  partial: boolean; // only part of it is still owed
  ageDays: number;
  dueDate: string; // date + terms
  daysPastDue: number; // negative = days until due
  /** ISO time the owner ticked "Paid" (money sent, not posted yet), or null. */
  paymentSentAt?: string | null;
}

export type AgingBucket = "notDue" | "late1to30" | "late31to60" | "late60plus";

export interface AgingResult {
  termsDays: number;
  openTotal: string;
  /** Owed but older than every invoice on record (history not captured). */
  unattributed: string;
  bills: OpenBill[]; // oldest first
  buckets: Record<AgingBucket, { amount: string; count: number }>;
}

const ZERO = new Money(0);
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function bucketFor(daysPastDue: number): AgingBucket {
  if (daysPastDue <= 0) return "notDue";
  if (daysPastDue <= 30) return "late1to30";
  if (daysPastDue <= 60) return "late31to60";
  return "late60plus";
}

export function computeAging(
  entries: LedgerEntryInput[],
  balance: Money | string,
  asOf: Date,
  termsDays: number,
): AgingResult {
  const owed = new Money(balance);
  const buckets: AgingResult["buckets"] = {
    notDue: { amount: "0.00", count: 0 },
    late1to30: { amount: "0.00", count: 0 },
    late31to60: { amount: "0.00", count: 0 },
    late60plus: { amount: "0.00", count: 0 },
  };
  if (owed.lte(0)) {
    return { termsDays, openTotal: "0.00", unattributed: "0.00", bills: [], buckets };
  }

  // Newest first. The same invoice can be on file twice from old backfills under
  // different keys; one reference + amount counts once.
  const seen = new Set<string>();
  const invoices = entries
    .filter((e) => e.type === "INVOICE" && e.supersededById === null && e.entryDate <= asOf)
    .sort((a, b) => b.entryDate.getTime() - a.entryDate.getTime())
    .filter((e) => {
      const k = `${(e.reference ?? e.id).toUpperCase()}|${e.amount.toFixed(2)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  let remaining = owed;
  const bills: OpenBill[] = [];
  for (const inv of invoices) {
    if (remaining.lte(0)) break;
    const open = Money.min(inv.amount, remaining);
    remaining = remaining.sub(open);
    const ageDays = Math.floor((asOf.getTime() - inv.entryDate.getTime()) / DAY);
    const due = new Date(inv.entryDate.getTime() + termsDays * DAY);
    bills.push({
      id: inv.id,
      reference: inv.reference,
      date: iso(inv.entryDate),
      amount: inv.amount.toFixed(2),
      open: open.toFixed(2),
      partial: open.lt(inv.amount),
      ageDays,
      dueDate: iso(due),
      daysPastDue: ageDays - termsDays,
      paymentSentAt: inv.paymentSentAt ? inv.paymentSentAt.toISOString() : null,
    });
  }

  const totals: Record<AgingBucket, Money> = {
    notDue: ZERO,
    late1to30: ZERO,
    late31to60: ZERO,
    late60plus: ZERO,
  };
  for (const b of bills) {
    const k = bucketFor(b.daysPastDue);
    totals[k] = totals[k].add(b.open);
    buckets[k].count++;
  }
  for (const k of Object.keys(totals) as AgingBucket[]) buckets[k].amount = totals[k].toFixed(2);

  return {
    termsDays,
    openTotal: owed.sub(remaining).toFixed(2),
    unattributed: remaining.toFixed(2),
    bills: bills.reverse(),
    buckets,
  };
}
