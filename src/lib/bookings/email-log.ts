/**
 * The message log (Bookings → Emails sent): what the once-only record in
 * `booking_emails` says about each email that goes out by itself, in words.
 * Pure, so the filters in the address and the words for each state are
 * tested without a page.
 */

export const LOG_KINDS = ["reminder", "day_of", "followup", "cancelled"] as const;
export type LogKind = (typeof LOG_KINDS)[number];

export const KIND_NAMES: Record<LogKind, string> = {
  reminder: "Reminder",
  day_of: "Day-of reminder",
  followup: "Thank-you",
  cancelled: "Cancelled by a shop refund",
};

/** What a person can filter by: how it went, in their words rather than the table's. */
export const LOG_STATES = ["sent", "trying", "failed", "unsure", "waiting"] as const;
export type LogState = (typeof LOG_STATES)[number];

export const STATE_NAMES: Record<LogState, string> = {
  sent: "Sent",
  trying: "Trying again",
  failed: "Didn't go",
  unsure: "Not sure it went",
  waiting: "On its way",
};

export type LogRow = {
  status: "queued" | "sending" | "sent" | "failed" | "unsure";
  next_try_at: string | null;
};

/** How one email went, as the list says it. */
export function logState(row: LogRow): LogState {
  if (row.status === "sent") return "sent";
  if (row.status === "unsure") return "unsure";
  if (row.status === "failed") return row.next_try_at ? "trying" : "failed";
  return "waiting";
}

export const STATE_TONES: Record<LogState, "good" | "waiting" | "bad" | "open"> = {
  sent: "good",
  trying: "waiting",
  failed: "bad",
  unsure: "waiting",
  waiting: "open",
};

export type LogFilters = { kind: LogKind | null; state: LogState | null; q: string };

const pick = <T extends string>(list: readonly T[], value: unknown): T | null =>
  typeof value === "string" && (list as readonly string[]).includes(value) ? (value as T) : null;

/** Reads the filters from the address; anything unknown is no filter. */
export function parseLogFilters(params: Record<string, string | string[] | undefined>): LogFilters {
  const one = (name: string) => {
    const value = params[name];
    return Array.isArray(value) ? value[0] : value;
  };
  return {
    kind: pick(LOG_KINDS, one("kind")),
    state: pick(LOG_STATES, one("state")),
    q: (one("q") ?? "").trim().toLowerCase().slice(0, 80),
  };
}

/** The table's statuses a state covers, for the query. */
export function statusesFor(state: LogState): LogRow["status"][] {
  if (state === "waiting") return ["queued", "sending"];
  if (state === "trying" || state === "failed") return ["failed"];
  return [state];
}

/** The address of the log with one filter changed (null takes it off). */
export function logHref(
  base: string,
  filters: LogFilters,
  change: Partial<Omit<LogFilters, "q">>,
): string {
  const next = { ...filters, ...change };
  const params = new URLSearchParams();
  if (next.kind) params.set("kind", next.kind);
  if (next.state) params.set("state", next.state);
  if (next.q) params.set("q", next.q);
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}
