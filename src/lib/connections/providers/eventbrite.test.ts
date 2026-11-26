import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PROVIDER_ORDER, getAdapter, isProviderKey } from "../registry";
import { ConnectError } from "../types";
import { createEventbriteAdapter } from "./eventbrite";

// Made up per run: not a real token, and not shaped like one.
const TOKEN = `test${randomBytes(10).toString("hex")}`;

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; authorization: string | null }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

describe("Eventbrite adapter", () => {
  it("is registered like every other provider and takes a pasted token", () => {
    expect(isProviderKey("eventbrite")).toBe(true);
    expect(PROVIDER_ORDER).toContain("eventbrite");
    const adapter = getAdapter("eventbrite");
    expect(adapter.key).toBe("eventbrite");
    expect(adapter.configured()).toBe(true);
    expect(adapter.nothingToSync).toBe(true);
    expect(adapter.connectFields).toEqual([
      expect.objectContaining({ name: "private_token", secret: true }),
    ]);
    expect(() => adapter.beginConnect({ state: "", redirectUri: "", input: {} })).toThrow(
      ConnectError,
    );
  });

  it("checks the token with one read and keeps it only as the token", async () => {
    const { impl, calls } = fakeFetch(200, {
      organizations: [{ id: "123456", name: "Rug Studio" }],
    });
    const account = await createEventbriteAdapter(impl).connectWithKey!({
      private_token: `  ${TOKEN}\n`,
    });
    expect(calls).toEqual([
      {
        url: "https://www.eventbriteapi.com/v3/users/me/organizations/",
        authorization: `Bearer ${TOKEN}`,
      },
    ]);
    expect(account).toEqual({
      externalAccountId: "123456",
      displayName: "Rug Studio",
      scopes: [],
      token: { access_token: TOKEN },
      metadata: { organizations: 1 },
    });
    expect(JSON.stringify(account.metadata)).not.toContain(TOKEN);
  });

  it("explains a refused token, a token with no organization, and a bad paste", async () => {
    const refused = createEventbriteAdapter(fakeFetch(401, { error: "INVALID_AUTH" }).impl);
    await expect(refused.connectWithKey!({ private_token: TOKEN })).rejects.toThrow(
      /didn't accept that token/,
    );
    const empty = createEventbriteAdapter(fakeFetch(200, { organizations: [] }).impl);
    await expect(empty.connectWithKey!({ private_token: TOKEN })).rejects.toThrow(
      /no organization/,
    );
    const { impl, calls } = fakeFetch(200, {});
    await expect(
      createEventbriteAdapter(impl).connectWithKey!({ private_token: "two words" }),
    ).rejects.toThrow(/doesn't look like/);
    expect(calls).toHaveLength(0);
  });
});
