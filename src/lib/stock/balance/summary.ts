import { Money } from "./money";
import type { AgingBucket, AgingResult, OpenBill } from "./aging";

/**
 * One line per vendor for the top of the Vendor balances page, plus the combined
 * figure across vendors (pure, unit-tested).
 *
 * The combined "amount due" adds up what you OWE. A credit with one vendor isn't
 * money you can spend on another vendor's bill, so credits are reported beside
 * the total rather than subtracted from it.
 */

export interface VendorSummaryInput {
  supplierId: string;
  supplierName: string;
  paymentTermsDays: number;
  estimatedBalance: string; // signed: positive = owed, negative = credit
  aging: AgingResult;
  needsReviewCount: number;
  entryCount: number;
  /** Still owed on bills the owner has ticked "Paid" (money sent, payment not posted yet). */
  markedPaid?: string;
}

export interface VendorSummary {
  supplierId: string;
  name: string;
  termsDays: number;
  balance: string; // signed
  /** Owed and past its due date (sum of the late buckets). */
  overdue: string;
  overdueBills: number;
  /** The oldest bill still (partly) unpaid. */
  oldest: { reference: string | null; date: string; dueDate: string; daysPastDue: number } | null;
  needsReview: number;
  /** No ledger entries at all yet — nothing to show but a prompt to add some. */
  empty: boolean;
  /** Part of `balance` already paid by the owner, waiting for the payment to post. */
  markedPaid: string;
}

export interface CombinedSummary {
  /** What you owe across vendors, credits not netted off. */
  owed: string;
  overdue: string;
  overdueBills: number;
  /** Total of vendor credits in your favour (positive number). */
  credit: string;
  vendorsOwed: number;
  vendorsOverdue: number;
  /** Part of `owed` the owner has already paid, waiting to post. */
  markedPaid: string;
}

const ZERO = new Money(0);

export function summarizeVendor(v: VendorSummaryInput): VendorSummary {
  const late = [v.aging.buckets.late1to30, v.aging.buckets.late31to60, v.aging.buckets.late60plus];
  const overdue = late.reduce((s, b) => s.add(b.amount), ZERO);
  const first = v.aging.bills[0] ?? null;
  return {
    supplierId: v.supplierId,
    name: v.supplierName,
    termsDays: v.paymentTermsDays,
    balance: new Money(v.estimatedBalance).toFixed(2),
    overdue: overdue.toFixed(2),
    overdueBills: late.reduce((n, b) => n + b.count, 0),
    oldest: first
      ? {
          reference: first.reference,
          date: first.date,
          dueDate: first.dueDate,
          daysPastDue: first.daysPastDue,
        }
      : null,
    needsReview: v.needsReviewCount,
    empty: v.entryCount === 0,
    markedPaid: new Money(v.markedPaid ?? 0).toFixed(2),
  };
}

export function combineSummaries(list: VendorSummary[]): CombinedSummary {
  let owed = ZERO;
  let credit = ZERO;
  let overdue = ZERO;
  let overdueBills = 0;
  let vendorsOwed = 0;
  let vendorsOverdue = 0;
  let markedPaid = ZERO;
  for (const s of list) {
    markedPaid = markedPaid.add(s.markedPaid ?? 0);
    const bal = new Money(s.balance);
    if (bal.gt(0)) {
      owed = owed.add(bal);
      vendorsOwed++;
    } else if (bal.lt(0)) {
      credit = credit.add(bal.neg());
    }
    const od = new Money(s.overdue);
    if (od.gt(0)) {
      overdue = overdue.add(od);
      overdueBills += s.overdueBills;
      vendorsOverdue++;
    }
  }
  return {
    owed: owed.toFixed(2),
    overdue: overdue.toFixed(2),
    overdueBills,
    credit: credit.toFixed(2),
    vendorsOwed,
    vendorsOverdue,
    markedPaid: markedPaid.toFixed(2),
  };
}

/** `supplierId` rides along when the caller has one, so a bill can link to its supplier. */
export type VendorBill = OpenBill & { vendor: string; supplierId?: string };
export type CombinedAging = Omit<AgingResult, "bills" | "termsDays"> & {
  bills: VendorBill[];
  /** The shared terms if every vendor has the same, else null. */
  termsDays: number | null;
};

/** Every vendor's open bills in one list (oldest first), with the buckets added up. */
export function combineAging(
  list: { vendor: string; supplierId?: string; aging: AgingResult }[],
): CombinedAging {
  const keys: AgingBucket[] = ["notDue", "late1to30", "late31to60", "late60plus"];
  const buckets = Object.fromEntries(
    keys.map((k) => [
      k,
      {
        amount: list.reduce((s, v) => s.add(v.aging.buckets[k].amount), ZERO).toFixed(2),
        count: list.reduce((n, v) => n + v.aging.buckets[k].count, 0),
      },
    ]),
  ) as CombinedAging["buckets"];
  const terms = [...new Set(list.map((v) => v.aging.termsDays))];
  return {
    termsDays: terms.length === 1 ? terms[0]! : null,
    openTotal: list.reduce((s, v) => s.add(v.aging.openTotal), ZERO).toFixed(2),
    unattributed: list.reduce((s, v) => s.add(v.aging.unattributed), ZERO).toFixed(2),
    bills: list
      .flatMap((v) =>
        v.aging.bills.map((b) => ({
          ...b,
          vendor: v.vendor,
          ...(v.supplierId ? { supplierId: v.supplierId } : {}),
        })),
      )
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.vendor.localeCompare(b.vendor)),
    buckets,
  };
}

export interface DueGroup {
  key: string;
  label: string;
  overdue: boolean;
  /** Still to pay this week — bills you've ticked "Paid" aren't in it. */
  total: string;
  /** Ticked "Paid" but not posted yet. */
  paid: string;
  bills: VendorBill[];
}

const DAY_MS = 86400000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Monday (YYYY-MM-DD) of the week containing `iso`. */
function mondayOf(iso: string): string {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  const dow = new Date(ms).getUTCDay(); // 0 = Sunday
  return isoDay(ms - ((dow + 6) % 7) * DAY_MS);
}
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function short(iso: string): string {
  return `${MON[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
}

/**
 * Open bills grouped by when they're due: everything past due first, then one group
 * per week (Monday–Sunday) — "This week", "Next week", then "Week of Nov 23".
 * `today` is the store's calendar day (YYYY-MM-DD).
 */
export function dueSchedule(bills: VendorBill[], today: string): DueGroup[] {
  const thisMonday = mondayOf(today);
  const nextMonday = isoDay(Date.parse(`${thisMonday}T00:00:00Z`) + 7 * DAY_MS);
  const groups = new Map<string, DueGroup>();
  const sorted = [...bills].sort(
    (a, b) => a.dueDate.localeCompare(b.dueDate) || a.vendor.localeCompare(b.vendor),
  );
  for (const bill of sorted) {
    let key: string;
    let label: string;
    const overdue = bill.dueDate < today;
    if (overdue) {
      key = "overdue";
      label = "Past due";
    } else {
      key = mondayOf(bill.dueDate);
      const sunday = isoDay(Date.parse(`${key}T00:00:00Z`) + 6 * DAY_MS);
      const range = `${short(key)} – ${short(sunday)}`;
      label =
        key === thisMonday
          ? `This week · ${range}`
          : key === nextMonday
            ? `Next week · ${range}`
            : `Week of ${range}`;
    }
    const g = groups.get(key) ?? { key, label, overdue, total: "0.00", paid: "0.00", bills: [] };
    g.bills.push(bill);
    if (bill.paymentSentAt) g.paid = new Money(g.paid).add(bill.open).toFixed(2);
    else g.total = new Money(g.total).add(bill.open).toFixed(2);
    groups.set(key, g);
  }
  return [...groups.values()];
}
