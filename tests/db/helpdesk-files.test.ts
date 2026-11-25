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

const q = <T>(who: User, sql: string, params: unknown[] = []) =>
  asUser(db, who, async (tx) => (await tx.query<T>(sql, params)).rows);
const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);

type Filed = { result: string; tenant_id: string; ticket_id: string; message_id: string };

async function email(slug: string, from: string, subject: string, extra: unknown[] = []) {
  n += 1;
  const rows = await service<{ r: Filed }>(
    `select public.file_inbound_email($1, $2, $3, null, $4, 'Hello', $5, null, '{}', '{}', $6, $7) as r`,
    [slug, `files-${n}`, from, subject, `<files-${n}@mail.test>`, extra[0] ?? [], extra[1] ?? []],
  );
  return rows[0].r;
}

const kept = (tenant: string, name: string, path: string, size = 1000, type = "image/jpeg") => ({
  name,
  type,
  size,
  path: `${tenant}/${path}`,
  content_id: null,
  state: "kept",
});

async function record(tenant: string, message: string, files: unknown[]) {
  return (
    await service<{ n: number }>(
      "select public.record_message_attachments($1, $2, $3::jsonb) as n",
      [tenant, message, JSON.stringify(files)],
    )
  )[0].n;
}

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
  tenantA = await tenantFor(alice, "Files A");
  tenantB = await tenantFor(bob, "Files B");
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, amy.id],
  );
});

describe("the private bucket", () => {
  it("exists, is not public, and takes only the kinds we keep", async () => {
    const { rows } = await db.query<{ public: boolean; allowed_mime_types: string[] }>(
      "select public, allowed_mime_types from storage.buckets where id = 'helpdesk'",
    );
    expect(rows[0].public).toBe(false);
    expect(rows[0].allowed_mime_types).toContain("image/jpeg");
    expect(rows[0].allowed_mime_types).not.toContain("text/html");
    expect(rows[0].allowed_mime_types).not.toContain("image/svg+xml");
  });

  it("no client reads or writes its objects, even if another policy would let them", async () => {
    await db.query(
      "insert into storage.objects (bucket_id, name) values ('helpdesk', 'a/b/c/d'), ('social', 'x/y')",
    );
    // A careless future policy that opens every bucket to signed-in people.
    await db.exec(
      'create policy "test: everything open" on storage.objects for all to authenticated, anon using (true) with check (true)',
    );
    const seen = await q<{ bucket_id: string }>(alice, "select bucket_id from storage.objects");
    expect(seen.map((r) => r.bucket_id)).toEqual(["social"]);
    await expect(
      q(alice, "insert into storage.objects (bucket_id, name) values ('helpdesk', 'mine')"),
    ).rejects.toThrow(/row-level security/);
    const anon = await asAnon(
      db,
      async (tx) =>
        (await tx.query("select 1 from storage.objects where bucket_id = 'helpdesk'")).rows,
    );
    expect(anon).toHaveLength(0);
    await db.exec('drop policy "test: everything open" on storage.objects');
  });
});

describe("incoming email keeps who else it went to", () => {
  it("stores To and Cc, and the old function still works", async () => {
    const filed = await email("files-a", "pat@example.test", "With copies", [
      ["Hello@Studio.test"],
      ["partner@example.test"],
    ]);
    expect(filed.result).toBe("created");
    expect(filed.message_id).toMatch(/^[0-9a-f-]{36}$/);
    const rows = await q<{ to_emails: string[]; cc_emails: string[] }>(
      amy,
      "select to_emails, cc_emails from public.messages where id = $1",
      [filed.message_id],
    );
    expect(rows[0]).toEqual({
      to_emails: ["hello@studio.test"],
      cc_emails: ["partner@example.test"],
    });

    const old = await service<{ r: Filed }>(
      "select public.ingest_inbound_email('files-a', 'old-1', 'sam@example.test', null, 'Old way', 'Hi', null, null, '{}', '{}') as r",
    );
    expect(old[0].r.result).toBe("created");
  });

  it("an email seen before answers with the message it became", async () => {
    const first = await email("files-a", "pat@example.test", "Once");
    const again = await service<{ r: Filed }>(
      "select public.file_inbound_email('files-a', $1, 'pat@example.test', null, 'Once', 'Hello') as r",
      [`files-${n}`],
    );
    expect(again[0].r).toMatchObject({
      result: "duplicate",
      ticket_id: first.ticket_id,
      message_id: first.message_id,
    });
  });

  it("clients can't call the filing functions", async () => {
    await expect(
      q(alice, "select public.file_inbound_email('files-a', 'x', 'a@b.test', null, 's', 'b')"),
    ).rejects.toThrow(/permission denied/);
    await expect(
      q(alice, "select public.record_message_attachments($1, $1, '[]')", [tenantA]),
    ).rejects.toThrow(/permission denied/);
    await expect(q(alice, "select public.attachment_bytes_today($1)", [tenantA])).rejects.toThrow(
      /permission denied/,
    );
    await expect(q(alice, "select public.claim_attachment_removals(10)")).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe("a message's files", () => {
  let a: Filed;
  let b: Filed;
  let fileA: string;

  it("are listed once, kept and not kept alike", async () => {
    a = await email("files-a", "pat@example.test", "Photos");
    b = await email("files-b", "pat@example.test", "Other shop");
    expect(
      await record(tenantA, a.message_id, [
        kept(tenantA, "IMG_0209.jpeg", "t/m/one", 5_900_000),
        {
          name: "setup.exe",
          type: "application/x-msdownload",
          size: 400,
          state: "not_kept",
          reason: "type",
        },
      ]),
    ).toBe(2);
    // A retried email doesn't list them twice.
    expect(await record(tenantA, a.message_id, [kept(tenantA, "again.jpeg", "t/m/two")])).toBe(0);
    await record(tenantB, b.message_id, [kept(tenantB, "theirs.png", "t/m/b1", 10, "image/png")]);

    const rows = await q<{ id: string; name: string; state: string; storage_path: string | null }>(
      amy,
      "select id, name, state, storage_path from public.message_attachments where message_id = $1 order by name",
      [a.message_id],
    );
    expect(rows.map((r) => [r.name, r.state])).toEqual([
      ["IMG_0209.jpeg", "kept"],
      ["setup.exe", "not_kept"],
    ]);
    expect(rows[1].storage_path).toBeNull();
    fileA = rows[0].id;
    expect(
      (await service<{ n: string }>("select public.attachment_bytes_today($1) as n", [tenantA]))[0]
        .n,
    ).toBe(5_900_000);
  });

  it("refuses a file under another workspace's path, an unlisted type, or a stranger's message", async () => {
    const c = await email("files-a", "pat@example.test", "Tricks");
    await expect(
      record(tenantA, c.message_id, [kept(tenantB, "x.jpeg", "t/m/steal")]),
    ).rejects.toThrow(/check/);
    await expect(
      record(tenantA, c.message_id, [kept(tenantA, "x.html", "t/m/html", 10, "text/html")]),
    ).rejects.toThrow(/check/);
    await expect(
      record(tenantA, c.message_id, [kept(tenantA, "x.svg", "t/m/svg", 10, "image/svg+xml")]),
    ).rejects.toThrow(/check/);
    // Naming workspace A for a message that belongs to B finds nothing.
    await expect(record(tenantA, b.message_id, [kept(tenantA, "x.jpeg", "t/m/x")])).rejects.toThrow(
      /Message not found/,
    );
  });

  it("a member of another workspace cannot fetch this attachment", async () => {
    // The file route reads the row as the signed-in member; this is that read.
    const mine = await q(amy, "select id from public.message_attachments where id = $1", [fileA]);
    expect(mine).toHaveLength(1);
    const theirs = await q(bob, "select id from public.message_attachments where id = $1", [fileA]);
    expect(theirs).toHaveLength(0);
    const all = await q<{ tenant_id: string }>(
      bob,
      "select tenant_id from public.message_attachments",
    );
    expect(all.every((r) => r.tenant_id === tenantB)).toBe(true);
    await expect(
      asAnon(db, (tx) => tx.query("select 1 from public.message_attachments")),
    ).rejects.toThrow(/permission denied/);
  });

  it("clients can't write the list themselves", async () => {
    await expect(
      q(alice, "delete from public.message_attachments where id = $1", [fileA]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      q(alice, "update public.message_attachments set name = 'x' where id = $1", [fileA]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      q(
        alice,
        "insert into public.message_attachments (tenant_id, message_id, name, mime_type, bytes, state) values ($1, $2, 'x', 'unknown', 1, 'not_kept')",
        [tenantA, a.message_id],
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("when a customer is forgotten, their files are queued to leave storage too", async () => {
    const sam = await email("files-a", "sam.gone@example.test", "Forget me");
    await record(tenantA, sam.message_id, [
      kept(tenantA, "one.jpeg", "forget/one"),
      kept(tenantA, "two.pdf", "forget/two", 10, "application/pdf"),
      { name: "odd.zip", type: "application/zip", size: 5, state: "not_kept", reason: "type" },
    ]);
    await service(
      "select public.redact_customer($1, 'shopify', 'cust-1', 'sam.gone@example.test')",
      [tenantA],
    );
    const left = await q(amy, "select 1 from public.message_attachments where message_id = $1", [
      sam.message_id,
    ]);
    expect(left).toHaveLength(0);

    const claimed = (
      await service<{ p: string }>("select public.claim_attachment_removals(100) as p")
    ).map((r) => r.p);
    expect(claimed.sort()).toEqual([`${tenantA}/forget/one`, `${tenantA}/forget/two`]);
    // Claimed paths aren't handed out twice while the worker is on them.
    expect(await service("select public.claim_attachment_removals(100)")).toHaveLength(0);
    await service("select public.finish_attachment_removals($1)", [claimed]);
    const { rows } = await db.query("select 1 from private.attachment_removals");
    expect(rows).toHaveLength(0);
  });

  it("when a workspace goes, its files are queued as well", async () => {
    const carol: User = { id: await createUser(db, "carol@c.test"), email: "carol@c.test" };
    const tenantC = (
      await q<{ id: string }>(carol, "select id from public.create_tenant('Files C', 'UTC', 'USD')")
    )[0].id;
    const c = await email("files-c", "pat@example.test", "Going");
    await record(tenantC, c.message_id, [kept(tenantC, "c.jpeg", "gone/c")]);
    await db.query("delete from public.tenants where id = $1", [tenantC]);
    const { rows } = await db.query<{ storage_path: string }>(
      "select storage_path from private.attachment_removals",
    );
    expect(rows.map((r) => r.storage_path)).toEqual([`${tenantC}/gone/c`]);
    await db.query("delete from private.attachment_removals");
  });
});
