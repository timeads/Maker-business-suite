import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { TokenDeps } from "../connections/tokens";
import { MichaelsApiError, type MichaelsClient } from "./client";
import { runClaimedLook } from "./worker";

const TENANT = "11111111-1111-4111-8111-111111111111";
const LOOK = { id: "22222222-2222-4222-8222-222222222222", tenant_id: TENANT, source: "schedule" };
const now = () => new Date("2026-10-21T14:00:00Z");

/** A stand-in for the service-role client: tables are arrays, functions are recorded. */
function fakeAdmin(over: {
  tables?: Record<string, unknown[]>;
  rpc?: Record<string, (args: Record<string, unknown>) => unknown>;
}) {
  const tables: Record<string, unknown[]> = {
    subscriptions: [{ tenant_id: TENANT, plan: "growth", status: "active", selected_modules: [] }],
    plan_grants: [],
    configs: [{ body: { version: 1, enabled: true, mode: "watch", units_held_back: 1 } }],
    connections: [
      { id: "conn-1", metadata: { environment: "sandbox", key_created_on: "2026-08-25" } },
    ],
    tenants: [{ timezone: "America/New_York" }],
    stock_items: [
      {
        id: "i-cone",
        title: "Sample cone",
        variant_title: "Red",
        sku: "CONE-01",
        on_hand: 10,
        tracked: true,
        price: 20,
      },
    ],
    michaels_pairings: [],
    michaels_listings: [],
    ...over.tables,
  };
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const seenAlerts = new Set<string>();
  const functions: Record<string, (args: Record<string, unknown>) => unknown> = {
    finish_michaels_run: () => ({ send_blocked: "watch_only", failed_in_row: 0 }),
    record_michaels_listings: () => 1,
    prune_michaels_listings: () => 0,
    record_michaels_orders: () => 0,
    mark_connection: () => null,
    post_app_chat_message: () => null,
    note_michaels_alert: (args) => {
      const key = String(args.p_key);
      if (seenAlerts.has(key)) return false;
      seenAlerts.add(key);
      return true;
    },
    ...over.rpc,
  };
  const builder = (table: string) => {
    const rows = tables[table] ?? [];
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "order", "range", "in"]) chain[method] = () => chain;
    chain.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
    chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: rows, error: null });
    return chain;
  };
  const admin = {
    from: (table: string) => builder(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (!functions[fn]) return { data: null, error: { message: `no function ${fn}` } };
      return { data: functions[fn](args), error: null };
    },
  } as unknown as SupabaseClient;
  return { admin, calls };
}

const catalog = (listings: unknown[]): MichaelsClient => ({
  request: async <T>(method: string, path: string) => {
    if (method !== "GET") throw new Error("a look must only read");
    if (path === "/listing/all-listings") return { listings, nextCursor: null } as T;
    return { records: [] } as T;
  },
});
const tokenDeps = {} as TokenDeps;
const of = (calls: { fn: string; args: Record<string, unknown> }[], fn: string) =>
  calls.filter((c) => c.fn === fn).map((c) => c.args);

describe("runClaimedLook", () => {
  it("reads, records for the named workspace, and closes the look", async () => {
    const { admin, calls } = fakeAdmin({});
    const client = catalog([
      { skuNumber: "P1", sellerSkuNumber: "CONE-01", status: "ACTIVE", inventory: 4, price: 20 },
    ]);
    const status = await runClaimedLook(LOOK, {
      admin,
      tokenDeps,
      now,
      clientFor: async () => client,
    });
    expect(status).toBe("done");
    const [recorded] = of(calls, "record_michaels_listings");
    expect(recorded).toMatchObject({ p_tenant_id: TENANT, p_run_id: LOOK.id });
    expect((recorded.p_rows as { stock_item_id: string }[])[0].stock_item_id).toBe("i-cone");
    expect(of(calls, "prune_michaels_listings")).toHaveLength(1);
    const [finished] = of(calls, "finish_michaels_run");
    expect(finished).toMatchObject({ p_run_id: LOOK.id, p_status: "done", p_error: null });
    expect(finished.p_changes).toEqual([
      expect.objectContaining({
        kind: "stock",
        seller_sku: "CONE-01",
        item_name: "Sample cone (Red)",
        from: "4",
        to: "9",
      }),
    ]);
    // Every function it calls is one of ours; none of them is a send.
    expect(new Set(calls.map((c) => c.fn))).toEqual(
      new Set([
        "record_michaels_listings",
        "prune_michaels_listings",
        "finish_michaels_run",
        "note_michaels_alert",
        "post_app_chat_message",
      ]),
    );
  });

  it("reminds about the key once, not at every look", async () => {
    const { admin, calls } = fakeAdmin({});
    const client = catalog([]);
    // Made 57 days before: three days from the replace-by date.
    await runClaimedLook(LOOK, { admin, tokenDeps, now, clientFor: async () => client });
    await runClaimedLook(LOOK, { admin, tokenDeps, now, clientFor: async () => client });
    expect(of(calls, "note_michaels_alert")).toHaveLength(2);
    const posted = of(calls, "post_app_chat_message");
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ p_tenant_id: TENANT, p_app: "stock" });
    expect(String(posted[0].p_body)).toContain("Replace your Michaels API key in 3 days");
  });

  it("does nothing for a workspace whose plan doesn't have Stock, but still closes the look", async () => {
    const { admin, calls } = fakeAdmin({ tables: { subscriptions: [] } });
    let asked = false;
    const status = await runClaimedLook(LOOK, {
      admin,
      tokenDeps,
      now,
      clientFor: async () => {
        asked = true;
        return catalog([]);
      },
    });
    expect(status).toBe("failed");
    expect(asked).toBe(false);
    expect(of(calls, "finish_michaels_run")[0]).toMatchObject({
      p_status: "failed",
      p_error: "Stock isn't part of this workspace's plan right now.",
    });
    expect(of(calls, "record_michaels_listings")).toEqual([]);
  });

  it("does nothing when the settings say off, or ask for a mode this stage doesn't have", async () => {
    for (const body of [
      { version: 1, enabled: false },
      { version: 1, enabled: true, mode: "live" },
    ]) {
      const { admin, calls } = fakeAdmin({ tables: { configs: [{ body }] } });
      const status = await runClaimedLook(LOOK, {
        admin,
        tokenDeps,
        now,
        clientFor: async () => catalog([]),
      });
      expect(status).toBe("failed");
      expect(of(calls, "finish_michaels_run")[0].p_error).toBe(
        "Michaels is switched off in its settings.",
      );
    }
  });

  it("flags the connection and tells the team when Michaels won't take the key", async () => {
    const { admin, calls } = fakeAdmin({
      tables: { connections: [{ id: "conn-1", metadata: { key_created_on: "2026-10-01" } }] },
      rpc: { finish_michaels_run: () => ({ send_blocked: "no_scan", failed_in_row: 1 }) },
    });
    const rejecting: MichaelsClient = {
      request: async () => {
        throw new MichaelsApiError("no", "MCU_API_INVALID_API_KEY", 401, "/listing/all-listings");
      },
    };
    const status = await runClaimedLook(LOOK, {
      admin,
      tokenDeps,
      now,
      clientFor: async () => rejecting,
    });
    expect(status).toBe("failed");
    expect(of(calls, "mark_connection")).toEqual([
      {
        p_connection_id: "conn-1",
        p_status: "needs_reconnect",
        p_error: "Michaels didn't accept the API key",
      },
    ]);
    expect(String(of(calls, "post_app_chat_message")[0].p_body)).toContain(
      "didn't accept your API key",
    );
  });

  it("mentions the safety stop when the database says more than a tenth are unmatched", async () => {
    const { admin, calls } = fakeAdmin({
      tables: { connections: [{ id: "conn-1", metadata: { key_created_on: "2026-10-01" } }] },
      rpc: { finish_michaels_run: () => ({ send_blocked: "unmatched", failed_in_row: 0 }) },
    });
    const client = catalog([{ skuNumber: "P9", sellerSkuNumber: "MYSTERY", status: "ACTIVE" }]);
    await runClaimedLook(LOOK, { admin, tokenDeps, now, clientFor: async () => client });
    expect(String(of(calls, "post_app_chat_message")[0].p_body)).toContain(
      "1 of your 1 Michaels listings don't match",
    );
  });

  it("keeps our own trouble out of what the workspace reads, and never throws", async () => {
    const { admin, calls } = fakeAdmin({
      rpc: {
        record_michaels_listings: () => {
          throw new Error("unexpected");
        },
      },
    });
    const broken = {
      ...admin,
      from: () => {
        throw new Error("relation secrets does not exist");
      },
    } as unknown as SupabaseClient;
    const status = await runClaimedLook(LOOK, {
      admin: broken,
      tokenDeps,
      now,
      clientFor: async () => catalog([]),
    });
    expect(status).toBe("failed");
    expect(of(calls, "finish_michaels_run")[0].p_error).toBe(
      "Something went wrong on our side. We'll try again at the next look.",
    );
  });
});
