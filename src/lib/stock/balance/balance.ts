import { Money } from "./money";

/**
 * Open-account balance for a vendor (pure, no I/O so it can be unit-tested).
 *
 * The account is a running balance, not invoice-by-invoice matching: Karida bills
 * net-30 and Tim pays what he can, when he can. Karida periodically emails a
 * "Statement of Account" asserting the balance as of a date — that stated balance
 * is the authoritative ANCHOR. Everything before it is already baked in, so the
 * current balance is:
 *
 *   anchor.statedBalance + invoices after it + adjustments after it − payments after it
 *
 * Anchoring this way means a mis-parsed older entry can never accumulate error:
 * the next statement re-syncs the whole account.
 *
 * Payment lag: wires leave Wells Fargo 1–3 days before Karida records receipt
 * (wired 7/31 → "received August 3"). A wire sent just before a statement date may
 * therefore be missing from that statement. Those are reported separately as
 * `paymentsPossiblyUnreflected` rather than silently added (which would risk
 * double-counting) or dropped (which would overstate the balance).
 */

export type LedgerType = "STATEMENT" | "INVOICE" | "PAYMENT" | "ADJUSTMENT";
export type LedgerSource =
  "KARIDA_EMAIL" | "VENDOR_EMAIL" | "WELLS_FARGO_EMAIL" | "QUICKBOOKS" | "MANUAL";

export interface LedgerEntryInput {
  id: string;
  type: LedgerType;
  entryDate: Date;
  /** Positive for STATEMENT/INVOICE/PAYMENT; ADJUSTMENT is signed (negative = credit). */
  amount: Money;
  statedBalance: Money | null; // STATEMENT only
  reference: string | null;
  description: string | null;
  source: LedgerSource;
  needsReview: boolean;
  supersededById: string | null;
  /** INVOICE: when Tim marked it paid (money sent, payment not posted yet). */
  paymentSentAt?: Date | null;
}

export interface LedgerEntryView {
  id: string;
  type: LedgerType;
  date: string; // ISO
  amount: string;
  reference: string | null;
  description: string | null;
  source: LedgerSource;
  needsReview: boolean;
}

export interface VendorBalanceResult {
  /** Karida's own most recent stated balance, the basis for the estimate. */
  anchor: { id: string; date: string; statedBalance: string } | null;
  invoicesSince: string;
  paymentsSince: string;
  adjustmentsSince: string;
  /** Best estimate of what's owed right now. */
  estimatedBalance: string;
  /** Activity after the anchor, newest first. */
  entriesSince: LedgerEntryView[];
  /** Wires sent just before the anchor that the statement may not include yet. */
  paymentsPossiblyUnreflected: LedgerEntryView[];
  needsReviewCount: number;
  daysSinceStatement: number | null;
}

const DAY = 86400000;
const ZERO = new Money(0);

/**
 * The same wire shows up twice: once from the Wells Fargo confirmation and again
 * when the vendor's statement lists it as received (Tim wires 7/31, Karida writes
 * "received August 3"). Counting both would double-subtract and silently understate
 * the balance. The vendor's own record wins — it's what their books reflect — so a
 * bank row matched by amount within the lag window is dropped from the arithmetic.
 * Each vendor payment can absorb only one wire, so two identical wires stay distinct.
 */
/** Payments seen from our bank's side rather than reported by the vendor. */
const BANK_SOURCES = new Set<LedgerSource>(["WELLS_FARGO_EMAIL", "QUICKBOOKS"]);

function dedupePayments(entries: LedgerEntryInput[], matchDays: number): LedgerEntryInput[] {
  const vendorPayments = entries.filter((e) => e.type === "PAYMENT" && e.source === "KARIDA_EMAIL");
  const consumed = new Set<string>();
  return entries.filter((e) => {
    if (e.type !== "PAYMENT" || !BANK_SOURCES.has(e.source)) return true;
    const match = vendorPayments.find(
      (v) =>
        !consumed.has(v.id) &&
        v.amount.equals(e.amount) &&
        Math.abs(v.entryDate.getTime() - e.entryDate.getTime()) <= matchDays * DAY,
    );
    if (match) {
      consumed.add(match.id);
      return false;
    }
    return true;
  });
}

function view(e: LedgerEntryInput): LedgerEntryView {
  return {
    id: e.id,
    type: e.type,
    date: e.entryDate.toISOString(),
    amount: e.amount.toFixed(2),
    reference: e.reference,
    description: e.description,
    source: e.source,
    needsReview: e.needsReview,
  };
}

export interface BalanceOptions {
  /** Days before a statement in which a wire may not yet be reflected. */
  paymentLagDays?: number;
  /** Window for treating a vendor-reported payment as the same one as a wire. */
  matchWindowDays?: number;
}

export function computeVendorBalance(
  entries: LedgerEntryInput[],
  asOf: Date,
  opts: BalanceOptions = {},
): VendorBalanceResult {
  const lagDays = opts.paymentLagDays ?? 5;
  const matchDays = opts.matchWindowDays ?? 7;

  // Corrections supersede the entry they replace; superseded rows never count.
  const live = entries.filter((e) => e.supersededById === null && e.entryDate <= asOf);

  const statements = live
    .filter((e) => e.type === "STATEMENT" && e.statedBalance !== null)
    .sort((a, b) => a.entryDate.getTime() - b.entryDate.getTime());
  const anchorEntry = statements.length > 0 ? statements[statements.length - 1]! : null;
  const anchorDate = anchorEntry ? anchorEntry.entryDate : null;

  // Raw activity is kept for the unreflected-wire check below; the arithmetic runs
  // on the deduped list so a vendor-confirmed wire isn't subtracted twice.
  const activity = live.filter((e) => e.type !== "STATEMENT");
  const deduped = dedupePayments(activity, matchDays);
  const since = anchorDate ? deduped.filter((e) => e.entryDate > anchorDate) : deduped;

  let invoices = ZERO;
  let payments = ZERO;
  let adjustments = ZERO;
  for (const e of since) {
    if (e.type === "INVOICE") invoices = invoices.add(e.amount);
    else if (e.type === "PAYMENT") payments = payments.add(e.amount);
    else if (e.type === "ADJUSTMENT") adjustments = adjustments.add(e.amount);
  }

  const base = anchorEntry?.statedBalance ?? ZERO;
  const estimated = base.add(invoices).add(adjustments).sub(payments);

  // A wire in the lag window before the anchor, with no vendor-reported payment of
  // the same amount nearby, probably hadn't landed when the statement was written.
  let unreflected: LedgerEntryInput[] = [];
  if (anchorDate) {
    const windowStart = new Date(anchorDate.getTime() - lagDays * DAY);
    const vendorPayments = activity.filter(
      (e) => e.type === "PAYMENT" && e.source === "KARIDA_EMAIL",
    );
    unreflected = activity.filter((e) => {
      if (e.type !== "PAYMENT" || !BANK_SOURCES.has(e.source)) return false;
      if (e.entryDate > anchorDate || e.entryDate < windowStart) return false;
      return !vendorPayments.some(
        (v) =>
          v.amount.equals(e.amount) &&
          Math.abs(v.entryDate.getTime() - e.entryDate.getTime()) <= matchDays * DAY,
      );
    });
  }

  return {
    anchor: anchorEntry
      ? {
          id: anchorEntry.id,
          date: anchorEntry.entryDate.toISOString(),
          statedBalance: anchorEntry.statedBalance!.toFixed(2),
        }
      : null,
    invoicesSince: invoices.toFixed(2),
    paymentsSince: payments.toFixed(2),
    adjustmentsSince: adjustments.toFixed(2),
    estimatedBalance: estimated.toFixed(2),
    entriesSince: [...since]
      .sort((a, b) => b.entryDate.getTime() - a.entryDate.getTime())
      .map(view),
    paymentsPossiblyUnreflected: unreflected.map(view),
    needsReviewCount: live.filter((e) => e.needsReview).length,
    daysSinceStatement: anchorDate
      ? Math.floor((asOf.getTime() - anchorDate.getTime()) / DAY)
      : null,
  };
}

export interface StatementAudit {
  fromDate: string | null; // previous statement (null = first on record)
  toDate: string;
  previousBalance: string | null;
  invoices: string;
  payments: string;
  adjustments: string;
  computedBalance: string; // what the ledger says it should be
  statedBalance: string; // what the vendor asserted
  delta: string; // stated − computed; non-zero means the vendor's math drifted
}

/**
 * Walk statement to statement and re-derive each asserted balance from the entries
 * in between. A non-zero delta means the vendor's own arithmetic doesn't tie out —
 * this really happens (Karida's Aug 6 2026 statement was 20¢ high), and catching it
 * is the point: the anchor is trusted, so a silent error would persist until the
 * next statement. Only pairs with a known previous balance are audited.
 */
export function auditStatements(
  entries: LedgerEntryInput[],
  matchWindowDays = 7,
): StatementAudit[] {
  const live = dedupePayments(
    entries.filter((e) => e.supersededById === null),
    matchWindowDays,
  );
  const statements = live
    .filter((e) => e.type === "STATEMENT" && e.statedBalance !== null)
    .sort((a, b) => a.entryDate.getTime() - b.entryDate.getTime());

  const out: StatementAudit[] = [];
  for (let i = 1; i < statements.length; i++) {
    const prev = statements[i - 1]!;
    const cur = statements[i]!;
    let invoices = ZERO;
    let payments = ZERO;
    let adjustments = ZERO;
    let components = 0;
    for (const e of live) {
      if (e.type === "STATEMENT") continue;
      if (e.entryDate <= prev.entryDate || e.entryDate > cur.entryDate) continue;
      components++;
      if (e.type === "INVOICE") invoices = invoices.add(e.amount);
      else if (e.type === "PAYMENT") payments = payments.add(e.amount);
      else if (e.type === "ADJUSTMENT") adjustments = adjustments.add(e.amount);
    }
    // No line-item detail captured for this gap (e.g. backfilled history where only
    // the balance is known). We can't audit what we can't recompute — reporting the
    // whole balance change as "drift" would be a false alarm.
    if (components === 0) continue;

    const computed = prev.statedBalance!.add(invoices).add(adjustments).sub(payments);
    out.push({
      fromDate: prev.entryDate.toISOString(),
      toDate: cur.entryDate.toISOString(),
      previousBalance: prev.statedBalance!.toFixed(2),
      invoices: invoices.toFixed(2),
      payments: payments.toFixed(2),
      adjustments: adjustments.toFixed(2),
      computedBalance: computed.toFixed(2),
      statedBalance: cur.statedBalance!.toFixed(2),
      delta: cur.statedBalance!.sub(computed).toFixed(2),
    });
  }
  return out;
}

/**
 * Balance over time, one point per statement plus today's estimate — for charting
 * the account trend. Each statement is the vendor's own asserted number.
 */
export function balanceHistory(
  entries: LedgerEntryInput[],
  asOf: Date,
): { date: string; balance: string; stated: boolean }[] {
  const points = entries
    .filter((e) => e.type === "STATEMENT" && e.statedBalance !== null && e.supersededById === null)
    .sort((a, b) => a.entryDate.getTime() - b.entryDate.getTime())
    .map((e) => ({
      date: e.entryDate.toISOString(),
      balance: e.statedBalance!.toFixed(2),
      stated: true,
    }));
  const now = computeVendorBalance(entries, asOf);
  points.push({ date: asOf.toISOString(), balance: now.estimatedBalance, stated: false });
  return points;
}
