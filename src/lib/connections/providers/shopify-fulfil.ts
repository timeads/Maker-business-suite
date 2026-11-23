import { ProviderHttpError, requestJson } from "../http";
import { ReconnectRequiredError, type Fetch, type TokenSet } from "../types";
import { shopifyApiVersion } from "./shopify";

/**
 * Tells the shop a parcel has gone: marks the items as sent and passes on the
 * tracking number. The shop then emails the customer if asked to.
 */

export class ShopSendError extends Error {}

const FULFILMENT_ORDERS = `query Open($id: ID!) {
  order(id: $id) {
    fulfillmentOrders(first: 10) {
      nodes { id status lineItems(first: 100) { nodes { id remainingQuantity lineItem { id } } } }
    }
  }
}`;
const FULFIL = `mutation Fulfil($f: FulfillmentInput!) {
  fulfillmentCreate(fulfillment: $f) { fulfillment { id } userErrors { message } }
}`;

export const canSendInShopify = (scopes: unknown): boolean =>
  Array.isArray(scopes) && scopes.includes("write_merchant_managed_fulfillment_orders");

type OpenOrder = {
  id: string;
  status: string;
  lineItems: { nodes: { id: string; remainingQuantity: number; lineItem: { id: string } }[] };
};

/** Spreads each line's quantity over the shop's own fulfilment lines that still have it. */
export function planFulfilment(
  open: OpenOrder[],
  items: { line_id: string; qty: number }[],
): { fulfillmentOrderId: string; fulfillmentOrderLineItems: { id: string; quantity: number }[] }[] {
  const want = new Map<string, number>();
  for (const item of items) {
    if (item.qty > 0) want.set(item.line_id, (want.get(item.line_id) ?? 0) + item.qty);
  }
  return open
    .map((order) => ({
      fulfillmentOrderId: order.id,
      fulfillmentOrderLineItems: order.lineItems.nodes.flatMap((line) => {
        const left = want.get(line.lineItem.id) ?? 0;
        const take = Math.min(left, line.remainingQuantity);
        if (take <= 0) return [];
        want.set(line.lineItem.id, left - take);
        return [{ id: line.id, quantity: take }];
      }),
    }))
    .filter((order) => order.fulfillmentOrderLineItems.length > 0);
}

/**
 * The tracking to put on one fulfilment: every box's number, in order. The
 * links are sent only when there is one for each number, so a link can never
 * sit against the wrong number; otherwise the shop works them out itself
 * from the carrier.
 */
export function trackingFor(shipment: {
  trackingNumber: string;
  trackingUrl: string | null;
  trackingNumbers?: string[];
  trackingUrls?: (string | null)[];
}): { numbers: string[]; urls: string[] } {
  const pairs = (
    shipment.trackingNumbers && shipment.trackingNumbers.length > 0
      ? shipment.trackingNumbers.map((number, index) => ({
          number,
          url: shipment.trackingUrls?.[index] ?? null,
        }))
      : [{ number: shipment.trackingNumber, url: shipment.trackingUrl }]
  ).filter((pair) => typeof pair.number === "string" && pair.number.trim() !== "");
  const urls = pairs.map((pair) => pair.url).filter((url): url is string => Boolean(url));
  return {
    numbers: pairs.map((pair) => pair.number),
    urls: urls.length === pairs.length ? urls : [],
  };
}

export function createShopifySender(fetchImpl: Fetch = fetch) {
  async function graphql<T>(shop: string, token: TokenSet, query: string, variables?: object) {
    try {
      const result = await requestJson<{ data?: T; errors?: unknown }>(
        fetchImpl,
        "Shopify",
        `https://${shop}/admin/api/${shopifyApiVersion()}/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": token.access_token,
          },
          body: JSON.stringify({ query, variables }),
        },
      );
      if (result.errors || !result.data)
        throw new ShopSendError("The shop turned the request down");
      return result.data;
    } catch (err) {
      if (err instanceof ProviderHttpError && err.status === 401) {
        throw new ReconnectRequiredError("Shopify no longer accepts this store's access");
      }
      throw err;
    }
  }

  return {
    async send(
      shop: string,
      token: TokenSet,
      shipment: {
        orderExternalId: string;
        carrier: string;
        trackingNumber: string;
        trackingUrl: string | null;
        /**
         * Every box's tracking number when a parcel went in several, with each
         * one's link (null where there is none). Left out, the single pair above is used.
         */
        trackingNumbers?: string[];
        trackingUrls?: (string | null)[];
        items: { line_id: string; qty: number }[];
        notifyCustomer: boolean;
      },
    ): Promise<void> {
      const found = await graphql<{
        order: { fulfillmentOrders: { nodes: OpenOrder[] } } | null;
      }>(shop, token, FULFILMENT_ORDERS, { id: `gid://shopify/Order/${shipment.orderExternalId}` });
      if (!found.order) throw new ShopSendError("The shop no longer has this order");
      const open = found.order.fulfillmentOrders.nodes.filter((order) =>
        ["OPEN", "IN_PROGRESS"].includes(order.status),
      );
      const plan = planFulfilment(open, shipment.items);
      if (plan.length === 0) {
        throw new ShopSendError("The shop shows nothing left to send on this order");
      }
      const tracking = trackingFor(shipment);
      const result = await graphql<{
        fulfillmentCreate: { userErrors: { message: string }[] };
      }>(shop, token, FULFIL, {
        f: {
          lineItemsByFulfillmentOrder: plan,
          ...(tracking.numbers.length > 0
            ? { trackingInfo: { ...tracking, company: shipment.carrier } }
            : {}),
          notifyCustomer: shipment.notifyCustomer,
        },
      });
      const errors = result.fulfillmentCreate.userErrors;
      if (errors.length > 0) {
        throw new ShopSendError(
          errors
            .map((e) => e.message)
            .join("; ")
            .slice(0, 300),
        );
      }
    },
  };
}
