import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let amy: User; // member of A
let bob: User; // owner of B
let tenantA: string;
let tenantB: string;

const q = <T>(who: User, sql: string, params: unknown[] = []) =>
  asUser(db, who, async (tx) => (await tx.query<T>(sql, params)).rows);
const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
const fails = async (run: Promise<unknown>, pattern: RegExp) =>
  expect(run.then(() => "ok").catch((err: Error) => err.message)).resolves.toMatch(pattern);

const body = (text: string) => JSON.stringify([{ t: "p", runs: [{ text }] }]);

const article = async (who: User, tenant: string, title: string) =>
  (
    await q<{ id: string }>(
      who,
      "select public.save_manual_article($1, null, $2, $3, '{}', false) as id",
      [tenant, title, body(`${title} body`)],
    )
  )[0].id;
const setState = (who: User, tenant: string, id: string, state: string) =>
  q<{ slug: string }>(who, "select public.set_help_article_state($1, $2, $3) as slug", [
    tenant,
    id,
    state,
  ]);
const switchOn = (who: User, tenant: string, on: boolean) =>
  q(who, "select public.save_config($1, 'helpdesk', 'help_centre', $2)", [
    tenant,
    JSON.stringify({ version: 1, on }),
  ]);
const listed = async (tenant: string) =>
  (await service<{ slug: string }>("select slug from public.help_centre_list($1)", [tenant])).map(
    (row) => row.slug,
  );
const read = async (tenant: string, slug: string) =>
  (
    await service<{ a: { id: string; slug: string; title: string; pictures: unknown[] } | null }>(
      "select public.help_centre_article($1, $2) as a",
      [tenant, slug],
    )
  )[0].a;

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  amy = { id: await createUser(db, "amy@a.test"), email: "amy@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  const tenantFor = async (owner: User, name: string) =>
    (
      await q<{ id: string }>(owner, "select id from public.create_tenant($1, 'UTC', 'USD')", [
        name,
      ])
    )[0].id;
  tenantA = await tenantFor(alice, "Help A");
  tenantB = await tenantFor(bob, "Help B");
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, amy.id],
  );
  await switchOn(alice, tenantA, true);
  await switchOn(bob, tenantB, true);
});

describe("who can reach what", () => {
  it("the new tables can't be written directly, nor read by a visitor", async () => {
    for (const table of ["help_article_slugs", "help_article_pictures"]) {
      const { rows } = await db.query<{ can: boolean }>(
        `select has_table_privilege('authenticated', 'public.${table}', 'insert')
             or has_table_privilege('authenticated', 'public.${table}', 'update')
             or has_table_privilege('authenticated', 'public.${table}', 'delete')
             or has_table_privilege('anon', 'public.${table}', 'select') as can`,
      );
      expect(rows[0].can, table).toBe(false);
    }
    for (const table of ["help_centre_hits", "help_picture_removals"]) {
      const { rows } = await db.query<{ can: boolean; rls: boolean }>(
        `select has_table_privilege('authenticated', 'private.${table}', 'select')
             or has_table_privilege('service_role', 'private.${table}', 'select')
             or has_table_privilege('anon', 'private.${table}', 'select') as can,
           (select relrowsecurity from pg_class where oid = 'private.${table}'::regclass) as rls`,
      );
      expect(rows[0], table).toEqual({ can: false, rls: true });
    }
  });

  it("the public reads belong to the server: no member and no visitor can call them", async () => {
    for (const call of [
      "select * from public.help_centre_list($1)",
      "select public.help_centre_article($1, 'x')",
      "select public.help_centre_vote($1, 'x', true)",
      "select public.help_centre_allow($1, 'search', 'k', 5, 60)",
      "select public.register_help_article_picture($1, $1, $1, 'p', 'image/png', 1)",
      "select * from public.claim_help_picture_removals(5)",
    ]) {
      await fails(q(alice, call, call.includes("$1") ? [tenantA] : []), /permission denied/);
      await fails(
        asAnon(db, (tx) => tx.query(call, call.includes("$1") ? [tenantA] : [])),
        /permission denied/,
      );
    }
    await fails(
      asAnon(db, (tx) =>
        tx.query("select public.set_help_article_state($1, $1, 'published')", [tenantA]),
      ),
      /permission denied/,
    );
  });

  it("members of one workspace can't see or change another's articles, addresses or pictures", async () => {
    const id = await article(bob, tenantB, "Bob's own");
    await setState(bob, tenantB, id, "published");
    expect(
      await q(alice, "select 1 from public.manual_articles where tenant_id = $1", [tenantB]),
    ).toEqual([]);
    expect(
      await q(alice, "select 1 from public.help_article_slugs where tenant_id = $1", [tenantB]),
    ).toEqual([]);
    await fails(setState(alice, tenantB, id, "internal"), /Only owners and admins/);
    await fails(setState(alice, tenantA, id, "internal"), /not_found/);
    await fails(
      q(alice, "select public.save_help_article_details($1, $2, 'mine', null, '')", [tenantB, id]),
      /Workspace not found/,
    );
    await fails(
      q(alice, "select public.save_help_article_details($1, $2, 'mine', null, '')", [tenantA, id]),
      /not_found/,
    );
    await fails(
      q(alice, "select public.start_help_article($1, 'x', '', '[]')", [tenantB]),
      /Only owners and admins/,
    );
  });
});

describe("the public state of an article", () => {
  it("starts internal; only a manager makes it public, publishes or takes it back", async () => {
    const id = await article(amy, tenantA, "How do I clean it?");
    const row = async () =>
      (
        await q<{ public_state: string; slug: string | null; published_at: string | null }>(
          alice,
          "select public_state, slug, published_at from public.manual_articles where id = $1",
          [id],
        )
      )[0];
    expect(await row()).toEqual({ public_state: "internal", slug: null, published_at: null });
    await fails(setState(amy, tenantA, id, "draft"), /Only owners and admins/);
    await fails(setState(amy, tenantA, id, "published"), /Only owners and admins/);
    await fails(setState(alice, tenantA, id, "live"), /bad_state/);

    expect((await setState(alice, tenantA, id, "draft"))[0].slug).toBe("how-do-i-clean-it");
    expect(await listed(tenantA)).not.toContain("how-do-i-clean-it");
    expect(await read(tenantA, "how-do-i-clean-it")).toBeNull();

    await setState(alice, tenantA, id, "published");
    expect((await row()).published_at).not.toBeNull();
    expect(await listed(tenantA)).toContain("how-do-i-clean-it");
    expect(await read(tenantA, "how-do-i-clean-it")).toMatchObject({
      id,
      title: "How do I clean it?",
    });

    await setState(alice, tenantA, id, "draft");
    expect(await read(tenantA, "how-do-i-clean-it")).toBeNull();
    await setState(alice, tenantA, id, "internal");
    expect(await listed(tenantA)).not.toContain("how-do-i-clean-it");
  });

  it("anyone edits an article until it is published; then only a manager does", async () => {
    const id = await article(amy, tenantA, "Returns");
    await q(amy, "select public.save_manual_article($1, $2, 'Returns', $3, '{}', false)", [
      tenantA,
      id,
      body("Thirty days."),
    ]);
    await setState(alice, tenantA, id, "draft");
    await q(
      amy,
      "select public.save_help_article_details($1, $2, null, 'orders', 'How returns work')",
      [tenantA, id],
    );
    await setState(alice, tenantA, id, "published");
    await fails(
      q(amy, "select public.save_manual_article($1, $2, 'Returns', $3, '{}', false)", [
        tenantA,
        id,
        body("Whenever."),
      ]),
      /Only owners and admins can change a published article/,
    );
    await fails(
      q(amy, "select public.save_help_article_details($1, $2, null, null, 'x')", [tenantA, id]),
      /Only owners and admins can change a published article/,
    );
    const before = (
      await q<{ at: string }>(
        alice,
        "select public_updated_at as at from public.manual_articles where id = $1",
        [id],
      )
    )[0].at;
    await db.query("update public.manual_articles set public_updated_at = $2 where id = $1", [
      id,
      "2020-01-01T00:00:00Z",
    ]);
    // The same words again don't move "last updated"; new words do.
    await q(alice, "select public.save_manual_article($1, $2, 'Returns', $3, '{}', false)", [
      tenantA,
      id,
      body("Thirty days."),
    ]);
    const same = await q<{ at: string }>(
      alice,
      "select public_updated_at as at from public.manual_articles where id = $1",
      [id],
    );
    expect(new Date(same[0].at).getUTCFullYear()).toBe(2020);
    await q(alice, "select public.save_manual_article($1, $2, 'Returns', $3, '{}', false)", [
      tenantA,
      id,
      body("Sixty days."),
    ]);
    const after = await q<{ at: string }>(
      alice,
      "select public_updated_at as at from public.manual_articles where id = $1",
      [id],
    );
    expect(new Date(after[0].at).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    expect(await read(tenantA, "returns")).toMatchObject({
      summary: "How returns work",
      category: "orders",
    });
  });

  it("a help article started from handed-over words is a draft, and a manager's to start", async () => {
    await fails(
      q(amy, "select public.start_help_article($1, 'From a topic', '', $2)", [tenantA, body("x")]),
      /Only owners and admins/,
    );
    const [{ id }] = await q<{ id: string }>(
      alice,
      "select public.start_help_article($1, ' From a topic ', 'In short', $2) as id",
      [tenantA, body("Copied words.")],
    );
    const [row] = await q<{ public_state: string; slug: string; summary: string; title: string }>(
      alice,
      "select public_state, slug, summary, title from public.manual_articles where id = $1",
      [id],
    );
    expect(row).toEqual({
      public_state: "draft",
      slug: "from-a-topic",
      summary: "In short",
      title: "From a topic",
    });
    expect(await read(tenantA, "from-a-topic")).toBeNull();
  });
});

describe("addresses", () => {
  it("are one of a kind in a workspace, and free to repeat in another", async () => {
    const first = await article(alice, tenantA, "Shipping times");
    const second = await article(alice, tenantA, "Shipping times");
    expect((await setState(alice, tenantA, first, "published"))[0].slug).toBe("shipping-times");
    expect((await setState(alice, tenantA, second, "published"))[0].slug).toBe("shipping-times-2");
    await fails(
      q(alice, "select public.save_help_article_details($1, $2, 'shipping-times', null, '')", [
        tenantA,
        second,
      ]),
      /slug_taken/,
    );
    await fails(
      q(alice, "select public.save_help_article_details($1, $2, 'Not OK!', null, '')", [
        tenantA,
        second,
      ]),
      /bad_slug/,
    );
    const other = await article(bob, tenantB, "Shipping times");
    expect((await setState(bob, tenantB, other, "published"))[0].slug).toBe("shipping-times");
    expect((await read(tenantB, "shipping-times"))?.id).toBe(other);
    expect((await read(tenantA, "shipping-times"))?.id).toBe(first);
  });

  it("an old address still finds the article and says where it lives now", async () => {
    const id = await article(alice, tenantA, "Care guide");
    await setState(alice, tenantA, id, "published");
    await q(
      alice,
      "select public.save_help_article_details($1, $2, 'looking-after-it', null, '')",
      [tenantA, id],
    );
    expect(await read(tenantA, "looking-after-it")).toMatchObject({ id, slug: "looking-after-it" });
    expect(await read(tenantA, "care-guide")).toMatchObject({ id, slug: "looking-after-it" });
    const [{ slug: workspace }] = (
      await db.query<{ slug: string }>("select slug from public.tenants where id = $1", [tenantA])
    ).rows;
    expect(
      (
        await service<{ w: { slug: string } }>(
          "select public.help_centre_where($1, 'care-guide') as w",
          [workspace],
        )
      )[0].w.slug,
    ).toBe("looking-after-it");
    expect(await listed(tenantA)).toContain("looking-after-it");
    expect(await listed(tenantA)).not.toContain("care-guide");
    // Nobody else can take the old one while this article is here.
    const squatter = await article(alice, tenantA, "Care guide");
    expect((await setState(alice, tenantA, squatter, "draft"))[0].slug).toBe("care-guide-2");
    // It can go back to its old address.
    await q(alice, "select public.save_help_article_details($1, $2, 'care-guide', null, '')", [
      tenantA,
      id,
    ]);
    expect(await read(tenantA, "looking-after-it")).toMatchObject({ slug: "care-guide" });
    // Once the article is gone, so are its addresses.
    await q(alice, "select public.delete_manual_article($1, $2)", [tenantA, id]);
    expect(await read(tenantA, "care-guide")).toBeNull();
    expect(await read(tenantA, "looking-after-it")).toBeNull();
  });

  it("a title with no plain letters still gets an address", async () => {
    const id = await article(alice, tenantA, "修理");
    expect((await setState(alice, tenantA, id, "draft"))[0].slug).toBe("article");
  });
});

describe("what a visitor's request can reach", () => {
  it("only published articles of the named workspace: no draft, internal article, topic or neighbour", async () => {
    const pub = await article(alice, tenantA, "Public one");
    await setState(alice, tenantA, pub, "published");
    const draft = await article(alice, tenantA, "Draft one");
    await setState(alice, tenantA, draft, "draft");
    const internal = await article(alice, tenantA, "Internal one");
    // An internal article that once had an address keeps it, and still can't be read.
    await setState(alice, tenantA, internal, "draft");
    await setState(alice, tenantA, internal, "internal");
    const [{ id: topic }] = await q<{ id: string }>(
      alice,
      "select public.save_manual_topic($1, null, 'Topic one', '', $2, '[]') as id",
      [tenantA, body("For the team.")],
    );
    await q(alice, "select public.set_manual_topic_state($1, $2, 'published', null)", [
      tenantA,
      topic,
    ]);
    const theirs = await article(bob, tenantB, "Neighbour one");
    await setState(bob, tenantB, theirs, "published");

    expect(await read(tenantA, "public-one")).toMatchObject({ id: pub });
    for (const guess of ["draft-one", "internal-one", "topic-one", "neighbour-one", topic, draft]) {
      expect(await read(tenantA, guess), guess).toBeNull();
    }
    expect(await read(tenantB, "public-one")).toBeNull();
    const all = await listed(tenantA);
    expect(all).toContain("public-one");
    for (const slug of ["draft-one", "internal-one", "topic-one", "neighbour-one"]) {
      expect(all, slug).not.toContain(slug);
    }
    // The answer is the article and nothing else about the workspace.
    expect(Object.keys((await read(tenantA, "public-one"))!).sort()).toEqual([
      "body",
      "category",
      "id",
      "pictures",
      "published_at",
      "slug",
      "summary",
      "title",
      "updated_at",
    ]);
  });

  it("the quick check before a page is drawn says the same", async () => {
    const where = async (workspace: string, article: string | null) =>
      (
        await service<{ w: { tenant_id: string; slug: string | null } | null }>(
          "select public.help_centre_where($1, $2) as w",
          [workspace, article],
        )
      )[0].w;
    const [{ slug: a }] = await db
      .query<{ slug: string }>("select slug from public.tenants where id = $1", [tenantA])
      .then((r) => r.rows);
    const [{ slug: b }] = await db
      .query<{ slug: string }>("select slug from public.tenants where id = $1", [tenantB])
      .then((r) => r.rows);
    expect(await where(a, null)).toEqual({ tenant_id: tenantA, slug: null });
    expect(await where(a, "public-one")).toEqual({ tenant_id: tenantA, slug: "public-one" });
    for (const guess of ["draft-one", "internal-one", "topic-one", "neighbour-one", "nope"]) {
      expect(await where(a, guess), guess).toBeNull();
    }
    expect(await where(b, "public-one")).toBeNull();
    expect(await where("no-such-workspace", null)).toBeNull();
    await fails(q(alice, "select public.help_centre_where($1, null)", [a]), /permission denied/);
    await fails(
      asAnon(db, (tx) => tx.query("select public.help_centre_where($1, null)", [a])),
      /permission denied/,
    );
    await switchOn(alice, tenantA, false);
    expect(await where(a, null)).toBeNull();
    expect(await where(a, "public-one")).toBeNull();
    await switchOn(alice, tenantA, true);
  });

  it("nothing at all while the help centre is switched off", async () => {
    await switchOn(alice, tenantA, false);
    expect(await listed(tenantA)).toEqual([]);
    expect(await read(tenantA, "public-one")).toBeNull();
    expect(
      (
        await service<{ ok: boolean }>(
          "select public.help_centre_vote($1, 'public-one', true) as ok",
          [tenantA],
        )
      )[0].ok,
    ).toBe(false);
    // The neighbour's is untouched.
    expect(await listed(tenantB)).toContain("neighbour-one");
    await switchOn(alice, tenantA, true);
    expect(await read(tenantA, "public-one")).not.toBeNull();
  });
});

describe("was this helpful, and how often", () => {
  it("counts yes and no on a published article only", async () => {
    const vote = async (tenant: string, slug: string, helpful: boolean) =>
      (
        await service<{ ok: boolean }>("select public.help_centre_vote($1, $2, $3) as ok", [
          tenant,
          slug,
          helpful,
        ])
      )[0].ok;
    expect(await vote(tenantA, "public-one", true)).toBe(true);
    expect(await vote(tenantA, "public-one", true)).toBe(true);
    expect(await vote(tenantA, "public-one", false)).toBe(true);
    expect(await vote(tenantA, "draft-one", true)).toBe(false);
    expect(await vote(tenantB, "public-one", true)).toBe(false);
    const [row] = await q<{ helpful_yes: number; helpful_no: number }>(
      alice,
      "select helpful_yes, helpful_no from public.manual_articles where slug = 'public-one' and tenant_id = $1",
      [tenantA],
    );
    expect(row).toEqual({ helpful_yes: 2, helpful_no: 1 });
  });

  it("lets a visitor through up to the limit, per workspace and kind, and again in a new window", async () => {
    const allow = async (tenant: string, kind: string, key: string, limit: number) =>
      (
        await service<{ ok: boolean }>(
          "select public.help_centre_allow($1, $2, $3, $4, 60) as ok",
          [tenant, kind, key, limit],
        )
      )[0].ok;
    expect(await allow(tenantA, "search", "k1", 2)).toBe(true);
    expect(await allow(tenantA, "search", "k1", 2)).toBe(true);
    expect(await allow(tenantA, "search", "k1", 2)).toBe(false);
    expect(await allow(tenantA, "search", "k2", 2)).toBe(true);
    expect(await allow(tenantA, "vote", "k1", 2)).toBe(true);
    expect(await allow(tenantB, "search", "k1", 2)).toBe(true);
    expect(await allow(tenantA, "search", "", 2)).toBe(false);
    await db.query(
      "update private.help_centre_hits set window_start = now() - interval '2 minutes' where key = 'k1' and kind = 'search' and tenant_id = $1",
      [tenantA],
    );
    expect(await allow(tenantA, "search", "k1", 2)).toBe(true);
  });
});

describe("an article's own pictures", () => {
  const register = (tenant: string, articleId: string, user: User, path: string) =>
    service<{ id: string }>(
      "select public.register_help_article_picture($1, $2, $3, $4, 'image/png', 1200) as id",
      [tenant, articleId, user.id, path],
    );

  it("the bucket is public, pictures only, and apart from the private help desk bucket", async () => {
    const { rows } = await db.query<{ public: boolean; allowed_mime_types: string[] }>(
      "select public, allowed_mime_types from storage.buckets where id = 'help-centre'",
    );
    expect(rows[0].public).toBe(true);
    expect(rows[0].allowed_mime_types.every((type) => type.startsWith("image/"))).toBe(true);
    const { rows: desk } = await db.query<{ public: boolean }>(
      "select public from storage.buckets where id = 'helpdesk'",
    );
    expect(desk[0].public).toBe(false);
  });

  it("are filed by the server under the workspace and article, shown with the article, and removed with it", async () => {
    const id = await article(alice, tenantA, "With pictures");
    await setState(alice, tenantA, id, "draft");
    const [{ id: picture }] = await register(tenantA, id, amy, `${tenantA}/${id}/one.png`);
    await fails(register(tenantA, id, amy, `${tenantB}/${id}/two.png`), /check/);
    await fails(register(tenantA, id, amy, `${tenantA}/elsewhere/two.png`), /check/);
    await fails(register(tenantA, id, bob, `${tenantA}/${id}/three.png`), /Workspace not found/);
    await fails(register(tenantB, id, bob, `${tenantB}/${id}/three.png`), /not_found/);

    await q(
      amy,
      "select public.save_help_article_picture($1, $2, 'A brush', 'Use a soft one', 'Steps', 2)",
      [tenantA, picture],
    );
    await fails(
      q(bob, "select public.save_help_article_picture($1, $2, 'x', '', '', 1)", [tenantB, picture]),
      /not_found/,
    );
    await setState(alice, tenantA, id, "published");
    expect((await read(tenantA, "with-pictures"))?.pictures).toEqual([
      {
        path: `${tenantA}/${id}/one.png`,
        alt: "A brush",
        caption: "Use a soft one",
        section: "Steps",
      },
    ]);
    // Published: a member can no longer add, change or remove its pictures.
    await fails(register(tenantA, id, amy, `${tenantA}/${id}/four.png`), /Only owners and admins/);
    await fails(
      q(amy, "select public.remove_help_article_picture($1, $2)", [tenantA, picture]),
      /Only owners and admins/,
    );
    await q(alice, "select public.remove_help_article_picture($1, $2)", [tenantA, picture]);
    expect((await read(tenantA, "with-pictures"))?.pictures).toEqual([]);
    const claimed = await service<{ p: string }>(
      "select public.claim_help_picture_removals(10) as p",
    );
    expect(claimed.map((row) => row.p)).toContain(`${tenantA}/${id}/one.png`);

    // Deleting the article queues what was left.
    await register(tenantA, id, alice, `${tenantA}/${id}/five.png`);
    await q(alice, "select public.delete_manual_article($1, $2)", [tenantA, id]);
    const { rows } = await db.query<{ storage_path: string }>(
      "select storage_path from private.help_picture_removals",
    );
    expect(rows.map((row) => row.storage_path)).toContain(`${tenantA}/${id}/five.png`);
    await service("select public.finish_help_picture_removals($1)", [
      [`${tenantA}/${id}/one.png`, `${tenantA}/${id}/five.png`],
    ]);
    const { rows: left } = await db.query("select 1 from private.help_picture_removals");
    expect(left).toEqual([]);
  });

  it("stops at twelve on one article", async () => {
    const id = await article(alice, tenantA, "Many pictures");
    for (let i = 0; i < 12; i += 1) {
      await register(tenantA, id, alice, `${tenantA}/${id}/${i}.png`);
    }
    await fails(register(tenantA, id, alice, `${tenantA}/${id}/12.png`), /too_many_pictures/);
  });
});
