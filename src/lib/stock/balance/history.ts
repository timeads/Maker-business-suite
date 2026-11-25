import type { AgingResult } from "./aging";
import { absorbedPayments, type LedgerEntryInput, type LedgerType } from "./balance";
import { payDay } from "./calendar";
import { Money } from "./money";

/**
 * One supplier's account read as a story (pure, unit-tested): the balance
 * after every entry, where a statement re-set it, and which payments cleared
 * which bills.
 *
 * Nothing here decides what is owed. That is `computeVendorBalance` (the
 * latest statement plus what came after) and `computeAging` (what's owed is
 * the most recent invoices). This file explains those answers:
 *
 *  - Running balance: entries in date order, a statement taking over from
 *    whatever came before it. Before the first statement the starting figure
 *    isn't known, so no balance is shown for those rows.
 *  - Who cleared what: payments and credits count against the oldest bills
 *    first. A statement can settle a bill no payment here accounts for (the
 *    supplier already counted it as paid), or say more is owed than the
 *    invoices written down. Either way an invoice's "still owed" is always
 *    the ageing's figure, and payments are only matched up to what that
 *    leaves as paid, so the two can never disagree.
 */

const DAY = 86400000;
const ZERO = new Money(0);
const iso = (d: Date) => d.toISOString().slice(0, 10);

export type ClearingKind = "PAYMENT" | "CREDIT";

/** A payment or credit counted against an invoice, and how much of it. */
export interface Clearing {
  entryId: string;
  kind: ClearingKind;
  date: string;
  reference: string | null;
  amount: string;
}

export type InvoiceState = "open" | "part" | "cleared" | "notCounted";

export interface InvoiceStanding {
  id: string;
  reference: string | null;
  /** Invoice date, YYYY-MM-DD. */
  date: string;
  amount: string;
  dueDate: string;
  /** The day to pay it: the due date, or the Friday before a weekend. */
  payBy: string;
  ageDays: number;
  /** Negative = days until it's due. */
  daysPastDue: number;
  /** Still owed, as the ageing has it. */
  open: string;
  paid: string;
  state: InvoiceState;
  /** Why it isn't counted: dated after today, or the same invoice written down twice. */
  notCounted: "future" | "duplicate" | null;
  clearedBy: Clearing[];
  /** Paid, but not by a payment written down here (a statement already counted it). */
  unmatched: string;
  /** ISO time someone ticked "Paid", or null. */
  paymentSentAt: string | null;
}

export interface PaymentUse {
  id: string;
  kind: ClearingKind;
  date: string;
  amount: string;
  reference: string | null;
  cleared: { invoiceId: string; reference: string | null; amount: string; whole: boolean }[];
  /** Not matched to an invoice here: it went to an older balance, or sits as credit. */
  rest: string;
}

export interface HistoryRow {
  id: string;
  type: LedgerType;
  date: string;
  /** The balance after this entry (signed; negative = credit), or null when it isn't known. */
  running: string | null;
  /** A statement: the balance is re-set to the supplier's own figure here. */
  anchor: boolean;
  /** The statement today's balance stands on. */
  current: boolean;
  /** Statements only: what the entries came to just before it, when that is known. */
  computedBefore: string | null;
  /** Statements only: stated − computed. Null when there was nothing in between to add up. */
  delta: string | null;
  /** False for an entry dated after today: it isn't in the balance yet. */
  counted: boolean;
  /**
   * Only ever true: the bank's notice of a payment the supplier also reported
   * receiving. The two are one payment, counted with the supplier's entry, so
   * the balance doesn't move here.
   */
  sameAsReported?: true;
}

export interface AccountHistory {
  /** Oldest first. */
  rows: HistoryRow[];
  /** Oldest first. */
  invoices: InvoiceStanding[];
  /** Payments and credits, oldest first. */
  payments: PaymentUse[];
}

type Slot = { invoiceId: string | null; left: Money };
type Part = { entryId: string; amount: Money };

const isCredit = (e: LedgerEntryInput) => e.type === "ADJUSTMENT" && e.amount.lt(0);
const clears = (e: LedgerEntryInput) => e.type === "PAYMENT" || isCredit(e);

/**
 * `entries` in the order they were written down (oldest first): entries on
 * the same day keep that order, except that a statement closes its day, the
 * way the balance counts it.
 */
export function accountHistory(
  entries: LedgerEntryInput[],
  aging: AgingResult,
  asOf: Date,
): AccountHistory {
  const live = entries.filter((e) => e.supersededById === null);
  const rank = (e: LedgerEntryInput) => (e.type === "STATEMENT" ? 1 : 0);
  const sorted = live
    .map((e, i) => ({ e, i }))
    .sort(
      (a, b) =>
        a.e.entryDate.getTime() - b.e.entryDate.getTime() || rank(a.e) - rank(b.e) || a.i - b.i,
    )
    .map((x) => x.e);
  const counted = sorted.filter((e) => e.entryDate <= asOf);
  // A payment seen from the bank's side and reported by the supplier is one
  // payment (the balance's own rule); the supplier's entry is the one counted.
  const absorbed = absorbedPayments(counted.filter((e) => e.type !== "STATEMENT"));
  const future = sorted.filter((e) => e.entryDate > asOf);

  // The same invoice written down twice (same number and amount) counts once:
  // the newest stands, as in the ageing.
  const duplicates = new Set<string>();
  const seen = new Set<string>();
  for (const e of [...counted].reverse()) {
    if (e.type !== "INVOICE") continue;
    const key = `${(e.reference ?? e.id).toUpperCase()}|${e.amount.toFixed(2)}`;
    if (seen.has(key)) duplicates.add(e.id);
    else seen.add(key);
  }

  // --- The balance after each entry -------------------------------------
  const statements = counted.filter((e) => e.type === "STATEMENT" && e.statedBalance !== null);
  const lastStatement = statements[statements.length - 1] ?? null;
  let known = statements.length === 0;
  let running = ZERO;
  let sinceStatement = 0;
  const rows: HistoryRow[] = [];
  for (const e of counted) {
    const row: HistoryRow = {
      id: e.id,
      type: e.type,
      date: iso(e.entryDate),
      running: null,
      anchor: false,
      current: false,
      computedBefore: null,
      delta: null,
      counted: true,
    };
    if (e.type === "STATEMENT" && e.statedBalance !== null) {
      if (known && statements[0] !== e && sinceStatement > 0) {
        row.computedBefore = running.toFixed(2);
        row.delta = e.statedBalance.sub(running).toFixed(2);
      }
      running = e.statedBalance;
      known = true;
      sinceStatement = 0;
      row.anchor = true;
      row.current = e === lastStatement;
    } else if (e.type === "INVOICE" || e.type === "ADJUSTMENT") {
      running = running.add(e.amount);
      sinceStatement++;
    } else if (e.type === "PAYMENT") {
      if (absorbed.has(e.id)) {
        row.sameAsReported = true;
      } else {
        running = running.sub(e.amount);
        sinceStatement++;
      }
    }
    row.running = known ? running.toFixed(2) : null;
    rows.push(row);
  }
  for (const e of future) {
    rows.push({
      id: e.id,
      type: e.type,
      date: iso(e.entryDate),
      running: null,
      anchor: false,
      current: false,
      computedBefore: null,
      delta: null,
      counted: false,
    });
  }

  // --- Which payments cleared which bills (oldest first) -----------------
  const parts = new Map<string, Part[]>();
  const attribute = (invoiceId: string, entryId: string, amount: Money) => {
    const list = parts.get(invoiceId) ?? [];
    list.push({ entryId, amount });
    parts.set(invoiceId, list);
  };
  let queue: Slot[] = [];
  let credit: { entryId: string | null; left: Money }[] = [];
  const invoicesSoFar: LedgerEntryInput[] = [];

  /** New money owed: any credit in hand goes against it first. */
  const owe = (amount: Money, invoiceId: string | null) => {
    let need = amount;
    while (need.gt(0) && credit.length > 0) {
      const c = credit[0]!;
      const take = Money.min(c.left, need);
      if (invoiceId && c.entryId) attribute(invoiceId, c.entryId, take);
      c.left = c.left.sub(take);
      need = need.sub(take);
      if (c.left.lte(0)) credit.shift();
    }
    if (need.gt(0)) queue.push({ invoiceId, left: need });
  };
  /** Money sent, or a credit: it clears the oldest of what's owed. */
  const pay = (entryId: string, amount: Money) => {
    let left = amount;
    while (left.gt(0) && queue.length > 0) {
      const slot = queue[0]!;
      const take = Money.min(slot.left, left);
      if (slot.invoiceId) attribute(slot.invoiceId, entryId, take);
      slot.left = slot.left.sub(take);
      left = left.sub(take);
      if (slot.left.lte(0)) queue.shift();
    }
    if (left.gt(0)) credit.push({ entryId, left });
  };
  /** A statement: what's open is re-set to the newest invoices, up to its figure. */
  const anchor = (stated: Money) => {
    const total = queue
      .reduce((s, q) => s.add(q.left), ZERO)
      .sub(credit.reduce((s, c) => s.add(c.left), ZERO));
    if (stated.equals(total)) return;
    if (stated.lte(0)) {
      queue = [];
      credit = stated.lt(0) ? [{ entryId: null, left: stated.neg() }] : [];
      return;
    }
    credit = [];
    let remaining = stated;
    const open = new Map<string, Money>();
    for (const inv of [...invoicesSoFar].reverse()) {
      if (remaining.lte(0)) break;
      const o = Money.min(inv.amount, remaining);
      open.set(inv.id, o);
      remaining = remaining.sub(o);
    }
    for (const [id, o] of open) {
      const inv = invoicesSoFar.find((i) => i.id === id)!;
      trim(parts, id, inv.amount.sub(o));
    }
    queue = [
      ...(remaining.gt(0) ? [{ invoiceId: null, left: remaining }] : []),
      ...invoicesSoFar
        .filter((inv) => open.has(inv.id))
        .map((inv) => ({ invoiceId: inv.id, left: open.get(inv.id)! })),
    ];
  };

  for (const e of counted) {
    if (e.type === "STATEMENT") {
      if (e.statedBalance !== null) anchor(e.statedBalance);
    } else if (e.type === "INVOICE") {
      if (duplicates.has(e.id)) continue;
      invoicesSoFar.push(e);
      owe(e.amount, e.id);
    } else if (e.type === "PAYMENT") {
      if (!absorbed.has(e.id)) pay(e.id, e.amount);
    } else if (isCredit(e)) {
      pay(e.id, e.amount.neg());
    } else if (e.amount.gt(0)) {
      owe(e.amount, null);
    }
  }

  // --- Each invoice as it stands: the ageing's figure is the last word ----
  const byId = new Map(sorted.map((e) => [e.id, e]));
  const openNow = new Map(aging.bills.map((b) => [b.id, new Money(b.open)]));
  const invoices: InvoiceStanding[] = [];
  for (const e of sorted) {
    if (e.type !== "INVOICE") continue;
    const ageDays = Math.floor((asOf.getTime() - e.entryDate.getTime()) / DAY);
    const dueDate = iso(new Date(e.entryDate.getTime() + aging.termsDays * DAY));
    const notCounted = e.entryDate > asOf ? "future" : duplicates.has(e.id) ? "duplicate" : null;
    const open = notCounted ? ZERO : (openNow.get(e.id) ?? ZERO);
    const paid = notCounted ? ZERO : e.amount.sub(open);
    if (!notCounted) trim(parts, e.id, paid);
    const clearedBy = notCounted
      ? []
      : (parts.get(e.id) ?? []).map((p): Clearing => {
          const by = byId.get(p.entryId)!;
          return {
            entryId: by.id,
            kind: by.type === "PAYMENT" ? "PAYMENT" : "CREDIT",
            date: iso(by.entryDate),
            reference: by.reference,
            amount: p.amount.toFixed(2),
          };
        });
    const matched = clearedBy.reduce((s, c) => s.add(c.amount), ZERO);
    invoices.push({
      id: e.id,
      reference: e.reference,
      date: iso(e.entryDate),
      amount: e.amount.toFixed(2),
      dueDate,
      payBy: payDay(dueDate),
      ageDays,
      daysPastDue: ageDays - aging.termsDays,
      open: open.toFixed(2),
      paid: paid.toFixed(2),
      state: notCounted
        ? "notCounted"
        : open.lte(0)
          ? "cleared"
          : open.lt(e.amount)
            ? "part"
            : "open",
      notCounted,
      clearedBy,
      unmatched: paid.sub(matched).toFixed(2),
      paymentSentAt: e.paymentSentAt ? e.paymentSentAt.toISOString() : null,
    });
  }

  const payments: PaymentUse[] = counted
    .filter((e) => clears(e) && !absorbed.has(e.id))
    .map((e) => {
      const cleared = invoices.flatMap((inv) =>
        inv.clearedBy
          .filter((c) => c.entryId === e.id)
          .map((c) => ({
            invoiceId: inv.id,
            reference: inv.reference,
            amount: c.amount,
            whole: new Money(c.amount).equals(inv.amount),
          })),
      );
      const amount = e.type === "PAYMENT" ? e.amount : e.amount.neg();
      return {
        id: e.id,
        kind: e.type === "PAYMENT" ? "PAYMENT" : "CREDIT",
        date: iso(e.entryDate),
        amount: amount.toFixed(2),
        reference: e.reference,
        cleared,
        rest: amount.sub(cleared.reduce((s, c) => s.add(c.amount), ZERO)).toFixed(2),
      };
    });

  return { rows, invoices, payments };
}

/** Cuts an invoice's matched payments back to `allowed`, newest match first. */
function trim(parts: Map<string, Part[]>, invoiceId: string, allowed: Money) {
  const list = parts.get(invoiceId);
  if (!list) return;
  let over = list.reduce((s, p) => s.add(p.amount), ZERO).sub(allowed);
  while (over.gt(0) && list.length > 0) {
    const last = list[list.length - 1]!;
    const cut = Money.min(last.amount, over);
    last.amount = last.amount.sub(cut);
    over = over.sub(cut);
    if (last.amount.lte(0)) list.pop();
  }
}

export type InvoiceEventKind = "invoiced" | "marked" | "payment" | "credit" | "payBy" | "due";

export interface InvoiceEvent {
  kind: InvoiceEventKind;
  /** YYYY-MM-DD. */
  date: string;
  amount: string | null;
  reference: string | null;
  /** On or before today. */
  happened: boolean;
}

/**
 * An invoice's own timeline, in date order: invoiced, ticked "Paid", each
 * payment counted against it, the day to pay (when the due date is a
 * weekend) and the due date. `markedDay` is the day of the tick in the
 * workspace's own calendar.
 */
export function invoiceTimeline(
  invoice: InvoiceStanding,
  today: string,
  markedDay: string | null,
): InvoiceEvent[] {
  const events: Omit<InvoiceEvent, "happened">[] = [
    { kind: "invoiced", date: invoice.date, amount: invoice.amount, reference: invoice.reference },
  ];
  if (markedDay) events.push({ kind: "marked", date: markedDay, amount: null, reference: null });
  for (const c of invoice.clearedBy) {
    events.push({
      kind: c.kind === "PAYMENT" ? "payment" : "credit",
      date: c.date,
      amount: c.amount,
      reference: c.reference,
    });
  }
  if (invoice.payBy !== invoice.dueDate) {
    events.push({ kind: "payBy", date: invoice.payBy, amount: null, reference: null });
  }
  events.push({ kind: "due", date: invoice.dueDate, amount: null, reference: null });
  const order: InvoiceEventKind[] = ["invoiced", "marked", "payment", "credit", "payBy", "due"];
  return events
    .map((e, i) => ({ e, i }))
    .sort(
      (a, b) =>
        a.e.date.localeCompare(b.e.date) ||
        order.indexOf(a.e.kind) - order.indexOf(b.e.kind) ||
        a.i - b.i,
    )
    .map(({ e }) => ({ ...e, happened: e.date <= today }));
}

/** The invoices either side of one, by date: its place in the supplier's account. */
export function invoiceNeighbours(
  invoices: InvoiceStanding[],
  id: string,
): {
  position: number;
  total: number;
  before: InvoiceStanding | null;
  after: InvoiceStanding | null;
} {
  const index = invoices.findIndex((i) => i.id === id);
  return {
    position: index + 1,
    total: invoices.length,
    before: index > 0 ? invoices[index - 1]! : null,
    after: index >= 0 && index < invoices.length - 1 ? invoices[index + 1]! : null,
  };
}
