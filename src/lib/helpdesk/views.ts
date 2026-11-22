import { localDay, zonedTimeToUtc } from "../bookings/slots";
import type { Priority } from "./config";

/** The folders of the inbox. Every conversation is in exactly one of the first four. */
export const VIEWS = [
  { key: "open", label: "Needs a reply" },
  { key: "mine", label: "Assigned to me" },
  { key: "unassigned", label: "Nobody has it" },
  { key: "pending", label: "Waiting on customer" },
  { key: "snoozed", label: "Snoozed" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "Everything" },
] as const;
export type ViewKey = (typeof VIEWS)[number]["key"];

export const isView = (value: unknown): value is ViewKey =>
  VIEWS.some((view) => view.key === value);

export type TicketFacts = {
  status: "open" | "pending" | "closed";
  assignee_id: string | null;
  snoozed_until: string | null;
  merged_into: string | null;
};

export const isSnoozed = (ticket: Pick<TicketFacts, "snoozed_until">, now: number) =>
  ticket.snoozed_until !== null && Date.parse(ticket.snoozed_until) > now;

/** Whether a conversation belongs in a folder. Folded-away ones only show under Everything. */
export function inView(ticket: TicketFacts, view: ViewKey, me: string, now: number): boolean {
  if (view === "all") return true;
  if (ticket.merged_into) return false;
  const snoozed = isSnoozed(ticket, now);
  switch (view) {
    case "open":
      return ticket.status === "open" && !snoozed;
    case "mine":
      return ticket.status !== "closed" && !snoozed && ticket.assignee_id === me;
    case "unassigned":
      return ticket.status === "open" && !snoozed && ticket.assignee_id === null;
    case "pending":
      return ticket.status === "pending" && !snoozed;
    case "snoozed":
      return ticket.status !== "closed" && snoozed;
    case "closed":
      return ticket.status === "closed";
  }
}

export const PRIORITY_LABELS: Record<Priority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

/** Urgent first, then by the newest message. */
export function byUrgency<T extends { priority: Priority; last_message_at: string }>(
  a: T,
  b: T,
): number {
  const rank = (p: Priority) => (p === "urgent" ? 0 : p === "high" ? 1 : 2);
  return rank(a.priority) - rank(b.priority) || b.last_message_at.localeCompare(a.last_message_at);
}

/**
 * The "come back to this" choices, as instants. Mornings are 9:00 on the
 * workspace's own clock.
 */
export function snoozeChoices(
  now: Date,
  timeZone: string,
): { key: string; label: string; until: string }[] {
  const today = localDay(now, timeZone);
  const morning = (daysAhead: number) => {
    const [y, m, d] = today.split("-").map(Number);
    const day = new Date(Date.UTC(y, m - 1, d + daysAhead)).toISOString().slice(0, 10);
    return (zonedTimeToUtc(day, 9 * 60, timeZone) ?? new Date(`${day}T09:00:00Z`)).toISOString();
  };
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const toMonday = (8 - weekday) % 7 || 7;
  return [
    {
      key: "3h",
      label: "In 3 hours",
      until: new Date(now.getTime() + 3 * 3_600_000).toISOString(),
    },
    { key: "tomorrow", label: "Tomorrow morning", until: morning(1) },
    { key: "3d", label: "In 3 days", until: morning(3) },
    { key: "monday", label: "Monday morning", until: morning(toMonday) },
    { key: "2w", label: "In 2 weeks", until: morning(14) },
  ];
}

/** "2h 5m", "3d 4h": how long something took, for the reports page. */
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
