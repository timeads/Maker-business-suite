import type { Priority } from "../config";
import { matchesConditions, type SavedView } from "../saved-views";
import type { Shelf } from "../views";
import type { ManualSources } from "./config";

/**
 * Which conversations the manual is written from. A workspace points it at
 * folders, saved views or tags (Settings → Help desk → Manual); nothing is
 * guessed from a conversation's words. A conversation counts once it is
 * closed and the team answered it: the manual is written from the team's
 * answers, so one nobody replied to has nothing to teach.
 */

export type SourceTicket = {
  id: string;
  status: "open" | "pending" | "closed";
  shelf: Shelf | null;
  merged_into: string | null;
  folder_id: string | null;
  assignee_id: string | null;
  priority: Priority;
  tags: string[];
  subject: string;
  /** The customer's name and address, as a saved view's "mentions" condition reads them. */
  customer: string;
  /** Whether the team has sent at least one reply. */
  replied: boolean;
};

/** Whether the workspace's settings name this conversation, whatever its status. */
export function namedBySources(
  ticket: SourceTicket,
  sources: ManualSources,
  savedViews: SavedView[],
): boolean {
  if (ticket.folder_id && sources.folders.includes(ticket.folder_id)) return true;
  if (sources.tags.some((tag) => ticket.tags.includes(tag))) return true;
  for (const id of sources.views) {
    const view = savedViews.find((one) => one.id === id);
    if (!view) continue;
    // A view is about who is looking and what is still open; a source is about
    // what the conversation was. So "status", "mine" and "unread" are left out.
    const { assignee, unread: _unread, ...rest } = view.conditions;
    void _unread;
    const conditions = {
      ...rest,
      status: "any" as const,
      ...(assignee && assignee !== "me" ? { assignee } : {}),
    };
    // A view with nothing left to ask would name every conversation there is.
    const asks =
      conditions.assignee ||
      conditions.tags_any?.length ||
      conditions.folder ||
      conditions.priority?.length ||
      conditions.text;
    if (!asks) continue;
    const facts = { ...ticket, snoozed_until: null, unread: false };
    if (matchesConditions(facts, conditions, "", 0)) return true;
  }
  return false;
}

/** Whether a conversation is ready to be read into the manual by itself. */
export function isSourceConversation(
  ticket: SourceTicket,
  sources: ManualSources,
  savedViews: SavedView[],
): boolean {
  if (ticket.status !== "closed" || ticket.merged_into) return false;
  if (ticket.shelf === "spam" || ticket.shelf === "trash") return false;
  if (!ticket.replied) return false;
  return namedBySources(ticket, sources, savedViews);
}

/**
 * How many more conversations may be read now: what is left of the month's
 * cap, and never more than one run's worth.
 */
export function readsAllowed(cap: number, readThisMonth: number, perRun: number): number {
  return Math.max(0, Math.min(perRun, cap - readThisMonth));
}
