import { createHash, createHmac, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { fn: string; args: Record<string, unknown> }[] = [];
let rpcError: { message: string } | null = null;
let deletionStatus: string | null = null;

vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (rpcError) return { data: null, error: rpcError };
      calls.push({ fn, args });
      return { data: fn === "meta_deletion_status" ? deletionStatus : "queued", error: null };
    },
  }),
}));
vi.mock("@/lib/site-url", () => ({ getSiteUrl: async () => "https://suite.test" }));

// Generated per run: nothing here is a real credential.
const appSecret = randomBytes(16).toString("hex");
const verifyToken = randomBytes(16).toString("hex");
process.env.META_APP_SECRET = appSecret;
process.env.META_WEBHOOK_VERIFY_TOKEN = verifyToken;
process.env.SUPABASE_SECRET_KEY = randomBytes(16).toString("hex");

const { GET, POST } = await import("./route");
const deletion = await import("./deletion/route");

const sign = (body: string, key = appSecret) =>
  `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
const post = (body: string, signature?: string) =>
  POST(
    new Request("http://localhost/api/webhooks/meta", {
      method: "POST",
      body,
      headers: signature ? { "x-hub-signature-256": signature } : {},
    }),
  );
const delivery = JSON.stringify({
  object: "instagram",
  entry: [{ id: "1784000000000002", time: 1, messaging: [] }],
});

beforeEach(() => {
  calls.length = 0;
  rpcError = null;
  deletionStatus = null;
});

describe("Meta's check of the webhook address", () => {
  const ask = (query: string) => GET(new Request(`http://localhost/api/webhooks/meta?${query}`));

  it("echoes the challenge for the right verify token", async () => {
    const res = await ask(
      `hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=1158201444`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("1158201444");
  });

  it("answers 403 for a wrong token, a missing one, or another mode", async () => {
    expect((await ask("hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1")).status).toBe(
      403,
    );
    expect((await ask("hub.mode=subscribe&hub.challenge=1")).status).toBe(403);
    expect(
      (await ask(`hub.mode=other&hub.verify_token=${verifyToken}&hub.challenge=1`)).status,
    ).toBe(403);
    expect((await ask("")).status).toBe(403);
  });
});

describe("a delivery from Meta", () => {
  it("queues a signed delivery under a fingerprint of its own bytes, and files nothing itself", async () => {
    const res = await post(delivery, sign(delivery));
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        fn: "enqueue_meta_event",
        args: {
          p_id: createHash("sha256").update(delivery).digest("hex"),
          p_payload: JSON.parse(delivery),
        },
      },
    ]);
  });

  it("answers 401 without a signature, with a wrong one, or when the body was changed", async () => {
    expect((await post(delivery)).status).toBe(401);
    expect((await post(delivery, sign(delivery, randomBytes(16).toString("hex")))).status).toBe(
      401,
    );
    expect((await post(`${delivery} `, sign(delivery))).status).toBe(401);
    expect((await post(delivery, sign(delivery).replace("sha256=", ""))).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("checks the signature before it reads the body at all", async () => {
    expect((await post("not json")).status).toBe(401);
    expect((await post("not json", sign("not json"))).status).toBe(400);
  });

  it("thanks Meta for a signed delivery that isn't messages, and queues nothing", async () => {
    const other = JSON.stringify({ object: "user", entry: [{ id: "1" }] });
    expect((await post(other, sign(other))).status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it("answers 500 when the queue is down, so Meta tries again", async () => {
    rpcError = { message: "down" };
    expect((await post(delivery, sign(delivery))).status).toBe(500);
  });
});

describe("Meta's data deletion callback", () => {
  const signed = (data: unknown, key = appSecret) => {
    const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
    return `${createHmac("sha256", key).update(payload).digest("base64url")}.${payload}`;
  };
  const ask = (signedRequest?: string) => {
    const form = new FormData();
    if (signedRequest) form.set("signed_request", signedRequest);
    return deletion.POST(
      new Request("http://localhost/api/webhooks/meta/deletion", { method: "POST", body: form }),
    );
  };
  const request = { algorithm: "HMAC-SHA256", issued_at: 1, user_id: "9000000000000003" };

  it("queues the deletion and gives Meta a code and a link to check it by", async () => {
    const res = await ask(signed(request));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; confirmation_code: string };
    expect(body.confirmation_code).toMatch(/^[a-f0-9]{24}$/);
    expect(body.url).toBe(
      `https://suite.test/api/webhooks/meta/deletion?code=${body.confirmation_code}`,
    );
    expect(calls).toEqual([
      {
        fn: "request_meta_deletion",
        args: { p_code: body.confirmation_code, p_external_id: "9000000000000003" },
      },
    ]);
  });

  it("refuses a request that isn't signed with the app secret", async () => {
    expect((await ask(signed(request, randomBytes(16).toString("hex")))).status).toBe(401);
    expect((await ask("garbage")).status).toBe(401);
    expect((await ask()).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("tells the person how their request stands, and nothing about anyone", async () => {
    const page = (code: string) =>
      deletion.GET(new Request(`http://localhost/api/webhooks/meta/deletion?code=${code}`));
    deletionStatus = "received";
    const waiting = await page("a".repeat(24));
    expect(waiting.status).toBe(200);
    expect(await waiting.text()).toContain("We have your request");
    deletionStatus = "done";
    expect(await (await page("a".repeat(24))).text()).toContain("has been carried out");
    deletionStatus = null;
    expect((await page("a".repeat(24))).status).toBe(404);
    calls.length = 0;
    expect((await page("../../etc")).status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
