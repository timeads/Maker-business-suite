import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Photos in the order they were taken and what each one is; drafts from a
 * project; Claude's drafts written again with what they said before kept;
 * slides and "what the photos show" filed by the monthly run. Every name
 * here is invented.
 */

type User = { id: string; email: string };

let db: PGlite;
let owner: User;
let member: User;
let other: User;
let tenantA: string;
let tenantB: string;
let brandA: string;
let project: string;
let otherProject: string;
let photos: string[];

function as<T>(user: User, sql: string, params: unknown[] = []): Promise<T[]> {
  return asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);
}
function service<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
}
const one = async <T>(rows: Promise<T[]>) => (await rows)[0];

const SLIDES = (paths: string[]) => ({
  v: 1,
  format: "4:5",
  slides: [
    {
      id: "s1",
      bg: "#223344",
      image: paths[0] ? `https://files.test/storage/v1/object/public/social/${paths[0]}` : null,
      layers: [],
      pics: [],
    },
  ],
});

beforeAll(async () => {
  db = await createTestDb();
  owner = { id: await createUser(db, "owner@a.test"), email: "owner@a.test" };
  member = { id: await createUser(db, "member@a.test"), email: "member@a.test" };
  other = { id: await createUser(db, "other@b.test"), email: "other@b.test" };
  tenantA = (
    await as<{ id: string }>(owner, "select id from public.create_tenant('Studio A', 'UTC', 'USD')")
  )[0].id;
  tenantB = (
    await as<{ id: string }>(other, "select id from public.create_tenant('Studio B', 'UTC', 'USD')")
  )[0].id;
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, member.id],
  );
  brandA = (
    await db.query<{ id: string }>(
      "select id from public.brands where tenant_id = $1 and is_default",
      [tenantA],
    )
  ).rows[0].id;
  project = (
    await one(
      as<{ id: string }>(
        owner,
        "select public.save_social_project($1, null, 'Moss rug', 'For a nook', null, false) as id",
        [tenantA],
      ),
    )
  ).id;
  otherProject = (
    await one(
      as<{ id: string }>(
        owner,
        "select public.save_social_project($1, null, 'Sun rug', '', null, false) as id",
        [tenantA],
      ),
    )
  ).id;
  photos = [];
  for (const name of ["one", "two", "three", "four", "five"]) {
    const id = (
      await one(
        service<{ id: string }>(
          "select public.register_social_asset($1, $2, 'image/jpeg', 1000, null) as id",
          [tenantA, `${tenantA}/${name}.jpg`],
        ),
      )
    ).id;
    photos.push(id);
  }
  await db.query("update public.social_assets set project_id = $1 where id = any ($2)", [
    project,
    photos.slice(0, 4),
  ]);
  await db.query(
    `insert into public.social_accounts (tenant_id, brand_id, network, platform_id, page_id, active)
     values ($1, $2, 'facebook', 'page-1', 'page-1', true),
            ($1, $2, 'instagram', 'ig-1', 'page-1', true)`,
    [tenantA, brandA],
  );
});

describe("when a photo was taken, and what it is", () => {
  it("only the server writes when it was taken, and only a sensible time", async () => {
    await service("select public.set_social_asset_taken_at($1, $2, '2026-10-12T18:56:17Z')", [
      tenantA,
      photos[0],
    ]);
    const [row] = await as<{ taken_at: string }>(
      member,
      "select taken_at::text from public.social_assets where id = $1",
      [photos[0]],
    );
    expect(row.taken_at).toContain("2026-10-12");
    await expect(
      as(owner, "select public.set_social_asset_taken_at($1, $2, now())", [tenantA, photos[1]]),
    ).rejects.toThrow();
    await expect(
      service("select public.set_social_asset_taken_at($1, $2, '1990-01-01')", [
        tenantA,
        photos[1],
      ]),
    ).rejects.toThrow(/bad_time/);
    // Another workspace's photo isn't found.
    await expect(
      service("select public.set_social_asset_taken_at($1, $2, now())", [tenantB, photos[1]]),
    ).rejects.toThrow(/not found/);
  });

  it("a member marks photos; another workspace can't", async () => {
    const [{ n }] = await as<{ n: number }>(
      member,
      "select public.set_social_asset_role($1, $2, 'finished') as n",
      [tenantA, [photos[3]]],
    );
    expect(n).toBe(1);
    await expect(
      as(member, "select public.set_social_asset_role($1, $2, 'shiny')", [tenantA, [photos[3]]]),
    ).rejects.toThrow(/bad_role/);
    await expect(
      as(other, "select public.set_social_asset_role($1, $2, 'artwork')", [tenantA, [photos[3]]]),
    ).rejects.toThrow();
    // Naming its own workspace changes nothing of ours.
    const [{ n: none }] = await as<{ n: number }>(
      other,
      "select public.set_social_asset_role($1, $2, 'artwork') as n",
      [tenantB, [photos[3]]],
    );
    expect(none).toBe(0);
    const [row] = await as<{ role: string }>(
      owner,
      "select role from public.social_assets where id = $1",
      [photos[3]],
    );
    expect(row.role).toBe("finished");
  });
});

describe("draft from this project", () => {
  let draft: string;

  it("files a plain draft from the project's unused photos, once", async () => {
    const body = {
      caption: "From the frame.",
      asset_ids: [photos[0], photos[1]],
      photos_show: "A green rug on the frame, then off it.",
      topic: "rugs",
    };
    draft = (
      await one(
        as<{ id: string }>(
          member,
          "select public.file_social_project_draft($1, $2, $3::jsonb) as id",
          [tenantA, project, JSON.stringify(body)],
        ),
      )
    ).id;
    expect(draft).toBeTruthy();
    const [post] = await as<Record<string, unknown>>(
      member,
      "select status, ai_draft, caption, photos_show, channels, review, planned_for, brand_id from public.social_posts where id = $1",
      [draft],
    );
    expect(post).toMatchObject({
      status: "draft",
      ai_draft: "From the frame.",
      caption: "From the frame.",
      photos_show: "A green rug on the frame, then off it.",
      channels: ["facebook", "instagram"],
      review: null,
      planned_for: null,
      brand_id: brandA,
    });
    // A second press with the same photos makes nothing.
    const [again] = await as<{ id: string | null }>(
      member,
      "select public.file_social_project_draft($1, $2, $3::jsonb) as id",
      [tenantA, project, JSON.stringify(body)],
    );
    expect(again.id).toBeNull();
  });

  it("counts photos pictured on slides as used", async () => {
    const slides = SLIDES([`${tenantA}/three.jpg`]);
    const [made] = await as<{ id: string | null }>(
      member,
      "select public.file_social_project_draft($1, $2, $3::jsonb) as id",
      [tenantA, project, JSON.stringify({ caption: "Slides.", pictured_ids: [photos[2]], slides })],
    );
    expect(made.id).toBeTruthy();
    const [again] = await as<{ id: string | null }>(
      member,
      "select public.file_social_project_draft($1, $2, $3::jsonb) as id",
      [tenantA, project, JSON.stringify({ caption: "Again.", asset_ids: [photos[2]] })],
    );
    expect(again.id).toBeNull();
  });

  it("refuses photos that aren't the project's, artwork, or pictured photos not on the slides", async () => {
    await expect(
      as(member, "select public.file_social_project_draft($1, $2, $3::jsonb)", [
        tenantA,
        otherProject,
        JSON.stringify({ caption: "No.", asset_ids: [photos[3]] }),
      ]),
    ).rejects.toThrow(/Photo not found/);
    await db.query("update public.social_assets set role = 'artwork' where id = $1", [photos[3]]);
    await expect(
      as(member, "select public.file_social_project_draft($1, $2, $3::jsonb)", [
        tenantA,
        project,
        JSON.stringify({ caption: "No.", asset_ids: [photos[3]] }),
      ]),
    ).rejects.toThrow(/Photo not found/);
    await db.query("update public.social_assets set role = 'finished' where id = $1", [photos[3]]);
    await expect(
      as(member, "select public.file_social_project_draft($1, $2, $3::jsonb)", [
        tenantA,
        project,
        JSON.stringify({ caption: "No.", pictured_ids: [photos[3]], slides: SLIDES([]) }),
      ]),
    ).rejects.toThrow(/Photo not found/);
    await expect(
      as(other, "select public.file_social_project_draft($1, $2, $3::jsonb)", [
        tenantA,
        project,
        JSON.stringify({ caption: "No.", asset_ids: [photos[3]] }),
      ]),
    ).rejects.toThrow();
  });

  it("writes it again, keeping what it said, and brings it back", async () => {
    // The person edits Claude's draft: the edit is kept against what Claude wrote.
    await db.query(
      "update public.social_posts set caption = 'From the frame, at last.' where id = $1",
      [draft],
    );
    const edits = () =>
      as<{ before: string; after: string }>(
        owner,
        "select before, after from public.social_post_edits where post_id = $1",
        [draft],
      );
    expect(await edits()).toEqual([
      { before: "From the frame.", after: "From the frame, at last." },
    ]);
    const seen = (
      await one(
        as<{ at: string }>(
          member,
          "select updated_at::text as at from public.social_posts where id = $1",
          [draft],
        ),
      )
    ).at;

    // An old look at the draft is refused: something changed since.
    await expect(
      as(member, "select public.redraft_social_post($1, $2, $3, $4::jsonb)", [
        tenantA,
        draft,
        "2000-01-01T00:00:00Z",
        JSON.stringify({ caption: "Second go." }),
      ]),
    ).rejects.toThrow(/changed_meanwhile/);

    await as(member, "select public.redraft_social_post($1, $2, $3, $4::jsonb)", [
      tenantA,
      draft,
      seen,
      JSON.stringify({ caption: "Second go.", photos_show: "A rug, then a reading nook." }),
    ]);
    const [post] = await as<Record<string, unknown>>(
      member,
      "select caption, ai_draft, photos_show from public.social_posts where id = $1",
      [draft],
    );
    expect(post).toEqual({
      caption: "Second go.",
      ai_draft: "Second go.",
      photos_show: "A rug, then a reading nook.",
    });
    // The new draft is unedited, so nothing is compared yet.
    expect(await edits()).toEqual([]);
    const versions = await as<{ id: string; caption: string; ai_draft: string; why: string }>(
      member,
      "select id, caption, ai_draft, why from public.social_post_versions where post_id = $1",
      [draft],
    );
    expect(versions).toEqual([
      {
        id: expect.any(String),
        caption: "From the frame, at last.",
        ai_draft: "From the frame.",
        why: "rewritten",
      },
    ]);
    // Another workspace sees no versions and can't bring one back.
    expect(
      await as(other, "select id from public.social_post_versions where post_id = $1", [draft]),
    ).toEqual([]);
    await expect(
      as(other, "select public.restore_social_post_version($1, $2)", [tenantB, versions[0].id]),
    ).rejects.toThrow(/not found/);

    // Bringing it back restores the person's words and Claude's draft they were set against.
    await as(member, "select public.restore_social_post_version($1, $2)", [
      tenantA,
      versions[0].id,
    ]);
    const [back] = await as<Record<string, unknown>>(
      member,
      "select caption, ai_draft, photos_show from public.social_posts where id = $1",
      [draft],
    );
    expect(back).toEqual({
      caption: "From the frame, at last.",
      ai_draft: "From the frame.",
      photos_show: "A green rug on the frame, then off it.",
    });
    expect(await edits()).toEqual([
      { before: "From the frame.", after: "From the frame, at last." },
    ]);
    const after = await as<{ caption: string; why: string }>(
      member,
      "select caption, why from public.social_post_versions where post_id = $1",
      [draft],
    );
    expect(after).toEqual([{ caption: "Second go.", why: "replaced" }]);
  });

  it("puts new slides on, taking drawn pictures off", async () => {
    const slides = SLIDES([]);
    await db.query(
      "update public.social_posts set slides = $2::jsonb, slide_asset_ids = array[$3::uuid], asset_ids = array[$3::uuid, $4::uuid], asset_id = $3 where id = $1",
      [draft, JSON.stringify(slides), photos[4], photos[0]],
    );
    const seen = (
      await one(
        as<{ at: string }>(
          member,
          "select updated_at::text as at from public.social_posts where id = $1",
          [draft],
        ),
      )
    ).at;
    const fresh = { ...slides, slides: [{ ...slides.slides[0], bg: "#445566" }] };
    await as(member, "select public.redraft_social_post($1, $2, $3, $4::jsonb)", [
      tenantA,
      draft,
      seen,
      JSON.stringify({ caption: "Third go.", slides: fresh }),
    ]);
    const [post] = await as<{
      asset_ids: string[];
      asset_id: string;
      slide_asset_ids: string[];
      bg: string;
    }>(
      member,
      "select asset_ids, asset_id, slide_asset_ids, slides #>> '{slides,0,bg}' as bg from public.social_posts where id = $1",
      [draft],
    );
    expect(post).toEqual({
      asset_ids: [photos[0]],
      asset_id: photos[0],
      slide_asset_ids: [],
      bg: "#445566",
    });
  });

  it("never writes again a post that went out, or one nobody drafted with Claude", async () => {
    const [plain] = await as<{ id: string }>(
      member,
      `select public.save_social_post_full($1, null, 'By hand.', '{}'::uuid[], '{}'::text[],
         null::timestamptz, '{}'::jsonb, null, null, null, null) as id`,
      [tenantA],
    );
    const seen = (
      await one(
        as<{ at: string }>(
          member,
          "select updated_at::text as at from public.social_posts where id = $1",
          [plain.id],
        ),
      )
    ).at;
    await expect(
      as(member, "select public.redraft_social_post($1, $2, $3, $4::jsonb)", [
        tenantA,
        plain.id,
        seen,
        JSON.stringify({ caption: "No." }),
      ]),
    ).rejects.toThrow(/not_drafted/);
    await db.query(
      `update public.social_posts set results = '{"x:facebook": {"id": "1"}}'::jsonb where id = $1`,
      [draft],
    );
    const seenOut = (
      await one(
        as<{ at: string }>(
          member,
          "select updated_at::text as at from public.social_posts where id = $1",
          [draft],
        ),
      )
    ).at;
    await expect(
      as(member, "select public.redraft_social_post($1, $2, $3, $4::jsonb)", [
        tenantA,
        draft,
        seenOut,
        JSON.stringify({ caption: "No." }),
      ]),
    ).rejects.toThrow(/locked/);
  });

  it("keeps ten versions at most", async () => {
    const [made] = await as<{ id: string }>(
      member,
      "select public.file_social_project_draft($1, $2, $3::jsonb) as id",
      [tenantA, project, JSON.stringify({ caption: "Go 0", asset_ids: [photos[3]] })],
    );
    for (let i = 1; i <= 12; i++) {
      const seen = (
        await one(
          as<{ at: string }>(
            member,
            "select updated_at::text as at from public.social_posts where id = $1",
            [made.id],
          ),
        )
      ).at;
      await as(member, "select public.redraft_social_post($1, $2, $3, $4::jsonb)", [
        tenantA,
        made.id,
        seen,
        JSON.stringify({ caption: `Go ${i}` }),
      ]);
    }
    const kept = await as<{ caption: string }>(
      member,
      "select caption from public.social_post_versions where post_id = $1 order by kept_at desc",
      [made.id],
    );
    expect(kept).toHaveLength(10);
  });

  it("nobody writes the versions table directly", async () => {
    await expect(
      as(
        owner,
        "insert into public.social_post_versions (tenant_id, post_id, why) values ($1, $2, 'rewritten')",
        [tenantA, draft],
      ),
    ).rejects.toThrow();
    await expect(
      as(owner, "update public.social_posts set photos_show = 'x' where id = $1", [draft]),
    ).rejects.toThrow();
  });
});

describe("the monthly run files slides and what the photos show", () => {
  it("keeps them on the draft, and treats pictured photos as used", async () => {
    const [run] = await db
      .query<{ id: string }>(
        `insert into public.social_month_runs
         (tenant_id, brand_id, window_start, window_end, status, started_at)
       values ($1, $2, current_date, current_date + 40, 'running', now()) returning id`,
        [tenantA, brandA],
      )
      .then((r) => r.rows);
    const at = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
    const fresh = (
      await one(
        service<{ id: string }>(
          "select public.register_social_asset($1, $2, 'image/jpeg', 1000, null) as id",
          [tenantA, `${tenantA}/six.jpg`],
        ),
      )
    ).id;
    await db.query("update public.social_assets set project_id = $1 where id = $2", [
      otherProject,
      fresh,
    ]);
    const slides = SLIDES([`${tenantA}/six.jpg`]);
    const [filed] = await service<{ id: string | null }>(
      "select public.file_social_month_draft($1, $2::jsonb) as id",
      [
        run.id,
        JSON.stringify({
          kind: "project",
          planned_for: at(3),
          caption: "Slides from the run.",
          asset_ids: [],
          pictured_ids: [fresh],
          slides,
          photos_show: "A sun rug, tufted.",
          project_id: otherProject,
          topic: null,
        }),
      ],
    );
    expect(filed.id).toBeTruthy();
    const [post] = await as<Record<string, unknown>>(
      member,
      "select photos_show, channels, slides is not null as has_slides, ai_draft from public.social_posts where id = $1",
      [filed.id],
    );
    expect(post).toEqual({
      photos_show: "A sun rug, tufted.",
      channels: ["facebook", "instagram"],
      has_slides: true,
      ai_draft: "Slides from the run.",
    });
    // The same photo again, as a plain carousel: already used.
    const [again] = await service<{ id: string | null }>(
      "select public.file_social_month_draft($1, $2::jsonb) as id",
      [
        run.id,
        JSON.stringify({
          kind: "project",
          planned_for: at(4),
          caption: "Again.",
          asset_ids: [fresh],
          project_id: otherProject,
        }),
      ],
    );
    expect(again.id).toBeNull();
    // Slides that aren't slides are refused.
    await expect(
      service("select public.file_social_month_draft($1, $2::jsonb)", [
        run.id,
        JSON.stringify({
          kind: "topic",
          planned_for: at(5),
          caption: "Bad.",
          slides: { v: 1, slides: [] },
        }),
      ]),
    ).rejects.toThrow(/slides_not_valid/);
  });
});
