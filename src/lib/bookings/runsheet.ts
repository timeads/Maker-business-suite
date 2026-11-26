import { csvCell } from "./emails";
import { formatWhen, localDay } from "./slots";

/**
 * The runsheet: everyone coming over a stretch of days, one block per class,
 * for the studio floor. A date's roster PDF is the same sheet with one block.
 * Words first (`buildRunsheet`, pure and tested), then drawn
 * (`runsheet-pdf.tsx`), the way a purchase order's PDF is made.
 *
 * "Returning" is worked out on read (`returningBookings`): someone whose email
 * has a confirmed booking on an earlier date in the same workspace that went
 * ahead. Nothing about it is stored.
 */

export type RunsheetPerson = {
  id: string;
  name: string;
  email: string;
  phone: string;
  seats: number;
  attendance: "attended" | "no_show" | null;
  notes: string;
  answers: Record<string, string>;
  returning: boolean;
};

export type RunsheetSession = {
  id: string;
  service: string;
  location: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  people: RunsheetPerson[];
};

export type RunsheetBlock = {
  id: string;
  title: string;
  when: string;
  /** "Studio 2 · 8 of 10 places booked · 3 checked in" */
  line: string;
  rows: {
    id: string;
    attendance: RunsheetPerson["attendance"];
    name: string;
    returning: boolean;
    contact: string;
    seats: string;
    here: boolean;
    /** Notes and the answers to the business's own questions, one line each. */
    extra: string[];
  }[];
};

export type RunsheetDoc = {
  title: string;
  subtitle: string;
  business: string;
  blocks: RunsheetBlock[];
  /** Shown when anyone on the sheet has booked before. */
  footnote: string | null;
  empty: string;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Mar 6 to Mar 19, 2027", or one day on its own. */
export function rangeLabel(from: string, to: string): string {
  const day = (d: string, year: boolean) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      weekday: from === to ? "long" : undefined,
      month: "short",
      day: "numeric",
      ...(year ? { year: "numeric" } : {}),
    }).format(new Date(`${d}T12:00:00Z`));
  return from === to ? day(from, true) : `${day(from, false)} to ${day(to, true)}`;
}

export function buildRunsheet(input: {
  business: string;
  timezone: string;
  from: string;
  to: string;
  sessions: RunsheetSession[];
  /** One date's roster rather than a stretch of days. */
  single?: boolean;
}): RunsheetDoc {
  const sessions = [...input.sessions].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const blocks = sessions
    .map((s): RunsheetBlock => {
      const people = [...s.people].sort((a, b) => a.name.localeCompare(b.name));
      const taken = people.reduce((n, p) => n + p.seats, 0);
      const here = people.filter((p) => p.attendance === "attended").length;
      return {
        id: s.id,
        title: s.service,
        when: formatWhen(s.starts_at, s.ends_at, input.timezone),
        line: [
          s.location.trim(),
          `${taken} of ${plural(s.capacity, "place", "places")} booked`,
          here ? `${here} checked in` : "",
        ]
          .filter(Boolean)
          .join(" · "),
        rows: people.map((p) => ({
          id: p.id,
          attendance: p.attendance,
          name: p.name,
          returning: p.returning,
          contact: [p.email, p.phone.trim()].filter(Boolean).join(" · "),
          seats: String(p.seats),
          here: p.attendance === "attended",
          extra: [
            ...(p.notes.trim() ? [p.notes.trim()] : []),
            ...Object.entries(p.answers ?? {}).map(
              ([q, a]) => `${/[?:]$/.test(q) ? q : `${q}:`} ${a}`,
            ),
          ],
        })),
      };
    })
    // A stretch of days lists only the classes someone is coming to.
    .filter((block) => input.single || block.rows.length > 0);
  const single = input.single && sessions[0];
  return {
    title: single ? `${sessions[0].service}: who's coming` : "Runsheet",
    subtitle: single
      ? formatWhen(sessions[0].starts_at, sessions[0].ends_at, input.timezone)
      : rangeLabel(input.from, input.to),
    business: input.business,
    blocks,
    footnote: blocks.some((b) => b.rows.some((r) => r.returning))
      ? "Returning: has booked with you before."
      : null,
    empty: single ? "Nobody is booked on this date." : "Nobody is booked in these days.",
  };
}

/** The same sheet as a spreadsheet: one row per person. */
export function runsheetCsv(doc: RunsheetDoc, sessions: RunsheetSession[], timezone: string) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const lines: (string | number)[][] = [
    ["Class", "Day", "When", "Name", "Email", "Phone", "Places", "Returning", "Checked in"],
  ];
  for (const block of doc.blocks) {
    const session = byId.get(block.id);
    const people = [...(session?.people ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    for (const p of people) {
      lines.push([
        block.title,
        session ? localDay(new Date(session.starts_at), timezone) : "",
        block.when,
        p.name,
        p.email,
        p.phone,
        p.seats,
        p.returning ? "Yes" : "",
        p.attendance === "attended" ? "Yes" : p.attendance === "no_show" ? "No-show" : "",
      ]);
    }
  }
  return lines.map((line) => line.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/**
 * Which bookings belong to someone who has come before: a confirmed booking
 * under the same email (capitals and outer spaces aside) on an earlier date
 * that wasn't cancelled.
 */
export function returningBookings(
  people: { id: string; email: string; starts_at: string }[],
  history: { email: string; starts_at: string }[],
): Set<string> {
  const key = (email: string) => email.trim().toLowerCase();
  const earliest = new Map<string, string>();
  for (const h of history) {
    const k = key(h.email);
    if (!k) continue;
    const seen = earliest.get(k);
    if (!seen || h.starts_at < seen) earliest.set(k, h.starts_at);
  }
  const out = new Set<string>();
  for (const p of people) {
    const first = earliest.get(key(p.email));
    if (first && first < p.starts_at) out.add(p.id);
  }
  return out;
}

/** "2027-03-06" checked, or null. */
export function parseDay(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== value ? null : value;
}

/** The stretch of days a runsheet covers: today and the next 13 unless the address says. */
export function runsheetRange(
  params: { from?: unknown; to?: unknown },
  today: string,
): { from: string; to: string } {
  const add = (day: string, n: number) => {
    const [y, m, d] = day.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  };
  const from = parseDay(params.from) ?? today;
  let to = parseDay(params.to) ?? add(from, 13);
  if (to < from) to = from;
  // Never more than about three months on one sheet.
  if (to > add(from, 92)) to = add(from, 92);
  return { from, to };
}
