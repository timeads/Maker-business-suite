import type { SupabaseClient } from "@supabase/supabase-js";
import { applyShopOrders } from "../bookings/shop";
import { noteShopOrderLines } from "../bookings/undated";
import {
  EXPENSES_KEY,
  decisionPayload,
  factsOfRow,
  parseExpenseSorting,
  type ExpenseSorting,
} from "../dashboard/expenses";
import { REVENUE_KEY, REVENUE_MODULE, parseRevenueSettings } from "../dashboard/lines";
import { moduleOpen } from "../module-access";
import { withTenant } from "../supabase/admin";
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
  // The workspace's lines and expense rules, read once per sync.
  let sorting: Promise<{ settings: ExpenseSorting; lineIds: Set<string> }> | null = null;
  const loadSorting = () =>
    (sorting ??= withTenant(
      scope.tenantId,
      async (tenant) => {
        const { data, error } = await tenant
          .select("configs", "key, body")
          .eq("module", REVENUE_MODULE)
          .in("key", [REVENUE_KEY, EXPENSES_KEY]);
        if (error) throw new Error(`Could not read the expense rules: ${error.message}`);
        const rows = (data ?? []) as unknown as { key: string; body: unknown }[];
        const body = (key: string) => rows.find((row) => row.key === key)?.body;
        const revenue = parseRevenueSettings(body(REVENUE_KEY));
        return {
          settings: parseExpenseSorting(body(EXPENSES_KEY)),
          lineIds: new Set(revenue.lines.map((line) => line.id)),
        };
      },
      admin,
    ));

  return {
    upsertCommerce: (batch) =>
      call("upsert_commerce_batch", {
        p_customers: batch.customers ?? [],
        p_products: batch.products ?? [],
        p_orders: batch.orders ?? [],
      }),
    noteDetailsRead: () => call("note_commerce_details_read", {}),
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
    bookExpensesWanted: () => moduleOpen(scope.tenantId, "dashboard", admin),
    async fileBookExpenses(run, rows) {
      const { settings, lineIds } = await loadSorting();
      const withRules = rows.map((row) => ({
        ...row,
        ...(row.kind === "transfer" || row.kind === "card_payment"
          ? {}
          : decisionPayload(settings, lineIds, factsOfRow(row))),
      }));
      for (let start = 0; start < withRules.length; start += 500) {
        await call("file_book_expenses", {
          p_run: run,
          p_rows: withRules.slice(start, start + 500),
        });
      }
    },
    closeBookExpenses: (run, since, entities) =>
      call("close_book_expenses", { p_run: run, p_since: since, p_entities: entities }),
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
