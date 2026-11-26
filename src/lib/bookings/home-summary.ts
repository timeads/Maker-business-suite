import type { SupabaseClient } from "@supabase/supabase-js";
import { lastMonthSamePoint, upOnLastMonth } from "../stock/home-summary";
import { localDay, zonedTimeToUtc } from "./slots";

/**
 * Bookings in a line or two for the workspace's home card, after the
 * business's earlier booking app's hub cards: bookings made this month,
 * how full the coming weeks are, classes already full and people coming
 * back. Like Stock's, they are only ever said when they are good news, and
 * a failed read leaves them off rather than costing the page.
 */

export type BookingsHomeFacts = {
  /** Confirmed bookings made since the 1st (workspace time), and their places. */
  bookingsThisMonth: number;
  placesThisMonth: number;
  /** Bookings made last month up to the same point. */
  bookingsLastMonthToDate: number;
  /** Places taken and offered on dates in the next 30 days. */
  upcoming: { taken: number; capacity: number; dates: number; full: number };
  /** People booked this month who had booked before. */
  returningThisMonth: number;
};

export const UPCOMING_DAYS = 30;
/** Below this, "how full" is a worry, not a win: leave it to Bookings' own pages. */
export const FILL_MIN_PCT = 50;

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The facts worth saying, each a short phrase, the most useful first. */
export function bookingsHomeLines(facts: BookingsHomeFacts): string[] {
  const lines: string[] = [];
  if (facts.bookingsThisMonth > 0) {
    const compared = upOnLastMonth(facts.bookingsThisMonth, facts.bookingsLastMonthToDate);
    lines.push(
      `${plural(facts.bookingsThisMonth, "booking")} this month (${plural(facts.placesThisMonth, "place")})${compared ? `, ${compared}` : ""}`,
    );
  }
  const { taken, capacity, full } = facts.upcoming;
  if (capacity > 0 && taken > 0) {
    // Rounded down, so a date with one place left never reads as "100%".
    const pct = Math.min(100, Math.floor((taken / capacity) * 100));
    if (pct >= FILL_MIN_PCT) {
      lines.push(`the next ${UPCOMING_DAYS} days are ${pct}% booked`);
    }
  }
  if (full > 0) lines.push(`${plural(full, "class", "classes")} full`);
  if (facts.returningThisMonth > 0) {
    lines.push(`${plural(facts.returningThisMonth, "person", "people")} came back to book again`);
  }
  return lines;
}

/** Reads the facts as the signed-in member. Every query names the workspace. */
export async function loadBookingsHomeFacts(
  supabase: SupabaseClient,
  tenant: { id: string; timezone: string },
  now: Date = new Date(),
): Promise<BookingsHomeFacts> {
  const today = localDay(now, tenant.timezone);
  const monthStart = zonedTimeToUtc(`${today.slice(0, 8)}01`, 0, tenant.timezone);
  const previous = lastMonthSamePoint(today);
  const prevStart = zonedTimeToUtc(previous.start, 0, tenant.timezone);
  if (!monthStart || !prevStart) throw new Error("No month start");
  // The same clock time on the matching day last month.
  const sinceMidnight =
    now.getTime() - (zonedTimeToUtc(today, 0, tenant.timezone)?.getTime() ?? now.getTime());
  const prevDay = zonedTimeToUtc(previous.day, 0, tenant.timezone);
  const prevCut =
    previous.day === `${today.slice(0, 8)}01`
      ? monthStart
      : new Date((prevDay ?? monthStart).getTime() + sinceMidnight);
  const horizon = new Date(now.getTime() + UPCOMING_DAYS * 86_400_000);

  const [thisMonth, lastMonth, dates] = await Promise.all([
    supabase
      .from("bookings")
      .select("seats, customer_email, created_at")
      .eq("tenant_id", tenant.id)
      .eq("status", "confirmed")
      .gte("created_at", monthStart.toISOString())
      .limit(5000),
    supabase
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant.id)
      .eq("status", "confirmed")
      .gte("created_at", prevStart.toISOString())
      .lt("created_at", prevCut.toISOString()),
    supabase
      .from("sessions")
      .select("id, capacity, bookings(seats, status)")
      .eq("tenant_id", tenant.id)
      .is("cancelled_at", null)
      .eq("private", false)
      .gte("starts_at", now.toISOString())
      .lt("starts_at", horizon.toISOString())
      .limit(500),
  ]);
  if (thisMonth.error || lastMonth.error || dates.error) throw new Error("Bookings unreadable");

  const made = (thisMonth.data ?? []) as { seats: number; customer_email: string }[];
  const emails = [
    ...new Set(made.flatMap((b) => [b.customer_email, b.customer_email.trim().toLowerCase()])),
  ].filter((e) => e.trim());
  let returning = 0;
  if (emails.length > 0) {
    const { data: before } = await supabase
      .from("bookings")
      .select("customer_email")
      .eq("tenant_id", tenant.id)
      .eq("status", "confirmed")
      .lt("created_at", monthStart.toISOString())
      .in("customer_email", emails.slice(0, 300))
      .limit(5000);
    returning = new Set(
      ((before ?? []) as { customer_email: string }[]).map((b) =>
        b.customer_email.trim().toLowerCase(),
      ),
    ).size;
  }

  let taken = 0;
  let capacity = 0;
  let full = 0;
  const sessions = (dates.data ?? []) as {
    capacity: number;
    bookings: { seats: number; status: string }[];
  }[];
  for (const s of sessions) {
    const seats = s.bookings
      .filter((b) => b.status === "confirmed")
      .reduce((n, b) => n + b.seats, 0);
    taken += Math.min(seats, s.capacity);
    capacity += s.capacity;
    if (seats >= s.capacity) full += 1;
  }

  return {
    bookingsThisMonth: made.length,
    placesThisMonth: made.reduce((n, b) => n + b.seats, 0),
    bookingsLastMonthToDate: lastMonth.count ?? 0,
    upcoming: { taken, capacity, dates: sessions.length, full },
    returningThisMonth: returning,
  };
}
