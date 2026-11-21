import { randomBytes } from "node:crypto";
import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queued: { p_id: string; p_type: string }[] = [];
let queueError: { message: string } | null = null;

vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () => ({
    rpc: async (_fn: string, args: { p_id: string; p_type: string }) => {
      if (queueError) return { error: queueError };
      queued.push(args);
      return { error: null };
    },
  }),
}));

// Generated per run: nothing here is a real credential.
const webhookSecret = `whsec_${randomBytes(16).toString("hex")}`;
process.env.STRIPE_SECRET_KEY = `sk_test_${randomBytes(16).toString("hex")}`;
process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;

const { POST } = await import("./route");

const payload = JSON.stringify({
  id: "evt_test_1",
  object: "event",
  type: "customer.subscription.updated",
  data: { object: { id: "sub_1" } },
});

function sign(body: string, secret = webhookSecret) {
  return Stripe.webhooks.generateTestHeaderString({ payload: body, secret });
}

function post(body: string, signature?: string) {
  return POST(
    new Request("http://localhost/api/webhooks/stripe", {
      method: "POST",
      body,
      headers: signature ? { "stripe-signature": signature } : {},
    }),
  );
}

beforeEach(() => {
  queued.length = 0;
  queueError = null;
});

describe("Stripe webhook", () => {
  it("queues a correctly signed event and answers 200", async () => {
    const res = await post(payload, sign(payload));
    expect(res.status).toBe(200);
    expect(queued).toEqual([
      expect.objectContaining({ p_id: "evt_test_1", p_type: "customer.subscription.updated" }),
    ]);
  });

  it("rejects a missing, wrong or mismatched signature without queuing anything", async () => {
    expect((await post(payload)).status).toBe(400);
    expect((await post(payload, sign(payload, "whsec_someone_else"))).status).toBe(400);
    // Signed for a different body: the payload was altered in transit.
    const tampered = payload.replace("sub_1", "sub_2");
    expect((await post(tampered, sign(payload))).status).toBe(400);
    expect(queued).toHaveLength(0);
  });

  it("answers 5xx when the queue is down so Stripe retries", async () => {
    queueError = { message: "database unavailable" };
    const res = await post(payload, sign(payload));
    expect(res.status).toBe(500);
  });

  it("reports itself unavailable when billing isn't configured", async () => {
    const saved = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    try {
      expect((await post(payload, sign(payload))).status).toBe(503);
    } finally {
      process.env.STRIPE_WEBHOOK_SECRET = saved;
    }
  });
});
