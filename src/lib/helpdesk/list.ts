import { PRIORITIES, type Priority } from "./config";

/** "now", "12m", "8h", "3d", "5w", "2y": how long ago, as short as it can be said. */
export function timeAgo(instant: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(instant)) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 365)}y`;
}

/** "opened 16h ago", "opened just now". */
export const openedAgo = (instant: string, now: number): string => {
  const ago = timeAgo(instant, now);
  return ago === "now" ? "opened just now" : `opened ${ago} ago`;
};

/**
 * Unread, for one person: the customer has written since they last looked.
 * A closed conversation is never unread; it has been dealt with.
 */
export function isUnread(
  lastInboundAt: string | null,
  readAt: string | null,
  status: "open" | "pending" | "closed",
): boolean {
  if (status === "closed" || !lastInboundAt) return false;
  return !readAt || Date.parse(lastInboundAt) > Date.parse(readAt);
}

export const SORTS = [
  { key: "newest", label: "Newest activity" },
  { key: "oldest", label: "Oldest activity" },
  { key: "waiting", label: "Waiting longest" },
  { key: "created", label: "Newest created" },
  { key: "priority", label: "Priority" },
] as const;
export type SortKey = (typeof SORTS)[number]["key"];
export const isSort = (value: unknown): value is SortKey => SORTS.some((s) => s.key === value);

export type ListRow = {
  priority: Priority;
  status: "open" | "pending" | "closed";
  assignee_id: string | null;
  last_message_at: string;
  created_at: string;
  last_inbound_at: string | null;
  tags: string[];
  unread: boolean;
  channel?: string | null;
  /** "message", or "comment" for a conversation about a comment on a post. */
  kind?: string | null;
};

export type ListFilters = {
  tag?: string;
  /** "me", "none" or a teammate's id. */
  assignee?: string;
  priority?: string;
  unread?: boolean;
  /** "email", "instagram", "facebook", or "social" for the last two together. */
  channel?: string;
  /** "message" or "comment": Instagram and Facebook bring both. */
  kind?: string;
};

/** Whether a conversation is the kind asked for ("comment", or "message" for everything else). */
export const kindMatches = (kind: string | null | undefined, want: string): boolean =>
  want === "comment" ? kind === "comment" : kind !== "comment";

/** The filter row above the list: every filter that is set must hold. */
export function passesFilters(row: ListRow, filters: ListFilters, me: string): boolean {
  if (filters.tag && !row.tags.includes(filters.tag)) return false;
  if (filters.assignee) {
    const want =
      filters.assignee === "me" ? me : filters.assignee === "none" ? null : filters.assignee;
    if (row.assignee_id !== want) return false;
  }
  if (filters.priority && row.priority !== filters.priority) return false;
  if (filters.unread && !row.unread) return false;
  if (filters.channel) {
    const is = row.channel ?? "email";
    const hit =
      filters.channel === "social"
        ? is === "instagram" || is === "facebook"
        : is === filters.channel;
    if (!hit) return false;
  }
  if (filters.kind && !kindMatches(row.kind, filters.kind)) return false;
  return true;
}

/** Orders the list. "Waiting longest" puts the customer who wrote first, and is still unanswered, on top. */
export function sortRows<T extends ListRow>(rows: T[], sort: SortKey): T[] {
  const by = (a: string, b: string) => a.localeCompare(b);
  const rank = (p: Priority) => PRIORITIES.length - PRIORITIES.indexOf(p);
  const sorted = [...rows];
  switch (sort) {
    case "newest":
      return sorted.sort((a, b) => by(b.last_message_at, a.last_message_at));
    case "oldest":
      return sorted.sort((a, b) => by(a.last_message_at, b.last_message_at));
    case "created":
      return sorted.sort((a, b) => by(b.created_at, a.created_at));
    case "priority":
      return sorted.sort(
        (a, b) => rank(a.priority) - rank(b.priority) || by(b.last_message_at, a.last_message_at),
      );
    case "waiting": {
      const waiting = (row: T) => (row.status === "open" ? (row.last_inbound_at ?? "9") : "9");
      return sorted.sort(
        (a, b) => by(waiting(a), waiting(b)) || by(b.last_message_at, a.last_message_at),
      );
    }
  }
}

/** "50+" when the list was cut short, else the number. */
export const listTotal = (shown: number, more: boolean): string =>
  shown === 0 ? "" : `${shown}${more ? "+" : ""}`;
