/**
 * Michaels Marketplace API shapes, trimmed to the fields the connector reads.
 * Michaels sends many numbers as strings and timestamps as epoch-millisecond
 * strings, so most fields are typed loosely and tidied at the edge
 * (mapping.ts). IDs are always strings, never numbers.
 */

export type NumLike = string | number;

export interface MichaelsEnvelope<T> {
  code: string;
  message?: string;
  data?: T;
}

export interface MichaelsSubSku {
  skuNumber: string;
  sellerSkuNumber?: string | null;
  inventory?: NumLike | null;
  price?: NumLike | null;
  availability?: string | null;
  globalTradeItemNumber?: string | null;
  /** e.g. "0: Blue,1: 5 Yard" */
  attrs?: string | null;
}

/** A listing as /listing/all-listings returns it. Only the fields used are typed. */
export interface MichaelsListing {
  skuNumber: string;
  primarySkuNumber?: string | null;
  sellerSkuNumber?: string | null;
  status?: string | null;
  itemName?: string | null;
  globalTradeItemNumber?: string | null;
  subSkus?: MichaelsSubSku[] | null;
  price?: NumLike | null;
  inventory?: NumLike | null;
  createdTime?: NumLike | null;
  updateDatetime?: NumLike | null;
  [key: string]: unknown;
}

export interface MichaelsAllListingsPage {
  listings?: MichaelsListing[] | null;
  nextCursor?: string | null;
}

/** GET /listing/inventory/{primarySkuNumber}. */
export interface MichaelsInventoryReply {
  primarySkuNumber?: string | null;
  skuInventories?:
    | { skuNumber: string; sellerSkuNumber?: string | null; availableQuantity?: NumLike | null }[]
    | null;
}

/** GET /listing/price/{primarySkuNumber}. */
export interface MichaelsPriceReply {
  primarySkuNumber?: string | null;
  skuPrices?:
    { skuNumber: string; sellerSkuNumber?: string | null; price?: NumLike | null }[] | null;
}

export interface MichaelsOrderLine {
  orderItemId: string;
  skuNumber?: string | null;
  sellerSkuNumber?: string | null;
  productName?: string | null;
  quantity: NumLike;
  fulfilledQuantity?: NumLike | null;
  price: NumLike;
  status?: string | null;
}

/**
 * An order as /order/query returns it. The reply also carries the buyer's
 * name, phone and address; they are deliberately not typed here, because this
 * stage never reads or stores them.
 */
export interface MichaelsOrder {
  orderNumber: string;
  status: string;
  currency?: string | null;
  itemsSubtotal?: NumLike | null;
  shippingHandlingCharge?: NumLike | null;
  estimatedTax?: NumLike | null;
  totalDiscount?: NumLike | null;
  grandTotalCollected?: NumLike | null;
  promiseShipDate?: NumLike | null;
  createdTime?: NumLike | null;
  updatedTime?: NumLike | null;
  orderLines?: MichaelsOrderLine[] | null;
}

/** /order/query returns a page; the docs don't pin the wrapper key, so accept several. */
export interface MichaelsOrderPage {
  orderList?: MichaelsOrder[] | null;
  orders?: MichaelsOrder[] | null;
  list?: MichaelsOrder[] | null;
  total?: NumLike | null;
}

/** Statuses where the seller still has work to do. */
export const OPEN_ORDER_STATUSES = [
  "PENDING_CONFIRMATION",
  "READY_TO_SHIP",
  "PARTIAL_FULFILLED",
] as const;

/** Recently finished orders, read so the page lists every real order. */
export const RECENT_DONE_ORDER_STATUSES = [
  "FULFILLED",
  "PARTIAL_DELIVERED",
  "DELIVERED",
  "CANCELLED",
] as const;
