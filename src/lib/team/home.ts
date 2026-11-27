import type { Entitlements } from "@/lib/entitlements";
import type { ModuleKey } from "@/lib/modules";
import { MEMBER_TOOLS, type TeamRole } from "./tools";

/** The order Home lists its cards in before "needs someone" lifts some to the top. */
export const HOME_ORDER: readonly ModuleKey[] = [
  "helpdesk",
  "shipping",
  "bookings",
  "social",
  "stock",
  "messages",
  "dashboard",
];

/**
 * Which cards Home shows this person: one for each tool they can open, so a
 * member never sees a card (or a figure) of a tool that isn't theirs, and
 * Money's card only where Money is theirs. `noTools`: a member who has
 * nothing but Home and Messages yet, who is told an owner or admin gives
 * them their tools.
 */
export function homeCards(
  entitlements: Pick<Entitlements, "can" | "toolsPerPerson">,
  role: TeamRole,
): { tools: ModuleKey[]; noTools: boolean } {
  const tools = HOME_ORDER.filter((key) => entitlements.can(`module.${key}`));
  const noTools =
    entitlements.toolsPerPerson &&
    role === "member" &&
    !MEMBER_TOOLS.some((key) => entitlements.can(`module.${key}`));
  return { tools, noTools };
}
