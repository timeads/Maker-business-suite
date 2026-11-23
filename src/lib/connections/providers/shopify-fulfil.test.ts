import { describe, expect, it } from "vitest";
import type { Fetch } from "../types";
import {
  canSendInShopify,
  createShopifySender,
  planFulfilment,
  trackingFor,
} from "./shopify-fulfil";

const token = { access_token: "test-access", refresh_token: null, expires_at: null } as never;
const open = [
  {
    id: "fo1",
    status: "OPEN",
    lineItems: {
      nodes: [
        { id: "fol1", remainingQuantity: 1, lineItem: { id: "l1" } },
        { id: "fol2", remainingQuantity: 3, lineItem: { id: "l2" } },
      ],
    },
  },
  {
    id: "fo2",
    status: "OPEN",
    lineItems: { nodes: [{ id: "fol3", remainingQuantity: 2, lineItem: { id: "l1" } }] },
  },
];

describe("matching a parcel to the shop's own lines", () => {
  it("spreads a quantity across the places the shop still holds it, and never over-sends", () => {
    expect(planFulfilment(open, [{ line_id: "l1", qty: 2 }])).toEqual([
      { fulfillmentOrderId: "fo1", fulfillmentOrderLineItems: [{ id: "fol1", quantity: 1 }] },
      { fulfillmentOrderId: "fo2", fulfillmentOrderLineItems: [{ id: "fol3", quantity: 1 }] },
    ]);
    expect(planFulfilment(open, [{ line_id: "l2", qty: 99 }])).toEqual([
      { fulfillmentOrderId: "fo1", fulfillmentOrderLineItems: [{ id: "fol2", quantity: 3 }] },
    ]);
    expect(planFulfilment(open, [{ line_id: "gone", qty: 1 }])).toEqual([]);
  });
});

describe("telling the shop a parcel has gone", () => {
  function shop(orders: unknown, userErrors: { message: string }[] = []) {
    const sent: { query: string; variables: Record<string, never> }[] = [];
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body));
      sent.push(body);
      const data = body.query.includes("fulfillmentOrders")
        ? { order: orders }
        : { fulfillmentCreate: { fulfillment: { id: "f1" }, userErrors } };
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as Fetch;
    return { sender: createShopifySender(fetchImpl), sent };
  }
  const shipment = {
    orderExternalId: "1001",
    carrier: "USPS",
    trackingNumber: "9400 1000",
    trackingUrl: "https://tools.usps.com/x",
    items: [{ line_id: "l2", qty: 3 }],
    notifyCustomer: true,
  };

  it("sends the items, the tracking and whether to email the customer", async () => {
    const { sender, sent } = shop({ fulfillmentOrders: { nodes: open } });
    await sender.send("wild-thread.myshopify.com", token, shipment);
    expect(sent[0].variables).toEqual({ id: "gid://shopify/Order/1001" });
    expect(sent[1].variables).toEqual({
      f: {
        lineItemsByFulfillmentOrder: [
          { fulfillmentOrderId: "fo1", fulfillmentOrderLineItems: [{ id: "fol2", quantity: 3 }] },
        ],
        trackingInfo: {
          numbers: ["9400 1000"],
          urls: ["https://tools.usps.com/x"],
          company: "USPS",
        },
        notifyCustomer: true,
      },
    });
  });

  it("puts every box's tracking number on the one fulfilment", async () => {
    const { sender, sent } = shop({ fulfillmentOrders: { nodes: open } });
    await sender.send("wild-thread.myshopify.com", token, {
      ...shipment,
      trackingNumbers: ["9400 1000", "9400 2000"],
      trackingUrls: ["https://tools.usps.com/x", "https://tools.usps.com/y"],
    });
    // Still one fulfilment: the order is looked up once and sent once.
    expect(sent).toHaveLength(2);
    expect(sent[1].variables).toMatchObject({
      f: {
        trackingInfo: {
          numbers: ["9400 1000", "9400 2000"],
          urls: ["https://tools.usps.com/x", "https://tools.usps.com/y"],
          company: "USPS",
        },
      },
    });
  });

  it("only sends links when there is one for every number", () => {
    const one = { trackingNumber: "A1", trackingUrl: "https://t.example/A1" };
    expect(trackingFor(one)).toEqual({ numbers: ["A1"], urls: ["https://t.example/A1"] });
    expect(trackingFor({ ...one, trackingUrl: null })).toEqual({ numbers: ["A1"], urls: [] });
    expect(trackingFor({ ...one, trackingNumbers: [], trackingUrls: [] })).toEqual({
      numbers: ["A1"],
      urls: ["https://t.example/A1"],
    });
    expect(
      trackingFor({
        ...one,
        trackingNumbers: ["A1", "", "A3"],
        trackingUrls: ["https://t.example/A1", null, null],
      }),
    ).toEqual({ numbers: ["A1", "A3"], urls: [] });
    expect(trackingFor({ trackingNumber: "", trackingUrl: null })).toEqual({
      numbers: [],
      urls: [],
    });
  });

  it("stops when the shop has nothing left to send, or says no", async () => {
    const done = shop({
      fulfillmentOrders: { nodes: [{ ...open[0], status: "CLOSED" }] },
    });
    await expect(done.sender.send("s.myshopify.com", token, shipment)).rejects.toThrow(
      /nothing left/,
    );
    expect(done.sent).toHaveLength(1);
    const refused = shop({ fulfillmentOrders: { nodes: open } }, [{ message: "Order is on hold" }]);
    await expect(refused.sender.send("s.myshopify.com", token, shipment)).rejects.toThrow(
      /on hold/,
    );
  });

  it("is only offered once the shop has given permission", () => {
    expect(canSendInShopify(["read_orders", "write_merchant_managed_fulfillment_orders"])).toBe(
      true,
    );
    expect(canSendInShopify(["read_orders"])).toBe(false);
  });
});
