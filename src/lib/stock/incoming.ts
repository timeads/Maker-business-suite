import { outstandingUnits } from "./po/totals";

/**
 * Orders on their way, for the Stock front page. Pure: takes placed orders
 * with their tracking numbers and says how far along each is, when to expect
 * it, and whether it is late. After TuftStock's src/lib/incoming/summary.ts
 * (same stages, same "soonest date wins", same late rule), but one row per
 * order rather than per item, and the status is whatever a person recorded:
 * no carrier is asked.
 */
export interface IncomingOrderInput {
  id: string;
  number: number;
  supplierName: string;
  status: string;
  /** Workspace-local days, YYYY-MM-DD. */
  orderedOn: string | null;
  expectedOn: string | null;
  lines: { qtyOrdered: number; qtyReceived: number }[];
  shipments: IncomingShipment[];
}
export interface IncomingShipment {
  id: string;
  carrier: string;
  tracking: string;
  expectedOn: string | null;
  arrivedOn: string | null;
}

export type IncomingStage = "ordered" | "shipped" | "arrived";

export interface IncomingOrder {
  id: string;
  number: number;
  supplierName: string;
  /** Units still to be checked in. */
  units: number;
  stage: IncomingStage;
  /** Soonest date across what is still travelling, else the order's own. */
  expected: string | null;
  late: boolean;
  daysLate: number;
  orderedOn: string | null;
  shipments: IncomingShipment[];
}

const dayNumber = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
};

/** Where one open order is (ordered / shipped / arrived) and its best expected date. */
export function orderState(order: Pick<IncomingOrderInput, "expectedOn" | "shipments">): {
  stage: IncomingStage;
  expected: string | null;
} {
  const travelling = order.shipments.filter((s) => !s.arrivedOn);
  if (travelling.length > 0) {
    const dates = travelling
      .map((s) => s.expectedOn)
      .filter((d): d is string => Boolean(d))
      .sort();
    return { stage: "shipped", expected: dates[0] ?? order.expectedOn };
  }
  // Every parcel we know of is here, waiting to be checked in.
  if (order.shipments.length > 0) return { stage: "arrived", expected: null };
  return { stage: "ordered", expected: order.expectedOn };
}

/** Oldest expected first; orders with no date go last. `today` is YYYY-MM-DD. */
export function summarizeIncoming(orders: IncomingOrderInput[], today: string): IncomingOrder[] {
  const rows: IncomingOrder[] = [];
  for (const order of orders) {
    if (order.status !== "ordered" && order.status !== "partial") continue;
    const units = outstandingUnits(order.lines);
    if (!units) continue;
    const { stage, expected } = orderState(order);
    const daysLate = stage !== "arrived" && expected ? dayNumber(today) - dayNumber(expected) : 0;
    rows.push({
      id: order.id,
      number: order.number,
      supplierName: order.supplierName,
      units,
      stage,
      expected,
      late: daysLate > 0,
      daysLate: Math.max(0, daysLate),
      orderedOn: order.orderedOn,
      shipments: order.shipments,
    });
  }
  const sortDay = (row: IncomingOrder) =>
    row.stage === "arrived"
      ? (row.shipments
          .map((s) => s.arrivedOn)
          .filter((d): d is string => Boolean(d))
          .sort()[0] ?? "0000-00-00")
      : (row.expected ?? "9999-12-31");
  return rows.sort((a, b) => sortDay(a).localeCompare(sortDay(b)) || a.number - b.number);
}
