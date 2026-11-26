import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { fits, type FitPlace } from "../../src/lib/social/fit";
import { asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };

let db: PGlite;
let owner: User;
let other: User;
let tenantA: string;
let tenantB: string;

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

function as<T>(user: User, sql: string, params: unknown[] = []): Promise<T[]> {
  return asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);
}
function service<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
}

let n = 0;
async function photo(
  tenant: string,
  size: [number, number] | null,
  mime = "image/jpeg",
): Promise<string> {
  n += 1;
  const [{ id }] = await service<{ id: string }>(
    "select public.register_social_asset($1, $2, $3, 1000, null) as id",
    [
      tenant,
      `${tenant}/p${n}.${mime === "image/png" ? "png" : mime === "video/mp4" ? "mp4" : "jpg"}`,
      mime,
    ],
  );
  if (size)
    await service("select public.set_social_asset_size($1, $2, $3, $4)", [tenant, id, ...size]);
  return id;
}

async function draft(tenant: string, assets: string[], channels: string[], user = owner) {
  return (
    await as<{ id: string }>(
      user,
      `select public.save_social_post_full($1, null, 'Hello', $2, $3, null,
         '{}'::jsonb, null, null, null, $4) as id`,
      [tenant, assets, channels, later(120)],
    )
  )[0].id;
}
const schedule = (id: string, assets: string[], channels: string[]) =>
  as(
    owner,
    `select public.save_social_post_full($1, $2, 'Hello', $3, $4, $5,
       '{}'::jsonb, null, null, null, null)`,
    [tenantA, id, assets, channels, later(60)],
  );
const setFits = (id: string, fitsBody: object, user = owner, tenant = tenantA) =>
  as(user, "select public.set_social_post_fits($1, $2, $3)", [
    tenant,
    id,
    JSON.stringify(fitsBody),
  ]);
const copyOf = async (original: string, place: FitPlace, size: [number, number]) => {
  const copy = await photo(tenantA, size);
  await service("select public.mark_social_fitted_copy($1, $2, $3, $4)", [
    tenantA,
    copy,
    original,
    place,
  ]);
  return copy;
};

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
});

describe("the database's size rule matches the app's", () => {
  it("agrees with fits() on the edges", async () => {
    const cases: [FitPlace, number, number][] = [
      ["instagram", 1080, 1350],
      ["instagram", 1080, 1365],
      ["instagram", 1080, 1380],
      ["instagram", 1910, 1000],
      ["instagram", 1930, 1000],
      ["instagram", 1950, 1000],
      ["instagram", 1080, 1920],
      ["instagram_story", 1080, 1920],
      ["instagram_story", 1080, 1900],
      ["instagram_story", 1080, 1350],
    ];
    for (const [place, w, h] of cases) {
      // A private function, read as the database owner.
      const [{ ok }] = (
        await db.query<{ ok: boolean }>("select private.social_photo_fits($1, $2, $3) as ok", [
          place,
          w,
          h,
        ])
      ).rows;
      expect(ok, `${place} ${w}x${h}`).toBe(fits(w, h, place));
    }
  });
});

describe("scheduling for Instagram", () => {
  it("refuses a photo of unknown size, the wrong shape, or a PNG", async () => {
    for (const asset of [
      await photo(tenantA, null),
      await photo(tenantA, [1080, 1920]),
      await photo(tenantA, [1080, 1350], "image/png"),
    ]) {
      const id = await draft(tenantA, [asset], ["instagram"]);
      await expect(schedule(id, [asset], ["instagram"])).rejects.toThrow(/photo_size/);
      // Facebook takes it as it is.
      await schedule(id, [asset], ["facebook"]);
    }
  });

  it("sends a sized copy instead, leaving the original as it was", async () => {
    const tall = await photo(tenantA, [1080, 1920]);
    const fine = await photo(tenantA, [1080, 1080]);
    const id = await draft(tenantA, [tall, fine], ["facebook", "instagram"]);
    const copy = await copyOf(tall, "instagram", [1080, 1350]);
    await setFits(id, { instagram: [copy, fine] });
    await schedule(id, [tall, fine], ["facebook", "instagram"]);
    const [original] = (
      await db.query<{ width: number; height: number; hidden: boolean }>(
        "select width, height, hidden from public.social_assets where id = $1",
        [tall],
      )
    ).rows;
    expect(original).toEqual({ width: 1080, height: 1920, hidden: false });
    const [kept] = (
      await db.query<{ asset_ids: string[]; channel_media: object }>(
        "select asset_ids, channel_media from public.social_posts where id = $1",
        [id],
      )
    ).rows;
    expect(kept.asset_ids).toEqual([tall, fine]);
    expect(kept.channel_media).toEqual({ instagram: [copy, fine] });
  });

  it("won't take a copy that doesn't fit, or isn't that photo's", async () => {
    const tall = await photo(tenantA, [1080, 1920]);
    const stranger = await photo(tenantA, [1080, 1080]);
    const misfit = await photo(tenantA, [1080, 1920]);
    await expect(
      service("select public.mark_social_fitted_copy($1, $2, $3, 'instagram')", [
        tenantA,
        misfit,
        tall,
      ]),
    ).rejects.toThrow(/photo_size/);
    const id = await draft(tenantA, [tall], ["instagram"]);
    await expect(setFits(id, { instagram: [stranger] })).rejects.toThrow(/fits_not_valid/);
    await expect(setFits(id, { instagram: [] })).rejects.toThrow(/fits_not_valid/);
    await expect(setFits(id, { tiktok: [tall] })).rejects.toThrow(/fits_not_valid/);
  });

  it("a copy for the feed is no copy for a Story", async () => {
    const square = await photo(tenantA, [1080, 1080]);
    const feedCopy = await copyOf(square, "instagram", [1080, 1350]);
    const id = await draft(tenantA, [square], ["instagram_story"]);
    await expect(setFits(id, { instagram_story: [feedCopy] })).rejects.toThrow(/fits_not_valid/);
    await expect(schedule(id, [square], ["instagram_story"])).rejects.toThrow(/story_size/);
    const storyCopy = await copyOf(square, "instagram_story", [1080, 1920]);
    await setFits(id, { instagram_story: [storyCopy] });
    await schedule(id, [square], ["instagram_story"]);
  });
});

describe("Stories", () => {
  it("take one photo or one video, never several or none", async () => {
    const a = await photo(tenantA, [1080, 1920]);
    const b = await photo(tenantA, [1080, 1920]);
    const video = await photo(tenantA, null, "video/mp4");
    const many = await draft(tenantA, [a, b], ["instagram_story"]);
    await expect(schedule(many, [a, b], ["instagram_story"])).rejects.toThrow(/story_one/);
    const none = await draft(tenantA, [], ["instagram_story"]);
    await expect(schedule(none, [], ["instagram_story"])).rejects.toThrow(/story_needs_media/);
    const clip = await draft(tenantA, [video], ["instagram_story"]);
    await schedule(clip, [video], ["instagram_story"]);
  });

  it("each place's answer is kept apart, so one that went out is never sent again", async () => {
    const a = await photo(tenantA, [1080, 1920]);
    const id = await draft(tenantA, [a], ["facebook", "instagram_story"]);
    await schedule(id, [a], ["facebook", "instagram_story"]);
    await db.query(
      "update public.social_posts set scheduled_for = now() - interval '1 minute' where id = $1",
      [id],
    );
    await service("select * from public.claim_due_social_posts(50)");
    const [first] = await service<{ s: string }>(
      "select public.finish_social_post($1, $2, true) as s",
      [id, JSON.stringify({ instagram_story: { id: "st_1" }, facebook: { error: "Busy" } })],
    );
    expect(first.s).toBe("scheduled");
    await db.query(
      "update public.social_posts set locked_at = null, scheduled_for = now() - interval '1 minute' where id = $1",
      [id],
    );
    await service("select * from public.claim_due_social_posts(50)");
    const [second] = await service<{ s: string }>(
      "select public.finish_social_post($1, $2, true) as s",
      [id, JSON.stringify({ facebook: { id: "fb_1" } })],
    );
    expect(second.s).toBe("published");
    const [{ results }] = (
      await db.query<{ results: Record<string, { id?: string }> }>(
        "select results from public.social_posts where id = $1",
        [id],
      )
    ).rows;
    expect(results.instagram_story.id).toBe("st_1");
  });
});

describe("workspace isolation", () => {
  it("members can't measure photos or mark copies, and can't reach another workspace", async () => {
    const mine = await photo(tenantA, [1080, 1920]);
    await expect(
      as(owner, "select public.set_social_asset_size($1, $2, 10, 10)", [tenantA, mine]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(owner, "select public.mark_social_fitted_copy($1, $2, $2, 'instagram')", [tenantA, mine]),
    ).rejects.toThrow(/permission denied/);
    const id = await draft(tenantA, [mine], ["instagram"]);
    await expect(setFits(id, { instagram: [mine] }, other, tenantB)).rejects.toThrow(/locked/);
    await expect(setFits(id, { instagram: [mine] }, other, tenantA)).rejects.toThrow();
    // A copy in another workspace can't be marked as one of ours.
    const theirs = await photo(tenantB, [1080, 1350]);
    await expect(
      service("select public.mark_social_fitted_copy($1, $2, $3, 'instagram')", [
        tenantB,
        theirs,
        mine,
      ]),
    ).rejects.toThrow(/Photo not found/);
  });
});
