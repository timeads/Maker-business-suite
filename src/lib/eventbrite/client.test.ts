import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EVENTBRITE_API, EventbriteError, createEventbriteClient } from "./client";

// Made up per run: nothing here is, or looks like, a real token.
const TOKEN = `test-${randomBytes(8).toString("hex")}`;

type Call = { url: string; method: string; headers: Record<string, string>; body: string | null };

function fakeFetch(replies: (Response | Error)[]) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? init.body : null,
    });
    const next = replies.shift();
    if (!next) throw new Error("no reply left");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const noSleep = async () => {};
const client = (replies: (Response | Error)[]) => {
  const fake = fakeFetch(replies);
  return {
    ...fake,
    eb: createEventbriteClient(
      { token: TOKEN },
      { fetchImpl: fake.impl, sleep: noSleep, minIntervalMs: 0 },
    ),
  };
};

describe("the Eventbrite client", () => {
  it("reads organizations with the token as a bearer header", async () => {
    const { eb, calls } = client([
      json(200, { organizations: [{ id: "123456", name: "Rug Studio" }, { id: "bad" }] }),
    ]);
    expect(await eb.organizations()).toEqual([{ id: "123456", name: "Rug Studio" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${EVENTBRITE_API}/users/me/organizations/`);
    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("lists live events with their ticket types, following continuation", async () => {
    const { eb, calls } = client([
      json(200, {
        events: [
          {
            id: "1001",
            name: { text: "Tufting night" },
            start: { utc: "2027-03-14T22:00:00Z" },
            ticket_classes: [{ id: "77", name: "General" }],
          },
        ],
        pagination: { has_more_items: true, continuation: "abc" },
      }),
      json(200, { events: [{ id: "1002", name: { text: "Punch needle" } }], pagination: {} }),
    ]);
    const events = await eb.listEvents("123456");
    expect(events.map((e) => e.id)).toEqual(["1001", "1002"]);
    expect(events[0]).toEqual({
      id: "1001",
      name: "Tufting night",
      startUtc: "2027-03-14T22:00:00Z",
      ticketClasses: [{ id: "77", name: "General" }],
    });
    expect(calls[0].url).toBe(
      `${EVENTBRITE_API}/organizations/123456/events/?status=live%2Cstarted&order_by=start_asc&expand=ticket_classes`,
    );
    expect(calls[1].url).toContain("continuation=abc");
  });

  it("sends a ticket change form-encoded with dotted keys, once", async () => {
    const { eb, calls } = client([json(200, {})]);
    await eb.updateTicketClass("1001", "77", { quantity_total: 12, hidden: false });
    expect(calls).toEqual([
      {
        url: `${EVENTBRITE_API}/events/1001/ticket_classes/77/`,
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Bearer ${TOKEN}`,
        }),
        body: "ticket_class.quantity_total=12&ticket_class.hidden=false",
      },
    ]);
  });

  it("tries a read again after a busy answer, but never a write", async () => {
    const read = client([
      json(503, {}),
      new Error("socket hang up"),
      json(200, { quantity_total: 10, quantity_sold: "3", hidden: false, name: "General" }),
    ]);
    expect(await read.eb.getTicketClass("1001", "77")).toEqual({
      id: "77",
      name: "General",
      quantityTotal: 10,
      quantitySold: 3,
      hidden: false,
    });
    expect(read.calls).toHaveLength(3);

    const busy = client([json(503, { error: "INTERNAL_ERROR" }), json(200, {})]);
    const err = await busy.eb.updateTicketClass("1001", "77", { hidden: true }).catch((e) => e);
    expect(err).toBeInstanceOf(EventbriteError);
    expect(err.applied).toBe("unknown");
    expect(busy.calls).toHaveLength(1);

    const lost = client([new Error("connection reset")]);
    const gone = await lost.eb.updateTicketClass("1001", "77", { hidden: true }).catch((e) => e);
    expect(gone.applied).toBe("unknown");
    expect(gone.words).toBe("We couldn't reach Eventbrite");
  });

  it("reports a clear no with Eventbrite's words, and never the token", async () => {
    const { eb } = client([
      json(400, { error: "INVALID", error_description: "quantity_total must be at least 1" }),
    ]);
    const err = await eb.updateTicketClass("1001", "77", { quantity_total: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(EventbriteError);
    expect(err.applied).toBe("no");
    expect(err.words).toBe("quantity_total must be at least 1");
    expect(err.code).toBe("INVALID");
    expect(String(err.message)).not.toContain(TOKEN);

    const auth = client([json(401, { error: "INVALID_AUTH" })]);
    const denied = await auth.eb.organizations().catch((e) => e);
    expect(denied.isAuthError).toBe(true);
  });

  it("gives up on a read after a few busy answers", async () => {
    const { eb, calls } = client([json(429, {}), json(429, {}), json(429, {}), json(429, {})]);
    await expect(eb.getOrder("555")).rejects.toBeInstanceOf(EventbriteError);
    expect(calls).toHaveLength(4);
  });

  it("puts only Eventbrite ids into an address", async () => {
    const { eb, calls } = client([json(200, { id: "555" })]);
    await expect(eb.getOrder("../users/me")).rejects.toThrow(/isn't an Eventbrite order id/);
    await expect(eb.getTicketClass("1001", "77?x=1")).rejects.toThrow(/ticket id/);
    expect(calls).toHaveLength(0);
    await eb.getOrder("555");
    expect(calls[0].url).toBe(`${EVENTBRITE_API}/orders/555/?expand=attendees`);
  });

  it("makes a webhook for the order actions and returns its id", async () => {
    const { eb, calls } = client([json(200, { id: "4242" }), json(200, { webhooks: [] })]);
    const endpoint = "https://app.example.com/api/webhooks/eventbrite/abc";
    expect(await eb.createWebhook("123456", endpoint, "order.placed,order.updated")).toBe("4242");
    expect(calls[0].url).toBe(`${EVENTBRITE_API}/organizations/123456/webhooks/`);
    expect(new URLSearchParams(calls[0].body ?? "").get("endpoint_url")).toBe(endpoint);
    expect(await eb.listWebhooks("123456")).toEqual([]);
  });

  it("makes its calls one at a time, with a gap between them", async () => {
    const waits: number[] = [];
    const fake = fakeFetch([json(200, { organizations: [] }), json(200, { organizations: [] })]);
    const eb = createEventbriteClient(
      { token: TOKEN },
      {
        fetchImpl: fake.impl,
        minIntervalMs: 1_000,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    await Promise.all([eb.organizations(), eb.organizations()]);
    expect(fake.calls).toHaveLength(2);
    expect(waits.length).toBe(1);
    expect(waits[0]).toBeGreaterThan(900);
  });
});
