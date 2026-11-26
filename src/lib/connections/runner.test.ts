import { describe, expect, it } from "vitest";
import { runSyncJob, type RunnerDeps, type SyncJob } from "./runner";
import { memoryStore } from "./testing";
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
    adapter: () =>
      ({ sync, tokenlessTopics: ["app/uninstalled", "shop/redact"] }) as unknown as ProviderAdapter,
    store: () => memoryStore().store,
    requeue: async (id, cursor) => {
      log.push(`requeue ${id} ${JSON.stringify(cursor)}`);
    },
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
    updateScopes: async (tenantId, connectionId, scopes) => {
      if (scopes.includes("explode")) throw new Error("database said no");
      log.push(`scopes ${tenantId} ${connectionId} ${scopes.join(",")}`);
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

  it("records the scopes a sync read, and a failure to record them never fails the sync", async () => {
    const t = setup(async () => ({ scopes: ["read_orders", "write_orders"] }));
    expect(await runSyncJob(job(), t.deps)).toBe("succeeded");
    expect(t.log[0]).toMatch(/^scopes .+ read_orders,write_orders$/);

    const quiet = setup(async () => ({ cursor: { since: "y" } }));
    await runSyncJob(job(), quiet.deps);
    expect(quiet.log.some((line) => line.startsWith("scopes"))).toBe(false);

    const failing = setup(async () => ({ scopes: ["explode"] }));
    expect(await runSyncJob(job(), failing.deps)).toBe("succeeded");
  });

  it("fetches a token for order webhooks but not for uninstall or erase notices", async () => {
    const t = setup(async () => ({}));
    expect(await runSyncJob(job({ type: "webhook", topic: "orders/create" }), t.deps)).toBe(
      "succeeded",
    );
    expect(t.tokenReads()).toBe(1);
    await runSyncJob(job({ type: "webhook", topic: "shop/redact" }), t.deps);
    expect(t.tokenReads()).toBe(1);
  });

  it("puts a long sync back on the queue instead of finishing it", async () => {
    const t = setup(async () => ({ continueWith: { after: "page-21" } }));
    expect(await runSyncJob(job(), t.deps)).toBe("continued");
    expect(t.log).toEqual(['requeue 7 {"after":"page-21"}']);
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
