import { describe, expect, it } from "vitest";
import {
  shopBookingsFrom,
  textConsentOf,
  type ShopifyOrder,
} from "../connections/providers/shopify-sync";
import type { ShopBookingOrder } from "../connections/types";
import { applyShopOrders } from "./shop";

const DATE_A = "11111111-1111-4111-8111-111111111111";
const DATE_B = "22222222-2222-4222-8222-222222222222";
const price = (amount: string) => ({ shopMoney: { amount } });

function order(lines: object[], more: Partial<ShopifyOrder> = {}): ShopifyOrder {
  return {
    legacyResourceId: "5001",
    name: "#1042",
    email: "sam@example.com",
    cancelledAt: null,
    customer: { legacyResourceId: "9", firstName: "Sam", lastName: "Shopper" },
    lineItems: { nodes: lines },
    ...more,
  } as unknown as ShopifyOrder;
}
const line = (sessionId: string | null, qty: number, unit = "90.00", key = "Session ID") => ({
  id: "gid://shopify/LineItem/1",
  currentQuantity: qty,
  discountedUnitPriceAfterAllDiscountsSet: price(unit),
  customAttributes: sessionId === null ? [] : [{ key, value: sessionId }],
});

describe("finding workshop dates on shop orders", () => {
  it("reads the date from the cart line and adds lines for the same date together", () => {
    const found = shopBookingsFrom([
      order([
        line(DATE_A, 2),
        line(DATE_A.toUpperCase(), 1),
        line(DATE_B, 1, "45.50"),
        line(null, 3),
        line("not-a-date", 1),
        line(DATE_A, 1, "90.00", "session id"),
      ]),
    ]);
    expect(found).toEqual([
      {
        external_id: "5001",
        name: "#1042",
        cancelled: false,
        customer_name: "Sam Shopper",
        email: "sam@example.com",
        lines: [
          { session_id: DATE_A, seats: 3, amount_cents: 27000 },
          { session_id: DATE_B, seats: 1, amount_cents: 4550 },
        ],
      },
    ]);
  });

  it("ignores ordinary orders, and keeps refunded and cancelled ones so seats come back", () => {
    expect(shopBookingsFrom([order([line(null, 1)])])).toEqual([]);
    expect(shopBookingsFrom([order([line(DATE_A, 0)])])[0].lines[0].seats).toBe(0);
    expect(
      shopBookingsFrom([order([line(DATE_A, 1)], { cancelledAt: "2026-11-01T00:00:00Z" })])[0]
        .cancelled,
    ).toBe(true);
  });
});

describe("text consent on the cart line", () => {
  const withText = (sessionId: string, qty: number, extra: { key: string; value: string }[]) => ({
    ...line(sessionId, qty),
    customAttributes: [{ key: "Session ID", value: sessionId }, ...extra],
  });

  it("reads the picker's number and tick, and the earlier app's, and only a ticked box agrees", () => {
    expect(textConsentOf([{ key: "_text_phone", value: " 215 555 0134 " }])).toEqual({
      phone: "215 555 0134",
      agreed: false,
    });
    expect(
      textConsentOf([
        { key: "_ttw_sms_phone", value: "2155550134" },
        { key: "_ttw_sms_consent", value: "yes" },
      ]),
    ).toEqual({ phone: "2155550134", agreed: true });
    expect(textConsentOf([{ key: "_text_consent", value: "yes" }])).toBeNull();
    expect(textConsentOf(null)).toBeNull();
  });

  it("travels with the booking, and a tick on any line for the date counts", () => {
    const [found] = shopBookingsFrom([
      order([
        withText(DATE_A, 1, [{ key: "_text_phone", value: "2155550134" }]),
        withText(DATE_A, 1, [
          { key: "_text_phone", value: "2155550199" },
          { key: "_text_consent", value: "yes" },
        ]),
        line(DATE_B, 1),
      ]),
    ]);
    expect(found.lines).toEqual([
      {
        session_id: DATE_A,
        seats: 2,
        amount_cents: 18000,
        text: { phone: "2155550199", agreed: true },
      },
      { session_id: DATE_B, seats: 1, amount_cents: 9000 },
    ]);
  });

  it("puts the consent on the booking before the confirmation goes", async () => {
    const calls: string[] = [];
    const admin = {
      rpc: async (fn: string) => {
        calls.push(fn);
        return {
          data: fn === "book_from_shop" ? { result: "booked", booking_id: "b1" } : null,
          error: null,
        };
      },
    } as never;
    await applyShopOrders(
      admin,
      "t1",
      [
        {
          external_id: "5001",
          name: "#1042",
          cancelled: false,
          customer_name: "Sam",
          email: "sam@example.com",
          lines: [
            {
              session_id: DATE_A,
              seats: 1,
              amount_cents: 0,
              text: { phone: "2155550134", agreed: true },
            },
          ],
        },
      ],
      {
        open: async () => true,
        details: async () => ({ tenant_id: "t1" }) as never,
        announce: async () => void calls.push("announce"),
      },
    );
    expect(calls).toEqual(["book_from_shop", "set_booking_text_consent", "announce"]);
  });
});

describe("turning shop orders into bookings", () => {
  const dated: ShopBookingOrder = {
    external_id: "5001",
    name: "#1042",
    cancelled: false,
    customer_name: "Sam Shopper",
    email: "sam@example.com",
    lines: [{ session_id: DATE_A, seats: 2, amount_cents: 18000 }],
  };
  function fakeAdmin(answers: Record<string, unknown>) {
    const calls: { fn: string; args: Record<string, unknown> }[] = [];
    return {
      calls,
      admin: {
        rpc: async (fn: string, args: Record<string, unknown>) => {
          calls.push({ fn, args });
          return { data: answers[fn] ?? null, error: null };
        },
      } as never,
    };
  }
  const details = { tenant_id: "t1", customer_name: "Sam Shopper" } as never;

  it("books each date and tells the shopper once, with their own link", async () => {
    const { admin, calls } = fakeAdmin({
      book_from_shop: { result: "booked", booking_id: "b1", oversold: false },
    });
    const told: string[] = [];
    await applyShopOrders(admin, "t1", [dated], {
      open: async () => true,
      details: async () => details,
      announce: async (_d, token) => void told.push(token),
    });
    const booked = calls.find((c) => c.fn === "book_from_shop")!;
    expect(booked.args).toMatchObject({
      p_tenant_id: "t1",
      p_session_id: DATE_A,
      p_order_id: "5001",
      p_seats: 2,
      p_amount_cents: 18000,
    });
    expect(told).toEqual([booked.args.p_manage_token]);
    expect(String(told[0]).length).toBeGreaterThan(20);
  });

  it("tags the order in the shop at the moments the earlier app did", async () => {
    const tagged: string[] = [];
    const tag = async (_a: unknown, _t: string, o: { id: string; name: string }, why: string) =>
      void tagged.push(`${o.id} ${o.name} ${why}`);
    const run = async (answer: object) =>
      applyShopOrders(fakeAdmin({ book_from_shop: answer }).admin, "t1", [dated], {
        open: async () => false,
        tag,
      });
    await run({ result: "booked", booking_id: "b1", oversold: true });
    await run({ result: "booked", booking_id: "b1", oversold: true, date_cancelled: true });
    await run({ result: "no_session" });
    await run({ result: "booked", booking_id: "b1", oversold: false });
    await run({ result: "unchanged", booking_id: "b1", oversold: true });
    await run({ result: "clash", booking_id: "b1" });
    expect(tagged).toEqual([
      "5001 #1042 oversold",
      "5001 #1042 booking_error",
      "5001 #1042 booking_error",
      "5001 #1042 booking_error",
    ]);
  });

  it("sends nothing and tags nothing for an order from the shop's history", async () => {
    const { admin, calls } = fakeAdmin({
      book_from_shop: { result: "recorded", booking_id: "b1", oversold: true },
    });
    const tagged: string[] = [];
    let told = 0;
    await applyShopOrders(admin, "t1", [dated], {
      open: async () => true,
      details: async () => details,
      announce: async () => void (told += 1),
      tag: async (_a, _t, _o, why) => void tagged.push(why),
    });
    expect(told).toBe(0);
    expect(tagged).toEqual([]);
    expect(calls.map((c) => c.fn)).toEqual(["book_from_shop"]);
  });

  it("says nothing when the shop repeats an order it has already told us about", async () => {
    const { admin } = fakeAdmin({ book_from_shop: { result: "unchanged", booking_id: "b1" } });
    let told = 0;
    await applyShopOrders(admin, "t1", [dated, dated], {
      open: async () => true,
      details: async () => details,
      announce: async () => void (told += 1),
    });
    expect(told).toBe(0);
  });

  it("cancels the bookings of a cancelled order without booking anything, and queues the email for each", async () => {
    const { admin, calls } = fakeAdmin({ cancel_shop_order_bookings: ["b1", "b2"] });
    await applyShopOrders(admin, "t1", [{ ...dated, cancelled: true }], { open: async () => true });
    // The email, and the text where the workspace sends one, for each.
    expect(calls.map((c) => c.fn)).toEqual([
      "cancel_shop_order_bookings",
      "queue_booking_cancel_email",
      "queue_booking_text",
      "queue_booking_cancel_email",
      "queue_booking_text",
    ]);
    expect(calls[3].args).toEqual({ p_tenant_id: "t1", p_booking_id: "b2" });
    expect(calls[4].args).toEqual({ p_tenant_id: "t1", p_booking_id: "b2", p_kind: "cancelled" });
  });

  it("queues the email when a refund takes a booking's last place, but not off the plan", async () => {
    const refunded = { book_from_shop: { result: "cancelled", booking_id: "b1" } };
    const on = fakeAdmin(refunded);
    await applyShopOrders(on.admin, "t1", [dated], { open: async () => true });
    expect(on.calls.map((c) => c.fn)).toEqual([
      "book_from_shop",
      "queue_booking_cancel_email",
      "queue_booking_text",
    ]);
    const off = fakeAdmin(refunded);
    await applyShopOrders(off.admin, "t1", [dated], { open: async () => false });
    expect(off.calls.map((c) => c.fn)).toEqual(["book_from_shop"]);
  });

  it("still books when bookings isn't on the plan, but sends no email", async () => {
    const { admin, calls } = fakeAdmin({ book_from_shop: { result: "booked", booking_id: "b1" } });
    let told = 0;
    await applyShopOrders(admin, "t1", [dated], {
      open: async () => false,
      details: async () => details,
      announce: async () => void (told += 1),
    });
    expect(calls.some((c) => c.fn === "book_from_shop")).toBe(true);
    expect(told).toBe(0);
  });

  it("a failed email never undoes the booking or stops the sync", async () => {
    const { admin } = fakeAdmin({ book_from_shop: { result: "booked", booking_id: "b1" } });
    await expect(
      applyShopOrders(admin, "t1", [dated], {
        open: async () => true,
        details: async () => details,
        announce: async () => {
          throw new Error("mail is down");
        },
      }),
    ).resolves.toBeUndefined();
  });
});
