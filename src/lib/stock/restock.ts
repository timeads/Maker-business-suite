import type { SupabaseClient } from "@supabase/supabase-js";
import { isCarrierStatus, parcelDates } from "./tracking";

/**
 * "When is this back?": what is on order for an item, how far along it is and
 * when to expect it. TuftStock hands this to its help desk over the web
 * (`/api/incoming`, `incoming/summary.ts`); here the help desk is in the same
 * app, so it reads it directly as the signed-in member, under row-level
 * security. Deliberately leaves out suppliers, costs and order references:
 * the desk only needs "how many, when".
 */

export type RestockStage = "ordered" | "shipped" | "arrived";

export type RestockLine = {
  itemId: string;
  name: string;
  sku: string | null;
  onHand: number;
  qtyOrdered: number;
  qtyReceived: number;
  /** The order's own status and expected day. */
  status: string;
  expectedOn: string | null;
  /** The parcels this line is in, with the dates to go by already chosen. */
  parcels: { arrivedOn: string | null; expectedOn: string | null }[];
};

export type RestockRow = {
  itemId: string;
  name: string;
  sku: string | null;
  onHand: number;
  /** Units ordered and not yet checked in. */
  incoming: number;
  /** The furthest along of its open lines. */
  stage: RestockStage;
  /** YYYY-MM-DD, the soonest across its open lines. Null once it's here, or when nobody knows. */
  expected: string | null;
  /** The expected day has passed and nothing has arrived. */
  late: boolean;
};

const RANK: Record<RestockStage, number> = { ordered: 0, shipped: 1, arrived: 2 };

/** Where one open line is, and its best expected day. */
export function lineState(line: Pick<RestockLine, "expectedOn" | "parcels">): {
  stage: RestockStage;
  eta: string | null;
} {
  if (line.parcels.some((parcel) => parcel.arrivedOn)) return { stage: "arrived", eta: null };
  if (line.parcels.length > 0) {
    const etas = line.parcels
      .map((parcel) => parcel.expectedOn)
      .filter((day): day is string => Boolean(day))
      .sort();
    return { stage: "shipped", eta: etas[0] ?? line.expectedOn };
  }
  return { stage: "ordered", eta: line.expectedOn };
}

/** One row per item with something still to come, by name. `today` is YYYY-MM-DD. */
export function summarizeRestock(lines: RestockLine[], today: string): RestockRow[] {
  const rows = new Map<string, RestockRow & { eta: string | null }>();
  for (const line of lines) {
    if (line.status !== "ordered" && line.status !== "partial") continue;
    const outstanding = Math.max(0, line.qtyOrdered - line.qtyReceived);
    if (!outstanding) continue;
    const { stage, eta } = lineState(line);
    const row = rows.get(line.itemId);
    if (!row) {
      rows.set(line.itemId, {
        itemId: line.itemId,
        name: line.name,
        sku: line.sku,
        onHand: line.onHand,
        incoming: outstanding,
        stage,
        expected: null,
        late: false,
        eta,
      });
      continue;
    }
    row.incoming += outstanding;
    if (RANK[stage] > RANK[row.stage]) row.stage = stage;
    if (eta && (!row.eta || eta < row.eta)) row.eta = eta;
  }
  return [...rows.values()]
    .map(({ eta, ...row }) => ({
      ...row,
      expected: row.stage === "arrived" || !eta ? null : eta,
      late: row.stage !== "arrived" && Boolean(eta) && (eta as string) < today,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const shortDay = (day: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(
    new Date(`${day}T12:00:00Z`),
  );

/** What the shelf and the orders say about one item, in a few plain words. */
export function restockWords(item: { onHand: number; incoming: RestockRow | null }): string {
  const shelf = item.onHand > 0 ? `${item.onHand} on the shelf` : "none on the shelf";
  const more = item.incoming;
  if (!more) return item.onHand > 0 ? shelf : `${shelf}, and none on order`;
  const coming = `${more.incoming} more ${
    more.stage === "arrived"
      ? "have arrived and are being checked in"
      : more.stage === "shipped"
        ? "on the way"
        : "on order"
  }`;
  if (more.stage === "arrived") return `${shelf}; ${coming}`;
  if (!more.expected) return `${shelf}; ${coming}, with no date yet`;
  return `${shelf}; ${coming}, ${more.late ? "was due" : "due"} ${shortDay(more.expected)}`;
}

/** A line of a customer's order, as the shop sync stores it. */
export type BoughtLine = {
  title: string;
  variant_title?: string | null;
  sku?: string | null;
  product_external_id?: string | null;
};

export type BoughtItemStock = {
  itemId: string;
  name: string;
  sku: string | null;
  onHand: number;
  incoming: RestockRow | null;
  words: string;
};

/**
 * For the things a customer bought: what is on the shelf and what is on its
 * way. Read as the signed-in member (every query names the workspace and is
 * held to it by row-level security). Lines are matched to stock items the way
 * the reorder sums match sales: by SKU, else by product and option.
 */
export async function loadStockForBought(
  supabase: SupabaseClient,
  tenant: { id: string },
  bought: BoughtLine[],
  today: string,
): Promise<BoughtItemStock[]> {
  const skus = [...new Set(bought.map((line) => line.sku?.trim()).filter(Boolean))] as string[];
  const products = [
    ...new Set(
      bought
        .filter((line) => !line.sku?.trim())
        .map((line) => line.product_external_id)
        .filter(Boolean),
    ),
  ] as string[];
  if (skus.length === 0 && products.length === 0) return [];
  type Item = {
    id: string;
    title: string;
    variant_title: string | null;
    sku: string | null;
    product_external_id: string | null;
    on_hand: number;
  };
  const select = "id, title, variant_title, sku, product_external_id, on_hand";
  const [bySku, byProduct] = await Promise.all([
    skus.length > 0
      ? supabase
          .from("stock_items")
          .select(select)
          .eq("tenant_id", tenant.id)
          .in("sku", skus.slice(0, 60))
          .limit(200)
      : Promise.resolve({ data: [] }),
    products.length > 0
      ? supabase
          .from("stock_items")
          .select(select)
          .eq("tenant_id", tenant.id)
          .is("sku", null)
          .in("product_external_id", products.slice(0, 60))
          .limit(200)
      : Promise.resolve({ data: [] }),
  ]);
  const wanted = (item: Item) =>
    bought.some((line) =>
      line.sku?.trim()
        ? item.sku === line.sku.trim()
        : item.sku === null &&
          item.product_external_id === line.product_external_id &&
          (item.variant_title ?? "") === (line.variant_title ?? ""),
    );
  const items = [...((bySku.data ?? []) as Item[]), ...((byProduct.data ?? []) as Item[])]
    .filter(wanted)
    .filter((item, index, list) => list.findIndex((other) => other.id === item.id) === index)
    .slice(0, 40);
  if (items.length === 0) return [];

  type Line = {
    stock_item_id: string;
    id: string;
    qty_ordered: number;
    qty_received: number;
    purchase_orders: {
      status: string;
      expected_on: string | null;
      purchase_order_shipments: {
        expected_on: string | null;
        arrived_on: string | null;
        removed_at: string | null;
        carrier_status: string | null;
        carrier_expected_on: string | null;
        carrier_delivered_on: string | null;
        purchase_order_shipment_items: { po_line_id: string }[];
      }[];
    };
  };
  const { data: lines } = await supabase
    .from("purchase_order_lines")
    .select(
      "id, stock_item_id, qty_ordered, qty_received, purchase_orders!inner(status, expected_on, purchase_order_shipments(expected_on, arrived_on, removed_at, carrier_status, carrier_expected_on, carrier_delivered_on, purchase_order_shipment_items(po_line_id)))",
    )
    .eq("tenant_id", tenant.id)
    .in(
      "stock_item_id",
      items.map((item) => item.id),
    )
    .in("purchase_orders.status", ["ordered", "partial"])
    .limit(500);
  const byId = new Map(items.map((item) => [item.id, item]));
  const nameOf = (item: Item) =>
    item.variant_title ? `${item.title} · ${item.variant_title}` : item.title;
  const rows = summarizeRestock(
    ((lines ?? []) as unknown as Line[]).flatMap((line) => {
      const item = byId.get(line.stock_item_id);
      if (!item) return [];
      const parcels = (line.purchase_orders.purchase_order_shipments ?? []).filter(
        (parcel) => !parcel.removed_at,
      );
      // Where the order's parcels say what is in them, a line travels only in
      // the parcels that list it; where none says, in all of them.
      const itemised = parcels.some((p) => (p.purchase_order_shipment_items ?? []).length > 0);
      const mine = itemised
        ? parcels.filter((p) =>
            (p.purchase_order_shipment_items ?? []).some((entry) => entry.po_line_id === line.id),
          )
        : parcels;
      return [
        {
          itemId: item.id,
          name: nameOf(item),
          sku: item.sku,
          onHand: item.on_hand,
          qtyOrdered: line.qty_ordered,
          qtyReceived: line.qty_received,
          status: line.purchase_orders.status,
          expectedOn: line.purchase_orders.expected_on,
          parcels: mine.map((parcel) =>
            parcelDates({
              expectedOn: parcel.expected_on,
              arrivedOn: parcel.arrived_on,
              carrierStatus: isCarrierStatus(parcel.carrier_status) ? parcel.carrier_status : null,
              carrierExpectedOn: parcel.carrier_expected_on,
              carrierDeliveredOn: parcel.carrier_delivered_on,
            }),
          ),
        },
      ];
    }),
    today,
  );
  const incoming = new Map(rows.map((row) => [row.itemId, row]));
  return items
    .map((item) => {
      const more = incoming.get(item.id) ?? null;
      return {
        itemId: item.id,
        name: nameOf(item),
        sku: item.sku,
        onHand: item.on_hand,
        incoming: more,
        words: restockWords({ onHand: item.on_hand, incoming: more }),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
