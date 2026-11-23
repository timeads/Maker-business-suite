import { Money } from "./money";
import type { LedgerEntryInput } from "./balance";
import type { AgingResult } from "./aging";

/**
 * The "Paid" tick on a bill, cross-checked against the payments that actually post
 * (pure, unit-tested).
 *
 * Tim pays by ACH (Ronille, Protech — shows up in QuickBooks days later) or by wire
 * (Karida — several bills at once to save the $30 fee, sometimes before they're due).
 * The tick is his note that the money has gone. The balance never changes because of
 * it; it changes when the payment posts, which (first-in-first-out) clears bills. So:
 *  - ticked and still owed, nothing posted since → waiting (amber after a week);
 *  - ticked, still owed, but a payment HAS posted since → the cross-check failed: the
 *    payment didn't cover it (wrong amount, or it went to older bills first);
 *  - ticked and no longer owed → confirmed, with the payment that cleared it.
 */

export type MarkState = "waiting" | "late" | "short";

export interface WaitingMark {
  billId: string;
  reference: string | null;
  open: string;
  markedAt: string; // ISO
  state: MarkState;
  note: string;
}

export interface ConfirmedMark {
  billId: string;
  reference: string | null;
  amount: string;
  markedAt: string; // ISO
  /** The first payment posted on/after the mark (or just before it — a wire's "send on" date). */
  payment: { date: string; amount: string } | null;
}

export interface PaidMarks {
  waiting: WaitingMark[];
  confirmed: ConfirmedMark[];
  /** Total still owed on ticked bills. */
  waitingTotal: string;
}

const DAY = 86400000;
const LATE_DAYS = 7;
const CONFIRMED_SHOWN_DAYS = 45;
// A payment dated up to 3 days before the tick still counts as that payment (Tim may
// tick the box a day or two after sending; wires carry their "send on" date).
const SLACK_DAYS = 3;

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (iso: string) => `${MON[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
const dollars = (v: Money.Value) => {
  const [w, c] = new Money(v).toFixed(2).split(".");
  return `$${w!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${c}`;
};

export function paidMarks(entries: LedgerEntryInput[], aging: AgingResult, now: Date): PaidMarks {
  const payments = entries
    .filter((e) => e.type === "PAYMENT" && e.supersededById === null)
    .sort((a, b) => a.entryDate.getTime() - b.entryDate.getTime());
  const paymentSince = (mark: Date) =>
    payments.find((p) => p.entryDate.getTime() >= mark.getTime() - SLACK_DAYS * DAY) ?? null;
  const open = new Map(aging.bills.map((b) => [b.id, b]));

  const waiting: WaitingMark[] = [];
  const confirmed: ConfirmedMark[] = [];
  let waitingTotal = new Money(0);

  for (const inv of entries) {
    if (inv.type !== "INVOICE" || !inv.paymentSentAt || inv.supersededById !== null) continue;
    const mark = inv.paymentSentAt;
    const markedAt = mark.toISOString();
    const posted = paymentSince(mark);
    const bill = open.get(inv.id);

    if (bill) {
      waitingTotal = waitingTotal.add(bill.open);
      // Calendar days since the tick ("10 days ago" on the 16th for a tick on the 6th).
      const days = Math.round(
        (Date.parse(now.toISOString().slice(0, 10)) - Date.parse(markedAt.slice(0, 10))) / DAY,
      );
      let state: MarkState = "waiting";
      let note = `Paid ${short(markedAt)} · waiting for the payment to show up`;
      if (posted) {
        state = "short";
        note =
          `A ${dollars(posted.amount)} payment posted ${short(posted.entryDate.toISOString())}, but this bill still ` +
          `shows ${dollars(bill.open)} owed — check the amount (payments clear the oldest bills first)`;
      } else if (days >= LATE_DAYS) {
        state = "late";
        note = `Marked paid ${short(markedAt)} (${days} days ago) — no payment has shown up yet`;
      }
      waiting.push({
        billId: inv.id,
        reference: inv.reference,
        open: bill.open,
        markedAt,
        state,
        note,
      });
    } else if (now.getTime() - mark.getTime() <= CONFIRMED_SHOWN_DAYS * DAY) {
      confirmed.push({
        billId: inv.id,
        reference: inv.reference,
        amount: inv.amount.toFixed(2),
        markedAt,
        payment: posted
          ? { date: posted.entryDate.toISOString().slice(0, 10), amount: posted.amount.toFixed(2) }
          : null,
      });
    }
  }
  confirmed.sort((a, b) => b.markedAt.localeCompare(a.markedAt));
  return { waiting, confirmed, waitingTotal: waitingTotal.toFixed(2) };
}
