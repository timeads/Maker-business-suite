import { describe, expect, it } from "vitest";
import {
  isLiveAttendee,
  isReleaseOrder,
  orderIdFromApiUrl,
  orderToBooking,
  parseWebhookBody,
  type EventbriteOrder,
} from "./orders";

// Ported from the earlier booking app's parse_test.ts, with the api_url now
// read for its order number only.
describe("Eventbrite webhook bodies", () => {
  it("pull the order number, the action and the webhook's id", () => {
    expect(
      parseWebhookBody({
        api_url: "https://www.eventbriteapi.com/v3/orders/123/",
        config: { action: "order.placed", webhook_id: "4242" },
      }),
    ).toEqual({ orderId: "123", action: "order.placed", webhookId: "4242" });
    expect(parseWebhookBody({})).toBeNull();
    expect(parseWebhookBody(null)).toBeNull();
    expect(parseWebhookBody({ api_url: "https://x/", config: {} })).toEqual({
      orderId: null,
      action: "",
      webhookId: null,
    });
  });

  it("take an order number only from Eventbrite's API host", () => {
    expect(orderIdFromApiUrl("https://www.eventbriteapi.com/v3/orders/1/")).toBe("1");
    expect(orderIdFromApiUrl("https://eventbriteapi.com/v3/orders/22")).toBe("22");
    expect(orderIdFromApiUrl("https://www.eventbrite.com/v3/orders/1/")).toBeNull();
    expect(orderIdFromApiUrl("https://evil.example/v3/orders/1/")).toBeNull();
    expect(orderIdFromApiUrl("http://www.eventbriteapi.com/v3/orders/1/")).toBeNull();
    expect(orderIdFromApiUrl("https://www.eventbriteapi.com/v3/users/me/")).toBeNull();
    expect(orderIdFromApiUrl("https://www.eventbriteapi.com/v3/orders/1/../../users")).toBeNull();
    expect(orderIdFromApiUrl("not a url")).toBeNull();
  });
});

describe("Eventbrite orders as bookings", () => {
  it("count attendees who aren't cancelled, refunded or deleted", () => {
    expect(isLiveAttendee({ status: "Attending" })).toBe(true);
    expect(isLiveAttendee({ cancelled: true })).toBe(false);
    expect(isLiveAttendee({ refunded: true })).toBe(false);
    expect(isLiveAttendee({ status: "Deleted" })).toBe(false);
  });

  it("count live attendees and pick a phone", () => {
    const order: EventbriteOrder = {
      id: 555,
      event_id: "9",
      email: "Jo@X.co",
      name: "Jo Ng",
      attendees: [
        { profile: { cell_phone: "  " } },
        { profile: { cell_phone: "215-555-0100" } },
        { cancelled: true, profile: { cell_phone: "999" } },
      ],
    };
    expect(orderToBooking(order)).toEqual({
      orderId: "555",
      eventId: "9",
      name: "Jo Ng",
      email: "jo@x.co",
      phone: "215-555-0100",
      seats: 2,
    });
  });

  it("fall back to first and last name, then email; at least one place", () => {
    const b = orderToBooking({
      id: 1,
      event_id: "e",
      email: "k@x.co",
      first_name: "K",
      last_name: "Lee",
      attendees: [],
    });
    expect(b.name).toBe("K Lee");
    expect(b.seats).toBe(1);
    expect(b.phone).toBe("");
    expect(orderToBooking({ id: 2, event_id: "e", email: "z@x.co" }).name).toBe("z@x.co");
    expect(orderToBooking({ id: 3 }).eventId).toBeNull();
  });

  it("give every place back for refunds and fully cancelled orders", () => {
    expect(isReleaseOrder({ id: 1 }, true)).toBe(true);
    expect(isReleaseOrder({ id: 1, status: "refunded" }, false)).toBe(true);
    expect(isReleaseOrder({ id: 1, status: "deleted" }, false)).toBe(true);
    expect(
      isReleaseOrder(
        { id: 1, status: "placed", attendees: [{ cancelled: true }, { refunded: true }] },
        false,
      ),
    ).toBe(true);
    expect(
      isReleaseOrder({ id: 1, status: "placed", attendees: [{ status: "Attending" }] }, false),
    ).toBe(false);
    expect(isReleaseOrder({ id: 1, status: "placed" }, false)).toBe(false);
  });
});
