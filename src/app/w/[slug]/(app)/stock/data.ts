import type { SupabaseClient } from "@supabase/supabase-js";
import { localDay } from "@/lib/bookings/slots";
import { canWriteShopifyStock } from "@/lib/connections/providers/shopify-stock";
import { STOCK_MODULE, STOCK_SETTINGS_KEY, parseStockSettings } from "@/lib/stock/config";
import {
  observedLeadTimeDays,
  type LeadTimeSample,
  type ObservedLeadTime,
} from "@/lib/stock/engine";
import { summarizeIncoming, type IncomingOrder } from "@/lib/stock/incoming";
import type { SpendLineInput } from "@/lib/stock/spend";
import {
  buildStockRows,
  itemName,
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

/** The workspace's own "today", YYYY-MM-DD. */
export const stockToday = (timezone: string) => localDay(new Date(), timezone);

type PlacedOrder = {
  id: string;
  number: number;
  status: string;
  ordered_at: string | null;
  expected_on: string | null;
  supplier_id: string;
  suppliers: { name: string } | null;
  purchase_order_lines: {
    qty_ordered: number;
    qty_received: number;
    stock_receipts: { created_at: string }[];
  }[];
  purchase_order_shipments: {
    id: string;
    carrier: string;
    tracking: string;
    expected_on: string | null;
    arrived_on: string | null;
    removed_at: string | null;
  }[];
};

/**
 * Orders that are on their way (oldest expected first, late ones flagged) and
 * how long each supplier has really taken, from sending an order to its first
 * delivery. Both are worked out here on read; nothing is stored.
 */
export async function loadIncoming(
  supabase: SupabaseClient,
  tenant: { id: string; timezone: string },
): Promise<{ incoming: IncomingOrder[]; leadTimes: Map<string, ObservedLeadTime> }> {
  const { data } = await supabase
    .from("purchase_orders")
    .select(
      "id, number, status, ordered_at, expected_on, supplier_id, suppliers(name), purchase_order_lines(qty_ordered, qty_received, stock_receipts(created_at)), purchase_order_shipments(id, carrier, tracking, expected_on, arrived_on, removed_at)",
    )
    .eq("tenant_id", tenant.id)
    .in("status", ["ordered", "partial", "closed"])
    .order("number", { ascending: false })
    .limit(400);
  const orders = (data ?? []) as unknown as PlacedOrder[];
  const today = stockToday(tenant.timezone);

  const incoming = summarizeIncoming(
    orders.map((order) => ({
      id: order.id,
      number: order.number,
      supplierName: order.suppliers?.name ?? "",
      status: order.status,
      orderedOn: order.ordered_at ? localDay(new Date(order.ordered_at), tenant.timezone) : null,
      expectedOn: order.expected_on,
      lines: order.purchase_order_lines.map((line) => ({
        qtyOrdered: line.qty_ordered,
        qtyReceived: line.qty_received,
      })),
      shipments: (order.purchase_order_shipments ?? [])
        .filter((s) => !s.removed_at)
        .map((s) => ({
          id: s.id,
          carrier: s.carrier,
          tracking: s.tracking,
          expectedOn: s.expected_on,
          arrivedOn: s.arrived_on,
        })),
    })),
    today,
  );

  const samples = new Map<string, LeadTimeSample[]>();
  for (const order of orders) {
    if (!order.ordered_at) continue;
    const arrivals = [
      ...order.purchase_order_lines.flatMap((line) =>
        line.stock_receipts.map((receipt) => new Date(receipt.created_at).getTime()),
      ),
      ...(order.purchase_order_shipments ?? [])
        .filter((s) => !s.removed_at && s.arrived_on)
        // A day with no time: count it as that day's noon in UTC.
        .map((s) => new Date(`${s.arrived_on}T12:00:00Z`).getTime()),
    ];
    if (arrivals.length === 0) continue;
    const list = samples.get(order.supplier_id) ?? [];
    list.push({ sentAt: new Date(order.ordered_at), arrivedAt: new Date(Math.min(...arrivals)) });
    samples.set(order.supplier_id, list);
  }
  const leadTimes = new Map<string, ObservedLeadTime>();
  for (const [supplierId, list] of samples) {
    const observed = observedLeadTimeDays(list);
    if (observed) leadTimes.set(supplierId, observed);
  }
  return { incoming, leadTimes };
}

/** Every line of every order that was placed, for the Spend page. Read as the member. */
export async function loadSpendLines(
  supabase: SupabaseClient,
  tenant: { id: string; timezone: string },
): Promise<SpendLineInput[]> {
  type Row = {
    po_id: string;
    qty_ordered: number;
    unit_cost: number | string;
    stock_items: { title: string; variant_title: string | null; sku: string | null };
    purchase_orders: {
      status: string;
      ordered_at: string | null;
      created_at: string;
      supplier_id: string;
      suppliers: { name: string } | null;
    };
  };
  const rows = await all<Row>((from, to) =>
    supabase
      .from("purchase_order_lines")
      .select(
        "po_id, qty_ordered, unit_cost, stock_items(title, variant_title, sku), purchase_orders!inner(status, ordered_at, created_at, supplier_id, suppliers(name))",
      )
      .eq("tenant_id", tenant.id)
      .in("purchase_orders.status", ["ordered", "partial", "closed"])
      .gt("qty_ordered", 0)
      .order("id")
      .range(from, to),
  );
  return rows.map((row) => ({
    poId: row.po_id,
    // The day the order went out on the workspace's own calendar, as a UTC
    // date, so months are the workspace's months.
    date: new Date(
      `${localDay(new Date(row.purchase_orders.ordered_at ?? row.purchase_orders.created_at), tenant.timezone)}T00:00:00Z`,
    ),
    supplierId: row.purchase_orders.supplier_id,
    supplierName: row.purchase_orders.suppliers?.name ?? "",
    sku: row.stock_items.sku,
    title: itemName(row.stock_items),
    qtyOrdered: row.qty_ordered,
    unitCost: Number(row.unit_cost).toFixed(2),
  }));
}
