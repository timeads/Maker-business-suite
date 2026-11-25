import type { SupabaseClient } from "@supabase/supabase-js";
import { applyShopOrders } from "../bookings/shop";
import { noteShopOrderLines } from "../bookings/undated";
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
    setVariantPhotos: (items) => call("set_variant_photos", { p_items: items }),
    setStockTags: (items) => call("set_stock_item_tags", { p_items: items }),
    bookShopOrders: (orders) => applyShopOrders(admin, scope.tenantId, orders),
    noteShopOrderLines: (orders) =>
      noteShopOrderLines(admin, scope.tenantId, scope.provider, orders),
    saveSnapshots: (rows) => call("save_financial_snapshots", { p_snapshots: rows }),
    importBookPayments: (rows) => call("import_book_payments", { p_rows: rows }),
    async bookPaymentsWanted() {
      const { data, error } = await admin.rpc("book_payments_wanted", {
        p_tenant_id: scope.tenantId,
        p_provider: scope.provider,
      });
      if (error) throw new Error(`book_payments_wanted failed: ${error.message}`);
      return data === true;
    },
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
