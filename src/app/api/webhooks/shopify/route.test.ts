import { createHmac, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Queued = {
  p_provider: string;
  p_external_account_id: string;
  p_topic: string;
  p_dedupe_key: string;
};
const queued: Queued[] = [];
let queueResult: { data: string | null; error: { message: string } | null } = {
  data: "queued",
  error: null,
};

vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () => ({
    rpc: async (_fn: string, args: Queued) => {
      if (!queueResult.error) queued.push(args);
      return queueResult;
    },
  }),
}));

// Generated per run: nothing here is a real credential.
const secret = randomBytes(16).toString("hex");
process.env.SHOPIFY_CLIENT_SECRET = secret;
process.env.SUPABASE_SECRET_KEY = randomBytes(16).toString("hex");

const { POST } = await import("./route");

const body = JSON.stringify({ id: 820982911946154500, email: "jon@example.com" });
const sign = (payload: string, key = secret) =>
  createHmac("sha256", key).update(payload, "utf8").digest("base64");

function post(payload: string, headers: Record<string, string>) {
  return POST(
    new Request("http://localhost/api/webhooks/shopify", {
      method: "POST",
      body: payload,
      headers,
    }),
  );
}

const goodHeaders = (payload = body) => ({
  "x-shopify-hmac-sha256": sign(payload),
  "x-shopify-topic": "orders/create",
  "x-shopify-shop-domain": "Wild-Thread.myshopify.com",
  "x-shopify-webhook-id": "b54557e4-bdd9-4b37-8a5f-bf7d70bcd043",
});

beforeEach(() => {
  queued.length = 0;
  queueResult = { data: "queued", error: null };
});

describe("Shopify webhook", () => {
  it("queues a signed delivery under its delivery id and store", async () => {
    const res = await post(body, goodHeaders());
    expect(res.status).toBe(200);
    expect(queued).toEqual([
      expect.objectContaining({
        p_provider: "shopify",
        p_external_account_id: "wild-thread.myshopify.com",
        p_topic: "orders/create",
        p_dedupe_key: "b54557e4-bdd9-4b37-8a5f-bf7d70bcd043",
      }),
    ]);
  });

  it("answers 401 to a missing, wrong or mismatched signature and queues nothing", async () => {
    const { "x-shopify-hmac-sha256": _omit, ...unsigned } = goodHeaders();
    expect((await post(body, unsigned)).status).toBe(401);
    expect(
      (await post(body, { ...goodHeaders(), "x-shopify-hmac-sha256": sign(body, "someone-else") }))
        .status,
    ).toBe(401);
    // Signature is for a different body.
    expect((await post(body.replace("jon", "eve"), goodHeaders())).status).toBe(401);
    expect(queued).toHaveLength(0);
  });

  it("accepts privacy requests for stores it doesn't know", async () => {
    queueResult = { data: "unknown_account", error: null };
    const res = await post(body, { ...goodHeaders(), "x-shopify-topic": "customers/redact" });
    expect(res.status).toBe(200);
  });

  it("answers 200 to a redelivery so Shopify stops retrying", async () => {
    queueResult = { data: "duplicate", error: null };
    expect((await post(body, goodHeaders())).status).toBe(200);
  });

  it("rejects a signed delivery that is missing its headers or isn't JSON", async () => {
    const { "x-shopify-webhook-id": _omit, ...noId } = goodHeaders();
    expect((await post(body, noId)).status).toBe(400);
    expect((await post("not json", goodHeaders("not json"))).status).toBe(400);
  });

  it("answers 5xx when the queue is down so Shopify retries", async () => {
    queueResult = { data: null, error: { message: "database unavailable" } };
    expect((await post(body, goodHeaders())).status).toBe(500);
  });
});
