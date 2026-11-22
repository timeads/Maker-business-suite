import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };

let db: PGlite;
let alice: User;
let bob: User;
let mia: User;
let tenantA: string;

async function tenantFor(owner: User, name: string): Promise<string> {
  return asUser(db, owner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select id from public.create_tenant($1, 'UTC', 'USD')",
      [name],
    );
    return rows[0].id;
  });
}

const propose = (user: User, tenant: string, body: object, summary = "Add a question") =>
  asUser(db, user, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select public.propose_config_change($1, 'bookings', 'booking_form', $2, $3) as id",
      [tenant, JSON.stringify(body), summary],
    );
    return rows[0].id;
  });

const currentBody = async (tenant: string) =>
  (
    await db.query<{ body: unknown }>(
      "select body from public.configs where tenant_id = $1 and module = 'bookings' and key = 'booking_form'",
      [tenant],
    )
  ).rows[0]?.body;

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  mia = { id: await createUser(db, "mia@a.test"), email: "mia@a.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  await tenantFor(bob, "Bob Pottery");
  // Mia is a plain member of Alice's workspace.
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, mia.id],
  );
});

describe("versions", () => {
  it("every save leaves a numbered version behind", async () => {
    for (const n of [1, 2]) {
      await asUser(db, alice, (tx) =>
        tx.query("select public.save_config($1, 'bookings', 'booking_form', $2)", [
          tenantA,
          JSON.stringify({ version: 1, n }),
        ]),
      );
    }
    const { rows } = await db.query<{ version: number; source: string }>(
      "select version, source from public.config_versions where tenant_id = $1 order by version",
      [tenantA],
    );
    expect(rows).toEqual([
      { version: 1, source: "manual" },
      { version: 2, source: "manual" },
    ]);
  });

  it("an earlier version can be put back, as a new version", async () => {
    const { rows } = await db.query<{ id: string }>(
      "select id from public.config_versions where tenant_id = $1 and version = 1",
      [tenantA],
    );
    await expect(
      asUser(db, mia, (tx) => tx.query("select public.restore_config_version($1)", [rows[0].id])),
    ).rejects.toThrow(/Only owners and admins/);
    const restored = await asUser(db, alice, (tx) =>
      tx.query<{ v: number }>("select public.restore_config_version($1) as v", [rows[0].id]),
    );
    expect(restored.rows[0].v).toBe(3);
    expect(await currentBody(tenantA)).toEqual({ version: 1, n: 1 });
  });
});

describe("proposals", () => {
  it("a proposal changes nothing until an owner or admin applies it, once", async () => {
    const before = await currentBody(tenantA);
    const id = await propose(mia, tenantA, { version: 1, questions: [] }, "Clear the questions");
    expect(await currentBody(tenantA)).toEqual(before);

    await expect(
      asUser(db, mia, (tx) => tx.query("select public.apply_config_proposal($1)", [id])),
    ).rejects.toThrow(/Only owners and admins/);
    expect(await currentBody(tenantA)).toEqual(before);

    await asUser(db, alice, (tx) => tx.query("select public.apply_config_proposal($1)", [id]));
    expect(await currentBody(tenantA)).toEqual({ version: 1, questions: [] });
    const { rows } = await db.query<{ source: string; note: string }>(
      "select source, note from public.config_versions where tenant_id = $1 order by version desc limit 1",
      [tenantA],
    );
    expect(rows[0]).toEqual({ source: "assistant", note: "Clear the questions" });

    await expect(
      asUser(db, alice, (tx) => tx.query("select public.apply_config_proposal($1)", [id])),
    ).rejects.toThrow(/already_decided/);
  });

  it("a dismissed proposal can't be applied", async () => {
    const id = await propose(mia, tenantA, { version: 1, questions: [] });
    await asUser(db, mia, (tx) => tx.query("select public.dismiss_config_proposal($1)", [id]));
    await expect(
      asUser(db, alice, (tx) => tx.query("select public.apply_config_proposal($1)", [id])),
    ).rejects.toThrow(/already_decided/);
  });

  it("stays inside its workspace", async () => {
    const id = await propose(alice, tenantA, { version: 1, questions: [] });
    await expect(propose(bob, tenantA, { x: 1 })).rejects.toThrow(/Workspace not found/);
    await expect(
      asUser(db, bob, (tx) => tx.query("select public.apply_config_proposal($1)", [id])),
    ).rejects.toThrow(/Proposal not found/);
    await asUser(db, bob, (tx) => tx.query("select public.dismiss_config_proposal($1)", [id]));
    const { rows } = await db.query<{ status: string }>(
      "select status from public.config_proposals where id = $1",
      [id],
    );
    expect(rows[0].status).toBe("pending");

    for (const table of ["config_versions", "config_proposals"]) {
      const mine = await asUser(db, alice, (tx) => tx.query(`select id from public.${table}`));
      const theirs = await asUser(db, bob, (tx) => tx.query(`select id from public.${table}`));
      expect(mine.rows.length, table).toBeGreaterThan(0);
      expect(theirs.rows.length, table).toBe(0);
      await expect(
        asAnon(db, (tx) => tx.query(`select id from public.${table}`)),
        table,
      ).rejects.toThrow(/permission denied/);
      await expect(
        asUser(db, alice, (tx) => tx.query(`update public.${table} set module = 'x'`)),
        table,
      ).rejects.toThrow(/permission denied/);
    }
  });
});
