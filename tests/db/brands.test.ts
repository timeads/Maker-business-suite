import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrationsAfter,
  asUser,
  createTestDb,
  createTestDbUntil,
  createUser,
} from "./harness";

type User = { id: string; email: string };
type BrandRow = {
  id: string;
  name: string;
  slug: string;
  kit_key: string;
  is_default: boolean;
  archived_at: string | null;
};

const KIT = {
  version: 1,
  name: "Studio A",
  colors: [
    { name: "ink", hex: "#1f2a2e" },
    { name: "paper", hex: "#f7f3ea" },
  ],
};

function as<T>(db: PGlite, user: User, sql: string, params: unknown[] = []): Promise<T[]> {
  return asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);
}

describe("brands", () => {
  let db: PGlite;
  let owner: User;
  let member: User;
  let other: User;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    db = await createTestDb();
    owner = { id: await createUser(db, "owner@a.test"), email: "owner@a.test" };
    member = { id: await createUser(db, "member@a.test"), email: "member@a.test" };
    other = { id: await createUser(db, "other@b.test"), email: "other@b.test" };
    tenantA = (
      await as<{ id: string }>(
        db,
        owner,
        "select id from public.create_tenant('Studio A', 'UTC', 'USD')",
      )
    )[0].id;
    tenantB = (
      await as<{ id: string }>(
        db,
        other,
        "select id from public.create_tenant('Studio B', 'UTC', 'USD')",
      )
    )[0].id;
    await db.query(
      "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
      [tenantA, member.id],
    );
  });
  afterAll(() => db.close());

  const brands = (user: User, tenant: string) =>
    as<BrandRow>(
      db,
      user,
      "select * from public.brands where tenant_id = $1 order by created_at, name",
      [tenant],
    );

  it("a new workspace starts with one main brand on the first kit key", async () => {
    const rows = await brands(owner, tenantA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Studio A", kit_key: "kit", is_default: true });
  });

  it("members read their own brands and nobody else's", async () => {
    expect(await brands(member, tenantA)).toHaveLength(1);
    expect(await brands(other, tenantA)).toHaveLength(0);
    const all = await as<{ tenant_id: string }>(db, other, "select tenant_id from public.brands");
    expect(all.every((row) => row.tenant_id === tenantB)).toBe(true);
  });

  it("clients can't write the table directly", async () => {
    await expect(
      as(
        db,
        owner,
        "insert into public.brands (tenant_id, name, slug, kit_key) values ($1, 'X', 'x', 'kit-00000000-0000-0000-0000-000000000000')",
        [tenantA],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(db, owner, "delete from public.brands where tenant_id = $1", [tenantA]),
    ).rejects.toThrow(/permission denied/);
  });

  it("owners add a brand whose kit is its own setting, with a version row", async () => {
    const [{ id }] = await as<{ id: string }>(
      db,
      owner,
      "select public.add_brand($1, 'Second Site', $2::jsonb) as id",
      [tenantA, JSON.stringify(KIT)],
    );
    const added = (await brands(owner, tenantA)).find((row) => row.id === id)!;
    expect(added).toMatchObject({ slug: "second-site", kit_key: `kit-${id}`, is_default: false });
    const [kit] = await as<{ body: { name: string } }>(
      db,
      owner,
      "select body from public.configs where tenant_id = $1 and module = 'brand' and key = $2",
      [tenantA, `kit-${id}`],
    );
    expect(kit.body.name).toBe("Second Site");
    const [versions] = await as<{ n: number }>(
      db,
      owner,
      "select count(*)::int as n from public.config_versions where tenant_id = $1 and key = $2",
      [tenantA, `kit-${id}`],
    );
    expect(versions.n).toBe(1);
  });

  it("members and other workspaces can't add, rename or change brands", async () => {
    await expect(
      as(db, member, "select public.add_brand($1, 'Nope', $2::jsonb)", [
        tenantA,
        JSON.stringify(KIT),
      ]),
    ).rejects.toThrow(/Only owners and admins/);
    const [main] = await brands(owner, tenantA);
    await expect(
      as(db, other, "select public.rename_brand($1, $2, 'Taken')", [tenantA, main.id]),
    ).rejects.toThrow(/Only owners and admins/);
    // Naming another workspace's brand from your own finds nothing.
    await expect(
      as(db, other, "select public.rename_brand($1, $2, 'Taken')", [tenantB, main.id]),
    ).rejects.toThrow(/Brand not found/);
    await expect(
      as(db, other, "select public.set_default_brand($1, $2)", [tenantB, main.id]),
    ).rejects.toThrow(/Brand not found/);
  });

  it("renaming keeps the kit's name in step, as a new version", async () => {
    const second = (await brands(owner, tenantA)).find((row) => !row.is_default)!;
    await as(db, owner, "select public.rename_brand($1, $2, 'History Site')", [tenantA, second.id]);
    const [kit] = await as<{ body: { name: string } }>(
      db,
      owner,
      "select body from public.configs where tenant_id = $1 and key = $2",
      [tenantA, second.kit_key],
    );
    expect(kit.body.name).toBe("History Site");
    const renamed = (await brands(owner, tenantA)).find((row) => row.id === second.id)!;
    expect(renamed.slug).toBe("history-site");
  });

  it("save_brand_kit writes the named brand's kit, or the main one's", async () => {
    await as(db, owner, "select public.save_brand_kit($1, null, $2::jsonb)", [
      tenantA,
      JSON.stringify({ ...KIT, name: "Studio A Rugs" }),
    ]);
    const [kit] = await as<{ body: { name: string } }>(
      db,
      owner,
      "select body from public.configs where tenant_id = $1 and module = 'brand' and key = 'kit'",
      [tenantA],
    );
    expect(kit.body.name).toBe("Studio A Rugs");
    const main = (await brands(owner, tenantA)).find((row) => row.is_default)!;
    expect(main.name).toBe("Studio A Rugs");
  });

  it("one main brand at a time; the main one can't be put away; nothing is deleted", async () => {
    const [main, second] = await brands(owner, tenantA);
    await expect(
      as(db, owner, "select public.archive_brand($1, $2, true)", [tenantA, main.id]),
    ).rejects.toThrow(/default_brand/);
    await as(db, owner, "select public.set_default_brand($1, $2)", [tenantA, second.id]);
    const after = await brands(owner, tenantA);
    expect(after.filter((row) => row.is_default).map((row) => row.id)).toEqual([second.id]);
    // The first kit key stays where it was: readers of brand / kit still find it.
    expect(after.find((row) => row.id === main.id)!.kit_key).toBe("kit");
    await as(db, owner, "select public.archive_brand($1, $2, true)", [tenantA, main.id]);
    const archived = (await brands(owner, tenantA)).find((row) => row.id === main.id)!;
    expect(archived.archived_at).not.toBeNull();
    await expect(
      as(db, owner, "select public.set_default_brand($1, $2)", [tenantA, main.id]),
    ).rejects.toThrow(/Brand not found/);
    await as(db, owner, "select public.archive_brand($1, $2, false)", [tenantA, main.id]);
    await as(db, owner, "select public.set_default_brand($1, $2)", [tenantA, main.id]);
    expect((await brands(owner, tenantA)).find((row) => row.is_default)!.id).toBe(main.id);
  });
});

describe("brands: an existing workspace, migrated in place", () => {
  const LAST_BEFORE = "20270127000100_social_sizes.sql";
  let db: PGlite;

  beforeAll(async () => {
    db = await createTestDbUntil(LAST_BEFORE);
    const owner = await createUser(db, "old@a.test");
    await db.query(
      `insert into public.tenants (id, slug, name, timezone, currency)
       values ('11111111-1111-1111-1111-111111111111', 'kit-shop', 'Kit Shop', 'UTC', 'USD'),
              ('22222222-2222-2222-2222-222222222222', 'no-kit', 'No Kit Yet', 'UTC', 'USD')`,
    );
    await db.query(
      `insert into public.memberships (tenant_id, user_id, role)
       values ('11111111-1111-1111-1111-111111111111', $1, 'owner')`,
      [owner],
    );
    await db.query(
      `insert into public.configs (tenant_id, module, key, body)
       values ('11111111-1111-1111-1111-111111111111', 'brand', 'kit', $1::jsonb)`,
      [JSON.stringify({ ...KIT, name: "The Kit's Own Name" })],
    );
    await applyMigrationsAfter(db, LAST_BEFORE);
  });
  afterAll(() => db.close());

  it("every workspace gets one main brand, named by its kit where it has one", async () => {
    const { rows } = await db.query<BrandRow & { tenant_id: string }>(
      "select * from public.brands order by tenant_id",
    );
    expect(rows.map((row) => [row.tenant_id, row.name, row.kit_key, row.is_default])).toEqual([
      ["11111111-1111-1111-1111-111111111111", "The Kit's Own Name", "kit", true],
      ["22222222-2222-2222-2222-222222222222", "No Kit Yet", "kit", true],
    ]);
  });
});
