import type { ModuleKey } from "@/lib/modules";

/**
 * Tools per person (docs/roles.md). Owners and admins have every tool the
 * plan includes. Once a workspace switches "choose which tools each person
 * can open" on, a member has only the tools ticked for them, and never Money.
 * Home and Messages are everyone's. While the switch is off, members have
 * every tool, as before.
 *
 * `toolAllowed` is the whole rule. Its database twin is
 * `private.tool_allowed`; tests/db/member-tools.test.ts holds the two equal.
 */

export type TeamRole = "owner" | "admin" | "member";

/** The tools an owner or admin can tick for a member, in the order they're shown. */
export const MEMBER_TOOLS = ["helpdesk", "bookings", "social", "stock", "shipping"] as const;
export type MemberTool = (typeof MEMBER_TOOLS)[number];

/** Never tickable: a person who needs the money side is made an admin. */
export const OWNERS_ONLY_TOOL = "dashboard" satisfies ModuleKey;

/** What decides one person's tools in one workspace. */
export type PersonTools = {
  role: TeamRole;
  /** The workspace's switch: "choose which tools each person can open". */
  on: boolean;
  /** Their chosen list; null when nobody has chosen one yet. */
  tools: readonly string[] | null;
};

export function isMemberTool(value: unknown): value is MemberTool {
  return typeof value === "string" && (MEMBER_TOOLS as readonly string[]).includes(value);
}

export function toolAllowed(person: PersonTools | null, tool: ModuleKey): boolean {
  if (!person) return false;
  if (tool === "messages") return true;
  if (person.role === "owner" || person.role === "admin") return true;
  if (!person.on) return true;
  if (tool === OWNERS_ONLY_TOOL) return false;
  return (person.tools ?? []).includes(tool);
}

/** What the business pays and earns in margin: owners and admins, and members while the switch is off. */
export function seesCosts(person: PersonTools | null): boolean {
  if (!person) return false;
  return person.role === "owner" || person.role === "admin" || !person.on;
}

/** A ticked list, cleaned: known tools once each, in the usual order. Money is never kept. */
export function cleanTools(values: readonly unknown[]): MemberTool[] {
  return MEMBER_TOOLS.filter((tool) => values.includes(tool));
}

/** A member who can open no tool but Home and Messages, while the switch is on. */
export function hasNoTools(person: PersonTools | null): boolean {
  return Boolean(
    person &&
    person.role === "member" &&
    person.on &&
    !MEMBER_TOOLS.some((tool) => toolAllowed(person, tool)),
  );
}
