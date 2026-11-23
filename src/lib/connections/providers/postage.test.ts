import { describe, expect, it } from "vitest";
import { getAdapter, isProviderKey, PROVIDER_ORDER } from "../registry";
import { ConnectError, ReconnectRequiredError, type Fetch } from "../types";
import { createRedoAdapter } from "./redo";
import { createUpsAdapter } from "./ups";

// Obviously not real keys.
const UPS_INPUT = {
  client_id: " fake-client-id ",
  client_secret: "fake-client-secret\n",
  account_number: "a1 b2c3",
  mode: "production",
};
const REDO_INPUT = { api_token: " fake-redo-token ", store_id: "store0000fake0000" };

type Call = { url: string; method: string; authorization: string; body: string };
function scripted(replies: { status?: number; body?: unknown }[]) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      authorization: new Headers(init.headers).get("authorization") ?? "",
      body: String(init.body ?? ""),
    });
    const reply = replies[calls.length - 1];
    if (!reply) throw new Error("network down");
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
  }) as Fetch;
  return { impl, calls };
}

const upsOk = [
  { body: { access_token: "fake-ups-token", expires_in: "14400" } },
  { body: { RateResponse: { RatedShipment: [] } } },
];

describe("UPS and Redo adapters", () => {
  it("are registered like every other provider, as key-based connections", () => {
    for (const key of ["ups", "redo"] as const) {
      expect(isProviderKey(key)).toBe(true);
      expect(PROVIDER_ORDER).toContain(key);
      const adapter = getAdapter(key);
      expect(adapter.key).toBe(key);
      expect(adapter.configured()).toBe(true);
      expect(adapter.pollEveryHours).toBeNull();
      expect(adapter.connectWithKey).toBeTypeOf("function");
      expect(() => adapter.beginConnect({ state: "s", redirectUri: "r", input: {} })).toThrow(ConnectError);
      // Everything typed in is typed into a password box, or picked from a list.
      for (const field of adapter.connectFields) {
        expect(Boolean(field.secret) || Boolean(field.options), `${key}.${field.name}`).toBe(true);
      }
    }
    expect(getAdapter("ups").connectFields.map((field) => field.name)).toEqual([
      "client_id",
      "client_secret",
      "account_number",
      "mode",
    ]);
    expect(getAdapter("redo").connectFields.map((field) => field.name)).toEqual([
      "api_token",
      "store_id",
    ]);
  });

  it("UPS: signs in, asks for one sample price, and keeps the keys only in the token", async () => {
    const { impl, calls } = scripted(upsOk);
    const account = await createUpsAdapter(impl, () => 1_000_000).connectWithKey!(UPS_INPUT);
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["POST", "https://onlinetools.ups.com/security/v1/oauth/token"],
      ["POST", "https://onlinetools.ups.com/api/rating/v2409/Shop"],
    ]);
    expect(calls[0].authorization).toBe(
      `Basic ${Buffer.from("fake-client-id:fake-client-secret").toString("base64")}`,
    );
    expect(calls[1].authorization).toBe("Bearer fake-ups-token");
    expect(account.token).toEqual({
      access_token: "fake-ups-token",
      expires_at: 1_000_000 + 14_400_000,
      secrets: {
        client_id: "fake-client-id",
        client_secret: "fake-client-secret",
        account: "A1B2C3",
        env: "production",
      },
    });
    expect(account.displayName).toBe("UPS");
    expect(account.metadata).toEqual({ mode: "production" });
    expect(account.externalAccountId).toMatch(/^ups-[0-9a-f-]{36}$/);
    // Nothing outside the token carries a key, the token or the account number.
    const { token: _token, ...rest } = account;
    expect(JSON.stringify(rest)).not.toMatch(/fake-|A1B2C3/);
    // Nor does any URL or request body.
    expect(calls.map((call) => call.url + call.body).join(" ")).not.toMatch(/fake-client|fake-ups-token/);
  });

  it("UPS: practice labels use UPS's test system and say so", async () => {
    const { impl, calls } = scripted(upsOk);
    const account = await createUpsAdapter(impl).connectWithKey!({ ...UPS_INPUT, mode: "test" });
    expect(calls[0].url).toBe("https://wwwcie.ups.com/security/v1/oauth/token");
    expect(account.metadata).toEqual({ mode: "test" });
    expect(account.displayName).toBe("UPS (practice labels)");
    expect(account.token.secrets?.env).toBe("test");
  });

  it("UPS: explains what's wrong without calling out, or without repeating a key", async () => {
    const none = scripted([]);
    const adapter = createUpsAdapter(none.impl);
    await expect(adapter.connectWithKey!({ ...UPS_INPUT, client_secret: " " })).rejects.toThrow(/Fill in/);
    await expect(adapter.connectWithKey!({ ...UPS_INPUT, account_number: "12345" })).rejects.toThrow(/six letters and numbers/);
    await expect(adapter.connectWithKey!({ ...UPS_INPUT, client_id: "has space" })).rejects.toThrow(/don't look like UPS keys/);
    expect(none.calls).toHaveLength(0);

    for (const replies of [
      [{ status: 401 }],
      [upsOk[0], { status: 403, body: { response: { errors: [{ code: "250002", message: "Invalid Authentication Information." }] } } }],
      [],
    ]) {
      const err = await createUpsAdapter(scripted(replies).impl)
        .connectWithKey!(UPS_INPUT)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConnectError);
      expect((err as Error).message).not.toMatch(/fake-/);
    }
  });

  it("UPS: renews its token with the saved keys, and asks to reconnect when they stop working", async () => {
    const saved = {
      access_token: "old-token",
      expires_at: 1,
      secrets: { client_id: "fake-client-id", client_secret: "fake-client-secret", account: "A1B2C3", env: "test" },
    };
    const { impl, calls } = scripted([{ body: { access_token: "new-token", expires_in: 3600 } }]);
    const renewed = await createUpsAdapter(impl, () => 5_000).refresh(saved, "ups-x");
    expect(calls[0].url).toBe("https://wwwcie.ups.com/security/v1/oauth/token");
    expect(renewed).toEqual({ access_token: "new-token", expires_at: 5_000 + 3_600_000, secrets: saved.secrets });
    await expect(createUpsAdapter(scripted([{ status: 401 }]).impl).refresh(saved, "ups-x")).rejects.toBeInstanceOf(ReconnectRequiredError);
    await expect(createUpsAdapter(impl).refresh({ access_token: "old-token" }, "ups-x")).rejects.toBeInstanceOf(ReconnectRequiredError);
  });

  it("Redo: checks the token with one sample quote and keeps it, with the store id, only in the token", async () => {
    const { impl, calls } = scripted([{ body: { data: { getShippingLabelQuotes: { rates: [] } } } }]);
    const account = await createRedoAdapter(impl).connectWithKey!(REDO_INPUT);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.getredo.com/v3/account/store0000fake0000/graphql");
    expect(calls[0].authorization).toBe("Bearer fake-redo-token");
    expect(calls[0].body).toContain("getShippingLabelQuotes");
    expect(calls[0].body).not.toContain("purchaseCarrierShipment");
    expect(calls[0].url + calls[0].body).not.toContain("fake-redo-token");
    expect(account.token).toEqual({
      access_token: "fake-redo-token",
      secrets: { store_id: "store0000fake0000" },
    });
    expect(account.displayName).toBe("Redo");
    const { token: _token, ...rest } = account;
    expect(JSON.stringify(rest)).not.toMatch(/fake-redo-token|store0000fake0000/);
  });

  it("Redo: explains a refused token, missing permissions and a bad store id", async () => {
    const none = scripted([]);
    await expect(createRedoAdapter(none.impl).connectWithKey!({ ...REDO_INPUT, store_id: "has space" })).rejects.toThrow(/store ID/);
    await expect(createRedoAdapter(none.impl).connectWithKey!({ api_token: "", store_id: "" })).rejects.toThrow(/Paste your Redo/);
    expect(none.calls).toHaveLength(0);
    const refused = await createRedoAdapter(scripted([{ status: 401, body: { errors: [{ message: "no" }] } }]).impl)
      .connectWithKey!(REDO_INPUT)
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConnectError);
    expect((refused as Error).message).toMatch(/didn't accept that token/);
    const scope = await createRedoAdapter(
      scripted([{ body: { errors: [{ message: "x", extensions: { code: "INSUFFICIENT_SCOPE" } }] } }]).impl,
    )
      .connectWithKey!(REDO_INPUT)
      .catch((e: unknown) => e);
    expect((scope as Error).message).toMatch(/Shipping read and Shipping write/);
    const down = await createRedoAdapter(none.impl).connectWithKey!(REDO_INPUT).catch((e: unknown) => e);
    expect((down as Error).message).toMatch(/couldn't reach Redo/);
  });
});
