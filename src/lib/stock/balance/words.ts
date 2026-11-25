import { payDay } from "./calendar";
import { describeBalance } from "./format";
import { Money } from "./money";
import type { ConfirmedMark } from "./paid-marks";
import type { VendorSummary } from "./summary";

/**
 * What the Balances pages say, worked out apart from how they look (pure,
 * unit-tested): the facts on each supplier's card, the heading over the due
 * dates, the "pay Fri Dec 4" hint, the "Payments confirmed" lines, and how
 * entries reach an account. After TuftStock's Vendor balances page.
 */

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const at = (day: string) => new Date(`${day.slice(0, 10)}T12:00:00Z`);

/** "2026-11-17" as "Nov 17". A plain date, never shifted by a time zone. */
export function shortDay(day: string): string {
  return `${MON[at(day).getUTCMonth()]} ${at(day).getUTCDate()}`;
}
/** "2026-12-04" as "Fri Dec 4". */
export function weekDay(day: string): string {
  return `${WEEKDAY[at(day).getUTCDay()]} ${shortDay(day)}`;
}
export const dayCount = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

export type CardLine =
  | { kind: "empty" }
  | { kind: "pastDue"; amount: string; bills: number }
  | { kind: "oldest"; reference: string | null; dueDate: string }
  | { kind: "paidUp" }
  | { kind: "terms"; days: number };

export interface CardFacts {
  supplierId: string;
  name: string;
  /** Unsigned: which way it points is `direction`. */
  balance: string;
  direction: "owed" | "credit" | "settled";
  line: CardLine;
  /** Ticked "Paid" and still waiting for the payment, or null when there is none. */
  waiting: string | null;
}

/**
 * One supplier's card: what's owed, then the one fact most worth knowing.
 * Past-due money comes before the oldest unpaid bill, which comes before
 * "Paid up"; an account in credit just says how long they give you to pay.
 */
export function supplierCard(s: VendorSummary): CardFacts {
  const balance = new Money(s.balance);
  const direction = describeBalance(s.balance).direction;
  const line: CardLine = s.empty
    ? { kind: "empty" }
    : new Money(s.overdue).gt(0)
      ? { kind: "pastDue", amount: s.overdue, bills: s.overdueBills }
      : s.oldest
        ? { kind: "oldest", reference: s.oldest.reference, dueDate: s.oldest.dueDate }
        : direction === "settled"
          ? { kind: "paidUp" }
          : { kind: "terms", days: s.termsDays };
  return {
    supplierId: s.supplierId,
    name: s.name,
    balance: balance.abs().toFixed(2),
    direction,
    line,
    waiting: new Money(s.markedPaid).gt(0) ? new Money(s.markedPaid).toFixed(2) : null,
  };
}

/** The card's line in words. `money` puts the currency on an amount. */
export function cardLineWords(line: CardLine, money: (amount: string) => string): string {
  switch (line.kind) {
    case "empty":
      return "Nothing written down yet";
    case "pastDue":
      return `${money(line.amount)} past due`;
    case "oldest":
      return `Oldest unpaid ${line.reference ?? "bill"} due ${shortDay(line.dueDate)}`;
    case "paidUp":
      return "Paid up";
    case "terms":
      return `${dayCount(line.days)} to pay each invoice`;
  }
}

/**
 * The words after "When bills are due": the days to pay when every supplier
 * gives the same, otherwise that each has its own.
 */
export function termsHeading(termsDays: number | null): string {
  if (termsDays === null) return "each supplier's own days to pay";
  if (termsDays === 0) return "due on the invoice date";
  return `net ${termsDays} from the invoice date`;
}

/** "pay Fri Dec 4" for a bill due on a weekend; null when the due day is a weekday. */
export function payByHint(dueDate: string): string | null {
  const pay = payDay(dueDate);
  return pay === dueDate ? null : `pay ${weekDay(pay)}`;
}

/** How far off a due date is: "in 2 days", "today", "3 days late". */
export function dueWords(daysPastDue: number): { text: string; tone: "late" | "today" | "ahead" } {
  if (daysPastDue > 0) return { text: `${dayCount(daysPastDue)} late`, tone: "late" };
  if (daysPastDue === 0) return { text: "today", tone: "today" };
  return { text: `in ${dayCount(-daysPastDue)}`, tone: "ahead" };
}

/**
 * The tail of a "Payments confirmed" line: when it was ticked and what
 * cleared it. `markedDay` is the tick's day in the workspace's own calendar.
 */
export function confirmedWords(
  c: Pick<ConfirmedMark, "payment">,
  markedDay: string,
  money: (amount: string) => string,
): string {
  const marked = `you marked it paid ${shortDay(markedDay)}`;
  return c.payment
    ? `${marked}; cleared by the ${money(c.payment.amount)} payment of ${shortDay(c.payment.date)}`
    : `${marked}; it's no longer owed`;
}

export interface ArrivalFacts {
  /** The workspace has "read payments from my books" switched on. */
  booksOn: boolean;
  /** The newest entries filed from the books: when, and how many came in together. */
  lastBooks: { at: string; count: number } | null;
  /** The newest entries brought in from a spreadsheet. */
  lastImport: { at: string; count: number } | null;
  /** Bills by email, when the workspace uses it. */
  mail?: {
    /** The workspace has a bills address to forward to. */
    forwarding: boolean;
    /** Its Gmail is read directly, once a day. */
    reading: boolean;
    /** This supplier's sender is on the workspace's list. */
    listed: boolean;
  };
}

/**
 * The newest batch of rows from one source: rows written in the same moment
 * arrived together (one read of the books, one spreadsheet).
 */
export function lastArrival(
  rows: { createdAt: string; source: string }[],
  source: string,
): { at: string; count: number } | null {
  const mine = rows.filter((r) => r.source === source);
  if (mine.length === 0) return null;
  const at = mine.reduce((max, r) => (r.createdAt > max ? r.createdAt : max), mine[0]!.createdAt);
  return { at, count: mine.filter((r) => r.createdAt === at).length };
}

/**
 * "How entries get here", true for this workspace: typed in, brought in from
 * a spreadsheet, and (only when switched on) payments read from the books.
 */
export function arrivalWords(supplier: string, facts: ArrivalFacts): string[] {
  const out = [
    `Invoices, payments, statements and credits for ${supplier} are typed in here, or brought in from a spreadsheet under Settings → Stock.`,
  ];
  out.push(
    facts.booksOn
      ? `Payments made out to ${supplier} in your books are read at each sync and filed here, marked “your books”. Nothing is ever changed in your books.`
      : "Payments aren't read from your books. You can switch that on under Settings → Stock if your books are connected.",
  );
  const mail = facts.mail;
  if (mail && (mail.forwarding || mail.reading)) {
    const how = [
      mail.forwarding ? "forwarded to your bills address" : null,
      mail.reading ? "found in your Gmail at the daily read" : null,
    ]
      .filter(Boolean)
      .join(", or ");
    out.push(
      mail.listed
        ? `Emails from ${supplier} that are ${how} are read by Claude and filed here, marked “from email”. A read there's any doubt about is marked “to check”; it counts in the balance meanwhile, so look it over. The email itself isn't kept.`
        : `Bills by email is on, but ${supplier}'s sender isn't on your list yet, so their mail isn't recognised. Add it under Bills by email.`,
    );
  }
  out.push(
    `${supplier}'s latest statement always wins: anything dated on or before it is already in their figure, so each new statement sets the account straight.`,
  );
  return out;
}
