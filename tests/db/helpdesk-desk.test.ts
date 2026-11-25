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
let ticketA: string;
let ticketB: string;
let n = 0;

const q = <T>(who: User, sql: string, params: unknown[] = []) =>
  asUser(db, who, async (tx) => (await tx.query<T>(sql, params)).rows);

async function tenantFor(owner: User, name: string): Promise<string> {
  return (
    await q<{ id: string }>(owner, "select id from public.create_tenant($1, 'UTC', 'USD')", [name])
  )[0].id;
}

async function email(slug: string, from: string, subject: string, body = "Hello there") {
  n += 1;
  const rows = await asService(
    db,
    async (tx) =>
      (
        await tx.query<{ r: { ticket_id: string } }>(
          "select public.ingest_inbound_email($1, $2, $3, null, $4, $5, $6, null, '{}', '{}') as r",
          [slug, `desk-${n}`, from, subject, body, `<desk-${n}@mail.test>`],
        )
      ).rows,
  );
  return rows[0].r.ticket_id;
}

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  amy = { id: await createUser(db, "amy@a.test"), email: "amy@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Desk A");
  tenantB = await tenantFor(bob, "Desk B");
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, amy.id],
  );
  ticketA = await email("desk-a", "pat@example.test", "Loose thread", "The yarn keeps slipping.");
  ticketB = await email("desk-b", "pat@example.test", "Other shop");
});

describe("folders", () => {
  let folder: string;

  it("an owner makes a folder; a plain member can't; another workspace can't", async () => {
    folder = (
      await q<{ id: string }>(alice, "select public.create_ticket_folder($1, 'Repairs') as id", [
        tenantA,
      ])
    )[0].id;
    await expect(
      q(amy, "select public.create_ticket_folder($1, 'Mine')", [tenantA]),
    ).rejects.toThrow(/owners and admins/i);
    await expect(
      q(bob, "select public.create_ticket_folder($1, 'Sneaky')", [tenantA]),
    ).rejects.toThrow();
    await expect(
      q(alice, "select public.create_ticket_folder($1, 'repairs')", [tenantA]),
    ).rejects.toThrow();
  });

  it("anyone on the team files a conversation; the move is written down", async () => {
    await q(amy, "select public.file_ticket($1, $2)", [ticketA, folder]);
    const rows = await q<{ folder_id: string }>(
      amy,
      "select folder_id from public.tickets where id = $1",
      [ticketA],
    );
    expect(rows[0].folder_id).toBe(folder);
    const events = await q<{ kind: string; detail: string; actor_id: string }>(
      alice,
      "select kind, detail, actor_id from public.ticket_events where ticket_id = $1",
      [ticketA],
    );
    expect(events).toContainEqual({ kind: "folder", detail: "Repairs", actor_id: amy.id });
  });

  it("a folder from another workspace is refused, and so is someone else's ticket", async () => {
    const other = (
      await q<{ id: string }>(bob, "select public.create_ticket_folder($1, 'Theirs') as id", [
        tenantB,
      ])
    )[0].id;
    await expect(q(amy, "select public.file_ticket($1, $2)", [ticketA, other])).rejects.toThrow(
      /not found/i,
    );
    await expect(q(bob, "select public.file_ticket($1, null)", [ticketA])).rejects.toThrow(
      /not found/i,
    );
    await expect(q(bob, "select public.rename_ticket_folder($1, 'X')", [folder])).rejects.toThrow();
    await expect(q(amy, "select public.delete_ticket_folder($1)", [folder])).rejects.toThrow();
  });

  it("another workspace sees no folders, events or read marks; clients can't write them", async () => {
    for (const table of ["ticket_folders", "ticket_events", "ticket_reads"]) {
      const mine = await q<{ c: number }>(
        bob,
        `select count(*)::int as c from public.${table} where tenant_id = $1`,
        [tenantA],
      );
      expect(mine[0].c, table).toBe(0);
      await expect(
        asAnon(db, (tx) => tx.query(`select 1 from public.${table}`)),
        table,
      ).rejects.toThrow();
    }
    await expect(
      q(alice, "insert into public.ticket_folders (tenant_id, name) values ($1, 'Direct')", [
        tenantA,
      ]),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      q(
        alice,
        "insert into public.ticket_events (tenant_id, ticket_id, kind) values ($1, $2, 'status')",
        [tenantA, ticketA],
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(q(alice, "delete from public.ticket_events")).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("removing a folder puts its conversations back in the inbox", async () => {
    await q(alice, "select public.delete_ticket_folder($1)", [folder]);
    const rows = await q<{ folder_id: string | null }>(
      alice,
      "select folder_id from public.tickets where id = $1",
      [ticketA],
    );
    expect(rows[0].folder_id).toBeNull();
  });
});

describe("read marks", () => {
  it("are each person's own", async () => {
    await q(alice, "select public.mark_ticket_read($1)", [ticketA]);
    expect(
      (await q(alice, "select 1 from public.ticket_reads where ticket_id = $1", [ticketA])).length,
    ).toBe(1);
    expect(
      (await q(amy, "select 1 from public.ticket_reads where ticket_id = $1", [ticketA])).length,
    ).toBe(0);
    await q(alice, "select public.mark_ticket_unread($1)", [ticketA]);
    expect(
      (await q(alice, "select 1 from public.ticket_reads where ticket_id = $1", [ticketA])).length,
    ).toBe(0);
  });

  it("can't be left on another workspace's ticket", async () => {
    await expect(q(bob, "select public.mark_ticket_read($1)", [ticketA])).rejects.toThrow(
      /not found/i,
    );
  });
});

describe("the list's facts and search", () => {
  it("counts messages, previews the last one and knows when the customer last wrote", async () => {
    const rows = await q<{ message_count: number; preview: string; last_direction: string }>(
      amy,
      "select * from public.ticket_list_facts($1)",
      [[ticketA, ticketB]],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      message_count: 1,
      preview: "The yarn keeps slipping.",
      last_direction: "inbound",
    });
  });

  it("finds a conversation by what was said, only in the asker's workspace", async () => {
    const mine = await q<{ id: string }>(
      amy,
      "select public.search_ticket_messages($1, 'YARN keeps') as id",
      [tenantA],
    );
    expect(mine.map((row) => row.id)).toEqual([ticketA]);
    expect(
      await q(bob, "select public.search_ticket_messages($1, 'yarn keeps')", [tenantA]),
    ).toEqual([]);
    expect(await q(amy, "select public.search_ticket_messages($1, 'ya')", [tenantA])).toEqual([]);
  });
});

describe("mail going out", () => {
  it("a reply with copies is recorded once and can close the conversation", async () => {
    const send = () =>
      q<{ id: string | null }>(
        amy,
        `select public.record_outbound($1, 'Thanks!', 'support-desk-a@mail.test', 'out-1', 'reply',
           array['Pat@Example.test'], array['kit@example.test'],
           '[{"t":"p","runs":[{"text":"Thanks!","b":true}]}]'::jsonb,
           '[{"name":"guide.pdf","size":1200}]'::jsonb, 'closed') as id`,
        [ticketA],
      );
    expect((await send())[0].id).toBeTruthy();
    expect((await send())[0].id).toBeNull();
    const [ticket] = await q<{ status: string; assignee_id: string; closed_at: string | null }>(
      amy,
      "select status, assignee_id, closed_at from public.tickets where id = $1",
      [ticketA],
    );
    expect(ticket.status).toBe("closed");
    expect(ticket.assignee_id).toBe(amy.id);
    expect(ticket.closed_at).not.toBeNull();
    const [message] = await q<{ to_emails: string[]; cc_emails: string[]; kind: string }>(
      amy,
      "select to_emails, cc_emails, kind from public.messages where provider_message_id = 'out-1'",
    );
    expect(message).toEqual({
      to_emails: ["pat@example.test"],
      cc_emails: ["kit@example.test"],
      kind: "reply",
    });
  });

  it("a forward leaves the conversation as it was and is written down", async () => {
    await q(
      amy,
      `select public.record_outbound($1, 'FYI', 'support-desk-a@mail.test', 'out-2', 'forward',
         array['maker@example.test'], '{}', null, '[]'::jsonb, 'keep')`,
      [ticketA],
    );
    const [ticket] = await q<{ status: string }>(
      amy,
      "select status from public.tickets where id = $1",
      [ticketA],
    );
    expect(ticket.status).toBe("closed");
    const events = await q<{ kind: string; detail: string }>(
      amy,
      "select kind, detail from public.ticket_events where ticket_id = $1 and kind = 'forwarded'",
      [ticketA],
    );
    expect(events).toEqual([{ kind: "forwarded", detail: "maker@example.test" }]);
  });

  it("send and snooze needs a time to come; another workspace can't record at all", async () => {
    await expect(
      q(
        amy,
        `select public.record_outbound($1, 'Later', 'a@mail.test', 'out-3', 'reply', '{}', '{}',
           null, '[]'::jsonb, 'snoozed', now() - interval '1 hour')`,
        [ticketA],
      ),
    ).rejects.toThrow(/coming year/i);
    await expect(
      q(bob, "select public.record_outbound($1, 'Hi', 'b@mail.test', 'out-4')", [ticketA]),
    ).rejects.toThrow(/not found/i);
  });

  it("a customer writing back is noted as the reason it reopened", async () => {
    const reply_key = (
      await db.query<{ reply_key: string }>("select reply_key from public.tickets where id = $1", [
        ticketA,
      ])
    ).rows[0].reply_key;
    await asService(db, (tx) =>
      tx.query(
        "select public.ingest_inbound_email('desk-a', 'desk-back', 'pat@example.test', null, 'Re: Loose thread', 'Still slipping', '<back@mail.test>', $1, '{}', '{}')",
        [reply_key],
      ),
    );
    const events = await q<{ detail: string; actor_id: string | null }>(
      amy,
      "select detail, actor_id from public.ticket_events where ticket_id = $1 and kind = 'status' order by created_at desc limit 1",
      [ticketA],
    );
    expect(events[0]).toEqual({ detail: "open|customer", actor_id: null });
  });
});

describe("a conversation the team starts", () => {
  it("gets the next number, belongs to its starter and is read by them", async () => {
    const [made] = await q<{ id: string; number: number }>(
      amy,
      "select * from public.start_ticket($1, 'New.Person@Example.test', 'New Person', 'Your order')",
      [tenantA],
    );
    expect(made.number).toBe(2);
    const [ticket] = await q<{ assignee_id: string; status: string }>(
      amy,
      "select assignee_id, status from public.tickets where id = $1",
      [made.id],
    );
    expect(ticket).toEqual({ assignee_id: amy.id, status: "open" });
    await expect(
      q(amy, "select reply_key from public.tickets where id = $1", [made.id]),
    ).rejects.toThrow(/permission denied/i);
  });

  it("is refused for an outsider and for a bad address", async () => {
    await expect(
      q(bob, "select * from public.start_ticket($1, 'x@example.test', null, 'Hi')", [tenantA]),
    ).rejects.toThrow(/not found/i);
    await expect(
      q(amy, "select * from public.start_ticket($1, 'not an address', null, 'Hi')", [tenantA]),
    ).rejects.toThrow(/does not look right/i);
  });
});

describe("subject and summary", () => {
  it("renaming notes the fact, never the words", async () => {
    await q(amy, "select public.set_ticket_subject($1, 'Yarn slipping on the frame')", [ticketA]);
    const events = await q<{ detail: string }>(
      amy,
      "select detail from public.ticket_events where ticket_id = $1 and kind = 'subject'",
      [ticketA],
    );
    expect(events).toEqual([{ detail: "" }]);
  });

  it("a summary is kept on the ticket, and only by its own team", async () => {
    await q(amy, "select public.set_ticket_insights($1, 'Yarn slips.', 'negative', 'repair')", [
      ticketA,
    ]);
    const [ticket] = await q<{ ai_summary: string; ai_mood: string }>(
      alice,
      "select ai_summary, ai_mood from public.tickets where id = $1",
      [ticketA],
    );
    expect(ticket).toEqual({ ai_summary: "Yarn slips.", ai_mood: "negative" });
    await expect(
      q(bob, "select public.set_ticket_insights($1, 'x', 'neutral', 'x')", [ticketA]),
    ).rejects.toThrow(/not found/i);
  });
});

describe("the customer's orders beside a conversation", () => {
  it("a member of another workspace sees none of this customer's orders", async () => {
    await db.query(
      `insert into public.orders (tenant_id, provider, external_id, name, email, processed_at, total)
       values ($1, 'shopify', 'gid://shopify/Order/1', '#1001', 'pat@example.test', now(), 42)`,
      [tenantA],
    );
    const sql = "select name from public.orders where email = 'pat@example.test'";
    expect(await q<{ name: string }>(amy, sql)).toEqual([{ name: "#1001" }]);
    expect(await q(bob, sql)).toEqual([]);
    expect(
      await q(bob, "select 1 from public.shipping_orders where email = 'pat@example.test'"),
    ).toEqual([]);
  });
});
