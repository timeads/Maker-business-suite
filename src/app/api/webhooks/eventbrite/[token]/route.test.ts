import { createHash, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queued: Record<string, unknown>[] = [];
let answer: string = "queued";
let queueError: { message: string } | null = null;

vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () => ({
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      if (queueError) return { data: null, error: queueError };
      queued.push(args);
      return { data: answer, error: null };
    },
  }),
}));

// Generated per run: nothing here is a real credential.
process.env.SUPABASE_SECRET_KEY = randomBytes(16).toString("hex");
const token = randomBytes(32).toString("base64url");

const { POST } = await import("./route");

const post = (body: unknown, secret = token) =>
  POST(
    new Request(`http://localhost/api/webhooks/eventbrite/${secret}`, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ token: secret }) },
  );

const order = (action: string, url = "https://www.eventbriteapi.com/v3/orders/555/") => ({
  api_url: url,
  config: { action, webhook_id: "4242" },
});

beforeEach(() => {
  queued.length = 0;
  answer = "queued";
  queueError = null;
});

describe("Eventbrite's webhook", () => {
  it("queues only the order's number, under the secret's hash", async () => {
    const res = await post(order("order.placed"));
    expect(res.status).toBe(200);
    expect(queued).toEqual([
      {
        p_token_hash: createHash("sha256").update(token).digest("hex"),
        p_order_id: "555",
        p_refunded: false,
        p_webhook_id: "4242",
      },
    ]);
    await post(order("order.refunded"));
    expect(queued[1].p_refunded).toBe(true);
  });

  it("refuses an address the database doesn't know, and a malformed secret", async () => {
    answer = "unknown";
    expect((await post(order("order.placed"))).status).toBe(401);
    queued.length = 0;
    expect((await post(order("order.placed"), "short")).status).toBe(401);
    expect(queued).toEqual([]);
  });

  it("never takes an address outside Eventbrite's API", async () => {
    const res = await post(order("order.placed", "https://evil.example/v3/orders/555/"));
    expect(res.status).toBe(400);
    expect(queued).toEqual([]);
    expect((await post("not json")).status).toBe(400);
  });

  it("answers anything but an order without doing a thing", async () => {
    const res = await post({
      api_url: "https://www.eventbriteapi.com/v3/users/me/",
      config: { action: "test" },
    });
    expect(res.status).toBe(200);
    expect(queued).toEqual([]);
  });

  it("asks Eventbrite to send again when the queue can't be reached", async () => {
    queueError = { message: "down" };
    expect((await post(order("order.updated"))).status).toBe(500);
  });
});
