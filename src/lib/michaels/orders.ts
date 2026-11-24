import { centsText, epochToDate, toCents, toInt } from "./mapping";
import type { MichaelsOrder } from "./types";

/**
 * Michaels orders, read only. Two things live here: what is kept of an order
 * (its number, status, dates, totals and lines; never the buyer's name,
 * phone or address), and what bringing it into the shop WOULD make, shown on
 * the Orders tab. Nothing is created anywhere in this stage.
 */

export type OrderLineRecord = {
  order_item_id: string;
  seller_sku: string | null;
  michaels_sku_number: string | null;
  product_name: string | null;
  quantity: number;
  unit_price: string | null;
  line_status: string | null;
};

export type OrderRecord = {
  order_number: string;
  status: string;
  currency: string | null;
  placed_at: string | null;
  promise_ship_at: string | null;
  michaels_updated_at: string | null;
  items_subtotal: string | null;
  shipping: string | null;
  tax: string | null;
  discount: string | null;
  grand_total: string | null;
  lines: OrderLineRecord[];
};

const money = (v: string | number | null | undefined): string | null => {
  const cents = toCents(v);
  return cents === null ? null : centsText(cents);
};
const short = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const id = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;

/** What we keep of one order. Null when Michaels sent something that isn't one. */
export function orderRecord(o: MichaelsOrder): OrderRecord | null {
  const number = id(o?.orderNumber);
  if (!number || number.length > 80) return null;
  const lines: OrderLineRecord[] = [];
  for (const l of o.orderLines ?? []) {
    const itemId = id(l?.orderItemId);
    if (!itemId || itemId.length > 80) continue;
    lines.push({
      order_item_id: itemId,
      // Kept exactly as Michaels has it; matching folds capitals and spaces.
      seller_sku:
        typeof l.sellerSkuNumber === "string" && l.sellerSkuNumber.trim()
          ? l.sellerSkuNumber.slice(0, 200)
          : null,
      michaels_sku_number: id(l.skuNumber)?.slice(0, 80) ?? null,
      product_name: short(l.productName, 300),
      quantity: Math.max(0, Math.min(1_000_000, toInt(l.quantity))),
      unit_price: money(l.price),
      line_status: short(l.status, 40),
    });
  }
  return {
    order_number: number,
    status: short(o.status, 40) ?? "UNKNOWN",
    currency: short(o.currency, 8),
    placed_at: epochToDate(o.createdTime)?.toISOString() ?? null,
    promise_ship_at: epochToDate(o.promiseShipDate)?.toISOString() ?? null,
    michaels_updated_at: epochToDate(o.updatedTime)?.toISOString() ?? null,
    items_subtotal: money(o.itemsSubtotal),
    shipping: money(o.shippingHandlingCharge),
    tax: money(o.estimatedTax),
    discount: money(o.totalDiscount),
    grand_total: money(o.grandTotalCollected),
    lines,
  };
}

export type OrderResolver = (sellerSku: string | null, skuNumber: string | null) => string | null;

/**
 * Michaels line → stock item (TuftStock's order of trying): the matched
 * listings first, by Michaels SKU number and then by seller SKU; then an item
 * in the shop that alone has that very SKU.
 */
export function buildOrderResolver(
  listings: {
    michaels_sku_number: string;
    seller_sku: string | null;
    stock_item_id: string | null;
  }[],
  items: { id: string; sku: string | null }[],
): OrderResolver {
  const byMichaelsSku = new Map<string, string>();
  const bySellerSku = new Map<string, string>();
  for (const l of listings) {
    if (!l.stock_item_id) continue;
    byMichaelsSku.set(l.michaels_sku_number, l.stock_item_id);
    if (l.seller_sku) bySellerSku.set(l.seller_sku, l.stock_item_id);
  }
  const counts = new Map<string, number>();
  for (const item of items) if (item.sku) counts.set(item.sku, (counts.get(item.sku) ?? 0) + 1);
  const byShopSku = new Map(
    items.filter((i) => i.sku && counts.get(i.sku) === 1).map((i) => [i.sku!, i.id]),
  );
  return (sellerSku, skuNumber) =>
    (skuNumber && byMichaelsSku.get(skuNumber)) ||
    (sellerSku && (bySellerSku.get(sellerSku) ?? byShopSku.get(sellerSku))) ||
    null;
}

export type OrderPreviewLine = OrderLineRecord & {
  /** The stock item this line would sell; null when its SKU isn't known. */
  item_id: string | null;
};

export type OrderPreview = {
  /** Could this order be brought into the shop as it stands? All or nothing. */
  wouldCreate: boolean;
  /** Why not, in words for the page. */
  problems: string[];
  lines: OrderPreviewLine[];
  units: number;
  /** Units × price over the lines, as "12.50". */
  itemsTotal: string;
};

/**
 * What bringing one order into the shop would make. TuftStock's rule: an
 * order is created whole or not at all. If any line's SKU can't be matched,
 * nothing would be created and the order is flagged for a person to pair.
 */
export function orderPreview(
  order: Pick<OrderRecord, "currency" | "lines">,
  resolve: OrderResolver,
): OrderPreview {
  const problems: string[] = [];
  const lines = order.lines.map((l) => ({
    ...l,
    item_id: resolve(l.seller_sku, l.michaels_sku_number),
  }));
  if (lines.length === 0) problems.push("Michaels sent this order without any lines.");
  if (order.currency && order.currency !== "USD") {
    problems.push(`It was paid in ${order.currency}, which isn't handled.`);
  }
  const unknown = lines.filter((l) => !l.item_id);
  if (unknown.length > 0) {
    const names = unknown.map(
      (l) => l.seller_sku || `Michaels SKU ${l.michaels_sku_number ?? "?"}`,
    );
    problems.push(
      `Not matched to anything in your shop: ${[...new Set(names)].slice(0, 8).join(", ")}${names.length > 8 ? "…" : ""}. Pair ${unknown.length === 1 ? "it" : "them"} on the Listings tab.`,
    );
  }
  if (lines.some((l) => l.quantity <= 0)) problems.push("A line has a quantity of 0.");
  const cents = lines.reduce((sum, l) => sum + (toCents(l.unit_price) ?? 0) * l.quantity, 0);
  return {
    wouldCreate: problems.length === 0,
    problems,
    lines,
    units: lines.reduce((sum, l) => sum + l.quantity, 0),
    itemsTotal: centsText(cents),
  };
}
