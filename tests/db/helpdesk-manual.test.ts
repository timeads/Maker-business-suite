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

const TABLES = [
  "manual_topics",
  "manual_topic_sources",
  "manual_topic_revisions",
  "manual_suggestions",
  "manual_runs",
  "manual_reads",
  "manual_articles",
];

const q = <T>(who: User, sql: string, params: unknown[] = []) =>
  asUser(db, who, async (tx) => (await tx.query<T>(sql, params)).rows);
const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
const fails = async (run: Promise<unknown>, pattern: RegExp) =>
  expect(run.then(() => "ok").catch((err: Error) => err.message)).resolves.toMatch(pattern);

async function ticket(slug: string): Promise<string> {
  n += 1;
  const rows = await service<{ r: { ticket_id: string } }>(
    "select public.file_inbound_email($1, $2, 'pat@example.test', null, $3, 'Hello', $4, null, '{}') as r",
    [slug, `manual-${n}`, `Question ${n}`, `<manual-${n}@mail.test>`],
  );
  return rows[0].r.ticket_id;
}

const body = (text: string) => JSON.stringify([{ t: "p", runs: [{ text }] }]);
const topicRow = async (id: string) =>
  (
    await q<{
      title: string;
      summary: string;
      body: { runs: { text: string }[] }[];
      status: string;
      source: string;
      person_edited_at: string | null;
      use_in_drafts: boolean;
    }>(alice, "select * from public.manual_topics where id = $1", [id])
  )[0];

/** A run the worker has claimed, as the worker would have it. */
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
  tenantA = await tenantFor(alice, "Manual A");
  tenantB = await tenantFor(bob, "Manual B");
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, amy.id],
  );
});

describe("who can do what", () => {
  it("no table can be written directly, by anyone signed in", async () => {
    for (const table of TABLES) {
      const { rows } = await db.query<{ can: boolean }>(
        `select has_table_privilege('authenticated', 'public.${table}', 'insert')
             or has_table_privilege('authenticated', 'public.${table}', 'update')
             or has_table_privilege('authenticated', 'public.${table}', 'delete')
             or has_table_privilege('anon', 'public.${table}', 'select') as can`,
      );
      expect(rows[0].can, table).toBe(false);
    }
  });

  it("the worker's functions can't be called by a member, and none by a visitor", async () => {
    await fails(q(alice, "select * from public.claim_manual_runs(2)"), /permission denied/);
    await fails(
      q(alice, "select public.apply_manual_reading($1, $1, '{}')", [tenantA]),
      /permission denied/,
    );
    await fails(
      asAnon(db, (tx) =>
        tx.query("select public.save_manual_topic($1, null, 'x', '', '[]', '[]')", [tenantA]),
      ),
      /permission denied/,
    );
  });

  it("anyone on the team writes and edits; only a manager publishes or deletes", async () => {
    const [{ id }] = await q<{ id: string }>(
      amy,
      "select public.save_manual_topic($1, null, ' Lid rattles ', 'Short', $2, '[]') as id",
      [tenantA, body("Tighten the knob.")],
    );
    expect(await topicRow(id)).toMatchObject({
      title: "Lid rattles",
      status: "draft",
      source: "person",
      use_in_drafts: true,
    });
    expect((await topicRow(id)).person_edited_at).not.toBeNull();
    await fails(
      q(amy, "select public.set_manual_topic_state($1, $2, 'published', null)", [tenantA, id]),
      /Only owners and admins/,
    );
    await fails(
      q(amy, "select public.delete_manual_topic($1, $2)", [tenantA, id]),
      /Only owners and admins/,
    );
    await q(alice, "select public.set_manual_topic_state($1, $2, 'published', false)", [
      tenantA,
      id,
    ]);
    expect(await topicRow(id)).toMatchObject({ status: "published", use_in_drafts: false });
    await q(amy, "select public.save_manual_topic($1, $2, 'Lid rattles', 'Longer', $3, '[]')", [
      tenantA,
      id,
      body("Tighten the knob a quarter turn."),
    ]);
    // An edit doesn't unpublish.
    expect(await topicRow(id)).toMatchObject({ status: "published", summary: "Longer" });
    const history = await q<{ cause: string; actor_id: string | null }>(
      alice,
      "select cause, actor_id from public.manual_topic_revisions where topic_id = $1 order by created_at, cause",
      [id],
    );
    expect(history.map((h) => h.cause).sort()).toEqual(["edited", "published", "written"]);
    expect(history.every((h) => h.actor_id !== null)).toBe(true);
    await q(alice, "select public.delete_manual_topic($1, $2)", [tenantA, id]);
    expect(await topicRow(id)).toBeUndefined();
  });

  it("refuses a topic with no title or a body that isn't a document", async () => {
    await fails(
      q(amy, "select public.save_manual_topic($1, null, '  ', '', '[]', '[]')", [tenantA]),
      /no_title/,
    );
    await fails(
      q(amy, "select public.save_manual_topic($1, null, 'T', '', '{}', '[]')", [tenantA]),
      /bad_body/,
    );
  });
});

describe("another workspace", () => {
  it("sees none of it and can change none of it", async () => {
    const t = await ticket("manual-a");
    const [{ id: topic }] = await q<{ id: string }>(
      alice,
      "select public.save_manual_topic($1, null, 'Ours', '', $2, '[]') as id",
      [tenantA, body("Ours.")],
    );
    const [{ id: article }] = await q<{ id: string }>(
      alice,
      "select public.save_manual_article($1, null, 'Our article', $2, array['care'], false) as id",
      [tenantA, body("Ours.")],
    );
    const run = await claimedRun(tenantA);
    await q(alice, "select public.set_manual_topic_state($1, $2, 'published', null)", [
      tenantA,
      topic,
    ]);
    await apply(run, t, {
      kind: "suggest",
      topic_id: topic,
      additions: [{ section: "Notes", points: ["x"] }],
    });
    await apply(run, t, { kind: "seen", topic_id: topic });

    for (const table of TABLES) {
      const mine = await q<{ n: number }>(alice, `select count(*)::int as n from public.${table}`);
      const theirs = await q<{ n: number }>(bob, `select count(*)::int as n from public.${table}`);
      expect(mine[0].n, `${table} has rows for its own workspace`).toBeGreaterThan(0);
      expect(theirs[0].n, `${table} leaks`).toBe(0);
    }

    // Bob can't write into A by naming it, nor reach A's rows by naming his own workspace.
    await fails(
      q(bob, "select public.save_manual_topic($1, null, 'Theirs', '', '[]', '[]')", [tenantA]),
      /Workspace not found/,
    );
    await fails(
      q(bob, "select public.save_manual_topic($1, $2, 'Theirs', '', '[]', '[]')", [tenantB, topic]),
      /not_found/,
    );
    await fails(q(bob, "select public.delete_manual_topic($1, $2)", [tenantB, topic]), /not_found/);
    await fails(
      q(bob, "select public.set_manual_topic_state($1, $2, 'draft', null)", [tenantB, topic]),
      /not_found/,
    );
    await fails(
      q(bob, "select public.save_manual_article($1, $2, 'Theirs', '[]', '{}', true)", [
        tenantB,
        article,
      ]),
      /not_found/,
    );
    await fails(
      q(bob, "select public.delete_manual_article($1, $2)", [tenantB, article]),
      /not_found/,
    );
    const [{ id: suggestion }] = await q<{ id: string }>(
      alice,
      "select id from public.manual_suggestions limit 1",
    );
    await fails(
      q(bob, "select public.decide_manual_suggestion($1, $2, false)", [tenantB, suggestion]),
      /not_found/,
    );
    await fails(q(bob, "select public.request_manual_run($1, $2)", [tenantB, t]), /not_found/);
    await fails(
      q(bob, "select public.request_manual_run($1)", [tenantA]),
      /Only owners and admins/,
    );
    expect((await topicRow(topic)).title).toBe("Ours");

    // The worker can't file a reading of one workspace's conversation under another's run.
    const runB = await claimedRun(tenantB);
    await fails(apply(runB, t, { kind: "new", title: "Leak", body: [], facets: [] }), /not_found/);
    // ...nor add to another workspace's topic.
    const tb = await ticket("manual-b");
    expect(
      await apply(runB, tb, {
        kind: "update",
        topic_id: topic,
        summary: "x",
        body: [],
        facets: [],
      }),
    ).toBe("nothing");
    expect((await topicRow(topic)).title).toBe("Ours");
  });
});

describe("readings", () => {
  it("writes a new topic as a draft by Claude, linked to its conversation", async () => {
    const t = await ticket("manual-a");
    const run = await claimedRun(tenantA);
    const result = await apply(run, t, {
      kind: "new",
      title: "Handle comes loose",
      summary: "The handle works free.",
      body: [{ t: "p", runs: [{ text: "What to do", b: true }] }],
      facets: [{ facet: "product", value: "Kettle" }],
    });
    expect(result).toBe("new");
    const [topic] = await q<{
      id: string;
      status: string;
      source: string;
      person_edited_at: string | null;
    }>(
      alice,
      "select t.* from public.manual_topics t join public.manual_topic_sources s on s.topic_id = t.id where s.ticket_id = $1",
      [t],
    );
    expect(topic).toMatchObject({ status: "draft", source: "ai", person_edited_at: null });
    const [read] = await q<{ result: string }>(
      alice,
      "select result from public.manual_reads where ticket_id = $1",
      [t],
    );
    expect(read.result).toBe("new");
    const [rev] = await q<{ cause: string; actor_id: string | null }>(
      alice,
      "select cause, actor_id from public.manual_topic_revisions where topic_id = $1",
      [topic.id],
    );
    expect(rev).toEqual({ cause: "ai_written", actor_id: null });
  });

  it("adds to a topic nobody has edited, in place, with a revision", async () => {
    const run = await claimedRun(tenantA);
    const first = await ticket("manual-a");
    await apply(run, first, {
      kind: "new",
      title: "Spout drips",
      summary: "",
      body: JSON.parse(body("One.")),
      facets: [],
    });
    const [{ topic_id: topic }] = await q<{ topic_id: string }>(
      alice,
      "select topic_id from public.manual_topic_sources where ticket_id = $1",
      [first],
    );
    const second = await ticket("manual-a");
    expect(
      await apply(run, second, {
        kind: "update",
        topic_id: topic,
        summary: "Drips after pouring.",
        body: JSON.parse(body("One. Two.")),
        facets: [],
        additions: [{ section: "Notes", points: ["Two."] }],
      }),
    ).toBe("updated");
    const row = await topicRow(topic);
    expect(row.body[0].runs[0].text).toBe("One. Two.");
    expect(row.person_edited_at).toBeNull();
    const sources = await q(
      alice,
      "select 1 from public.manual_topic_sources where topic_id = $1",
      [topic],
    );
    expect(sources).toHaveLength(2);
    const causes = await q<{ cause: string }>(
      alice,
      "select cause from public.manual_topic_revisions where topic_id = $1 order by created_at, cause",
      [topic],
    );
    expect(causes.map((c) => c.cause).sort()).toEqual(["ai_added", "ai_written"]);
  });

  it("never overwrites a person's edit, even when the worker asks for an update", async () => {
    const run = await claimedRun(tenantA);
    const first = await ticket("manual-a");
    await apply(run, first, {
      kind: "new",
      title: "Knob sticks",
      summary: "",
      body: JSON.parse(body("By Claude.")),
      facets: [],
    });
    const [{ topic_id: topic }] = await q<{ topic_id: string }>(
      alice,
      "select topic_id from public.manual_topic_sources where ticket_id = $1",
      [first],
    );
    // A teammate rewrites it while a reading is underway.
    await q(amy, "select public.save_manual_topic($1, $2, 'Knob sticks', 'Ours', $3, '[]')", [
      tenantA,
      topic,
      body("In our own words."),
    ]);
    const second = await ticket("manual-a");
    const result = await apply(run, second, {
      kind: "update",
      topic_id: topic,
      summary: "Claude's summary",
      body: JSON.parse(body("By Claude, rewritten.")),
      facets: [{ facet: "product", value: "Kettle" }],
      additions: [{ section: "What to do", points: ["Oil the knob"] }],
      new_facets: [{ facet: "product", value: "Kettle" }],
    });
    expect(result).toBe("suggested");
    const row = await topicRow(topic);
    expect(row.body[0].runs[0].text).toBe("In our own words.");
    expect(row.summary).toBe("Ours");
    const [suggestion] = await q<{
      id: string;
      status: string;
      additions: unknown;
      ticket_ids: string[];
    }>(alice, "select * from public.manual_suggestions where topic_id = $1", [topic]);
    expect(suggestion).toMatchObject({
      status: "pending",
      additions: [{ section: "What to do", points: ["Oil the knob"] }],
      ticket_ids: [second],
    });
    // The conversation isn't linked until a person accepts.
    expect(
      await q(alice, "select 1 from public.manual_topic_sources where ticket_id = $1", [second]),
    ).toHaveLength(0);

    // Reading the same conversation again replaces its waiting suggestion rather than piling up.
    await apply(run, second, {
      kind: "suggest",
      topic_id: topic,
      additions: [{ section: "Notes", points: ["Again"] }],
    });
    const waiting = await q<{ id: string }>(
      alice,
      "select id from public.manual_suggestions where topic_id = $1 and status = 'pending'",
      [topic],
    );
    expect(waiting).toHaveLength(1);

    // A member accepts it with the merged text; the link and a revision follow.
    await q(amy, "select public.decide_manual_suggestion($1, $2, true, $3, null)", [
      tenantA,
      waiting[0].id,
      body("In our own words. Again."),
    ]);
    expect((await topicRow(topic)).body[0].runs[0].text).toBe("In our own words. Again.");
    expect(
      await q(
        alice,
        "select 1 from public.manual_topic_sources where ticket_id = $1 and topic_id = $2",
        [second, topic],
      ),
    ).toHaveLength(1);
    const [last] = await q<{ cause: string; actor_id: string }>(
      alice,
      "select cause, actor_id from public.manual_topic_revisions where topic_id = $1 and cause = 'suggestion'",
      [topic],
    );
    expect(last.actor_id).toBe(amy.id);
    // Deciding twice changes nothing.
    await q(amy, "select public.decide_manual_suggestion($1, $2, false)", [tenantA, waiting[0].id]);
    const [{ status }] = await q<{ status: string }>(
      alice,
      "select status from public.manual_suggestions where id = $1",
      [waiting[0].id],
    );
    expect(status).toBe("accepted");
  });

  it("dismissing a suggestion leaves the topic alone, and accepting needs the text", async () => {
    const run = await claimedRun(tenantA);
    const t = await ticket("manual-a");
    const [{ id: topic }] = await q<{ id: string }>(
      amy,
      "select public.save_manual_topic($1, null, 'By hand', '', $2, '[]') as id",
      [tenantA, body("Ours.")],
    );
    await apply(run, t, {
      kind: "suggest",
      topic_id: topic,
      additions: [{ section: "Notes", points: ["x"] }],
    });
    const [{ id }] = await q<{ id: string }>(
      alice,
      "select id from public.manual_suggestions where topic_id = $1",
      [topic],
    );
    await fails(
      q(amy, "select public.decide_manual_suggestion($1, $2, true)", [tenantA, id]),
      /bad_body/,
    );
    await q(amy, "select public.decide_manual_suggestion($1, $2, false)", [tenantA, id]);
    expect((await topicRow(topic)).body[0].runs[0].text).toBe("Ours.");
  });

  it("a conversation is marked read whatever came of it, and only under a running run", async () => {
    const run = await claimedRun(tenantA);
    const t = await ticket("manual-a");
    expect(await apply(run, t, { kind: "nothing" })).toBe("nothing");
    expect(await apply(run, t, { kind: "failed" })).toBe("failed");
    const reads = await q<{ result: string }>(
      alice,
      "select result from public.manual_reads where ticket_id = $1",
      [t],
    );
    expect(reads).toEqual([{ result: "failed" }]);
    await service("select public.finish_manual_run($1, 'done', $2)", [
      run,
      JSON.stringify({ read: 1 }),
    ]);
    await fails(apply(run, t, { kind: "nothing" }), /run_not_running/);
  });
});

describe("runs", () => {
  const setConfig = (tenant: string, value: object) =>
    db.query(
      `insert into public.configs (tenant_id, module, key, body) values ($1, 'helpdesk', 'manual', $2)
       on conflict (tenant_id, module, key) do update set body = excluded.body`,
      [tenant, JSON.stringify(value)],
    );
  const clear = () => db.query("delete from public.manual_runs");

  it("“Update now” is a manager's, finds a waiting one, and can't be pressed in a row", async () => {
    await clear();
    await fails(
      q(amy, "select public.request_manual_run($1)", [tenantA]),
      /Only owners and admins/,
    );
    const [{ id }] = await q<{ id: string }>(alice, "select public.request_manual_run($1) as id", [
      tenantA,
    ]);
    const [{ id: again }] = await q<{ id: string }>(
      alice,
      "select public.request_manual_run($1) as id",
      [tenantA],
    );
    expect(again).toBe(id);
    const claimed = await service<{ id: string; tenant_id: string; source: string }>(
      "select * from public.claim_manual_runs(5)",
    );
    expect(claimed).toMatchObject([{ id, tenant_id: tenantA, source: "manual" }]);
    // Claimed once: a second worker gets nothing.
    expect(await service("select * from public.claim_manual_runs(5)")).toEqual([]);
    await service("select public.finish_manual_run($1, 'done', '{}')", [id]);
    await fails(q(alice, "select public.request_manual_run($1)", [tenantA]), /too_soon/);
    // One conversation can still be added, in its own run.
    const t = await ticket("manual-a");
    const [{ id: one }] = await q<{ id: string }>(
      alice,
      "select public.request_manual_run($1, $2) as id",
      [tenantA, t],
    );
    const next = await service<{ id: string; ticket_id: string; source: string }>(
      "select * from public.claim_manual_runs(5)",
    );
    expect(next).toMatchObject([{ id: one, ticket_id: t, source: "ticket" }]);
  });

  it("runs by itself only where it was switched on and told where to look", async () => {
    await clear();
    await setConfig(tenantA, { version: 1, auto: true, sources: { tags: [] } });
    await setConfig(tenantB, { version: 1, auto: false, sources: { tags: ["fix"] } });
    expect(await service("select * from public.claim_manual_runs(5)")).toEqual([]);
    await setConfig(tenantA, { version: 1, auto: true, every: "day", sources: { tags: ["fix"] } });
    const first = await service<{ id: string; tenant_id: string; source: string }>(
      "select * from public.claim_manual_runs(5)",
    );
    expect(first).toMatchObject([{ tenant_id: tenantA, source: "schedule" }]);
    await service("select public.finish_manual_run($1, 'done', '{}')", [first[0].id]);
    // Not again the same day...
    expect(await service("select * from public.claim_manual_runs(5)")).toEqual([]);
    // ...but the next day, yes; and with "week", not until a week has gone.
    await db.query("update public.manual_runs set created_at = now() - interval '25 hours'");
    expect(await service("select * from public.claim_manual_runs(5)")).toHaveLength(1);
    await db.query(
      "update public.manual_runs set status = 'done', created_at = now() - interval '25 hours'",
    );
    await setConfig(tenantA, { version: 1, auto: true, every: "week", sources: { tags: ["fix"] } });
    expect(await service("select * from public.claim_manual_runs(5)")).toEqual([]);
    await db.query("update public.manual_runs set created_at = now() - interval '8 days'");
    expect(await service("select * from public.claim_manual_runs(5)")).toHaveLength(1);
  });

  it("a run that never finished is marked failed, not run again", async () => {
    await clear();
    await setConfig(tenantA, { version: 1, auto: false });
    await db.query(
      "insert into public.manual_runs (tenant_id, source, status, started_at) values ($1, 'manual', 'running', now() - interval '45 minutes')",
      [tenantA],
    );
    expect(await service("select * from public.claim_manual_runs(5)")).toEqual([]);
    const [row] = await q<{ status: string; error: string }>(
      alice,
      "select status, error from public.manual_runs",
    );
    expect(row).toEqual({ status: "failed", error: "This update never finished." });
  });
});

describe("articles", () => {
  it("anyone on the team writes one; tags are tidied; only a manager deletes", async () => {
    const [{ id }] = await q<{ id: string }>(
      amy,
      "select public.save_manual_article($1, null, 'Returns', $2, array['Policy', ' policy ', 'returns'], true) as id",
      [tenantA, body("Thirty days.")],
    );
    const [row] = await q<{ tags: string[]; shareable: boolean; created_by: string }>(
      alice,
      "select tags, shareable, created_by from public.manual_articles where id = $1",
      [id],
    );
    expect([...row.tags].sort()).toEqual(["policy", "returns"]);
    expect(row).toMatchObject({ shareable: true, created_by: amy.id });
    await fails(
      q(amy, "select public.delete_manual_article($1, $2)", [tenantA, id]),
      /Only owners and admins/,
    );
    await q(alice, "select public.delete_manual_article($1, $2)", [tenantA, id]);
  });
});
