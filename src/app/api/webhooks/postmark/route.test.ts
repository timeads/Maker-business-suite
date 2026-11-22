import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queued: { p_id: string }[] = [];
let queueError: { message: string } | null = null;

vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () => ({
    rpc: async (_fn: string, args: { p_id: string }) => {
      if (queueError) return { error: queueError };
      queued.push(args);
      return { error: null };
    },
  }),
}));

// Generated per run: nothing here is a real credential.
const secret = randomBytes(16).toString("hex");
process.env.POSTMARK_INBOUND_SECRET = secret;
process.env.SUPABASE_SECRET_KEY = randomBytes(16).toString("hex");

const { POST } = await import("./route");

const basic = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

function post(body: string, authorization?: string) {
  return POST(
    new Request("http://localhost/api/webhooks/postmark", {
      method: "POST",
      body,
      headers: authorization ? { authorization } : {},
    }),
  );
}

const email = JSON.stringify({ MessageID: "pm-123", Subject: "Hello" });

beforeEach(() => {
  queued.length = 0;
  queueError = null;
});

describe("Postmark inbound webhook", () => {
  it("queues an email that arrives with the right secret", async () => {
    const res = await post(email, basic("postmark", secret));
    expect(res.status).toBe(200);
    expect(queued).toEqual([expect.objectContaining({ p_id: "pm-123" })]);
  });

  it("answers 401 without the secret, with a wrong one, or with the wrong username", async () => {
    expect((await post(email)).status).toBe(401);
    expect((await post(email, basic("postmark", "wrong"))).status).toBe(401);
    expect((await post(email, basic("someone", secret))).status).toBe(401);
    expect((await post(email, `Bearer ${secret}`)).status).toBe(401);
    expect(queued).toHaveLength(0);
  });

  it("rejects a body that isn't an email", async () => {
    expect((await post("not json", basic("postmark", secret))).status).toBe(400);
    expect((await post("{}", basic("postmark", secret))).status).toBe(400);
  });

  it("answers 5xx when the queue is down so Postmark retries", async () => {
    queueError = { message: "database unavailable" };
    expect((await post(email, basic("postmark", secret))).status).toBe(500);
  });
});
