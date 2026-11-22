import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEntitlements } from "./entitlements";
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
      const { data } = await scope
        .select(
          "subscriptions",
          "tenant_id, plan, status, trial_end, current_period_end, cancel_at_period_end, ended_at, purge_after, selected_modules",
        )
        .maybeSingle();
      const entitlements = resolveEntitlements(data as never);
      return entitlements.canWrite && entitlements.can(`module.${module}`);
    },
    admin,
  );
}
