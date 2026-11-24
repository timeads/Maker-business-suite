import type { AgingResult } from "./aging";
import { Money } from "./money";

/**
 * Open bills as calendar events: one all-day event per supplier per pay day
 * (pure; ported from TuftStock's `vendor-account/calendar.ts` with its tests,
 * on whole-cents `Money`). TuftStock pushes these to a Google calendar every
 * morning; here they are handed over as an .ics file a person adds to the
 * calendar they already use, so no permission to anyone's calendar is needed.
 *
 * Pay day: a bill due on a Saturday or Sunday goes on the Friday before.
 */

export interface CalendarAccount {
  supplierId: string;
  supplierName: string;
  aging: AgingResult;
}

export interface BillEvent {
  /** Stable id: supplier + pay day. */
  key: string;
  /** Pay day (YYYY-MM-DD): the due date, or the Friday before when that's a weekend. */
  date: string;
  vendor: string;
  amount: string;
  overdue: boolean;
  title: string;
  description: string;
}

const DAY_MS = 86400000;
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const ms = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const short = (iso: string) => `${MON[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
const withWeekday = (iso: string) => `${WEEKDAY[new Date(ms(iso)).getUTCDay()]} ${short(iso)}`;

/** The day to pay a bill due on `dueDate`: Saturday and Sunday move back to Friday. */
export function payDay(dueDate: string): string {
  const dow = new Date(ms(dueDate)).getUTCDay();
  if (dow === 6) return isoDay(ms(dueDate) - DAY_MS);
  if (dow === 0) return isoDay(ms(dueDate) - 2 * DAY_MS);
  return dueDate;
}

/** "1,922.87": exact to the cent, with thousands marked. The caller adds the currency. */
export function amountWords(amount: string): string {
  const [whole, cents] = new Money(amount).toFixed(2).split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

export function billEvents(
  accounts: CalendarAccount[],
  today: string,
  /** Puts the currency on an amount ("$1,922.87"). */
  money: (amount: string) => string = (amount) => `$${amountWords(amount)}`,
): BillEvent[] {
  const events = new Map<
    string,
    BillEvent & { lines: string[]; total: Money; paid: Money; dues: Set<string>; terms: number }
  >();
  for (const a of accounts) {
    for (const bill of a.aging.bills) {
      const date = payDay(bill.dueDate);
      const key = `${a.supplierId}:${date}`;
      const ev = events.get(key) ?? {
        key,
        date,
        vendor: a.supplierName.trim(),
        amount: "0.00",
        overdue: false,
        title: "",
        description: "",
        lines: [],
        total: new Money(0),
        paid: new Money(0),
        dues: new Set<string>(),
        terms: a.aging.termsDays,
      };
      // A bill ticked "Paid" is still owed until the payment is added, but it
      // isn't something left to pay: it doesn't count toward the amount or "past due".
      const ticked = bill.paymentSentAt ? bill.paymentSentAt.slice(0, 10) : null;
      if (ticked) ev.paid = ev.paid.add(bill.open);
      else {
        ev.total = ev.total.add(bill.open);
        ev.overdue = ev.overdue || bill.dueDate < today;
      }
      ev.dues.add(bill.dueDate);
      const owed = bill.partial
        ? `${money(bill.open)} still owed of ${money(bill.amount)}`
        : money(bill.open);
      ev.lines.push(
        `${bill.reference ?? "Invoice"} · ${owed} (invoiced ${short(bill.date)})${ticked ? `, paid ${short(ticked)}, waiting to show up` : ""}`,
      );
      events.set(key, ev);
    }
  }

  return [...events.values()]
    .map(({ lines, total, paid, dues, terms, ...ev }) => {
      const allPaid = total.isZero() && paid.gt(0);
      const amount = (allPaid ? paid : total).toFixed(2);
      const due = [...dues].sort();
      const moved = due.filter((d) => d !== ev.date);
      const notes = [
        ...lines,
        "",
        moved.length > 0
          ? `Due ${moved.map(withWeekday).join(", ")}: on the Friday before because that's a weekend.`
          : `Due ${withWeekday(ev.date)} (${terms} days from the invoice date).`,
        ev.overdue ? "Past due and not yet marked as paid." : null,
      ].filter((l): l is string => l !== null);
      return {
        ...ev,
        amount,
        title: allPaid
          ? `Paid · ${ev.vendor} due - ${money(amount)}`
          : `${ev.overdue ? "PAST DUE · " : ""}${ev.vendor} due - ${money(amount)}`,
        description: notes.join("\n"),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.vendor.localeCompare(b.vendor));
}

/** Text as an .ics value: backslash, semicolon, comma and line breaks escaped. */
const icsText = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Lines no longer than 75 bytes, continued with a leading space, as the format asks. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (new TextEncoder().encode(rest).length > 75) {
    let cut = Math.min(rest.length, 75);
    while (new TextEncoder().encode(rest.slice(0, cut)).length > 75) cut -= 1;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join("\r\n");
}

/**
 * The events as an iCalendar file. Each event keeps the same id from one
 * download to the next, so adding a newer file updates the events a calendar
 * already has rather than doubling them.
 */
export function toIcs(
  events: BillEvent[],
  opts: { name: string; stamp: Date; host: string },
): string {
  const stamp = `${opts.stamp.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
  const compact = (day: string) => day.replace(/-/g, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Maker Business Suite//Supplier bills//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(opts.name)}`,
  ];
  for (const event of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:bill-${event.key.replace(/[^A-Za-z0-9-]/g, "-")}@${opts.host}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact(event.date)}`,
      `DTEND;VALUE=DATE:${compact(isoDay(ms(event.date) + DAY_MS))}`,
      `SUMMARY:${icsText(event.title)}`,
      `DESCRIPTION:${icsText(event.description)}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
