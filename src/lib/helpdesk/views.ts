import { localDay, zonedTimeToUtc } from "../bookings/slots";
import type { Priority } from "./config";

/**
 * The built-in views of the inbox, in the order the menu shows them. The
 * names are the ones the team already uses: "In progress" is a conversation
 * we answered and are waiting on (the `pending` status).
 */
export const VIEWS = [
  { key: "mine", label: "Your tickets" },
  { key: "unassigned", label: "Unassigned" },
  { key: "open", label: "Open" },
  { key: "pending", label: "In progress" },
  { key: "snoozed", label: "Snoozed" },
  { key: "mentions", label: "Mentions" },
  // Shown in the menu only where a workspace has switched these messages on.
  { key: "social", label: "Instagram & Facebook" },
  { key: "closed", label: "Closed" },
  { key: "all", label: "All tickets" },
  { key: "archived", label: "Archived" },
  { key: "spam", label: "Spam" },
  { key: "trash", label: "Trash" },
] as const;
export type ViewKey = (typeof VIEWS)[number]["key"];

/** The three shelves a conversation can be put on. Each has a view of the same name. */
export const SHELVES = ["archived", "spam", "trash"] as const;
export type Shelf = (typeof SHELVES)[number];
export const isShelf = (value: unknown): value is Shelf => SHELVES.some((s) => s === value);
export const SHELF_LABELS: Record<Shelf, string> = {
  archived: "Archived",
  spam: "Spam",
  trash: "In the Trash",
};

export const isView = (value: unknown): value is ViewKey =>
  VIEWS.some((view) => view.key === value);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAVED_ID = /^[a-z0-9-]{1,40}$/;

/** What the `view` word in the address means: a built-in view, a folder (`f:<id>`) or a saved view (`v:<id>`). */
export type ViewChoice =
  { kind: "built"; key: ViewKey } | { kind: "folder"; id: string } | { kind: "saved"; id: string };

export function parseView(value: unknown): ViewChoice {
  const text = typeof value === "string" ? value : "";
  if (text.startsWith("f:") && UUID.test(text.slice(2)))
    return { kind: "folder", id: text.slice(2) };
  if (text.startsWith("v:") && SAVED_ID.test(text.slice(2)))
    return { kind: "saved", id: text.slice(2) };
  return { kind: "built", key: isView(text) ? text : "open" };
}

export const viewParam = (choice: ViewChoice): string =>
  choice.kind === "built" ? choice.key : `${choice.kind === "folder" ? "f" : "v"}:${choice.id}`;

export type TicketFacts = {
  status: "open" | "pending" | "closed";
  assignee_id: string | null;
  snoozed_until: string | null;
  merged_into: string | null;
  /** The folder it was filed in. Filed conversations leave the inbox views. */
  folder_id?: string | null;
  /** Whether a note on it names the person looking. */
  mentioned?: boolean;
  /** Archived, in Spam or in the Trash: out of every working view. */
  shelf?: Shelf | null;
  /** Where it came from: "email", "instagram" or "facebook". */
  channel?: string | null;
  /** "message", or "comment" for a conversation about a comment on a post. */
  kind?: string | null;
};

export const isSnoozed = (ticket: Pick<TicketFacts, "snoozed_until">, now: number) =>
  ticket.snoozed_until !== null && Date.parse(ticket.snoozed_until) > now;

/**
 * Whether a conversation belongs in a view. Joined-away ones only show under
 * All tickets. One filed in a folder shows only there, under Mentions, Closed
 * and All tickets (and in a search, which the page handles). A shelved one
 * (archived, spam, trash) shows on its own shelf and nowhere in the working
 * folders; Spam and Trash are left out of All tickets and Mentions as well.
 */
export function inView(ticket: TicketFacts, view: ViewKey, me: string, now: number): boolean {
  const shelf = ticket.shelf ?? null;
  if (isShelf(view)) return shelf === view && !ticket.merged_into;
  if (shelf === "spam" || shelf === "trash") return false;
  if (view === "all") return true;
  if (ticket.merged_into) return false;
  if (shelf) return view === "mentions" && ticket.mentioned === true;
  if (view === "closed") return ticket.status === "closed";
  if (view === "mentions") return ticket.mentioned === true;
  if (ticket.folder_id) return false;
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
    case "social":
      // Instagram and Facebook conversations being worked: open or in progress.
      return (
        ticket.status !== "closed" &&
        !snoozed &&
        (ticket.channel === "instagram" || ticket.channel === "facebook")
      );
    default:
      return false;
  }
}

/** A folder holds what was filed in it and isn't closed. */
export const inFolder = (ticket: TicketFacts, folderId: string): boolean =>
  !ticket.merged_into &&
  !ticket.shelf &&
  ticket.status !== "closed" &&
  ticket.folder_id === folderId;

export const STATUS_LABELS = { open: "Open", pending: "In progress", closed: "Closed" } as const;

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
