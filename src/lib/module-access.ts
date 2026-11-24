import type { SupabaseClient } from "@supabase/supabase-js";
import {
  GRANT_COLUMNS,
  SUMMARY_COLUMNS,
  resolveEntitlements,
  type PlanGrant,
} from "./entitlements";
import type { ModuleKey } from "./modules";
import { getAdminClient, withTenant } from "./supabase/admin";

/**
 * Whether a workspace's plan lets a tool run right now, for code with no
 * signed-in member to ask on behalf of (public booking pages, the worker).
 * Same answer `getEntitlements().can("module.x")` gives a member, because it
 * goes through the same resolver (CLAUDE.md rule 7).
 */
export async function moduleOpen(
  tenantId: string,
  module: ModuleKey,
  admin: SupabaseClient = getAdminClient(),
): Promise<boolean> {
  return withTenant(
    tenantId,
    async (scope) => {
      const [{ data }, grant] = await Promise.all([
        scope.select("subscriptions", SUMMARY_COLUMNS).maybeSingle(),
        scope.select("plan_grants", GRANT_COLUMNS).maybeSingle(),
      ]);
      const entitlements = resolveEntitlements(
        data as never,
        grant.error ? null : (grant.data as PlanGrant | null),
      );
      return entitlements.canWrite && entitlements.can(`module.${module}`);
    },
    admin,
  );
}
