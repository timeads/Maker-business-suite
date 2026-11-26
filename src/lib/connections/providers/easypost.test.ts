import { describe, expect, it } from "vitest";
import { getAdapter, isProviderKey, PROVIDER_ORDER } from "../registry";
import { memoryStore } from "../testing";
import { ConnectError, type Fetch } from "../types";
import { createEasyPostAdapter } from "./easypost";

// Obviously not a real key.
const KEY = "test-key-not-real";

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; method: string; authorization: string }[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      authorization: new Headers(init.headers).get("authorization") ?? "",
    });
    return new Response(JSON.stringify(body), { status });
  }) as Fetch;
  return { impl, calls };
}

describe("EasyPost adapter", () => {
  it("is registered like every other provider", () => {
    expect(isProviderKey("easypost")).toBe(true);
    expect(PROVIDER_ORDER).toContain("easypost");
    const adapter = getAdapter("easypost");
    expect(adapter.key).toBe("easypost");
    expect(adapter.configured()).toBe(true);
    expect(adapter.pollEveryHours).toBeNull();
    expect(adapter.connectFields).toHaveLength(1);
    expect(adapter.connectFields[0]).toMatchObject({ name: "api_key", secret: true });
    // The OAuth-shaped adapters are untouched: none of them takes a key.
    for (const key of PROVIDER_ORDER.filter(
      (k) => !["easypost", "ups", "redo", "michaels", "twilio", "eventbrite"].includes(k),
    )) {
      expect(getAdapter(key).connectWithKey, key).toBeUndefined();
    }
  });

  it("checks a good key with one cheap call and keeps it only as the token", async () => {
    const { impl, calls } = fakeFetch(200, { shipments: [{ id: "shp_1", mode: "production" }] });
    const account = await createEasyPostAdapter(impl).connectWithKey!({ api_key: `  ${KEY}\n` });
    expect(calls).toEqual([
      {
        url: "https://api.easypost.com/v2/shipments?page_size=1",
        method: "GET",
        authorization: `Basic ${Buffer.from(`${KEY}:`).toString("base64")}`,
      },
    ]);
    expect(account.token).toEqual({ access_token: KEY });
    expect(account.metadata).toEqual({ mode: "production" });
    expect(account.displayName).toBe("EasyPost");
    expect(account.scopes).toEqual([]);
    // Nothing outside the token carries the key.
    const { token: _token, ...rest } = account;
    expect(JSON.stringify(rest).includes(KEY)).toBe(false);
  });

  it("notices a test key", async () => {
    const { impl } = fakeFetch(200, { shipments: [{ id: "shp_1", mode: "test" }] });
    const account = await createEasyPostAdapter(impl).connectWithKey!({ api_key: KEY });
    expect(account.metadata).toEqual({ mode: "test" });
    expect(account.displayName).toBe("EasyPost (test key)");

    // A brand-new account has no shipments yet: the key's prefix decides.
    const empty = fakeFetch(200, { shipments: [] });
    const fresh = await createEasyPostAdapter(empty.impl).connectWithKey!({
      api_key: "EZTKnot-a-real-key",
    });
    expect(fresh.metadata).toEqual({ mode: "test" });
  });

  it("gives each connection its own account id, so two workspaces can share an account", async () => {
    const { impl } = fakeFetch(200, { shipments: [] });
    const adapter = createEasyPostAdapter(impl);
    const one = await adapter.connectWithKey!({ api_key: KEY });
    const two = await adapter.connectWithKey!({ api_key: KEY });
    expect(one.externalAccountId).not.toBe(two.externalAccountId);
    expect(one.externalAccountId.includes(KEY)).toBe(false);
  });

  it("explains a wrong key plainly, without repeating it", async () => {
    const { impl } = fakeFetch(401, { error: { message: "Invalid API key" } });
    const err = await createEasyPostAdapter(impl).connectWithKey!({ api_key: KEY }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as Error).message).toMatch(/didn't accept that key/);
    expect((err as Error).message.includes(KEY)).toBe(false);
  });

  it("refuses an empty or mangled key before calling anyone", async () => {
    const { impl, calls } = fakeFetch(200, {});
    const adapter = createEasyPostAdapter(impl);
    await expect(adapter.connectWithKey!({})).rejects.toThrow(ConnectError);
    await expect(adapter.connectWithKey!({ api_key: "   " })).rejects.toThrow(ConnectError);
    await expect(adapter.connectWithKey!({ api_key: "two words" })).rejects.toThrow(ConnectError);
    await expect(adapter.connectWithKey!({ api_key: "k".repeat(201) })).rejects.toThrow(
      ConnectError,
    );
    expect(calls).toHaveLength(0);
  });

  it("says so when EasyPost can't be reached", async () => {
    const { impl } = fakeFetch(503, {});
    await expect(createEasyPostAdapter(impl).connectWithKey!({ api_key: KEY })).rejects.toThrow(
      /couldn't reach EasyPost/,
    );
  });

  it("has no approval page, and the rest of the interface is quietly trivial", async () => {
    const { impl, calls } = fakeFetch(200, {});
    const adapter = createEasyPostAdapter(impl);
    expect(() => adapter.beginConnect({ state: "s", redirectUri: "x", input: {} })).toThrow(
      ConnectError,
    );
    await expect(
      adapter.completeConnect({ params: new URLSearchParams(), redirectUri: "x", input: {} }),
    ).rejects.toThrow(ConnectError);

    const token = { access_token: KEY };
    expect(await adapter.refresh(token, "easypost-1")).toBe(token);
    await adapter.disconnect(token, "easypost-1");
    const result = await adapter.sync({
      store: memoryStore().store,
      connectionId: "c",
      externalAccountId: "easypost-1",
      token,
      job: { type: "full", topic: null, payload: null, cursor: null },
    });
    expect(result.disconnected).toBeUndefined();
    expect(result.continueWith).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
