import { ProviderHttpError, requestJson } from "../http";
import { ReconnectRequiredError, type Fetch, type TokenSet } from "../types";
import { shopifyApiVersion } from "./shopify";

/**
 * Tells the shop a parcel has gone: marks the items as sent and passes on the
 * tracking number. The shop then emails the customer if asked to.
 */

export class ShopSendError extends Error {}
/** The shop itself said this connection may not do that (a watch-only connection, say). */
export class ShopPermissionError extends ShopSendError {}

export const SHOP_NO_PERMISSION = "Your shop hasn't given permission for this";

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
// Undoing a parcel: the fulfilments on an order (to find ours by tracking
// number when its id was never kept), and cancelling one.
const FULFILMENTS = `query F($id: ID!) {
  order(id: $id) { fulfillments(first: 20) { id status trackingInfo(first: 10) { number } } }
}`;
const CANCEL = `mutation C($id: ID!) {
  fulfillmentCancel(id: $id) { fulfillment { id status } userErrors { message } }
}`;
// In-store pickup: which of the order's fulfilment orders are for collecting,
// and telling the shop they are packed and waiting (the shop emails the customer).
const PICKUP_ORDERS = `query FO($id: ID!) {
  order(id: $id) { fulfillmentOrders(first: 10) { nodes { id status deliveryMethod { methodType } } } }
}`;
const READY_FOR_PICKUP = `mutation R($input: FulfillmentOrderLineItemsPreparedForPickupInput!) {
  fulfillmentOrderLineItemsPreparedForPickup(input: $input) { userErrors { message } }
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

/** Shopify's own "this app may not do that": said per field, with a code. */
const accessDenied = (errors: unknown): boolean =>
  Array.isArray(errors) &&
  errors.some(
    (each) =>
      (each as { extensions?: { code?: unknown } } | null)?.extensions?.code === "ACCESS_DENIED",
  );

const said = (errors: { message: string }[]) =>
  errors
    .map((e) => e.message)
    .join("; ")
    .slice(0, 300);

const orderGid = (externalId: string) => `gid://shopify/Order/${externalId}`;

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
      if (result.errors || !result.data) {
        if (accessDenied(result.errors)) throw new ShopPermissionError(SHOP_NO_PERMISSION);
        throw new ShopSendError("The shop turned the request down");
      }
      return result.data;
    } catch (err) {
      if (err instanceof ProviderHttpError && err.status === 401) {
        throw new ReconnectRequiredError("Shopify no longer accepts this store's access");
      }
      if (err instanceof ProviderHttpError && err.status === 403) {
        throw new ShopPermissionError(SHOP_NO_PERMISSION);
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
    ): Promise<{ fulfilmentId: string | null }> {
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
        fulfillmentCreate: {
          fulfillment?: { id?: string } | null;
          userErrors: { message: string }[];
        };
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
      if (errors.length > 0) throw new ShopSendError(said(errors));
      // Kept so the parcel can be undone in the shop later.
      return { fulfilmentId: result.fulfillmentCreate.fulfillment?.id ?? null };
    },

    /**
     * Undoes "this has been sent" for a voided parcel, so the order shows as
     * unfulfilled again. With no kept id (a parcel sent before ids were
     * kept), the fulfilment is found by its tracking number. "not_found":
     * the shop has nothing of ours left to cancel.
     */
    async cancel(
      shop: string,
      token: TokenSet,
      parcel: {
        orderExternalId: string;
        fulfilmentId: string | null;
        trackingNumbers: string[];
      },
    ): Promise<"cancelled" | "not_found"> {
      let id = parcel.fulfilmentId;
      if (!id) {
        const numbers = parcel.trackingNumbers.filter((number) => number.trim() !== "");
        const found = await graphql<{
          order: {
            fulfillments: {
              id: string;
              status: string;
              trackingInfo: { number: string | null }[];
            }[];
          } | null;
        }>(shop, token, FULFILMENTS, { id: orderGid(parcel.orderExternalId) });
        id =
          (found.order?.fulfillments ?? []).find(
            (each) =>
              each.status !== "CANCELLED" &&
              each.trackingInfo.some((info) => info.number && numbers.includes(info.number)),
          )?.id ?? null;
      }
      if (!id) return "not_found";
      const result = await graphql<{
        fulfillmentCancel: { userErrors: { message: string }[] };
      }>(shop, token, CANCEL, { id });
      const errors = result.fulfillmentCancel.userErrors;
      if (errors.length > 0) throw new ShopSendError(said(errors));
      return "cancelled";
    },

    /**
     * In-store pickup, packed and waiting: tells the shop, which emails the
     * customer to come and collect.
     */
    async readyForPickup(shop: string, token: TokenSet, orderExternalId: string): Promise<void> {
      const found = await graphql<{
        order: {
          fulfillmentOrders: {
            nodes: { id: string; status: string; deliveryMethod: { methodType: string } | null }[];
          };
        } | null;
      }>(shop, token, PICKUP_ORDERS, { id: orderGid(orderExternalId) });
      if (!found.order) throw new ShopSendError("The shop no longer has this order");
      const open = found.order.fulfillmentOrders.nodes.filter(
        (order) =>
          ["OPEN", "IN_PROGRESS"].includes(order.status) &&
          order.deliveryMethod?.methodType === "PICK_UP",
      );
      if (open.length === 0) {
        throw new ShopSendError(
          "The shop doesn't have this order set up for in-store pickup, or it has already been picked up",
        );
      }
      const result = await graphql<{
        fulfillmentOrderLineItemsPreparedForPickup: { userErrors: { message: string }[] };
      }>(shop, token, READY_FOR_PICKUP, {
        input: {
          lineItemsByFulfillmentOrder: open.map((order) => ({ fulfillmentOrderId: order.id })),
        },
      });
      const errors = result.fulfillmentOrderLineItemsPreparedForPickup.userErrors;
      if (errors.length > 0) throw new ShopSendError(said(errors));
    },

    /**
     * In-store pickup, collected: everything still open on the order is
     * marked fulfilled, with no tracking and no email to the customer.
     */
    async pickedUp(
      shop: string,
      token: TokenSet,
      orderExternalId: string,
    ): Promise<{ fulfilmentId: string | null }> {
      const found = await graphql<{
        order: { fulfillmentOrders: { nodes: OpenOrder[] } } | null;
      }>(shop, token, FULFILMENT_ORDERS, { id: orderGid(orderExternalId) });
      if (!found.order) throw new ShopSendError("The shop no longer has this order");
      const open = found.order.fulfillmentOrders.nodes.filter((order) =>
        ["OPEN", "IN_PROGRESS"].includes(order.status),
      );
      if (open.length === 0) {
        throw new ShopSendError("The shop shows nothing left to hand over on this order");
      }
      const result = await graphql<{
        fulfillmentCreate: {
          fulfillment?: { id?: string } | null;
          userErrors: { message: string }[];
        };
      }>(shop, token, FULFIL, {
        f: {
          lineItemsByFulfillmentOrder: open.map((order) => ({ fulfillmentOrderId: order.id })),
          notifyCustomer: false,
        },
      });
      const errors = result.fulfillmentCreate.userErrors;
      if (errors.length > 0) throw new ShopSendError(said(errors));
      return { fulfilmentId: result.fulfillmentCreate.fulfillment?.id ?? null };
    },
  };
}
