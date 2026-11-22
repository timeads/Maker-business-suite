import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asUser, createTestDb, createUser } from "./harness";

type Tenant = { id: string; slug: string; name: string };
type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of tenant A
let bob: User; // owner of tenant B
let carol: User; // invited to tenant A as a member
let tenantA: Tenant;
let tenantB: Tenant;

async function user(email: string): Promise<User> {
  return { id: await createUser(db, email), email };
}

async function createTenant(owner: User, name: string): Promise<Tenant> {
  return asUser(db, owner, async (tx) => {
    const { rows } = await tx.query<Tenant>(
      "select * from public.create_tenant($1, 'America/New_York', 'USD')",
      [name],
    );
    return rows[0];
  });
}

async function invite(by: User, tenantId: string, email: string, role = "member") {
  return asUser(db, by, async (tx) => {
    const { rows } = await tx.query<{ invite_id: string; token: string }>(
      "select * from public.create_invite($1, $2, $3::public.membership_role)",
      [tenantId, email, role],
    );
    return rows[0];
  });
}

beforeAll(async () => {
  db = await createTestDb();
  alice = await user("alice@a.test");
  bob = await user("bob@b.test");
  carol = await user("carol@a.test");
  tenantA = await createTenant(alice, "Alice Rugs");
  tenantB = await createTenant(bob, "Bob Pottery");
  // Give tenant B some rows in every table so there is something to leak.
  await invite(bob, tenantB.id, "friend@b.test");
});

describe("schema rules", () => {
  it("every public table has RLS on and (except tenants) a tenant_id", async () => {
    const { rows } = await db.query<{ table: string; rls: boolean; has_tenant_id: boolean }>(`
      select c.relname as "table", c.relrowsecurity as rls,
        exists (select 1 from pg_attribute a
                where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped) as has_tenant_id
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'`);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) {
      expect(row.rls, `${row.table} must have RLS enabled`).toBe(true);
      if (row.table !== "tenants") {
        expect(row.has_tenant_id, `${row.table} must have tenant_id`).toBe(true);
      }
    }
  });
});

describe("cross-tenant isolation", () => {
  it("user A cannot read tenant B's rows in any table", async () => {
    await asUser(db, alice, async (tx) => {
      const tenants = await tx.query<Tenant>("select id from public.tenants");
      expect(tenants.rows.map((r) => r.id)).toEqual([tenantA.id]);

      for (const table of ["memberships", "invites", "audit_log"]) {
        const { rows } = await tx.query<{ tenant_id: string }>(
          `select tenant_id from public.${table}`,
        );
        expect(rows.length, `${table} should show A's own rows`).toBeGreaterThanOrEqual(0);
        expect(
          rows.every((r) => r.tenant_id === tenantA.id),
          `${table} leaked another tenant's rows`,
        ).toBe(true);
      }

      // Asking for B by id directly is no different.
      const direct = await tx.query("select 1 from public.tenants where id = $1", [tenantB.id]);
      expect(direct.rows).toHaveLength(0);
      const members = await tx.query("select * from public.list_members($1)", [tenantB.id]);
      expect(members.rows).toHaveLength(0);
    });
  });

  it("tenant B really does have rows to hide (the test above is not vacuous)", async () => {
    await asUser(db, bob, async (tx) => {
      for (const table of ["tenants", "memberships", "invites", "audit_log"]) {
        const { rows } = await tx.query(`select 1 from public.${table}`);
        expect(rows.length, `${table} should have rows for B`).toBeGreaterThan(0);
      }
    });
  });

  it("user A cannot change tenant B", async () => {
    await asUser(db, alice, async (tx) => {
      const res = await tx.query("update public.tenants set name = 'Hacked' where id = $1", [
        tenantB.id,
      ]);
      expect(res.affectedRows).toBe(0);
    });
    await expect(invite(alice, tenantB.id, "mole@a.test")).rejects.toThrow(/owners and admins/i);

    const { rows } = await db.query<Tenant>("select name from public.tenants where id = $1", [
      tenantB.id,
    ]);
    expect(rows[0].name).toBe("Bob Pottery");
  });

  it("user A cannot revoke tenant B's invites", async () => {
    const { rows } = await db.query<{ id: string }>(
      "select id from public.invites where tenant_id = $1",
      [tenantB.id],
    );
    await expect(
      asUser(db, alice, (tx) => tx.query("select public.revoke_invite($1)", [rows[0].id])),
    ).rejects.toThrow(/not found/i);
  });

  it("clients cannot write tenancy tables directly", async () => {
    const attempts = [
      `insert into public.tenants (name, slug, timezone, currency) values ('X', 'xx', 'UTC', 'USD')`,
      `insert into public.memberships (tenant_id, user_id, role) values ('${tenantB.id}', '${alice.id}', 'owner')`,
      `update public.memberships set role = 'owner' where user_id = '${alice.id}'`,
      `delete from public.memberships where tenant_id = '${tenantA.id}'`,
      `insert into public.audit_log (tenant_id, action) values ('${tenantA.id}', 'fake')`,
      `delete from public.audit_log`,
      `update public.tenants set slug = 'stolen' where id = '${tenantA.id}'`,
      `select token_hash from public.invites`,
    ];
    for (const sql of attempts) {
      await expect(
        asUser(db, alice, (tx) => tx.query(sql)),
        sql,
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it("signed-out visitors can read nothing and call nothing", async () => {
    for (const sql of [
      "select * from public.tenants",
      "select * from public.memberships",
      "select * from public.invites",
      "select * from public.audit_log",
      "select * from public.create_tenant('X', 'UTC', 'USD')",
      "select * from public.get_invite('whatever')",
      "select public.accept_invite('whatever')",
    ]) {
      await expect(
        asAnon(db, (tx) => tx.query(sql)),
        sql,
      ).rejects.toThrow(/permission denied/i);
    }
  });

  it("the audit log is append-only even for the service role", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.exec("set local role service_role");
        await tx.query("delete from public.audit_log");
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("workspaces", () => {
  it("creating one makes the caller its owner and writes an audit entry", async () => {
    await asUser(db, alice, async (tx) => {
      const m = await tx.query<{ role: string }>(
        "select role from public.memberships where tenant_id = $1 and user_id = $2",
        [tenantA.id, alice.id],
      );
      expect(m.rows[0].role).toBe("owner");
      const log = await tx.query<{ action: string }>(
        "select action from public.audit_log where tenant_id = $1 order by id",
        [tenantA.id],
      );
      expect(log.rows[0].action).toBe("tenant.created");
    });
    expect(tenantA.slug).toBe("alice-rugs");
  });

  it("gives a second workspace with the same name its own address", async () => {
    const dupe = await createTenant(bob, "Alice Rugs");
    expect(dupe.slug).toMatch(/^alice-rugs-[a-z0-9]{5}$/);
  });

  it("rejects unknown timezones and malformed currencies", async () => {
    await expect(
      asUser(db, alice, (tx) =>
        tx.query("select * from public.create_tenant('T', 'Mars/Olympus', 'USD')"),
      ),
    ).rejects.toThrow(/unknown timezone/i);
    await expect(
      asUser(db, alice, (tx) =>
        tx.query("select * from public.create_tenant('T', 'UTC', 'DOLLARS')"),
      ),
    ).rejects.toThrow();
  });
});

describe("invites", () => {
  it("runs end to end: invite, wrong person refused, right person joins, link is single-use", async () => {
    const { token } = await invite(alice, tenantA.id, "Carol@A.test");

    // Bob holds the link but it wasn't sent to him.
    await expect(
      asUser(db, bob, (tx) => tx.query("select public.accept_invite($1)", [token])),
    ).rejects.toThrow(/different email/i);

    // Before accepting, Carol sees nothing of tenant A.
    await asUser(db, carol, async (tx) => {
      expect((await tx.query("select 1 from public.tenants")).rows).toHaveLength(0);
      const preview = await tx.query<{ tenant_name: string; status: string }>(
        "select * from public.get_invite($1)",
        [token],
      );
      expect(preview.rows[0]).toMatchObject({ tenant_name: "Alice Rugs", status: "open" });
    });

    const slug = await asUser(db, carol, async (tx) => {
      const { rows } = await tx.query<{ accept_invite: string }>(
        "select public.accept_invite($1)",
        [token],
      );
      return rows[0].accept_invite;
    });
    expect(slug).toBe(tenantA.slug);

    await asUser(db, carol, async (tx) => {
      const tenants = await tx.query<Tenant>("select id from public.tenants");
      expect(tenants.rows.map((r) => r.id)).toEqual([tenantA.id]);
      const roster = await tx.query<{ email: string; role: string }>(
        "select email, role from public.list_members($1)",
        [tenantA.id],
      );
      expect(roster.rows).toEqual([
        { email: "alice@a.test", role: "owner" },
        { email: "carol@a.test", role: "member" },
      ]);
    });

    await expect(
      asUser(db, carol, (tx) => tx.query("select public.accept_invite($1)", [token])),
    ).rejects.toThrow(/already been used/i);
  });

  it("plain members cannot see invites or the audit log, edit the workspace, or invite", async () => {
    await asUser(db, carol, async (tx) => {
      expect((await tx.query("select id from public.invites")).rows).toHaveLength(0);
      expect((await tx.query("select id from public.audit_log")).rows).toHaveLength(0);
      const res = await tx.query("update public.tenants set name = 'Carol Rugs'");
      expect(res.affectedRows).toBe(0);
    });
    await expect(invite(carol, tenantA.id, "pal@a.test")).rejects.toThrow(/owners and admins/i);
  });

  it("refuses expired and revoked invites, and inviting existing teammates", async () => {
    const dave = await user("dave@a.test");

    const expired = await invite(alice, tenantA.id, dave.email);
    await db.query(
      "update public.invites set expires_at = now() - interval '1 minute' where id = $1",
      [expired.invite_id],
    );
    await expect(
      asUser(db, dave, (tx) => tx.query("select public.accept_invite($1)", [expired.token])),
    ).rejects.toThrow(/expired/i);

    const revoked = await invite(alice, tenantA.id, dave.email);
    await asUser(db, alice, (tx) =>
      tx.query("select public.revoke_invite($1)", [revoked.invite_id]),
    );
    await expect(
      asUser(db, dave, (tx) => tx.query("select public.accept_invite($1)", [revoked.token])),
    ).rejects.toThrow(/withdrawn/i);

    await expect(invite(alice, tenantA.id, carol.email)).rejects.toThrow(/already on the team/i);
    await expect(invite(alice, tenantA.id, dave.email, "owner")).rejects.toThrow();
  });

  it("a new invite to the same address replaces the old link", async () => {
    const erin = await user("erin@a.test");
    const first = await invite(alice, tenantA.id, erin.email);
    const second = await invite(alice, tenantA.id, erin.email, "admin");
    await expect(
      asUser(db, erin, (tx) => tx.query("select public.accept_invite($1)", [first.token])),
    ).rejects.toThrow(/withdrawn/i);
    await asUser(db, erin, (tx) => tx.query("select public.accept_invite($1)", [second.token]));
    // Admins can see invites and the audit log.
    await asUser(db, erin, async (tx) => {
      expect((await tx.query("select id from public.invites")).rows.length).toBeGreaterThan(0);
      expect((await tx.query("select id from public.audit_log")).rows.length).toBeGreaterThan(0);
    });
  });
});

describe("invites waiting for a signed-in person", () => {
  it("shows a person the invites sent to their email, and nobody else's", async () => {
    const frank = await user("frank@a.test");
    const { invite_id } = await invite(alice, tenantA.id, "Frank@A.test", "admin");
    await invite(bob, tenantB.id, "someone-else@b.test");

    const pending = (who: User) =>
      asUser(db, who, async (tx) => {
        const { rows } = await tx.query<{ invite_id: string; tenant_name: string; role: string }>(
          "select invite_id, tenant_name, role from public.my_pending_invites()",
        );
        return rows;
      });

    expect(await pending(frank)).toEqual([{ invite_id, tenant_name: "Alice Rugs", role: "admin" }]);
    expect(await pending(bob)).toEqual([]);

    // Bob knows the id but it isn't his invite.
    await expect(
      asUser(db, bob, (tx) => tx.query("select public.accept_invite_by_id($1)", [invite_id])),
    ).rejects.toThrow(/not valid/i);

    const slug = await asUser(db, frank, async (tx) => {
      const { rows } = await tx.query<{ s: string }>("select public.accept_invite_by_id($1) as s", [
        invite_id,
      ]);
      return rows[0].s;
    });
    expect(slug).toBe(tenantA.slug);
    expect(await pending(frank)).toEqual([]);
    await asUser(db, frank, async (tx) => {
      const m = await tx.query<{ role: string }>(
        "select role from public.memberships where user_id = $1",
        [frank.id],
      );
      expect(m.rows).toEqual([{ role: "admin" }]);
    });
    await expect(
      asUser(db, frank, (tx) => tx.query("select public.accept_invite_by_id($1)", [invite_id])),
    ).rejects.toThrow(/already been used/i);
  });

  it("hides expired and withdrawn invites, and signed-out visitors can't ask", async () => {
    const gina = await user("gina@a.test");
    const expired = await invite(alice, tenantA.id, gina.email);
    await db.query(
      "update public.invites set expires_at = now() - interval '1 minute' where id = $1",
      [expired.invite_id],
    );
    await asUser(db, gina, async (tx) => {
      expect((await tx.query("select * from public.my_pending_invites()")).rows).toEqual([]);
    });
    await expect(
      asUser(db, gina, (tx) =>
        tx.query("select public.accept_invite_by_id($1)", [expired.invite_id]),
      ),
    ).rejects.toThrow(/expired/i);
    await expect(
      asAnon(db, (tx) => tx.query("select * from public.my_pending_invites()")),
    ).rejects.toThrow(/permission denied/i);
  });
});
