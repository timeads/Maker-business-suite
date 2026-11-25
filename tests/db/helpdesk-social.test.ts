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

// Made-up ids: a Page, the Instagram account linked to it, and customers.
const PAGE_A = "page-a-1001";
const IG_A = "ig-a-2002";
const PAGE_B = "page-b-3003";
const POSTING = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
];
const MESSAGING = [
  ...POSTING,
  "pages_messaging",
  "pages_manage_metadata",
  "instagram_manage_messages",
];

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
  needs_profile: boolean;
  kept_in: string | null;
};

async function message(
  tenant: string,
  channel: string,
  person: string,
  body: string,
  extra: { mid?: string; kind?: string; summary?: string | null; tags?: string[] } = {},
) {
  n += 1;
  const rows = await service<{ r: Filed }>(
    `select public.file_social_message($1, $2, $3, $4, $5, $6, $7, $8, now(), $9) as r`,
    [
      tenant,
      channel,
      person,
      extra.mid ?? `mid-${n}`,
      body,
      extra.kind ?? "reply",
      extra.summary ?? null,
      `${channel === "instagram" ? "Instagram" : "Facebook"} message: test`,
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
    JSON.stringify({ version: 1, human_agent: false, ...body }),
  ]);

const payload = (object: string, account: string) => ({
  object,
  entry: [{ id: account, time: 1, messaging: [] }],
});
const enqueue = async (id: string, body: unknown) =>
  (
    await service<{ r: string }>("select public.enqueue_meta_event($1, $2::jsonb) as r", [
      id,
      JSON.stringify(body),
    ])
  )[0].r;

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
  tenantA = await tenantFor(alice, "Social A");
  tenantB = await tenantFor(bob, "Social B");
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, amy.id],
  );
});

describe("whose a delivery is", () => {
  it("is dropped while nobody has that account connected", async () => {
    expect(await enqueue("a".repeat(64), payload("page", PAGE_A))).toBe("dropped");
    expect(await enqueue("b".repeat(64), payload("instagram", IG_A))).toBe("dropped");
  });

  it("is dropped for a posting-only connection, and while the channel is switched off", async () => {
    await connect(tenantA, PAGE_A, POSTING, IG_A, alice);
    await switchOn(alice, tenantA, { instagram: true, facebook: true });
    expect(await enqueue("c".repeat(64), payload("instagram", IG_A))).toBe("dropped");

    await connect(tenantA, PAGE_A, MESSAGING, IG_A, alice);
    await switchOn(alice, tenantA, { instagram: false, facebook: false });
    expect(await enqueue("d".repeat(64), payload("page", PAGE_A))).toBe("dropped");
  });

  it("is queued once the permissions are granted and the channel is on, and only once", async () => {
    await switchOn(alice, tenantA, { instagram: true, facebook: true });
    expect(await enqueue("e".repeat(64), payload("instagram", IG_A))).toBe("queued");
    expect(await enqueue("e".repeat(64), payload("instagram", IG_A))).toBe("duplicate");
    expect(await enqueue("f".repeat(64), payload("page", PAGE_A))).toBe("queued");
    // Another workspace's account, never connected for messages.
    expect(await enqueue("g".repeat(64), payload("page", PAGE_B))).toBe("dropped");
    // Not a messaging object at all.
    expect(await enqueue("h".repeat(64), payload("user", PAGE_A))).toBe("dropped");

    const where = await service<{ tenant_id: string; channel: string; page_id: string }>(
      "select * from public.resolve_meta_channel('instagram', $1)",
      [IG_A],
    );
    expect(where).toEqual([
      expect.objectContaining({ tenant_id: tenantA, channel: "instagram", page_id: PAGE_A }),
    ]);
    expect(await service("select * from public.resolve_meta_channel('page', $1)", [IG_A])).toEqual(
      [],
    );
  });

  it("hands deliveries to the worker once, and lets go of the payload when done", async () => {
    const claimed = await service<{ id: string }>("select * from public.claim_meta_events(10)");
    expect(claimed.map((row) => row.id).sort()).toEqual(["e".repeat(64), "f".repeat(64)]);
    expect(await service("select * from public.claim_meta_events(10)")).toHaveLength(0);
    await service("select public.complete_meta_event($1)", ["e".repeat(64)]);
    await service("select public.complete_meta_event($1, 'retry later')", ["f".repeat(64)]);
    const { rows } = await db.query<{ id: string; payload: unknown; processed_at: string | null }>(
      "select id, payload, processed_at from private.meta_events order by id",
    );
    expect(rows[0].payload).toEqual({});
    expect(rows[0].processed_at).not.toBeNull();
    expect(rows[1].processed_at).toBeNull();
  });
});

describe("filing a message", () => {
  let first: Filed;

  it("starts one conversation per person per channel, and files the same message once", async () => {
    first = await message(tenantA, "instagram", "person-1", "Hello there", { mid: "same-mid" });
    expect(first.result).toBe("created");
    expect(first.needs_profile).toBe(true);
    const again = await message(tenantA, "instagram", "person-1", "Hello there", {
      mid: "same-mid",
    });
    expect(again.result).toBe("duplicate");
    expect(again.message_id).toBe(first.message_id);

    const more = await message(tenantA, "instagram", "person-1", "One more thing");
    expect(more.result).toBe("threaded");
    expect(more.ticket_id).toBe(first.ticket_id);

    // The same person's id on the other channel is someone else as far as we know.
    const other = await message(tenantA, "facebook", "person-1", "Hi from Facebook");
    expect(other.result).toBe("created");
    expect(other.ticket_id).not.toBe(first.ticket_id);

    const rows = await q<{ channel: string; n: number }>(
      alice,
      `select t.channel, count(m.id)::int as n from public.tickets t
       join public.messages m on m.ticket_id = t.id where t.tenant_id = $1 group by t.channel order by 1`,
      [tenantA],
    );
    expect(rows).toEqual([
      { channel: "facebook", n: 1 },
      { channel: "instagram", n: 2 },
    ]);
  });

  it("keeps the person's name and handle once read, and asks again only after a month", async () => {
    await service("select public.set_social_profile($1, $2, $3, $4)", [
      tenantA,
      first.contact_id,
      "Made Up Person",
      "made.up_person",
    ]);
    const after = await message(tenantA, "instagram", "person-1", "Thanks");
    expect(after.needs_profile).toBe(false);
    const contact = await q<{ name: string; handle: string; email: string | null }>(
      amy,
      "select name, handle, email from public.contacts where id = $1",
      [first.contact_id],
    );
    expect(contact).toEqual([{ name: "Made Up Person", handle: "made.up_person", email: null }]);
    // Something that isn't a username is never kept as one.
    await service("select public.set_social_profile($1, $2, null, $3)", [
      tenantA,
      first.contact_id,
      "not a/handle",
    ]);
    expect(
      (
        await q<{ handle: string }>(amy, "select handle from public.contacts where id = $1", [
          first.contact_id,
        ])
      )[0].handle,
    ).toBe("made.up_person");
  });

  it("reopens a closed conversation, and leaves one in Spam where it is", async () => {
    await q(alice, "select public.set_ticket_status($1, 'closed')", [first.ticket_id]);
    await message(tenantA, "instagram", "person-1", "Are you there?");
    const [ticket] = await q<{ status: string }>(
      alice,
      "select status from public.tickets where id = $1",
      [first.ticket_id],
    );
    expect(ticket.status).toBe("open");

    const spam = await message(tenantA, "instagram", "person-spam", "Buy followers");
    await q(alice, "select public.shelve_ticket($1, 'spam')", [spam.ticket_id]);
    const more = await message(tenantA, "instagram", "person-spam", "Really, buy them");
    expect(more.ticket_id).toBe(spam.ticket_id);
    expect(more.kept_in).toBe("spam");
    const [kept] = await q<{ shelf: string; status: string }>(
      alice,
      "select shelf, status from public.tickets where id = $1",
      [spam.ticket_id],
    );
    expect(kept).toEqual({ shelf: "spam", status: "closed" });
  });

  it("applies the tags the rules gave it", async () => {
    const tagged = await message(tenantA, "facebook", "person-tags", "Where is my order", {
      tags: ["shipping"],
    });
    const tags = await q<{ name: string }>(
      alice,
      `select g.name from public.ticket_tags tt join public.tags g on g.id = tt.tag_id
       where tt.ticket_id = $1`,
      [tagged.ticket_id],
    );
    expect(tags).toEqual([{ name: "shipping" }]);
  });

  it("shows a picture-only message in the list by our own few words", async () => {
    const photo = await message(tenantA, "instagram", "person-photo", "", {
      summary: "Sent a photo",
    });
    const facts = await q<{ preview: string; message_count: number }>(
      alice,
      "select preview, message_count from public.ticket_list_facts($1)",
      [[photo.ticket_id]],
    );
    expect(facts).toEqual([{ preview: "Sent a photo", message_count: 1 }]);
  });

  it("is refused for anything that isn't Instagram or Facebook, and for members", async () => {
    await expect(
      service(
        "select public.file_social_message($1, 'email', 'x', 'm', 'b', 'reply', null, 's', now())",
        [tenantA],
      ),
    ).rejects.toThrow(/can't be filed/);
    for (const who of [alice, bob]) {
      await expect(
        q(
          who,
          "select public.file_social_message($1, 'instagram', 'x', 'm', 'b', 'reply', null, 's', now())",
          [tenantA],
        ),
      ).rejects.toThrow(/permission denied/);
    }
  });
});

describe("taking a message back, and reactions", () => {
  it("clears the words and files of an unsent message and says it was removed", async () => {
    const sent = await message(tenantA, "instagram", "person-unsend", "Oops wrong chat", {
      mid: "unsend-me",
    });
    await service("select public.record_message_attachments($1, $2, $3::jsonb)", [
      tenantA,
      sent.message_id,
      JSON.stringify([
        {
          name: "photo.jpg",
          type: "image/jpeg",
          size: 10,
          path: `${tenantA}/${sent.ticket_id}/${sent.message_id}/abc`,
          state: "kept",
        },
      ]),
    ]);
    const removed = await service<{ r: boolean }>(
      "select public.remove_social_message($1, 'unsend-me') as r",
      [tenantA],
    );
    expect(removed[0].r).toBe(true);
    const [row] = await q<{ body: string; removed_at: string | null }>(
      alice,
      "select body, removed_at from public.messages where id = $1",
      [sent.message_id],
    );
    expect(row.body).toBe("");
    expect(row.removed_at).not.toBeNull();
    expect(
      await q(alice, "select id from public.message_attachments where message_id = $1", [
        sent.message_id,
      ]),
    ).toHaveLength(0);
    const { rows: queued } = await db.query<{ storage_path: string }>(
      "select storage_path from private.attachment_removals where storage_path like $1",
      [`${tenantA}/${sent.ticket_id}/%`],
    );
    expect(queued).toHaveLength(1);
    const facts = await q<{ preview: string }>(
      alice,
      "select preview from public.ticket_list_facts($1)",
      [[sent.ticket_id]],
    );
    expect(facts[0].preview).toBe("Message removed");
    // Another workspace's worker call can't reach it, and a second call changes nothing.
    expect(
      (
        await service<{ r: boolean }>("select public.remove_social_message($1, 'unsend-me') as r", [
          tenantB,
        ])
      )[0].r,
    ).toBe(false);
    expect(
      (
        await service<{ r: boolean }>("select public.remove_social_message($1, 'unsend-me') as r", [
          tenantA,
        ])
      )[0].r,
    ).toBe(false);
  });

  it("keeps one reaction per person per message, without reopening anything", async () => {
    const sent = await message(tenantA, "instagram", "person-react", "Lovely", { mid: "liked" });
    await q(alice, "select public.set_ticket_status($1, 'closed')", [sent.ticket_id]);
    const react = (emoji: string | null) =>
      service(
        "select public.set_social_reaction($1, 'react:person-react:liked', 'liked', $2, now())",
        [tenantA, emoji],
      );
    await react("+1");
    await react("<3");
    const rows = await q<{ body: string; kind: string }>(
      alice,
      "select body, kind from public.messages where ticket_id = $1 and kind = 'reaction'",
      [sent.ticket_id],
    );
    expect(rows).toEqual([{ body: "<3", kind: "reaction" }]);
    const [ticket] = await q<{ status: string }>(
      alice,
      "select status from public.tickets where id = $1",
      [sent.ticket_id],
    );
    expect(ticket.status).toBe("closed");
    const facts = await q<{ preview: string; message_count: number }>(
      alice,
      "select preview, message_count from public.ticket_list_facts($1)",
      [[sent.ticket_id]],
    );
    expect(facts).toEqual([{ preview: "Lovely", message_count: 1 }]);
    await react(null);
    expect(
      await q(alice, "select id from public.messages where ticket_id = $1 and kind = 'reaction'", [
        sent.ticket_id,
      ]),
    ).toHaveLength(0);
  });
});

describe("replies", () => {
  let convo: Filed;

  it("records a reply as the member who sent it, with Meta's ids, once", async () => {
    convo = await message(tenantA, "instagram", "person-reply", "Do you ship abroad?");
    const send = () =>
      q<{ id: string | null }>(
        amy,
        "select public.record_social_outbound($1, 'We do!', array['out-1', 'out-1-pictures'], $2::jsonb) as id",
        [convo.ticket_id, JSON.stringify([{ name: "photo.jpg", size: 10 }])],
      );
    const [sent] = await send();
    expect(sent.id).not.toBeNull();
    expect((await send())[0].id).toBeNull();
    const [row] = await q<{
      author_id: string;
      summary: string;
      also_ids: string[];
      from_email: string | null;
    }>(
      alice,
      "select author_id, summary, also_ids, from_email from public.messages where id = $1",
      [sent.id],
    );
    expect(row).toEqual({
      author_id: amy.id,
      summary: "Sent a photo",
      also_ids: ["out-1-pictures"],
      from_email: null,
    });
    const [ticket] = await q<{ status: string; assignee_id: string }>(
      alice,
      "select status, assignee_id from public.tickets where id = $1",
      [convo.ticket_id],
    );
    expect(ticket).toEqual({ status: "pending", assignee_id: amy.id });
  });

  it("does not file Meta's echo of that reply, by either of its ids", async () => {
    for (const mid of ["out-1", "out-1-pictures"]) {
      const echo = await service<{ r: { result: string } }>(
        "select public.file_social_echo($1, 'instagram', 'person-reply', $2, 'We do!', null, now()) as r",
        [tenantA, mid],
      );
      expect(echo[0].r.result).toBe("duplicate");
    }
  });

  it("files a reply sent from the Instagram app as the team's, and never starts a conversation with one", async () => {
    await message(tenantA, "instagram", "person-reply", "Great, thanks");
    const echo = await service<{ r: { result: string; message_id: string } }>(
      "select public.file_social_echo($1, 'instagram', 'person-reply', 'from-the-app', 'You are welcome', null, now()) as r",
      [tenantA],
    );
    expect(echo[0].r.result).toBe("threaded");
    const [row] = await q<{ direction: string; author_id: string | null; from_name: string }>(
      alice,
      "select direction, author_id, from_name from public.messages where id = $1",
      [echo[0].r.message_id],
    );
    expect(row).toEqual({ direction: "outbound", author_id: null, from_name: "Instagram app" });
    const [ticket] = await q<{ status: string }>(
      alice,
      "select status from public.tickets where id = $1",
      [convo.ticket_id],
    );
    expect(ticket.status).toBe("pending");

    const stranger = await service<{ r: { result: string } }>(
      "select public.file_social_echo($1, 'instagram', 'nobody-we-know', 'cold', 'Hi!', null, now()) as r",
      [tenantA],
    );
    expect(stranger[0].r.result).toBe("ignored");
  });

  it("turns an echo that arrived first into the reply, once its author is known", async () => {
    await service(
      "select public.file_social_echo($1, 'instagram', 'person-reply', 'raced', 'Sent at once', null, now())",
      [tenantA],
    );
    const [sent] = await q<{ id: string }>(
      amy,
      "select public.record_social_outbound($1, 'Sent at once', array['raced']) as id",
      [convo.ticket_id],
    );
    const rows = await q<{ id: string; author_id: string; from_name: string | null }>(
      alice,
      "select id, author_id, from_name from public.messages where provider_message_id = 'raced'",
    );
    expect(rows).toEqual([{ id: sent.id, author_id: amy.id, from_name: null }]);
  });

  it("goes through the outbox: failed keeps the words, sent files it, part-sent says so", async () => {
    const queue = async (text: string) =>
      (
        await q<{ id: string }>(
          amy,
          "select public.queue_outbound($1, $2::jsonb, $3::jsonb, 1) as id",
          [
            convo.ticket_id,
            JSON.stringify({
              kind: "social",
              channel: "instagram",
              doc: [{ t: "p", runs: [{ text }] }],
              then: "closed",
              files: [],
            }),
            JSON.stringify({ kind: "social", to: ["@made.up"], preview: text }),
          ],
        )
      )[0].id;
    const claim = async () => {
      await db.query("update private.outbound_queue set send_at = now() - interval '1 second'");
      return service<{ id: string }>("select * from public.claim_outbound(5)");
    };

    const failed = await queue("First try");
    await claim();
    // While it is being sent, an echo on this conversation waits rather than being filed twice.
    const waiting = await service<{ r: { result: string } }>(
      "select public.file_social_echo($1, 'instagram', 'person-reply', 'during', 'First try', null, now()) as r",
      [tenantA],
    );
    expect(waiting[0].r.result).toBe("retry");
    await service("select public.finish_social_outbound($1, '{}', null, '[]'::jsonb, $2)", [
      failed,
      "meta:10:2018278:none:outside the window",
    ]);
    const outbox = await q<{ state: string; error: string; doc: unknown }>(
      amy,
      "select state, error, doc from public.ticket_outbox($1)",
      [convo.ticket_id],
    );
    expect(outbox).toEqual([
      expect.objectContaining({
        state: "failed",
        error: "meta:10:2018278:none:outside the window",
      }),
    ]);
    expect(outbox[0].doc).toEqual([{ t: "p", runs: [{ text: "First try" }] }]);
    await q(amy, "select public.dismiss_outbound($1)", [failed]);

    const sent = await queue("Second try");
    await claim();
    const [filed] = await service<{ id: string }>(
      "select public.finish_social_outbound($1, array['queued-1'], 'Second try') as id",
      [sent],
    );
    expect(filed.id).not.toBeNull();
    const [row] = await q<{ author_id: string; body: string }>(
      alice,
      "select author_id, body from public.messages where id = $1",
      [filed.id],
    );
    expect(row).toEqual({ author_id: amy.id, body: "Second try" });
    const [ticket] = await q<{ status: string }>(
      alice,
      "select status from public.tickets where id = $1",
      [convo.ticket_id],
    );
    expect(ticket.status).toBe("closed");
    // A second answer for the same send changes nothing.
    expect(
      (
        await service<{ id: string | null }>(
          "select public.finish_social_outbound($1, array['queued-1'], 'Second try') as id",
          [sent],
        )
      )[0].id,
    ).toBeNull();

    const partial = await queue("Words and a picture");
    await claim();
    await service(
      "select public.finish_social_outbound($1, array['queued-2'], 'Words and a picture', '[]'::jsonb, $2)",
      [partial, "meta:100:2018008:partial:could not fetch"],
    );
    const after = await q<{ state: string; error: string }>(
      amy,
      "select state, error from public.ticket_outbox($1)",
      [convo.ticket_id],
    );
    expect(after).toEqual([
      expect.objectContaining({
        state: "failed",
        error: "meta:100:2018008:partial:could not fetch",
      }),
    ]);
    expect(
      await q(alice, "select id from public.messages where provider_message_id = 'queued-2'"),
    ).toHaveLength(1);
  });

  it("is refused on an email conversation, without an id, and across workspaces", async () => {
    const mail = await service<{ r: { ticket_id: string } }>(
      "select public.file_inbound_email('social-a', 'pm-1', 'someone@customer.test', null, 'Hi', 'Hello', null, null, '{}', '{}', '{}', '{}') as r",
    );
    await expect(
      q(amy, "select public.record_social_outbound($1, 'x', array['m'])", [mail[0].r.ticket_id]),
    ).rejects.toThrow(/is an email/);
    await expect(
      q(amy, "select public.record_social_outbound($1, 'x', '{}')", [convo.ticket_id]),
    ).rejects.toThrow(/needs its id/);
    await expect(
      q(bob, "select public.record_social_outbound($1, 'x', array['m2'])", [convo.ticket_id]),
    ).rejects.toThrow(/not found/i);
    // Conversations from different channels can't be joined into one.
    await expect(
      q(alice, "select public.merge_tickets($1, $2)", [convo.ticket_id, mail[0].r.ticket_id]),
    ).rejects.toThrow(/different channels/);
  });

  it("tells the server who to reply to and when they last wrote", async () => {
    const rows = await service<{ channel: string; external_id: string; last_inbound_at: string }>(
      "select * from public.social_reply_context($1, $2)",
      [tenantA, convo.ticket_id],
    );
    expect(rows).toEqual([
      expect.objectContaining({ channel: "instagram", external_id: "person-reply" }),
    ]);
    expect(rows[0].last_inbound_at).not.toBeNull();
    // Naming the wrong workspace finds nothing.
    expect(
      await service("select * from public.social_reply_context($1, $2)", [
        tenantB,
        convo.ticket_id,
      ]),
    ).toHaveLength(0);
  });
});

describe("workspaces stay apart", () => {
  it("another workspace sees none of the people, conversations or messages", async () => {
    await connect(tenantB, PAGE_B, MESSAGING, null, bob);
    await switchOn(bob, tenantB, { facebook: true, instagram: false });
    const theirs = await message(tenantB, "facebook", "person-1", "Hello B");
    expect(theirs.result).toBe("created");

    for (const table of ["contacts", "tickets", "messages"]) {
      const mine = await q<{ tenant_id: string }>(bob, `select tenant_id from public.${table}`);
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.every((row) => row.tenant_id === tenantB)).toBe(true);
    }
    // The same person id in two workspaces is two people.
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::int as n from public.contacts where external_id = 'person-1' and channel = 'facebook'",
    );
    expect(rows[0].n).toBe(2);
    // Instagram isn't on for B: a delivery for an account of theirs would be dropped.
    expect(await enqueue("i".repeat(64), payload("page", PAGE_B))).toBe("queued");
    expect(await enqueue("j".repeat(64), payload("instagram", PAGE_B))).toBe("dropped");
  });

  it("nobody but the service role touches the queue or the filing functions", async () => {
    const attempts = [
      "select * from private.meta_events",
      "select * from private.meta_deletions",
      "select public.enqueue_meta_event('" + "z".repeat(64) + "', '{}'::jsonb)",
      "select * from public.claim_meta_events(1)",
      "select public.complete_meta_event('x')",
      `select * from public.resolve_meta_channel('page', '${PAGE_A}')`,
      `select public.set_social_profile('${tenantA}', gen_random_uuid(), 'x', 'y')`,
      `select public.file_social_echo('${tenantA}', 'instagram', 'p', 'm', 'b', null, now())`,
      `select public.remove_social_message('${tenantA}', 'm')`,
      `select public.set_social_reaction('${tenantA}', 'r', 'm', 'x', now())`,
      `select * from public.social_reply_context('${tenantA}', gen_random_uuid())`,
      "select public.finish_social_outbound(gen_random_uuid())",
      "select public.request_meta_deletion('abcdefghijklmnop', 'x')",
      "select public.run_meta_deletions(1)",
      "select public.meta_deletion_status('abcdefghijklmnop')",
    ];
    for (const sql of attempts) {
      await expect(q(alice, sql), sql).rejects.toThrow(/permission denied/);
      await expect(
        asAnon(db, (tx) => tx.query(sql)),
        sql,
      ).rejects.toThrow(/permission denied/);
    }
  });
});

describe("privacy", () => {
  it("lets the team write down an email, and a shop's privacy request for it forgets them", async () => {
    const who = await message(tenantA, "instagram", "person-email", "My order is late");
    await q(amy, "select public.set_contact_known_email($1, $2)", [
      who.contact_id,
      "Late@Customer.Test",
    ]);
    await expect(
      q(amy, "select public.set_contact_known_email($1, 'not an email')", [who.contact_id]),
    ).rejects.toThrow(/isn't an email/);
    await expect(
      q(bob, "select public.set_contact_known_email($1, 'x@y.test')", [who.contact_id]),
    ).rejects.toThrow(/not found/i);
    const [contact] = await q<{ known_email: string }>(
      amy,
      "select known_email from public.contacts where id = $1",
      [who.contact_id],
    );
    expect(contact.known_email).toBe("late@customer.test");

    await service("select public.redact_customer($1, 'shopify', 'cust-9', 'late@customer.test')", [
      tenantA,
    ]);
    expect(
      await q(alice, "select id from public.tickets where id = $1", [who.ticket_id]),
    ).toHaveLength(0);
  });

  it("forgets a person, their conversations and files on a manager's say-so only", async () => {
    const who = await message(tenantA, "facebook", "person-forget", "Please delete me");
    await service("select public.record_message_attachments($1, $2, $3::jsonb)", [
      tenantA,
      who.message_id,
      JSON.stringify([
        {
          name: "photo.jpg",
          type: "image/jpeg",
          size: 10,
          path: `${tenantA}/${who.ticket_id}/${who.message_id}/forget`,
          state: "kept",
        },
      ]),
    ]);
    await expect(
      q(amy, "select public.forget_social_person($1)", [who.contact_id]),
    ).rejects.toThrow(/Only owners and admins/);
    await expect(
      q(bob, "select public.forget_social_person($1)", [who.contact_id]),
    ).rejects.toThrow(/not found/i);
    const [gone] = await q<{ n: number }>(alice, "select public.forget_social_person($1) as n", [
      who.contact_id,
    ]);
    expect(gone.n).toBe(1);
    expect(
      await q(alice, "select id from public.messages where ticket_id = $1", [who.ticket_id]),
    ).toHaveLength(0);
    const { rows } = await db.query(
      "select 1 from private.attachment_removals where storage_path like $1",
      [`%/${who.message_id}/forget`],
    );
    expect(rows).toHaveLength(1);
    // An email customer isn't forgotten this way.
    const [mail] = await q<{ id: string }>(
      alice,
      "select id from public.contacts where channel = 'email' and tenant_id = $1 limit 1",
      [tenantA],
    );
    await expect(q(alice, "select public.forget_social_person($1)", [mail.id])).rejects.toThrow(
      /not found/i,
    );
  });

  it("deletes whatever is held under an id Meta names, in every workspace, and keeps no id afterwards", async () => {
    await message(tenantA, "facebook", "delete-this-id", "A");
    await message(tenantB, "facebook", "delete-this-id", "B");
    await service("select public.request_meta_deletion('code0000000000000001', 'delete-this-id')");
    expect(
      (
        await service<{ s: string }>(
          "select public.meta_deletion_status('code0000000000000001') as s",
        )
      )[0].s,
    ).toBe("received");
    expect((await service<{ n: number }>("select public.run_meta_deletions() as n"))[0].n).toBe(1);
    const { rows } = await db.query(
      "select 1 from public.contacts where external_id = 'delete-this-id'",
    );
    expect(rows).toHaveLength(0);
    const { rows: kept } = await db.query<{ external_id: string | null; removed: number }>(
      "select external_id, removed from private.meta_deletions where code = 'code0000000000000001'",
    );
    expect(kept).toEqual([{ external_id: null, removed: 2 }]);
    expect(
      (
        await service<{ s: string }>(
          "select public.meta_deletion_status('code0000000000000001') as s",
        )
      )[0].s,
    ).toBe("done");
    expect(
      (
        await service<{ s: string | null }>(
          "select public.meta_deletion_status('nosuchcode0000000000') as s",
        )
      )[0].s,
    ).toBeNull();
    // Running again finds nothing left to do.
    expect((await service<{ n: number }>("select public.run_meta_deletions() as n"))[0].n).toBe(0);
  });
});

describe("what a contact and a kept file can be", () => {
  it("an email contact has an address and no outside id; a social one the other way round", async () => {
    await expect(
      db.query("insert into public.contacts (tenant_id, channel) values ($1, 'instagram')", [
        tenantA,
      ]),
    ).rejects.toThrow(/contacts_channel_shape/);
    await expect(
      db.query(
        "insert into public.contacts (tenant_id, channel, external_id, email) values ($1, 'instagram', 'x', 'a@b.test')",
        [tenantA],
      ),
    ).rejects.toThrow(/contacts_channel_shape/);
    await expect(
      db.query("insert into public.contacts (tenant_id) values ($1)", [tenantA]),
    ).rejects.toThrow(/contacts_channel_shape/);
  });

  it("keeps a voice message, and still no markup or programs", async () => {
    const voice = await message(tenantA, "instagram", "person-voice", "", {
      summary: "Sent a voice message",
    });
    const file = (type: string) =>
      JSON.stringify([
        {
          name: "voice-message.m4a",
          type,
          size: 10,
          path: `${tenantA}/${voice.ticket_id}/${voice.message_id}/v`,
          state: "kept",
        },
      ]);
    await expect(
      service("select public.record_message_attachments($1, $2, $3::jsonb)", [
        tenantA,
        voice.message_id,
        file("text/html"),
      ]),
    ).rejects.toThrow(/message_attachments_kept_types/);
    const [written] = await service<{ n: number }>(
      "select public.record_message_attachments($1, $2, $3::jsonb) as n",
      [tenantA, voice.message_id, file("audio/mp4")],
    );
    expect(written.n).toBe(1);
    const { rows } = await db.query<{ allowed_mime_types: string[] }>(
      "select allowed_mime_types from storage.buckets where id = 'helpdesk'",
    );
    expect(rows[0].allowed_mime_types).toContain("audio/mp4");
    expect(rows[0].allowed_mime_types).not.toContain("text/html");
  });
});
