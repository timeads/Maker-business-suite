import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };
type Row = {
  status: string;
  asset_ids: string[];
  asset_id: string | null;
  slide_asset_ids: string[];
  slides_key: string | null;
  slides_drawn: string | null;
};

let db: PGlite;
let owner: User;
let other: User;
let tenantA: string;
let tenantB: string;
let photo: string;
let pictures: string[];
let theirPicture: string;

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const design = (n: number, words = "Hello") => ({
  v: 1,
  format: "4:5",
  slides: Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    bg: "#123456",
    layers: [{ text: `${words} ${i}` }],
  })),
});

function as<T>(user: User, sql: string, params: unknown[] = []): Promise<T[]> {
  return asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);
}
const row = async (id: string) =>
  (await db.query<Row>("select * from public.social_posts where id = $1", [id])).rows[0];
const register = async (tenant: string, name: string) =>
  (
    await asService(db, (tx) =>
      tx.query<{ id: string }>(
        "select public.register_social_asset($1, $2, 'image/jpeg', 1000, null) as id",
        [tenant, `${tenant}/${name}.jpg`],
      ),
    )
  ).rows[0].id;

async function draft(user: User, tenant: string, assets: string[] = []) {
  return (
    await as<{ id: string }>(
      user,
      `select public.save_social_post_full($1, null, 'Swipe through', $2, '{facebook}', null,
         '{}'::jsonb, null, null, null, $3) as id`,
      [tenant, assets, later(120)],
    )
  )[0].id;
}
const setSlides = (user: User, tenant: string, id: string, slides: object | null) =>
  as<{ key: string | null }>(user, "select public.set_social_post_slides($1, $2, $3) as key", [
    tenant,
    id,
    slides === null ? null : JSON.stringify(slides),
  ]);
const attach = (user: User, tenant: string, id: string, key: string | null, ids: string[]) =>
  as(user, "select public.attach_social_slide_pictures($1, $2, $3, $4)", [tenant, id, key, ids]);
const schedule = (user: User, tenant: string, id: string) =>
  as(user, "select public.save_social_post($1, $2, 'Swipe through', null, '{facebook}', $3)", [
    tenant,
    id,
    later(60),
  ]);

beforeAll(async () => {
  db = await createTestDb();
  owner = { id: await createUser(db, "owner@a.test"), email: "owner@a.test" };
  other = { id: await createUser(db, "other@b.test"), email: "other@b.test" };
  tenantA = (
    await as<{ id: string }>(owner, "select id from public.create_tenant('Studio A', 'UTC', 'USD')")
  )[0].id;
  tenantB = (
    await as<{ id: string }>(other, "select id from public.create_tenant('Studio B', 'UTC', 'USD')")
  )[0].id;
  photo = await register(tenantA, "photo");
  pictures = [await register(tenantA, "s1"), await register(tenantA, "s2")];
  theirPicture = await register(tenantB, "theirs");
});

describe("slides on a post", () => {
  it("are kept as one design and drawn into pictures ahead of the other photos", async () => {
    const id = await draft(owner, tenantA, [photo]);
    const [{ key }] = await setSlides(owner, tenantA, id, design(2));
    expect(key).toBe((await row(id)).slides_key);
    // Not drawn yet: it can't be scheduled.
    await expect(schedule(owner, tenantA, id)).rejects.toThrow(/slides_not_drawn/);
    await attach(owner, tenantA, id, key, pictures);
    const drawn = await row(id);
    expect(drawn.asset_ids).toEqual([...pictures, photo]);
    expect(drawn.asset_id).toBe(pictures[0]);
    expect(drawn.slides_drawn).toBe(key);
    await schedule(owner, tenantA, id);
    expect((await row(id)).status).toBe("scheduled");
    // Once approved, the slides are fixed.
    await expect(setSlides(owner, tenantA, id, design(3))).rejects.toThrow(/locked/);
  });

  it("changed slides need drawing again, and stale pictures are refused", async () => {
    const id = await draft(owner, tenantA);
    const [{ key: first }] = await setSlides(owner, tenantA, id, design(2));
    await attach(owner, tenantA, id, first, pictures);
    const [{ key: second }] = await setSlides(owner, tenantA, id, design(2, "Changed"));
    expect(second).not.toBe(first);
    await expect(schedule(owner, tenantA, id)).rejects.toThrow(/slides_not_drawn/);
    await expect(attach(owner, tenantA, id, first, pictures)).rejects.toThrow(/slides_changed/);
    await expect(attach(owner, tenantA, id, second, [pictures[0]])).rejects.toThrow(/slides_count/);
    await expect(attach(owner, tenantA, id, second, [pictures[0], pictures[0]])).rejects.toThrow(
      /slides_count/,
    );
  });

  it("taking the slides off takes their pictures off too", async () => {
    const id = await draft(owner, tenantA, [photo]);
    const [{ key }] = await setSlides(owner, tenantA, id, design(2));
    await attach(owner, tenantA, id, key, pictures);
    await setSlides(owner, tenantA, id, null);
    const after = await row(id);
    expect(after.asset_ids).toEqual([photo]);
    expect(after.asset_id).toBe(photo);
    expect(after.slide_asset_ids).toEqual([]);
    await schedule(owner, tenantA, id);
  });

  it("refuses slides that aren't a design, or more than ten", async () => {
    const id = await draft(owner, tenantA);
    await expect(setSlides(owner, tenantA, id, { slides: "no" })).rejects.toThrow(
      /slides_not_valid/,
    );
    await expect(setSlides(owner, tenantA, id, design(11))).rejects.toThrow(/slides_not_valid/);
  });

  it("approval is refused until the slides are drawn, and goes once they are", async () => {
    const id = await draft(owner, tenantA);
    const [{ key }] = await setSlides(owner, tenantA, id, design(2));
    const [{ result }] = await as<{
      result: { approved: string[]; skipped: { reason: string }[] };
    }>(owner, "select public.approve_social_posts($1, $2, null) as result", [tenantA, [id]]);
    expect(result.approved).toEqual([]);
    expect(result.skipped[0].reason).toBe("slides_not_drawn");
    await attach(owner, tenantA, id, key, pictures);
    await as(owner, "select public.approve_social_post($1, $2, null)", [tenantA, id]);
    expect((await row(id)).status).toBe("scheduled");
  });
});

describe("workspace isolation", () => {
  it("never touches another workspace's post or pictures", async () => {
    const id = await draft(owner, tenantA);
    const [{ key }] = await setSlides(owner, tenantA, id, design(1));
    await expect(attach(owner, tenantA, id, key, [theirPicture])).rejects.toThrow(
      /Picture not found/,
    );
    await expect(setSlides(other, tenantA, id, design(1))).rejects.toThrow();
    await expect(setSlides(other, tenantB, id, design(1))).rejects.toThrow(/locked/);
    await expect(attach(other, tenantB, id, key, [theirPicture])).rejects.toThrow(/locked/);
  });
});
