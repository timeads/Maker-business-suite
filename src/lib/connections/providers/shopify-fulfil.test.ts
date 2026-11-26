import { describe, expect, it } from "vitest";
import type { Fetch } from "../types";
import {
  ShopPermissionError,
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
    const made = await sender.send("wild-thread.myshopify.com", token, shipment);
    // The shop's own id for what it made, kept so the parcel can be undone there.
    expect(made).toEqual({ fulfilmentId: "f1" });
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

/**
 * A scripted shop: each call is answered by the first script whose word is in
 * the query, and every request is kept so its shape can be checked.
 */
function scripted(answers: Record<string, unknown>, status = 200) {
  const sent: { url: string; query: string; variables: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: unknown, init?: { body?: unknown; headers?: unknown }) => {
    const body = JSON.parse(String(init?.body));
    sent.push({ url: String(url), ...body });
    const key = Object.keys(answers).find((word) => body.query.includes(word));
    return new Response(JSON.stringify(key ? answers[key] : { data: {} }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as Fetch;
  return { sender: createShopifySender(fetchImpl), sent };
}
const DENIED = {
  errors: [
    {
      message: "Access denied for fulfillmentCancel field.",
      extensions: { code: "ACCESS_DENIED" },
    },
  ],
};

describe("undoing a parcel in the shop", () => {
  const cancelled = {
    data: { fulfillmentCancel: { fulfillment: { id: "f1", status: "CANCELLED" }, userErrors: [] } },
  };

  it("cancels the fulfilment whose id was kept, without looking anything up", async () => {
    const { sender, sent } = scripted({ fulfillmentCancel: cancelled });
    await expect(
      sender.cancel("wild-thread.myshopify.com", token, {
        orderExternalId: "1001",
        fulfilmentId: "gid://shopify/Fulfillment/77",
        trackingNumbers: ["9400 1000"],
      }),
    ).resolves.toBe("cancelled");
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toMatch(
      /^https:\/\/wild-thread\.myshopify\.com\/admin\/api\/.+\/graphql\.json$/,
    );
    expect(sent[0].query).toContain("fulfillmentCancel(id: $id)");
    expect(sent[0].query).toContain("userErrors { message }");
    expect(sent[0].variables).toEqual({ id: "gid://shopify/Fulfillment/77" });
  });

  it("finds a parcel sent before ids were kept by its tracking number, skipping cancelled ones", async () => {
    const { sender, sent } = scripted({
      "fulfillments(first: 20)": {
        data: {
          order: {
            fulfillments: [
              { id: "old", status: "CANCELLED", trackingInfo: [{ number: "9400 2000" }] },
              { id: "other", status: "SUCCESS", trackingInfo: [{ number: "1Z999" }] },
              {
                id: "ours",
                status: "SUCCESS",
                trackingInfo: [{ number: null }, { number: "9400 2000" }],
              },
            ],
          },
        },
      },
      fulfillmentCancel: cancelled,
    });
    await expect(
      sender.cancel("s.myshopify.com", token, {
        orderExternalId: "1001",
        fulfilmentId: null,
        trackingNumbers: ["9400 1000", "9400 2000"],
      }),
    ).resolves.toBe("cancelled");
    expect(sent[0].query).toContain("trackingInfo(first: 10) { number }");
    expect(sent[0].variables).toEqual({ id: "gid://shopify/Order/1001" });
    expect(sent[1].variables).toEqual({ id: "ours" });
  });

  it("says so, and cancels nothing, when the shop has no fulfilment of ours", async () => {
    const { sender, sent } = scripted({
      "fulfillments(first: 20)": {
        data: { order: { fulfillments: [{ id: "other", status: "SUCCESS", trackingInfo: [] }] } },
      },
    });
    await expect(
      sender.cancel("s.myshopify.com", token, {
        orderExternalId: "1001",
        fulfilmentId: null,
        trackingNumbers: ["9400 1000"],
      }),
    ).resolves.toBe("not_found");
    // A parcel with no tracking number can't be matched to anything.
    await expect(
      sender.cancel("s.myshopify.com", token, {
        orderExternalId: "1001",
        fulfilmentId: null,
        trackingNumbers: [""],
      }),
    ).resolves.toBe("not_found");
    expect(sent.every((call) => !call.query.includes("fulfillmentCancel"))).toBe(true);
  });

  it("passes on what the shop says when it won't cancel", async () => {
    const { sender } = scripted({
      fulfillmentCancel: {
        data: {
          fulfillmentCancel: {
            fulfillment: null,
            userErrors: [{ message: "Fulfillment is already cancelled" }],
          },
        },
      },
    });
    await expect(
      sender.cancel("s.myshopify.com", token, {
        orderExternalId: "1001",
        fulfilmentId: "f1",
        trackingNumbers: [],
      }),
    ).rejects.toThrow(/already cancelled/);
  });

  it("knows a shop that hasn't given permission from any other no", async () => {
    const denied = scripted({ fulfillmentCancel: DENIED });
    await expect(
      denied.sender.cancel("s.myshopify.com", token, {
        orderExternalId: "1001",
        fulfilmentId: "f1",
        trackingNumbers: [],
      }),
    ).rejects.toBeInstanceOf(ShopPermissionError);
    const forbidden = scripted({ fulfillmentCancel: {} }, 403);
    await expect(
      forbidden.sender.cancel("s.myshopify.com", token, {
        orderExternalId: "1001",
        fulfilmentId: "f1",
        trackingNumbers: [],
      }),
    ).rejects.toBeInstanceOf(ShopPermissionError);
  });
});

describe("telling the shop about a pickup", () => {
  const orders = (nodes: unknown[]) => ({ data: { order: { fulfillmentOrders: { nodes } } } });
  const pickup = { id: "fo1", status: "OPEN", deliveryMethod: { methodType: "PICK_UP" } };

  it("marks the pickup fulfilment orders ready, and only those", async () => {
    const { sender, sent } = scripted({
      "deliveryMethod { methodType }": orders([
        pickup,
        { id: "fo2", status: "OPEN", deliveryMethod: { methodType: "SHIPPING" } },
        { id: "fo3", status: "CLOSED", deliveryMethod: { methodType: "PICK_UP" } },
        { id: "fo4", status: "IN_PROGRESS", deliveryMethod: { methodType: "PICK_UP" } },
        { id: "fo5", status: "OPEN", deliveryMethod: null },
      ]),
      fulfillmentOrderLineItemsPreparedForPickup: {
        data: { fulfillmentOrderLineItemsPreparedForPickup: { userErrors: [] } },
      },
    });
    await sender.readyForPickup("s.myshopify.com", token, "1001");
    expect(sent).toHaveLength(2);
    expect(sent[0].variables).toEqual({ id: "gid://shopify/Order/1001" });
    expect(sent[1].query).toContain(
      "mutation R($input: FulfillmentOrderLineItemsPreparedForPickupInput!)",
    );
    expect(sent[1].query).toContain("fulfillmentOrderLineItemsPreparedForPickup(input: $input)");
    expect(sent[1].variables).toEqual({
      input: {
        lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: "fo1" }, { fulfillmentOrderId: "fo4" }],
      },
    });
  });

  it("stops before telling the shop when the order isn't a pickup there", async () => {
    const { sender, sent } = scripted({
      "deliveryMethod { methodType }": orders([
        { id: "fo2", status: "OPEN", deliveryMethod: { methodType: "SHIPPING" } },
      ]),
    });
    await expect(sender.readyForPickup("s.myshopify.com", token, "1001")).rejects.toThrow(
      /in-store pickup/,
    );
    expect(sent).toHaveLength(1);
  });

  it("passes on the shop's own words, and knows a missing permission", async () => {
    const refused = scripted({
      "deliveryMethod { methodType }": orders([pickup]),
      fulfillmentOrderLineItemsPreparedForPickup: {
        data: {
          fulfillmentOrderLineItemsPreparedForPickup: {
            userErrors: [{ message: "The fulfillment order is on hold" }],
          },
        },
      },
    });
    await expect(refused.sender.readyForPickup("s.myshopify.com", token, "1001")).rejects.toThrow(
      /on hold/,
    );
    const denied = scripted({
      "deliveryMethod { methodType }": orders([pickup]),
      fulfillmentOrderLineItemsPreparedForPickup: DENIED,
    });
    await expect(
      denied.sender.readyForPickup("s.myshopify.com", token, "1001"),
    ).rejects.toBeInstanceOf(ShopPermissionError);
    // A watch-only shop may not even read fulfilment orders.
    const blind = scripted({ "deliveryMethod { methodType }": DENIED });
    await expect(
      blind.sender.readyForPickup("s.myshopify.com", token, "1001"),
    ).rejects.toBeInstanceOf(ShopPermissionError);
  });

  it("marks a collected order fulfilled: every open fulfilment order whole, no tracking, no email", async () => {
    const { sender, sent } = scripted({
      "fulfillmentOrders(first: 10)": orders([
        { id: "fo1", status: "OPEN", lineItems: { nodes: [] } },
        { id: "fo2", status: "CLOSED", lineItems: { nodes: [] } },
        { id: "fo3", status: "IN_PROGRESS", lineItems: { nodes: [] } },
      ]),
      fulfillmentCreate: {
        data: { fulfillmentCreate: { fulfillment: { id: "f9" }, userErrors: [] } },
      },
    });
    await expect(sender.pickedUp("s.myshopify.com", token, "1001")).resolves.toEqual({
      fulfilmentId: "f9",
    });
    expect(sent[1].query).toContain("fulfillmentCreate(fulfillment: $f)");
    expect(sent[1].variables).toEqual({
      f: {
        lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: "fo1" }, { fulfillmentOrderId: "fo3" }],
        notifyCustomer: false,
      },
    });
  });

  it("stops when nothing is left to hand over, the shop says no, or permission is missing", async () => {
    const done = scripted({
      "fulfillmentOrders(first: 10)": orders([
        { id: "fo1", status: "CLOSED", lineItems: { nodes: [] } },
      ]),
    });
    await expect(done.sender.pickedUp("s.myshopify.com", token, "1001")).rejects.toThrow(
      /nothing left/,
    );
    expect(done.sent).toHaveLength(1);
    const open1 = orders([{ id: "fo1", status: "OPEN", lineItems: { nodes: [] } }]);
    const refused = scripted({
      "fulfillmentOrders(first: 10)": open1,
      fulfillmentCreate: {
        data: {
          fulfillmentCreate: { fulfillment: null, userErrors: [{ message: "Not allowed yet" }] },
        },
      },
    });
    await expect(refused.sender.pickedUp("s.myshopify.com", token, "1001")).rejects.toThrow(
      /Not allowed yet/,
    );
    const denied = scripted({ "fulfillmentOrders(first: 10)": open1, fulfillmentCreate: DENIED });
    await expect(denied.sender.pickedUp("s.myshopify.com", token, "1001")).rejects.toBeInstanceOf(
      ShopPermissionError,
    );
  });
});

describe("adding tags to a shop order", () => {
  it("only adds, with the order's own id and each tag once", async () => {
    const { sender, sent } = scripted({
      tagsAdd: { data: { tagsAdd: { node: { id: "gid://shopify/Order/1001" }, userErrors: [] } } },
    });
    await sender.addTags("wild-thread.myshopify.com", token, "1001", [
      "ttw-oversold",
      " ttw-oversold ",
      "",
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0].query).toContain("tagsAdd(id: $id, tags: $tags)");
    expect(sent[0].query).not.toMatch(/orderUpdate|tagsRemove/);
    expect(sent[0].variables).toEqual({ id: "gid://shopify/Order/1001", tags: ["ttw-oversold"] });
  });

  it("asks nothing for no tags, and tells a refusal from a missing permission", async () => {
    const none = scripted({});
    await none.sender.addTags("wild-thread.myshopify.com", token, "1001", ["  "]);
    expect(none.sent).toHaveLength(0);

    const refused = scripted({
      tagsAdd: { data: { tagsAdd: { node: null, userErrors: [{ message: "Order not found" }] } } },
    });
    await expect(
      refused.sender.addTags("wild-thread.myshopify.com", token, "1001", ["x"]),
    ).rejects.toThrow("Order not found");

    const denied = scripted({ tagsAdd: DENIED });
    await expect(
      denied.sender.addTags("wild-thread.myshopify.com", token, "1001", ["x"]),
    ).rejects.toBeInstanceOf(ShopPermissionError);
  });
});
