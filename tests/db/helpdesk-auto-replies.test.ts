import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

/**
 * The automatic first reply in the database: the claim that makes it once
 * per message, the quiet period, the outbox carrying a reply nobody wrote,
 * and how it is filed (never as the team having answered).
 */

type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let amy: User; // member of A
let bob: User; // owner of B
let tenantA: string;
let tenantB: string;
let n = 0;

const q = <T>(who: User, sql: string, params: unknown[] = []) =>
  asUser(db, who, async (tx) => (await tx.query<T>(sql, params)).rows);
const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);

type Filed = { result: string; ticket_id: string; message_id: string; contact_id: string };

async function dm(tenant: string, person: string, kind = "reply", channel = "instagram") {
  n += 1;
  const rows = await service<{ r: Filed }>(
    "select public.file_social_message($1, $2, $3, $4, 'Hello there', $5, null, 'Instagram message', now()) as r",
    [tenant, channel, person, `mid-in-${n}`, kind],
  );
  return rows[0].r;
}
async function email(slug: string, from: string) {
  n += 1;
  const rows = await service<{ r: Filed }>(
    "select public.file_inbound_email($1, $2, $3, 'Pat Example', 'A question', 'Hello', $4, null, '{}', '{}') as r",
    [slug, `pm-in-${n}`, from, `<in-${n}@mail.test>`],
  );
  return rows[0].r;
}

const SOCIAL = { kind: "social", channel: "instagram", doc: [], then: "keep", via: "message" };
const claim = async (
  tenant: string,
  messageId: string,
  over: { hours?: number; variant?: string; payload?: object } = {},
) =>
  (
    await service<{ r: { result: string; id?: string } }>(
      "select public.claim_auto_reply($1, $2, $3, $4::jsonb, $5::jsonb, $6) as r",
      [
        tenant,
        messageId,
        over.variant ?? "usual",
        JSON.stringify(over.payload ?? SOCIAL),
        JSON.stringify({ kind: "social", to: ["Pat"], preview: "Thanks for writing" }),
        over.hours ?? 24,
      ],
    )
  )[0].r;
const facts = async (tenant: string, messageId: string) =>
  (
    await service<{
      channel: string;
      ticket_kind: string;
      shelf: string | null;
      direction: string;
      message_kind: string;
      removed: boolean;
      contact_name: string | null;
      reply_to_email: string | null;
      last_auto_reply_at: string | null;
      team_answered_since: boolean;
      business_name: string;
      time_zone: string;
    }>("select * from public.auto_reply_facts($1, $2)", [tenant, messageId])
  )[0];
const due = () =>
  service<{ id: string; author_id: string | null; payload: Record<string, unknown> }>(
    "select * from public.claim_outbound(5)",
  );
const queue = async (id: string) =>
  (
    await db.query<{ state: string; error: string | null; automatic: boolean; payload: object }>(
      "select state, error, automatic, payload from private.outbound_queue where id = $1",
      [id],
    )
  ).rows[0];
const ticket = async (id: string) =>
  (
    await db.query<Record<string, string | null>>(
      "select status, first_reply_at, assignee_id, closed_at, last_message_at::text from public.tickets where id = $1",
      [id],
    )
  ).rows[0];
const claims = async (messageId: string) =>
  (
    await db.query<{ state: string; error: string | null; variant: string }>(
      "select state, error, variant from private.auto_replies where inbound_message_id = $1",
      [messageId],
    )
  ).rows;
const age = (messageId: string, interval: string) =>
  db.query(
    `update private.auto_replies set created_at = now() - interval '${interval}' where inbound_message_id = $1`,
    [messageId],
  );

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  amy = { id: await createUser(db, "amy@a.test"), email: "amy@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  const tenantFor = async (owner: User, name: string) =>
    (
      await q<{ id: string }>(
        owner,
        "select id from public.create_tenant($1, 'America/New_York', 'USD')",
        [name],
      )
    )[0].id;
  tenantA = await tenantFor(alice, "Auto A");
  tenantB = await tenantFor(bob, "Auto B");
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, amy.id],
  );
});

describe("the claim", () => {
  it("is taken once per message: a second worker or a retry gets 'duplicate'", async () => {
    const m = await dm(tenantA, "person-once");
    const first = await claim(tenantA, m.message_id);
    expect(first.result).toBe("queued");
    expect(await claim(tenantA, m.message_id)).toEqual({ result: "duplicate" });
    expect(await claim(tenantA, m.message_id, { hours: 1 })).toEqual({ result: "duplicate" });
    expect(await claims(m.message_id)).toEqual([
      { state: "queued", error: null, variant: "usual" },
    ]);
    const rows = await db.query<{ c: number }>(
      "select count(*)::int as c from private.outbound_queue where ticket_id = $1",
      [m.ticket_id],
    );
    expect(rows.rows[0].c).toBe(1);
    // The table itself refuses a second row for the message, whatever asks.
    await expect(
      db.query(
        `insert into private.auto_replies (tenant_id, ticket_id, contact_id, channel, inbound_message_id, variant)
         values ($1, $2, $3, 'instagram', $4, 'usual')`,
        [tenantA, m.ticket_id, m.contact_id, m.message_id],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it("queues it due now, with no author, marked automatic by the database", async () => {
    const m = await dm(tenantA, "person-shape");
    const { id } = await claim(tenantA, m.message_id, { variant: "away" });
    const row = await queue(id!);
    expect(row).toMatchObject({ state: "waiting", automatic: true });
    expect(row.payload).toMatchObject({ kind: "social", automatic: true });
    const full = await db.query<{ author_id: string | null; late: boolean; summary: object }>(
      "select author_id, send_at <= now() as late, summary from private.outbound_queue where id = $1",
      [id],
    );
    expect(full.rows[0]).toMatchObject({
      author_id: null,
      late: true,
      summary: { automatic: true },
    });
    expect((await claims(m.message_id))[0].variant).toBe("away");
    // The team sees it waiting, like anything else in the outbox.
    const seen = await q<{
      id: string;
      summary: { automatic?: boolean };
      author_id: string | null;
    }>(amy, "select id, summary, author_id from public.ticket_outbox($1)", [m.ticket_id]);
    expect(seen).toEqual([
      {
        id,
        author_id: null,
        summary: { kind: "social", to: ["Pat"], preview: "Thanks for writing", automatic: true },
      },
    ]);
    await db.query("delete from private.outbound_queue where id = $1", [id]);
  });

  it("keeps the quiet period per person and channel", async () => {
    const first = await dm(tenantA, "person-quiet");
    expect((await claim(tenantA, first.message_id)).result).toBe("queued");
    const second = await dm(tenantA, "person-quiet");
    expect(second.ticket_id).toBe(first.ticket_id);
    expect(await claim(tenantA, second.message_id)).toEqual({ result: "quiet" });
    expect(await claims(second.message_id)).toEqual([]);
    expect((await facts(tenantA, second.message_id)).last_auto_reply_at).not.toBeNull();
    // 23 hours on: still quiet for 24, not for a workspace that set 12.
    await age(first.message_id, "23 hours");
    expect(await claim(tenantA, second.message_id)).toEqual({ result: "quiet" });
    expect((await claim(tenantA, second.message_id, { hours: 12 })).result).toBe("queued");
    // Someone else, and the same person's id on another channel, are their own.
    const other = await dm(tenantA, "person-quiet-2");
    expect((await claim(tenantA, other.message_id)).result).toBe("queued");
    const facebook = await dm(tenantA, "person-quiet", "reply", "facebook");
    expect((await claim(tenantA, facebook.message_id)).result).toBe("queued");
    await db.query("delete from private.outbound_queue where automatic");
  });

  it("counts a reply that was refused, so it is never tried again on the next message", async () => {
    const first = await dm(tenantA, "person-refused");
    const { id } = await claim(tenantA, first.message_id);
    expect((await due()).map((r) => r.id)).toContain(id);
    await service("select public.finish_social_outbound($1, '{}', null, '[]'::jsonb, $2)", [
      id,
      "meta:100:2534037:none:not the thread owner",
    ]);
    expect(await queue(id!)).toEqual({
      state: "failed",
      error: "meta:100:2534037:none:not the thread owner",
      automatic: true,
      // Nothing is kept to send again.
      payload: {},
    });
    expect(await claims(first.message_id)).toEqual([
      { state: "failed", error: "meta:100:2534037:none:not the thread owner", variant: "usual" },
    ]);
    // It is finished: the worker is never handed it again.
    expect((await due()).map((r) => r.id)).not.toContain(id);
    expect(
      await service("select public.finish_social_outbound($1, array['late'], 'x')", [id]),
    ).toEqual([{ finish_social_outbound: null }]);
    const next = await dm(tenantA, "person-refused");
    expect(await claim(tenantA, next.message_id)).toEqual({ result: "quiet" });
    // The team is told, with no words to put back, and can clear the notice.
    const seen = await q<{ id: string; state: string; doc: unknown }>(
      amy,
      "select id, state, doc from public.ticket_outbox($1)",
      [first.ticket_id],
    );
    expect(seen).toEqual([{ id, state: "failed", doc: null }]);
    await q(amy, "select public.dismiss_outbound($1)", [id]);
    expect(await q(amy, "select id from public.ticket_outbox($1)", [first.ticket_id])).toEqual([]);
    // The claim outlives the notice: still quiet.
    expect(await claim(tenantA, next.message_id)).toEqual({ result: "quiet" });
  });

  it("is refused for anything but a person's own message", async () => {
    for (const kind of ["story_mention"]) {
      const m = await dm(tenantA, `person-kind-${kind}`, kind);
      expect(await claim(tenantA, m.message_id)).toEqual({ result: "not_a_message" });
    }
    // A reaction, a team message, and a message the person took back.
    const m = await dm(tenantA, "person-kinds");
    await service("select public.set_social_reaction($1, 'reaction-1', $2, '❤', now())", [
      tenantA,
      `mid-in-${n}`,
    ]);
    const reaction = await db.query<{ id: string }>(
      "select id from public.messages where ticket_id = $1 and kind = 'reaction'",
      [m.ticket_id],
    );
    expect(await claim(tenantA, reaction.rows[0].id)).toEqual({ result: "not_a_message" });
    const echo = (
      await service<{ r: { message_id: string } }>(
        "select public.file_social_echo($1, 'instagram', 'person-kinds', 'mid-echo-1', 'From the app', null, now()) as r",
        [tenantA],
      )
    )[0].r;
    expect(await claim(tenantA, echo.message_id)).toEqual({ result: "not_a_message" });
    const taken = await dm(tenantA, "person-taken");
    await service("select public.remove_social_message($1, $2)", [tenantA, `mid-in-${n}`]);
    expect(await claim(tenantA, taken.message_id)).toEqual({ result: "not_a_message" });
    expect((await facts(tenantA, taken.message_id)).removed).toBe(true);
    // A comment on a post is public: never.
    const c = (
      await service<{ r: Filed }>(
        `select public.file_social_comment($1, 'instagram', 'person-comment', 'Pat', 'pat', 'comment-1', null,
                                           'post-1', 'Lovely!', null, 'Instagram comment', now(), true, '{}') as r`,
        [tenantA],
      )
    )[0].r;
    expect(await claim(tenantA, c.message_id)).toEqual({ result: "not_a_message" });
    expect(await facts(tenantA, c.message_id)).toMatchObject({
      ticket_kind: "comment",
      message_kind: "comment",
    });
    expect(await claim(tenantA, "00000000-0000-4000-8000-000000000000")).toEqual({
      result: "unknown",
    });
  });

  it("leaves Spam and the Trash alone, and answers an archived conversation", async () => {
    const m = await dm(tenantA, "person-spam");
    await q(amy, "select public.shelve_ticket($1, 'spam')", [m.ticket_id]);
    const again = await dm(tenantA, "person-spam");
    expect((await facts(tenantA, again.message_id)).shelf).toBe("spam");
    expect(await claim(tenantA, again.message_id)).toEqual({ result: "shelved" });
    await q(amy, "select public.shelve_ticket($1, 'trash')", [m.ticket_id]);
    expect(await claim(tenantA, again.message_id)).toEqual({ result: "shelved" });
    const a = await dm(tenantA, "person-archive");
    await q(amy, "select public.shelve_ticket($1, 'archived')", [a.ticket_id]);
    const back = await dm(tenantA, "person-archive");
    expect((await claim(tenantA, back.message_id)).result).toBe("queued");
    await db.query("delete from private.outbound_queue where automatic");
  });

  it("steps back once someone on the team has answered, or is answering", async () => {
    const m = await dm(tenantA, "person-answered");
    expect((await facts(tenantA, m.message_id)).team_answered_since).toBe(false);
    await q(amy, "select public.record_social_outbound($1, 'On it', array['mid-out-a1'])", [
      m.ticket_id,
    ]);
    expect((await facts(tenantA, m.message_id)).team_answered_since).toBe(true);
    expect(await claim(tenantA, m.message_id)).toEqual({ result: "answered" });
    // A reply of a person's still waiting out its undo counts too.
    const w = await dm(tenantA, "person-answering");
    await q(amy, "select public.queue_outbound($1, $2::jsonb, '{}'::jsonb, 20)", [
      w.ticket_id,
      JSON.stringify({ ...SOCIAL, then: "pending" }),
    ]);
    expect((await facts(tenantA, w.message_id)).team_answered_since).toBe(true);
    expect(await claim(tenantA, w.message_id)).toEqual({ result: "answered" });
    // An earlier answer doesn't count against a later message.
    const later = await dm(tenantA, "person-answered");
    expect((await facts(tenantA, later.message_id)).team_answered_since).toBe(false);
    await db.query("delete from private.outbound_queue");
  });

  it("checks what it is handed", async () => {
    const m = await dm(tenantA, "person-checks");
    await expect(claim(tenantA, m.message_id, { hours: 0 })).rejects.toThrow(/quiet period/);
    await expect(claim(tenantA, m.message_id, { hours: 169 })).rejects.toThrow(/quiet period/);
    await expect(claim(tenantA, m.message_id, { variant: "clever" })).rejects.toThrow(
      /Unknown kind/,
    );
    await expect(
      service("select public.claim_auto_reply($1, $2, 'usual', '[]'::jsonb, '{}'::jsonb, 24)", [
        tenantA,
        m.message_id,
      ]),
    ).rejects.toThrow(/can't be queued/);
    expect(await claims(m.message_id)).toEqual([]);
  });
});

describe("how it is filed", () => {
  it("is the business's own message, and never the team having answered", async () => {
    const m = await dm(tenantA, "person-filed");
    const before = await ticket(m.ticket_id);
    expect(before).toMatchObject({ status: "open", first_reply_at: null, assignee_id: null });
    const { id } = await claim(tenantA, m.message_id);
    const rows = await due();
    expect(rows.find((r) => r.id === id)).toMatchObject({
      author_id: null,
      payload: { automatic: true },
    });
    const sent = await service<{ id: string | null }>(
      "select public.finish_social_outbound($1, array['mid-auto-1'], 'Thanks for writing. A person will answer soon.') as id",
      [id],
    );
    expect(sent[0].id).not.toBeNull();
    const thread = await q<Record<string, unknown>>(
      amy,
      `select direction, kind, body, from_name, author_id, automatic, provider_message_id
       from public.messages where ticket_id = $1 order by created_at`,
      [m.ticket_id],
    );
    expect(thread[1]).toEqual({
      direction: "outbound",
      kind: "reply",
      body: "Thanks for writing. A person will answer soon.",
      from_name: "Automatic reply",
      author_id: null,
      automatic: true,
      provider_message_id: "mid-auto-1",
    });
    // Nothing about the conversation says a person has answered.
    expect(await ticket(m.ticket_id)).toEqual(before);
    expect(await queue(id!)).toMatchObject({ state: "sent", payload: {} });
    expect(await claims(m.message_id)).toEqual([{ state: "sent", error: null, variant: "usual" }]);
    // In the list it still reads as the customer's message waiting.
    const list = await q<{ preview: string; last_direction: string; message_count: number }>(
      amy,
      "select preview, last_direction, message_count from public.ticket_list_facts($1)",
      [[m.ticket_id]],
    );
    expect(list).toEqual([{ preview: "Hello there", last_direction: "inbound", message_count: 2 }]);
    // Meta's echo of our own send is the same message: not filed twice, and no status change.
    expect(
      (
        await service<{ r: { result: string } }>(
          "select public.file_social_echo($1, 'instagram', 'person-filed', 'mid-auto-1', 'Thanks for writing. A person will answer soon.', null, now()) as r",
          [tenantA],
        )
      )[0].r.result,
    ).toBe("duplicate");
    expect(await ticket(m.ticket_id)).toEqual(before);
    // It doesn't stop a person's answer, and that one does count.
    await q(
      amy,
      "select public.record_social_outbound($1, 'Hello, Amy here', array['mid-out-f1'])",
      [m.ticket_id],
    );
    const after = await ticket(m.ticket_id);
    expect(after.status).toBe("pending");
    expect(after.first_reply_at).not.toBeNull();
    expect(after.assignee_id).toBe(amy.id);
  });

  it("an echo that arrives while ours is going out waits its turn", async () => {
    const m = await dm(tenantA, "person-race");
    const { id } = await claim(tenantA, m.message_id);
    await due();
    const echo = () =>
      service<{ r: { result: string } }>(
        "select public.file_social_echo($1, 'instagram', 'person-race', 'mid-auto-race', 'Thanks', null, now()) as r",
        [tenantA],
      );
    expect((await echo())[0].r.result).toBe("retry");
    await service("select public.finish_social_outbound($1, array['mid-auto-race'], 'Thanks')", [
      id,
    ]);
    expect((await echo())[0].r.result).toBe("duplicate");
    expect((await ticket(m.ticket_id)).first_reply_at).toBeNull();
  });

  it("works for email, answered to whoever wrote", async () => {
    const m = await email("auto-a", "pat@example.test");
    expect(await facts(tenantA, m.message_id)).toMatchObject({
      channel: "email",
      ticket_kind: "message",
      direction: "inbound",
      message_kind: "reply",
      contact_name: "Pat Example",
      reply_to_email: "pat@example.test",
      business_name: "Auto A",
      time_zone: "America/New_York",
      team_answered_since: false,
      last_auto_reply_at: null,
    });
    const before = await ticket(m.ticket_id);
    const { id } = await claim(tenantA, m.message_id, {
      payload: { kind: "reply", to: ["pat@example.test"], cc: [], bcc: [], doc: [], then: "keep" },
    });
    await due();
    const sent = await service<{ id: string | null }>(
      "select public.finish_outbound($1, 'pm-auto-1', 'support-auto-a@inbound.example.test', 'Thanks for your email.') as id",
      [id],
    );
    const filed = await q<Record<string, unknown>>(
      amy,
      "select direction, from_email, from_name, to_emails, author_id, automatic, body from public.messages where id = $1",
      [sent[0].id],
    );
    expect(filed).toEqual([
      {
        direction: "outbound",
        from_email: "support-auto-a@inbound.example.test",
        from_name: "Automatic reply",
        to_emails: ["pat@example.test"],
        author_id: null,
        automatic: true,
        body: "Thanks for your email.",
      },
    ]);
    expect(await ticket(m.ticket_id)).toEqual(before);
    // The customer's next email within the day gets none.
    const next = await email("auto-a", "pat@example.test");
    expect(await claim(tenantA, next.message_id)).toEqual({ result: "quiet" });
    // A refused email is written down the same way.
    const other = await email("auto-a", "sam@example.test");
    const second = await claim(tenantA, other.message_id, {
      payload: { kind: "reply", to: ["sam@example.test"], doc: [], then: "keep" },
    });
    await due();
    await service(
      "select public.finish_outbound($1, null, null, null, '[]'::jsonb, 'postmark:422:406')",
      [second.id],
    );
    expect(await queue(second.id!)).toMatchObject({
      state: "failed",
      error: "postmark:422:406",
      payload: {},
    });
    expect(await claims(other.message_id)).toEqual([
      { state: "failed", error: "postmark:422:406", variant: "usual" },
    ]);
  });

  it("a person's own reply can't pass itself off as automatic, and still goes as theirs", async () => {
    const m = await dm(tenantA, "person-forge");
    const id = (
      await q<{ id: string }>(
        amy,
        "select public.queue_outbound($1, $2::jsonb, $3::jsonb, 1) as id",
        [
          m.ticket_id,
          JSON.stringify({ ...SOCIAL, then: "pending", automatic: true }),
          JSON.stringify({ kind: "social", automatic: true }),
        ],
      )
    )[0].id;
    const row = await db.query<{
      automatic: boolean;
      payload: object;
      summary: object;
      author_id: string;
    }>("select automatic, payload, summary, author_id from private.outbound_queue where id = $1", [
      id,
    ]);
    expect(row.rows[0].automatic).toBe(false);
    expect(row.rows[0].author_id).toBe(amy.id);
    expect(row.rows[0].payload).not.toHaveProperty("automatic");
    expect(row.rows[0].summary).not.toHaveProperty("automatic");
    await expect(
      db.query("update private.outbound_queue set automatic = true where id = $1", [id]),
    ).rejects.toThrow(/outbound_queue_author_shape/);
    await db.query(
      "update private.outbound_queue set send_at = now() - interval '1 second' where id = $1",
      [id],
    );
    await due();
    await service("select public.finish_social_outbound($1, array['mid-out-forge'], 'Mine')", [id]);
    const filed = await q<{ author_id: string; automatic: boolean }>(
      amy,
      "select author_id, automatic from public.messages where provider_message_id = 'mid-out-forge'",
    );
    expect(filed).toEqual([{ author_id: amy.id, automatic: false }]);
    expect((await ticket(m.ticket_id)).status).toBe("pending");
    // And a message can't be marked automatic with an author, or as the customer's.
    await expect(
      db.query(
        "update public.messages set automatic = true where provider_message_id = 'mid-out-forge'",
      ),
    ).rejects.toThrow(/messages_automatic_shape/);
    await expect(
      db.query("update public.messages set automatic = true where id = $1", [m.message_id]),
    ).rejects.toThrow(/messages_automatic_shape/);
  });

  it("an automatic reply waiting doesn't block a person, and a departed author rule doesn't touch it", async () => {
    const m = await dm(tenantA, "person-waiting");
    const { id } = await claim(tenantA, m.message_id);
    const rows = await due();
    // No author to have left: it is handed over, not failed as "author_left".
    expect(rows.map((r) => r.id)).toContain(id);
    expect((await queue(id!)).state).toBe("sending");
    await service("select public.finish_social_outbound($1, array['mid-auto-w'], 'Thanks')", [id]);
  });
});

describe("workspaces are kept apart", () => {
  it("a claim must name the workspace the message belongs to", async () => {
    const m = await dm(tenantA, "person-apart");
    expect(await claim(tenantB, m.message_id)).toEqual({ result: "unknown" });
    expect(
      await service("select * from public.auto_reply_facts($1, $2)", [tenantB, m.message_id]),
    ).toEqual([]);
    expect(await claims(m.message_id)).toEqual([]);
    expect((await claim(tenantA, m.message_id)).result).toBe("queued");
  });

  it("the quiet period never crosses workspaces", async () => {
    // The same person id writes to both businesses.
    const a = await dm(tenantA, "person-both");
    const b = await dm(tenantB, "person-both");
    expect((await claim(tenantA, a.message_id)).result).toBe("queued");
    expect((await facts(tenantB, b.message_id)).last_auto_reply_at).toBeNull();
    expect((await claim(tenantB, b.message_id)).result).toBe("queued");
  });

  it("another workspace's member sees neither the reply nor its notice", async () => {
    const m = await dm(tenantA, "person-private");
    const { id } = await claim(tenantA, m.message_id);
    expect(await q(bob, "select id from public.ticket_outbox($1)", [m.ticket_id])).toEqual([]);
    expect(await q<{ ok: boolean }>(bob, "select public.cancel_outbound($1) as ok", [id])).toEqual([
      { ok: false },
    ]);
    await due();
    await service("select public.finish_social_outbound($1, array['mid-auto-p'], 'Thanks')", [id]);
    expect(
      await q(bob, "select id from public.messages where ticket_id = $1", [m.ticket_id]),
    ).toEqual([]);
    expect(
      (
        await q<{ id: string }>(amy, "select id from public.messages where ticket_id = $1", [
          m.ticket_id,
        ])
      ).length,
    ).toBe(2);
  });

  it("nobody but the worker can read the claims or take one", async () => {
    const m = await dm(tenantA, "person-locked");
    for (const who of [alice, amy, bob]) {
      await expect(q(who, "select * from private.auto_replies")).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        q(who, "select public.claim_auto_reply($1, $2, 'usual', '{}'::jsonb, '{}'::jsonb, 24)", [
          tenantA,
          m.message_id,
        ]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        q(who, "select * from public.auto_reply_facts($1, $2)", [tenantA, m.message_id]),
      ).rejects.toThrow(/permission denied/);
    }
    await expect(
      asAnon(db, (tx) =>
        tx.query("select * from public.auto_reply_facts($1, $2)", [tenantA, m.message_id]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(service("select * from private.auto_replies")).rejects.toThrow(
      /permission denied/,
    );
    const rls = await db.query<{ on: boolean }>(
      "select relrowsecurity as on from pg_class where oid = 'private.auto_replies'::regclass",
    );
    expect(rls.rows[0].on).toBe(true);
  });

  it("the claim goes when the person is forgotten", async () => {
    const m = await dm(tenantA, "person-forgotten");
    await claim(tenantA, m.message_id);
    await q(alice, "select public.forget_social_person($1)", [m.contact_id]);
    expect(await claims(m.message_id)).toEqual([]);
    const left = await db.query<{ c: number }>(
      "select count(*)::int as c from private.outbound_queue where ticket_id = $1",
      [m.ticket_id],
    );
    expect(left.rows[0].c).toBe(0);
  });
});
