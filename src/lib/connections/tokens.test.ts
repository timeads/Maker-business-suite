import { describe, expect, it } from "vitest";
import { getProviderToken, type StoredToken, type TokenDeps } from "./tokens";
import { ReconnectRequiredError, type ProviderAdapter, type TokenSet } from "./types";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function setup(initial: Partial<StoredToken> & { token: TokenSet }) {
  let stored: StoredToken | null = {
    connectionId: "conn-1",
    externalAccountId: "realm-1",
    status: "active",
    ...initial,
  };
  let locked = false;
  const calls = { refresh: 0, waits: 0, notified: [] as string[] };
  let refreshImpl: (token: TokenSet) => Promise<TokenSet> = async (token) => ({
    access_token: `${token.access_token}+`,
    refresh_token: `${token.refresh_token}+`,
    expires_at: NOW + HOUR,
  });

  const deps: TokenDeps = {
    now: () => NOW,
    wait: async () => {
      calls.waits += 1;
    },
    adapter: () =>
      ({
        refresh: async (token: TokenSet) => {
          calls.refresh += 1;
          return refreshImpl(token);
        },
      }) as unknown as ProviderAdapter,
    store: {
      read: async () => (stored ? structuredClone(stored) : null),
      lockRefresh: async () => {
        if (locked) return false;
        locked = true;
        return true;
      },
      save: async (_id, token) => {
        stored = { ...stored!, token, status: "active" };
        locked = false;
      },
      markNeedsReconnect: async () => {
        stored = { ...stored!, status: "needs_reconnect" };
        locked = false;
      },
    },
    onNeedsReconnect: async ({ reason }) => {
      calls.notified.push(reason);
    },
  };
  return {
    deps,
    calls,
    current: () => stored,
    setRefresh: (fn: typeof refreshImpl) => (refreshImpl = fn),
    setLocked: (value: boolean) => (locked = value),
    clear: () => (stored = null),
  };
}

const get = (deps: TokenDeps) => getProviderToken("tenant-1", "quickbooks", deps);

describe("getProviderToken", () => {
  it("returns a token that still has time left without refreshing", async () => {
    const t = setup({ token: { access_token: "a", refresh_token: "r", expires_at: NOW + HOUR } });
    expect((await get(t.deps)).token.access_token).toBe("a");
    expect(t.calls.refresh).toBe(0);
  });

  it("returns a token that never expires as it is", async () => {
    const t = setup({ token: { access_token: "forever" } });
    expect((await get(t.deps)).token.access_token).toBe("forever");
    expect(t.calls.refresh).toBe(0);
  });

  it("refreshes a token that is about to expire and stores the rotated pair", async () => {
    const t = setup({ token: { access_token: "a", refresh_token: "r", expires_at: NOW + 60_000 } });
    const result = await get(t.deps);
    expect(result.token).toEqual({
      access_token: "a+",
      refresh_token: "r+",
      expires_at: NOW + HOUR,
    });
    expect(t.current()?.token.refresh_token).toBe("r+");
    expect(t.calls.refresh).toBe(1);
    // The next caller uses the stored result.
    await get(t.deps);
    expect(t.calls.refresh).toBe(1);
  });

  it("does not refresh while another caller holds the lock; it waits for their result", async () => {
    const t = setup({ token: { access_token: "a", refresh_token: "r", expires_at: NOW - 1 } });
    t.setLocked(true);
    let reads = 0;
    const read = t.deps.store.read;
    t.deps.store.read = async (...args) => {
      reads += 1;
      if (reads === 3) {
        // The other caller finishes between our polls.
        await t.deps.store.save("conn-1", {
          access_token: "theirs",
          refresh_token: "r2",
          expires_at: NOW + HOUR,
        });
      }
      return read(...args);
    };
    const result = await get(t.deps);
    expect(result.token.access_token).toBe("theirs");
    expect(t.calls.refresh).toBe(0);
    expect(t.calls.waits).toBe(2);
  });

  it("two callers at once produce exactly one refresh", async () => {
    const t = setup({ token: { access_token: "a", refresh_token: "r", expires_at: NOW - 1 } });
    const [one, two] = await Promise.all([get(t.deps), get(t.deps)]);
    expect(t.calls.refresh).toBe(1);
    expect(one.token.access_token).toBe("a+");
    expect(two.token.access_token).toBe("a+");
  });

  it("flags the connection and tells the owner when the provider rejects the refresh", async () => {
    const t = setup({ token: { access_token: "a", refresh_token: "dead", expires_at: NOW - 1 } });
    t.setRefresh(async () => {
      throw new ReconnectRequiredError("QuickBooks rejected the saved access for this company");
    });
    await expect(get(t.deps)).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect(t.current()?.status).toBe("needs_reconnect");
    expect(t.calls.notified).toEqual(["QuickBooks rejected the saved access for this company"]);

    // Later callers are told to reconnect without hammering the provider or re-notifying.
    await expect(get(t.deps)).rejects.toBeInstanceOf(ReconnectRequiredError);
    expect(t.calls.refresh).toBe(1);
    expect(t.calls.notified).toHaveLength(1);
  });

  it("leaves the connection alone when the refresh fails for a passing reason", async () => {
    const t = setup({ token: { access_token: "a", refresh_token: "r", expires_at: NOW - 1 } });
    t.setRefresh(async () => {
      throw new Error("QuickBooks answered 503");
    });
    await expect(get(t.deps)).rejects.toThrow("503");
    expect(t.current()?.status).toBe("active");
    expect(t.current()?.token.refresh_token).toBe("r");
    expect(t.calls.notified).toEqual([]);
  });

  it("says so when nothing is connected", async () => {
    const t = setup({ token: { access_token: "a" } });
    t.clear();
    await expect(get(t.deps)).rejects.toThrow(/not connected/);
  });
});
