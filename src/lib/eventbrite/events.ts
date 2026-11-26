import type { EventbriteEvent } from "./client";

/**
 * Matching a date here with an event on Eventbrite, for the linking page.
 * Pure. An event is suggested for a date only when it starts at the very
 * same minute and nobody has linked it already; anything else is the
 * person's choice from the list. A date's ticket type is the event's first
 * unless the person picks another, as in the earlier app.
 */

const minute = (iso: string | null) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 60_000) : null;
};

export function suggestEvent(
  startsAt: string,
  events: EventbriteEvent[],
  taken: ReadonlySet<string> = new Set(),
): EventbriteEvent | null {
  const at = minute(startsAt);
  if (at === null) return null;
  const same = events.filter((e) => !taken.has(e.id) && minute(e.startUtc) === at);
  // Two events at one minute: no guess between them.
  return same.length === 1 ? same[0] : null;
}

/** The ticket type to keep in step: the one asked for if the event has it, else the first. */
export function pickTicketClass(event: EventbriteEvent, wanted: string | null): string | null {
  if (wanted && event.ticketClasses.some((t) => t.id === wanted)) return wanted;
  return event.ticketClasses[0]?.id ?? null;
}

/** A date's link as members read it (name the columns: see CLAUDE.md, Connections). */
export type ListingRow = {
  id: string;
  session_id: string;
  event_id: string;
  ticket_class_id: string | null;
  event_name: string;
  status: string;
  detail: string;
  checked_at: string | null;
  eb_total: number | null;
  eb_sold: number | null;
  eb_hidden: boolean | null;
  seats_left: number | null;
};

export const LISTING_COLUMNS =
  "id, session_id, event_id, ticket_class_id, event_name, status, detail, checked_at, eb_total, eb_sold, eb_hidden, seats_left";

/** How a link stands, in the words the date's page shows. */
export type LinkState = {
  tone: "good" | "waiting" | "bad" | "closed";
  label: string;
  /** Eventbrite's or our own words for what went wrong. */
  detail: string;
  /** A manager may press "Try again". */
  retry: boolean;
};

export function linkState(row: {
  status: string;
  detail: string;
  ticket_class_id: string | null;
  checked_at: string | null;
  eb_hidden: boolean | null;
  eb_total: number | null;
  eb_sold: number | null;
}): LinkState {
  if (!row.ticket_class_id) {
    return {
      tone: "closed",
      label: "Takes orders; no ticket type to keep in step",
      detail: "",
      retry: false,
    };
  }
  if (row.status === "failed") {
    return { tone: "bad", label: "Eventbrite said no", detail: row.detail, retry: true };
  }
  if (row.status === "unsure") {
    return { tone: "bad", label: "Not sure Eventbrite has it", detail: row.detail, retry: true };
  }
  if (row.status === "done" && row.checked_at) {
    const soldOut = row.eb_hidden || (row.eb_total !== null && row.eb_total === row.eb_sold);
    return {
      tone: "good",
      label: soldOut ? "On Eventbrite · sold out there" : "On Eventbrite",
      detail: "",
      retry: false,
    };
  }
  return { tone: "waiting", label: "Not on Eventbrite yet", detail: "", retry: false };
}
