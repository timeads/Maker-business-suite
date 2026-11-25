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
let n = 0;

// Made-up ids: a Page, the Instagram account linked to it, posts and people.
const PAGE_A = "page-a-5001";
const IG_A = "ig-a-6002";
const PAGE_B = "page-b-7003";
const BASE = ["pages_show_list", "pages_manage_metadata", "pages_read_engagement"];
const FB_COMMENTS = [...BASE, "pages_read_user_content", "pages_manage_engagement"];
const IG_COMMENTS = [...BASE, "instagram_basic", "instagram_manage_comments"];
const MESSAGING = [...BASE, "pages_messaging", "instagram_basic", "instagram_manage_messages"];

const q = <T>(who: User, sql: string, params: unknown[] = []) =>
  asUser(db, who, async (tx) => (await tx.query<T>(sql, params)).rows);
const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);

type Filed = {
  result: string;
  ticket_id: string;
  message_id: string;
  contact_id: string;
  number: number;
  post_id: string;
  needs_post: boolean;
  kept_in: string | null;
};

async function comment(
  tenant: string,
  channel: string,
  person: string,
  post: string,
  body: string,
  extra: {
    id?: string;
    parent?: string | null;
    start?: boolean;
    name?: string | null;
    handle?: string | null;
    tags?: string[];
    at?: string;
  } = {},
) {
  n += 1;
  const rows = await service<{ r: Filed }>(
    `select public.file_social_comment($1, $2, $3, $4, $5, $6, $7, $8, $9, null, $10,
                                       coalesce($11::timestamptz, now()), $12, $13) as r`,
    [
      tenant,
      channel,
      person,
      extra.name ?? null,
      extra.handle ?? null,
      extra.id ?? `comment-${n}`,
      extra.parent ?? null,
      post,
      body,
      `${channel === "instagram" ? "Instagram" : "Facebook"} comment: test`,
      extra.at ?? null,
      extra.start ?? true,
      extra.tags ?? [],
    ],
  );
  return rows[0].r;
}

const connect = (tenant: string, page: string, scopes: string[], ig: string | null, by: User) =>
  service("select public.save_connection($1, 'meta', $2, 'A Page', $3, $4::jsonb, $5, $6::jsonb)", [
    tenant,
    page,
    scopes,
    JSON.stringify({ access_token: "made-up-for-a-test" }),
    by.id,
    JSON.stringify({ instagram_id: ig, instagram_username: ig ? "a_made_up_shop" : null }),
  ]);

const switchOn = (who: User, tenant: string, body: Record<string, unknown>) =>
  q(who, "select public.save_config($1, 'helpdesk', 'channels', $2::jsonb)", [
    tenant,
    JSON.stringify({ version: 1, ...body }),
  ]);

const delivery = (object: string, account: string) => ({
  object,
  entry: [{ id: account, time: 1, changes: [] }],
});
const enqueue = async (id: string, body: unknown) =>
  (
    await service<{ r: string }>("select public.enqueue_meta_event($1, $2::jsonb) as r", [
      id,
      JSON.stringify(body),
    ])
  )[0].r;
const resolve = (object: string, account: string) =>
  service<{ tenant_id: string; channel: string; page_id: string; own_handle: string | null }>(
    "select * from public.resolve_meta_comments($1, $2)",
    [object, account],
  );

type Message = {
  id: string;
  direction: string;
  kind: string;
  body: string;
  from_name: string | null;
  author_id: string | null;
  hidden: boolean;
  edited_at: string | null;
  removed_at: string | null;
  private_reply: string | null;
  parent_external_id: string | null;
  provider_message_id: string;
};
const thread = (who: User, ticket: string) =>
  q<Message>(
    who,
    `select id, direction, kind, body, from_name, author_id, hidden, edited_at, removed_at,
            private_reply, parent_external_id, provider_message_id
     from public.messages where ticket_id = $1 order by created_at, id`,
    [ticket],
  );

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
  tenantA = await tenantFor(alice, "Comments A");
  tenantB = await tenantFor(bob, "Comments B");
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, amy.id],
  );
});

describe("whose a comment is", () => {
  it("is nobody's until the permissions are granted and comments are switched on", async () => {
    expect(await resolve("page", PAGE_A)).toEqual([]);
    // Connected for messages only, with messages on: comments still aren't taken.
    await connect(tenantA, PAGE_A, MESSAGING, IG_A, alice);
    await switchOn(alice, tenantA, { instagram: false, facebook: false });
    expect(await resolve("page", PAGE_A)).toEqual([]);
    expect(await enqueue("1".repeat(64), delivery("page", PAGE_A))).toBe("dropped");

    // Granted, but not switched on.
    await connect(tenantA, PAGE_A, [...FB_COMMENTS, ...IG_COMMENTS], IG_A, alice);
    expect(await resolve("page", PAGE_A)).toEqual([]);
    expect(await resolve("instagram", IG_A)).toEqual([]);
  });

  it("is the workspace's once both are true, one platform at a time", async () => {
    await switchOn(alice, tenantA, { facebook_comments: true });
    expect(await resolve("page", PAGE_A)).toEqual([
      expect.objectContaining({ tenant_id: tenantA, channel: "facebook", page_id: PAGE_A }),
    ]);
    expect(await resolve("instagram", IG_A)).toEqual([]);
    expect(await enqueue("2".repeat(64), delivery("page", PAGE_A))).toBe("queued");
    expect(await enqueue("2".repeat(64), delivery("page", PAGE_A))).toBe("duplicate");
    expect(await enqueue("3".repeat(64), delivery("instagram", IG_A))).toBe("dropped");

    await switchOn(alice, tenantA, { facebook_comments: true, instagram_comments: true });
    expect(await resolve("instagram", IG_A)).toEqual([
      expect.objectContaining({
        tenant_id: tenantA,
        channel: "instagram",
        page_id: PAGE_A,
        own_handle: "a_made_up_shop",
      }),
    ]);
    // Someone else's Page is nobody's here.
    expect(await resolve("page", PAGE_B)).toEqual([]);
  });

  it("needs the comment permission itself, not just the Page's", async () => {
    await connect(tenantB, PAGE_B, [...BASE, "pages_manage_engagement"], null, bob);
    await switchOn(bob, tenantB, { facebook_comments: true });
    expect(await resolve("page", PAGE_B)).toEqual([]);
    await connect(tenantB, PAGE_B, FB_COMMENTS, null, bob);
    expect(await resolve("page", PAGE_B)).toHaveLength(1);
  });
});

describe("filing comments", () => {
  let first: Filed;

  it("starts one conversation per person per post, with who wrote it", async () => {
    first = await comment(tenantA, "instagram", "person-1", "post-1", "Do you ship to Canada?", {
      id: "c-1",
      handle: "a_made_up_person",
    });
    expect(first.result).toBe("created");
    expect(first.needs_post).toBe(true);
    const [ticket] = await q<{ kind: string; channel: string; comment_post_id: string }>(
      amy,
      "select kind, channel, comment_post_id from public.tickets where id = $1",
      [first.ticket_id],
    );
    expect(ticket).toEqual({
      kind: "comment",
      channel: "instagram",
      comment_post_id: first.post_id,
    });
    const [contact] = await q<{ handle: string; profile_checked_at: string | null }>(
      amy,
      "select handle, profile_checked_at from public.contacts where id = $1",
      [first.contact_id],
    );
    expect(contact.handle).toBe("a_made_up_person");
    expect(contact.profile_checked_at).not.toBeNull();
  });

  it("files the same comment once, however often Meta sends it", async () => {
    const again = await comment(tenantA, "instagram", "person-1", "post-1", "Do you ship?", {
      id: "c-1",
    });
    expect(again.result).toBe("duplicate");
    expect(again.ticket_id).toBe(first.ticket_id);
    expect(await thread(amy, first.ticket_id)).toHaveLength(1);
  });

  it("threads the person's later comments and replies on that post; another post or person starts anew", async () => {
    const reply = await comment(tenantA, "instagram", "person-1", "post-1", "And how long?", {
      id: "c-2",
      parent: "c-1",
    });
    expect(reply).toMatchObject({ result: "threaded", ticket_id: first.ticket_id });
    const messages = await thread(amy, first.ticket_id);
    expect(messages.map((m) => [m.kind, m.direction, m.parent_external_id])).toEqual([
      ["comment", "inbound", null],
      ["comment", "inbound", "c-1"],
    ]);

    const otherPost = await comment(tenantA, "instagram", "person-1", "post-2", "Lovely colours?");
    expect(otherPost.result).toBe("created");
    expect(otherPost.ticket_id).not.toBe(first.ticket_id);
    const otherPerson = await comment(tenantA, "instagram", "person-2", "post-1", "Same question?");
    expect(otherPerson.result).toBe("created");
    expect(otherPerson.post_id).toBe(first.post_id);
    // The same ids on another platform are different people and posts.
    const facebook = await comment(tenantA, "facebook", "person-1", "post-1", "Is it open?", {
      name: "A Made Up Person",
    });
    expect(facebook.result).toBe("created");
    expect(facebook.post_id).not.toBe(first.post_id);
  });

  it("starts nothing for a comment that isn't worth a conversation, but keeps it on one already going", async () => {
    const noise = await comment(tenantA, "instagram", "person-9", "post-1", "🔥🔥", {
      start: false,
    });
    expect(noise).toEqual({ result: "filtered" });
    const none = await q<{ n: number }>(
      alice,
      "select count(*)::int as n from public.contacts where tenant_id = $1 and external_id = 'person-9'",
      [tenantA],
    );
    expect(none[0].n).toBe(0);

    const kept = await comment(tenantA, "instagram", "person-1", "post-1", "😍", { start: false });
    expect(kept).toMatchObject({ result: "threaded", ticket_id: first.ticket_id });
  });

  it("reopens a closed conversation, and leaves one in the Trash where it is", async () => {
    await q(alice, "select public.set_ticket_status($1, 'closed')", [first.ticket_id]);
    await comment(tenantA, "instagram", "person-1", "post-1", "Hello again?");
    const [open] = await q<{ status: string }>(
      amy,
      "select status from public.tickets where id = $1",
      [first.ticket_id],
    );
    expect(open.status).toBe("open");

    const junk = await comment(tenantA, "instagram", "person-3", "post-1", "Buy followers?");
    await q(alice, "select public.shelve_ticket($1, 'trash')", [junk.ticket_id]);
    const more = await comment(tenantA, "instagram", "person-3", "post-1", "Buy more?");
    expect(more).toMatchObject({ result: "threaded", kept_in: "trash" });
  });

  it("applies the tags the workspace's rules chose", async () => {
    const tagged = await comment(tenantA, "facebook", "person-4", "post-5", "Where is my order?", {
      tags: ["orders"],
    });
    const tags = await q<{ name: string }>(
      amy,
      `select g.name from public.ticket_tags tt join public.tags g on g.id = tt.tag_id
       where tt.ticket_id = $1`,
      [tagged.ticket_id],
    );
    expect(tags.map((t) => t.name)).toEqual(["orders"]);
  });

  it("keeps what Meta said about the post once: its address on the platform and a short excerpt", async () => {
    await service("select public.set_comment_post($1, $2, $3, $4)", [
      tenantA,
      first.post_id,
      "https://www.instagram.com/p/MADEUP123/",
      `  New   colours\nthis week  ${"x".repeat(400)}`,
    ]);
    const [post] = await q<{ permalink: string; excerpt: string; checked_at: string | null }>(
      amy,
      "select permalink, excerpt, checked_at from public.comment_posts where id = $1",
      [first.post_id],
    );
    expect(post.permalink).toBe("https://www.instagram.com/p/MADEUP123/");
    expect(post.excerpt.startsWith("New colours this week x")).toBe(true);
    expect(post.excerpt.length).toBe(280);
    expect(post.checked_at).not.toBeNull();
    // Asked once: a second answer changes nothing.
    await service("select public.set_comment_post($1, $2, $3, 'Something else')", [
      tenantA,
      first.post_id,
      "https://www.instagram.com/p/OTHER/",
    ]);
    const [same] = await q<{ permalink: string }>(
      amy,
      "select permalink from public.comment_posts where id = $1",
      [first.post_id],
    );
    expect(same.permalink).toBe("https://www.instagram.com/p/MADEUP123/");
    const later = await comment(tenantA, "instagram", "person-1", "post-1", "One more?");
    expect(later.needs_post).toBe(false);
  });

  it("never keeps an address that isn't on the platform itself", async () => {
    const elsewhere = await comment(tenantA, "facebook", "person-5", "post-6", "Is this real?");
    await service("select public.set_comment_post($1, $2, $3, 'Words')", [
      tenantA,
      elsewhere.post_id,
      "https://evil.example.com/facebook.com/",
    ]);
    const [post] = await q<{ permalink: string | null; excerpt: string }>(
      amy,
      "select permalink, excerpt from public.comment_posts where id = $1",
      [elsewhere.post_id],
    );
    expect(post).toEqual({ permalink: null, excerpt: "Words" });
    await expect(
      db.query(
        "insert into public.comment_posts (tenant_id, channel, external_id, permalink) values ($1, 'facebook', 'x', 'javascript:alert(1)')",
        [tenantA],
      ),
    ).rejects.toThrow();
  });
});

describe("edits, removals and hiding", () => {
  it("an edit replaces the words and marks the comment; a removal clears them", async () => {
    const one = await comment(tenantA, "facebook", "person-6", "post-7", "Is it wool?", {
      id: "c-edit",
    });
    const edited = await service<{ r: boolean }>(
      "select public.edit_social_comment($1, 'c-edit', 'Is it merino wool?', now()) as r",
      [tenantA],
    );
    expect(edited[0].r).toBe(true);
    // The same words again are not an edit.
    const unchanged = await service<{ r: boolean }>(
      "select public.edit_social_comment($1, 'c-edit', 'Is it merino wool?', now()) as r",
      [tenantA],
    );
    expect(unchanged[0].r).toBe(false);
    let [message] = await thread(amy, one.ticket_id);
    expect(message.body).toBe("Is it merino wool?");
    expect(message.edited_at).not.toBeNull();

    await service("select public.set_comment_hidden($1, 'c-edit', true)", [tenantA]);
    [message] = await thread(amy, one.ticket_id);
    expect(message.hidden).toBe(true);
    await service("select public.set_comment_hidden($1, 'c-edit', false)", [tenantA]);

    const removed = await service<{ r: boolean }>(
      "select public.remove_social_comment($1, 'c-edit') as r",
      [tenantA],
    );
    expect(removed[0].r).toBe(true);
    [message] = await thread(amy, one.ticket_id);
    expect(message.body).toBe("");
    expect(message.removed_at).not.toBeNull();
    const facts = await q<{ preview: string }>(
      amy,
      "select preview from public.ticket_list_facts($1::uuid[])",
      [[one.ticket_id]],
    );
    expect(facts[0].preview).toBe("Comment removed");
    // Another workspace naming the same comment id changes nothing here.
    const elsewhere = await service<{ r: boolean }>(
      "select public.edit_social_comment($1, 'c-edit', 'hijack', now()) as r",
      [tenantB],
    );
    expect(elsewhere[0].r).toBe(false);
  });

  it("the team may note a comment hidden; only owners and admins may note it deleted", async () => {
    const one = await comment(tenantA, "instagram", "person-7", "post-8", "Rude words?", {
      id: "c-hide",
    });
    await q(amy, "select public.mark_comment_hidden($1, true)", [one.message_id]);
    let [message] = await thread(amy, one.ticket_id);
    expect(message.hidden).toBe(true);
    await q(amy, "select public.mark_comment_hidden($1, false)", [one.message_id]);

    await expect(
      q(amy, "select public.mark_comment_deleted($1)", [one.message_id]),
    ).rejects.toThrow(/Only owners and admins/);
    await q(alice, "select public.mark_comment_deleted($1)", [one.message_id]);
    [message] = await thread(amy, one.ticket_id);
    expect(message).toMatchObject({ body: "" });
    expect(message.removed_at).not.toBeNull();
    const log = await q<{ metadata: Record<string, unknown> }>(
      alice,
      "select metadata from public.audit_log where tenant_id = $1 and action = 'helpdesk.comment_deleted'",
      [tenantA],
    );
    // That it happened; never whose comment or what it said.
    expect(log).toEqual([{ metadata: {} }]);
  });
});

describe("answering a comment", () => {
  let filed: Filed;
  const context = (tenant: string, ticket: string) =>
    service<{
      channel: string;
      external_id: string;
      label: string;
      comment_id: string | null;
      comment_hidden: boolean | null;
      private_reply: string | null;
    }>("select * from public.comment_reply_context($1, $2)", [tenant, ticket]);

  it("answers under the person's latest comment that still stands", async () => {
    filed = await comment(tenantA, "instagram", "person-10", "post-10", "Is the kit in stock?", {
      id: "c-10",
      handle: "another_made_up",
    });
    await comment(tenantA, "instagram", "person-10", "post-10", "The blue one?", { id: "c-11" });
    let [ctx] = await context(tenantA, filed.ticket_id);
    expect(ctx).toMatchObject({
      channel: "instagram",
      external_id: "person-10",
      label: "@another_made_up",
      comment_id: "c-11",
      private_reply: null,
    });
    await service("select public.remove_social_comment($1, 'c-11')", [tenantA]);
    [ctx] = await context(tenantA, filed.ticket_id);
    expect(ctx.comment_id).toBe("c-10");
    // Another workspace can't read this conversation's context by naming it.
    expect(await context(tenantB, filed.ticket_id)).toEqual([]);
  });

  it("records a public reply as its author, once", async () => {
    const id = await q<{ id: string }>(
      amy,
      "select public.record_comment_outbound($1, 'Yes, plenty!', 'reply-1', 'public', 'c-10') as id",
      [filed.ticket_id],
    );
    expect(id[0].id).toBeTruthy();
    const again = await q<{ id: string | null }>(
      amy,
      "select public.record_comment_outbound($1, 'Yes, plenty!', 'reply-1', 'public', 'c-10') as id",
      [filed.ticket_id],
    );
    expect(again[0].id).toBeNull();
    const messages = await thread(amy, filed.ticket_id);
    const reply = messages.find((m) => m.provider_message_id === "reply-1")!;
    expect(reply).toMatchObject({
      direction: "outbound",
      kind: "comment",
      author_id: amy.id,
      parent_external_id: "c-10",
    });
    const [ticket] = await q<{ status: string; assignee_id: string }>(
      amy,
      "select status, assignee_id from public.tickets where id = $1",
      [filed.ticket_id],
    );
    expect(ticket).toEqual({ status: "pending", assignee_id: amy.id });
  });

  it("Meta's own word of a reply the help desk sent is not filed a second time", async () => {
    const echo = await service<{ r: { result: string } }>(
      "select public.file_own_comment($1, 'instagram', 'reply-1', 'c-10', 'Yes, plenty!', now()) as r",
      [tenantA],
    );
    expect(echo[0].r.result).toBe("duplicate");
  });

  it("a reply written in the app is filed as the team's, and adopted if the help desk records it after", async () => {
    const app = await service<{ r: { result: string; message_id: string } }>(
      "select public.file_own_comment($1, 'instagram', 'reply-app', 'c-10', 'Blue is back Friday', now()) as r",
      [tenantA],
    );
    expect(app[0].r.result).toBe("threaded");
    let messages = await thread(amy, filed.ticket_id);
    expect(messages.find((m) => m.provider_message_id === "reply-app")).toMatchObject({
      direction: "outbound",
      kind: "comment",
      from_name: "Instagram app",
      author_id: null,
    });
    // The webhook won the race against the help desk writing its own send down.
    await q(
      alice,
      "select public.record_comment_outbound($1, 'Blue is back Friday', 'reply-app', 'public', 'c-10')",
      [filed.ticket_id],
    );
    messages = await thread(amy, filed.ticket_id);
    const adopted = messages.filter((m) => m.provider_message_id === "reply-app");
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ author_id: alice.id, from_name: null });

    // The account's own comment that answers nobody we know starts nothing.
    const stray = await service<{ r: { result: string } }>(
      "select public.file_own_comment($1, 'instagram', 'own-top', 'unknown-parent', 'New drop!', now()) as r",
      [tenantA],
    );
    expect(stray[0].r.result).toBe("ignored");
  });

  it("waits while one of the help desk's own sends is still being written down", async () => {
    const queued = await q<{ id: string }>(
      amy,
      `select public.queue_outbound($1, $2::jsonb, '{}'::jsonb, 5) as id`,
      [
        filed.ticket_id,
        JSON.stringify({ kind: "social", via: "public", comment_id: "c-10", then: "pending" }),
      ],
    );
    await db.query(
      "update private.outbound_queue set state = 'sending', locked_at = now() where id = $1",
      [queued[0].id],
    );
    const early = await service<{ r: { result: string } }>(
      "select public.file_own_comment($1, 'instagram', 'reply-q', 'c-10', 'On its way', now()) as r",
      [tenantA],
    );
    expect(early[0].r.result).toBe("retry");

    const done = await service<{ id: string }>(
      "select public.finish_comment_outbound($1, 'reply-q', 'On its way') as id",
      [queued[0].id],
    );
    expect(done[0].id).toBeTruthy();
    const late = await service<{ r: { result: string } }>(
      "select public.file_own_comment($1, 'instagram', 'reply-q', 'c-10', 'On its way', now()) as r",
      [tenantA],
    );
    expect(late[0].r.result).toBe("duplicate");
    const messages = await thread(amy, filed.ticket_id);
    expect(messages.find((m) => m.provider_message_id === "reply-q")).toMatchObject({
      author_id: amy.id,
      kind: "comment",
    });
  });

  it("allows one private message per comment, and only within seven days", async () => {
    const claim = async (ticket: string, id: string) =>
      (
        await service<{ r: boolean }>("select public.claim_private_reply($1, $2, $3) as r", [
          tenantA,
          ticket,
          id,
        ])
      )[0].r;
    expect(await claim(filed.ticket_id, "c-10")).toBe(true);
    expect(await claim(filed.ticket_id, "c-10")).toBe(false);
    // Meta said no: the comment can have its private message after all.
    await service("select public.release_private_reply($1, 'c-10')", [tenantA]);
    expect(await claim(filed.ticket_id, "c-10")).toBe(true);
    await q(
      amy,
      "select public.record_comment_outbound($1, 'Sent you the details', 'm_private_1', 'private', 'c-10')",
      [filed.ticket_id],
    );
    const messages = await thread(amy, filed.ticket_id);
    expect(messages.find((m) => m.provider_message_id === "c-10")?.private_reply).toBe("sent");
    expect(messages.find((m) => m.provider_message_id === "m_private_1")).toMatchObject({
      kind: "private_reply",
      direction: "outbound",
      parent_external_id: "c-10",
    });
    // Sent stays sent: nothing releases it, and nobody can claim it again.
    await service("select public.release_private_reply($1, 'c-10')", [tenantA]);
    expect(await claim(filed.ticket_id, "c-10")).toBe(false);

    const old = await comment(tenantA, "instagram", "person-11", "post-10", "Still there?", {
      id: "c-old",
      at: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(),
    });
    expect(await claim(old.ticket_id, "c-old")).toBe(false);
    // A comment on another conversation can't be claimed through this one.
    const other = await comment(tenantA, "instagram", "person-12", "post-10", "Me too?", {
      id: "c-other",
    });
    expect(await claim(filed.ticket_id, "c-other")).toBe(false);
    expect(await claim(other.ticket_id, "c-other")).toBe(true);
  });

  it("a queued private message that fails keeps its words, and never frees a claim it doesn't hold", async () => {
    const one = await comment(tenantA, "facebook", "person-13", "post-11", "Can you DM me?", {
      id: "c-13",
    });
    const queued = await q<{ id: string }>(
      amy,
      `select public.queue_outbound($1, $2::jsonb, '{}'::jsonb, 5) as id`,
      [
        one.ticket_id,
        JSON.stringify({ kind: "social", via: "private", comment_id: "c-13", then: "pending" }),
      ],
    );
    await db.query("update private.outbound_queue set state = 'sending' where id = $1", [
      queued[0].id,
    ]);
    // Someone else's private message about the same comment is on its way.
    await service("select public.claim_private_reply($1, $2, 'c-13')", [tenantA, one.ticket_id]);
    await service("select public.finish_comment_outbound($1, null, null, 'private_used')", [
      queued[0].id,
    ]);
    const [message] = await thread(amy, one.ticket_id);
    expect(message.private_reply).toBe("claimed");
    const state = await db.query<{ state: string; error: string; kept: boolean }>(
      "select state, error, payload ? 'comment_id' as kept from private.outbound_queue where id = $1",
      [queued[0].id],
    );
    expect(state.rows[0]).toEqual({ state: "failed", error: "private_used", kept: true });
  });

  it("refuses a reply to a comment that isn't on the conversation, or with no words", async () => {
    await expect(
      q(amy, "select public.record_comment_outbound($1, 'Hi', 'r-x', 'public', 'c-other')", [
        filed.ticket_id,
      ]),
    ).rejects.toThrow(/isn't on this conversation/);
    await expect(
      q(amy, "select public.record_comment_outbound($1, '  ', 'r-y', 'public', 'c-10')", [
        filed.ticket_id,
      ]),
    ).rejects.toThrow(/needs some words/);
    await expect(
      q(amy, "select public.record_comment_outbound($1, 'Hi', 'r-z', 'shout', 'c-10')", [
        filed.ticket_id,
      ]),
    ).rejects.toThrow(/how it was sent/);
  });
});

describe("comments and messages stay apart", () => {
  it("a message from the same person lands on their message conversation, not the comment one", async () => {
    await connect(tenantA, PAGE_A, [...MESSAGING, ...FB_COMMENTS, ...IG_COMMENTS], IG_A, alice);
    const said = await comment(tenantA, "instagram", "person-20", "post-20", "Do you teach?", {
      id: "c-20",
    });
    const dm = await service<{ r: { result: string; ticket_id: string; contact_id: string } }>(
      `select public.file_social_message($1, 'instagram', 'person-20', 'mid-20', 'Thanks for the message!',
                                         'reply', null, 'Instagram message: test', now(), '{}') as r`,
      [tenantA],
    );
    expect(dm[0].r.result).toBe("created");
    expect(dm[0].r.ticket_id).not.toBe(said.ticket_id);
    // One person: the two conversations share their contact, which is how each links to the other.
    expect(dm[0].r.contact_id).toBe(said.contact_id);

    // A later comment goes to the comment conversation, a later message to the message one.
    const more = await comment(tenantA, "instagram", "person-20", "post-20", "On Saturdays?");
    expect(more.ticket_id).toBe(said.ticket_id);
    const dm2 = await service<{ r: { ticket_id: string } }>(
      `select public.file_social_message($1, 'instagram', 'person-20', 'mid-21', 'Great',
                                         'reply', null, 'x', now(), '{}') as r`,
      [tenantA],
    );
    expect(dm2[0].r.ticket_id).toBe(dm[0].r.ticket_id);

    // A message reply can't be recorded on a comment conversation, or the other way round.
    await expect(
      q(amy, "select public.record_social_outbound($1, 'Hi', array['mid-x'])", [said.ticket_id]),
    ).rejects.toThrow(/about a comment/);
    await expect(
      q(amy, "select public.record_comment_outbound($1, 'Hi', 'r-1', 'public', 'c-20')", [
        dm[0].r.ticket_id,
      ]),
    ).rejects.toThrow(/isn't about a comment/);
    const none = await service("select * from public.social_reply_context($1, $2)", [
      tenantA,
      said.ticket_id,
    ]);
    expect(none).toEqual([]);

    // And the two can't be joined.
    await expect(
      db.query("update public.tickets set merged_into = $1 where id = $2", [
        dm[0].r.ticket_id,
        said.ticket_id,
      ]),
    ).rejects.toThrow(/can't be joined/);
    await expect(
      db.query("update public.tickets set kind = 'message' where id = $1", [said.ticket_id]),
    ).rejects.toThrow(/keeps the kind/);
  });

  it("an email conversation is never a comment", async () => {
    await expect(
      db.query(
        `insert into public.tickets (tenant_id, number, subject, reply_key, kind)
         values ($1, 9999, 'x', 'made-up-key-0001', 'comment')`,
        [tenantA],
      ),
    ).rejects.toThrow();
  });
});

describe("workspaces are separate", () => {
  it("another workspace sees none of it, and can change none of it", async () => {
    const mine = await comment(tenantA, "facebook", "person-30", "post-30", "Private to A?", {
      id: "c-30",
    });
    for (const table of ["comment_posts", "tickets", "messages", "contacts"]) {
      const rows = await q<{ n: number }>(
        bob,
        `select count(*)::int as n from public.${table} where tenant_id = $1`,
        [tenantA],
      );
      expect(rows[0].n, table).toBe(0);
    }
    await expect(
      q(bob, "select public.record_comment_outbound($1, 'Hi', 'r-b', 'public', 'c-30')", [
        mine.ticket_id,
      ]),
    ).rejects.toThrow(/not found/i);
    await expect(
      q(bob, "select public.mark_comment_hidden($1, true)", [mine.message_id]),
    ).rejects.toThrow(/not found/i);
    await expect(
      q(bob, "select public.mark_comment_deleted($1)", [mine.message_id]),
    ).rejects.toThrow(/not found/i);

    // The same Meta ids in workspace B are B's own, untouched by A's.
    const theirs = await comment(tenantB, "facebook", "person-30", "post-30", "Ours?", {
      id: "c-30",
    });
    expect(theirs.result).toBe("created");
    expect(theirs.post_id).not.toBe(mine.post_id);
    expect(theirs.contact_id).not.toBe(mine.contact_id);
    const seen = await q<{ n: number }>(
      alice,
      "select count(*)::int as n from public.comment_posts where tenant_id = $1",
      [tenantB],
    );
    expect(seen[0].n).toBe(0);
  });

  it("members can't write the posts table or call the worker's functions; visitors can do nothing", async () => {
    await expect(
      q(
        alice,
        "insert into public.comment_posts (tenant_id, channel, external_id) values ($1, 'facebook', 'p')",
        [tenantA],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      q(alice, "update public.comment_posts set excerpt = 'x' where tenant_id = $1", [tenantA]),
    ).rejects.toThrow(/permission denied/);
    for (const call of [
      "public.file_social_comment($1, 'facebook', 'p', null, null, 'c', null, 'post', 'x', null, 's', now())",
      "public.file_own_comment($1, 'facebook', 'c', 'p', 'x', now())",
      "public.remove_social_comment($1, 'c-30')",
      "public.edit_social_comment($1, 'c-30', 'x', now())",
      "public.set_comment_hidden($1, 'c-30', true)",
      "public.claim_private_reply($1, gen_random_uuid(), 'c-30')",
      "public.release_private_reply($1, 'c-30')",
      "public.set_comment_post($1, gen_random_uuid(), null, 'x')",
      "public.finish_comment_outbound(gen_random_uuid())",
    ]) {
      const params = call.includes("$1") ? [tenantA] : [];
      await expect(q(alice, `select ${call}`, params), call).rejects.toThrow(/permission denied/);
    }
    await expect(
      q(alice, "select * from public.resolve_meta_comments('page', $1)", [PAGE_A]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      q(alice, "select * from public.comment_reply_context($1, gen_random_uuid())", [tenantA]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asAnon(db, (tx) => tx.query("select * from public.comment_posts")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asAnon(db, (tx) => tx.query("select public.mark_comment_deleted(gen_random_uuid())")),
    ).rejects.toThrow(/permission denied/);
  });

  it("forgetting a person takes their comment conversations with them", async () => {
    const gone = await comment(tenantA, "instagram", "person-40", "post-40", "Forget me?");
    await q(alice, "select public.forget_social_person($1)", [gone.contact_id]);
    const left = await q<{ n: number }>(
      alice,
      "select count(*)::int as n from public.messages where ticket_id = $1",
      [gone.ticket_id],
    );
    expect(left[0].n).toBe(0);
  });
});
