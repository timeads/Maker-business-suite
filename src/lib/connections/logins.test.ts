import { describe, expect, it } from "vitest";
import {
  LOGINS_HOLDER,
  changeLogins,
  connectionForLogin,
  getLoginToken,
  loginIds,
  loginToken,
  mergeLogins,
  singleLogin,
  withoutLogin,
  type LoginDeps,
} from "./logins";
import type { StoredToken } from "./tokens";
import { ReconnectRequiredError, type ProviderAdapter, type TokenSet } from "./types";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

// Made-up tokens only.
const one: TokenSet = { access_token: "a1", refresh_token: "r1", expires_at: NOW + HOUR };
const two: TokenSet = { access_token: "a2", refresh_token: "r2", expires_at: NOW - 1 };

function setup(token: TokenSet) {
  let stored: StoredToken = {
    connectionId: "conn-1",
    externalAccountId: "login-1",
    status: "active",
    token,
  };
  let locked = false;
  const calls = { refresh: [] as string[], marked: [] as string[], saves: 0 };
  let refresh: (token: TokenSet) => Promise<TokenSet> = async (t) => ({
    access_token: `${t.access_token}+`,
    refresh_token: `${t.refresh_token}+`,
    expires_at: NOW + HOUR,
  });
  const deps: LoginDeps = {
    now: () => NOW,
    wait: async () => undefined,
    adapter: () =>
      ({
        refresh: async (t: TokenSet, loginId: string) => {
          calls.refresh.push(loginId);
          return refresh(t);
        },
      }) as unknown as ProviderAdapter,
    store: {
      read: async () => structuredClone(stored),
      lockRefresh: async () => {
        if (locked) return false;
        locked = true;
        return true;
      },
      save: async (_id, next) => {
        calls.saves += 1;
        stored = { ...stored, token: next };
        locked = false;
      },
      markNeedsReconnect: async () => {
        throw new Error("the whole connection must never be marked for one login");
      },
    },
    markLogin: async ({ loginId }) => {
      calls.marked.push(loginId);
    },
  };
  return {
    deps,
    calls,
    current: () => stored,
    setRefresh: (fn: typeof refresh) => (refresh = fn),
  };
}

describe("several logins in one connection", () => {
  it("adds, replaces and takes away logins without touching the others", () => {
    const first = singleLogin("login-1", one);
    expect(first.access_token).toBe(LOGINS_HOLDER);
    const both = mergeLogins(first, singleLogin("login-2", two));
    expect(loginIds(both).sort()).toEqual(["login-1", "login-2"]);
    expect(loginToken(both, "login-1")).toEqual(one);
    const again = mergeLogins(both, singleLogin("login-2", one));
    expect(loginToken(again, "login-2")).toEqual(one);
    expect(loginToken(again, "login-1")).toEqual(one);
    const left = withoutLogin(again, "login-1");
    expect(loginIds(left)).toEqual(["login-2"]);
    // A token from before (not a holder) is never kept beside new logins.
    expect(loginIds(mergeLogins({ access_token: "old" }, first))).toEqual(["login-1"]);
    expect(
      loginToken({ access_token: "x", secrets: { "login:bad": "not json" } }, "bad"),
    ).toBeNull();
  });

  it("names the connection after its logins and keeps its first id", () => {
    const first = connectionForLogin(null, {
      externalAccountId: "login-1",
      displayName: "Studio",
      scopes: ["video.publish"],
      token: singleLogin("login-1", one),
      metadata: {
        logins: [{ id: "login-1", name: "Studio", scopes: ["video.publish"], connected_at: "t" }],
        offered: [{ network: "tiktok", platform_id: "login-1" }],
      },
    });
    expect(first).toMatchObject({ externalAccountId: "login-1", displayName: "Studio" });
    // What a login offered is said to the database, not kept on the connection.
    expect(first.metadata.offered).toBeUndefined();
    const second = connectionForLogin(
      { external_account_id: "login-1", metadata: { ...first.metadata, offered: ["old"] } },
      {
        externalAccountId: "login-2",
        displayName: "Second",
        scopes: ["user.info.basic"],
        token: singleLogin("login-2", two),
        metadata: { logins: [{ id: "login-2", name: "Second", scopes: ["user.info.basic"] }] },
      },
    );
    expect(second.externalAccountId).toBe("login-1");
    expect(second.displayName).toBe("Studio · Second");
    expect(second.scopes.sort()).toEqual(["user.info.basic", "video.publish"]);
    expect(second.metadata.offered).toBeUndefined();
  });
});

describe("one login's tokens", () => {
  it("returns a login's own token while it is fresh", async () => {
    const { deps, calls } = setup(
      mergeLogins(singleLogin("login-1", one), singleLogin("login-2", two)),
    );
    const got = await getLoginToken("t", "tiktok", "login-1", deps);
    expect(got.token).toEqual(one);
    expect(calls.refresh).toEqual([]);
  });

  it("renews only that login under the lock, keeping the others as they were", async () => {
    const { deps, calls, current } = setup(
      mergeLogins(singleLogin("login-1", one), singleLogin("login-2", two)),
    );
    const got = await getLoginToken("t", "tiktok", "login-2", deps);
    expect(got.token.access_token).toBe("a2+");
    expect(calls.refresh).toEqual(["login-2"]);
    expect(loginToken(current().token, "login-2")?.refresh_token).toBe("r2+");
    expect(loginToken(current().token, "login-1")).toEqual(one);
  });

  it("a login that can't be renewed is marked, and the connection stands", async () => {
    const { deps, calls, current, setRefresh } = setup(
      mergeLogins(singleLogin("login-1", one), singleLogin("login-2", two)),
    );
    setRefresh(async () => {
      throw new ReconnectRequiredError("ran out");
    });
    await expect(getLoginToken("t", "tiktok", "login-2", deps)).rejects.toThrow(
      ReconnectRequiredError,
    );
    expect(calls.marked).toEqual(["login-2"]);
    expect(current().status).toBe("active");
    // The lock was put down.
    expect(await deps.store.lockRefresh("conn-1")).toBe(true);
  });

  it("a login the connection doesn't hold must be connected again", async () => {
    const { deps } = setup(singleLogin("login-1", one));
    await expect(getLoginToken("t", "tiktok", "nobody", deps)).rejects.toThrow(
      ReconnectRequiredError,
    );
  });

  it("changes to the logins wait for the lock and start from what is stored then", async () => {
    const { deps, current } = setup(singleLogin("login-1", one));
    await changeLogins(
      "t",
      "tiktok",
      (token) => mergeLogins(token, singleLogin("login-2", two)),
      deps,
    );
    expect(loginIds(current().token).sort()).toEqual(["login-1", "login-2"]);
  });
});
