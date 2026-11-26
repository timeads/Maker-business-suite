import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { shopOrderLinesFrom, type ShopifyOrder } from "../connections/providers/shopify-sync";
import type { ShopOrderLines } from "../connections/types";
import { needsDateWords, noteShopOrderLines } from "./undated";

const DATE = "11111111-1111-4111-8111-111111111111";

function fakeAdmin(noted: object, fail = false) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const admin = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === "note_shop_undated_lines") {
        return fail ? { data: null, error: { message: "down" } } : { data: noted, error: null };
      }
      if (fn === "tenant_owner_emails")
        return { data: [{ email: "owner@example.com" }], error: null };
      return { data: true, error: null };
    },
  } as unknown as SupabaseClient;
  return { admin, calls };
}

const orders: ShopOrderLines[] = [
  {
    external_id: "5001",
    name: "#1042",
    cancelled: false,
    lines: [{ line_id: "77", product_id: "9001", seats: 2, session_id: null }],
  },
];

describe("reading order lines for Bookings", () => {
  it("hands over every line with the date it carries, only when it looks like one", () => {
    const order = {
      legacyResourceId: "5001",
      name: "#1042",
      cancelledAt: null,
      lineItems: {
        nodes: [
          {
            id: "gid://shopify/LineItem/77",
            currentQuantity: 2,
            customAttributes: [],
            product: { legacyResourceId: "9001" },
          },
          {
            id: "gid://shopify/LineItem/78",
            currentQuantity: 1,
            customAttributes: [{ key: "Session ID", value: ` ${DATE.toUpperCase()} ` }],
            product: { legacyResourceId: "9001" },
          },
          {
            id: "gid://shopify/LineItem/79",
            currentQuantity: -1,
            customAttributes: [{ key: "Session ID", value: "soon" }],
            product: null,
          },
        ],
      },
    } as unknown as ShopifyOrder;
    expect(shopOrderLinesFrom([order])).toEqual([
      {
        external_id: "5001",
        name: "#1042",
        cancelled: false,
        lines: [
          { line_id: "77", product_id: "9001", seats: 2, session_id: null },
          { line_id: "78", product_id: "9001", seats: 1, session_id: DATE },
          { line_id: "79", product_id: null, seats: 0, session_id: null },
        ],
      },
    ]);
    expect(
      shopOrderLinesFrom([{ ...order, cancelledAt: "2026-11-01T00:00:00Z" } as ShopifyOrder])[0]
        .cancelled,
    ).toBe(true);
  });
});

describe("telling the team about an order with no date", () => {
  const fresh = { order_name: "#1042", service_name: "Rug Tufting", seats: 2 };

  it("says nothing when the database found nothing new", async () => {
    const { admin, calls } = fakeAdmin({ new: [], cancelled: [], known: 1 });
    const alerts: string[] = [];
    await noteShopOrderLines(admin, "t1", "shopify", orders, {
      open: async () => true,
      alert: async (_a, _t, _app, text) => void alerts.push(text),
    });
    expect(calls.map((c) => c.fn)).toEqual(["note_shop_undated_lines"]);
    expect(calls[0].args).toMatchObject({
      p_tenant_id: "t1",
      p_provider: "shopify",
      p_orders: [{ order_id: "5001", name: "#1042", cancelled: false, lines: orders[0].lines }],
    });
    expect(alerts).toEqual([]);
  });

  it("posts a heads-up and emails the owners once per new line", async () => {
    const { admin } = fakeAdmin({ new: [fresh], cancelled: [], known: 0 });
    const alerts: string[] = [];
    const mail: { to: string; subject: string; text: string }[] = [];
    await noteShopOrderLines(admin, "t1", "shopify", orders, {
      open: async () => true,
      alert: async (_a, _t, app, text) => void alerts.push(`${app}: ${text}`),
      mail: async (m) => (mail.push(m), true),
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("bookings: Order #1042 paid for Rug Tufting (2 places)");
    expect(alerts[0]).toContain("Needs a date");
    expect(mail.map((m) => m.to)).toEqual(["owner@example.com"]);
    expect(mail[0].subject).toBe("Needs a date: order #1042");
    expect(mail[0].text).toContain("Buy again");
  });

  it("off the plan the line is still written down and the heads-up posted, but no email goes", async () => {
    const { admin, calls } = fakeAdmin({ new: [fresh], cancelled: ["b9"], known: 0 });
    const alerts: string[] = [];
    let mailed = 0;
    await noteShopOrderLines(admin, "t1", "shopify", orders, {
      open: async () => false,
      alert: async (_a, _t, _app, text) => void alerts.push(text),
      mail: async () => ((mailed += 1), true),
    });
    expect(alerts).toHaveLength(1);
    expect(mailed).toBe(0);
    expect(calls.some((c) => c.fn === "queue_booking_cancel_email")).toBe(false);
  });

  it("queues the cancellation email when a refund cancels a booking made from one", async () => {
    const { admin, calls } = fakeAdmin({ new: [], cancelled: ["b9"], known: 1 });
    await noteShopOrderLines(admin, "t1", "shopify", orders, { open: async () => true });
    expect(calls.map((c) => c.fn)).toEqual([
      "note_shop_undated_lines",
      "queue_booking_cancel_email",
      "queue_booking_text",
    ]);
    expect(calls[1].args).toEqual({ p_tenant_id: "t1", p_booking_id: "b9" });
  });

  it("an email that fails doesn't stop the sync, but a database that can't write it down does", async () => {
    const ok = fakeAdmin({ new: [fresh], cancelled: [], known: 0 });
    await expect(
      noteShopOrderLines(ok.admin, "t1", "shopify", orders, {
        open: async () => true,
        alert: async () => {},
        mail: async () => {
          throw new Error("mail is down");
        },
      }),
    ).resolves.toBeUndefined();
    // Thrown so the sync job is tried again: a paid line must not slip by unrecorded.
    await expect(
      noteShopOrderLines(fakeAdmin({}, true).admin, "t1", "shopify", orders),
    ).rejects.toThrow(/note_shop_undated_lines/);
  });

  it("tags an order with no date once, and leaves a date we couldn't find to the booking step", async () => {
    const tagged: string[] = [];
    const tag = async (_a: unknown, _t: string, o: { id: string; name: string }, why: string) =>
      void tagged.push(`${o.id} ${why}`);
    const both: ShopOrderLines[] = [
      ...orders,
      {
        external_id: "5002",
        name: "#1043",
        cancelled: false,
        lines: [{ line_id: "80", product_id: "9001", seats: 1, session_id: DATE }],
      },
    ];
    const { admin } = fakeAdmin({
      new: [
        { ...fresh, order_id: "5001" },
        { ...fresh, order_id: "5001" },
        { ...fresh, order_id: "5002", order_name: "#1043" },
      ],
      cancelled: [],
      known: 0,
    });
    await noteShopOrderLines(admin, "t1", "shopify", both, {
      open: async () => false,
      alert: async () => undefined,
      tag,
    });
    expect(tagged).toEqual(["5001 needs_date"]);
  });

  it("has plain words when the order names no workshop", () => {
    expect(needsDateWords({ order_name: "", service_name: null, seats: 1 })).toContain(
      "Order from your shop paid for a workshop (1 place)",
    );
  });
});
