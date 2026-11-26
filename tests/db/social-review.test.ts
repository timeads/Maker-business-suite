import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };
type Row = {
  id: string;
  status: string;
  review: string | null;
  review_note: string | null;
  scheduled_for: string | null;
  planned_for: string | null;
  approved_by: string | null;
};

let db: PGlite;
let owner: User;
let admin: User;
let member: User;
let other: User;
let tenantA: string;
let tenantB: string;
let photo: string;

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

function as<T>(user: User, sql: string, params: unknown[] = []): Promise<T[]> {
  return asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);
}
const row = async (id: string) =>
  (await db.query<Row>("select * from public.social_posts where id = $1", [id])).rows[0];

async function draft(user: User, tenant: string, plannedFor: string | null = later(120)) {
  const rows = await as<{ id: string }>(
    user,
    `select public.save_social_post_full($1, null, 'Fresh off the frame', $2, '{facebook}', null,
       '{}'::jsonb, null, null, $3, $4) as id`,
    [tenant, tenant === tenantA ? [photo] : [], "Fresh off the frame", plannedFor],
  );
  return rows[0].id;
}

const schedule = (user: User, tenant: string, id: string | null, at = later(60)) =>
  as<{ id: string }>(
    user,
    "select public.save_social_post($1, $2, 'Hello', null, '{facebook}', $3) as id",
    [tenant, id, at],
  );

const setReview = (tenant: string, body: object) =>
  as(owner, "select public.save_config($1, 'social', 'review', $2::jsonb)", [
    tenant,
    JSON.stringify({ version: 1, ...body }),
  ]);

beforeAll(async () => {
  db = await createTestDb();
  owner = { id: await createUser(db, "owner@a.test"), email: "owner@a.test" };
  admin = { id: await createUser(db, "admin@a.test"), email: "admin@a.test" };
  member = { id: await createUser(db, "member@a.test"), email: "member@a.test" };
  other = { id: await createUser(db, "other@b.test"), email: "other@b.test" };
  tenantA = (
    await as<{ id: string }>(owner, "select id from public.create_tenant('Studio A', 'UTC', 'USD')")
  )[0].id;
  tenantB = (
    await as<{ id: string }>(other, "select id from public.create_tenant('Studio B', 'UTC', 'USD')")
  )[0].id;
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'admin'), ($1, $3, 'member')",
    [tenantA, admin.id, member.id],
  );
  photo = (
    await asService(db, (tx) =>
      tx.query<{ id: string }>(
        "select public.register_social_asset($1, $2, 'image/jpeg', 1000, null) as id",
        [tenantA, `${tenantA}/photo.jpg`],
      ),
    )
  ).rows[0].id;
});

describe("without the setting (today's behaviour)", () => {
  it("anyone on the team can still schedule, and who did is kept", async () => {
    const [{ id }] = await schedule(member, tenantA, null);
    const saved = await row(id);
    expect(saved.status).toBe("scheduled");
    expect(saved.approved_by).toBe(member.id);
  });

  it("only owners and admins approve or send back", async () => {
    const id = await draft(member, tenantA);
    await as(member, "select public.submit_social_post($1, $2)", [tenantA, id]);
    await expect(
      as(member, "select public.approve_social_post($1, $2, null)", [tenantA, id]),
    ).rejects.toThrow(/not_approver/);
    await expect(
      as(member, "select public.send_back_social_post($1, $2, 'Too long')", [tenantA, id]),
    ).rejects.toThrow(/not_approver/);
    await as(admin, "select public.approve_social_post($1, $2, null)", [tenantA, id]);
    const approved = await row(id);
    expect(approved.status).toBe("scheduled");
    expect(approved.review).toBeNull();
    expect(approved.approved_by).toBe(admin.id);
    expect(approved.planned_for).toBeNull();
    expect(approved.scheduled_for).not.toBeNull();
  });
});

describe("review", () => {
  it("a draft waits for review, is sent back with a note, and comes back", async () => {
    const id = await draft(member, tenantA);
    await as(member, "select public.submit_social_post($1, $2)", [tenantA, id]);
    expect((await row(id)).review).toBe("waiting");
    await expect(
      as(owner, "select public.send_back_social_post($1, $2, '  ')", [tenantA, id]),
    ).rejects.toThrow(/needs_note/);
    await as(owner, "select public.send_back_social_post($1, $2, 'Swap the second photo')", [
      tenantA,
      id,
    ]);
    const back = await row(id);
    expect(back.status).toBe("draft");
    expect(back.review).toBe("sent_back");
    expect(back.review_note).toBe("Swap the second photo");
    // Saving it again keeps it where it was in review.
    await as(
      member,
      `select public.save_social_post_full($1, $2, 'Better words', $3, '{facebook}', null,
         '{}'::jsonb, null, null, null, $4)`,
      [tenantA, id, [photo], later(120)],
    );
    expect((await row(id)).review).toBe("sent_back");
    await as(member, "select public.submit_social_post($1, $2)", [tenantA, id]);
    expect((await row(id)).review).toBe("waiting");
  });

  it("a scheduled post sent back is a draft again, pencilled in for its time", async () => {
    const at = later(90);
    const [{ id }] = await schedule(owner, tenantA, null, at);
    await as(admin, "select public.send_back_social_post($1, $2, 'Not this week')", [tenantA, id]);
    const back = await row(id);
    expect(back.status).toBe("draft");
    expect(new Date(back.planned_for as string).toISOString()).toBe(at);
    expect(back.scheduled_for).toBeNull();
  });

  it("approving needs a time, a place and something to post", async () => {
    const noTime = await draft(member, tenantA, null);
    await expect(
      as(owner, "select public.approve_social_post($1, $2, null)", [tenantA, noTime]),
    ).rejects.toThrow(/no_time/);
    const past = await draft(member, tenantA, later(-120));
    await expect(
      as(owner, "select public.approve_social_post($1, $2, null)", [tenantA, past]),
    ).rejects.toThrow(/past/);
    // A time given at approval wins over the pencilled one.
    await as(owner, "select public.approve_social_post($1, $2, $3)", [tenantA, past, later(30)]);
    expect((await row(past)).status).toBe("scheduled");
  });

  it("a post that has gone out can't be approved, sent back or submitted", async () => {
    const [{ id }] = await schedule(owner, tenantA, null);
    await db.query(
      `update public.social_posts set status = 'published', results = '{"facebook":{"id":"1"}}' where id = $1`,
      [id],
    );
    for (const sql of [
      "select public.approve_social_post($1, $2, null)",
      "select public.send_back_social_post($1, $2, 'x')",
      "select public.submit_social_post($1, $2)",
    ]) {
      await expect(as(owner, sql, [tenantA, id])).rejects.toThrow(/locked/);
    }
  });
});

describe("approve all", () => {
  it("approves a month's waiting posts and the ticked ones, skipping what can't go", async () => {
    const month = later(60 * 24 * 40).slice(0, 7);
    const inMonth = `${month}-15T10:00:00.000Z`;
    const a = await draft(member, tenantA, inMonth);
    const b = await draft(member, tenantA, inMonth);
    const notWaiting = await draft(member, tenantA, inMonth);
    const ticked = await draft(member, tenantA, later(300));
    const noTime = await draft(member, tenantA, null);
    for (const id of [a, b]) {
      await as(member, "select public.submit_social_post($1, $2)", [tenantA, id]);
    }
    await expect(
      as(member, "select public.approve_social_posts($1, '{}', $2)", [tenantA, month]),
    ).rejects.toThrow(/not_approver/);
    const [{ result }] = await as<{
      result: { approved: string[]; skipped: { id: string; reason: string }[] };
    }>(owner, "select public.approve_social_posts($1, $2, $3) as result", [
      tenantA,
      [ticked, noTime],
      month,
    ]);
    expect(new Set(result.approved)).toEqual(new Set([a, b, ticked]));
    expect(result.skipped).toEqual([{ id: noTime, reason: "no_time" }]);
    expect((await row(notWaiting)).status).toBe("draft");
    expect((await row(a)).status).toBe("scheduled");
  });

  it("never reaches another workspace's posts", async () => {
    const theirs = (
      await as<{ id: string }>(
        other,
        `select public.save_social_post_full($1, null, 'Theirs', '{}', '{facebook}', null,
           '{}'::jsonb, null, null, null, $2) as id`,
        [tenantB, later(200)],
      )
    )[0].id;
    const [{ result }] = await as<{ result: { approved: string[] } }>(
      owner,
      "select public.approve_social_posts($1, $2, null) as result",
      [tenantA, [theirs]],
    );
    expect(result.approved).toEqual([]);
    await expect(
      as(owner, "select public.approve_social_post($1, $2, null)", [tenantB, theirs]),
    ).rejects.toThrow();
    await expect(
      as(owner, "select public.send_back_social_post($1, $2, 'x')", [tenantA, theirs]),
    ).rejects.toThrow(/locked/);
    await expect(
      as(owner, "select public.submit_social_post($1, $2)", [tenantB, theirs]),
    ).rejects.toThrow();
    expect((await row(theirs)).status).toBe("draft");
  });
});

describe("where the workspace requires approval", () => {
  it("a drafted post can't be scheduled by someone who can't approve", async () => {
    await setReview(tenantA, { require_approval: true, approvers: ["owner", "admin"] });
    const id = await draft(member, tenantA);
    await expect(schedule(member, tenantA, id)).rejects.toThrow(/needs_approval/);
    await expect(schedule(member, tenantA, null)).rejects.toThrow(/needs_approval/);
    expect((await row(id)).status).toBe("draft");
    // An approver scheduling it is the approval.
    await schedule(admin, tenantA, id);
    expect((await row(id)).approved_by).toBe(admin.id);
  });

  it("no route can slip an unapproved post past the rule", async () => {
    const id = await draft(member, tenantA);
    await expect(
      db.query(
        "update public.social_posts set status = 'scheduled', scheduled_for = now() + interval '1 hour' where id = $1",
        [id],
      ),
    ).rejects.toThrow(/needs_approval/);
    await expect(
      db.query(
        "update public.social_posts set status = 'scheduled', scheduled_for = now() + interval '1 hour', approved_by = $2 where id = $1",
        [id, member.id],
      ),
    ).rejects.toThrow(/needs_approval/);
  });

  it("the worker can still retry an approved post", async () => {
    const [{ id }] = await schedule(owner, tenantA, null);
    await db.query(
      "update public.social_posts set scheduled_for = now() - interval '1 minute' where id = $1",
      [id],
    );
    await asService(db, (tx) => tx.query("select * from public.claim_due_social_posts(50)"));
    const status = await asService(db, (tx) =>
      tx.query<{ s: string }>("select public.finish_social_post($1, '{}'::jsonb, true) as s", [id]),
    );
    expect(status.rows[0].s).toBe("scheduled");
  });

  it("the setting chooses who approves; owners always can", async () => {
    await setReview(tenantA, { require_approval: true, approvers: ["member"] });
    const id = await draft(admin, tenantA);
    await expect(
      as(admin, "select public.approve_social_post($1, $2, null)", [tenantA, id]),
    ).rejects.toThrow(/not_approver/);
    await as(member, "select public.approve_social_post($1, $2, null)", [tenantA, id]);
    expect((await row(id)).approved_by).toBe(member.id);
    const again = await draft(admin, tenantA);
    await as(owner, "select public.approve_social_post($1, $2, null)", [tenantA, again]);
    expect((await row(again)).status).toBe("scheduled");
  });

  it("only owners and admins change the setting", async () => {
    await expect(
      as(member, "select public.save_config($1, 'social', 'review', '{\"version\":1}'::jsonb)", [
        tenantA,
      ]),
    ).rejects.toThrow(/Only owners and admins/);
    await setReview(tenantA, { require_approval: false });
  });
});
