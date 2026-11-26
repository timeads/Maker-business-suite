import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrationsAfter, asService, asUser, createTestDbUntil, createUser } from "./harness";

/**
 * The brands and accounts migrations, run over a database holding rows
 * shaped like a live one's before them: a workspace with one Page and its
 * Instagram account, posts that went out, half went out, are waiting and are
 * drafts, help desk conversations from both channels and a comment, and a
 * workspace whose connection was disconnected.
 */

const LAST_BEFORE = "20270127000100_social_sizes.sql";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NO_IG_PAGE = "5010";
const PAGE = "5001";
const IG = "6001";
const OLD_PAGE = "5009";
const SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
  "pages_messaging",
  "pages_manage_metadata",
  "instagram_manage_messages",
  "pages_read_user_content",
  "pages_manage_engagement",
];

let db: PGlite;
let owner: { id: string; email: string };
const ids: Record<string, string> = {};

const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);

async function post(
  name: string,
  values: {
    status: string;
    channels: string[];
    results?: object;
    captions?: object;
    scheduled?: string | null;
    published?: boolean;
  },
) {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.social_posts
       (tenant_id, caption, asset_ids, channels, status, scheduled_for, published_at, results, captions,
        attempts, updated_at)
     values ($1, 'Words', $2, $3, $4::public.social_post_status, $5, $6, $7::jsonb, $8::jsonb, 1,
             '2026-11-01T00:00:00Z')
     returning id`,
    [
      A,
      [ids.photo],
      values.channels,
      values.status,
      values.scheduled ?? (values.status === "draft" ? null : "2026-11-20T15:00:00Z"),
      values.published ? "2026-11-20T15:00:05Z" : null,
      JSON.stringify(values.results ?? {}),
      JSON.stringify(values.captions ?? {}),
    ],
  );
  ids[name] = rows[0].id;
}

beforeAll(async () => {
  db = await createTestDbUntil(LAST_BEFORE);
  owner = { id: await createUser(db, "owner@a.test"), email: "owner@a.test" };
  await db.query(
    `insert into public.tenants (id, slug, name, timezone, currency)
     values ($1, 'old-shop', 'Old Shop', 'UTC', 'USD'), ($2, 'gone', 'Gone Shop', 'UTC', 'USD')`,
    [A, D],
  );
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'owner')",
    [A, owner.id],
  );
  const connect = (tenant: string, page: string, ig: string | null) =>
    service(
      "select public.save_connection($1, 'meta', $2, 'Old Page · @old_shop', $3, $4::jsonb, $5, $6::jsonb)",
      [
        tenant,
        page,
        SCOPES,
        JSON.stringify({ access_token: "made-up-for-a-test" }),
        owner.id,
        JSON.stringify({ instagram_id: ig, instagram_username: ig ? "old_shop" : null }),
      ],
    );
  await connect(A, PAGE, IG);
  await connect(D, OLD_PAGE, null);
  await db.query("update public.connections set status = 'disconnected' where tenant_id = $1", [D]);
  await db.query(
    `insert into public.configs (tenant_id, module, key, body) values
       ($1, 'helpdesk', 'channels', '{"version":1,"instagram":true,"facebook":true,"facebook_comments":true}')`,
    [A],
  );
  ids.photo = (
    await service<{ id: string }>(
      "select public.register_social_asset($1, $2, 'image/jpeg', 1000, null) as id",
      [A, `${A}/old.jpg`],
    )
  )[0].id;
  await service("select public.set_social_asset_size($1, $2, 1080, 1350)", [A, ids.photo]);
  // Before review was switched on, posts were scheduled with no approver.
  await post("published", {
    status: "published",
    channels: ["facebook", "instagram"],
    results: { facebook: { id: "fb-1" }, instagram: { id: "ig-1" } },
    captions: { instagram: "Own Instagram words" },
    published: true,
  });
  await post("half", {
    status: "failed",
    channels: ["facebook", "instagram"],
    results: { facebook: { id: "fb-2" }, instagram: { error: "Instagram was busy" } },
  });
  await post("waiting", { status: "scheduled", channels: ["facebook"] });
  await post("draft", { status: "draft", channels: [] });
  // Instagram from a workspace whose Page has no Instagram account: it keeps its places.
  await db.query(
    "insert into public.tenants (id, slug, name, timezone, currency) values ($1, 'no-ig', 'No IG', 'UTC', 'USD')",
    [E],
  );
  await connect(E, NO_IG_PAGE, null);
  ids.noIg = (
    await db.query<{ id: string }>(
      `insert into public.social_posts (tenant_id, caption, channels, status, scheduled_for)
       values ($1, 'Words', '{facebook,instagram}', 'scheduled', '2026-12-20T15:00:00Z') returning id`,
      [E],
    )
  ).rows[0].id;

  // Review switched on afterwards: those posts have no approver, and must still move across.
  await db.query(
    `insert into public.configs (tenant_id, module, key, body)
     values ($1, 'social', 'review', '{"version":1,"require_approval":true}')`,
    [A],
  );
  const message = (channel: string, person: string, mid: string) =>
    service<{ r: { ticket_id: string; contact_id: string } }>(
      `select public.file_social_message($1, $2, $3, $4, 'Hi', 'reply', null, 'Subject', now()) as r`,
      [A, channel, person, mid],
    );
  ids.igTicket = (await message("instagram", "ig-person", "old-mid-1"))[0].r.ticket_id;
  ids.fbTicket = (await message("facebook", "fb-person", "old-mid-2"))[0].r.ticket_id;
  const [{ r: comment }] = await service<{ r: { ticket_id: string; post_id: string } }>(
    `select public.file_social_comment($1, 'facebook', 'commenter', 'Sam', null, 'old-c-1', null,
       'old-post', 'Love it, how much?', null, 'Facebook comment', now(), true, '{}') as r`,
    [A],
  );
  ids.commentTicket = comment.ticket_id;
  ids.commentPost = comment.post_id;

  await applyMigrationsAfter(db, LAST_BEFORE);
});
afterAll(() => db.close());

const accountId = async (platformId: string) =>
  (
    await db.query<{ id: string }>("select id from public.social_accounts where platform_id = $1", [
      platformId,
    ])
  ).rows[0].id;

describe("moving an existing workspace across", () => {
  it("its one Page and Instagram account become two accounts in use, on its main brand", async () => {
    const { rows } = await db.query<{
      network: string;
      platform_id: string;
      page_id: string;
      name: string;
      handle: string | null;
      active: boolean;
      is_default: boolean;
    }>(
      `select a.network, a.platform_id, a.page_id, a.name, a.handle, a.active, b.is_default
       from public.social_accounts a join public.brands b on b.id = a.brand_id
       where a.tenant_id = $1 order by a.network`,
      [A],
    );
    expect(rows).toEqual([
      {
        network: "facebook",
        platform_id: PAGE,
        page_id: PAGE,
        name: "Old Page",
        handle: null,
        active: true,
        is_default: true,
      },
      {
        network: "instagram",
        platform_id: IG,
        page_id: PAGE,
        name: "Old Page",
        handle: "old_shop",
        active: true,
        is_default: true,
      },
    ]);
  });

  it("a disconnected workspace keeps its account on file, out of use", async () => {
    const { rows } = await db.query<{ active: boolean; offered: boolean }>(
      "select active, offered from public.social_accounts where tenant_id = $1",
      [D],
    );
    expect(rows).toEqual([{ active: false, offered: false }]);
  });

  it("every post gets the brand and the accounts for its places; nothing else about it moves", async () => {
    const fb = await accountId(PAGE);
    const ig = await accountId(IG);
    const { rows } = await db.query<{
      id: string;
      status: string;
      account_ids: string[];
      results: Record<string, unknown>;
      captions: Record<string, string>;
      updated_at: Date;
      brand_id: string | null;
    }>("select * from public.social_posts where tenant_id = $1", [A]);
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(rows.every((row) => row.brand_id !== null)).toBe(true);
    expect(byId[ids.published].status).toBe("published");
    expect(byId[ids.published].account_ids).toEqual([fb, ig]);
    // The answers are kept under the bare names (for a worker still on the old code) and the targets.
    expect(byId[ids.published].results).toEqual({
      facebook: { id: "fb-1" },
      instagram: { id: "ig-1" },
      [`${fb}:facebook`]: { id: "fb-1" },
      [`${ig}:instagram`]: { id: "ig-1" },
    });
    expect(byId[ids.published].captions).toEqual({
      instagram: "Own Instagram words",
      [ig]: "Own Instagram words",
    });
    expect(byId[ids.waiting].account_ids).toEqual([fb]);
    expect(byId[ids.waiting].status).toBe("scheduled");
    expect(byId[ids.draft].account_ids).toEqual([]);
    expect(
      rows.every((row) => new Date(row.updated_at).toISOString() === "2026-11-01T00:00:00.000Z"),
    ).toBe(true);
  });

  it("a post with a place its workspace has no account for keeps going by its places", async () => {
    const { rows } = await db.query<{ account_ids: string[] }>(
      "select account_ids from public.social_posts where id = $1",
      [ids.noIg],
    );
    expect(rows[0].account_ids).toEqual([]);
  });

  it("the half-sent post, tried again, only sends what didn't go", async () => {
    const fb = await accountId(PAGE);
    const ig = await accountId(IG);
    await asUser(db, owner, (tx) =>
      tx.query("select public.retry_social_post($1, $2)", [A, ids.half]),
    );
    await db.query(
      "update public.social_posts set scheduled_for = now() - interval '1 minute' where id = $1",
      [ids.half],
    );
    const claimed = await service<{ id: string }>(
      "select id from public.claim_due_social_posts(10)",
    );
    expect(claimed.map((row) => row.id)).toContain(ids.half);
    const [{ s }] = await service<{ s: string }>(
      "select public.finish_social_post($1, $2::jsonb, true) as s",
      [ids.half, JSON.stringify({ [`${ig}:instagram`]: { id: "ig-2" } })],
    );
    expect(s).toBe("published");
    const { rows } = await db.query<{ results: Record<string, { id?: string }> }>(
      "select results from public.social_posts where id = $1",
      [ids.half],
    );
    expect(rows[0].results[`${fb}:facebook`]).toEqual({ id: "fb-2" });
  });

  it("conversations, people and the comment's post get their channel's account", async () => {
    const fb = await accountId(PAGE);
    const ig = await accountId(IG);
    const { rows } = await db.query<{ id: string; social_account_id: string }>(
      "select id, social_account_id from public.tickets where tenant_id = $1",
      [A],
    );
    const byId = Object.fromEntries(rows.map((row) => [row.id, row.social_account_id]));
    expect(byId[ids.igTicket]).toBe(ig);
    expect(byId[ids.fbTicket]).toBe(fb);
    expect(byId[ids.commentTicket]).toBe(fb);
    const contacts = await db.query<{ channel: string; social_account_id: string }>(
      "select channel, social_account_id from public.contacts where tenant_id = $1 and channel <> 'email'",
      [A],
    );
    expect(
      contacts.rows.every((c) => c.social_account_id === (c.channel === "instagram" ? ig : fb)),
    ).toBe(true);
    const posts = await db.query<{ social_account_id: string }>(
      "select social_account_id from public.comment_posts where id = $1",
      [ids.commentPost],
    );
    expect(posts.rows[0].social_account_id).toBe(fb);
  });

  it("deliveries for the old Page still arrive, and the same person lands on their conversation", async () => {
    const [{ r }] = await service<{ r: string }>(
      "select public.enqueue_meta_event($1, $2::jsonb) as r",
      ["a".repeat(32), JSON.stringify({ object: "instagram", entry: [{ id: IG, messaging: [] }] })],
    );
    expect(r).toBe("queued");
    const ig = await accountId(IG);
    const [{ r: filed }] = await service<{ r: { ticket_id: string; result: string } }>(
      `select public.file_account_message($1, $2, 'instagram', 'ig-person', 'new-mid', 'Again', 'reply',
         null, 'Subject', now()) as r`,
      [ig, A],
    );
    expect(filed).toMatchObject({ result: "threaded", ticket_id: ids.igTicket });
  });
});
