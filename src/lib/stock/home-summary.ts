import type { SupabaseClient } from "@supabase/supabase-js";
import { localDay, zonedTimeToUtc } from "../bookings/slots";
import { shiftDay } from "./engine/closures";
import { summarizeIncoming } from "./incoming";
import { isCarrierStatus, parcelDates } from "./tracking";

/**
 * Stock in a line or two for the workspace's home page: how much of the range
 * is in stock, what was checked in this month, what is due soon and the best
 * seller. TuftStock serves these as cards to a separate hub over the web
 * (`hub-summary/cards.ts`); here the home page is in the same app, so it
 * reads them directly as the signed-in member. Like TuftStock's, they are
 * only ever said when they are good news: nothing here is an alarm.
 */

export type StockHomeFacts = {
  /** Items kept in stock: counted by the shop, on sale, not hidden or switched off. */
  activeItems: number;
  /** …of which have some on the shelf. */
  inStockItems: number;
  /** Units checked in since the 1st of the month (workspace time), and on how many orders. */
  receivedUnitsThisMonth: number;
  receivedOrdersThisMonth: number;
  /** Units checked in last month up to the same point. */
  receivedUnitsLastMonthToDate: number;
  /** Units due in the next two weeks on orders still open. */
  arriving: { units: number; orders: number };
  topSeller: { name: string; units: number } | null;
};

export const ARRIVING_WINDOW_DAYS = 14;
/** Below this, "in stock" is an alarm, not a win: leave it to Stock's own first screen. */
export const IN_STOCK_RATE_MIN_PCT = 50;

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "up 18% on last month at this point", "level with last month…", or nothing when it's down. */
export function upOnLastMonth(current: number, previous: number): string | null {
  if (current <= 0 || previous <= 0 || current < previous) return null;
  const pct = Math.round(((current - previous) / previous) * 100);
  return pct >= 1
    ? `up ${pct}% on last month at this point`
    : "level with last month at this point";
}

/** The facts worth saying, each a short phrase, the most useful first. */
export function stockHomeLines(facts: StockHomeFacts): string[] {
  const lines: string[] = [];
  if (facts.arriving.units > 0) {
    lines.push(
      `${plural(facts.arriving.units, "unit")} due in the next ${ARRIVING_WINDOW_DAYS} days on ${plural(facts.arriving.orders, "order")}`,
    );
  }
  if (facts.activeItems > 0 && facts.inStockItems > 0) {
    // Rounded down to one decimal, so a single empty shelf never reads as "100%".
    const pct = Math.floor((facts.inStockItems / facts.activeItems) * 1000) / 10;
    if (pct >= IN_STOCK_RATE_MIN_PCT) {
      lines.push(
        `${pct}% of items in stock (${facts.inStockItems.toLocaleString("en-US")} of ${facts.activeItems.toLocaleString("en-US")})`,
      );
    }
  }
  if (facts.receivedUnitsThisMonth > 0) {
    const compared = upOnLastMonth(
      facts.receivedUnitsThisMonth,
      facts.receivedUnitsLastMonthToDate,
    );
    lines.push(
      `${plural(facts.receivedUnitsThisMonth, "unit")} checked in this month${compared ? `, ${compared}` : ""}`,
    );
  }
  if (facts.topSeller && facts.topSeller.units > 0) {
    const name =
      facts.topSeller.name.length > 60
        ? `${facts.topSeller.name.slice(0, 59).trimEnd()}…`
        : facts.topSeller.name;
    lines.push(
      `best seller in 30 days: ${name} (${facts.topSeller.units.toLocaleString("en-US")})`,
    );
  }
  return lines;
}

/** The same moment of the month, one month back (clamped to that month's end), as days and clock. */
export function lastMonthSamePoint(today: string): { start: string; day: string } {
  const [y, m, d] = today.split("-").map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const daysInPrev = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    start: `${py}-${pad(pm)}-01`,
    // Past the end of a shorter month means "all of it": the 1st of this month.
    day: d > daysInPrev ? `${y}-${pad(m)}-01` : `${py}-${pad(pm)}-${pad(d)}`,
  };
}

const PAGE = 1000;

/** Reads the facts as the signed-in member. Every query names the workspace. */
export async function loadStockHomeFacts(
  supabase: SupabaseClient,
  tenant: { id: string; timezone: string },
  now: Date = new Date(),
): Promise<StockHomeFacts> {
  const today = localDay(now, tenant.timezone);
  const monthStart = zonedTimeToUtc(`${today.slice(0, 8)}01`, 0, tenant.timezone);
  const previous = lastMonthSamePoint(today);
  const prevStart = zonedTimeToUtc(previous.start, 0, tenant.timezone);
  // The same clock time on the matching day last month.
  const minutesToday = monthStart
    ? Math.round(
        (now.getTime() - (zonedTimeToUtc(today, 0, tenant.timezone)?.getTime() ?? now.getTime())) /
          60_000,
      )
    : 0;
  const prevCut =
    previous.day === `${today.slice(0, 8)}01`
      ? monthStart
      : zonedTimeToUtc(previous.day, Math.max(0, Math.min(1439, minutesToday)), tenant.timezone);

  const active = () =>
    supabase
      .from("stock_items")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant.id)
      .eq("hidden", false)
      .eq("dont_reorder", false)
      .eq("tracked", true)
      .or("product_status.is.null,product_status.neq.ARCHIVED");
  const receipts = (from: Date | null, to: Date | null) =>
    from && to
      ? supabase
          .from("stock_receipts")
          .select("quantity, purchase_order_lines(po_id)")
          .eq("tenant_id", tenant.id)
          .eq("source", "app")
          .gte("created_at", from.toISOString())
          .lt("created_at", to.toISOString())
          .limit(PAGE)
      : Promise.resolve({ data: [] });

  const [all, inStock, thisMonth, lastMonth, open, sales] = await Promise.all([
    active(),
    active().gt("on_hand", 0),
    receipts(monthStart, new Date(now.getTime() + 1000)),
    receipts(prevStart, prevCut),
    supabase
      .from("purchase_orders")
      .select(
        "id, number, status, expected_on, purchase_order_lines(qty_ordered, qty_received), purchase_order_shipments(id, carrier, tracking, expected_on, arrived_on, removed_at, carrier_status, carrier_expected_on, carrier_delivered_on)",
      )
      .eq("tenant_id", tenant.id)
      .in("status", ["ordered", "partial"])
      .limit(300),
    supabase
      .rpc("stock_sales_by_day", { p_tenant_id: tenant.id, p_days: 30 })
      .order("day")
      .order("stock_item_id")
      .limit(5 * PAGE),
  ]);

  type Receipt = { quantity: number; purchase_order_lines: { po_id: string } | null };
  const sum = (rows: Receipt[]) => rows.reduce((n, row) => n + row.quantity, 0);
  const received = (thisMonth.data ?? []) as unknown as Receipt[];

  type Open = {
    id: string;
    number: number;
    status: string;
    expected_on: string | null;
    purchase_order_lines: { qty_ordered: number; qty_received: number }[];
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
  const arrivingBy = shiftDay(today, ARRIVING_WINDOW_DAYS);
  // The same rule the "To order" tab uses for each order's stage and best date.
  const due = summarizeIncoming(
    ((open.data ?? []) as unknown as Open[]).map((order) => ({
      id: order.id,
      number: order.number,
      supplierName: "",
      status: order.status,
      orderedOn: null,
      expectedOn: order.expected_on,
      lines: order.purchase_order_lines.map((line) => ({
        qtyOrdered: line.qty_ordered,
        qtyReceived: line.qty_received,
      })),
      shipments: (order.purchase_order_shipments ?? [])
        .filter((parcel) => !parcel.removed_at)
        .map((parcel) => ({
          id: parcel.id,
          carrier: parcel.carrier,
          tracking: parcel.tracking,
          ...parcelDates({
            expectedOn: parcel.expected_on,
            arrivedOn: parcel.arrived_on,
            carrierStatus: isCarrierStatus(parcel.carrier_status) ? parcel.carrier_status : null,
            carrierExpectedOn: parcel.carrier_expected_on,
            carrierDeliveredOn: parcel.carrier_delivered_on,
          }),
        })),
    })),
    today,
    // Late, undated and already-here orders aren't "due soon".
  ).filter(
    (order) =>
      order.stage !== "arrived" &&
      order.expected !== null &&
      order.expected >= today &&
      order.expected <= arrivingBy,
  );

  const sold = new Map<string, number>();
  for (const row of (sales.data ?? []) as { stock_item_id: string; units: number | string }[]) {
    sold.set(row.stock_item_id, (sold.get(row.stock_item_id) ?? 0) + Number(row.units));
  }
  const best = [...sold].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  let topSeller: StockHomeFacts["topSeller"] = null;
  if (best && best[1] > 0) {
    const { data: item } = await supabase
      .from("stock_items")
      .select("title, variant_title")
      .eq("tenant_id", tenant.id)
      .eq("id", best[0])
      .maybeSingle();
    if (item) {
      topSeller = {
        name: item.variant_title ? `${item.title} · ${item.variant_title}` : (item.title as string),
        units: best[1],
      };
    }
  }

  return {
    activeItems: all.count ?? 0,
    inStockItems: inStock.count ?? 0,
    receivedUnitsThisMonth: sum(received),
    receivedOrdersThisMonth: new Set(
      received.map((row) => row.purchase_order_lines?.po_id).filter(Boolean),
    ).size,
    receivedUnitsLastMonthToDate: sum((lastMonth.data ?? []) as unknown as Receipt[]),
    arriving: { units: due.reduce((n, order) => n + order.units, 0), orders: due.length },
    topSeller,
  };
}
