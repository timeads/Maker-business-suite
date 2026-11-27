import { notFound } from "next/navigation";
import { getUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import type { ModuleKey } from "@/lib/modules";
import { getTenantContext } from "@/lib/tenants";

/**
 * For a tool's layout: a tool the plan includes but this person can't open
 * (tools per person, docs/roles.md) is simply not there, like the debts are
 * for members. A tool missing from the plan still shows its "not on your
 * plan" page, which the tool's own pages draw. Signed-out people and
 * strangers are left to the pages, which already send them away.
 */
export async function hideToolUnlessOpen(slug: string, tool: ModuleKey): Promise<void> {
  const user = await getUser();
  if (!user) return;
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (entitlements.onPlan(`module.${tool}`) && !entitlements.can(`module.${tool}`)) notFound();
}
