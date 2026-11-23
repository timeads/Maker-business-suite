import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };
type Post = { id: string; status: string; results: Record<string, unknown>; error: string | null };

let db: PGlite;
let alice: User;
let bob: User;
let tenantA: string;
let tenantB: string;
let assetA: string;

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

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

async function save(
  user: User,
  tenant: string,
  opts: {
    id?: string;
    caption?: string;
    asset?: string | null;
    channels?: string[];
    at?: string | null;
  } = {},
): Promise<string> {
  return asUser(db, user, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select public.save_social_post($1, $2, $3, $4, $5, $6) as id",
      [
        tenant,
        opts.id ?? null,
        opts.caption ?? "New rugs just landed",
        opts.asset ?? null,
        opts.channels ?? ["facebook"],
        opts.at ?? null,
      ],
    );
    return rows[0].id;
  });
}

const makeDue = (id: string) =>
  db.query(
    "update public.social_posts set scheduled_for = now() - interval '1 minute' where id = $1",
    [id],
  );
const post = async (id: string) =>
  (await db.query<Post>("select * from public.social_posts where id = $1", [id])).rows[0];

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
  const rows = await service<{ id: string }>(
    "select public.register_social_asset($1, $2, 'image/jpeg', 1000, $3) as id",
    [tenantA, `${tenantA}/photo-1.jpg`, alice.id],
  );
  assetA = rows[0].id;
});

describe("workspace isolation", () => {
  it("members see their own posts and photos and nobody else's", async () => {
    await save(alice, tenantA, { asset: assetA });
    for (const table of ["social_posts", "social_assets"]) {
      const mine = await asUser(db, alice, (tx) => tx.query(`select id from public.${table}`));
      const theirs = await asUser(db, bob, (tx) => tx.query(`select id from public.${table}`));
      expect(mine.rows.length, table).toBeGreaterThan(0);
      expect(theirs.rows.length, table).toBe(0);
      await expect(
        asAnon(db, (tx) => tx.query(`select id from public.${table}`)),
        table,
      ).rejects.toThrow(/permission denied/);
      await expect(
        asUser(db, alice, (tx) => tx.query(`delete from public.${table}`)),
        table,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("nobody can post into, edit or delete in another workspace", async () => {
    const id = await save(alice, tenantA);
    await expect(save(bob, tenantA)).rejects.toThrow(/Workspace not found/);
    await expect(save(bob, tenantB, { id })).rejects.toThrow(/locked/);
    await expect(save(bob, tenantB, { asset: assetA })).rejects.toThrow(/Photo not found/);
    await expect(
      asUser(db, bob, (tx) => tx.query("select public.delete_social_post($1)", [id])),
    ).rejects.toThrow(/locked/);
  });

  it("a photo can only be registered inside its own workspace's folder", async () => {
    await expect(
      service("select public.register_social_asset($1, $2, 'image/jpeg', 10, null)", [
        tenantB,
        `${tenantA}/sneaky.jpg`,
      ]),
    ).rejects.toThrow(/Bad path/);
  });

  it("the publishing queue is closed to members", async () => {
    await expect(
      asUser(db, alice, (tx) => tx.query("select * from public.claim_due_social_posts(5)")),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("scheduling", () => {
  it("a post without a time is a draft; with one it is scheduled", async () => {
    const draft = await save(alice, tenantA, { channels: [] });
    const scheduled = await save(alice, tenantA, { at: later(60) });
    expect((await post(draft)).status).toBe("draft");
    expect((await post(scheduled)).status).toBe("scheduled");
  });

  it("refuses to schedule something that can't go out", async () => {
    await expect(save(alice, tenantA, { at: later(60), channels: [] })).rejects.toThrow(
      /no_channel/,
    );
    await expect(save(alice, tenantA, { at: later(60), caption: " " })).rejects.toThrow(/empty/);
    await expect(save(alice, tenantA, { at: later(60), channels: ["instagram"] })).rejects.toThrow(
      /instagram_needs_photo/,
    );
    await expect(save(alice, tenantA, { at: later(-60) })).rejects.toThrow(/past/);
    await expect(save(alice, tenantA, { channels: ["tiktok"] })).rejects.toThrow(/check/);
  });
});

describe("publishing", () => {
  it("claims a post once when its time comes, then publishes it", async () => {
    const early = await save(alice, tenantA, { at: later(60) });
    const id = await save(alice, tenantA, { at: later(60), asset: assetA });
    await makeDue(id);
    const claimed = await service<Post>("select * from public.claim_due_social_posts(10)");
    expect(claimed.map((p) => p.id)).toEqual([id]);
    expect(await service("select * from public.claim_due_social_posts(10)")).toHaveLength(0);
    expect((await post(early)).status).toBe("scheduled");

    const status = await service<{ s: string }>(
      "select public.finish_social_post($1, $2, true) as s",
      [id, JSON.stringify({ facebook: { id: "fb_1" } })],
    );
    expect(status[0].s).toBe("published");
    // Once out, it can't be edited or deleted.
    await expect(save(alice, tenantA, { id, caption: "Changed" })).rejects.toThrow(/locked/);
    await expect(
      asUser(db, alice, (tx) => tx.query("select public.delete_social_post($1)", [id])),
    ).rejects.toThrow(/locked/);
  });

  it("keeps what went out when one channel fails, retries the other, then gives up", async () => {
    const id = await save(alice, tenantA, {
      at: later(60),
      asset: assetA,
      channels: ["facebook", "instagram"],
    });
    await makeDue(id);
    await service("select * from public.claim_due_social_posts(10)");
    const first = await service<{ s: string }>(
      "select public.finish_social_post($1, $2, true) as s",
      [id, JSON.stringify({ facebook: { id: "fb_2" }, instagram: { error: "Try again later" } })],
    );
    expect(first[0].s).toBe("scheduled");
    expect((await post(id)).results).toMatchObject({ facebook: { id: "fb_2" } });
    // Part of it is out, so it can no longer be edited into something else.
    await expect(save(alice, tenantA, { id, caption: "Changed", at: later(60) })).rejects.toThrow(
      /locked/,
    );

    for (let attempt = 2; attempt <= 3; attempt++) {
      await db.query("update public.social_posts set locked_at = null where id = $1", [id]);
      const again = await service<Post>("select * from public.claim_due_social_posts(10)");
      expect(again.map((p) => p.id)).toContain(id);
      await service("select public.finish_social_post($1, $2, true)", [
        id,
        JSON.stringify({ instagram: { error: "Still no" } }),
      ]);
    }
    const final = await post(id);
    expect(final.status).toBe("failed");
    expect(final.error).toBe("instagram: Still no");
    expect(final.results).toMatchObject({ facebook: { id: "fb_2" } });
  });

  it("waits ten minutes before picking up a post that didn't finish", async () => {
    const id = await save(alice, tenantA, { at: later(60) });
    await makeDue(id);
    await service("select * from public.claim_due_social_posts(10)");
    expect(await service("select * from public.claim_due_social_posts(10)")).toHaveLength(0);
    await db.query(
      "update public.social_posts set locked_at = now() - interval '11 minutes' where id = $1",
      [id],
    );
    const again = await service<Post>("select * from public.claim_due_social_posts(10)");
    expect(again.map((p) => p.id)).toEqual([id]);
  });

  it("a failure that can't be retried fails at once", async () => {
    const id = await save(alice, tenantA, { at: later(60) });
    await makeDue(id);
    await service("select * from public.claim_due_social_posts(10)");
    const status = await service<{ s: string }>(
      "select public.finish_social_post($1, $2, false) as s",
      [id, JSON.stringify({ facebook: { error: "Reconnect needed" } })],
    );
    expect(status[0].s).toBe("failed");
    // A failed post can be fixed and rescheduled.
    await save(alice, tenantA, { id, at: later(30) });
    expect((await post(id)).status).toBe("scheduled");
  });
});

describe("library, projects and posts with several photos", () => {
  const as = <T>(user: User, sql: string, params: unknown[] = []) =>
    asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);
  const photo = async (tenant: string, name: string) =>
    (
      await service<{ id: string }>(
        "select public.register_social_asset($1, $2, 'image/jpeg', 1000, null) as id",
        [tenant, `${tenant}/${name}.jpg`],
      )
    )[0].id;
  const full = (
    user: User,
    tenant: string,
    assets: string[],
    opts: { captions?: object; project?: string | null; channels?: string[]; id?: string } = {},
  ) =>
    as<{ id: string }>(
      user,
      "select public.save_social_post_full($1, $2, 'Studio day', $3, $4, null, $5::jsonb, $6, 'process', 'First try by Claude') as id",
      [
        tenant,
        opts.id ?? null,
        assets,
        opts.channels ?? ["facebook", "instagram"],
        JSON.stringify(opts.captions ?? {}),
        opts.project ?? null,
      ],
    ).then((rows) => rows[0].id);

  it("projects stay inside their workspace", async () => {
    const mine = (
      await as<{ id: string }>(
        alice,
        "select public.save_social_project($1, null, 'Blue rug', 'Commission for a hallway', 'process') as id",
        [tenantA],
      )
    )[0].id;
    expect(await as(bob, "select id from public.social_projects")).toEqual([]);
    await expect(
      as(bob, "select public.save_social_project($1, $2, 'Mine now', '', null)", [tenantB, mine]),
    ).rejects.toThrow(/Project not found/);
    await expect(
      as(bob, "select public.save_social_project($1, null, 'Sneaky', '', null)", [tenantA]),
    ).rejects.toThrow(/Workspace not found/);
    await expect(
      as(alice, "insert into public.social_projects (tenant_id, name) values ($1, 'x')", [tenantA]),
    ).rejects.toThrow(/permission denied/);
  });

  it("photos can be named, tagged and filed, but only by their own workspace", async () => {
    const one = await photo(tenantA, "lib-1");
    const two = await photo(tenantA, "lib-2");
    const project = (
      await as<{ id: string }>(
        alice,
        "select public.save_social_project($1, null, 'Green rug', '', null) as id",
        [tenantA],
      )
    )[0].id;
    await as(alice, "select public.update_social_asset($1, 'Trimming', $2, $3, false)", [
      one,
      ["Process", " studio ", "bad tag!!"],
      project,
    ]);
    await as(alice, "select public.file_social_assets($1, $2, $3, $4)", [
      tenantA,
      [one, two],
      project,
      ["Green"],
    ]);
    const { rows } = await db.query<{ title: string; tags: string[]; project_id: string }>(
      "select title, tags, project_id from public.social_assets where id = $1",
      [one],
    );
    expect(rows[0].title).toBe("Trimming");
    expect([...rows[0].tags].sort()).toEqual(["green", "process", "studio"]);
    expect(rows[0].project_id).toBe(project);
    await expect(
      as(bob, "select public.update_social_asset($1, 'x', '{}', null, true)", [one]),
    ).rejects.toThrow(/Photo not found/);
    expect(
      (
        await as<{ n: number }>(bob, "select public.file_social_assets($1, $2, null, '{}') as n", [
          tenantB,
          [one],
        ])
      )[0].n,
    ).toBe(0);
  });

  it("a post keeps its photos in order, with a caption per channel only where it differs", async () => {
    const a = await photo(tenantA, "multi-a");
    const b = await photo(tenantA, "multi-b");
    const id = await full(alice, tenantA, [b, a], {
      captions: { instagram: "Studio day #tufting", facebook: "Studio day", tiktok: "nope" },
    });
    const { rows } = await db.query(
      "select asset_id, asset_ids, captions, topic, ai_draft from public.social_posts where id = $1",
      [id],
    );
    expect(rows[0]).toEqual({
      asset_id: b,
      asset_ids: [b, a],
      captions: { instagram: "Studio day #tufting" },
      topic: "process",
      ai_draft: "First try by Claude",
    });
    // Saving again with no photos clears them.
    await full(alice, tenantA, [], { id });
    const after = await db.query(
      "select asset_id, asset_ids from public.social_posts where id = $1",
      [id],
    );
    expect(after.rows[0]).toEqual({ asset_id: null, asset_ids: [] });
  });

  it("refuses another workspace's photos or project, and more than ten photos", async () => {
    const theirs = await photo(tenantB, "theirs");
    await expect(full(alice, tenantA, [theirs])).rejects.toThrow(/Photo not found/);
    const bobProject = (
      await as<{ id: string }>(
        bob,
        "select public.save_social_project($1, null, 'Pots', '', null) as id",
        [tenantB],
      )
    )[0].id;
    await expect(full(alice, tenantA, [], { project: bobProject })).rejects.toThrow(
      /Project not found/,
    );
    const many = await Promise.all(
      Array.from({ length: 11 }, (_, i) => photo(tenantA, `many-${i}`)),
    );
    await expect(full(alice, tenantA, many)).rejects.toThrow(/too_many_photos/);
    await expect(full(bob, tenantA, [])).rejects.toThrow(/Workspace not found/);
  });

  it("folders hold photos and videos, and stay inside their workspace", async () => {
    const folder = (
      await as<{ id: string }>(
        alice,
        "select public.save_social_folder($1, null, ' Workshops ') as id",
        [tenantA],
      )
    )[0].id;
    const clip = (
      await service<{ id: string }>(
        "select public.register_social_asset($1, $2, 'video/mp4', 4000000, $3, $4, 'Tufting clip') as id",
        [tenantA, `${tenantA}/clip-1.mp4`, alice.id, folder],
      )
    )[0].id;
    const still = await photo(tenantA, "folder-still");
    const moved = await as<{ n: number }>(
      alice,
      "select public.sort_social_assets($1, $2, true, $3, $4, null) as n",
      [tenantA, [still], folder, ["Workshop"]],
    );
    expect(moved[0].n).toBe(1);
    const inside = await as<{ id: string; tags: string[] }>(
      alice,
      "select id, tags from public.social_assets where folder_id = $1 order by created_at",
      [folder],
    );
    expect(inside.map((row) => row.id).sort()).toEqual([clip, still].sort());
    expect(inside.find((row) => row.id === still)?.tags).toContain("workshop");

    // Bob can't see the folder, use it, rename it, or file Alice's things.
    expect(await as(bob, "select id from public.social_folders")).toEqual([]);
    await expect(
      as(bob, "select public.save_social_folder($1, $2, 'Mine now')", [tenantB, folder]),
    ).rejects.toThrow(/Folder not found/);
    await expect(
      as(bob, "select public.save_social_folder($1, null, 'Sneaky')", [tenantA]),
    ).rejects.toThrow(/Workspace not found/);
    await expect(
      as(bob, "select public.remove_social_folder($1, $2)", [tenantB, folder]),
    ).rejects.toThrow(/Folder not found/);
    const bobs = await photo(tenantB, "bobs");
    await expect(
      as(bob, "select public.sort_social_assets($1, $2, true, $3, '{}', null)", [
        tenantB,
        [bobs],
        folder,
      ]),
    ).rejects.toThrow(/Folder not found/);
    await expect(
      service("select public.register_social_asset($1, $2, 'image/png', 10, $3, $4, '')", [
        tenantB,
        `${tenantB}/x.png`,
        bob.id,
        folder,
      ]),
    ).rejects.toThrow(/Folder not found/);
    await expect(
      service("select public.register_social_asset($1, $2, 'application/pdf', 10, $3, null, '')", [
        tenantA,
        `${tenantA}/x.pdf`,
        alice.id,
      ]),
    ).rejects.toThrow(/mime_type/);

    // A video goes out on its own, never beside photos.
    await expect(full(alice, tenantA, [clip, still])).rejects.toThrow(/video_alone/);
    await expect(full(alice, tenantA, [still, clip])).rejects.toThrow(/video_alone/);
    expect(await full(alice, tenantA, [clip])).toMatch(/^[0-9a-f-]{36}$/);

    // Removing a folder keeps what was in it.
    await as(alice, "select public.remove_social_folder($1, $2)", [tenantA, folder]);
    const { rows } = await db.query<{ folder_id: string | null }>(
      "select folder_id from public.social_assets where id = any($1)",
      [[clip, still]],
    );
    expect(rows.map((row) => row.folder_id)).toEqual([null, null]);
  });
});

describe("emails", () => {
  const as = <T>(user: User, sql: string, params: unknown[] = []) =>
    asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);
  const doc = (title: string, subject = "") =>
    JSON.stringify({ v: 2, title, meta: { subject, previewText: "" }, sections: [] });

  it("stay inside their workspace", async () => {
    const id = (
      await as<{ id: string }>(
        alice,
        "select public.save_email($1, null, $2::jsonb, 'Sale') as id",
        [tenantA, doc("", "Autumn sale")],
      )
    )[0].id;
    expect(
      await as<{ title: string }>(alice, "select title from public.emails where id = $1", [id]),
    ).toEqual([{ title: "Autumn sale" }]);
    await as(alice, "select public.save_email($1, $2, $3::jsonb)", [tenantA, id, doc("Renamed")]);
    expect(
      await as<{ title: string }>(alice, "select title from public.emails where id = $1", [id]),
    ).toEqual([{ title: "Renamed" }]);

    expect(await as(bob, "select id from public.emails")).toEqual([]);
    await expect(
      as(bob, "select public.save_email($1, $2, $3::jsonb)", [tenantB, id, doc("Mine")]),
    ).rejects.toThrow(/Email not found/);
    await expect(
      as(bob, "select public.save_email($1, null, $2::jsonb)", [tenantA, doc("Sneaky")]),
    ).rejects.toThrow(/Workspace not found/);
    await expect(as(bob, "select public.remove_email($1, $2)", [tenantB, id])).rejects.toThrow(
      /Email not found/,
    );
    await expect(
      as(bob, "insert into public.emails (tenant_id, doc) values ($1, '{}')", [tenantB]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(alice, "select public.save_email($1, null, '[]'::jsonb)", [tenantA]),
    ).rejects.toThrow(/not valid/);

    await as(alice, "select public.remove_email($1, $2)", [tenantA, id]);
    expect(await as(alice, "select id from public.emails")).toEqual([]);
  });
});
