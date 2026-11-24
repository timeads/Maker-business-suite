import type { SupabaseClient } from "@supabase/supabase-js";
import { localDay } from "@/lib/bookings/slots";
import { canWriteShopifyStock } from "@/lib/connections/providers/shopify-stock";
import {
  STOCK_MODULE,
  STOCK_SEASONS_KEY,
  STOCK_SETTINGS_KEY,
  STOCK_VIEWS_KEY,
  parseSavedViews,
  parseSeasons,
  parseStockSettings,
} from "@/lib/stock/config";
import {
  observedLeadTimeDays,
  type LeadTimeSample,
  type ObservedLeadTime,
} from "@/lib/stock/engine";
import { summarizeIncoming, type IncomingOrder } from "@/lib/stock/incoming";
import { trackingUrl } from "@/lib/shipping/carriers";
import {
  CARRIER_WORDS,
  canAskCarrier,
  isCarrierStatus,
  parcelDates,
  parcelWords,
} from "@/lib/stock/tracking";
import { toOrderRow, type OrderListRow } from "@/lib/stock/po/list";
import type { SpendLineInput } from "@/lib/stock/spend";
import {
  buildStockRows,
  emptyDaysSince,
  itemName,
  type EmptyDayRow,
  type ReceivedCostRow,
  type ItemRow,
  type ClosureRow,
  type OpenLine,
  type RevenueRow,
  type SaleRow,
  type SupplierRow,
} from "@/lib/stock/plan";

const PAGE = 1000;

type OrderOfLine = { status: string; number: number; created_at: string };

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
  const today = localDay(new Date(), tenant.timezone);
  const [
    items,
    suppliers,
    sales,
    lines,
    emptyDays,
    received,
    revenue,
    closures,
    { data: configs },
    { data: shop },
  ] = await Promise.all([
    all<ItemRow & { synced_at: string }>((from, to) =>
      supabase
        .from("stock_items")
        .select(
          "id, title, variant_title, sku, on_hand, unit_cost, tracked, product_status, supplier_id, lead_time_days, coverage_days, safety_stock, hidden, dont_reorder, tags, vendor, price, case_pack, moq, supplier_sku, own_cost, image_url, variant_image_url, synced_at",
        )
        .eq("tenant_id", tenant.id)
        .order("title")
        .order("id")
        .range(from, to),
    ),
    all<
      SupplierRow & {
        email: string | null;
        notes: string;
        contact_name: string | null;
        more_emails: string[] | null;
      }
    >((from, to) =>
      supabase
        .from("suppliers")
        .select(
          "id, name, email, contact_name, more_emails, lead_time_days, coverage_days, moq, moq_applies_to, notes, archived_at",
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
      purchase_orders: OrderOfLine | OrderOfLine[];
    }>((from, to) =>
      supabase
        .from("purchase_order_lines")
        .select(
          "stock_item_id, qty_ordered, qty_received, purchase_orders!inner(status, number, created_at)",
        )
        .eq("tenant_id", tenant.id)
        .in("purchase_orders.status", ["ordered", "partial"])
        .order("id")
        .range(from, to),
    ),
    // Only the days an item had none: the sales rate leaves those out. Days it
    // was in stock aren't read.
    all<EmptyDayRow>((from, to) =>
      supabase
        .from("stock_daily_counts")
        .select("stock_item_id, day")
        .eq("tenant_id", tenant.id)
        .lte("on_hand", 0)
        .gte("day", emptyDaysSince(today))
        .order("day")
        .order("stock_item_id")
        .range(from, to),
    ),
    // What checked-in deliveries cost, summed per item, for the average cost.
    all<ReceivedCostRow>((from, to) =>
      supabase
        .rpc("stock_received_costs", { p_tenant_id: tenant.id })
        .order("stock_item_id")
        .range(from, to),
    ),
    // What each item brought in over 90 days, for "% Rev" and the best sellers.
    all<RevenueRow>((from, to) =>
      supabase
        .rpc("stock_revenue_by_item", { p_tenant_id: tenant.id, p_days: 90 })
        .order("stock_item_id")
        .range(from, to),
    ),
    // When suppliers are shut: today's closures and those still to come.
    all<ClosureRow>((from, to) =>
      supabase
        .from("supplier_closures")
        .select("id, supplier_id, name, starts_on, ends_on")
        .eq("tenant_id", tenant.id)
        .gte("ends_on", today)
        .order("starts_on")
        .order("id")
        .range(from, to),
    ),
    supabase
      .from("configs")
      .select("key, body")
      .eq("tenant_id", tenant.id)
      .eq("module", STOCK_MODULE)
      .in("key", [STOCK_SETTINGS_KEY, STOCK_VIEWS_KEY, STOCK_SEASONS_KEY]),
    supabase
      .from("connections")
      .select("status, scopes, last_synced_at")
      .eq("tenant_id", tenant.id)
      .eq("provider", "shopify")
      .maybeSingle(),
  ]);
  const config = (key: string) =>
    ((configs ?? []) as { key: string; body: unknown }[]).find((row) => row.key === key)?.body;
  const settings = parseStockSettings(config(STOCK_SETTINGS_KEY));
  const seasons = parseSeasons(config(STOCK_SEASONS_KEY)).seasons;
  const openLines: OpenLine[] = lines.map((line) => {
    const order = Array.isArray(line.purchase_orders)
      ? line.purchase_orders[0]
      : line.purchase_orders;
    return {
      stock_item_id: line.stock_item_id,
      qty_ordered: line.qty_ordered,
      qty_received: line.qty_received,
      status: order.status,
      order_number: order.number,
      order_created_at: order.created_at,
    };
  });
  const link: ShopLink = {
    connected: shop?.status === "active",
    canPush: shop?.status === "active" && canWriteShopifyStock(shop.scopes),
    lastSyncedAt: (shop?.last_synced_at as string | null) ?? null,
  };
  return {
    rows: buildStockRows({
      items,
      suppliers,
      sales,
      openLines,
      emptyDays,
      received,
      revenue,
      closures,
      seasons: seasons.map((season) => ({
        id: season.id,
        name: season.name,
        inStockBy: season.in_stock_by,
        liftPct: season.lift_pct,
        note: season.note,
      })),
      settings,
      today,
    }),
    seasons,
    closures,
    suppliers,
    settings,
    savedViews: parseSavedViews(config(STOCK_VIEWS_KEY)).views,
    today,
    link,
  };
}

/**
 * For each sent order that has tracking numbers, its parcels in a few words
 * ("UPS …6784: out for delivery, due Nov 26"), keyed by the order's number.
 * For the "on the way" chip in the reorder list.
 */
export async function loadOrderTracking(
  supabase: SupabaseClient,
  tenant: { id: string; timezone: string },
): Promise<Map<number, string[]>> {
  const { data } = await supabase
    .from("purchase_order_shipments")
    .select(
      "carrier, tracking, expected_on, arrived_on, carrier_status, carrier_detail, carrier_expected_on, carrier_delivered_on, carrier_scan_place, carrier_scan_at, carrier_checked_at, carrier_error, purchase_orders!inner(number, status)",
    )
    .eq("tenant_id", tenant.id)
    .is("removed_at", null)
    .in("purchase_orders.status", ["ordered", "partial"])
    .order("created_at")
    .limit(1000);
  const today = localDay(new Date(), tenant.timezone);
  const words = new Map<number, string[]>();
  for (const row of data ?? []) {
    const order = (
      Array.isArray(row.purchase_orders) ? row.purchase_orders[0] : row.purchase_orders
    ) as { number: number } | undefined;
    if (!order) continue;
    const said = parcelWords(
      {
        carrier: row.carrier as string,
        tracking: row.tracking as string,
        expectedOn: row.expected_on as string | null,
        arrivedOn: row.arrived_on as string | null,
        carrierStatus: isCarrierStatus(row.carrier_status) ? row.carrier_status : null,
        carrierDetail: row.carrier_detail as string | null,
        carrierExpectedOn: row.carrier_expected_on as string | null,
        carrierDeliveredOn: row.carrier_delivered_on as string | null,
        carrierScanPlace: row.carrier_scan_place as string | null,
        carrierScanAt: row.carrier_scan_at as string | null,
        carrierCheckedAt: row.carrier_checked_at as string | null,
        carrierError: row.carrier_error as string | null,
      },
      today,
    );
    words.set(order.number, [...(words.get(order.number) ?? []), said]);
  }
  return words;
}

/** One parcel still on its way, for its card on the "To order" tab. */
export type IncomingParcel = {
  id: string;
  orderId: string;
  orderNumber: number;
  orderReference: string;
  supplierName: string;
  carrier: string;
  tracking: string;
  url: string | null;
  note: string;
  /** The day to go by: the carrier's own estimate, else the one typed in. */
  expectedOn: string | null;
  late: boolean;
  status: { label: string; tone: "open" | "waiting" | "good" | "bad" | "closed" };
  /** A UPS number in a workspace that can ask UPS. */
  canCheck: boolean;
  items: { name: string; quantity: number }[];
};

/**
 * Every tracking number still travelling on an order that is still open,
 * soonest due first (TuftStock's `loadIncomingShipments`). A parcel a person
 * marked as here, or that UPS says was delivered, has left the list: what is
 * left to do with it is checking it in, on the order's own page.
 */
export async function loadIncomingParcels(
  supabase: SupabaseClient,
  tenant: { id: string; timezone: string },
): Promise<{ parcels: IncomingParcel[]; canAskUps: boolean }> {
  const [{ data }, { data: ups }] = await Promise.all([
    supabase
      .from("purchase_order_shipments")
      .select(
        "id, po_id, carrier, tracking, expected_on, arrived_on, note, created_at, carrier_status, carrier_expected_on, carrier_delivered_on, purchase_orders!inner(number, reference, status, suppliers(name)), purchase_order_shipment_items(quantity, purchase_order_lines(stock_items(title, variant_title)))",
      )
      .eq("tenant_id", tenant.id)
      .is("removed_at", null)
      .is("arrived_on", null)
      .in("purchase_orders.status", ["ordered", "partial"])
      .order("created_at")
      .limit(300),
    supabase
      .from("connections")
      .select("status, metadata")
      .eq("tenant_id", tenant.id)
      .eq("provider", "ups")
      .maybeSingle(),
  ]);
  const canAskUps =
    ups?.status === "active" &&
    ((ups.metadata as { mode?: string } | null)?.mode ?? "production") !== "test";
  const today = localDay(new Date(), tenant.timezone);
  type Row = {
    id: string;
    po_id: string;
    carrier: string;
    tracking: string;
    expected_on: string | null;
    arrived_on: string | null;
    note: string;
    carrier_status: string | null;
    carrier_expected_on: string | null;
    carrier_delivered_on: string | null;
    purchase_orders: {
      number: number;
      reference: string;
      suppliers: { name: string } | null;
    };
    purchase_order_shipment_items: {
      quantity: number;
      purchase_order_lines: {
        stock_items: { title: string; variant_title: string | null } | null;
      } | null;
    }[];
  };
  const parcels: IncomingParcel[] = [];
  for (const row of (data ?? []) as unknown as Row[]) {
    const carrierStatus = isCarrierStatus(row.carrier_status) ? row.carrier_status : null;
    const dates = parcelDates({
      expectedOn: row.expected_on,
      arrivedOn: row.arrived_on,
      carrierStatus,
      carrierExpectedOn: row.carrier_expected_on,
      carrierDeliveredOn: row.carrier_delivered_on,
    });
    if (dates.arrivedOn) continue;
    const late = dates.expectedOn !== null && dates.expectedOn < today;
    parcels.push({
      id: row.id,
      orderId: row.po_id,
      orderNumber: row.purchase_orders.number,
      orderReference: row.purchase_orders.reference,
      supplierName: row.purchase_orders.suppliers?.name ?? "",
      carrier: row.carrier,
      tracking: row.tracking,
      url: trackingUrl(row.carrier, row.tracking),
      note: row.note ?? "",
      expectedOn: dates.expectedOn,
      late,
      status:
        carrierStatus && carrierStatus !== "not_found"
          ? CARRIER_WORDS[carrierStatus]
          : late
            ? { label: "Late", tone: "bad" }
            : { label: "On its way", tone: "open" },
      canCheck: canAskUps && canAskCarrier({ tracking: row.tracking, arrivedOn: null }),
      items: (row.purchase_order_shipment_items ?? []).flatMap((item) => {
        const stock = item.purchase_order_lines?.stock_items;
        return stock ? [{ name: itemName(stock), quantity: item.quantity }] : [];
      }),
    });
  }
  parcels.sort(
    (a, b) =>
      (a.expectedOn ?? "9999-12-31").localeCompare(b.expectedOn ?? "9999-12-31") ||
      a.orderNumber - b.orderNumber,
  );
  return { parcels, canAskUps };
}

/** The workspace's own "today", YYYY-MM-DD. */
export const stockToday = (timezone: string) => localDay(new Date(), timezone);

type PlacedOrder = {
  id: string;
  number: number;
  reference: string;
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
    carrier_status: string | null;
    carrier_expected_on: string | null;
    carrier_delivered_on: string | null;
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
      "id, number, reference, status, ordered_at, expected_on, supplier_id, suppliers(name), purchase_order_lines(qty_ordered, qty_received, stock_receipts(created_at)), purchase_order_shipments(id, carrier, tracking, expected_on, arrived_on, removed_at, carrier_status, carrier_expected_on, carrier_delivered_on)",
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
      reference: order.reference,
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
        .map((s) => {
          const carrierStatus = isCarrierStatus(s.carrier_status) ? s.carrier_status : null;
          return {
            id: s.id,
            carrier: s.carrier,
            tracking: s.tracking,
            // A person's own word first, then what UPS said.
            ...parcelDates({
              expectedOn: s.expected_on,
              arrivedOn: s.arrived_on,
              carrierStatus,
              carrierExpectedOn: s.carrier_expected_on,
              carrierDeliveredOn: s.carrier_delivered_on,
            }),
            carrierStatus,
          };
        }),
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

/**
 * Every order with what the Orders tab shows of it, newest first: its lines'
 * totals, and its tracking numbers with the dates to go by. Read as the
 * member; the list, its search and its spreadsheet all start from this.
 */
export async function loadOrderList(
  supabase: SupabaseClient,
  tenant: { id: string; timezone: string },
): Promise<OrderListRow[]> {
  type Row = {
    id: string;
    number: number;
    reference: string;
    status: string;
    supplier_id: string;
    expected_on: string | null;
    created_at: string;
    ordered_at: string | null;
    archived_at: string | null;
    shipping_cost: number | string;
    tax_rate_pct: number | string;
    adjustments: unknown;
    suppliers: { name: string } | null;
    purchase_order_lines: { qty_ordered: number; qty_received: number; unit_cost: number }[];
    purchase_order_shipments: {
      expected_on: string | null;
      arrived_on: string | null;
      removed_at: string | null;
      carrier_status: string | null;
      carrier_expected_on: string | null;
      carrier_delivered_on: string | null;
    }[];
  };
  const rows = await all<Row>(
    (from, to) =>
      supabase
        .from("purchase_orders")
        .select(
          "id, number, reference, status, supplier_id, expected_on, created_at, ordered_at, archived_at, shipping_cost, tax_rate_pct, adjustments, suppliers(name), purchase_order_lines(qty_ordered, qty_received, unit_cost), purchase_order_shipments(expected_on, arrived_on, removed_at, carrier_status, carrier_expected_on, carrier_delivered_on)",
        )
        .eq("tenant_id", tenant.id)
        .order("number", { ascending: false })
        .range(from, to),
    5000,
  );
  const today = localDay(new Date(), tenant.timezone);
  return rows.map((order) =>
    toOrderRow(
      {
        id: order.id,
        number: order.number,
        reference: order.reference,
        status: order.status,
        supplierId: order.supplier_id,
        supplierName: order.suppliers?.name ?? "",
        expectedOn: order.expected_on,
        createdOn: localDay(new Date(order.created_at), tenant.timezone),
        sentOn: order.ordered_at ? localDay(new Date(order.ordered_at), tenant.timezone) : null,
        archived: order.archived_at !== null,
        shippingCost: order.shipping_cost,
        taxRatePct: order.tax_rate_pct,
        adjustments: order.adjustments,
        lines: order.purchase_order_lines.map((line) => ({
          qtyOrdered: line.qty_ordered,
          qtyReceived: line.qty_received,
          unitCost: line.unit_cost,
        })),
        parcels: (order.purchase_order_shipments ?? [])
          .filter((parcel) => !parcel.removed_at)
          .map((parcel) => {
            const carrierStatus = isCarrierStatus(parcel.carrier_status)
              ? parcel.carrier_status
              : null;
            return {
              ...parcelDates({
                expectedOn: parcel.expected_on,
                arrivedOn: parcel.arrived_on,
                carrierStatus,
                carrierExpectedOn: parcel.carrier_expected_on,
                carrierDeliveredOn: parcel.carrier_delivered_on,
              }),
              carrierStatus,
            };
          }),
      },
      today,
    ),
  );
}
