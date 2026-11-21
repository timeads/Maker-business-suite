import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };

let db: PGlite;
let alice: User;
let bob: User;
let tenantA: string;
let tenantB: string;

async function tenantFor(owner: User, name: string): Promise<string> {
  return asUser(db, owner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select id from public.create_tenant($1, 'UTC', 'USD')",
      [name],
    );
    return rows[0].id;
  });
}

async function subscribe(tenantId: string, n: number, extra = "") {
  await asService(db, (tx) =>
    tx.query(
      `insert into public.subscriptions (tenant_id, stripe_customer_id, stripe_subscription_id, plan, status ${extra ? ", ended_at, purge_after" : ""})
       values ($1, $2, $3, 'growth', ${extra ? "'canceled', now() - interval '40 days', " + extra : "'active'"})`,
      [tenantId, `cus_${n}`, `sub_${n}`],
    ),
  );
}

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
  await subscribe(tenantA, 1);
  await subscribe(tenantB, 2);
  await asService(db, (tx) =>
    tx.query(
      "insert into public.usage_events (tenant_id, type, quantity) values ($1, 'ai_tokens', 100), ($2, 'ai_tokens', 900)",
      [tenantA, tenantB],
    ),
  );
});

describe("cross-tenant isolation for billing tables", () => {
  it("user A sees only tenant A's subscription and usage", async () => {
    await asUser(db, alice, async (tx) => {
      const subs = await tx.query<{ tenant_id: string }>(
        "select tenant_id, plan, status from public.subscriptions",
      );
      expect(subs.rows.map((r) => r.tenant_id)).toEqual([tenantA]);
      const usage = await tx.query<{ tenant_id: string; quantity: number }>(
        "select tenant_id, quantity from public.usage_events",
      );
      expect(usage.rows).toEqual([{ tenant_id: tenantA, quantity: 100 }]);
    });
    // Not vacuous: B's rows exist and B can see them.
    await asUser(db, bob, async (tx) => {
      expect((await tx.query("select 1 from public.subscriptions")).rows).toHaveLength(1);
      expect((await tx.query("select 1 from public.usage_events")).rows).toHaveLength(1);
    });
  });

  it("clients cannot read Stripe ids or write billing data", async () => {
    const attempts = [
      "select stripe_customer_id from public.subscriptions",
      "select * from public.subscriptions",
      "update public.subscriptions set plan = 'studio'",
      `insert into public.subscriptions (tenant_id, stripe_customer_id, stripe_subscription_id, plan, status) values ('${tenantA}', 'cus_x', 'sub_x', 'studio', 'active')`,
      "delete from public.subscriptions",
      `insert into public.usage_events (tenant_id, type, quantity) values ('${tenantA}', 'ai_tokens', 1)`,
      "delete from public.usage_events",
      "select * from private.stripe_events",
      "select public.enqueue_stripe_event('evt_x', 'x', '{}')",
      "select * from public.claim_stripe_events(1)",
      "select public.complete_stripe_event('evt_x')",
      "select public.purge_expired_tenants()",
    ];
    for (const sql of attempts) {
      await expect(
        asUser(db, alice, (tx) => tx.query(sql)),
        sql,
      ).rejects.toThrow(/permission denied/i);
    }
    await expect(
      asAnon(db, (tx) => tx.query("select plan from public.subscriptions")),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("Stripe event queue", () => {
  const enqueue = (id: string) =>
    asService(db, async (tx) => {
      const { rows } = await tx.query<{ ok: boolean }>(
        "select public.enqueue_stripe_event($1, 'customer.subscription.updated', '{\"id\":\"x\"}') as ok",
        [id],
      );
      return rows[0].ok;
    });
  const claim = (limit = 10) =>
    asService(db, async (tx) => {
      const { rows } = await tx.query<{ id: string; attempts: number }>(
        "select id, attempts from public.claim_stripe_events($1)",
        [limit],
      );
      return rows;
    });
  const complete = (id: string, error: string | null = null) =>
    asService(db, (tx) => tx.query("select public.complete_stripe_event($1, $2)", [id, error]));

  it("accepts an event once and reports replays", async () => {
    expect(await enqueue("evt_1")).toBe(true);
    expect(await enqueue("evt_1")).toBe(false);
    expect(await enqueue("evt_2")).toBe(true);
    const { rows } = await db.query("select id from private.stripe_events order by id");
    expect(rows).toEqual([{ id: "evt_1" }, { id: "evt_2" }]);
  });

  it("hands each pending event to one claimer, oldest first", async () => {
    const first = await claim(1);
    expect(first.map((r) => r.id)).toEqual(["evt_1"]);
    const second = await claim(10);
    expect(second.map((r) => r.id)).toEqual(["evt_2"]);
    expect(await claim(10)).toEqual([]);
  });

  it("never hands out a completed event again, and retries a failed one later", async () => {
    await complete("evt_1");
    await complete("evt_2", "Stripe was unreachable");
    expect(await claim()).toEqual([]);

    // Five minutes later the failed event is offered again; the finished one is not.
    await db.query("update private.stripe_events set locked_at = now() - interval '6 minutes'");
    const retry = await claim();
    expect(retry).toEqual([{ id: "evt_2", attempts: 2 }]);
    await complete("evt_2");
    await db.query("update private.stripe_events set locked_at = now() - interval '6 minutes'");
    expect(await claim()).toEqual([]);
  });
});

describe("retention", () => {
  it("deletes only workspaces whose subscription ended and whose window has passed", async () => {
    const carol = { id: await createUser(db, "carol@c.test"), email: "carol@c.test" };
    const dave = { id: await createUser(db, "dave@d.test"), email: "dave@d.test" };
    const expired = await tenantFor(carol, "Gone Studio");
    const inWindow = await tenantFor(dave, "Lapsed Studio");
    await subscribe(expired, 3, "now() - interval '10 days'");
    await subscribe(inWindow, 4, "now() + interval '20 days'");

    const { rows } = await asService(db, (tx) =>
      tx.query<{ n: number }>("select public.purge_expired_tenants() as n"),
    );
    expect(rows[0].n).toBe(1);

    const left = await db.query<{ id: string }>("select id from public.tenants");
    const ids = left.rows.map((r) => r.id);
    expect(ids).not.toContain(expired);
    expect(ids).toEqual(expect.arrayContaining([tenantA, tenantB, inWindow]));
    // Everything belonging to the purged workspace went with it.
    for (const table of ["memberships", "subscriptions", "audit_log"]) {
      const res = await db.query(`select 1 from public.${table} where tenant_id = $1`, [expired]);
      expect(res.rows, table).toHaveLength(0);
    }
  });
});
