import { computePoTotals, parseAdjustments } from "./totals";

/**
 * The Orders tab: its views, its search, each order's shipping state and the
 * spreadsheet of the list. Pure, and shared by the page and the download so
 * the two always agree. The views and the shipping column follow TuftStock
 * (`po/query.ts`, `po/shipping-state.ts`, ported with its tests).
 */

export type ShippingState =
  "none" | "not-shipped" | "shipped" | "partly-delivered" | "delivered" | "problem";

export type ShippingSummary = {
  state: ShippingState;
  label: string;
  /** Tracking numbers on the order. */
  count: number;
  delivered: number;
  /** Soonest due date among parcels still on their way (YYYY-MM-DD), if known. */
  nextEta: string | null;
};

/** One parcel, with the dates to go by already chosen (`parcelDates`). */
export type ParcelLite = {
  arrivedOn: string | null;
  expectedOn: string | null;
  /** The carrier's own word, where it is asked. */
  carrierStatus?: string | null;
};

/** An order's shipping state, from its tracking numbers. Nothing to set by hand. */
export function shippingSummary(orderStatus: string, parcels: ParcelLite[]): ShippingSummary {
  const count = parcels.length;
  const onTheWay = parcels.filter((parcel) => !parcel.arrivedOn);
  const delivered = count - onTheWay.length;
  const etas = onTheWay
    .map((parcel) => parcel.expectedOn)
    .filter((day): day is string => Boolean(day))
    .sort();
  const base = { count, delivered, nextEta: etas[0] ?? null };
  if (count === 0) {
    // A draft hasn't been ordered; a finished order is done either way.
    if (orderStatus === "ordered" || orderStatus === "partial") {
      return { ...base, state: "not-shipped", label: "Not shipped" };
    }
    return { ...base, state: "none", label: "–" };
  }
  // A closed order was checked in, whatever the carrier last said.
  if (delivered === count || orderStatus === "closed") {
    return { ...base, state: "delivered", label: "Delivered", nextEta: null };
  }
  if (onTheWay.some((parcel) => parcel.carrierStatus === "problem")) {
    return { ...base, state: "problem", label: "Held up" };
  }
  if (delivered > 0) {
    return { ...base, state: "partly-delivered", label: `${delivered} of ${count} delivered` };
  }
  return {
    ...base,
    state: "shipped",
    label: count === 1 ? "Shipped" : `Shipped · ${count} parcels`,
  };
}

export const SHIPPING_TONES: Record<ShippingState, "open" | "waiting" | "good" | "bad" | "closed"> =
  {
    none: "closed",
    "not-shipped": "closed",
    shipped: "open",
    "partly-delivered": "waiting",
    delivered: "good",
    problem: "bad",
  };

// TuftStock's five, in its order.
export const ORDER_VIEWS = [
  ["progress", "In progress"],
  ["draft", "Draft"],
  ["overdue", "Overdue"],
  ["all", "All"],
  ["archived", "Archived"],
] as const;
export type OrderView = (typeof ORDER_VIEWS)[number][0];
export const isOrderView = (value: unknown): value is OrderView =>
  ORDER_VIEWS.some(([key]) => key === value);

export type OrderListInput = {
  id: string;
  number: number;
  reference: string;
  status: string;
  supplierId: string;
  supplierName: string;
  expectedOn: string | null;
  /** Workspace-local days. */
  createdOn: string;
  sentOn: string | null;
  archived: boolean;
  shippingCost: number | string;
  taxRatePct: number | string;
  adjustments: unknown;
  lines: { qtyOrdered: number; qtyReceived: number; unitCost: number | string }[];
  parcels: ParcelLite[];
};

export type OrderListRow = Omit<
  OrderListInput,
  "lines" | "parcels" | "shippingCost" | "taxRatePct" | "adjustments"
> & {
  items: number;
  units: number;
  received: number;
  /** The order's total as "1234.50". */
  value: string;
  late: boolean;
  shipping: ShippingSummary;
};

export function toOrderRow(order: OrderListInput, today: string): OrderListRow {
  const lines = order.lines.filter((line) => line.qtyOrdered > 0 || line.qtyReceived > 0);
  const { lines: _lines, parcels, shippingCost, taxRatePct, adjustments, ...rest } = order;
  void _lines;
  return {
    ...rest,
    items: lines.length,
    units: lines.reduce((n, line) => n + line.qtyOrdered, 0),
    received: lines.reduce((n, line) => n + line.qtyReceived, 0),
    value: computePoTotals({
      lines: lines.map((line) => ({
        qtyOrdered: line.qtyOrdered,
        unitCost: Number(line.unitCost).toFixed(2),
      })),
      shippingCost: String(shippingCost ?? "0"),
      taxRatePct: String(taxRatePct ?? "0"),
      adjustments: parseAdjustments(adjustments),
    }).total.toFixed(2),
    late:
      (order.status === "ordered" || order.status === "partial") &&
      order.expectedOn !== null &&
      order.expectedOn < today,
    shipping: shippingSummary(order.status, parcels),
  };
}

const open = (row: OrderListRow) => row.status === "ordered" || row.status === "partial";

/** The rows each view holds. Archived orders are only ever under "Archived". */
export function orderViewRows(rows: OrderListRow[]): Record<OrderView, OrderListRow[]> {
  const live = rows.filter((row) => !row.archived);
  return {
    progress: live.filter(open),
    draft: live.filter((row) => row.status === "draft"),
    overdue: live.filter((row) => row.late),
    all: live,
    archived: rows.filter((row) => row.archived),
  };
}

export const ORDER_STATUS_WORDS: Record<string, string> = {
  draft: "Draft",
  ordered: "Sent, waiting",
  partial: "Part arrived",
  closed: "All in",
  cancelled: "Cancelled",
};

/** Search by reference, supplier, status or shipping words; and one supplier's orders. */
export function searchOrders(
  rows: OrderListRow[],
  q: string,
  supplierId: string | null = null,
): OrderListRow[] {
  const needle = q.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (!supplierId || row.supplierId === supplierId) &&
      (!needle ||
        `${row.reference} #${row.number} ${row.supplierName} ${ORDER_STATUS_WORDS[row.status] ?? row.status} ${row.shipping.label}`
          .toLowerCase()
          .includes(needle)),
  );
}

/** The list as a spreadsheet: TuftStock's columns, with real dates and plain numbers. */
export function ordersCsv(rows: OrderListRow[]): (string | number)[][] {
  return [
    [
      "Reference",
      "Supplier",
      "Items",
      "Units",
      "Arrived",
      "Expected",
      "Sent",
      "Status",
      "Shipping",
      "Value",
    ],
    ...rows.map((row) => [
      row.reference,
      row.supplierName,
      row.items,
      row.units,
      row.received,
      row.expectedOn ?? "",
      row.sentOn ?? "",
      row.archived ? "Archived" : (ORDER_STATUS_WORDS[row.status] ?? row.status),
      row.shipping.state === "none" ? "" : row.shipping.label,
      row.value,
    ]),
  ];
}

/** How many orders each supplier has had (drafts and cancelled ones aside), for the Suppliers tab. */
export function orderCountsBySupplier(
  orders: { supplierId: string; status: string }[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const order of orders) {
    if (order.status === "draft" || order.status === "cancelled") continue;
    counts.set(order.supplierId, (counts.get(order.supplierId) ?? 0) + 1);
  }
  return counts;
}
