import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };

let db: PGlite;
let alice: User;
let bob: User;
let tenantA: string;
let tenantB: string;
let connA: string;
let connB: string;

const TOKEN_A = { access_token: "token-for-a", refresh_token: "refresh-a", expires_at: 1 };
const TOKEN_B = { access_token: "token-for-b", refresh_token: "refresh-b", expires_at: 1 };

async function tenantFor(owner: User, name: string): Promise<string> {
  return asUser(db, owner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select id from public.create_tenant($1, 'UTC', 'USD')",
      [name],
    );
    return rows[0].id;
  });
}

function service<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
}

async function connect(
  tenantId: string,
  provider: string,
  account: string,
  token: object,
  by: User,
): Promise<string> {
  const rows = await service<{ id: string }>(
    "select public.save_connection($1, $2, $3, $4, array['read_orders'], $5::jsonb, $6) as id",
    [tenantId, provider, account, `${account} store`, JSON.stringify(token), by.id],
  );
  return rows[0].id;
}

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
  connA = await connect(tenantA, "shopify", "alice.myshopify.com", TOKEN_A, alice);
  connB = await connect(tenantB, "shopify", "bob.myshopify.com", TOKEN_B, bob);
});

describe("cross-tenant isolation for connections", () => {
  it("user A sees only tenant A's connections and sync jobs", async () => {
    await asUser(db, alice, async (tx) => {
      const conns = await tx.query<{ id: string }>(
        "select id, provider, status from public.connections",
      );
      expect(conns.rows.map((r) => r.id)).toEqual([connA]);
      const jobs = await tx.query<{ tenant_id: string }>(
        "select tenant_id, type, status from public.sync_jobs",
      );
      expect(jobs.rows.length).toBeGreaterThan(0);
      expect(jobs.rows.every((r) => r.tenant_id === tenantA)).toBe(true);
    });
    await asUser(db, bob, async (tx) => {
      expect((await tx.query("select id from public.connections")).rows).toHaveLength(1);
      expect((await tx.query("select id from public.sync_jobs")).rows.length).toBeGreaterThan(0);
    });
  });

  it("no client can read tokens, job payloads, or call the service functions", async () => {
    const attempts = [
      "select * from vault.secrets",
      "select * from vault.decrypted_secrets",
      `select * from public.get_provider_token('${tenantA}', 'shopify')`,
      `select * from public.get_provider_token('${tenantB}', 'shopify')`,
      "select payload from public.sync_jobs",
      "select metadata from public.connections",
      "select * from public.connections",
      `update public.connections set status = 'disconnected'`,
      `delete from public.connections`,
      `insert into public.sync_jobs (tenant_id, connection_id, provider, type) values ('${tenantA}', '${connA}', 'shopify', 'full')`,
      `select public.save_connection('${tenantA}', 'quickbooks', '1', 'x', '{}', '{}'::jsonb, '${alice.id}')`,
      `select public.store_provider_token('${connB}', '{}'::jsonb)`,
      `select public.mark_connection('${connB}', 'disconnected')`,
      `select public.enqueue_sync('${connB}')`,
      `select public.enqueue_provider_webhook('shopify', 'bob.myshopify.com', 'orders/create', 'x', '{}'::jsonb)`,
      "select * from public.claim_sync_jobs(1)",
      "select public.finish_sync_job(1)",
      `select * from public.tenant_owner_emails('${tenantB}')`,
    ];
    for (const sql of attempts) {
      await expect(
        asUser(db, alice, (tx) => tx.query(sql)),
        sql,
      ).rejects.toThrow(/permission denied/i);
    }
    await expect(asAnon(db, (tx) => tx.query("select id from public.connections"))).rejects.toThrow(
      /permission denied/i,
    );
  });
});

describe("tokens", () => {
  const tokenFor = (tenantId: string, provider = "shopify") =>
    service<{ connection_id: string; token: { access_token: string } }>(
      "select connection_id, token from public.get_provider_token($1, $2)",
      [tenantId, provider],
    );

  it("are stored in Vault, never in the connections table, and come back per tenant", async () => {
    expect((await tokenFor(tenantA))[0]).toMatchObject({ connection_id: connA, token: TOKEN_A });
    expect((await tokenFor(tenantB))[0]).toMatchObject({ connection_id: connB, token: TOKEN_B });
    expect(await tokenFor(tenantA, "quickbooks")).toEqual([]);

    const { rows } = await db.query<{ row: string }>(
      "select c::text as row from public.connections c",
    );
    for (const { row } of rows) {
      expect(row).not.toContain("token-for-");
      expect(row).not.toContain("refresh-");
    }
  });

  it("only one caller at a time may refresh, and storing the new token releases the lock", async () => {
    const lock = async () =>
      (
        await service<{ ok: boolean }>("select public.lock_connection_refresh($1) as ok", [connA])
      )[0].ok;
    expect(await lock()).toBe(true);
    expect(await lock()).toBe(false);

    const rotated = { access_token: "token-for-a-2", refresh_token: "refresh-a-2", expires_at: 2 };
    await service("select public.store_provider_token($1, $2::jsonb)", [
      connA,
      JSON.stringify(rotated),
    ]);
    expect((await tokenFor(tenantA))[0].token).toEqual(rotated);
    // Tenant B's token is untouched by A's rotation.
    expect((await tokenFor(tenantB))[0].token).toEqual(TOKEN_B);
    expect(await lock()).toBe(true);

    // A crashed refresher's lock expires on its own.
    await db.query(
      "update public.connections set refresh_locked_until = now() - interval '1 second' where id = $1",
      [connA],
    );
    expect(await lock()).toBe(true);
    await db.query("update public.connections set refresh_locked_until = null");
  });

  it("a failed refresh marks the connection, and a successful one clears it", async () => {
    await service(
      "select public.mark_connection($1, 'needs_reconnect', 'Refresh token was rejected')",
      [connA],
    );
    const status = async () =>
      (
        await db.query<{ status: string; last_error: string | null }>(
          "select status, last_error from public.connections where id = $1",
          [connA],
        )
      ).rows[0];
    expect(await status()).toEqual({
      status: "needs_reconnect",
      last_error: "Refresh token was rejected",
    });
    // Tokens are kept while it needs reconnecting, so a retry can still work.
    expect(await tokenFor(tenantA)).toHaveLength(1);

    await service("select public.store_provider_token($1, $2::jsonb)", [
      connA,
      JSON.stringify(TOKEN_A),
    ]);
    expect(await status()).toEqual({ status: "active", last_error: null });
  });
});

describe("webhooks", () => {
  const hook = async (account: string, topic: string, id: string) =>
    (
      await service<{ r: string }>(
        "select public.enqueue_provider_webhook('shopify', $1, $2, $3, '{\"id\":1}'::jsonb) as r",
        [account, topic, id],
      )
    )[0].r;

  it("are routed to the workspace that owns the account, once per delivery", async () => {
    expect(await hook("bob.myshopify.com", "orders/create", "delivery-1")).toBe("queued");
    expect(await hook("bob.myshopify.com", "orders/create", "delivery-1")).toBe("duplicate");
    expect(await hook("stranger.myshopify.com", "orders/create", "delivery-2")).toBe(
      "unknown_account",
    );

    const { rows } = await db.query<{ tenant_id: string }>(
      "select tenant_id from public.sync_jobs where type = 'webhook'",
    );
    expect(rows).toEqual([{ tenant_id: tenantB }]);
  });

  it("an account can't be connected to a second workspace while the first is live", async () => {
    await expect(connect(tenantA, "quickbooks", "realm-1", TOKEN_A, alice)).resolves.toBeTruthy();
    await expect(connect(tenantB, "quickbooks", "realm-1", TOKEN_B, bob)).rejects.toThrow(
      /connections_one_live_per_account/,
    );
  });
});

describe("sync queue", () => {
  const claim = (limit = 10) =>
    service<{ id: number; type: string; attempts: number; connection_id: string }>(
      "select id, type, attempts, connection_id from public.claim_sync_jobs($1)",
      [limit],
    );
  const finish = async (id: number, error: string | null = null, retry = true) =>
    (
      await service<{ s: string }>("select public.finish_sync_job($1, $2, $3::jsonb, $4) as s", [
        id,
        error,
        error ? null : JSON.stringify({ since: "2026-11-21" }),
        retry,
      ])
    )[0].s;

  it("hands each job to one worker and records success on the connection", async () => {
    const first = await claim();
    expect(first.length).toBeGreaterThanOrEqual(3);
    expect(await claim()).toEqual([]);

    for (const job of first) expect(await finish(job.id)).toBe("succeeded");
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from public.connections where last_synced_at is null and status = 'active'",
    );
    expect(rows[0].n).toBe(0);
    // Webhook payloads are dropped once handled.
    const payloads = await db.query("select 1 from public.sync_jobs where payload is not null");
    expect(payloads.rows).toHaveLength(0);
  });

  it("won't queue a second sync while one is waiting, and retries failures with backoff", async () => {
    const enqueue = async () =>
      (await service<{ ok: boolean }>("select public.enqueue_sync($1) as ok", [connA]))[0].ok;
    expect(await enqueue()).toBe(true);
    expect(await enqueue()).toBe(false);

    const [job] = await claim();
    expect(await finish(job.id, "Shopify answered 502")).toBe("queued");
    // Not due yet: it waits out the backoff.
    expect(await claim()).toEqual([]);

    for (let attempt = 2; attempt <= 5; attempt++) {
      await db.query("update public.sync_jobs set run_after = now() where id = $1", [job.id]);
      const [again] = await claim();
      expect(again).toMatchObject({ id: job.id, attempts: attempt });
      expect(await finish(again.id, "Shopify answered 502")).toBe(
        attempt < 5 ? "queued" : "failed",
      );
    }
    const conn = await db.query<{ last_error: string }>(
      "select last_error from public.connections where id = $1",
      [connA],
    );
    expect(conn.rows[0].last_error).toBe("Shopify answered 502");
  });

  it("fails at once when retrying can't help", async () => {
    await service("select public.enqueue_sync($1)", [connA]);
    const [job] = await claim();
    expect(await finish(job.id, "Needs reconnecting", false)).toBe("failed");
  });

  it("reclaims a job whose worker died", async () => {
    await service("select public.enqueue_sync($1)", [connA]);
    const [job] = await claim();
    expect(await claim()).toEqual([]);
    await db.query(
      "update public.sync_jobs set locked_at = now() - interval '11 minutes' where id = $1",
      [job.id],
    );
    const [again] = await claim();
    expect(again).toMatchObject({ id: job.id, attempts: 2 });
    await finish(again.id);
  });

  it("schedules pulls only for connections that are due", async () => {
    const run = async () =>
      (
        await service<{ n: number }>(
          "select public.enqueue_scheduled_syncs('shopify', interval '6 hours') as n",
        )
      )[0].n;
    expect(await run()).toBe(0);
    await db.query(
      "update public.connections set last_synced_at = now() - interval '7 hours' where id = $1",
      [connB],
    );
    expect(await run()).toBe(1);
    expect(await run()).toBe(0);
    const [job] = await claim();
    expect(job.connection_id).toBe(connB);
    await finish(job.id);
  });
});

describe("disconnecting", () => {
  it("deletes the tokens, cancels queued work, stops webhooks, and frees the account", async () => {
    await service("select public.enqueue_sync($1)", [connB]);
    await service("select public.mark_connection($1, 'disconnected', 'App was uninstalled')", [
      connB,
    ]);

    expect(
      await service("select * from public.get_provider_token($1, 'shopify')", [tenantB]),
    ).toEqual([]);
    const secrets = await db.query("select 1 from vault.secrets where name like '%' || $1", [
      connB,
    ]);
    expect(secrets.rows).toHaveLength(0);
    // Tenant A's token is still there.
    expect(
      await service("select * from public.get_provider_token($1, 'shopify')", [tenantA]),
    ).toHaveLength(1);

    const jobs = await db.query<{ status: string }>(
      "select status from public.sync_jobs where connection_id = $1 and status in ('queued', 'running')",
      [connB],
    );
    expect(jobs.rows).toHaveLength(0);

    const routed = await service<{ r: string }>(
      "select public.enqueue_provider_webhook('shopify', 'bob.myshopify.com', 'orders/create', 'late', '{}'::jsonb) as r",
    );
    expect(routed[0].r).toBe("unknown_account");
    expect(
      (await service<{ ok: boolean }>("select public.enqueue_sync($1) as ok", [connB]))[0].ok,
    ).toBe(false);

    const log = await db.query<{ action: string }>(
      "select action from public.audit_log where tenant_id = $1 and action like 'connection.%' order by id",
      [tenantB],
    );
    expect(log.rows.map((r) => r.action)).toEqual([
      "connection.connected",
      "connection.disconnected",
    ]);
  });

  it("reconnecting brings the same connection back with fresh tokens and a full sync", async () => {
    const again = await connect(tenantB, "shopify", "bob.myshopify.com", TOKEN_B, bob);
    expect(again).toBe(connB);
    const rows = await service<{ status: string; token: object }>(
      "select status, token from public.get_provider_token($1, 'shopify')",
      [tenantB],
    );
    expect(rows[0]).toMatchObject({ status: "active", token: TOKEN_B });
    const jobs = await db.query(
      "select 1 from public.sync_jobs where connection_id = $1 and type = 'full' and status = 'queued'",
      [connB],
    );
    expect(jobs.rows).toHaveLength(1);
  });

  it("tells the worker who owns the workspace", async () => {
    expect(await service("select email from public.tenant_owner_emails($1)", [tenantA])).toEqual([
      { email: "alice@a.test" },
    ]);
  });
});
