import { describe, expect, it } from "vitest";
import { runSyncJob, type RunnerDeps, type SyncJob } from "./runner";
import {
  ReconnectRequiredError,
  type ProviderAdapter,
  type SyncContext,
  type SyncResult,
} from "./types";

function job(overrides: Partial<SyncJob> = {}): SyncJob {
  return {
    id: 7,
    tenant_id: "tenant-1",
    connection_id: "conn-1",
    provider: "shopify",
    type: "full",
    topic: null,
    payload: null,
    cursor: null,
    attempts: 1,
    ...overrides,
  };
}

function setup(sync: (ctx: SyncContext) => Promise<SyncResult>) {
  const log: string[] = [];
  let tokenReads = 0;
  const deps: RunnerDeps = {
    adapter: () => ({ sync }) as unknown as ProviderAdapter,
    getToken: async () => {
      tokenReads += 1;
      return {
        connectionId: "conn-1",
        externalAccountId: "alice.myshopify.com",
        status: "active",
        token: { access_token: "t" },
      };
    },
    finish: async (id, outcome) => {
      log.push(`finish ${id} ${JSON.stringify(outcome)}`);
    },
    updateAccount: async (_id, account) => {
      log.push(`account ${account.displayName}`);
    },
    disconnect: async (_id, reason) => {
      log.push(`disconnect ${reason}`);
    },
  };
  return { deps, log, tokenReads: () => tokenReads };
}

describe("runSyncJob", () => {
  it("runs a pull with the connection's token and records the result", async () => {
    let seen: SyncContext | null = null;
    const t = setup(async (ctx) => {
      seen = ctx;
      return { account: { displayName: "Alice Rugs" }, cursor: { since: "x" } };
    });
    expect(await runSyncJob(job(), t.deps)).toBe("succeeded");
    expect(seen!.externalAccountId).toBe("alice.myshopify.com");
    expect(t.log).toEqual(["account Alice Rugs", 'finish 7 {"cursor":{"since":"x"}}']);
  });

  it("handles webhooks without touching the token", async () => {
    const t = setup(async () => ({}));
    expect(await runSyncJob(job({ type: "webhook", topic: "orders/create" }), t.deps)).toBe(
      "succeeded",
    );
    expect(t.tokenReads()).toBe(0);
  });

  it("disconnects when the provider says the app was removed", async () => {
    const t = setup(async () => ({ disconnected: "The app was removed from the store" }));
    expect(await runSyncJob(job({ type: "webhook", topic: "app/uninstalled" }), t.deps)).toBe(
      "disconnected",
    );
    expect(t.log).toEqual(["finish 7 {}", "disconnect The app was removed from the store"]);
  });

  it("retries a passing failure and gives up at once on a reconnect", async () => {
    const flaky = setup(async () => {
      throw new Error("Shopify answered 502");
    });
    expect(await runSyncJob(job(), flaky.deps)).toBe("retry");
    expect(flaky.log).toEqual(['finish 7 {"error":"Shopify answered 502","retry":true}']);

    const dead = setup(async () => {
      throw new ReconnectRequiredError("Shopify no longer accepts this store's access");
    });
    expect(await runSyncJob(job(), dead.deps)).toBe("failed");
    expect(dead.log[0]).toContain('"retry":false');
  });

  it("fails a job for a provider it doesn't know", async () => {
    const t = setup(async () => ({}));
    expect(await runSyncJob(job({ provider: "myspace" }), t.deps)).toBe("failed");
  });
});
