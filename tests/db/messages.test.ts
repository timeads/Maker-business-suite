import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };
type Row = { channel_id: string; kind: string; name: string | null; unread: number };

let db: PGlite;
let alice: User;
let mia: User;
let noor: User;
let bob: User;
let tenantA: string;
let tenantB: string;

async function tenantFor(owner: User, name: string): Promise<string> {
  return asUser(db, owner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select id from public.create_tenant($1, 'UTC', 'USD')",
      [name],
    );
    return rows[0].id;
  });
}

const overview = (user: User, tenant: string) =>
  asUser(
    db,
    user,
    async (tx) => (await tx.query<Row>("select * from public.chat_overview($1)", [tenant])).rows,
  );

const post = (user: User, channel: string, body: string) =>
  asUser(db, user, async (tx) => {
    const { rows } = await tx.query<{ id: number }>(
      "select public.post_chat_message($1, $2) as id",
      [channel, body],
    );
    return Number(rows[0].id);
  });

const general = async (user: User, tenant: string) =>
  (await overview(user, tenant)).find((c) => c.name === "general")!.channel_id;

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  mia = { id: await createUser(db, "mia@a.test"), email: "mia@a.test" };
  noor = { id: await createUser(db, "noor@a.test"), email: "noor@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
  for (const member of [mia, noor]) {
    await db.query(
      "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
      [tenantA, member.id],
    );
  }
});

describe("channels", () => {
  it("a workspace starts with general and alerts, alerts last", async () => {
    const rows = await overview(alice, tenantA);
    expect(rows.map((r) => r.name)).toEqual(["general", "alerts"]);
    expect((await overview(alice, tenantA)).length).toBe(2);
  });

  it("any member can add a channel; names are tidy and unique", async () => {
    await asUser(db, mia, (tx) =>
      tx.query("select public.create_chat_channel($1, ' Orders ', 'What needs packing')", [
        tenantA,
      ]),
    );
    expect((await overview(alice, tenantA)).map((r) => r.name)).toEqual([
      "general",
      "orders",
      "alerts",
    ]);
    await expect(
      asUser(db, mia, (tx) =>
        tx.query("select public.create_chat_channel($1, 'orders')", [tenantA]),
      ),
    ).rejects.toThrow(/duplicate|unique/);
    await expect(
      asUser(db, mia, (tx) =>
        tx.query("select public.create_chat_channel($1, 'Bad Name!')", [tenantA]),
      ),
    ).rejects.toThrow(/check/);
  });
});

describe("messages and unread counts", () => {
  it("others see a new message as unread until they read it; the author never does", async () => {
    const channel = await general(alice, tenantA);
    const id = await post(alice, channel, "  Dye lot arrived  ");
    const unread = async (user: User) =>
      Number((await overview(user, tenantA)).find((c) => c.channel_id === channel)!.unread);
    expect(await unread(alice)).toBe(0);
    expect(await unread(mia)).toBe(1);
    await asUser(db, mia, (tx) => tx.query("select public.mark_chat_read($1, $2)", [channel, id]));
    expect(await unread(mia)).toBe(0);
    // Read positions never move backwards.
    await asUser(db, mia, (tx) => tx.query("select public.mark_chat_read($1, 0)", [channel]));
    expect(await unread(mia)).toBe(0);
    const { rows } = await db.query<{ body: string }>(
      "select body from public.chat_messages where id = $1",
      [id],
    );
    expect(rows[0].body).toBe("Dye lot arrived");
  });

  it("only the author can edit or delete, and a deleted message keeps its place", async () => {
    const channel = await general(alice, tenantA);
    const id = await post(alice, channel, "Typo hree");
    await expect(
      asUser(db, mia, (tx) => tx.query("select public.edit_chat_message($1, 'hacked')", [id])),
    ).rejects.toThrow(/Message not found/);
    await asUser(db, alice, (tx) =>
      tx.query("select public.edit_chat_message($1, 'Typo here')", [id]),
    );
    await expect(
      asUser(db, mia, (tx) => tx.query("select public.delete_chat_message($1)", [id])),
    ).rejects.toThrow(/Message not found/);
    await asUser(db, alice, (tx) => tx.query("select public.delete_chat_message($1)", [id]));
    const { rows } = await db.query<{ body: string; deleted: boolean; edited: boolean }>(
      "select body, deleted_at is not null as deleted, edited_at is not null as edited from public.chat_messages where id = $1",
      [id],
    );
    expect(rows[0]).toEqual({ body: "", deleted: true, edited: true });
  });

  it("refuses empty messages and direct table writes", async () => {
    const channel = await general(alice, tenantA);
    await expect(post(alice, channel, "   ")).rejects.toThrow(/needs some words/);
    await expect(
      asUser(db, alice, (tx) =>
        tx.query(
          "insert into public.chat_messages (tenant_id, channel_id, body) values ($1, $2, 'x')",
          [tenantA, channel],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("direct messages", () => {
  it("a pair shares one conversation that nobody else can see", async () => {
    const open = (from: User, to: User) =>
      asUser(db, from, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          "select public.open_chat_dm($1, $2) as id",
          [tenantA, to.id],
        );
        return rows[0].id;
      });
    const dm = await open(alice, mia);
    expect(await open(mia, alice)).toBe(dm);
    await post(alice, dm, "Can you cover Saturday?");

    const miaSees = (await overview(mia, tenantA)).find((c) => c.channel_id === dm);
    expect(miaSees?.kind).toBe("dm");
    expect(Number(miaSees?.unread)).toBe(1);
    expect((await overview(noor, tenantA)).some((c) => c.channel_id === dm)).toBe(false);

    const noorReads = await asUser(db, noor, (tx) =>
      tx.query("select id from public.chat_messages where channel_id = $1", [dm]),
    );
    expect(noorReads.rows).toHaveLength(0);
    await expect(post(noor, dm, "let me in")).rejects.toThrow(/Conversation not found/);
  });

  it("can't be opened with someone outside the workspace", async () => {
    await expect(
      asUser(db, alice, (tx) => tx.query("select public.open_chat_dm($1, $2)", [tenantA, bob.id])),
    ).rejects.toThrow(/not in this workspace/);
  });
});

describe("workspace isolation", () => {
  it("another workspace sees and can do nothing here", async () => {
    const channel = await general(alice, tenantA);
    await post(alice, channel, "Private to Alice Rugs");
    for (const table of ["chat_channels", "chat_messages", "chat_members", "chat_reads"]) {
      const theirs = await asUser(db, bob, (tx) =>
        tx.query(`select * from public.${table} where tenant_id = $1`, [tenantA]),
      );
      expect(theirs.rows.length, table).toBe(0);
      await expect(
        asAnon(db, (tx) => tx.query(`select 1 from public.${table}`)),
        table,
      ).rejects.toThrow(/permission denied/);
    }
    const mine = await asUser(db, alice, (tx) => tx.query("select id from public.chat_messages"));
    expect(mine.rows.length).toBeGreaterThan(0);
    await expect(post(bob, channel, "hello neighbours")).rejects.toThrow(/Conversation not found/);
    await expect(overview(bob, tenantA)).rejects.toThrow(/Workspace not found/);
    await expect(
      asUser(db, bob, (tx) => tx.query("select * from public.chat_people($1)", [tenantA])),
    ).resolves.toMatchObject({ rows: [] });
    expect((await overview(bob, tenantB)).map((r) => r.name)).toEqual(["general", "alerts"]);
  });
});

describe("posts from the tools", () => {
  it("land in alerts, or a named channel, and only the service role can send them", async () => {
    await asService(db, (tx) =>
      tx.query(
        "select public.post_app_chat_message($1, null, 'bookings', 'New booking: Ada, 2 places')",
        [tenantA],
      ),
    );
    await asService(db, (tx) =>
      tx.query(
        "select public.post_app_chat_message($1, 'orders', 'helpdesk', 'Customer waiting 2 days')",
        [tenantA],
      ),
    );
    const { rows } = await db.query<{ name: string; app: string }>(
      "select c.name, m.app from public.chat_messages m join public.chat_channels c on c.id = m.channel_id where m.app is not null order by m.id",
    );
    expect(rows).toEqual([
      { name: "alerts", app: "bookings" },
      { name: "orders", app: "helpdesk" },
    ]);
    await expect(
      asUser(db, alice, (tx) =>
        tx.query("select public.post_app_chat_message($1, null, 'bookings', 'fake')", [tenantA]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("display names are per workspace and set by the person themselves", async () => {
    await asUser(db, mia, (tx) =>
      tx.query("select public.set_display_name($1, ' Mia K ')", [tenantA]),
    );
    const people = await asUser(db, alice, (tx) =>
      tx.query<{ email: string; display_name: string | null }>(
        "select email, display_name from public.chat_people($1)",
        [tenantA],
      ),
    );
    expect(people.rows.find((p) => p.email === "mia@a.test")?.display_name).toBe("Mia K");
    expect(people.rows).toHaveLength(3);
  });
});
