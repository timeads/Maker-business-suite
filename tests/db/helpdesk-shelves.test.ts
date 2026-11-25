import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let amy: User; // member of A
let bob: User; // owner of B
let tenantA: string;
let n = 0;

const q = <T>(who: User, sql: string, params: unknown[] = []) =>
  asUser(db, who, async (tx) => (await tx.query<T>(sql, params)).rows);

type Filed = { result: string; ticket_id: string; message_id: string; kept_in: string | null };

async function email(slug: string, from: string, subject: string, references: string[] = []) {
  n += 1;
  const rows = await asService(
    db,
    async (tx) =>
      (
        await tx.query<{ r: Filed }>(
          "select public.file_inbound_email($1, $2, $3, null, $4, 'Hello', $5, null, $6) as r",
          [slug, `shelf-${n}`, from, subject, `<shelf-${n}@mail.test>`, references],
        )
      ).rows,
  );
  return { ...rows[0].r, mid: `<shelf-${n}@mail.test>` };
}

const ticket = async (id: string) =>
  (
    await q<{ status: string; shelf: string | null; closed_at: string | null }>(
      alice,
      "select status, shelf, closed_at from public.tickets where id = $1",
      [id],
    )
  )[0];
const events = async (id: string) =>
  (
    await q<{ kind: string; detail: string }>(
      alice,
      "select kind, detail from public.ticket_events where ticket_id = $1 order by created_at, id",
      [id],
    )
  ).map((e) => `${e.kind}:${e.detail}`);

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
  tenantA = await tenantFor(alice, "Shelf A");
  await tenantFor(bob, "Shelf B");
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, amy.id],
  );
});

describe("archive", () => {
  it("closes the conversation onto its shelf, and a customer writing back reopens it", async () => {
    const t = await email("shelf-a", "pat@example.test", "Done with this");
    await q(amy, "select public.shelve_ticket($1, 'archived')", [t.ticket_id]);
    const archived = await ticket(t.ticket_id);
    expect(archived).toMatchObject({ status: "closed", shelf: "archived" });
    expect(archived.closed_at).not.toBeNull();
    // One line in the log, not "closed" as well.
    expect(await events(t.ticket_id)).toEqual(["shelf:archived"]);

    const back = await email("shelf-a", "pat@example.test", "Re: Done with this", [t.mid]);
    expect(back).toMatchObject({ result: "threaded", ticket_id: t.ticket_id, kept_in: "archived" });
    expect(await ticket(t.ticket_id)).toMatchObject({
      status: "open",
      shelf: null,
      closed_at: null,
    });
    expect(await events(t.ticket_id)).toEqual(["shelf:archived", "status:open|customer"]);
  });

  it("a teammate reopening it, or changing its status, takes it off the shelf", async () => {
    const t = await email("shelf-a", "pat@example.test", "Archive then reopen");
    await q(amy, "select public.shelve_ticket($1, 'archived')", [t.ticket_id]);
    await q(amy, "select public.set_ticket_status($1, 'pending')", [t.ticket_id]);
    expect(await ticket(t.ticket_id)).toMatchObject({ status: "pending", shelf: null });
    expect(await events(t.ticket_id)).toEqual(["shelf:archived", "shelf:restored|archived"]);
  });
});

describe("spam", () => {
  it("stays put when more mail arrives on it, until someone says it isn't spam", async () => {
    const t = await email("shelf-a", "junk@example.test", "You have won");
    await q(amy, "select public.shelve_ticket($1, 'spam')", [t.ticket_id]);
    const spam = await ticket(t.ticket_id);
    expect(spam).toMatchObject({ status: "closed", shelf: "spam", closed_at: null });

    const more = await email("shelf-a", "junk@example.test", "Re: You have won", [t.mid]);
    expect(more).toMatchObject({ result: "threaded", ticket_id: t.ticket_id, kept_in: "spam" });
    expect(await ticket(t.ticket_id)).toMatchObject({ status: "closed", shelf: "spam" });
    const count = await q<{ n: number }>(
      amy,
      "select count(*)::int as n from public.messages where ticket_id = $1",
      [t.ticket_id],
    );
    expect(count[0].n).toBe(2);

    await q(amy, "select public.shelve_ticket($1, null)", [t.ticket_id]);
    expect(await ticket(t.ticket_id)).toMatchObject({ status: "open", shelf: null });
    expect(await events(t.ticket_id)).toEqual(["shelf:spam", "shelf:restored|spam"]);
  });

  it("a new email from the same sender is still a new conversation", async () => {
    const first = await email("shelf-a", "again@example.test", "Offer one");
    await q(amy, "select public.shelve_ticket($1, 'spam')", [first.ticket_id]);
    const second = await email("shelf-a", "again@example.test", "Offer two");
    expect(second.result).toBe("created");
    expect(second.ticket_id).not.toBe(first.ticket_id);
  });
});

describe("the trash", () => {
  let trashed: string;

  it("holds a conversation until it is restored; mail on it stays there", async () => {
    const t = await email("shelf-a", "pat@example.test", "Thrown away");
    trashed = t.ticket_id;
    await q(amy, "select public.shelve_ticket($1, 'trash')", [trashed]);
    expect(await ticket(trashed)).toMatchObject({ status: "closed", shelf: "trash" });
    await email("shelf-a", "pat@example.test", "Re: Thrown away", [t.mid]);
    expect(await ticket(trashed)).toMatchObject({ status: "closed", shelf: "trash" });
    await q(amy, "select public.shelve_ticket($1, null)", [trashed]);
    expect(await ticket(trashed)).toMatchObject({ status: "open", shelf: null });
    await q(amy, "select public.shelve_ticket($1, 'trash')", [trashed]);
  });

  it("deleting for good is for owners and admins, and only from the trash", async () => {
    await expect(q(amy, "select public.delete_ticket_for_good($1)", [trashed])).rejects.toThrow(
      /owners and admins/i,
    );
    await expect(q(amy, "select public.empty_ticket_trash($1)", [tenantA])).rejects.toThrow(
      /owners and admins/i,
    );
    const open = await email("shelf-a", "pat@example.test", "Still wanted");
    await expect(
      q(alice, "select public.delete_ticket_for_good($1)", [open.ticket_id]),
    ).rejects.toThrow(/Trash first/);

    // Its files go with it.
    const { rows: msg } = await db.query<{ id: string }>(
      "select id from public.messages where ticket_id = $1 limit 1",
      [trashed],
    );
    await asService(db, (tx) =>
      tx.query("select public.record_message_attachments($1, $2, $3::jsonb)", [
        tenantA,
        msg[0].id,
        JSON.stringify([
          { name: "a.jpeg", type: "image/jpeg", size: 9, path: `${tenantA}/x/y/z`, state: "kept" },
        ]),
      ]),
    );
    await q(alice, "select public.delete_ticket_for_good($1)", [trashed]);
    expect(await ticket(trashed)).toBeUndefined();
    const { rows: left } = await db.query(
      "select 1 from public.messages where ticket_id = $1 union all select 1 from public.message_attachments where message_id = $2",
      [trashed, msg[0].id],
    );
    expect(left).toHaveLength(0);
    const { rows: queued } = await db.query<{ storage_path: string }>(
      "select storage_path from private.attachment_removals",
    );
    expect(queued.map((r) => r.storage_path)).toEqual([`${tenantA}/x/y/z`]);
  });

  it("emptying the trash removes only what is in it, in this workspace", async () => {
    const one = await email("shelf-a", "pat@example.test", "Bin one");
    const two = await email("shelf-a", "pat@example.test", "Bin two");
    const keep = await email("shelf-a", "pat@example.test", "Archived, not binned");
    const theirs = await email("shelf-b", "pat@example.test", "B's bin");
    await q(amy, "select public.shelve_ticket($1, 'trash')", [one.ticket_id]);
    await q(amy, "select public.shelve_ticket($1, 'trash')", [two.ticket_id]);
    await q(amy, "select public.shelve_ticket($1, 'archived')", [keep.ticket_id]);
    await q(bob, "select public.shelve_ticket($1, 'trash')", [theirs.ticket_id]);

    await expect(q(bob, "select public.empty_ticket_trash($1)", [tenantA])).rejects.toThrow(
      /owners and admins/i,
    );
    const gone = await q<{ n: number }>(alice, "select public.empty_ticket_trash($1) as n", [
      tenantA,
    ]);
    expect(gone[0].n).toBe(2);
    expect(await ticket(keep.ticket_id)).toMatchObject({ shelf: "archived" });
    const b = await q<{ shelf: string }>(bob, "select shelf from public.tickets where id = $1", [
      theirs.ticket_id,
    ]);
    expect(b[0].shelf).toBe("trash");
  });
});

describe("who can shelve", () => {
  it("another workspace can't shelve, restore or delete this one's conversations", async () => {
    const t = await email("shelf-a", "pat@example.test", "Not yours");
    await expect(q(bob, "select public.shelve_ticket($1, 'trash')", [t.ticket_id])).rejects.toThrow(
      /not found/i,
    );
    await q(amy, "select public.shelve_ticket($1, 'trash')", [t.ticket_id]);
    await expect(q(bob, "select public.shelve_ticket($1, null)", [t.ticket_id])).rejects.toThrow(
      /not found/i,
    );
    await expect(q(bob, "select public.delete_ticket_for_good($1)", [t.ticket_id])).rejects.toThrow(
      /not found/i,
    );
    expect(await q(bob, "select shelf from public.tickets where id = $1", [t.ticket_id])).toEqual(
      [],
    );
  });

  it("refuses a shelf that doesn't exist, and nothing is joined into spam or trash", async () => {
    const a = await email("shelf-a", "pat@example.test", "One");
    const b = await email("shelf-a", "pat@example.test", "Two");
    await expect(q(amy, "select public.shelve_ticket($1, 'attic')", [a.ticket_id])).rejects.toThrow(
      /Unknown place/,
    );
    await q(amy, "select public.shelve_ticket($1, 'spam')", [b.ticket_id]);
    await expect(
      q(amy, "select public.merge_tickets($1, $2)", [a.ticket_id, b.ticket_id]),
    ).rejects.toThrow(/can't be joined/);
    // The other way round works, and the joined one leaves its shelf.
    await q(amy, "select public.merge_tickets($1, $2)", [b.ticket_id, a.ticket_id]);
    const { rows } = await db.query<{ shelf: string | null; merged_into: string }>(
      "select shelf, merged_into from public.tickets where id = $1",
      [b.ticket_id],
    );
    expect(rows[0]).toEqual({ shelf: null, merged_into: a.ticket_id });
  });
});
