import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLACES, PLACE_RULES } from "../../src/lib/social/networks";
import { asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };
type Account = {
  id: string;
  network: string;
  platform_id: string;
  login_id: string | null;
  active: boolean;
  offered: boolean;
  paused: boolean;
  needs_login: boolean;
};

let db: PGlite;
let owner: User;
let member: User;
let other: User;
let tenantA: string;
let tenantB: string;
let photo: string;
let video: string;

// Made-up ids only; nothing here is a real account or credential.
const TT_LOGIN_1 = "tt-open-id-1";
const TT_LOGIN_2 = "tt-open-id-2";
const LI_LOGIN = "li-sub-1";
const LI_PERSON = "urn:li:person:li-sub-1";
const LI_ORG = "urn:li:organization:5550001";

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const q = <T>(who: User, sql: string, params: unknown[] = []) =>
  asUser(db, who, async (tx) => (await tx.query<T>(sql, params)).rows);
const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
const accounts = async (tenant: string, network?: string) =>
  (
    await db.query<Account>(
      "select * from public.social_accounts where tenant_id = $1 and ($2::text is null or network = $2) order by created_at, platform_id",
      [tenant, network ?? null],
    )
  ).rows;
const accountOf = async (tenant: string, platformId: string) =>
  (await accounts(tenant)).find((a) => a.platform_id === platformId)!;
const postRow = async (id: string) =>
  (
    await db.query<{
      status: string;
      results: Record<string, Record<string, unknown>>;
      attempts: number;
      target_options: Record<string, unknown>;
      error: string | null;
    }>(
      "select status, results, attempts, target_options, error from public.social_posts where id = $1",
      [id],
    )
  ).rows[0];

const connect = (tenant: string, provider: string, login: string, by: User) =>
  service(
    "select public.save_connection($1, $2, $3, 'Made-up login', '{}', $4::jsonb, $5, $6::jsonb)",
    [
      tenant,
      provider,
      login,
      JSON.stringify({ access_token: "logins", secrets: {} }),
      by.id,
      JSON.stringify({ logins: [{ id: login, name: "Made-up login" }] }),
    ],
  );
const note = (tenant: string, provider: string, login: string, list: object[]) =>
  service<{ r: { offered: number; started: number } }>(
    "select public.note_login_accounts($1, $2, $3, $4::jsonb) as r",
    [tenant, provider, login, JSON.stringify(list)],
  );

type Save = {
  id?: string | null;
  accounts: string[];
  channels: string[];
  caption?: string;
  assets?: string[];
  at?: string | null;
  captions?: Record<string, string>;
  options?: Record<string, unknown>;
};
const save = async (who: User, tenant: string, s: Save) =>
  (
    await q<{ id: string }>(
      who,
      `select public.save_social_post_with_options($1, $2, null, $3::uuid[], $4::text[], $5, $6::uuid[], $7,
         $8::jsonb, null, null, null, null, $9::jsonb) as id`,
      [
        tenant,
        s.id ?? null,
        s.accounts,
        s.channels,
        s.caption ?? "Words",
        s.assets ?? [],
        s.at === undefined ? later(60) : s.at,
        JSON.stringify(s.captions ?? {}),
        JSON.stringify(s.options ?? {}),
      ],
    )
  )[0].id;

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

describe("one table of rules", () => {
  it("the database's rules are the app's, place by place", async () => {
    for (const place of PLACES) {
      const { rows } = await db.query<Record<string, unknown>>(
        "select * from private.social_place_rule($1)",
        [place],
      );
      const rule = PLACE_RULES[place];
      expect(rows[0], place).toEqual({
        network: rule.network,
        caption_max: rule.captionMax,
        hashtags_max: rule.hashtagsMax,
        photos_max: rule.photosMax,
        video_ok: rule.videoOk,
        needs_media: rule.needsMedia,
        needs_video: rule.needsVideo,
      });
      const { rows: net } = await db.query<{ n: string }>(
        "select private.social_place_network($1) as n",
        [place],
      );
      expect(net[0].n).toBe(rule.network);
    }
    const { rows } = await db.query("select * from private.social_place_rule('pinterest')");
    expect(rows).toHaveLength(0);
  });
});

describe("logins and their accounts", () => {
  it("a first TikTok login's account is used straight away, on the main brand", async () => {
    await connect(tenantA, "tiktok", TT_LOGIN_1, owner);
    const [{ r }] = await note(tenantA, "tiktok", TT_LOGIN_1, [
      { network: "tiktok", platform_id: TT_LOGIN_1, name: "Studio", handle: "studio.makes" },
    ]);
    expect(r.started).toBe(1);
    const [account] = await accounts(tenantA, "tiktok");
    expect(account).toMatchObject({ platform_id: TT_LOGIN_1, login_id: TT_LOGIN_1, active: true });
  });

  it("another login's account arrives unused; the one in use stays as it is", async () => {
    await note(tenantA, "tiktok", TT_LOGIN_2, [
      { network: "tiktok", platform_id: TT_LOGIN_2, name: "Second", handle: "second_one" },
    ]);
    const rows = await accounts(tenantA, "tiktok");
    expect(rows.map((a) => [a.platform_id, a.active])).toEqual([
      [TT_LOGIN_1, true],
      [TT_LOGIN_2, false],
    ]);
  });

  it("a LinkedIn login offers the person and the company pages they look after", async () => {
    await connect(tenantA, "linkedin", LI_LOGIN, owner);
    await note(tenantA, "linkedin", LI_LOGIN, [
      { network: "linkedin", platform_id: LI_ORG, name: "Studio Ltd", tasks: ["ADMINISTRATOR"] },
      { network: "linkedin", platform_id: LI_PERSON, name: "Sam Maker" },
      // Another network's account is never taken from this login.
      { network: "tiktok", platform_id: "sneaky", name: "No" },
    ]);
    const rows = await accounts(tenantA, "linkedin");
    expect(rows.map((a) => [a.platform_id, a.active])).toEqual([
      [LI_ORG, true],
      [LI_PERSON, false],
    ]);
    expect(await accountOf(tenantA, "sneaky")).toBeUndefined();
  });

  it("only the server notes logins; members read their accounts and nobody else does", async () => {
    await expect(
      q(owner, "select public.note_login_accounts($1, 'tiktok', 'x', '[]'::jsonb)", [tenantA]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      q(owner, "select public.mark_social_login($1, 'tiktok', 'x', true)", [tenantA]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      q(owner, "select * from public.claim_due_social_posts_for(5, '{tiktok}')"),
    ).rejects.toThrow(/permission denied/);
    expect(
      await q(
        member,
        "select id from public.social_accounts where tenant_id = $1 and network in ('tiktok', 'linkedin')",
        [tenantA],
      ),
    ).toHaveLength(4);
    expect(
      await q(other, "select id from public.social_accounts where tenant_id = $1", [tenantA]),
    ).toHaveLength(0);
    await expect(note(tenantB, "tiktok", "x", [])).rejects.toThrow(/Not connected/);
  });

  it("a login whose token ran out says so on its accounts, and connecting again clears it", async () => {
    await service("select public.mark_social_login($1, 'tiktok', $2, true)", [tenantA, TT_LOGIN_1]);
    expect((await accountOf(tenantA, TT_LOGIN_1)).needs_login).toBe(true);
    expect((await accountOf(tenantA, TT_LOGIN_2)).needs_login).toBe(false);
    await note(tenantA, "tiktok", TT_LOGIN_1, [
      { network: "tiktok", platform_id: TT_LOGIN_1, name: "Studio", handle: "studio.makes" },
    ]);
    expect((await accountOf(tenantA, TT_LOGIN_1)).needs_login).toBe(false);
  });

  it("only owners and admins let go of one login, and the others carry on", async () => {
    await db.query(
      `update public.connections set metadata = $2::jsonb where tenant_id = $1 and provider = 'tiktok'`,
      [tenantA, JSON.stringify({ logins: [{ id: TT_LOGIN_1 }, { id: TT_LOGIN_2 }] })],
    );
    await expect(
      q(member, "select public.forget_social_login($1, 'tiktok', $2)", [tenantA, TT_LOGIN_2]),
    ).rejects.toThrow(/Only owners and admins/);
    await expect(
      q(other, "select public.forget_social_login($1, 'tiktok', $2)", [tenantA, TT_LOGIN_2]),
    ).rejects.toThrow();
    const [{ left }] = await q<{ left: number }>(
      owner,
      "select public.forget_social_login($1, 'tiktok', $2) as left",
      [tenantA, TT_LOGIN_2],
    );
    expect(left).toBe(1);
    expect(await accountOf(tenantA, TT_LOGIN_2)).toMatchObject({ active: false, offered: false });
    expect((await accountOf(tenantA, TT_LOGIN_1)).active).toBe(true);
  });
});

describe("each network's rules when a post is scheduled", () => {
  let tiktok: string;
  let linkedinOrg: string;
  beforeAll(async () => {
    tiktok = (await accountOf(tenantA, TT_LOGIN_1)).id;
    linkedinOrg = (await accountOf(tenantA, LI_ORG)).id;
  });
  const choices = (extra: object = {}) => ({ [tiktok]: { privacy_level: "SELF_ONLY", ...extra } });

  it("TikTok needs a video and takes no photos", async () => {
    await expect(
      save(owner, tenantA, { accounts: [tiktok], channels: ["tiktok"], options: choices() }),
    ).rejects.toThrow(/place_rule:needs_video:tiktok/);
    await expect(
      save(owner, tenantA, {
        accounts: [tiktok],
        channels: ["tiktok"],
        assets: [photo],
        options: choices(),
      }),
    ).rejects.toThrow(/place_rule:needs_video:tiktok/);
  });

  it("TikTok needs someone to choose who can see it, among what TikTok allows", async () => {
    await expect(
      save(owner, tenantA, { accounts: [tiktok], channels: ["tiktok"], assets: [video] }),
    ).rejects.toThrow(/tiktok_needs_privacy/);
    await service("select public.note_social_account_options($1, $2, $3::jsonb)", [
      tenantA,
      tiktok,
      JSON.stringify({
        privacy_level_options: ["SELF_ONLY", "FOLLOWER_OF_CREATOR", "NOT_A_LEVEL"],
      }),
    ]);
    await expect(
      save(owner, tenantA, {
        accounts: [tiktok],
        channels: ["tiktok"],
        assets: [video],
        options: choices({ privacy_level: "PUBLIC_TO_EVERYONE" }),
      }),
    ).rejects.toThrow(/tiktok_privacy_not_allowed/);
    await expect(
      save(owner, tenantA, {
        accounts: [tiktok],
        channels: ["tiktok"],
        assets: [video],
        options: choices({ brand_content: true }),
      }),
    ).rejects.toThrow(/tiktok_branded_private/);
    await expect(
      save(owner, tenantA, {
        accounts: [tiktok],
        channels: ["tiktok"],
        assets: [video],
        options: { [tiktok]: { privacy_level: "EVERYBODY" } },
      }),
    ).rejects.toThrow(/options_not_valid/);
    const id = await save(owner, tenantA, {
      accounts: [tiktok],
      channels: ["tiktok"],
      assets: [video],
      options: {
        ...choices({ allow_comment: true }),
        [linkedinOrg]: { privacy_level: "SELF_ONLY" },
      },
    });
    const row = await postRow(id);
    expect(row.status).toBe("scheduled");
    // Only the post's TikTok accounts keep choices, each with every switch said.
    expect(row.target_options).toEqual({
      [tiktok]: {
        privacy_level: "SELF_ONLY",
        allow_comment: true,
        allow_duet: false,
        allow_stitch: false,
        brand_organic: false,
        brand_content: false,
      },
    });
  });

  it("a draft can be saved without any of that", async () => {
    const id = await save(owner, tenantA, {
      accounts: [tiktok],
      channels: ["tiktok"],
      at: null,
    });
    expect((await postRow(id)).status).toBe("draft");
  });

  it("a newer network needs an account; words alone are fine on LinkedIn", async () => {
    await expect(save(owner, tenantA, { accounts: [], channels: ["linkedin"] })).rejects.toThrow(
      /place_rule:no_account:linkedin/,
    );
    const id = await save(owner, tenantA, { accounts: [linkedinOrg], channels: ["linkedin"] });
    expect((await postRow(id)).status).toBe("scheduled");
  });

  it("each account's own words are held to its network's rules", async () => {
    await service(
      "select public.save_connection($1, 'meta', '1001', 'Page', '{instagram_basic,instagram_content_publish}', $2::jsonb, $3, $4::jsonb)",
      [
        tenantA,
        JSON.stringify({ access_token: "made-up-for-a-test" }),
        owner.id,
        JSON.stringify({ instagram_id: "2001", instagram_username: "made_up" }),
      ],
    );
    const ig = (await accounts(tenantA, "instagram"))[0];
    await q(owner, "select public.choose_social_accounts($1, $2::jsonb)", [
      tenantA,
      JSON.stringify([{ id: ig.id, active: true }]),
    ]);
    const tags = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ");
    await expect(
      save(owner, tenantA, {
        accounts: [ig.id],
        channels: ["instagram"],
        assets: [photo],
        captions: { [ig.id]: tags },
      }),
    ).rejects.toThrow(/place_rule:hashtags:instagram/);
    // The same words on LinkedIn are fine.
    expect(
      await save(owner, tenantA, {
        accounts: [linkedinOrg],
        channels: ["linkedin"],
        captions: { [linkedinOrg]: tags },
      }),
    ).toBeTruthy();
  });
});

describe("sending once", () => {
  let tiktok: string;
  let postId: string;
  const target = () => `${tiktok}:tiktok`;
  const claim = (places: string[]) =>
    service<{ id: string }>("select id from public.claim_due_social_posts_for(10, $1::text[])", [
      places,
    ]);
  const finish = (results: object, retry = true) =>
    service<{ s: string }>("select public.finish_social_post($1, $2::jsonb, $3) as s", [
      postId,
      JSON.stringify(results),
      retry,
    ]);
  const due = () =>
    db.query(
      "update public.social_posts set scheduled_for = now() - interval '1 minute', locked_at = null where id = $1",
      [postId],
    );

  beforeAll(async () => {
    tiktok = (await accountOf(tenantA, TT_LOGIN_1)).id;
    await db.query("update public.social_posts set status = 'draft', scheduled_for = null");
    postId = await save(owner, tenantA, {
      accounts: [tiktok],
      channels: ["tiktok"],
      assets: [video],
      options: { [tiktok]: { privacy_level: "SELF_ONLY" } },
    });
    await due();
  });

  it("the earlier worker never claims a TikTok post; the new one does", async () => {
    const old = await service<{ id: string }>("select id from public.claim_due_social_posts(10)");
    expect(old.map((p) => p.id)).not.toContain(postId);
    const claimed = await claim(["facebook", "instagram", "instagram_story", "tiktok", "linkedin"]);
    expect(claimed.map((p) => p.id)).toContain(postId);
  });

  it("the one write is marked first, and only once", async () => {
    const begin = () =>
      service<{ ok: boolean }>("select public.begin_social_target($1, $2) as ok", [
        postId,
        target(),
      ]);
    expect((await begin())[0].ok).toBe(true);
    expect((await begin())[0].ok).toBe(false);
    expect((await postRow(postId)).results[target()]).toHaveProperty("sending");
  });

  it("while TikTok prepares it, it comes back to be asked about, without using a try", async () => {
    const before = (await postRow(postId)).attempts;
    expect((await finish({ [target()]: { pending: "publish-1", since: "x" } }))[0].s).toBe(
      "scheduled",
    );
    const row = await postRow(postId);
    expect(row.attempts).toBe(before - 1);
    // Nobody can change or delete it meanwhile.
    await expect(
      save(owner, tenantA, {
        id: postId,
        accounts: [tiktok],
        channels: ["tiktok"],
        assets: [video],
        options: { [tiktok]: { privacy_level: "SELF_ONLY" } },
      }),
    ).rejects.toThrow(/in_flight/);
    await expect(q(owner, "select public.delete_social_post($1)", [postId])).rejects.toThrow(
      /in_flight/,
    );
  });

  it("an answer we never got is not sent again; a person settles it", async () => {
    await due();
    await claim(["tiktok"]);
    expect((await finish({ [target()]: { unsure: "We didn't hear back from TikTok" } }))[0].s).toBe(
      "failed",
    );
    await expect(
      q(member, "select public.retry_social_post($1, $2)", [tenantA, postId]),
    ).rejects.toThrow(/settle_unsure/);
    await expect(
      q(other, "select public.settle_social_target($1, $2, $3, true)", [tenantA, postId, target()]),
    ).rejects.toThrow();
    // "It isn't there": it can be tried again.
    await q(member, "select public.settle_social_target($1, $2, $3, false)", [
      tenantA,
      postId,
      target(),
    ]);
    expect((await postRow(postId)).results).toEqual({});
    await q(member, "select public.retry_social_post($1, $2)", [tenantA, postId]);
    expect((await postRow(postId)).status).toBe("scheduled");
  });

  it("a person who finds it there marks it posted, and it is never sent again", async () => {
    await due();
    await claim(["tiktok"]);
    await finish({ [target()]: { unsure: "We didn't hear back" } });
    const [{ s }] = await q<{ s: string }>(
      owner,
      "select public.settle_social_target($1, $2, $3, true) as s",
      [tenantA, postId, target()],
    );
    expect(s).toBe("published");
    expect((await postRow(postId)).results[target()]).toMatchObject({ id: "checked-by-hand" });
  });

  it("a refusal that won't be tried again by itself is marked, and a retry clears it", async () => {
    const id = await save(owner, tenantA, {
      accounts: [tiktok],
      channels: ["tiktok"],
      assets: [video],
      options: { [tiktok]: { privacy_level: "SELF_ONLY" } },
    });
    await db.query(
      "update public.social_posts set scheduled_for = now() - interval '1 minute' where id = $1",
      [id],
    );
    await claim(["tiktok"]);
    const [{ s }] = await service<{ s: string }>(
      "select public.finish_social_post($1, $2::jsonb, false) as s",
      [id, JSON.stringify({ [`${tiktok}:tiktok`]: { error: "TikTok said no" } })],
    );
    expect(s).toBe("failed");
    expect((await postRow(id)).results[`${tiktok}:tiktok`]).toEqual({
      error: "TikTok said no",
      stop: true,
    });
    await q(member, "select public.retry_social_post($1, $2)", [tenantA, id]);
    expect((await postRow(id)).results).toEqual({});
  });
});

describe("disconnecting", () => {
  it("puts a login's accounts aside, and connecting it again brings them back", async () => {
    await db.query(
      "update public.connections set status = 'disconnected' where tenant_id = $1 and provider = 'linkedin'",
      [tenantA],
    );
    expect(await accountOf(tenantA, LI_ORG)).toMatchObject({
      active: false,
      offered: false,
      paused: true,
    });
    await connect(tenantA, "linkedin", LI_LOGIN, owner);
    await note(tenantA, "linkedin", LI_LOGIN, [
      { network: "linkedin", platform_id: LI_ORG, name: "Studio Ltd" },
      { network: "linkedin", platform_id: LI_PERSON, name: "Sam Maker" },
    ]);
    expect(await accountOf(tenantA, LI_ORG)).toMatchObject({ active: true, paused: false });
    expect((await accountOf(tenantA, LI_PERSON)).active).toBe(false);
  });
});
