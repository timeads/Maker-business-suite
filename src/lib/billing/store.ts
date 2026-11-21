import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminClient, withTenant } from "../supabase/admin";
import { getStripe } from "./stripe";
import type { SyncableRow, SyncDeps } from "./sync";
import type { SubscriptionRow } from "./types";

/** Server-side read of a workspace's full subscription row, Stripe ids included. */
export async function getSubscriptionRow(
  tenantId: string,
  admin: SupabaseClient = getAdminClient(),
): Promise<SubscriptionRow | null> {
  return withTenant(
    tenantId,
    async (scope) => {
      const { data, error } = await scope.select("subscriptions", "*").maybeSingle();
      if (error) throw new Error(`Could not read subscription: ${error.message}`);
      return data as SubscriptionRow | null;
    },
    admin,
  );
}

/** The real Stripe + database wiring for `processStripeEvent`. */
export function liveSyncDeps(admin: SupabaseClient = getAdminClient()): SyncDeps {
  return {
    retrieveSubscription: (id) => getStripe().subscriptions.retrieve(id),
    async currentSubscriptionId(tenantId) {
      const row = await getSubscriptionRow(tenantId, admin);
      if (!row) return null;
      return {
        id: row.stripe_subscription_id,
        ended: row.status === "canceled" || row.status === "incomplete_expired",
      };
    },
    async upsertSubscription(row: SyncableRow) {
      await withTenant(
        row.tenant_id,
        async (scope) => {
          const { error } = await scope.upsert("subscriptions", row, { onConflict: "tenant_id" });
          if (error) {
            throw new Error(
              `Could not save subscription: ${(error as { message: string }).message}`,
            );
          }
        },
        admin,
      );
    },
  };
}
