import type { SupabaseClient } from "@supabase/supabase-js";
import { returningBookings, type RunsheetSession } from "./runsheet";
import { zonedTimeToUtc } from "./slots";

type Tenant = { id: string; timezone: string };

const addDay = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

/**
 * The classes and people for a runsheet, read as the signed-in member: dates
 * that go ahead between two days on the workspace's clocks (or one date by
 * its id), everyone confirmed on them, and who among them has come before.
 * A failed "who has come before" read leaves the badges off; it never costs
 * the sheet.
 */
export async function loadRunsheet(
  supabase: SupabaseClient,
  tenant: Tenant,
  pick: { from: string; to: string } | { sessionId: string },
): Promise<RunsheetSession[] | null> {
  let query = supabase
    .from("sessions")
    .select("id, starts_at, ends_at, capacity, services(name, location)")
    .eq("tenant_id", tenant.id)
    .order("starts_at")
    .limit(300);
  if ("sessionId" in pick) {
    query = query.eq("id", pick.sessionId);
  } else {
    const start = zonedTimeToUtc(pick.from, 0, tenant.timezone);
    const end = zonedTimeToUtc(addDay(pick.to), 0, tenant.timezone);
    if (!start || !end) return [];
    query = query
      .is("cancelled_at", null)
      .gte("starts_at", start.toISOString())
      .lt("starts_at", end.toISOString());
  }
  const { data: sessionRows, error } = await query;
  if (error) return null;
  const rows = (sessionRows ?? []) as unknown as {
    id: string;
    starts_at: string;
    ends_at: string;
    capacity: number;
    services: { name: string; location: string | null } | null;
  }[];
  if (rows.length === 0) return [];

  const { data: bookingRows, error: bookingError } = await supabase
    .from("bookings")
    .select(
      "id, session_id, customer_name, customer_email, customer_phone, seats, attendance, notes, answers",
    )
    .eq("tenant_id", tenant.id)
    .eq("status", "confirmed")
    .in(
      "session_id",
      rows.map((r) => r.id),
    )
    .order("created_at")
    .limit(5000);
  if (bookingError) return null;
  const bookings = (bookingRows ?? []) as {
    id: string;
    session_id: string;
    customer_name: string;
    customer_email: string;
    customer_phone: string | null;
    seats: number;
    attendance: "attended" | "no_show" | null;
    notes: string | null;
    answers: Record<string, string> | null;
  }[];

  const startOf = new Map(rows.map((r) => [r.id, r.starts_at]));
  const returning = await loadReturning(
    supabase,
    tenant.id,
    bookings.map((b) => ({
      id: b.id,
      email: b.customer_email,
      starts_at: startOf.get(b.session_id) ?? "",
    })),
  );

  return rows.map((r) => ({
    id: r.id,
    service: r.services?.name ?? "Class",
    location: r.services?.location ?? "",
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    capacity: r.capacity,
    people: bookings
      .filter((b) => b.session_id === r.id)
      .map((b) => ({
        id: b.id,
        name: b.customer_name,
        email: b.customer_email,
        phone: b.customer_phone ?? "",
        seats: b.seats,
        attendance: b.attendance,
        notes: b.notes ?? "",
        answers: b.answers ?? {},
        returning: returning.has(b.id),
      })),
  }));
}

/**
 * Which of these bookings belong to someone who came before: worked out on
 * read from the workspace's own earlier bookings, by email. Empty when it
 * can't be read.
 */
export async function loadReturning(
  supabase: SupabaseClient,
  tenantId: string,
  people: { id: string; email: string; starts_at: string }[],
): Promise<Set<string>> {
  const emails = [
    ...new Set(
      people.flatMap((p) => [p.email, p.email.trim().toLowerCase()]).filter((e) => e.trim()),
    ),
  ];
  if (emails.length === 0) return new Set();
  const latest = people.reduce((max, p) => (p.starts_at > max ? p.starts_at : max), "");
  try {
    const history: { email: string; starts_at: string }[] = [];
    for (let i = 0; i < emails.length; i += 200) {
      const { data, error } = await supabase
        .from("bookings")
        .select("customer_email, sessions!inner(starts_at, cancelled_at)")
        .eq("tenant_id", tenantId)
        .eq("status", "confirmed")
        .in("customer_email", emails.slice(i, i + 200))
        .lt("sessions.starts_at", latest)
        .is("sessions.cancelled_at", null)
        .limit(1000);
      if (error) return new Set();
      for (const row of (data ?? []) as unknown as {
        customer_email: string;
        sessions: { starts_at: string } | null;
      }[]) {
        if (row.sessions)
          history.push({ email: row.customer_email, starts_at: row.sessions.starts_at });
      }
    }
    return returningBookings(people, history);
  } catch {
    return new Set();
  }
}
