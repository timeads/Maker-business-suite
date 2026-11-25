/**
 * What happened to a conversation, in words. The wording follows the help
 * desk the team already knows. Pure: names and times are handed in.
 */

export type TicketEvent = {
  id: string;
  kind: string;
  detail: string;
  actor_id: string | null;
  created_at: string;
};

export type Names = {
  /** A teammate's name, or null for someone who has left. */
  person: (id: string | null) => string | null;
  /** A time as the workspace reads it. */
  when: (instant: string) => string;
};

const STATUS_WORDS: Record<string, string> = {
  open: "open",
  pending: "in progress",
  closed: "closed",
};

export function describeEvent(event: TicketEvent, names: Names): string {
  const who = event.actor_id ? (names.person(event.actor_id) ?? "Someone") : "System";
  const [d, source] = event.detail.split("|");
  switch (event.kind) {
    case "assigned": {
      if (!d) return `${who} unassigned the ticket`;
      const name = names.person(d) ?? "someone";
      if (d === event.actor_id) return `${who} took this ticket`;
      return event.actor_id ? `${who} assigned to ${name}` : `Auto-assigned to ${name}`;
    }
    case "status":
      if (source === "customer") return "Reopened — customer replied";
      return `${who} marked ${STATUS_WORDS[d] ?? d}`;
    case "snoozed":
      return `${who} snoozed until ${names.when(d)}`;
    case "unsnoozed":
      return d === "customer"
        ? "Snooze ended — customer replied"
        : `${who} brought this back from snooze`;
    case "priority":
      // With nobody signed in, it was one of the workspace's rules for new email.
      if (!event.actor_id) return `A rule set priority to ${d}`;
      return d === "normal" ? `${who} cleared the priority` : `${who} set priority to ${d}`;
    case "tags": {
      const name = event.detail.slice(1);
      if (event.detail.startsWith("-")) return `${who} removed the tag ${name}`;
      return event.actor_id ? `${who} added the tag ${name}` : `A rule added the tag ${name}`;
    }
    case "folder":
      return d ? `${who} moved this to the ${d} folder` : `${who} moved this back to the inbox`;
    case "subject":
      return `${who} renamed the ticket`;
    case "merged":
      return `${who} merged ${d}`;
    case "forwarded":
      return `${who} forwarded to ${d}`;
    case "shelf":
      if (d === "restored") {
        return source === "spam"
          ? `${who} marked this as not spam`
          : source === "trash"
            ? `${who} restored this from the Trash`
            : `${who} took this out of the archive`;
      }
      return d === "spam"
        ? `${who} marked this as spam`
        : d === "trash"
          ? `${who} moved this to the Trash`
          : `${who} archived this`;
    default:
      return `${event.kind} ${event.detail}`.trim();
  }
}

/** The events worth a line in the conversation itself. */
export const THREAD_EVENTS = new Set(["status", "assigned", "merged", "forwarded", "shelf"]);

export const ACTIVITY_GROUPS = [
  { key: "all", label: "Everything" },
  { key: "messages", label: "Messages" },
  { key: "status", label: "Status & assignment" },
  { key: "tags", label: "Tags, priority & subject" },
] as const;
export type ActivityGroup = (typeof ACTIVITY_GROUPS)[number]["key"];
export const isActivityGroup = (value: unknown): value is ActivityGroup =>
  ACTIVITY_GROUPS.some((group) => group.key === value);

const groupOf = (kind: string): Exclude<ActivityGroup, "all" | "messages"> =>
  kind === "priority" || kind === "subject" || kind === "tags" ? "tags" : "status";

export type ActivityEntry = {
  at: string;
  group: Exclude<ActivityGroup, "all">;
  icon: "mail" | "send" | "note" | "activity";
  text: string;
};

/** Everything that happened, newest first: mail in and out, notes, and the log. */
export function buildActivity(
  input: {
    createdAt: string;
    messages: {
      direction: string;
      kind?: string | null;
      from_name: string | null;
      from_email: string;
      author_id: string | null;
      created_at: string;
    }[];
    notes: { author_id: string | null; created_at: string }[];
    events: TicketEvent[];
  },
  names: Names,
): ActivityEntry[] {
  const first = input.messages[0];
  const entries: ActivityEntry[] = [
    {
      at: input.createdAt,
      group: "status",
      icon: "activity",
      text:
        first && first.direction === "outbound"
          ? `${names.person(first.author_id) ?? "Someone"} started this ticket by email`
          : "Ticket created from email",
    },
    ...input.messages.map((m): ActivityEntry => {
      const inbound = m.direction === "inbound";
      const by = names.person(m.author_id);
      return {
        at: m.created_at,
        group: "messages",
        icon: inbound ? "mail" : "send",
        text: inbound
          ? `Message received by email from ${m.from_name || m.from_email}`
          : `${m.kind === "forward" ? "Forward" : "Message"} sent by email${by ? ` by ${by}` : ""}`,
      };
    }),
    ...input.notes.map((n): ActivityEntry => ({
      at: n.created_at,
      group: "messages",
      icon: "note",
      text: `${names.person(n.author_id) ?? "Someone"} added an internal note`,
    })),
    ...input.events.map((e): ActivityEntry => ({
      at: e.created_at,
      group: groupOf(e.kind),
      icon: "activity",
      text: describeEvent(e, names),
    })),
  ];
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}
