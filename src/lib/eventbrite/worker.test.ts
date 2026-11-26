import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { EventbriteError, type EventbriteClient } from "./client";
import { createHash } from "node:crypto";
import { hookEndpoint, hookTokenHash, isHookToken, newHookToken, tokensAtSite } from "./hook";
import {
  drainEventbriteOrders,
  drainEventbritePushes,
  pushSeats,
  type ClaimedPush,
} from "./worker";

vi.mock("../bookings/server", () => ({ announceBooking: vi.fn(), getBookingDetails: vi.fn() }));
vi.mock("../bookings/shop", () => ({ queueCancelEmails: vi.fn() }));
vi.mock("../messages/alerts", () => ({ postAlert: vi.fn() }));
vi.mock("../module-access", () => ({ featureOpen: vi.fn(async () => true) }));

const push = (over: Partial<ClaimedPush> = {}): ClaimedPush => ({
  id: "p1",
  tenant_id: "t1",
  session_id: "s1",
  event_id: "1001",
  ticket_class_id: "77",
  event_name: "Rug night",
  tries: 1,
  seats_left: 4,
  ...over,
});

function fakeClient(
  over: Partial<EventbriteClient> = {},
): EventbriteClient & { writes: unknown[] } {
  const writes: unknown[] = [];
  return {
    writes,
    organizations: async () => [],
    listEvents: async () => [],
    getTicketClass: async (_e, t) => ({
      id: t,
      name: "General",
      quantityTotal: 10,
      quantitySold: 3,
      hidden: false,
    }),
    updateTicketClass: async (_e, _t, change) => {
      writes.push(change);
    },
    getOrder: async () => {
      throw new Error("not set");
    },
    listWebhooks: async () => [],
    createWebhook: async () => "1",
    ...over,
  };
}

function fakeAdmin(replies: Record<string, unknown>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const admin = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: replies[fn] ?? null, error: null };
    },
  } as unknown as SupabaseClient;
  return { admin, calls };
}

const err = (status: number, applied: "no" | "unknown", words = "nope") =>
  new EventbriteError(`Eventbrite: ${status}`, status, "X", words, applied);

describe("one push", () => {
  it("reads first and changes only what differs", async () => {
    const client = fakeClient();
    expect(await pushSeats(push(), client)).toEqual({
      outcome: "done",
      detail: "",
      total: 7,
      sold: 3,
      hidden: false,
    });
    expect(client.writes).toEqual([{ quantity_total: 7 }]);
    const same = fakeClient();
    await pushSeats(push({ seats_left: 7 }), same);
    expect(same.writes).toEqual([]);
  });

  it("is refused when the read fails, so nothing was written", async () => {
    const client = fakeClient({
      getTicketClass: async () => {
        throw err(404, "no");
      },
    });
    const result = await pushSeats(push(), client);
    expect(result.outcome).toBe("refused");
    expect(result.detail).toMatch(/no such ticket type/);
    expect(client.writes).toEqual([]);
  });

  it("tells a clear no from an unclear answer", async () => {
    const no = await pushSeats(
      push(),
      fakeClient({
        updateTicketClass: async () => {
          throw err(400, "no", "quantity too low");
        },
      }),
    );
    expect(no).toMatchObject({
      outcome: "refused",
      detail: "Eventbrite said no: quantity too low",
    });
    const unclear = await pushSeats(
      push(),
      fakeClient({
        updateTicketClass: async () => {
          throw err(502, "unknown");
        },
      }),
    );
    expect(unclear.outcome).toBe("unsure");
  });
});

describe("the push queue", () => {
  it("writes down every push, and tells the team about an unclear one", async () => {
    const { admin, calls } = fakeAdmin({
      claim_eventbrite_pushes: [push(), push({ id: "p2", tries: 3 })],
    });
    const alert = vi.fn();
    let n = 0;
    const client = fakeClient({
      updateTicketClass: async () => {
        n += 1;
        throw n === 1 ? err(504, "unknown") : err(400, "no");
      },
    });
    const handled = await drainEventbritePushes(admin, {
      access: async () => ({ connectionId: "c", token: "t", organizationId: "1" }),
      client: () => client,
      open: async () => true,
      alert,
    });
    expect(handled).toBe(2);
    const finishes = calls.filter((c) => c.fn === "finish_eventbrite_push");
    expect(finishes.map((c) => [c.args.p_id, c.args.p_outcome])).toEqual([
      ["p1", "unsure"],
      ["p2", "refused"],
    ]);
    // Unsure always, a refusal once it has had its tries.
    expect(alert).toHaveBeenCalledTimes(2);
  });

  it("asks nothing of Eventbrite for a workspace whose plan has closed", async () => {
    const { admin, calls } = fakeAdmin({ claim_eventbrite_pushes: [push()] });
    const client = fakeClient();
    await drainEventbritePushes(admin, {
      access: async () => ({ connectionId: "c", token: "t", organizationId: "1" }),
      client: () => client,
      open: async () => false,
      alert: vi.fn(),
    });
    expect(client.writes).toEqual([]);
    expect(calls.find((c) => c.fn === "finish_eventbrite_push")?.args.p_outcome).toBe("refused");
  });
});

describe("the order queue", () => {
  const deps = (client: EventbriteClient, alert = vi.fn()) => ({
    access: async () => ({ connectionId: "c", token: "t", organizationId: "1" }),
    client: () => client,
    open: async () => true,
    alert,
  });

  it("reads each order from Eventbrite and books its live attendees", async () => {
    const { admin, calls } = fakeAdmin({
      claim_eventbrite_events: [
        { id: "e1", tenant_id: "t1", order_id: "555", refunded: false, tries: 1 },
      ],
      book_from_eventbrite: { result: "unchanged", booking_id: "b1" },
    });
    const client = fakeClient({
      getOrder: async () => ({
        id: 555,
        event_id: "1001",
        email: "jo@x.co",
        name: "Jo",
        attendees: [{ status: "Attending" }, { refunded: true }],
      }),
    });
    await drainEventbriteOrders(admin, deps(client));
    const book = calls.find((c) => c.fn === "book_from_eventbrite");
    expect(book?.args).toMatchObject({
      p_tenant_id: "t1",
      p_event_id: "1001",
      p_order_id: "555",
      p_seats: 1,
      p_email: "jo@x.co",
    });
    expect(calls.find((c) => c.fn === "finish_eventbrite_event")?.args).toMatchObject({
      p_outcome: "done",
      p_detail: "unchanged",
    });
  });

  it("gives every place back on a refund nudge", async () => {
    const { admin, calls } = fakeAdmin({
      claim_eventbrite_events: [
        { id: "e1", tenant_id: "t1", order_id: "555", refunded: true, tries: 1 },
      ],
      book_from_eventbrite: { result: "cancelled", booking_id: "b1", cancelled: ["b1"] },
    });
    const client = fakeClient({ getOrder: async () => ({ id: "555", event_id: "1001" }) });
    await drainEventbriteOrders(admin, deps(client));
    expect(calls.find((c) => c.fn === "book_from_eventbrite")?.args.p_seats).toBe(0);
  });

  it("tries again later when Eventbrite can't be read, and drops an order it no longer has", async () => {
    const { admin, calls } = fakeAdmin({
      claim_eventbrite_events: [
        { id: "e1", tenant_id: "t1", order_id: "1", refunded: false, tries: 1 },
        { id: "e2", tenant_id: "t1", order_id: "2", refunded: false, tries: 1 },
      ],
    });
    const client = fakeClient({
      getOrder: async (id) => {
        throw id === "1" ? err(503, "unknown", "busy") : err(404, "no");
      },
    });
    await drainEventbriteOrders(admin, deps(client));
    const finishes = calls.filter((c) => c.fn === "finish_eventbrite_event").map((c) => c.args);
    expect(finishes).toEqual([
      { p_id: "e1", p_outcome: "retry", p_detail: "busy" },
      { p_id: "e2", p_outcome: "done", p_detail: "gone" },
    ]);
    expect(calls.some((c) => c.fn === "book_from_eventbrite")).toBe(false);
  });

  it("tells the team about a refund for an order that is on no date", async () => {
    const alert = vi.fn();
    const { admin } = fakeAdmin({
      claim_eventbrite_events: [
        { id: "e1", tenant_id: "t1", order_id: "8", refunded: true, tries: 1 },
      ],
      book_from_eventbrite: { result: "nothing" },
    });
    const client = fakeClient({ getOrder: async () => ({ id: "8", event_id: "9" }) });
    await drainEventbriteOrders(admin, deps(client, alert));
    expect(alert.mock.calls[0][3]).toMatch(/order 8 was refunded or cancelled/);
  });

  it("tells the team about an order for an unlinked event, and one given up on", async () => {
    const alert = vi.fn();
    const { admin } = fakeAdmin({
      claim_eventbrite_events: [
        { id: "e1", tenant_id: "t1", order_id: "1", refunded: false, tries: 1 },
        { id: "e2", tenant_id: "t1", order_id: "2", refunded: false, tries: 7 },
      ],
      book_from_eventbrite: { result: "no_listing" },
    });
    const client = fakeClient({ getOrder: async () => ({ id: "1", event_id: "9" }) });
    await drainEventbriteOrders(admin, deps(client, alert));
    expect(alert).toHaveBeenCalledTimes(2);
    expect(alert.mock.calls.map((c) => c[3])).toEqual([
      expect.stringMatching(/order 1 is for an event that isn't linked/),
      expect.stringMatching(/couldn't read Eventbrite order 2/),
    ]);
  });
});

describe("the webhook's secret", () => {
  it("is long, random, and only its hash is kept", () => {
    const a = newHookToken();
    expect(isHookToken(a)).toBe(true);
    expect(a).not.toBe(newHookToken());
    expect(hookTokenHash(a)).toBe(createHash("sha256").update(a).digest("hex"));
    expect(isHookToken("short")).toBe(false);
    expect(isHookToken("../../etc/passwd-and-some-more-words-to-pad")).toBe(false);
  });

  it("is found in Eventbrite's list only at this site", () => {
    const a = newHookToken();
    const site = "https://app.example.com/";
    const endpoint = hookEndpoint(site, a);
    expect(endpoint).toBe(`https://app.example.com/api/webhooks/eventbrite/${a}`);
    expect(
      tokensAtSite(site, [endpoint, `https://other.example/api/webhooks/eventbrite/${a}`, "nope"]),
    ).toEqual([a]);
  });
});
