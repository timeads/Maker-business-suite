import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { normalizeInvoiceRef } from "../../src/lib/stock/mail/extract";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Supplier balances filled in from email: the one function that files an
 * emailed entry, the looks and their record, what waits for a supplier, and
 * the bills address. Made-up suppliers, numbers and amounts throughout.
 */

type User = { id: string; email: string };
type Result = { external_key: string; outcome: string; detail: string | null; id: string | null };
type Answer = { repeated: boolean; outcome: string | null; results: Result[] };

let db: PGlite;
let alice: User; // owner of A
let carol: User; // plain member of A
let bob: User; // owner of B
let tenantA: string;
let tenantB: string;
let mill: string;
let dyer: string;
let bobYard: string;

const READ = "https://www.googleapis.com/auth/gmail.readonly";
const SEND = "https://www.googleapis.com/auth/gmail.send";

const as = <T>(user: User, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);
const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);

const key = (n: number) => n.toString(16).padStart(32, "0");
let counter = 100;
const freshKey = () => key(++counter);

type Entry = Record<string, unknown>;
const invoice = (
  messageKey: string,
  supplier: string,
  ref: string,
  amount: number,
  over: Entry = {},
) => ({
  supplier_id: supplier,
  type: "invoice",
  entry_date: "2026-10-27",
  amount,
  reference: ref,
  description: "Read from an email",
  external_key: `mail:${messageKey}:inv:${normalizeInvoiceRef(ref)}`,
  needs_review: false,
  ...over,
});
const message = (messageKey: string, over: Entry = {}) => ({
  message_key: messageKey,
  route: "gmail",
  gmail_id: "18f0a1b2c3d4e5f6",
  thread_id: "18f0a1b2c3d4e5f0",
  sent_at: "2026-10-28T14:00:00Z",
  sender: "billing@mill.test",
  subject: "Invoice",
  notes: [],
  ...over,
});

async function file(
  tenant: string,
  msg: Entry | null,
  entries: Entry[],
  extra: { pending?: string; confirm?: boolean; actor?: string } = {},
): Promise<Answer> {
  const rows = await service<{ answer: Answer }>(
    "select public.file_email_entries($1, $2::jsonb, $3::jsonb, null, $4, $5, $6) as answer",
    [
      tenant,
      msg ? JSON.stringify(msg) : null,
      JSON.stringify(entries),
      extra.pending ?? null,
      extra.confirm ?? true,
      extra.actor ?? null,
    ],
  );
  return rows[0].answer;
}
const ledger = (supplier: string) =>
  db
    .query<{
      id: string;
      type: string;
      reference: string | null;
      amount: string;
      entry_date: string;
      source: string;
      needs_review: boolean;
      review_note: string | null;
      mail_route: string | null;
      mail_message_id: string | null;
      reported_by: string | null;
    }>(
      `select id, type, reference, amount::text, entry_date::text, source, needs_review, review_note,
              mail_route, mail_message_id, reported_by
       from public.supplier_ledger where supplier_id = $1 order by created_at, id`,
      [supplier],
    )
    .then((r) => r.rows);

async function tenantFor(owner: User, name: string): Promise<string> {
  const rows = await as<{ id: string }>(
    owner,
    "select id from public.create_tenant($1, 'America/New_York', 'USD')",
    [name],
  );
  return rows[0].id;
}
const newSupplier = (user: User, tenant: string, name: string) =>
  as<{ id: string }>(
    user,
    "select public.save_supplier($1, null, $2, 'orders@supplier.test', 21, 45, 1, 'order', '') as id",
    [tenant, name],
  ).then((rows) => rows[0].id);
const typed = (
  user: User,
  tenant: string,
  supplier: string,
  type: string,
  date: string,
  amount: number,
  stated: number | null,
  ref: string | null,
) =>
  as<{ id: string }>(
    user,
    "select public.save_ledger_entry($1, $2, $3, $4, $5, $6, $7, '') as id",
    [tenant, supplier, type, date, amount, stated, ref],
  ).then((rows) => rows[0].id);
const setSources = (user: User, tenant: string, body: Entry) =>
  as(user, "select public.save_config($1, 'stock', 'email_sources', $2::jsonb)", [
    tenant,
    JSON.stringify({ version: 1, ...body }),
  ]);
const connectGmail = (tenant: string, user: User, scopes: string[], account: string) =>
  db.query(
    "select public.save_connection($1, 'google_mail', $2, 'owner@studio.test', $3, '{}'::jsonb, $4)",
    [tenant, account, scopes, user.id],
  );

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  carol = { id: await createUser(db, "carol@a.test"), email: "carol@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, carol.id],
  );
  mill = await newSupplier(alice, tenantA, "Hill Mill");
  dyer = await newSupplier(alice, tenantA, "Dale Dyers");
  bobYard = await newSupplier(bob, tenantB, "Clay Yard");
});

describe("invoice numbers", () => {
  it("are compared the same way in the database and in the app", async () => {
    for (const ref of [
      "#10070",
      " 10070 ",
      "inv 10070",
      "Invoice #10070",
      "INV. 10070",
      "INV-2041",
      "inv-2041 a",
      "ka 12",
    ]) {
      const { rows } = await db.query<{ k: string }>("select private.ledger_ref_key($1) as k", [
        ref,
      ]);
      expect(rows[0].k, ref).toBe(normalizeInvoiceRef(ref));
    }
  });
});

describe("filing what was read from an email", () => {
  it("is for the service role only", async () => {
    for (const run of [
      () => as(alice, "select public.file_email_entries($1, null, '[]'::jsonb)", [tenantA]),
      () =>
        asAnon(db, (tx) =>
          tx.query("select public.file_email_entries($1, null, '[]'::jsonb)", [tenantA]),
        ),
      () => as(alice, "select public.claim_stock_email_reads(1)"),
      () => as(alice, "select public.receive_bills_mail('0123456789abcdef0123456789abcdef')"),
    ]) {
      await expect(run()).rejects.toThrow(/permission denied/);
    }
  });

  it("files an invoice with where it came from, and the same message twice files once", async () => {
    const k = freshKey();
    const first = await file(tenantA, message(k, { supplier_id: mill }), [
      invoice(k, mill, "INV-2041", 482.53),
    ]);
    expect(first).toMatchObject({ repeated: false, outcome: "filed" });
    expect(first.results[0].outcome).toBe("added");
    const again = await file(tenantA, message(k, { supplier_id: mill }), [
      invoice(k, mill, "INV-2041", 482.53),
    ]);
    expect(again).toEqual({ repeated: true, outcome: null, results: [] });
    expect(await ledger(mill)).toMatchObject([
      {
        type: "invoice",
        reference: "INV-2041",
        amount: "482.53",
        source: "email",
        mail_route: "gmail",
        mail_message_id: "18f0a1b2c3d4e5f6",
        needs_review: false,
      },
    ]);
    const { rows } = await db.query<{ outcome: string; sender: string }>(
      "select outcome, sender from public.stock_email_messages where message_key = $1",
      [k],
    );
    expect(rows).toEqual([{ outcome: "filed", sender: "billing@mill.test" }]);
  });

  it("does not add an invoice that another email already brought", async () => {
    const k = freshKey();
    const answer = await file(
      tenantA,
      message(k, { route: "forward", gmail_id: null, thread_id: null }),
      [invoice(k, mill, "inv-2041", 482.53)],
    );
    expect(answer.results[0].outcome).toBe("same");
    expect(answer.outcome).toBe("skipped");
    expect(await ledger(mill)).toHaveLength(1);
  });

  it("follows a revised copy of an emailed invoice and asks a person to look", async () => {
    const k = freshKey();
    const answer = await file(tenantA, message(k), [
      invoice(k, mill, "INV-2041", 490, { entry_date: "2026-11-03" }),
    ]);
    expect(answer.results[0].outcome).toBe("changed");
    expect(answer.outcome).toBe("to_check");
    const [row] = await ledger(mill);
    // The newest amount, the first date.
    expect(row).toMatchObject({ amount: "490.00", entry_date: "2026-10-27", needs_review: true });
    expect(row.review_note).toMatch(/earlier copy of INV-2041 said 482.53; this one says 490.00/);
  });

  it("leaves a typed-in invoice's figure alone and marks it to check", async () => {
    const id = await typed(alice, tenantA, mill, "invoice", "2026-10-20", 120, null, "INV-1999");
    const same = freshKey();
    expect(
      (await file(tenantA, message(same), [invoice(same, mill, "#INV-1999", 120)])).results[0]
        .outcome,
    ).toBe("same");
    const other = freshKey();
    const answer = await file(tenantA, message(other), [invoice(other, mill, "INV-1999", 125)]);
    expect(answer.results[0]).toMatchObject({ outcome: "flagged", id });
    const row = (await ledger(mill)).find((r) => r.id === id);
    expect(row).toMatchObject({ amount: "120.00", source: "manual", needs_review: true });
    expect(row?.review_note).toBe("A copy read from email says 125.00; this entry says 120.00.");
    expect((await ledger(mill)).filter((r) => r.reference?.includes("1999"))).toHaveLength(1);
  });

  it("lets a manager, and only a manager of that workspace, say an entry has been checked", async () => {
    const row = (await ledger(mill)).find((r) => r.reference === "INV-1999")!;
    await expect(
      as(carol, "select public.settle_ledger_review($1, $2)", [tenantA, row.id]),
    ).rejects.toThrow(/Only owners and admins/);
    await expect(
      as(bob, "select public.settle_ledger_review($1, $2)", [tenantA, row.id]),
    ).rejects.toThrow(/Only owners and admins/);
    await expect(
      as(bob, "select public.settle_ledger_review($1, $2)", [tenantB, row.id]),
    ).rejects.toThrow(/Entry not found/);
    await as(alice, "select public.settle_ledger_review($1, $2)", [tenantA, row.id]);
    expect((await ledger(mill)).find((r) => r.id === row.id)).toMatchObject({
      needs_review: false,
      review_note: null,
    });
  });

  it("the latest statement wins: what it covers is not filed, and an older statement is not filed", async () => {
    const k = freshKey();
    const answer = await file(tenantA, message(k, { subject: "Statement" }), [
      // Listed after the statement on purpose: statements are filed first.
      invoice(k, dyer, "D-10", 50, { entry_date: "2026-10-30" }),
      invoice(k, dyer, "D-11", 75, { entry_date: "2026-11-02" }),
      {
        supplier_id: dyer,
        type: "payment",
        entry_date: "2026-10-29",
        amount: 40,
        description: "The supplier's note that they received it",
        external_key: `mail:${k}:pay:2026-10-29:4000`,
        reported_by: "supplier",
      },
      {
        supplier_id: dyer,
        type: "statement",
        entry_date: "2026-11-01",
        amount: 0,
        stated_balance: 310.4,
        description: "Statement read from an email",
        external_key: `mail:${k}:stmt`,
      },
    ]);
    const by = Object.fromEntries(
      answer.results.map((r) => [r.external_key.split(":").slice(2).join(":"), r]),
    );
    expect(by.stmt.outcome).toBe("added");
    expect(by["inv:D-10"]).toMatchObject({ outcome: "covered", detail: "2026-11-01" });
    expect(by["inv:D-11"].outcome).toBe("added");
    expect(by["pay:2026-10-29:4000"]).toMatchObject({ outcome: "covered", detail: "2026-11-01" });

    const older = freshKey();
    const old = await file(tenantA, message(older), [
      {
        supplier_id: dyer,
        type: "statement",
        entry_date: "2026-10-01",
        amount: 0,
        stated_balance: 99,
        external_key: `mail:${older}:stmt`,
      },
    ]);
    expect(old.results[0]).toMatchObject({ outcome: "older_statement", detail: "2026-11-01" });
    // The same statement by another road is the same statement.
    const twin = freshKey();
    const dup = await file(
      tenantA,
      message(twin, { route: "forward", gmail_id: null, thread_id: null }),
      [
        {
          supplier_id: dyer,
          type: "statement",
          entry_date: "2026-11-01",
          amount: 0,
          stated_balance: 310.4,
          external_key: `mail:${twin}:stmt`,
        },
      ],
    );
    expect(dup.results[0].outcome).toBe("same");
    expect((await ledger(dyer)).map((r) => r.type).sort()).toEqual(["invoice", "statement"]);
  });

  it("files a payment notice once, and not one already written down", async () => {
    const pay = (k: string, over: Entry = {}) => ({
      supplier_id: dyer,
      type: "payment",
      entry_date: "2026-11-05",
      amount: 200,
      description: "Your bank's notice of a payment",
      external_key: `mail:${k}:bank:2026-11-05:20000`,
      reported_by: "bank",
      ...over,
    });
    const k = freshKey();
    expect((await file(tenantA, message(k), [pay(k)])).results[0].outcome).toBe("added");
    // The same notice forwarded as well: another message, the same payment.
    const fwd = freshKey();
    expect(
      (
        await file(tenantA, message(fwd, { route: "forward", gmail_id: null, thread_id: null }), [
          pay(fwd),
        ])
      ).results[0].outcome,
    ).toBe("have_already");
    // Typed in by hand within five days: the same payment.
    await typed(alice, tenantA, dyer, "payment", "2026-11-08", 75.5, null, null);
    const near = freshKey();
    expect(
      (
        await file(tenantA, message(near), [
          pay(near, {
            entry_date: "2026-11-10",
            amount: 75.5,
            external_key: `mail:${near}:bank:2026-11-10:7550`,
          }),
        ])
      ).results[0].outcome,
    ).toBe("have_already");
    const rows = (await ledger(dyer)).filter((r) => r.type === "payment");
    expect(rows.map((r) => [r.amount, r.source, r.reported_by])).toEqual([
      ["200.00", "email", "bank"],
      ["75.50", "manual", null],
    ]);
  });

  it("the books don't add a payment the bank's notice already brought", async () => {
    await setSources(alice, tenantA, {});
    await as(alice, "select public.save_config($1, 'stock', 'settings', $2::jsonb)", [
      tenantA,
      JSON.stringify({ version: 1, payments_from_books: true }),
    ]);
    const rows = await service<{ counts: { added: number; typed_already: number } }>(
      "select public.import_book_payments($1, 'quickbooks', $2::jsonb) as counts",
      [
        tenantA,
        JSON.stringify([
          {
            external_id: "9001",
            kind: "BillPayment",
            date: "2026-11-06",
            payee: "Dale Dyers",
            amount: 200,
            memo: "",
          },
        ]),
      ],
    );
    expect(rows[0].counts).toMatchObject({ added: 0, typed_already: 1 });
  });

  it("removed stays removed, even when another email brings the same invoice", async () => {
    const k = freshKey();
    const answer = await file(tenantA, message(k), [
      invoice(k, mill, "INV-3000", 64, { entry_date: "2026-11-04" }),
    ]);
    const id = answer.results[0].id!;
    await as(alice, "select public.remove_ledger_entry($1, $2)", [tenantA, id]);
    // The same message again (a second look would not even get here)...
    const { rows: gone } = await db.query(
      "delete from public.stock_email_messages where message_key = $1 returning id",
      [k],
    );
    expect(gone).toHaveLength(1);
    expect(
      (await file(tenantA, message(k), [invoice(k, mill, "INV-3000", 64)])).results[0].outcome,
    ).toBe("taken_off");
    // ...and another copy in a later email.
    const later = freshKey();
    expect(
      (await file(tenantA, message(later), [invoice(later, mill, "#inv-3000", 64)])).results[0]
        .outcome,
    ).toBe("taken_off");
    expect((await ledger(mill)).some((r) => r.reference?.includes("3000"))).toBe(false);
    // A person can still write it down themselves.
    await typed(alice, tenantA, mill, "invoice", "2026-11-04", 64, null, "INV-3000");
    expect((await ledger(mill)).filter((r) => r.reference === "INV-3000")).toHaveLength(1);
  });

  it("keeps an entry marked to check, and counts it from the start", async () => {
    const k = freshKey();
    const answer = await file(tenantA, message(k), [
      invoice(k, mill, "INV-3100", 30, {
        entry_date: "2026-11-05",
        needs_review: true,
        review_note: "The reader wasn't sure of the amount — check it.",
      }),
    ]);
    expect(answer.outcome).toBe("to_check");
    const row = (await ledger(mill)).find((r) => r.reference === "INV-3100");
    // It is an ordinary ledger row: the balance maths sees it like any other.
    expect(row).toMatchObject({ amount: "30.00", needs_review: true });
  });

  it("refuses an entry filed under another message's key, or for another workspace's supplier", async () => {
    const k = freshKey();
    const other = freshKey();
    await expect(file(tenantA, message(k), [invoice(other, mill, "INV-9", 5)])).rejects.toThrow(
      /not valid/,
    );
    await expect(file(tenantA, message(k), [invoice(k, bobYard, "INV-9", 5)])).rejects.toThrow(
      /Supplier not found/,
    );
    await expect(file(tenantB, message(k), [invoice(k, mill, "INV-9", 5)])).rejects.toThrow(
      /Supplier not found/,
    );
    await expect(file(tenantA, message(k, { supplier_id: bobYard }), [])).rejects.toThrow(
      /Supplier not found/,
    );
    await expect(
      file(tenantA, message(k), [invoice(k, mill, "INV-9", 5, { entry_date: "2031-01-01" })]),
    ).rejects.toThrow(/not valid/);
    expect(
      (await db.query("select 1 from public.stock_email_messages where message_key = $1", [k]))
        .rows,
    ).toEqual([]);
  });

  it("a look files nothing", async () => {
    const k = freshKey();
    const before = (await ledger(mill)).length;
    const answer = await file(
      tenantA,
      message(k),
      [invoice(k, mill, "INV-4000", 12, { entry_date: "2026-11-06" })],
      {
        confirm: false,
      },
    );
    expect(answer.results[0].outcome).toBe("added");
    expect(await ledger(mill)).toHaveLength(before);
    expect(
      (await db.query("select 1 from public.stock_email_messages where message_key = $1", [k]))
        .rows,
    ).toEqual([]);
  });

  it("files an uploaded file under its own source, once", async () => {
    const entry = invoice("x", mill, "INV-5000", 18, {
      entry_date: "2026-11-06",
      external_key: "upload:0123456789abcdef01234567:inv:INV-5000",
      description: "Read from an uploaded file",
    });
    expect((await file(tenantA, null, [entry], { actor: alice.id })).results[0].outcome).toBe(
      "added",
    );
    expect((await file(tenantA, null, [entry], { actor: alice.id })).results[0].outcome).toBe(
      "same",
    );
    expect((await ledger(mill)).find((r) => r.reference === "INV-5000")).toMatchObject({
      source: "upload",
      mail_route: null,
    });
    // An upload can't borrow a message's key.
    await expect(
      file(tenantA, null, [{ ...entry, external_key: `mail:${key(1)}:inv:INV-5000` }]),
    ).rejects.toThrow(/not valid/);
  });
});

describe("a message nobody could place", () => {
  const docs = [
    {
      kind: "invoice",
      reference: "Q-77",
      date: "2026-11-03",
      amountCents: 9900,
      currency: null,
      linesCents: null,
      balanceCents: null,
      balanceDate: null,
      sure: { reference: true, date: true, amount: true },
    },
  ];
  let pendingId: string;
  const k = key(7001);
  const waiting = (over: Entry = {}) =>
    message(k, {
      route: "forward",
      gmail_id: null,
      thread_id: null,
      sender: "owner@studio.test",
      subject: "Fwd: your bill",
      pending: { sent_day: "2026-11-04", documents: docs },
      ...over,
    });

  it("waits for a manager, with nothing on any account", async () => {
    const answer = await file(tenantA, waiting(), []);
    expect(answer.outcome).toBe("unassigned");
    const rows = await as<{ id: string; subject: string }>(
      alice,
      "select id, subject from public.stock_email_pending where tenant_id = $1",
      [tenantA],
    );
    expect(rows).toMatchObject([{ subject: "Fwd: your bill" }]);
    pendingId = rows[0].id;
  });

  it("is only seen and settled by that workspace's managers", async () => {
    for (const user of [carol, bob]) {
      expect(await as(user, "select id from public.stock_email_pending")).toEqual([]);
      expect(await as(user, "select id from public.stock_email_messages")).toEqual([]);
    }
    await expect(
      as(carol, "select public.discard_email_pending($1, $2)", [tenantA, pendingId]),
    ).rejects.toThrow(/Only owners and admins/);
    await expect(
      as(bob, "select public.discard_email_pending($1, $2)", [tenantB, pendingId]),
    ).rejects.toThrow(/not waiting/);
    // Another workspace can't file it either.
    await expect(
      file(
        tenantB,
        { message_key: k, route: "forward", supplier_id: bobYard },
        [invoice(k, bobYard, "Q-77", 99)],
        {
          pending: pendingId,
        },
      ),
    ).rejects.toThrow(/not waiting/);
  });

  it("is filed once a manager says whose it is, and stops waiting", async () => {
    const answer = await file(
      tenantA,
      { message_key: k, route: "forward", supplier_id: dyer },
      [invoice(k, dyer, "Q-77", 99, { entry_date: "2026-11-03" })],
      { pending: pendingId, actor: alice.id },
    );
    expect(answer.results[0].outcome).toBe("added");
    expect(
      await as(alice, "select id from public.stock_email_pending where tenant_id = $1", [tenantA]),
    ).toEqual([]);
    const { rows } = await db.query<{ outcome: string; supplier_id: string }>(
      "select outcome, supplier_id from public.stock_email_messages where message_key = $1",
      [k],
    );
    expect(rows).toEqual([{ outcome: "filed", supplier_id: dyer }]);
    expect((await ledger(dyer)).find((r) => r.reference === "Q-77")).toMatchObject({
      source: "email",
      mail_route: "forward",
      mail_message_id: null,
    });
  });

  it("can be put away instead", async () => {
    const k2 = key(7002);
    await file(tenantA, waiting({ message_key: k2 }), []);
    const [row] = await as<{ id: string }>(
      alice,
      "select id from public.stock_email_pending where tenant_id = $1",
      [tenantA],
    );
    await as(alice, "select public.discard_email_pending($1, $2)", [tenantA, row.id]);
    expect(
      await as(alice, "select id from public.stock_email_pending where tenant_id = $1", [tenantA]),
    ).toEqual([]);
    // Forwarded again, it is the same message: nothing new waits.
    expect((await file(tenantA, waiting({ message_key: k2 }), [])).repeated).toBe(true);
  });
});

describe("looks at Gmail", () => {
  const claim = () =>
    service<{ id: string; tenant_id: string; source: string }>(
      "select * from public.claim_stock_email_reads(5)",
    );
  const finish = (id: string, status = "done") =>
    service("select public.finish_stock_email_read($1, $2, $3::jsonb, $4::jsonb, null)", [
      id,
      status,
      JSON.stringify({ seen: 2, read: 1, filed: 1, to_check: 0, skipped: 1, capped: false }),
      JSON.stringify([{ what: "a waybill", reason: "not an invoice, statement or payment" }]),
    ]);

  it("are never made for a workspace that hasn't both switched reading on and granted it", async () => {
    await setSources(alice, tenantA, { enabled: true, read_hour: 0 });
    expect(await claim()).toEqual([]);
    await expect(
      as(alice, "select public.request_stock_email_read($1)", [tenantA]),
    ).rejects.toThrow(/not_on/);
    // Connected, but for sending only.
    await connectGmail(tenantA, alice, ["openid", "email", SEND], "gmail-a");
    expect(await claim()).toEqual([]);
    await expect(
      as(alice, "select public.request_stock_email_read($1)", [tenantA]),
    ).rejects.toThrow(/not_on/);
    // Granted, but switched off.
    await connectGmail(tenantA, alice, ["openid", "email", SEND, READ], "gmail-a");
    await setSources(alice, tenantA, { enabled: false, read_hour: 0 });
    expect(await claim()).toEqual([]);
  });

  it("happen once a day, at or after the hour the workspace chose", async () => {
    // An hour that hasn't come yet today, on the workspace's own clock.
    const { rows } = await db.query<{ hour: number }>(
      "select extract(hour from now() at time zone 'America/New_York')::int as hour",
    );
    if (rows[0].hour < 23) {
      await setSources(alice, tenantA, { enabled: true, read_hour: rows[0].hour + 1 });
      expect(await claim()).toEqual([]);
    }
    await setSources(alice, tenantA, { enabled: true, read_hour: 0 });
    const first = await claim();
    expect(first).toMatchObject([{ tenant_id: tenantA, source: "schedule" }]);
    // Claimed by one worker only, and not made again while it runs.
    expect(await claim()).toEqual([]);
    await finish(first[0].id);
    expect(await claim()).toEqual([]);
    const seen = await as<{ status: string; counts: { filed: number }; skipped: unknown[] }>(
      alice,
      "select status, counts, skipped from public.stock_email_reads where tenant_id = $1",
      [tenantA],
    );
    expect(seen).toMatchObject([{ status: "done", counts: { filed: 1 } }]);
    expect(seen[0].skipped).toHaveLength(1);
  });

  it("can be asked for by a manager, not too often", async () => {
    await expect(
      as(carol, "select public.request_stock_email_read($1)", [tenantA]),
    ).rejects.toThrow(/Only owners and admins/);
    await expect(as(bob, "select public.request_stock_email_read($1)", [tenantA])).rejects.toThrow(
      /Only owners and admins/,
    );
    await expect(
      as(alice, "select public.request_stock_email_read($1)", [tenantA]),
    ).rejects.toThrow(/too_soon/);
    await db.query(
      "update public.stock_email_reads set created_at = now() - interval '20 minutes'",
    );
    const [{ id }] = await as<{ id: string }>(
      alice,
      "select public.request_stock_email_read($1) as id",
      [tenantA],
    );
    // A second press finds the first.
    expect(
      (
        await as<{ id: string }>(alice, "select public.request_stock_email_read($1) as id", [
          tenantA,
        ])
      )[0].id,
    ).toBe(id);
    expect(await claim()).toMatchObject([{ id, source: "manual" }]);
    await finish(id, "failed");
    // Six a day at most.
    await db.query(
      `insert into public.stock_email_reads (tenant_id, status, source, created_at, finished_at)
       select $1, 'done', 'manual', now() - interval '2 hours', now() from generate_series(1, 5)`,
      [tenantA],
    );
    await db.query(
      "update public.stock_email_reads set created_at = created_at - interval '20 minutes'",
    );
    await expect(
      as(alice, "select public.request_stock_email_read($1)", [tenantA]),
    ).rejects.toThrow(/too_many/);
  });

  it("a look that never finished is marked failed, not run again", async () => {
    await db.query(
      "insert into public.stock_email_reads (tenant_id, status, source, started_at) values ($1, 'running', 'manual', now() - interval '2 hours')",
      [tenantA],
    );
    expect(await claim()).toEqual([]);
    const { rows } = await db.query<{ error: string }>(
      "select error from public.stock_email_reads where tenant_id = $1 and error is not null and status = 'failed' order by finished_at desc limit 1",
      [tenantA],
    );
    expect(rows[0].error).toBe("This read never finished.");
  });

  it("are not shown to members or to another workspace", async () => {
    for (const user of [carol, bob]) {
      expect(await as(user, "select id from public.stock_email_reads")).toEqual([]);
    }
    expect(await asAnon(db, async (tx) => tx.query("select 1").then(() => "ok"))).toBe("ok");
    await expect(
      asAnon(db, (tx) => tx.query("select id from public.stock_email_reads")),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("the bills address", () => {
  let tokenA: string;

  it("is made by a manager and read only by managers of that workspace", async () => {
    await expect(as(carol, "select public.make_bills_address($1)", [tenantA])).rejects.toThrow(
      /Only owners and admins/,
    );
    await expect(as(bob, "select public.make_bills_address($1)", [tenantA])).rejects.toThrow(
      /Only owners and admins/,
    );
    tokenA = (
      await as<{ t: string }>(alice, "select public.make_bills_address($1) as t", [tenantA])
    )[0].t;
    expect(tokenA).toMatch(/^[0-9a-f]{32}$/);
    expect(await as(alice, "select token from public.stock_bills_addresses")).toEqual([
      { token: tokenA },
    ]);
    for (const user of [carol, bob]) {
      expect(await as(user, "select token from public.stock_bills_addresses")).toEqual([]);
    }
    await expect(
      asAnon(db, (tx) => tx.query("select token from public.stock_bills_addresses")),
    ).rejects.toThrow(/permission denied/);
  });

  it("leads to its own workspace and no other", async () => {
    const tokenB = (
      await as<{ t: string }>(bob, "select public.make_bills_address($1) as t", [tenantB])
    )[0].t;
    expect(tokenB).not.toBe(tokenA);
    const lookup = (token: string) =>
      service<{ t: string | null }>("select public.receive_bills_mail($1) as t", [token]).then(
        (r) => r[0].t,
      );
    expect(await lookup(tokenA)).toBe(tenantA);
    expect(await lookup(tokenB)).toBe(tenantB);
    expect(await lookup("ffffffffffffffffffffffffffffffff")).toBeNull();
    expect(await lookup("not a token")).toBeNull();
    const [row] = await as<{ last: string | null }>(
      alice,
      "select last_received_at::text as last from public.stock_bills_addresses",
    );
    expect(row.last).not.toBeNull();
  });

  it("keeps Gmail's request to confirm it for a manager, and lets them put it away", async () => {
    await service(
      "select public.note_bills_confirmation($1, '481516234', 'https://mail-settings.google.com/mail/vf-made-up', 'owner@studio.test')",
      [tenantA],
    );
    expect(
      await as(
        alice,
        "select confirm_code, confirm_link, confirm_for from public.stock_bills_addresses",
      ),
    ).toEqual([
      {
        confirm_code: "481516234",
        confirm_link: "https://mail-settings.google.com/mail/vf-made-up",
        confirm_for: "owner@studio.test",
      },
    ]);
    await expect(
      as(carol, "select public.clear_bills_confirmation($1)", [tenantA]),
    ).rejects.toThrow(/Only owners and admins/);
    await as(alice, "select public.clear_bills_confirmation($1)", [tenantA]);
    expect(await as(alice, "select confirm_code from public.stock_bills_addresses")).toEqual([
      { confirm_code: null },
    ]);
  });

  it("a new address replaces the old one, which stops working; switching off forgets it", async () => {
    const next = (
      await as<{ t: string }>(alice, "select public.make_bills_address($1) as t", [tenantA])
    )[0].t;
    expect(next).not.toBe(tokenA);
    const lookup = (token: string) =>
      service<{ t: string | null }>("select public.receive_bills_mail($1) as t", [token]).then(
        (r) => r[0].t,
      );
    expect(await lookup(tokenA)).toBeNull();
    expect(await lookup(next)).toBe(tenantA);
    await as(alice, "select public.remove_bills_address($1)", [tenantA]);
    expect(await lookup(next)).toBeNull();
    // Bob's is untouched, and Bob can't remove Alice's.
    await expect(as(bob, "select public.remove_bills_address($1)", [tenantA])).rejects.toThrow(
      /Only owners and admins/,
    );
    expect(await as(bob, "select 1 as one from public.stock_bills_addresses")).toEqual([
      { one: 1 },
    ]);
  });
});
