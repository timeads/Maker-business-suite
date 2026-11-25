import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createTestDb, createUser } from "./harness";

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

async function email(slug: string, subject: string, tags: string[] = []) {
  n += 1;
  const rows = await service<{ r: { ticket_id: string } }>(
    "select public.file_inbound_email($1, $2, 'pat@example.test', null, $3, 'Hello', $4, null, '{}', $5) as r",
    [slug, `bulk-${n}`, subject, `<bulk-${n}@mail.test>`, tags],
  );
  return rows[0].r.ticket_id;
}

const row = async (id: string) =>
  (
    await db.query<Record<string, string | null>>(
      "select status, shelf, assignee_id, folder_id, priority, snoozed_until from public.tickets where id = $1",
      [id],
    )
  ).rows[0];
const tagsOf = async (id: string) =>
  (
    await db.query<{ name: string }>(
      "select g.name from public.ticket_tags tt join public.tags g on g.id = tt.tag_id where tt.ticket_id = $1 order by g.name",
      [id],
    )
  ).rows.map((r) => r.name);
const events = async (id: string, kind: string) =>
  (
    await db.query<{ detail: string; actor_id: string | null }>(
      "select detail, actor_id from public.ticket_events where ticket_id = $1 and kind = $2 order by created_at, id",
      [id, kind],
    )
  ).rows;
const bulk = (who: User, tenant: string, ids: string[], change: object) =>
  q<{ n: number }>(who, "select public.bulk_update_tickets($1, $2, $3::jsonb) as n", [
    tenant,
    ids,
    JSON.stringify(change),
  ]).then((rows) => rows[0].n);

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
  tenantA = await tenantFor(alice, "Bulk A");
  tenantB = await tenantFor(bob, "Bulk B");
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, amy.id],
  );
});

describe("tag changes in the activity log", () => {
  it("a rule's tag on new mail is written down with no actor", async () => {
    const t = await email("bulk-a", "Refund please", ["refund"]);
    expect(await events(t, "tags")).toEqual([{ detail: "+refund", actor_id: null }]);
  });

  it("only what really changed is logged", async () => {
    const t = await email("bulk-a", "Tags", ["refund"]);
    await q(amy, "select public.set_ticket_tags($1, $2)", [t, ["refund", "Wholesale "]]);
    await q(amy, "select public.set_ticket_tags($1, $2)", [t, ["wholesale"]]);
    expect(await tagsOf(t)).toEqual(["wholesale"]);
    expect((await events(t, "tags")).map((e) => e.detail)).toEqual([
      "+refund",
      "+wholesale",
      "-refund",
    ]);
    expect((await events(t, "tags"))[1].actor_id).toBe(amy.id);
  });
});

describe("several conversations at once", () => {
  it("assigns, tags, files, snoozes and closes in one request each", async () => {
    const ids = [await email("bulk-a", "One"), await email("bulk-a", "Two", ["old"])];
    const folder = (
      await q<{ id: string }>(alice, "select public.create_ticket_folder($1, 'Repairs') as id", [
        tenantA,
      ])
    )[0].id;
    expect(await bulk(amy, tenantA, ids, { assignee: amy.id })).toBe(2);
    await bulk(amy, tenantA, ids, { add_tags: ["vip"], remove_tags: ["old"] });
    await bulk(amy, tenantA, ids, { folder });
    await bulk(amy, tenantA, ids, { priority: "high" });
    const until = new Date(Date.now() + 86_400_000).toISOString();
    await bulk(amy, tenantA, ids, { snooze_until: until });
    for (const id of ids) {
      const t = await row(id);
      expect(t).toMatchObject({ assignee_id: amy.id, folder_id: folder, priority: "high" });
      expect(t.snoozed_until).not.toBeNull();
      expect(await tagsOf(id)).toEqual(["vip"]);
    }
    await bulk(amy, tenantA, ids, { status: "closed" });
    expect((await row(ids[0])).status).toBe("closed");
    expect((await row(ids[0])).snoozed_until).toBeNull();
    // Each change left its line in the log.
    // (Two lines written in one request carry the same time, so the order between them isn't fixed.)
    expect((await events(ids[1], "tags")).map((e) => e.detail).sort()).toEqual([
      "+old",
      "+vip",
      "-old",
    ]);
    expect(await events(ids[0], "assigned")).toHaveLength(1);
    await bulk(amy, tenantA, ids, { assignee: null, folder: null });
    expect(await row(ids[0])).toMatchObject({ assignee_id: null, folder_id: null });
  });

  it("archives, marks as spam, bins and restores", async () => {
    const ids = [await email("bulk-a", "Shelf one"), await email("bulk-a", "Shelf two")];
    for (const shelf of ["archived", "spam", "trash"]) {
      await bulk(amy, tenantA, ids, { shelf });
      expect(await row(ids[1])).toMatchObject({ shelf, status: "closed" });
    }
    await bulk(amy, tenantA, ids, { shelf: null });
    expect(await row(ids[0])).toMatchObject({ shelf: null, status: "open" });
  });

  it("covers only this workspace's conversations, and only for its members", async () => {
    const mine = await email("bulk-a", "Mine");
    const theirs = await email("bulk-b", "Theirs");
    // B's id is quietly left out: nothing of B's changes.
    expect(await bulk(amy, tenantA, [mine, theirs], { status: "closed" })).toBe(1);
    expect((await row(theirs)).status).toBe("open");
    await expect(bulk(bob, tenantA, [mine], { status: "open" })).rejects.toThrow(/not found/i);
    await expect(bulk(amy, tenantB, [theirs], { status: "closed" })).rejects.toThrow(/not found/i);
    await expect(bulk(amy, tenantA, [mine], { assignee: bob.id })).rejects.toThrow(
      /not in this workspace/,
    );
    await expect(bulk(amy, tenantA, [mine], { shelf: "attic" })).rejects.toThrow(/Unknown place/);
    await expect(bulk(amy, tenantA, [], { status: "open" })).rejects.toThrow(/between one and 200/);
    const folderB = (
      await q<{ id: string }>(bob, "select public.create_ticket_folder($1, 'B') as id", [tenantB])
    )[0].id;
    await expect(bulk(amy, tenantA, [mine], { folder: folderB })).rejects.toThrow(
      /Folder not found/,
    );
  });
});

describe("email waiting to go (undo send)", () => {
  const payload = (over: object = {}) => ({
    kind: "reply",
    to: ["pat@example.test"],
    cc: [],
    doc: [{ t: "p", runs: [{ text: "On its way." }] }],
    then: "closed",
    add_tags: ["answered"],
    files: [{ name: "a.png", base64: "eA==" }],
    ...over,
  });
  const queue = (who: User, ticket: string, body: object = payload(), delay = 5) =>
    q<{ id: string }>(who, "select public.queue_outbound($1, $2::jsonb, $3::jsonb, $4) as id", [
      ticket,
      JSON.stringify(body),
      JSON.stringify({ kind: "reply", to: ["pat@example.test"], preview: "On its way." }),
      delay,
    ]).then((rows) => rows[0].id);
  const due = (id: string) =>
    db.query(
      "update private.outbound_queue set send_at = now() - interval '1 second' where id = $1",
      [id],
    );
  const state = async (id: string) =>
    (
      await db.query<{ state: string; payload: Record<string, unknown>; error: string | null }>(
        "select state, payload, error from private.outbound_queue where id = $1",
        [id],
      )
    ).rows[0];

  it("waits, can be taken back, and then never goes", async () => {
    const t = await email("bulk-a", "Undo me");
    const id = await queue(amy, t);
    const box = await q<{ state: string; doc: unknown }>(
      alice,
      "select state, doc from public.ticket_outbox($1)",
      [t],
    );
    expect(box).toEqual([{ state: "waiting", doc: null }]);
    // Not due yet: the worker gets nothing.
    expect(await service("select * from public.claim_outbound(5)")).toHaveLength(0);
    expect(
      (await q<{ ok: boolean }>(amy, "select public.cancel_outbound($1) as ok", [id]))[0].ok,
    ).toBe(true);
    expect(await state(id)).toMatchObject({ state: "cancelled", payload: {} });
    await due(id);
    expect(await service("select * from public.claim_outbound(5)")).toHaveLength(0);
    expect(
      (await q<{ ok: boolean }>(amy, "select public.cancel_outbound($1) as ok", [id]))[0].ok,
    ).toBe(false);
    expect(
      (
        await db.query(
          "select 1 from public.messages where ticket_id = $1 and direction = 'outbound'",
          [t],
        )
      ).rows,
    ).toHaveLength(0);
  });

  it("once the worker has it, it can't be taken back; it is filed as its author's own send", async () => {
    const t = await email("bulk-a", "Goes out");
    const id = await queue(amy, t);
    await due(id);
    const claimed = await service<{ id: string; author_id: string; payload: { kind: string } }>(
      "select * from public.claim_outbound(5)",
    );
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ id, author_id: amy.id });
    expect(
      (await q<{ ok: boolean }>(amy, "select public.cancel_outbound($1) as ok", [id]))[0].ok,
    ).toBe(false);
    // Claimed once: a second worker gets nothing.
    expect(await service("select * from public.claim_outbound(5)")).toHaveLength(0);

    const filed = await service<{ m: string }>(
      "select public.finish_outbound($1, 'pm-out-1', 'support-bulk-a@in.test', 'On its way.', '[]'::jsonb, null) as m",
      [id],
    );
    expect(filed[0].m).toMatch(/^[0-9a-f-]{36}$/);
    const { rows } = await db.query<{ author_id: string; to_emails: string[] }>(
      "select author_id, to_emails from public.messages where id = $1",
      [filed[0].m],
    );
    expect(rows[0]).toEqual({ author_id: amy.id, to_emails: ["pat@example.test"] });
    expect(await row(t)).toMatchObject({ status: "closed", assignee_id: amy.id });
    expect(await tagsOf(t)).toEqual(["answered"]);
    // The log names the person, not "System".
    expect((await events(t, "status")).at(-1)).toEqual({ detail: "closed", actor_id: amy.id });
    expect(await state(id)).toMatchObject({ state: "sent", payload: {} });
    expect(await q(amy, "select 1 from public.ticket_outbox($1)", [t])).toHaveLength(0);
    // Finishing twice files nothing more.
    const again = await service<{ m: string | null }>(
      "select public.finish_outbound($1, 'pm-out-1', 'x@in.test', 'On its way.') as m",
      [id],
    );
    expect(again[0].m).toBeNull();
  });

  it("a refused email is kept as failed, with its words but not its files", async () => {
    const t = await email("bulk-a", "Refused");
    const id = await queue(amy, t);
    await due(id);
    await service("select * from public.claim_outbound(5)");
    await service(
      "select public.finish_outbound($1, null, null, null, '[]'::jsonb, 'postmark_406')",
      [id],
    );
    const failed = await state(id);
    expect(failed).toMatchObject({ state: "failed", error: "postmark_406" });
    expect(failed.payload.files).toBeUndefined();
    const box = await q<{ state: string; doc: unknown; error: string }>(
      amy,
      "select state, doc, error from public.ticket_outbox($1)",
      [t],
    );
    expect(box[0]).toMatchObject({ state: "failed", error: "postmark_406" });
    expect(box[0].doc).toEqual(payload().doc);
    expect((await row(t)).status).toBe("open");
    await q(amy, "select public.dismiss_outbound($1)", [id]);
    expect(await q(amy, "select 1 from public.ticket_outbox($1)", [t])).toHaveLength(0);
  });

  it("an email claimed and never finished is marked unsure, never sent again", async () => {
    const t = await email("bulk-a", "Crashed");
    const id = await queue(amy, t);
    await due(id);
    await service("select * from public.claim_outbound(5)");
    await db.query(
      "update private.outbound_queue set locked_at = now() - interval '11 minutes' where id = $1",
      [id],
    );
    expect(await service("select * from public.claim_outbound(5)")).toHaveLength(0);
    expect(await state(id)).toMatchObject({
      state: "unsure",
      error: "never_finished",
      payload: {},
    });
  });

  it("another workspace can't queue on, see, take back or dismiss this one's email", async () => {
    const t = await email("bulk-a", "Private");
    await expect(queue(bob, t)).rejects.toThrow(/not found/i);
    const id = await queue(amy, t);
    expect(await q(bob, "select 1 from public.ticket_outbox($1)", [t])).toHaveLength(0);
    expect(
      (await q<{ ok: boolean }>(bob, "select public.cancel_outbound($1) as ok", [id]))[0].ok,
    ).toBe(false);
    expect((await state(id)).state).toBe("waiting");
    await expect(q(amy, "select public.claim_outbound(5)")).rejects.toThrow(/permission denied/);
    await expect(q(amy, "select public.finish_outbound($1)", [id])).rejects.toThrow(
      /permission denied/,
    );
    await expect(q(amy, "select * from private.outbound_queue")).rejects.toThrow(
      /permission denied/,
    );
    await expect(queue(amy, t, payload(), 0)).rejects.toThrow(/between 1 and 60/);
    await q(amy, "select public.cancel_outbound($1)", [id]);
  });
});

describe("an empty conversation", () => {
  it("can be thrown away by the team, but not once anything was said", async () => {
    const started = (
      await q<{ id: string }>(
        amy,
        "select id from public.start_ticket($1, 'new@example.test', null, 'Never sent')",
        [tenantA],
      )
    )[0].id;
    await expect(q(bob, "select public.discard_empty_ticket($1)", [started])).rejects.toThrow(
      /not found/i,
    );
    await q(amy, "select public.discard_empty_ticket($1)", [started]);
    expect(
      (await db.query("select 1 from public.tickets where id = $1", [started])).rows,
    ).toHaveLength(0);

    const real = await email("bulk-a", "Has words");
    await expect(q(amy, "select public.discard_empty_ticket($1)", [real])).rejects.toThrow(
      /Only an empty conversation/,
    );
  });
});
