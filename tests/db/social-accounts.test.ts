import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountAllows } from "../../src/lib/connections/meta-access";
import { asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };
type Account = {
  id: string;
  tenant_id: string;
  network: string;
  platform_id: string;
  page_id: string;
  brand_id: string;
  active: boolean;
  offered: boolean;
  paused: boolean;
};

let db: PGlite;
let owner: User;
let member: User;
let other: User;
let tenantA: string;
let tenantB: string;
let mainBrand: string;
let secondBrand: string;
let photo: string;
let video: string;

// Made-up ids only.
const PAGE_1 = "1001";
const IG_1 = "2001";
const PAGE_2 = "1002";
const IG_2 = "2002";
const PAGE_B = "1009";
const SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
  "pages_messaging",
  "pages_manage_metadata",
  "instagram_manage_messages",
  "business_management",
  "pages_read_user_content",
  "pages_manage_engagement",
  "instagram_manage_comments",
];

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const q = <T>(who: User, sql: string, params: unknown[] = []) =>
  asUser(db, who, async (tx) => (await tx.query<T>(sql, params)).rows);
const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
const accounts = async (tenant: string) =>
  (
    await db.query<Account>(
      "select * from public.social_accounts where tenant_id = $1 order by page_id, network",
      [tenant],
    )
  ).rows;
const accountOf = async (tenant: string, platformId: string) =>
  (await accounts(tenant)).find((a) => a.platform_id === platformId)!;

const connect = (tenant: string, page: string, ig: string | null, by: User) =>
  service(
    "select public.save_connection($1, 'meta', $2, 'First Page', $3, $4::jsonb, $5, $6::jsonb)",
    [
      tenant,
      page,
      SCOPES,
      JSON.stringify({ access_token: "made-up-for-a-test" }),
      by.id,
      JSON.stringify({ instagram_id: ig, instagram_username: ig ? "first_made_up" : null }),
    ],
  );

const offered = (pages: { id: string; ig: string | null; name: string; tasks?: string[] }[]) =>
  pages.flatMap((page) => [
    {
      network: "facebook",
      platform_id: page.id,
      page_id: page.id,
      name: page.name,
      handle: null,
      tasks: page.tasks ?? null,
    },
    ...(page.ig
      ? [
          {
            network: "instagram",
            platform_id: page.ig,
            page_id: page.id,
            name: page.name,
            handle: `${page.name.toLowerCase().replace(/\W+/g, "_")}`,
            tasks: page.tasks ?? null,
          },
        ]
      : []),
  ]);

beforeAll(async () => {
  db = await createTestDb();
  owner = { id: await createUser(db, "owner@a.test"), email: "owner@a.test" };
  member = { id: await createUser(db, "member@a.test"), email: "member@a.test" };
  other = { id: await createUser(db, "other@b.test"), email: "other@b.test" };
  tenantA = (
    await q<{ id: string }>(owner, "select id from public.create_tenant('Studio A', 'UTC', 'USD')")
  )[0].id;
  tenantB = (
    await q<{ id: string }>(other, "select id from public.create_tenant('Studio B', 'UTC', 'USD')")
  )[0].id;
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, member.id],
  );
  mainBrand = (
    await db.query<{ id: string }>(
      "select id from public.brands where tenant_id = $1 and is_default",
      [tenantA],
    )
  ).rows[0].id;
  secondBrand = (
    await q<{ id: string }>(owner, "select public.add_brand($1, 'Second Site', $2::jsonb) as id", [
      tenantA,
      JSON.stringify({
        version: 1,
        name: "Second Site",
        colors: [
          { name: "ink", hex: "#111111" },
          { name: "paper", hex: "#fafafa" },
        ],
      }),
    ])
  )[0].id;
  photo = (
    await service<{ id: string }>(
      "select public.register_social_asset($1, $2, 'image/jpeg', 1000, null) as id",
      [tenantA, `${tenantA}/photo.jpg`],
    )
  )[0].id;
  await service("select public.set_social_asset_size($1, $2, 1080, 1350)", [tenantA, photo]);
  video = (
    await service<{ id: string }>(
      "select public.register_social_asset($1, $2, 'video/mp4', 1000, null) as id",
      [tenantA, `${tenantA}/clip.mp4`],
    )
  )[0].id;
});
afterAll(() => db.close());

describe("accounts from a login", () => {
  it("a first connection uses its Page and that Page's Instagram account, on the main brand", async () => {
    await connect(tenantA, PAGE_1, IG_1, owner);
    const rows = await accounts(tenantA);
    expect(rows.map((a) => [a.network, a.platform_id, a.page_id, a.active])).toEqual([
      ["facebook", PAGE_1, PAGE_1, true],
      ["instagram", IG_1, PAGE_1, true],
    ]);
    expect(rows.every((a) => a.brand_id === mainBrand)).toBe(true);
  });

  it("further Pages from the login arrive unused, and the ones in use stay as they are", async () => {
    const [{ r }] = await service<{ r: { waiting: number } }>(
      "select public.note_meta_accounts($1, $2::jsonb) as r",
      [
        tenantA,
        JSON.stringify(
          offered([
            { id: PAGE_1, ig: IG_1, name: "First Page", tasks: ["MANAGE"] },
            { id: PAGE_2, ig: IG_2, name: "Second Page", tasks: ["CREATE_CONTENT", "MESSAGING"] },
          ]),
        ),
      ],
    );
    expect(r.waiting).toBe(2);
    const rows = await accounts(tenantA);
    expect(rows.filter((a) => a.active).map((a) => a.platform_id)).toEqual([PAGE_1, IG_1]);
    expect(rows.filter((a) => !a.active).map((a) => a.platform_id)).toEqual([PAGE_2, IG_2]);
  });

  it("members read their accounts; another workspace reads none of them", async () => {
    expect(
      await q(member, "select id from public.social_accounts where tenant_id = $1", [tenantA]),
    ).toHaveLength(4);
    expect(
      await q(other, "select id from public.social_accounts where tenant_id = $1", [tenantA]),
    ).toHaveLength(0);
    await expect(
      q(owner, "update public.social_accounts set active = true where tenant_id = $1", [tenantA]),
    ).rejects.toThrow(/permission denied/);
  });

  it("only owners and admins choose, and only this workspace's accounts and brands", async () => {
    const ig2 = await accountOf(tenantA, IG_2);
    const choose = (who: User, tenant: string, choices: object[]) =>
      q(who, "select public.choose_social_accounts($1, $2::jsonb)", [
        tenant,
        JSON.stringify(choices),
      ]);
    await expect(choose(member, tenantA, [{ id: ig2.id, active: true }])).rejects.toThrow(
      /Only owners and admins/,
    );
    await expect(choose(other, tenantB, [{ id: ig2.id, active: true }])).rejects.toThrow(
      /Account not found/,
    );
    const otherBrand = (
      await db.query<{ id: string }>("select id from public.brands where tenant_id = $1", [tenantB])
    ).rows[0].id;
    await expect(
      choose(owner, tenantA, [{ id: ig2.id, active: true, brand_id: otherBrand }]),
    ).rejects.toThrow(/Brand not found/);
    const page2 = await accountOf(tenantA, PAGE_2);
    await choose(owner, tenantA, [
      { id: ig2.id, active: true, brand_id: secondBrand },
      { id: page2.id, active: true, brand_id: secondBrand },
    ]);
    const after = await accounts(tenantA);
    expect(after.filter((a) => a.active)).toHaveLength(4);
    expect((await accountOf(tenantA, IG_2)).brand_id).toBe(secondBrand);
    // The first Page's accounts weren't touched.
    expect((await accountOf(tenantA, IG_1)).brand_id).toBe(mainBrand);
  });

  it("an account another workspace uses can't be used here too", async () => {
    await connect(tenantB, PAGE_B, null, other);
    await service("select public.note_meta_accounts($1, $2::jsonb)", [
      tenantB,
      JSON.stringify(
        offered([
          { id: PAGE_B, ig: null, name: "B" },
          { id: PAGE_2, ig: null, name: "Shared" },
        ]),
      ),
    ]);
    const shared = (await accounts(tenantB)).find((a) => a.platform_id === PAGE_2)!;
    expect(shared.active).toBe(false);
    await expect(
      q(other, "select public.choose_social_accounts($1, $2::jsonb)", [
        tenantB,
        JSON.stringify([{ id: shared.id, active: true }]),
      ]),
    ).rejects.toThrow(/in_use/);
  });

  it("a brand that accounts post as can't be put away", async () => {
    await expect(
      q(owner, "select public.archive_brand($1, $2, true)", [tenantA, secondBrand]),
    ).rejects.toThrow(/has_accounts/);
  });

  it("disconnecting puts the accounts aside, and reconnecting brings them all back", async () => {
    await db.query(
      "update public.connections set status = 'disconnected' where tenant_id = $1 and provider = 'meta'",
      [tenantA],
    );
    expect((await accounts(tenantA)).filter((a) => a.active)).toHaveLength(0);
    await connect(tenantA, PAGE_1, IG_1, owner);
    expect((await accounts(tenantA)).filter((a) => a.active)).toHaveLength(4);
  });

  it("the per-Page rule in the database matches the app's", async () => {
    const cases: [string[] | null, string][] = [
      [null, "posting"],
      [["MANAGE"], "comments"],
      [["CREATE_CONTENT"], "posting"],
      [["CREATE_CONTENT"], "messages"],
      [["MESSAGING"], "messages"],
      [["MODERATE"], "comments"],
      [["ANALYZE"], "posting"],
      [[], "messages"],
    ];
    for (const [tasks, use] of cases) {
      const { rows } = await db.query<{ ok: boolean }>(
        "select private.meta_tasks_allow($1::text[], $2) as ok",
        [tasks, use],
      );
      expect(rows[0].ok, `${JSON.stringify(tasks)} ${use}`).toBe(
        accountAllows(use as "posting" | "messages" | "comments", tasks),
      );
    }
  });
});

describe("routing messages and comments to the right account", () => {
  beforeAll(async () => {
    await q(owner, "select public.save_config($1, 'helpdesk', 'channels', $2::jsonb)", [
      tenantA,
      JSON.stringify({
        version: 1,
        instagram: true,
        facebook: true,
        instagram_comments: true,
        facebook_comments: true,
      }),
    ]);
  });

  const route = async (object: string, id: string, use = "messages") =>
    (
      await service<{ tenant_id: string; social_account_id: string; page_id: string }>(
        "select * from public.resolve_meta_account($1, $2, $3)",
        [object, id, use],
      )
    )[0] ?? null;

  it("each account's deliveries go to its workspace and account, through its own Page", async () => {
    const ig2 = await accountOf(tenantA, IG_2);
    const routed = await route("instagram", IG_2);
    expect(routed).toMatchObject({
      tenant_id: tenantA,
      social_account_id: ig2.id,
      page_id: PAGE_2,
    });
    expect((await route("page", PAGE_1))?.social_account_id).toBe(
      (await accountOf(tenantA, PAGE_1)).id,
    );
    // The second Page's tasks don't include moderating, so its comments aren't taken.
    expect(await route("page", PAGE_2, "comments")).toBeNull();
    expect((await route("page", PAGE_1, "comments"))?.tenant_id).toBe(tenantA);
  });

  it("still drops what no workspace uses", async () => {
    expect(await route("instagram", "9999")).toBeNull();
    const [{ r }] = await service<{ r: string }>(
      "select public.enqueue_meta_event($1, $2::jsonb) as r",
      [
        "f".repeat(32),
        JSON.stringify({ object: "instagram", entry: [{ id: "9999", messaging: [] }] }),
      ],
    );
    expect(r).toBe("dropped");
    const [{ r: kept }] = await service<{ r: string }>(
      "select public.enqueue_meta_event($1, $2::jsonb) as r",
      [
        "e".repeat(32),
        JSON.stringify({ object: "instagram", entry: [{ id: IG_2, messaging: [] }] }),
      ],
    );
    expect(kept).toBe("queued");
  });

  it("a message is filed on a conversation of the account it came to", async () => {
    const ig1 = await accountOf(tenantA, IG_1);
    const ig2 = await accountOf(tenantA, IG_2);
    const file = async (account: string, person: string, mid: string) =>
      (
        await service<{ r: { ticket_id: string; result: string } }>(
          `select public.file_account_message($1, $2, 'instagram', $3, $4, 'Hello', 'reply', null,
             'Instagram message: Hello', now()) as r`,
          [account, tenantA, person, mid],
        )
      )[0].r;
    const first = await file(ig1.id, "person-on-first", "mid-1");
    const second = await file(ig2.id, "person-on-second", "mid-2");
    const again = await file(ig2.id, "person-on-second", "mid-3");
    expect(first.result).toBe("created");
    expect(second.result).toBe("created");
    expect(again.ticket_id).toBe(second.ticket_id);
    const { rows } = await db.query<{ id: string; social_account_id: string }>(
      "select id, social_account_id from public.tickets where id = any ($1)",
      [[first.ticket_id, second.ticket_id]],
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.social_account_id]))).toEqual({
      [first.ticket_id]: ig1.id,
      [second.ticket_id]: ig2.id,
    });
    const [ctx] = await service<{
      social_account_id: string;
      page_id: string;
      platform_id: string;
    }>("select * from public.social_ticket_account($1, $2)", [tenantA, second.ticket_id]);
    expect(ctx).toMatchObject({ social_account_id: ig2.id, page_id: PAGE_2, platform_id: IG_2 });
    // Members can read which account a conversation is on.
    const seen = await q<{ social_account_id: string }>(
      member,
      "select social_account_id from public.tickets where id = $1",
      [second.ticket_id],
    );
    expect(seen[0].social_account_id).toBe(ig2.id);
    // The account is the workspace's own and of that channel, or nothing is filed.
    await expect(
      service(
        `select public.file_account_message($1, $2, 'facebook', 'x', 'mid-x', 'Hi', 'reply', null, 'S', now())`,
        [ig2.id, tenantA],
      ),
    ).rejects.toThrow(/isn't this workspace's/);
    const pageB = (await accounts(tenantB)).find((a) => a.platform_id === PAGE_B)!;
    await expect(
      service(
        `select public.file_account_message($1, $2, 'facebook', 'x', 'mid-y', 'Hi', 'reply', null, 'S', now())`,
        [pageB.id, tenantA],
      ),
    ).rejects.toThrow(/isn't this workspace's/);
  });

  it("a comment's conversation and post carry the account too", async () => {
    const page1 = await accountOf(tenantA, PAGE_1);
    const [{ r }] = await service<{ r: { ticket_id: string; post_id: string } }>(
      `select public.file_account_comment($1, $2, 'facebook', 'commenter-1', 'Sam', null, 'c-1', null,
         'post-1', 'How much is it?', null, 'Facebook comment: How much', now(), true, '{}') as r`,
      [page1.id, tenantA],
    );
    const { rows } = await db.query<{ t: string; p: string }>(
      `select (select social_account_id from public.tickets where id = $1) as t,
              (select social_account_id from public.comment_posts where id = $2) as p`,
      [r.ticket_id, r.post_id],
    );
    expect(rows[0]).toEqual({ t: page1.id, p: page1.id });
  });

  it("the automatic reply's business name is the brand's, for a brand other than the main one", async () => {
    const { rows } = await db.query<{ id: string; ticket_id: string }>(
      "select m.id, m.ticket_id from public.messages m where m.provider_message_id in ('mid-1', 'mid-2') order by m.provider_message_id",
    );
    const facts = async (messageId: string) =>
      (
        await service<{ business_name: string }>(
          "select business_name from public.auto_reply_facts($1, $2)",
          [tenantA, messageId],
        )
      )[0].business_name;
    expect(await facts(rows[0].id)).toBe("Studio A");
    expect(await facts(rows[1].id)).toBe("Second Site");
  });
});

describe("posting to accounts", () => {
  type Post = {
    id: string;
    status: string;
    results: Record<string, { id?: string; error?: string }>;
    account_ids: string[];
    brand_id: string;
    captions: Record<string, string>;
  };
  const post = async (id: string) =>
    (await db.query<Post>("select * from public.social_posts where id = $1", [id])).rows[0];
  const save = (
    who: User,
    brand: string | null,
    accountIds: string[],
    channels: string[],
    at: string | null,
    captions: Record<string, string> = {},
    media = photo,
  ) =>
    q<{ id: string }>(
      who,
      `select public.save_social_post_to($1, null, $2, $3, $4, 'Fresh off the frame', $5, $6, $7::jsonb) as id`,
      [tenantA, brand, accountIds, channels, [media], at, JSON.stringify(captions)],
    );
  const claim = () =>
    service<{ id: string; account_ids: string[] }>(
      "select id, account_ids from public.claim_due_social_posts(10)",
    );
  const finish = (id: string, results: object, retry = true) =>
    service<{ s: string }>("select public.finish_social_post($1, $2::jsonb, $3) as s", [
      id,
      JSON.stringify(results),
      retry,
    ]);

  it("names its brand and accounts, with a caption of its own per account", async () => {
    const page2 = await accountOf(tenantA, PAGE_2);
    const ig2 = await accountOf(tenantA, IG_2);
    const [{ id }] = await save(
      member,
      secondBrand,
      [page2.id, ig2.id],
      ["facebook", "instagram"],
      null,
      {
        [ig2.id]: "Swipe to see it finished",
        [page2.id]: "Fresh off the frame",
        "not-an-account": "dropped",
      },
    );
    const saved = await post(id);
    expect(saved.brand_id).toBe(secondBrand);
    expect(saved.account_ids).toEqual([page2.id, ig2.id]);
    expect(saved.captions).toEqual({ [ig2.id]: "Swipe to see it finished" });
  });

  it("refuses accounts of another brand or workspace, and places with no account", async () => {
    const ig1 = await accountOf(tenantA, IG_1);
    const ig2 = await accountOf(tenantA, IG_2);
    const page2 = await accountOf(tenantA, PAGE_2);
    await expect(save(member, secondBrand, [ig1.id], ["instagram"], null)).rejects.toThrow(
      /account_not_for_post/,
    );
    const pageB = (await accounts(tenantB)).find((a) => a.platform_id === PAGE_B)!;
    await expect(save(member, secondBrand, [pageB.id], ["facebook"], null)).rejects.toThrow(
      /account_not_for_post/,
    );
    await expect(
      save(member, secondBrand, [page2.id], ["facebook", "instagram"], later(60)),
    ).rejects.toThrow(/no_account_for_place/);
    // An Instagram account can't take a Facebook place.
    await expect(save(member, secondBrand, [ig2.id], ["facebook"], null)).rejects.toThrow(
      /account_not_for_post/,
    );
  });

  it("an older caller naming no accounts gets the main brand's accounts for its places", async () => {
    const [{ id }] = await q<{ id: string }>(
      member,
      "select public.save_social_post($1, null, 'Hello', $2, '{facebook,instagram}', null) as id",
      [tenantA, photo],
    );
    const saved = await post(id);
    expect(saved.brand_id).toBe(mainBrand);
    expect(new Set(saved.account_ids)).toEqual(
      new Set([(await accountOf(tenantA, PAGE_1)).id, (await accountOf(tenantA, IG_1)).id]),
    );
  });

  it("answers merge per account: one that went is never sent again; a failed one is retried alone", async () => {
    const page1 = await accountOf(tenantA, PAGE_1);
    const page2 = await accountOf(tenantA, PAGE_2);
    const ig1 = await accountOf(tenantA, IG_1);
    const [{ id }] = await save(
      owner,
      mainBrand,
      [page1.id, ig1.id],
      ["facebook", "instagram", "instagram_story"],
      later(-1),
      {},
      video,
    );
    await db.query(
      "update public.social_posts set scheduled_for = now() - interval '1 minute' where id = $1",
      [id],
    );
    const [claimed] = (await claim()).filter((p) => p.id === id);
    expect(claimed).toBeTruthy();
    const fb = `${page1.id}:facebook`;
    const feed = `${ig1.id}:instagram`;
    const story = `${ig1.id}:instagram_story`;
    // Facebook went; Instagram's feed failed; the Story wasn't reached. Not worth retrying.
    expect(
      (await finish(id, { [fb]: { id: "fb-1" }, [feed]: { error: "Nope" } }, false))[0].s,
    ).toBe("failed");
    let saved = await post(id);
    expect(saved.results[fb]).toEqual({ id: "fb-1" });
    expect(saved.status).toBe("failed");
    // A partly sent post can't be edited...
    await expect(
      q(owner, "select public.save_social_post($1, $2, 'Changed', null, '{facebook}', null)", [
        tenantA,
        id,
      ]),
    ).rejects.toThrow(/locked/);
    // ...but it can be tried again, and only what failed is still owed.
    await q(member, "select public.retry_social_post($1, $2)", [tenantA, id]);
    saved = await post(id);
    expect(saved.status).toBe("scheduled");
    expect(Object.keys(saved.results)).toEqual([fb]);
    await db.query(
      "update public.social_posts set scheduled_for = now() - interval '1 minute' where id = $1",
      [id],
    );
    expect((await claim()).some((p) => p.id === id)).toBe(true);
    // A late answer for Facebook again can't undo what went; the rest go now.
    expect(
      (
        await finish(id, {
          [feed]: { id: "ig-1" },
          [story]: { id: "st-1" },
          [`${page2.id}:facebook`]: { id: "stray" },
        })
      )[0].s,
    ).toBe("published");
    saved = await post(id);
    expect(saved.results).toEqual({
      [fb]: { id: "fb-1" },
      [feed]: { id: "ig-1" },
      [story]: { id: "st-1" },
    });
    // A published post can't be tried again.
    await expect(
      q(member, "select public.retry_social_post($1, $2)", [tenantA, id]),
    ).rejects.toThrow(/locked/);
  });

  it("another workspace can't retry it", async () => {
    const [{ id }] = await save(
      owner,
      mainBrand,
      [(await accountOf(tenantA, PAGE_1)).id],
      ["facebook"],
      null,
    );
    await expect(
      q(other, "select public.retry_social_post($1, $2)", [tenantA, id]),
    ).rejects.toThrow();
  });

  it("an answer under a bare place name (an older worker) counts for that place's one account", async () => {
    const page1 = await accountOf(tenantA, PAGE_1);
    const [{ id }] = await save(owner, mainBrand, [page1.id], ["facebook"], later(-1));
    await db.query(
      "update public.social_posts set scheduled_for = now() - interval '1 minute' where id = $1",
      [id],
    );
    await claim();
    expect((await finish(id, { facebook: { id: "fb-old" } }))[0].s).toBe("published");
    const saved = await post(id);
    expect(saved.results[`${page1.id}:facebook`]).toEqual({ id: "fb-old" });
  });
});
