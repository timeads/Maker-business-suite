import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

/**
 * The record on an order of each time it was emailed, and the claim that
 * makes a send happen once.
 */

type User = { id: string; email: string };
type Claim = { id: string; state: string; thread_id: string | null; reply_to: string | null };

let db: PGlite;
let alice: User; // owner of A
let bob: User; // owner of B
let carol: User; // plain member of A
let tenantA: string;
let tenantB: string;
let orderA: string;
let orderB: string;
let supplierA: string;

async function tenantFor(owner: User, name: string): Promise<string> {
  return asUser(db, owner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select id from public.create_tenant($1, 'America/New_York', 'USD')",
      [name],
    );
    return rows[0].id;
  });
}
const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
const as = <T>(user: User, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);
const one = async <T>(sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows[0];

const SNAPSHOT = { reference: "HI-1", lines: [], shipping: "0.00" };
const begin = async (
  user: User,
  order: string,
  key: string,
  over: {
    to?: string[];
    cc?: string[];
    subject?: string;
    sender?: string;
    messageId?: string;
  } = {},
): Promise<Claim> =>
  (
    await as<Claim>(
      user,
      "select * from public.begin_po_email($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)",
      [
        order,
        key,
        over.to ?? ["Sam@HillMill.example", "pat@hillmill.example"],
        over.cc ?? [],
        over.subject ?? "November order",
        over.sender ?? "dana@wildthread.example",
        over.messageId ?? `<po-${key.slice(0, 8)}@wildthread.example>`,
        JSON.stringify(SNAPSHOT),
        "0123456789abcdef",
      ],
    )
  )[0];
const finish = async (
  user: User,
  id: string,
  outcome: string,
  more: (string | null)[] = [null, null, null],
) =>
  (
    await as<{ marked: boolean }>(
      user,
      "select public.finish_po_email($1, $2, $3, $4, $5) as marked",
      [id, outcome, ...more],
    )
  )[0].marked;
const emailRow = (id: string) =>
  one<Record<string, unknown>>(
    "select status, to_emails, cc_emails, subject, sender_email, sent_by, gmail_message_id, gmail_thread_id, error, attempts, sent_at is not null as has_sent_at from public.purchase_order_emails where id = $1",
    [id],
  );

async function draftOrder(owner: User, tenant: string, prefix: string) {
  await service("select public.upsert_stock_items($1, 'shopify', $2::jsonb)", [
    tenant,
    JSON.stringify([
      {
        external_id: `${prefix}-v1`,
        title: "Wool rug",
        sku: `${prefix}-RUG`,
        on_hand: 4,
        tracked: true,
      },
    ]),
  ]);
  const item = await one<{ id: string }>("select id from public.stock_items where tenant_id = $1", [
    tenant,
  ]);
  const [{ id: supplier }] = await as<{ id: string }>(
    owner,
    "select public.save_supplier($1, null, 'Hill Mill Yarns', null, 30, 30, 1, 'order', '') as id",
    [tenant],
  );
  const [{ number }] = await as<{ number: number }>(
    owner,
    "select public.create_purchase_order($1, $2, $3::jsonb, '') as number",
    [tenant, supplier, JSON.stringify([{ stock_item_id: item.id, qty: 10, unit_cost: 5 }])],
  );
  const order = await one<{ id: string }>(
    "select id from public.purchase_orders where tenant_id = $1 and number = $2",
    [tenant, number],
  );
  return { order: order.id, supplier, item: item.id };
}

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  carol = { id: await createUser(db, "carol@a.test"), email: "carol@a.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, carol.id],
  );
  ({ order: orderA, supplier: supplierA } = await draftOrder(alice, tenantA, "a"));
  ({ order: orderB } = await draftOrder(bob, tenantB, "b"));
}, 120_000);

describe("a Gmail connection", () => {
  it("is a provider the connections table accepts, with its token in Vault only", async () => {
    await service(
      "select public.save_connection($1, 'google_mail', 'gmail-test-1', 'dana@wildthread.example', $2, $3::jsonb, $4, $5::jsonb)",
      [
        tenantA,
        ["openid", "email", "https://www.googleapis.com/auth/gmail.send"],
        JSON.stringify({ access_token: "fake-access", refresh_token: "fake-refresh" }),
        alice.id,
        JSON.stringify({ email: "dana@wildthread.example" }),
      ],
    );
    const row = await one<Record<string, unknown>>(
      "select to_jsonb(c)::text as everything from public.connections c where tenant_id = $1 and provider = 'google_mail'",
      [tenantA],
    );
    expect(String(row.everything)).not.toMatch(/fake-access|fake-refresh/);
    // Members see which mailbox, never a token; another workspace sees nothing.
    expect(
      await as(
        carol,
        "select status, metadata from public.connections where provider = 'google_mail'",
      ),
    ).toEqual([{ status: "active", metadata: { email: "dana@wildthread.example" } }]);
    expect(
      await as(bob, "select status from public.connections where provider = 'google_mail'"),
    ).toEqual([]);
    await expect(
      as(alice, "select * from public.get_provider_token($1, 'google_mail')", [tenantA]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.query(
        "insert into public.connections (tenant_id, provider, external_account_id) values ($1, 'hotmail', 'x')",
        [tenantB],
      ),
    ).rejects.toThrow(/connections_provider_check/);
  });
});

describe("emailing an order", () => {
  let first: Claim;
  const key = randomUUID();

  it("is for owners and admins of that workspace", async () => {
    await expect(begin(carol, orderA, randomUUID())).rejects.toThrow(/Only owners and admins/);
    await expect(begin(bob, orderA, randomUUID())).rejects.toThrow(/Order not found/);
    await expect(
      asAnon(db, (tx) =>
        tx.query(
          "select * from public.begin_po_email($1, gen_random_uuid(), '{a@b.example}', '{}', 's', 'a@b.example', '<m@b.example>', '{}'::jsonb, '0123456789abcdef')",
          [orderA],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    expect(await one("select count(*)::int as n from public.purchase_order_emails")).toEqual({
      n: 0,
    });
  });

  it("claims a send once: a second press finds the first and sends nothing", async () => {
    first = await begin(alice, orderA, key, {
      cc: ["Dana@WildThread.example", "sam@hillmill.example"],
    });
    expect(first).toMatchObject({ state: "new", thread_id: null, reply_to: null });
    expect(await emailRow(first.id)).toMatchObject({
      status: "sending",
      to_emails: ["sam@hillmill.example", "pat@hillmill.example"],
      // Nobody is copied who is already written to.
      cc_emails: ["dana@wildthread.example"],
      subject: "November order",
      sender_email: "dana@wildthread.example",
      sent_by: alice.id,
      attempts: 1,
    });
    // Pressed again while the first is still going.
    expect(await begin(alice, orderA, key)).toMatchObject({ id: first.id, state: "busy" });
    // Nothing about the order has changed yet.
    expect(await one("select status from public.purchase_orders where id = $1", [orderA])).toEqual({
      status: "draft",
    });
  });

  it("on success records Gmail's ids, marks a draft as ordered and remembers the supplier's addresses", async () => {
    expect(await finish(alice, first.id, "sent", ["msg-1", "thr-1", null])).toBe(true);
    expect(await emailRow(first.id)).toMatchObject({
      status: "sent",
      gmail_message_id: "msg-1",
      gmail_thread_id: "thr-1",
      error: null,
      has_sent_at: true,
    });
    expect(
      await one(
        "select status, ordered_at is not null as sent from public.purchase_orders where id = $1",
        [orderA],
      ),
    ).toEqual({ status: "ordered", sent: true });
    expect(
      await one("select email, more_emails from public.suppliers where id = $1", [supplierA]),
    ).toEqual({
      email: "sam@hillmill.example",
      more_emails: ["pat@hillmill.example"],
    });
    // The same press again, after it went: told so, nothing claimed.
    expect(await begin(alice, orderA, key)).toMatchObject({ id: first.id, state: "sent" });
    // Finishing twice changes nothing.
    expect(await finish(alice, first.id, "failed", [null, null, "late"])).toBe(false);
    expect(await emailRow(first.id)).toMatchObject({ status: "sent", gmail_message_id: "msg-1" });
    expect(await one("select count(*)::int as n from public.purchase_order_emails")).toEqual({
      n: 1,
    });
  });

  it("a later send from the same mailbox replies in the same conversation, and changes no status", async () => {
    const again = await begin(alice, orderA, randomUUID(), { to: ["other@hillmill.example"] });
    expect(again).toMatchObject({ state: "new", thread_id: "thr-1" });
    expect(again.reply_to).toBe(`<po-${key.slice(0, 8)}@wildthread.example>`);
    expect(await finish(alice, again.id, "sent", ["msg-2", "thr-1", null])).toBe(false);
    // A supplier that already has addresses keeps them.
    expect(await one("select email from public.suppliers where id = $1", [supplierA])).toEqual({
      email: "sam@hillmill.example",
    });
    // Another mailbox has no such conversation: its Gmail wouldn't know the thread.
    const other = await begin(alice, orderA, randomUUID(), { sender: "pat@wildthread.example" });
    expect(other).toMatchObject({ state: "new", thread_id: null, reply_to: null });
    await finish(alice, other.id, "failed", [null, null, "Gmail wouldn't send it"]);
  });

  it("a clean failure can be tried again with the same press; not knowing cannot", async () => {
    const retryKey = randomUUID();
    const claim = await begin(alice, orderA, retryKey);
    await finish(alice, claim.id, "failed", [
      null,
      null,
      "Gmail wouldn't send it: Invalid To header. Nothing was sent.",
    ]);
    expect(await emailRow(claim.id)).toMatchObject({
      status: "failed",
      error: "Gmail wouldn't send it: Invalid To header. Nothing was sent.",
      gmail_message_id: null,
      has_sent_at: false,
    });
    const retry = await begin(alice, orderA, retryKey, { to: ["fixed@hillmill.example"] });
    expect(retry).toMatchObject({ id: claim.id, state: "retry" });
    expect(await emailRow(claim.id)).toMatchObject({
      status: "sending",
      attempts: 2,
      to_emails: ["fixed@hillmill.example"],
      error: null,
    });

    await finish(alice, claim.id, "unsure", [null, null, "We didn't hear back from Gmail."]);
    expect(await begin(alice, orderA, retryKey)).toMatchObject({ id: claim.id, state: "unsure" });
    expect(await emailRow(claim.id)).toMatchObject({ status: "unsure", attempts: 2 });
  });

  it("a claim that was never finished turns into “can't tell”, not a second send", async () => {
    const lostKey = randomUUID();
    const claim = await begin(alice, orderA, lostKey);
    await db.query(
      "update public.purchase_order_emails set updated_at = now() - interval '5 minutes' where id = $1",
      [claim.id],
    );
    expect(await begin(alice, orderA, lostKey)).toMatchObject({ id: claim.id, state: "unsure" });
    expect(await emailRow(claim.id)).toMatchObject({ status: "unsure" });
    expect(String((await emailRow(claim.id)).error)).toMatch(/can't tell/);
  });

  it("turns down what can't be sent", async () => {
    const tryIt = (over: Parameters<typeof begin>[3]) => begin(alice, orderA, randomUUID(), over);
    await expect(tryIt({ to: [] })).rejects.toThrow(/can't be sent/);
    await expect(tryIt({ to: ["not-an-address"] })).rejects.toThrow(/Bad email/);
    await expect(tryIt({ to: ["a@b.example\r\nBcc: x@evil.example"] })).rejects.toThrow(
      /Bad email/,
    );
    await expect(tryIt({ subject: "  " })).rejects.toThrow(/can't be sent/);
    await expect(tryIt({ messageId: "no-brackets" })).rejects.toThrow(/can't be sent/);
    await expect(
      tryIt({ to: Array.from({ length: 11 }, (_, i) => `p${i}@x.example`) }),
    ).rejects.toThrow(/can't be sent/);
    // A subject can't smuggle a line break into the record.
    const odd = await tryIt({ subject: "Order\r\nBcc: x@evil.example" });
    expect((await emailRow(odd.id)).subject).toBe("Order Bcc: x@evil.example");
    await finish(alice, odd.id, "failed");
    await expect(
      as(
        alice,
        "select * from public.begin_po_email($1, null, '{a@b.example}', '{}', 's', 'a@b.example', '<m@b.example>', '{}'::jsonb, '0123456789abcdef')",
        [orderA],
      ),
    ).rejects.toThrow(/request key/);
    await expect(finish(alice, odd.id, "delivered")).rejects.toThrow(/Unknown outcome/);
  });

  it("won't email an order with nothing on it, or a cancelled one", async () => {
    const hill = await one<{ id: string }>(
      "select supplier_id as id from public.purchase_orders where id = $1",
      [orderA],
    );
    const [{ number }] = await as<{ number: number }>(
      alice,
      "select public.create_purchase_order($1, $2, '[]'::jsonb, '') as number",
      [tenantA, hill.id],
    );
    const empty = await one<{ id: string }>(
      "select id from public.purchase_orders where tenant_id = $1 and number = $2",
      [tenantA, number],
    );
    await expect(begin(alice, empty.id, randomUUID())).rejects.toThrow(/order_empty/);
    await as(alice, "select public.set_purchase_order_status($1, 'cancelled')", [empty.id]);
    await expect(begin(alice, empty.id, randomUUID())).rejects.toThrow(/order_cancelled/);
  });

  it("keeps each workspace's record to itself, and nobody writes it by hand", async () => {
    const mine = await begin(bob, orderB, randomUUID(), { sender: "bob@pots.example" });
    // Bob's key can't be used to reach into Alice's order, nor Alice's claim finished by Bob.
    await expect(finish(bob, first.id, "sent", ["x", "y", null])).rejects.toThrow(
      /Order not found/,
    );
    await expect(finish(carol, first.id, "failed")).rejects.toThrow(/Only owners and admins/);
    expect(await finish(bob, mine.id, "sent", ["msg-b", "thr-b", null])).toBe(true);

    expect(
      (
        await as<{ n: number }>(
          carol,
          "select count(*)::int as n from public.purchase_order_emails",
        )
      )[0].n,
    ).toBeGreaterThan(3);
    expect(await as(bob, "select sender_email from public.purchase_order_emails")).toEqual([
      { sender_email: "bob@pots.example" },
    ]);
    await expect(
      asAnon(db, (tx) => tx.query("select id from public.purchase_order_emails")),
    ).rejects.toThrow(/permission denied/);
    for (const sql of [
      "update public.purchase_order_emails set status = 'sent'",
      "delete from public.purchase_order_emails",
      "insert into public.purchase_order_emails (tenant_id, po_id, request_key, to_emails, subject, sender_email, message_id_header, snapshot, fingerprint) select tenant_id, po_id, gen_random_uuid(), to_emails, subject, sender_email, message_id_header, snapshot, fingerprint from public.purchase_order_emails limit 1",
    ]) {
      await expect(as(alice, sql)).rejects.toThrow(/permission denied/);
    }
    // The same key in two workspaces is two different sends.
    const shared = randomUUID();
    expect((await begin(alice, orderA, shared)).state).toBe("new");
    expect((await begin(bob, orderB, shared)).state).toBe("new");
    // The record holds addresses and ids, and nothing that looks like a token.
    const all = await one<{ everything: string }>(
      "select jsonb_agg(to_jsonb(e))::text as everything from public.purchase_order_emails e",
    );
    expect(all.everything).not.toMatch(
      /access_token|refresh_token|fake-access|fake-refresh|Bearer/,
    );
  });
});
