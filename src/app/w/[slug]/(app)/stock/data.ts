import type { SupabaseClient } from "@supabase/supabase-js";
import { localDay } from "@/lib/bookings/slots";
import { canWriteShopifyStock } from "@/lib/connections/providers/shopify-stock";
import { STOCK_MODULE, STOCK_SETTINGS_KEY, parseStockSettings } from "@/lib/stock/config";
import {
  buildStockRows,
  type ItemRow,
  type OpenLine,
  type SaleRow,
  type SupplierRow,
} from "@/lib/stock/plan";

const PAGE = 1000;

/** Reads every row of a query, a page at a time (the API hands back 1,000 at most). */
async function all<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
  limit = 60_000,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; from < limit; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) break;
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

export type ShopLink = {
  connected: boolean;
  /** The shop has given permission to have deliveries added to its count. */
  canPush: boolean;
  lastSyncedAt: string | null;
};

/** Everything the Stock screens work from, read as the signed-in member. */
export async function loadStock(
  supabase: SupabaseClient,
  tenant: { id: string; timezone: string },
) {
  const [items, suppliers, sales, lines, { data: config }, { data: shop }] = await Promise.all([
    all<ItemRow & { synced_at: string }>((from, to) =>
      supabase
        .from("stock_items")
        .select(
          "id, title, variant_title, sku, on_hand, unit_cost, tracked, product_status, supplier_id, lead_time_days, coverage_days, safety_stock, hidden, vendor, price, case_pack, moq, supplier_sku, synced_at",
        )
        .eq("tenant_id", tenant.id)
        .order("title")
        .order("id")
        .range(from, to),
    ),
    all<SupplierRow & { email: string | null; notes: string }>((from, to) =>
      supabase
        .from("suppliers")
        .select(
          "id, name, email, lead_time_days, coverage_days, moq, moq_applies_to, notes, archived_at",
        )
        .eq("tenant_id", tenant.id)
        .order("name")
        .range(from, to),
    ),
    all<SaleRow>((from, to) =>
      supabase
        .rpc("stock_sales_by_day", { p_tenant_id: tenant.id, p_days: 730 })
        .order("day")
        .order("stock_item_id")
        .range(from, to),
    ),
    all<{
      stock_item_id: string;
      qty_ordered: number;
      qty_received: number;
      purchase_orders: { status: string } | { status: string }[];
    }>((from, to) =>
      supabase
        .from("purchase_order_lines")
        .select("stock_item_id, qty_ordered, qty_received, purchase_orders!inner(status)")
        .eq("tenant_id", tenant.id)
        .in("purchase_orders.status", ["ordered", "partial"])
        .order("id")
        .range(from, to),
    ),
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenant.id)
      .eq("module", STOCK_MODULE)
      .eq("key", STOCK_SETTINGS_KEY)
      .maybeSingle(),
    supabase
      .from("connections")
      .select("status, scopes, last_synced_at")
      .eq("tenant_id", tenant.id)
      .eq("provider", "shopify")
      .maybeSingle(),
  ]);
  const settings = parseStockSettings(config?.body);
  const today = localDay(new Date(), tenant.timezone);
  const openLines: OpenLine[] = lines.map((line) => ({
    stock_item_id: line.stock_item_id,
    qty_ordered: line.qty_ordered,
    qty_received: line.qty_received,
    status: (Array.isArray(line.purchase_orders) ? line.purchase_orders[0] : line.purchase_orders)
      .status,
  }));
  const link: ShopLink = {
    connected: shop?.status === "active",
    canPush: shop?.status === "active" && canWriteShopifyStock(shop.scopes),
    lastSyncedAt: (shop?.last_synced_at as string | null) ?? null,
  };
  return {
    rows: buildStockRows({ items, suppliers, sales, openLines, settings, today }),
    suppliers,
    settings,
    today,
    link,
  };
}
