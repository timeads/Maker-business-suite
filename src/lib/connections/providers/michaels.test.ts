import { describe, expect, it } from "vitest";
import { PROVIDER_ORDER, getAdapter, isProviderKey } from "../registry";
import { memoryStore } from "../testing";
import { ConnectError } from "../types";
import { createMichaelsAdapter, michaelsKeyNote } from "./michaels";

const KEY = "made-up-michaels-key-0001";
const today = () => new Date().toISOString().slice(0, 10);

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: URL | string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}
const ok = { code: "200", message: "Succeeded", data: { listings: [], nextCursor: null } };
const input = (over: Record<string, string> = {}) => ({
  api_key: KEY,
  key_created: today(),
  environment: "production",
  ...over,
});

describe("Michaels adapter", () => {
  it("is registered like every other provider, and connects with a pasted key", () => {
    expect(isProviderKey("michaels")).toBe(true);
    expect(PROVIDER_ORDER).toContain("michaels");
    const adapter = getAdapter("michaels");
    expect(adapter.key).toBe("michaels");
    expect(adapter.configured()).toBe(true);
    expect(adapter.connectWithKey).toBeTypeOf("function");
    expect(adapter.pollEveryHours).toBeNull();
    expect(adapter.connectFields.find((f) => f.name === "api_key")?.secret).toBe(true);
    expect(adapter.blurb).toContain("only watches");
  });

  it("checks a good key with one harmless read and keeps it only as the token", async () => {
    const { impl, calls } = fakeFetch(200, ok);
    const account = await createMichaelsAdapter(impl).connectWithKey!(input());
    expect(calls).toEqual([
      {
        url: "https://www.michaels.com/api/mkp/v1/listing/all-listings?limit=1",
        method: "GET",
        headers: expect.objectContaining({ "Api-Key": KEY }),
      },
    ]);
    expect(account.token).toEqual({ access_token: KEY, secrets: { env: "production" } });
    expect(account.metadata).toEqual({ environment: "production", key_created_on: today() });
    expect(account.externalAccountId).toMatch(/^michaels-[0-9a-f-]{36}$/);
    // Nothing the page can read carries the key.
    expect(JSON.stringify({ ...account, token: null })).not.toContain(KEY);
  });

  it("checks a sandbox key against the sandbox", async () => {
    const { impl, calls } = fakeFetch(200, ok);
    const account = await createMichaelsAdapter(impl).connectWithKey!(
      input({ environment: "sandbox" }),
    );
    expect(calls[0]!.url).toBe(
      "https://www.michaels.com/api/mkp/v1/uat/listing/all-listings?limit=1",
    );
    expect(account.displayName).toBe("Michaels sandbox");
    expect(account.token.secrets).toEqual({ env: "sandbox" });
  });

  it("gives each connection its own account id", async () => {
    const { impl } = fakeFetch(200, ok);
    const adapter = createMichaelsAdapter(impl);
    const [a, b] = await Promise.all([
      adapter.connectWithKey!(input()),
      adapter.connectWithKey!(input()),
    ]);
    expect(a.externalAccountId).not.toBe(b.externalAccountId);
  });

  it("explains a key Michaels won't take, without repeating it, and asks once", async () => {
    const { impl, calls } = fakeFetch(401, { code: "MCU_API_INVALID_API_KEY", message: "invalid" });
    const err = await createMichaelsAdapter(impl).connectWithKey!(input()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as Error).message).toMatch(/didn't accept that key/);
    expect((err as Error).message).not.toContain(KEY);
    expect(calls).toHaveLength(1);
  });

  it("says which permission is missing when the key can't read listings", async () => {
    const { impl } = fakeFetch(401, { code: "MCU_DEVELOPER_API_DO_NOT_HAVE_PERMISSION" });
    await expect(createMichaelsAdapter(impl).connectWithKey!(input())).rejects.toThrow(
      /Read Only access to Listing/,
    );
  });

  it("says so when Michaels can't be reached or answers strangely", async () => {
    const down = fakeFetch(503, { code: "MCU_API_INTERNAL_SERVER_ERROR" });
    await expect(createMichaelsAdapter(down.impl).connectWithKey!(input())).rejects.toThrow(
      /couldn't reach Michaels/,
    );
    expect(down.calls).toHaveLength(1);
    const odd = fakeFetch(404, "<html>nope</html>");
    await expect(createMichaelsAdapter(odd.impl).connectWithKey!(input())).rejects.toThrow(
      /sandbox or the real marketplace/,
    );
  });

  it("refuses an empty or mangled key, a bad date and an unknown Michaels before calling anyone", async () => {
    const { impl, calls } = fakeFetch(200, ok);
    const adapter = createMichaelsAdapter(impl);
    for (const bad of [
      input({ api_key: "" }),
      input({ api_key: "short" }),
      input({ api_key: "has a space in it" }),
      input({ key_created: "" }),
      input({ key_created: "24/11/2026" }),
      input({ key_created: "2026-02-31" }),
      input({ key_created: "2999-01-01" }),
      input({ key_created: "2020-01-01" }),
      input({ environment: "staging" }),
    ]) {
      await expect(adapter.connectWithKey!(bad)).rejects.toThrow(ConnectError);
    }
    expect(calls).toHaveLength(0);
  });

  it("has no approval page, and the rest of the interface is quietly trivial", async () => {
    const { impl, calls } = fakeFetch(200, ok);
    const adapter = createMichaelsAdapter(impl);
    expect(() => adapter.beginConnect({ state: "s", redirectUri: "x", input: {} })).toThrow(
      ConnectError,
    );
    await expect(
      adapter.completeConnect({ params: new URLSearchParams(), redirectUri: "x", input: {} }),
    ).rejects.toThrow(ConnectError);
    const token = { access_token: KEY };
    expect(await adapter.refresh(token, "michaels-1")).toBe(token);
    await adapter.disconnect(token, "michaels-1");
    const result = await adapter.sync({
      store: memoryStore().store,
      connectionId: "c",
      externalAccountId: "michaels-1",
      token,
      job: { type: "full", topic: null, payload: null, cursor: null },
    });
    expect(result.disconnected).toBeUndefined();
    expect(result.continueWith).toBeUndefined();
    // Syncing and disconnecting never reach Michaels.
    expect(calls).toHaveLength(0);
  });
});

describe("michaelsKeyNote", () => {
  const note = (day: string) => michaelsKeyNote({ key_created_on: "2026-09-01" }, day);
  it("counts down to the replace-by date in the house tones", () => {
    expect(note("2026-09-11")).toEqual({
      tone: "good",
      text: "Replace this API key in 50 days, by 2026-10-31. Michaels ends it on 2026-11-30.",
    });
    expect(note("2026-10-20")?.tone).toBe("waiting");
    expect(note("2026-10-30")).toMatchObject({
      tone: "bad",
      text: expect.stringContaining("in 1 day,"),
    });
    expect(note("2026-11-05")?.text).toContain("Replace this API key now");
    expect(note("2026-12-01")?.text).toContain("ran out on 2026-11-30");
  });

  it("says nothing when the day isn't known", () => {
    expect(michaelsKeyNote({}, "2026-09-11")).toBeNull();
    expect(michaelsKeyNote({ key_created_on: 5 }, "2026-09-11")).toBeNull();
  });
});
