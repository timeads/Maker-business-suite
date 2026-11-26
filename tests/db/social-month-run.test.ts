import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { comingReviewDay, monthDue, monthEnd } from "../../src/lib/social/month";
import {
  applyMigrationsAfter,
  asService,
  asUser,
  createTestDb,
  createTestDbUntil,
  createUser,
} from "./harness";

/**
 * The monthly run: once per workspace + brand + month, claimed by one worker,
 * filed only as drafts through `file_social_month_draft`; and the edits kept
 * when a drafted caption is changed. Every name here is invented.
 */

type User = { id: string; email: string };

let db: PGlite;
let owner: User;
let member: User;
let other: User;
let tenantA: string;
let tenantB: string;
let brandA: string;
let photos: string[];
let project: string;

function as<T>(user: User, sql: string, params: unknown[] = []): Promise<T[]> {
  return asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);
}
function service<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
}

/** Today on a UTC workspace's clock, and a review day that makes the run due today. */
function dueToday() {
  const today = new Date().toISOString().slice(0, 10);
  const dom = Number(today.slice(8, 10));
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  if (dom <= 28) return { week: Math.ceil(dom / 7), weekday: dow, lead_days: 0 };
  // Late in the month: the first weekday of next month, a few days ahead.
  const first = new Date(`${today}T00:00:00Z`);
  first.setUTCMonth(first.getUTCMonth() + 1, 1);
  return { week: 1, weekday: first.getUTCDay(), lead_days: 7 };
}

const setPlan = (tenant: string, body: object) =>
  as(owner, "select public.save_config($1, 'social', 'plan', $2::jsonb)", [
    tenant,
    JSON.stringify({ version: 1, ...body }),
  ]);

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
  const brand = async (tenant: string) =>
    (
      await db.query<{ id: string }>(
        "select id from public.brands where tenant_id = $1 and is_default",
        [tenant],
      )
    ).rows[0].id;
  brandA = await brand(tenantA);
  photos = [];
  for (const name of ["one", "two", "three"]) {
    photos.push(
      (
        await service<{ id: string }>(
          "select public.register_social_asset($1, $2, 'image/jpeg', 1000, null) as id",
          [tenantA, `${tenantA}/${name}.jpg`],
        )
      )[0].id,
    );
  }
  project = (
    await as<{ id: string }>(
      owner,
      "select public.save_social_project($1, null, 'Moss rug', 'For a nook', 'rugs', false) as id",
      [tenantA],
    )
  )[0].id;
  await db.query(
    `insert into public.social_accounts (tenant_id, brand_id, network, platform_id, page_id, active)
     values ($1, $2, 'facebook', 'page-1', 'page-1', true),
            ($1, $2, 'instagram', 'ig-1', 'page-1', true)`,
    [tenantA, brandA],
  );
});

describe("review days, in the database and in the app", () => {
  it("agree on every day of a year, for every kind of review day", async () => {
    const days: string[] = [];
    for (let t = Date.parse("2026-11-01"); t < Date.parse("2027-11-01"); t += 3 * 86_400_000) {
      days.push(new Date(t).toISOString().slice(0, 10));
    }
    for (const day of [
      { week: 1, weekday: 1, lead_days: 10 },
      { week: 4, weekday: 0, lead_days: 0 },
      { week: 2, weekday: 5, lead_days: 21 },
    ]) {
      const { rows } = await db.query<{
        today: string;
        coming: string;
        end_day: string;
        due: string | null;
      }>(
        `select d::text as today,
                private.social_coming_review_day(d, $2, $3)::text as coming,
                private.social_month_end(private.social_coming_review_day(d, $2, $3), $2, $3)::text as end_day,
                private.social_month_due(d, $2, $3, $4)::text as due
         from unnest($1::date[]) d`,
        [days, day.week, day.weekday, day.lead_days],
      );
      for (const row of rows) {
        expect(row.coming, row.today).toBe(comingReviewDay(row.today, day));
        expect(row.end_day, row.today).toBe(monthEnd(row.coming, day));
        expect(row.due, row.today).toBe(monthDue(row.today, day));
      }
    }
  });
});

describe("claiming a month", () => {
  it("does nothing by itself until an owner or admin switches it on", async () => {
    await setPlan(tenantA, { review_days: [{ brand_id: null, ...dueToday(), auto: false }] });
    expect(await service("select * from public.claim_social_month_runs(5)")).toEqual([]);
  });

  it("only owners and admins can ask for a run, and only with a review day", async () => {
    await expect(
      as(member, "select public.request_social_month_run($1, null)", [tenantA]),
    ).rejects.toThrow(/Only owners and admins/);
    await expect(
      as(other, "select public.request_social_month_run($1, null)", [tenantB]),
    ).rejects.toThrow(/no_review_day/);
    await expect(
      as(other, "select public.request_social_month_run($1, null)", [tenantA]),
    ).rejects.toThrow();
  });

  it("queues once per workspace, brand and month, claimed by one worker", async () => {
    await setPlan(tenantA, {
      topics: [{ id: "rugs", name: "Rugs", from: "projects" }],
      review_days: [{ brand_id: null, ...dueToday(), auto: true }],
    });
    const claimed = await service<{ id: string; brand_id: string; source: string }>(
      "select * from public.claim_social_month_runs(5)",
    );
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ brand_id: brandA, source: "schedule" });
    // Asked again: nothing new, the same month isn't queued twice.
    expect(await service("select * from public.claim_social_month_runs(5)")).toEqual([]);
    // "Run it now" finds the run that is going rather than starting another.
    const [{ id }] = await as<{ id: string }>(
      owner,
      "select public.request_social_month_run($1, null) as id",
      [tenantA],
    );
    expect(id).toBe(claimed[0].id);
  });

  it("members of the workspace see its runs; nobody else does", async () => {
    expect(
      await as(member, "select id from public.social_month_runs where tenant_id = $1", [tenantA]),
    ).toHaveLength(1);
    expect(
      await as(other, "select id from public.social_month_runs where tenant_id = $1", [tenantA]),
    ).toEqual([]);
    await expect(
      as(
        owner,
        "insert into public.social_month_runs (tenant_id, brand_id, window_start, window_end) values ($1, $2, current_date, current_date)",
        [tenantA, brandA],
      ),
    ).rejects.toThrow();
    await expect(as(owner, "select * from public.claim_social_month_runs(1)")).rejects.toThrow();
  });
});

describe("filing a run's drafts", () => {
  let run: { id: string; window_start: string; window_end: string };
  const inWindow = () => `${run.window_end}T12:00:00Z`;
  const file = (draft: object) =>
    service<{ id: string | null }>("select public.file_social_month_draft($1, $2::jsonb) as id", [
      run.id,
      JSON.stringify(draft),
    ]);

  beforeAll(async () => {
    run = (
      await db.query<{ id: string; window_start: string; window_end: string }>(
        "select id, window_start::text, window_end::text from public.social_month_runs where tenant_id = $1",
        [tenantA],
      )
    ).rows[0];
  });

  it("is a draft for the brand's accounts, never scheduled, and a plain draft where review is off", async () => {
    const [{ id }] = await file({
      kind: "project",
      planned_for: inWindow(),
      caption: "Moss, row by row.",
      asset_ids: [photos[0], photos[1]],
      project_id: project,
      topic: "rugs",
    });
    const { rows } = await db.query<Record<string, unknown>>(
      "select * from public.social_posts where id = $1",
      [id],
    );
    expect(rows[0]).toMatchObject({
      status: "draft",
      scheduled_for: null,
      review: null,
      brand_id: brandA,
      caption: "Moss, row by row.",
      ai_draft: "Moss, row by row.",
      month_run_id: run.id,
      project_id: project,
      channels: ["facebook", "instagram"],
      approved_by: null,
    });
    expect((rows[0].account_ids as string[]).length).toBe(2);
  });

  it("skips a time already taken, and a project photo already on a post", async () => {
    expect(
      (await file({ kind: "topic", planned_for: inWindow(), caption: "Again", asset_ids: [] }))[0]
        .id,
    ).toBeNull();
    const at = `${run.window_end}T23:00:00Z`;
    expect(
      (
        await file({
          kind: "project",
          planned_for: at,
          caption: "Reused",
          asset_ids: [photos[1], photos[2]],
          project_id: project,
        })
      )[0].id,
    ).toBeNull();
  });

  it("waits for review where approval is required", async () => {
    await as(owner, "select public.save_config($1, 'social', 'review', $2::jsonb)", [
      tenantA,
      JSON.stringify({ version: 1, require_approval: true }),
    ]);
    const [{ id }] = await file({
      kind: "topic",
      planned_for: `${run.window_end}T18:00:00Z`,
      caption: "A tip for the frame.",
      asset_ids: [],
    });
    const { rows } = await db.query<{ review: string; status: string; channels: string[] }>(
      "select review, status, channels from public.social_posts where id = $1",
      [id],
    );
    expect(rows[0]).toEqual({ review: "waiting", status: "draft", channels: ["facebook"] });
  });

  it("refuses what doesn't belong: a time outside the month, another workspace's photo, an empty caption", async () => {
    await expect(
      file({ kind: "topic", planned_for: "2099-01-01T10:00:00Z", caption: "Late", asset_ids: [] }),
    ).rejects.toThrow(/bad_time/);
    const theirs = (
      await service<{ id: string }>(
        "select public.register_social_asset($1, $2, 'image/jpeg', 1000, null) as id",
        [tenantB, `${tenantB}/x.jpg`],
      )
    )[0].id;
    await expect(
      file({
        kind: "topic",
        planned_for: `${run.window_end}T19:00:00Z`,
        caption: "x",
        asset_ids: [theirs],
      }),
    ).rejects.toThrow(/Photo not found/);
    await expect(
      file({
        kind: "topic",
        planned_for: `${run.window_end}T19:00:00Z`,
        caption: "  ",
        asset_ids: [],
      }),
    ).rejects.toThrow(/bad_caption/);
    await expect(
      as(owner, "select public.file_social_month_draft($1, '{}'::jsonb)", [run.id]),
    ).rejects.toThrow();
  });

  it("files nothing once the run is finished, and the month can't be asked for again", async () => {
    await service("select public.finish_social_month_run($1, 'done', '{}'::jsonb, null)", [run.id]);
    await expect(
      file({
        kind: "topic",
        planned_for: `${run.window_end}T20:00:00Z`,
        caption: "x",
        asset_ids: [],
      }),
    ).rejects.toThrow(/run_not_running/);
    await expect(
      as(owner, "select public.request_social_month_run($1, null)", [tenantA]),
    ).rejects.toThrow(/already_drafted/);
  });
});

describe("edits to Claude's drafts", () => {
  const saveDraft = (user: User, tenant: string, id: string | null, caption: string, ai: string) =>
    as<{ id: string }>(
      user,
      `select public.save_social_post_full($1, $2, $3, '{}', '{facebook}', null,
         '{}'::jsonb, null, null, $4, null) as id`,
      [tenant, id, caption, ai],
    );
  const edits = (user: User, post: string) =>
    as<{ which: string; before: string; after: string; edited_by: string | null }>(
      user,
      "select which, before, after, edited_by from public.social_post_edits where post_id = $1",
      [post],
    );

  it("keeps what Claude wrote beside the changed caption, following the latest save", async () => {
    const [{ id }] = await saveDraft(member, tenantA, null, "Drafted words", "Drafted words");
    expect(await edits(member, id)).toEqual([]);
    await saveDraft(member, tenantA, id, "My own words", "");
    expect(await edits(member, id)).toEqual([
      { which: "main", before: "Drafted words", after: "My own words", edited_by: member.id },
    ]);
    await saveDraft(owner, tenantA, id, "My own words, again", "");
    expect((await edits(member, id))[0]).toMatchObject({ after: "My own words, again" });
    // Back to Claude's words: nothing to learn.
    await saveDraft(member, tenantA, id, "Drafted words", "");
    expect(await edits(member, id)).toEqual([]);
  });

  it("keeps an account's own caption too", async () => {
    const [{ id }] = await saveDraft(member, tenantA, null, "Same", "Same");
    const [account] = (
      await db.query<{ id: string }>(
        "select id from public.social_accounts where tenant_id = $1 and network = 'facebook'",
        [tenantA],
      )
    ).rows;
    await as(
      member,
      `select public.save_social_post_to($1, $2, null, $3, '{facebook}', 'Same', '{}', null,
         $4::jsonb)`,
      [tenantA, id, [account.id], JSON.stringify({ [account.id]: "Just for the Page" })],
    );
    expect(await edits(member, id)).toEqual([
      { which: account.id, before: "Same", after: "Just for the Page", edited_by: member.id },
    ]);
  });

  it("is read only inside the workspace, and written only by the database", async () => {
    const [{ id }] = await saveDraft(owner, tenantA, null, "Changed", "Original");
    expect(await edits(other, id)).toEqual([]);
    await expect(
      as(
        owner,
        `insert into public.social_post_edits (tenant_id, post_id, which, before, after)
         values ($1, $2, 'main', 'a', 'b')`,
        [tenantA, id],
      ),
    ).rejects.toThrow();
    await expect(
      as(owner, "delete from public.social_post_edits where post_id = $1", [id]),
    ).rejects.toThrow();
  });
});

describe("posts saved before edits were kept", () => {
  it("bring what already differs from Claude's draft across, with no one named", async () => {
    const before = "20270130000100_social_month_run.sql";
    const old = await createTestDbUntil(before);
    const user = await createUser(old, "o@c.test");
    const tenant = (
      await asUser(old, { id: user }, (tx) =>
        tx.query<{ id: string }>("select id from public.create_tenant('Studio C', 'UTC', 'USD')"),
      )
    ).rows[0].id;
    for (const [caption, ai] of [
      ["Posted words", "Drafted words"],
      ["Same", "Same"],
      ["No draft", null],
    ]) {
      await asUser(old, { id: user }, (tx) =>
        tx.query(
          `select public.save_social_post_full($1, null, $2, '{}', '{facebook}', null,
             '{}'::jsonb, null, null, $3, null)`,
          [tenant, caption, ai],
        ),
      );
    }
    await applyMigrationsAfter(old, before);
    const { rows } = await old.query<{ before: string; after: string; edited_by: string | null }>(
      "select before, after, edited_by from public.social_post_edits where tenant_id = $1",
      [tenant],
    );
    expect(rows).toEqual([{ before: "Drafted words", after: "Posted words", edited_by: null }]);
  });
});
