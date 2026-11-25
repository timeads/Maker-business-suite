import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };
type Filed = { result: string; tenant_id: string; ticket_id: string; message_id: string };

let db: PGlite;
let alice: User; // owner of A
let amy: User; // member of A
let bob: User; // owner of B
let tenantA: string;
let tenantB: string;
let slugA: string;
let slugB: string;
let n = 0;

const q = <T>(who: User, sql: string, params: unknown[] = []) =>
  asUser(db, who, async (tx) => (await tx.query<T>(sql, params)).rows);
const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
const fails = async (run: Promise<unknown>, pattern: RegExp) =>
  expect(run.then(() => "ok").catch((err: Error) => err.message)).resolves.toMatch(pattern);

const body = (text: string) => JSON.stringify([{ t: "p", runs: [{ text }] }]);

/** A conversation from a customer, with files on its first message. Returns the ids. */
async function conversation(
  slug: string,
  tenant: string,
  from: string,
  files: { name: string; type: string }[],
) {
  n += 1;
  const [{ r }] = await service<{ r: Filed }>(
    "select public.file_inbound_email($1, $2, $3, null, $4, 'Hello', $5, null, '{}') as r",
    [slug, `media-${n}`, from, `Question ${n}`, `<media-${n}@mail.test>`],
  );
  if (files.length > 0) {
    await service("select public.record_message_attachments($1, $2, $3::jsonb)", [
      tenant,
      r.message_id,
      JSON.stringify(
        files.map((file, i) => ({
          name: file.name,
          type: file.type,
          size: 1000,
          path: `${tenant}/t/${r.message_id}/${n}-${i}`,
          content_id: null,
          state: "kept",
        })),
      ),
    ]);
  }
  const attachments = (
    await db.query<{ id: string; name: string }>(
      "select id, name from public.message_attachments where message_id = $1 order by name",
      [r.message_id],
    )
  ).rows;
  return { ticket: r.ticket_id, message: r.message_id, files: attachments };
}

async function claimedRun(tenant: string): Promise<string> {
  await db.query("delete from public.manual_runs where tenant_id = $1", [tenant]);
  const { rows } = await db.query<{ id: string }>(
    "insert into public.manual_runs (tenant_id, source, status, started_at) values ($1, 'manual', 'running', now()) returning id",
    [tenant],
  );
  return rows[0].id;
}
const apply = async (run: string, ticketId: string, plan: object) =>
  (
    await service<{ r: string }>("select public.apply_manual_reading($1, $2, $3) as r", [
      run,
      ticketId,
      JSON.stringify(plan),
    ])
  )[0].r;

type Media = {
  id: string;
  topic_id: string;
  attachment_id: string;
  kind: string;
  state: string;
  caption: string;
  suggested: boolean;
  position: number;
};
const mediaOf = (who: User, topic: string) =>
  q<Media>(
    who,
    "select id, topic_id, attachment_id, kind, state, caption, suggested, position from public.manual_topic_media where topic_id = $1 order by position, created_at",
    [topic],
  );
const casesOf = (who: User, topic: string) =>
  q<{ ticket_id: string; summary: string; outcome: string }>(
    who,
    "select ticket_id, summary, outcome from public.manual_topic_cases where topic_id = $1 order by created_at",
    [topic],
  );
const topicId = async (tenant: string, title: string) =>
  (
    await db.query<{ id: string }>(
      "select id from public.manual_topics where tenant_id = $1 and title = $2",
      [tenant, title],
    )
  ).rows[0].id;

const PHOTO = { name: "a-photo.jpg", type: "image/jpeg" };
const SECOND = { name: "b-photo.png", type: "image/png" };
const VIDEO = { name: "c-clip.mp4", type: "video/mp4" };
const PDF = { name: "d-receipt.pdf", type: "application/pdf" };

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  amy = { id: await createUser(db, "amy@a.test"), email: "amy@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  const tenantFor = async (owner: User, name: string) =>
    (
      await q<{ id: string; slug: string }>(
        owner,
        "select id, slug from public.create_tenant($1, 'UTC', 'USD')",
        [name],
      )
    )[0];
  ({ id: tenantA, slug: slugA } = await tenantFor(alice, "Media A"));
  ({ id: tenantB, slug: slugB } = await tenantFor(bob, "Media B"));
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, amy.id],
  );
});

describe("who can reach what", () => {
  it("neither table can be written directly, nor read by a visitor", async () => {
    for (const table of ["manual_topic_media", "manual_topic_cases"]) {
      const { rows } = await db.query<{ can: boolean }>(
        `select has_table_privilege('authenticated', 'public.${table}', 'insert')
             or has_table_privilege('authenticated', 'public.${table}', 'update')
             or has_table_privilege('authenticated', 'public.${table}', 'delete')
             or has_table_privilege('anon', 'public.${table}', 'select') as can`,
      );
      expect(rows[0].can, table).toBe(false);
    }
    await fails(
      asAnon(db, (tx) =>
        tx.query("select public.set_manual_topic_media($1, $1, 'kept', null)", [tenantA]),
      ),
      /permission denied/,
    );
  });
});

describe("a reading files the case line and offers the customer's pictures and videos", () => {
  let topic: string;
  let first: Awaited<ReturnType<typeof conversation>>;

  it("candidates are the customer's kept pictures and videos of that conversation, nothing else", async () => {
    first = await conversation(slugA, tenantA, "pat@example.test", [PHOTO, SECOND, VIDEO, PDF]);
    const other = await conversation(slugA, tenantA, "sam@example.test", [PHOTO]);
    const theirs = await conversation(slugB, tenantB, "kit@example.test", [PHOTO]);
    // A file the team sent in the same conversation is not the customer's.
    const { rows: out } = await db.query<{ id: string }>(
      "insert into public.messages (tenant_id, ticket_id, direction, from_email, body) values ($1, $2, 'outbound', 'us@a.test', 'Here you go') returning id",
      [tenantA, first.ticket],
    );
    await service("select public.record_message_attachments($1, $2, $3::jsonb)", [
      tenantA,
      out[0].id,
      JSON.stringify([
        {
          name: "ours.jpg",
          type: "image/jpeg",
          size: 10,
          path: `${tenantA}/t/${out[0].id}/ours`,
          content_id: null,
          state: "kept",
        },
      ]),
    ]);
    const ours = (
      await db.query<{ id: string }>(
        "select id from public.message_attachments where message_id = $1",
        [out[0].id],
      )
    ).rows[0].id;
    const [photo, second, video, pdf] = first.files;

    const run = await claimedRun(tenantA);
    expect(
      await apply(run, first.ticket, {
        kind: "new",
        title: "Lid rattles",
        summary: "",
        body: [{ t: "p", runs: [{ text: "Tighten the knob." }] }],
        facets: [],
        case: { summary: " The lid rattled; the knob was loose. ", outcome: "Fixed by hand" },
        media: [
          { attachment_id: photo.id, suggested: true, caption: "The loose knob from above" },
          { attachment_id: second.id, suggested: false, caption: "ignored" },
          // A video never arrives suggested or captioned, whatever the list says.
          { attachment_id: video.id, suggested: true, caption: "A clip" },
          { attachment_id: pdf.id },
          { attachment_id: ours },
          { attachment_id: other.files[0].id },
          { attachment_id: theirs.files[0].id },
          { attachment_id: "not-an-id" },
          "nonsense",
        ],
      }),
    ).toBe("new");
    topic = await topicId(tenantA, "Lid rattles");

    expect(await casesOf(amy, topic)).toEqual([
      {
        ticket_id: first.ticket,
        summary: "The lid rattled; the knob was loose.",
        outcome: "Fixed by hand",
      },
    ]);
    const media = await mediaOf(amy, topic);
    expect(media.map((m) => [m.attachment_id, m.kind, m.state, m.suggested, m.caption])).toEqual([
      [photo.id, "image", "candidate", true, "The loose knob from above"],
      [second.id, "image", "candidate", false, ""],
      [video.id, "video", "candidate", false, ""],
    ]);
  });

  it("another workspace sees none of it and can change none of it", async () => {
    expect(await mediaOf(bob, topic)).toEqual([]);
    expect(await casesOf(bob, topic)).toEqual([]);
    const [one] = await mediaOf(alice, topic);
    await fails(
      q(bob, "select public.set_manual_topic_media($1, $2, 'kept', null)", [tenantB, one.id]),
      /not_found/,
    );
    await fails(
      q(bob, "select public.set_manual_topic_media($1, $2, 'kept', null)", [tenantA, one.id]),
      /Workspace not found/,
    );
    await fails(
      q(bob, "select public.order_manual_topic_media($1, $2, $3)", [tenantA, topic, [one.id]]),
      /Workspace not found/,
    );
    await q(bob, "select public.order_manual_topic_media($1, $2, $3)", [tenantB, topic, [one.id]]);
    expect((await mediaOf(alice, topic))[0].position).toBe(one.position);
  });

  it("anyone on the team keeps, captions, orders and removes; a person's choice is theirs", async () => {
    const [photo, second, video] = await mediaOf(amy, topic);
    await q(amy, "select public.set_manual_topic_media($1, $2, 'kept', null)", [tenantA, photo.id]);
    await q(amy, "select public.set_manual_topic_media($1, $2, 'kept', $3)", [
      tenantA,
      video.id,
      "  How it <b>sounds</b>\nwhen shaken ",
    ]);
    await q(amy, "select public.set_manual_topic_media($1, $2, 'dismissed', null)", [
      tenantA,
      second.id,
    ]);
    await fails(
      q(amy, "select public.set_manual_topic_media($1, $2, 'candidate', null)", [
        tenantA,
        second.id,
      ]),
      /bad_state/,
    );
    let rows = await mediaOf(amy, topic);
    const by = (id: string) => rows.find((m) => m.id === id)!;
    // Kept: no longer "suggested", the proposed caption stays until someone rewrites it.
    expect(by(photo.id)).toMatchObject({
      state: "kept",
      suggested: false,
      caption: "The loose knob from above",
      position: 1,
    });
    expect(by(video.id)).toMatchObject({
      state: "kept",
      caption: "How it <b>sounds</b> when shaken",
      position: 2,
    });
    expect(by(second.id).state).toBe("dismissed");

    await q(amy, "select public.order_manual_topic_media($1, $2, $3)", [
      tenantA,
      topic,
      [video.id, photo.id, second.id],
    ]);
    rows = await mediaOf(amy, topic);
    expect(rows.filter((m) => m.state === "kept").map((m) => m.id)).toEqual([video.id, photo.id]);
    await q(amy, "select public.set_manual_topic_media($1, $2, null, 'Knob, seen from above')", [
      tenantA,
      photo.id,
    ]);
    expect((await mediaOf(amy, topic)).find((m) => m.id === photo.id)?.caption).toBe(
      "Knob, seen from above",
    );
  });

  it("reading the conversation again changes the case line and nothing a person decided", async () => {
    const run = await claimedRun(tenantA);
    expect(
      await apply(run, first.ticket, {
        kind: "seen",
        topic_id: topic,
        case: { summary: "The knob had worked loose.", outcome: "Fixed" },
        media: first.files.map((f) => ({
          attachment_id: f.id,
          suggested: true,
          caption: "A new guess",
        })),
      }),
    ).toBe("seen");
    expect(await casesOf(amy, topic)).toEqual([
      { ticket_id: first.ticket, summary: "The knob had worked loose.", outcome: "Fixed" },
    ]);
    const rows = await mediaOf(amy, topic);
    expect(rows.map((m) => m.state).sort()).toEqual(["dismissed", "kept", "kept"]);
    expect(rows.map((m) => m.caption)).not.toContain("A new guess");
  });

  it("read again under another topic, the case line and unpicked candidates move; kept ones stay", async () => {
    const again = await conversation(slugA, tenantA, "lee@example.test", [PHOTO, SECOND]);
    let run = await claimedRun(tenantA);
    await apply(run, again.ticket, {
      kind: "seen",
      topic_id: topic,
      case: { summary: "Another loose knob.", outcome: "" },
      media: again.files.map((f) => ({ attachment_id: f.id })),
    });
    const offered = (await mediaOf(amy, topic)).filter((m) => m.state === "candidate");
    expect(offered).toHaveLength(2);
    await q(amy, "select public.set_manual_topic_media($1, $2, 'kept', null)", [
      tenantA,
      offered[0].id,
    ]);
    run = await claimedRun(tenantA);
    await apply(run, again.ticket, {
      kind: "new",
      title: "Knob thread stripped",
      summary: "",
      body: [{ t: "p", runs: [{ text: "Replace the knob." }] }],
      facets: [],
      case: { summary: "The thread was stripped.", outcome: "Sent a new knob" },
      media: again.files.map((f) => ({ attachment_id: f.id })),
    });
    const moved = await topicId(tenantA, "Knob thread stripped");
    expect((await casesOf(amy, topic)).map((c) => c.ticket_id)).toEqual([first.ticket]);
    expect((await casesOf(amy, moved)).map((c) => c.ticket_id)).toEqual([again.ticket]);
    // The one a person kept is still on the first topic; both are offered on the new one.
    expect(
      (await mediaOf(amy, topic)).filter((m) => m.attachment_id === offered[0].attachment_id),
    ).toHaveLength(1);
    expect(
      (await mediaOf(amy, topic)).filter((m) => m.attachment_id === offered[1].attachment_id),
    ).toHaveLength(0);
    expect(await mediaOf(amy, moved)).toHaveLength(2);
  });

  it("for a topic a person has edited, the case line and candidates wait with the suggestion", async () => {
    const [{ id: mine }] = await q<{ id: string }>(
      amy,
      "select public.save_manual_topic($1, null, 'Handle loose', '', $2, '[]') as id",
      [tenantA, body("Tighten it.")],
    );
    const talk = await conversation(slugA, tenantA, "ray@example.test", [PHOTO]);
    const run = await claimedRun(tenantA);
    const plan = (ticketId: string, attachment: string) => ({
      kind: "suggest",
      topic_id: mine,
      additions: [{ section: "What to do", points: ["Use the long screw"] }],
      new_facets: [],
      case: { summary: "The handle came loose.", outcome: "Sent a screw" },
      media: [{ attachment_id: attachment, suggested: true, caption: "The handle" }],
    });
    expect(await apply(run, talk.ticket, plan(talk.ticket, talk.files[0].id))).toBe("suggested");
    expect(await casesOf(amy, mine)).toEqual([]);
    expect(await mediaOf(amy, mine)).toEqual([]);

    const [{ id: suggestion }] = await q<{ id: string }>(
      amy,
      "select id from public.manual_suggestions where topic_id = $1 and status = 'pending'",
      [mine],
    );
    await q(amy, "select public.decide_manual_suggestion($1, $2, true, $3, '[]')", [
      tenantA,
      suggestion,
      body("Tighten it. Use the long screw."),
    ]);
    expect((await casesOf(amy, mine)).map((c) => c.summary)).toEqual(["The handle came loose."]);
    expect((await mediaOf(amy, mine)).map((m) => [m.state, m.suggested, m.caption])).toEqual([
      ["candidate", true, "The handle"],
    ]);

    // Dismissed, nothing is filed.
    const quiet = await conversation(slugA, tenantA, "jo@example.test", [PHOTO]);
    const run2 = await claimedRun(tenantA);
    await apply(run2, quiet.ticket, plan(quiet.ticket, quiet.files[0].id));
    const [{ id: second }] = await q<{ id: string }>(
      amy,
      "select id from public.manual_suggestions where topic_id = $1 and status = 'pending'",
      [mine],
    );
    await q(amy, "select public.decide_manual_suggestion($1, $2, false)", [tenantA, second]);
    expect(await casesOf(amy, mine)).toHaveLength(1);
    expect(await mediaOf(amy, mine)).toHaveLength(1);
  });

  it("when the file's row goes, the topic's entry goes with it", async () => {
    const before = await mediaOf(amy, topic);
    const kept = before.filter((m) => m.state === "kept");
    expect(kept.length).toBeGreaterThanOrEqual(2);

    // A conversation deleted for good.
    await q(alice, "select public.shelve_ticket($1, 'trash')", [first.ticket]);
    await q(alice, "select public.delete_ticket_for_good($1)", [first.ticket]);
    const after = await mediaOf(amy, topic);
    const gone = new Set(first.files.map((f) => f.id));
    expect(after.some((m) => gone.has(m.attachment_id))).toBe(false);
    expect(await casesOf(amy, topic)).toEqual([]);
    // The topic itself is still there, with what is left.
    expect(
      (await q(alice, "select 1 from public.manual_topics where id = $1", [topic])).length,
    ).toBe(1);

    // A customer forgotten: the shop's privacy request for their email.
    const left = after.filter((m) => m.state === "kept");
    expect(left).toHaveLength(1);
    await service("select public.redact_customer($1, 'shopify', 'none', 'lee@example.test')", [
      tenantA,
    ]);
    expect(await mediaOf(amy, topic)).toEqual([]);
    const stripped = await topicId(tenantA, "Knob thread stripped");
    expect(await mediaOf(amy, stripped)).toEqual([]);
    expect(await casesOf(amy, stripped)).toEqual([]);

    // One file's row removed on its own.
    const solo = await conversation(slugA, tenantA, "max@example.test", [PHOTO]);
    const run = await claimedRun(tenantA);
    await apply(run, solo.ticket, {
      kind: "seen",
      topic_id: topic,
      case: { summary: "Loose again.", outcome: "" },
      media: [{ attachment_id: solo.files[0].id }],
    });
    expect(await mediaOf(amy, topic)).toHaveLength(1);
    await db.query("delete from public.message_attachments where id = $1", [solo.files[0].id]);
    expect(await mediaOf(amy, topic)).toEqual([]);
    expect(await casesOf(amy, topic)).toHaveLength(1);
  });
});

describe("joining two topics and copying one", () => {
  const write = async (who: User, title: string, text: string) =>
    (
      await q<{ id: string }>(
        who,
        "select public.save_manual_topic($1, null, $2, '', $3, '[]') as id",
        [tenantA, title, body(text)],
      )
    )[0].id;

  it("a join keeps both histories, the conversations, case lines and media; only a manager joins", async () => {
    const from = await write(amy, "Frame wobbles", "Check the feet.");
    const into = await write(amy, "Frame rocks", "Level the table.");
    const one = await conversation(slugA, tenantA, "ann@example.test", [PHOTO, VIDEO]);
    const two = await conversation(slugA, tenantA, "ben@example.test", [PHOTO]);
    for (const [topic, talk, summary] of [
      [from, one, "Wobbled on carpet."],
      [into, two, "Rocked on a slope."],
    ] as const) {
      const run = await claimedRun(tenantA);
      await apply(run, talk.ticket, {
        kind: "seen",
        topic_id: topic,
        case: { summary, outcome: "" },
        media: talk.files.map((f) => ({ attachment_id: f.id })),
      });
    }
    const [photo] = await mediaOf(amy, from);
    await q(amy, "select public.set_manual_topic_media($1, $2, 'kept', 'On carpet')", [
      tenantA,
      photo.id,
    ]);
    const historyBefore = (
      await q(alice, "select 1 from public.manual_topic_revisions where topic_id in ($1, $2)", [
        from,
        into,
      ])
    ).length;

    const joined = body("Level the table. Check the feet.");
    await fails(
      q(amy, "select public.merge_manual_topics($1, $2, $3, $4, '[]')", [
        tenantA,
        from,
        into,
        joined,
      ]),
      /Only owners and admins/,
    );
    await fails(
      q(alice, "select public.merge_manual_topics($1, $2, $2, $3, '[]')", [tenantA, into, joined]),
      /same_topic/,
    );
    await fails(
      q(bob, "select public.merge_manual_topics($1, $2, $3, $4, '[]')", [
        tenantB,
        from,
        into,
        joined,
      ]),
      /not_found/,
    );
    await q(alice, "select public.merge_manual_topics($1, $2, $3, $4, $5)", [
      tenantA,
      from,
      into,
      joined,
      JSON.stringify([{ facet: "product", value: "Frame" }]),
    ]);

    expect(await q(alice, "select 1 from public.manual_topics where id = $1", [from])).toEqual([]);
    const [row] = await q<{ body: { runs: { text: string }[] }[]; person_edited_at: string }>(
      alice,
      "select body, person_edited_at from public.manual_topics where id = $1",
      [into],
    );
    expect(row.body[0].runs[0].text).toBe("Level the table. Check the feet.");
    expect((await casesOf(amy, into)).map((c) => c.summary).sort()).toEqual([
      "Rocked on a slope.",
      "Wobbled on carpet.",
    ]);
    const media = await mediaOf(amy, into);
    expect(media).toHaveLength(3);
    expect(media.find((m) => m.id === photo.id)).toMatchObject({
      state: "kept",
      caption: "On carpet",
    });
    expect(
      (await q(alice, "select 1 from public.manual_topic_sources where topic_id = $1", [into]))
        .length,
    ).toBe(2);
    const history = await q<{ cause: string }>(
      alice,
      "select cause from public.manual_topic_revisions where topic_id = $1",
      [into],
    );
    expect(history).toHaveLength(historyBefore + 1);
    expect(history.map((h) => h.cause)).toContain("joined");
  });

  it("a copy is a new draft under other labels, with no conversations, cases, media or history", async () => {
    const source = await topicId(tenantA, "Frame rocks");
    const [{ id: copy }] = await q<{ id: string }>(
      amy,
      "select public.copy_manual_topic($1, $2, ' Frame rocks (floor frame) ', $3) as id",
      [tenantA, source, JSON.stringify([{ facet: "product", value: "Floor frame" }])],
    );
    const [row] = await q<{
      title: string;
      status: string;
      source: string;
      person_edited_at: string | null;
      facets: unknown;
      body: unknown;
    }>(alice, "select * from public.manual_topics where id = $1", [copy]);
    const [original] = await q<{ body: unknown }>(
      alice,
      "select body from public.manual_topics where id = $1",
      [source],
    );
    expect(row).toMatchObject({
      title: "Frame rocks (floor frame)",
      status: "draft",
      source: "person",
      facets: [{ facet: "product", value: "Floor frame" }],
    });
    expect(row.person_edited_at).not.toBeNull();
    expect(row.body).toEqual(original.body);
    expect(await mediaOf(amy, copy)).toEqual([]);
    expect(await casesOf(amy, copy)).toEqual([]);
    expect(
      await q(alice, "select 1 from public.manual_topic_sources where topic_id = $1", [copy]),
    ).toEqual([]);
    expect(
      (
        await q<{ cause: string }>(
          alice,
          "select cause from public.manual_topic_revisions where topic_id = $1",
          [copy],
        )
      ).map((r) => r.cause),
    ).toEqual(["copied"]);
    await fails(
      q(bob, "select public.copy_manual_topic($1, $2, 'x', '[]')", [tenantB, source]),
      /not_found/,
    );
  });
});
