import { z } from "zod";
import { PRIORITIES, TAG_PATTERN, type Priority } from "./config";
import { isSnoozed, type TicketFacts } from "./views";

/**
 * Saved views: a name and the conditions a conversation must meet. They are
 * data (module "helpdesk", key "saved_views"), shared by the workspace and
 * parsed with this schema on every read. Every condition given must hold.
 */
export const SAVED_VIEWS_KEY = "saved_views";

/** "social" is Instagram and Facebook together. */
export const CHANNELS = ["email", "instagram", "facebook", "social"] as const;
export const CHANNEL_CHOICES: Record<(typeof CHANNELS)[number], string> = {
  email: "Email",
  instagram: "Instagram",
  facebook: "Facebook",
  social: "Instagram & Facebook",
};

/** Whether a conversation's channel meets a channel condition or filter. */
export function channelMatches(channel: string | null | undefined, want: string): boolean {
  const is = channel ?? "email";
  return want === "social" ? is === "instagram" || is === "facebook" : is === want;
}

export const viewConditionsSchema = z.object({
  /** active: open or in progress, not snoozed, not filed. any: everything not joined away. */
  status: z.enum(["active", "open", "pending", "snoozed", "closed", "any"]).default("active"),
  /** "me", "none", or a teammate's user id. */
  assignee: z.union([z.literal("me"), z.literal("none"), z.string().uuid()]).optional(),
  /** Has at least one of these tags. */
  tags_any: z.array(z.string().trim().toLowerCase().regex(TAG_PATTERN)).max(10).optional(),
  /** A folder's id, or "none" for conversations not filed anywhere. */
  folder: z.union([z.literal("none"), z.string().uuid()]).optional(),
  priority: z.array(z.enum(PRIORITIES)).max(4).optional(),
  channel: z.enum(CHANNELS).optional(),
  /** Words in the subject or the customer's name or address, any letter case. */
  text: z.string().trim().min(2).max(80).optional(),
  unread: z.boolean().optional(),
});
export type ViewConditions = z.infer<typeof viewConditionsSchema>;

export const savedViewsSchema = z.object({
  version: z.literal(1),
  views: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]{1,40}$/),
        name: z.string().trim().min(1).max(40),
        conditions: viewConditionsSchema,
      }),
    )
    .max(30),
});
export type SavedViews = z.infer<typeof savedViewsSchema>;
export type SavedView = SavedViews["views"][number];

export const DEFAULT_SAVED_VIEWS: SavedViews = { version: 1, views: [] };

export function parseSavedViews(body: unknown): SavedViews {
  const parsed = savedViewsSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_SAVED_VIEWS;
}

export type ViewFacts = TicketFacts & {
  priority: Priority;
  tags: string[];
  subject: string;
  customer: string;
  unread: boolean;
};

/** Whether a conversation meets every condition of a saved view. */
export function matchesConditions(
  ticket: ViewFacts,
  conditions: ViewConditions,
  me: string,
  now: number,
): boolean {
  if (ticket.merged_into) return false;
  // Spam and Trash are in no view; archived only where a view asks for any status.
  if (ticket.shelf === "spam" || ticket.shelf === "trash") return false;
  if (ticket.shelf && conditions.status !== "any") return false;
  const snoozed = isSnoozed(ticket, now);
  switch (conditions.status) {
    case "active":
      if (ticket.status === "closed" || snoozed) return false;
      if (!conditions.folder && ticket.folder_id) return false;
      break;
    case "open":
    case "pending":
      if (ticket.status !== conditions.status || snoozed) return false;
      break;
    case "snoozed":
      if (ticket.status === "closed" || !snoozed) return false;
      break;
    case "closed":
      if (ticket.status !== "closed") return false;
      break;
    case "any":
      break;
  }
  if (conditions.assignee) {
    const want =
      conditions.assignee === "me"
        ? me
        : conditions.assignee === "none"
          ? null
          : conditions.assignee;
    if (ticket.assignee_id !== want) return false;
  }
  if (
    conditions.tags_any?.length &&
    !conditions.tags_any.some((tag) => ticket.tags.includes(tag))
  ) {
    return false;
  }
  if (conditions.folder) {
    const want = conditions.folder === "none" ? null : conditions.folder;
    if ((ticket.folder_id ?? null) !== want) return false;
  }
  if (conditions.priority?.length && !conditions.priority.includes(ticket.priority)) return false;
  if (conditions.channel && !channelMatches(ticket.channel, conditions.channel)) return false;
  if (conditions.text) {
    const hay = `${ticket.subject} ${ticket.customer}`.toLowerCase();
    if (!hay.includes(conditions.text.toLowerCase())) return false;
  }
  if (conditions.unread && !ticket.unread) return false;
  return true;
}

/** The conditions in a few words, for the settings list. */
export function describeConditions(
  conditions: ViewConditions,
  names: { person: (id: string) => string; folder: (id: string) => string },
): string {
  const parts: string[] = [];
  const status = {
    active: "open or in progress",
    open: "open",
    pending: "in progress",
    snoozed: "snoozed",
    closed: "closed",
    any: "any status",
  }[conditions.status];
  parts.push(status);
  if (conditions.assignee) {
    parts.push(
      conditions.assignee === "me"
        ? "assigned to whoever is looking"
        : conditions.assignee === "none"
          ? "unassigned"
          : `assigned to ${names.person(conditions.assignee)}`,
    );
  }
  if (conditions.tags_any?.length) parts.push(`tagged ${conditions.tags_any.join(" or ")}`);
  if (conditions.folder) {
    parts.push(
      conditions.folder === "none" ? "not in a folder" : `in ${names.folder(conditions.folder)}`,
    );
  }
  if (conditions.priority?.length) parts.push(`${conditions.priority.join(" or ")} priority`);
  if (conditions.channel) parts.push(`from ${CHANNEL_CHOICES[conditions.channel]}`);
  if (conditions.text) parts.push(`mentions “${conditions.text}”`);
  if (conditions.unread) parts.push("unread");
  return parts.join(" · ");
}
