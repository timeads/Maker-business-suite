import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };

let db: PGlite;
let root: User; // the platform admin: belongs to no workspace
let alice: User; // owner of workspace A
let bob: User; // owner of workspace B
let tenantA: string;
let tenantB: string;
let connA: string;

const DENIED = { code: "42501" };

async function tenantFor(owner: User, name: string): Promise<string> {
  return asUser(db, owner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select id from public.create_tenant($1, 'UTC', 'USD')",
      [name],
    );
    return rows[0].id;
  });
}

function as<T>(user: User, sql: string, params: unknown[] = []): Promise<T[]> {
  return asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);
}

/** Every admin function, with arguments that would work for an admin. */
function adminCalls(): string[] {
  return [
    "select * from public.admin_list_workspaces()",
    `select public.admin_workspace('${tenantA}')`,
    "select * from public.admin_health()",
    `select public.admin_set_plan_grant('${tenantA}', 'studio', null, 'let me in')`,
    `select public.admin_end_plan_grant('${tenantA}', 'because')`,
    `select public.admin_requeue_sync('${connA}')`,
    "select private.require_platform_admin()",
  ];
}

const PRIVATE_READS = [
  "select * from private.platform_admins",
  "select * from private.admin_audit",
  "select * from public.plan_grants",
  "select tenant_id from public.plan_grants",
];

beforeAll(async () => {
  db = await createTestDb();
  root = { id: await createUser(db, "root@suite.test"), email: "root@suite.test" };
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");

  // By hand, as the operator would (docs/admin.md).
  await db.query("insert into private.platform_admins (user_id, note) values ($1, 'test')", [
    root.id,
  ]);

  await asService(db, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `select public.save_connection($1, 'shopify', 'alice.myshopify.com', 'Alice store',
         array['read_orders'], '{"access_token":"TOKEN-SECRET-A"}'::jsonb, $2) as id`,
      [tenantA, alice.id],
    );
    connA = rows[0].id;
    await tx.query(
      `select public.save_connection($1, 'quickbooks', 'realm-b', 'Bob books', '{}',
         '{"access_token":"TOKEN-SECRET-B"}'::jsonb, $2)`,
      [tenantB, bob.id],
    );
    await tx.query(
      `insert into public.subscriptions
         (tenant_id, stripe_customer_id, stripe_subscription_id, plan, status, trial_end)
       values ($1, 'cus_a', 'sub_a', 'starter', 'trialing', now() + interval '5 days'),
              ($2, 'cus_b', 'sub_b', 'growth', 'past_due', null)`,
      [tenantA, tenantB],
    );
    await tx.query(
      "insert into public.usage_events (tenant_id, type, quantity) values ($1, 'ai_tokens', 700), ($1, 'ai_tokens', 50), ($1, 'sync_calls', 9)",
      [tenantA],
    );
    await tx.query(
      `select public.enqueue_provider_webhook('shopify', 'alice.myshopify.com', 'orders/create',
         'd1', '{"shopper":"SHOPPER-NAME-A","address":"1 Secret Street"}'::jsonb)`,
    );
  });

  // Workspace A's first sync finished; B's failed and its connection needs
  // reconnecting; one of B's jobs has sat on the queue for two hours.
  await db.exec(`
    update public.sync_jobs set status = 'succeeded', finished_at = now()
      where tenant_id = '${tenantA}' and type = 'full';
    update public.connections set last_synced_at = now() where tenant_id = '${tenantA}';
    update public.sync_jobs set status = 'failed', error = 'refresh token revoked', finished_at = now()
      where tenant_id = '${tenantB}';
    update public.connections set status = 'needs_reconnect', last_error = 'refresh token revoked'
      where tenant_id = '${tenantB}';
    insert into public.sync_jobs (tenant_id, connection_id, provider, type, run_after)
      select tenant_id, id, provider, 'webhook', now() - interval '2 hours'
      from public.connections where tenant_id = '${tenantB}';
    insert into private.stripe_events (id, type, payload, received_at)
      values ('evt_old', 'x', '{}', now() - interval '20 minutes'), ('evt_new', 'x', '{}', now());
    insert into private.inbound_emails (id, payload, received_at)
      values ('mail_old', '{"text":"TICKET-TEXT"}', now() - interval '20 minutes');
  `);
});

describe("who gets in", () => {
  it("answers is_platform_admin only for the caller", async () => {
    expect(await as(root, "select public.is_platform_admin() as yes")).toEqual([{ yes: true }]);
    expect(await as(alice, "select public.is_platform_admin() as yes")).toEqual([{ yes: false }]);
    await expect(
      asAnon(db, (tx) => tx.query("select public.is_platform_admin()")),
    ).rejects.toMatchObject(DENIED);
  });

  it("refuses every admin function to a workspace owner, to anon and to the service role", async () => {
    for (const sql of adminCalls()) {
      await expect(as(alice, sql), `owner: ${sql}`).rejects.toMatchObject(DENIED);
      await expect(
        asAnon(db, (tx) => tx.query(sql)),
        `anon: ${sql}`,
      ).rejects.toMatchObject(DENIED);
      await expect(
        asService(db, (tx) => tx.query(sql)),
        `service: ${sql}`,
      ).rejects.toMatchObject(DENIED);
    }
    // Nothing was written by the refused calls.
    const { rows } = await db.query("select 1 from public.plan_grants");
    expect(rows).toHaveLength(0);
    const audit = await db.query("select 1 from private.admin_audit");
    expect(audit.rows).toHaveLength(0);
  });

  it("lets no client read the private tables, admin or not", async () => {
    for (const sql of PRIVATE_READS) {
      await expect(as(alice, sql), `owner: ${sql}`).rejects.toMatchObject(DENIED);
      await expect(as(root, sql), `admin: ${sql}`).rejects.toMatchObject(DENIED);
      await expect(
        asAnon(db, (tx) => tx.query(sql)),
        `anon: ${sql}`,
      ).rejects.toMatchObject(DENIED);
    }
    for (const sql of [
      `insert into private.platform_admins (user_id) values ('${alice.id}')`,
      `insert into public.plan_grants (tenant_id, plan, note) values ('${tenantA}', 'studio', 'x')`,
      "delete from private.admin_audit",
    ]) {
      await expect(as(alice, sql), sql).rejects.toMatchObject(DENIED);
      await expect(as(root, sql), sql).rejects.toMatchObject(DENIED);
    }
  });
});

describe("what an admin sees", () => {
  it("lists every workspace with operational facts only", async () => {
    const rows = await as<Record<string, unknown>>(
      root,
      "select * from public.admin_list_workspaces()",
    );
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        "ai_tokens_month",
        "cancel_at_period_end",
        "connections",
        "created_at",
        "current_period_end",
        "failed_jobs_7d",
        "grant_ends_at",
        "grant_plan",
        "last_synced_at",
        "member_count",
        "name",
        "owner_email",
        "plan",
        "slug",
        "status",
        "tenant_id",
        "trial_end",
      ].sort(),
    );

    const a = rows.find((r) => r.tenant_id === tenantA)!;
    expect(a).toMatchObject({
      name: "Alice Rugs",
      owner_email: "alice@a.test",
      member_count: 1,
      plan: "starter",
      status: "trialing",
      grant_plan: null,
      connections: [{ provider: "shopify", health: "active" }],
      failed_jobs_7d: 0,
    });
    expect(Number(a.ai_tokens_month)).toBe(750);
    expect(a.last_synced_at).not.toBeNull();

    const b = rows.find((r) => r.tenant_id === tenantB)!;
    expect(b).toMatchObject({
      owner_email: "bob@b.test",
      status: "past_due",
      connections: [{ provider: "quickbooks", health: "needs reconnect" }],
      failed_jobs_7d: 1,
      last_synced_at: null,
    });
  });

  it("shows one workspace in full, without tokens, payloads or what customers wrote", async () => {
    const [{ doc }] = await as<{ doc: Record<string, unknown> }>(
      root,
      "select public.admin_workspace($1) as doc",
      [tenantA],
    );
    expect(Object.keys(doc).sort()).toEqual(
      [
        "ai_tokens_month",
        "audit",
        "connections",
        "counts",
        "failed_jobs_7d",
        "grant",
        "jobs",
        "members",
        "subscription",
        "workspace",
      ].sort(),
    );
    expect(doc.members).toMatchObject([{ email: "alice@a.test", role: "owner" }]);
    expect(doc.subscription).toMatchObject({
      plan: "starter",
      status: "trialing",
      stripe_customer_id: "cus_a",
      stripe_subscription_id: "sub_a",
    });
    expect(doc.grant).toBeNull();
    const connections = doc.connections as Record<string, unknown>[];
    expect(Object.keys(connections[0]).sort()).toEqual(
      ["connected_at", "health", "id", "last_error", "last_synced_at", "provider", "status"].sort(),
    );
    const jobs = doc.jobs as Record<string, unknown>[];
    expect(jobs.length).toBe(2);
    expect(Object.keys(jobs[0]).sort()).toEqual(
      [
        "attempts",
        "created_at",
        "error",
        "finished_at",
        "id",
        "provider",
        "status",
        "topic",
        "type",
      ].sort(),
    );
    expect(Object.keys(doc.counts as object).sort()).toEqual(
      ["bookings", "orders", "parcels", "posts", "stock_items", "tickets"].sort(),
    );

    const text = JSON.stringify(doc);
    for (const secret of ["TOKEN-SECRET", "SHOPPER-NAME", "Secret Street", "alice.myshopify.com"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("answers null for a workspace that doesn't exist", async () => {
    const rows = await as<{ doc: unknown }>(
      root,
      "select public.admin_workspace('00000000-0000-4000-8000-000000000000') as doc",
    );
    expect(rows[0].doc).toBeNull();
  });

  it("adds up the health totals", async () => {
    const [health] = await as<Record<string, number>>(root, "select * from public.admin_health()");
    expect(health).toEqual({
      workspaces: 2,
      trialing: 1,
      paying: 0,
      past_due: 1,
      internal: 0,
      failed_jobs_24h: 1,
      needs_reconnect: 1,
      stuck_jobs: 1,
      stripe_events_waiting: 1,
      inbound_emails_waiting: 1,
    });
  });
});

describe("internal plan grants", () => {
  it("needs a real plan, a note and an end date that hasn't passed", async () => {
    const bad = [
      `select public.admin_set_plan_grant('${tenantA}', 'platinum', null, 'x')`,
      `select public.admin_set_plan_grant('${tenantA}', 'studio', null, '  ')`,
      `select public.admin_set_plan_grant('${tenantA}', 'studio', now() - interval '1 day', 'x')`,
      `select public.admin_set_plan_grant('00000000-0000-4000-8000-000000000000', 'studio', null, 'x')`,
      `select public.admin_end_plan_grant('${tenantA}', '')`,
    ];
    for (const sql of bad) {
      await expect(as(root, sql), sql).rejects.toMatchObject({ code: "22023" });
    }
  });

  it("gives the workspace the plan without touching its subscription, and records who and why", async () => {
    await as(root, "select public.admin_set_plan_grant($1, 'studio', null, 'our own shop')", [
      tenantA,
    ]);

    // The member's resolver sees it; the note stays with us.
    const mine = await as<Record<string, unknown>>(
      alice,
      "select * from public.workspace_plan_grant($1)",
      [tenantA],
    );
    expect(mine).toEqual([{ plan: "studio", ends_at: null, selected_modules: [] }]);

    // Stripe's record is as it was.
    const sub = await db.query(
      "select plan, status from public.subscriptions where tenant_id = $1",
      [tenantA],
    );
    expect(sub.rows).toEqual([{ plan: "starter", status: "trialing" }]);

    const [{ doc }] = await as<{ doc: { grant: unknown; audit: Record<string, unknown>[] } }>(
      root,
      "select public.admin_workspace($1) as doc",
      [tenantA],
    );
    expect(doc.grant).toMatchObject({
      plan: "studio",
      ends_at: null,
      note: "our own shop",
      granted_by: "root@suite.test",
    });
    expect(doc.audit).toHaveLength(1);
    expect(doc.audit[0]).toMatchObject({
      admin_email: "root@suite.test",
      action: "plan_grant.set",
      note: "our own shop",
      details: { plan: "studio", ends_at: null, before: null },
    });

    const [health] = await as<{ internal: number }>(
      root,
      "select internal from public.admin_health()",
    );
    expect(health.internal).toBe(1);
    const list = await as<{ tenant_id: string; grant_plan: string | null }>(
      root,
      "select tenant_id, grant_plan from public.admin_list_workspaces()",
    );
    expect(list.find((r) => r.tenant_id === tenantA)?.grant_plan).toBe("studio");
    expect(list.find((r) => r.tenant_id === tenantB)?.grant_plan).toBeNull();
  });

  it("is cross-tenant safe: another workspace's member learns nothing about the grant", async () => {
    // Bob owns workspace B and asks about A's grant.
    expect(await as(bob, "select * from public.workspace_plan_grant($1)", [tenantA])).toEqual([]);
    await expect(as(bob, "select * from public.plan_grants")).rejects.toMatchObject(DENIED);
    await expect(
      as(bob, `update public.plan_grants set plan = 'studio' where tenant_id = '${tenantA}'`),
    ).rejects.toMatchObject(DENIED);
    // Not vacuous: the row exists and A's own member can learn of it.
    expect(
      await as(alice, "select * from public.workspace_plan_grant($1)", [tenantA]),
    ).toHaveLength(1);
    // The worker reads it with the service role, by workspace.
    const rows = await asService(
      db,
      async (tx) =>
        (await tx.query("select plan from public.plan_grants where tenant_id = $1", [tenantB]))
          .rows,
    );
    expect(rows).toEqual([]);
  });

  it("changes in place, keeping what it was in the record", async () => {
    await as(
      root,
      "select public.admin_set_plan_grant($1, 'starter', now() + interval '30 days', 'smaller, for a month')",
      [tenantA],
    );
    const grants = await db.query("select plan from public.plan_grants where tenant_id = $1", [
      tenantA,
    ]);
    expect(grants.rows).toEqual([{ plan: "starter" }]);
    const audit = await db.query<{ details: { before: { plan: string } } }>(
      "select details from private.admin_audit where tenant_id = $1 order by id desc limit 1",
      [tenantA],
    );
    expect(audit.rows[0].details.before.plan).toBe("studio");
  });

  it("keeps the workspace's own pick of tool on the grant", async () => {
    await as(alice, "select public.choose_modules($1, array['bookings'])", [tenantA]);
    const mine = await as<{ selected_modules: string[] }>(
      alice,
      "select selected_modules from public.workspace_plan_grant($1)",
      [tenantA],
    );
    expect(mine[0].selected_modules).toEqual(["bookings"]);
  });

  it("stops counting once its end date has passed", async () => {
    await db.query(
      "update public.plan_grants set ends_at = now() - interval '1 minute' where tenant_id = $1",
      [tenantA],
    );
    expect(await as(alice, "select * from public.workspace_plan_grant($1)", [tenantA])).toEqual([]);
    const [health] = await as<{ internal: number }>(
      root,
      "select internal from public.admin_health()",
    );
    expect(health.internal).toBe(0);
  });

  it("ends early with a note, and says so when there was nothing to end", async () => {
    expect(
      await as(root, "select public.admin_end_plan_grant($1, 'done with it') as ended", [tenantA]),
    ).toEqual([{ ended: true }]);
    expect(
      await as(root, "select public.admin_end_plan_grant($1, 'again') as ended", [tenantA]),
    ).toEqual([{ ended: false }]);
    const audit = await db.query<{ action: string }>(
      "select action from private.admin_audit where tenant_id = $1 order by id",
      [tenantA],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      "plan_grant.set",
      "plan_grant.set",
      "plan_grant.ended",
    ]);
  });

  it("keeps a granted workspace from being purged when its old subscription ended", async () => {
    await db.query(
      `update public.subscriptions set status = 'canceled', ended_at = now() - interval '40 days',
         purge_after = now() - interval '1 day' where tenant_id = $1`,
      [tenantB],
    );
    await as(root, "select public.admin_set_plan_grant($1, 'growth', null, 'comp')", [tenantB]);
    const purged = await asService(
      db,
      async (tx) =>
        (await tx.query<{ n: number }>("select public.purge_expired_tenants() as n")).rows,
    );
    expect(purged).toEqual([{ n: 0 }]);
    const still = await db.query("select 1 from public.tenants where id = $1", [tenantB]);
    expect(still.rows).toHaveLength(1);
  });
});

describe("asking for a fresh sync", () => {
  it("queues one through enqueue_sync, once, and records each ask", async () => {
    expect(await as(root, "select public.admin_requeue_sync($1) as queued", [connA])).toEqual([
      { queued: true },
    ]);
    // One is waiting now, so a second ask queues nothing.
    expect(
      await as(root, "select public.admin_requeue_sync($1, 'pressed twice') as queued", [connA]),
    ).toEqual([{ queued: false }]);
    const jobs = await db.query(
      "select 1 from public.sync_jobs where connection_id = $1 and type = 'incremental' and status = 'queued'",
      [connA],
    );
    expect(jobs.rows).toHaveLength(1);
    const audit = await db.query<{ details: object; note: string | null }>(
      "select details, note from private.admin_audit where action = 'sync.requeued' order by id",
    );
    expect(audit.rows).toEqual([
      { details: { provider: "shopify", queued: true }, note: null },
      { details: { provider: "shopify", queued: false }, note: "pressed twice" },
    ]);
  });

  it("refuses a connection that doesn't exist", async () => {
    await expect(
      as(root, "select public.admin_requeue_sync('00000000-0000-4000-8000-000000000000')"),
    ).rejects.toMatchObject({ code: "22023" });
  });

  it("keeps the trail after the workspace is gone", async () => {
    await db.query("delete from public.tenants where id = $1", [tenantA]);
    const audit = await db.query<{ n: number }>(
      "select count(*)::int as n from private.admin_audit where tenant_id is null",
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(5);
  });
});
