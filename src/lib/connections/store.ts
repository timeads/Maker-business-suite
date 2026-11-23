import type { SupabaseClient } from "@supabase/supabase-js";
import { applyShopOrders } from "../bookings/shop";
import type { SyncStore } from "./types";

/**
 * The real SyncStore: every write is a service-role function call that names
 * the workspace and provider explicitly (CLAUDE.md rule 2).
 */
export function rpcSyncStore(
  admin: SupabaseClient,
  scope: { tenantId: string; provider: string },
  notifyOwners: SyncStore["notifyOwners"],
): SyncStore {
  const call = async (fn: string, args: Record<string, unknown>) => {
    const { error } = await admin.rpc(fn, {
      p_tenant_id: scope.tenantId,
      p_provider: scope.provider,
      ...args,
    });
    if (error) throw new Error(`${fn} failed: ${error.message}`);
  };
  return {
    upsertCommerce: (batch) =>
      call("upsert_commerce_batch", {
        p_customers: batch.customers ?? [],
        p_products: batch.products ?? [],
        p_orders: batch.orders ?? [],
      }),
    upsertShipping: (orders) => call("upsert_shipping_orders", { p_orders: orders }),
    upsertStock: (items) => call("upsert_stock_items", { p_items: items }),
    setProductPhotos: (products) => call("set_product_photos", { p_products: products }),
    bookShopOrders: (orders) => applyShopOrders(admin, scope.tenantId, orders),
    saveSnapshots: (rows) => call("save_financial_snapshots", { p_snapshots: rows }),
    redactCustomer: (externalId, email) =>
      call("redact_customer", { p_customer_external_id: externalId, p_email: email }),
    purgeProviderData: () => call("purge_provider_data", {}),
    async recordUsage(calls) {
      const { error } = await admin.rpc("record_usage", {
        p_tenant_id: scope.tenantId,
        p_type: "sync_calls",
        p_quantity: calls,
      });
      if (error) throw new Error(`record_usage failed: ${error.message}`);
    },
    notifyOwners,
  };
}
