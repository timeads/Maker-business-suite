import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Booking texts, in the database:
 *   - nothing is handed out until texts, the message and Twilio are all on;
 *   - only to a booking whose person ticked the box and gave a number;
 *   - each text once per booking, message and date; a refusal is tried again
 *     a few times, a claim never finished is "unsure" and never resent;
 *   - a STOP is kept once per Twilio message and takes that workspace's
 *     bookings off, and no other workspace's;
 *   - the test text is limited, and only managers may send one;
 *   - nobody but the server can queue, claim or finish, and no workspace
 *     sees another's.
 */
type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let carol: User; // member of A
let bob: User; // owner of B
let tenantA: string;
let tenantB: string;
let workshopA: string;
let workshopB: string;
let n = 0;

const ACCOUNT_A = `AC${"a".repeat(32)}`;
const ACCOUNT_B = `AC${"b".repeat(32)}`;
const sid = (c: string) => `SM${c.repeat(32)}`;
const soon = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();

const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
const as = <T>(user: User, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);
/** As the database's owner, for setting the clock back on a row. */
const owner = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

async function tenantFor(user: User, name: string): Promise<string> {
  const rows = await as<{ id: string }>(
    user,
    "select id from public.create_tenant($1, 'America/New_York', 'USD')",
    [name],
  );
  return rows[0].id;
}

async function workshop(user: User, tenant: string): Promise<string> {
  n += 1;
  const rows = await as<{ id: string }>(
    user,
    "select public.save_service($1, null, 'workshop', $2, '', 120, 0, 8, true) as id",
    [tenant, `Workshop ${n}`],
  );
  return rows[0].id;
}

async function date(user: User, serviceId: string, hours: number): Promise<string> {
  const rows = await as<{ id: string }>(user, "select public.add_session($1, $2, null) as id", [
    serviceId,
    soon(hours),
  ]);
  return rows[0].id;
}

/** A booking made a week ago, with or without a number and the tick. */
async function booking(
  user: User,
  tenant: string,
  sessionId: string,
  phone: string,
  agreed: boolean,
): Promise<string> {
  n += 1;
  const rows = await as<{ id: string }>(
    user,
    "select public.add_manual_booking($1, $2, $3, 1, '', $4, true) as id",
    [sessionId, `Person ${n}`, `person${n}@example.com`, `token-${n}-${"x".repeat(20)}`],
  );
  const id = rows[0].id;
  await service("select public.set_booking_text_consent($1, $2, $3, $4)", [
    tenant,
    id,
    phone,
    agreed,
  ]);
  await owner(
    "update public.bookings set created_at = now() - interval '7 days', confirmed_at = now() - interval '7 days' where id = $1",
    [id],
  );
  return id;
}

const connectTwilio = (tenant: string, user: User, account: string) =>
  service(
    "select public.save_connection($1, 'twilio', $2, 'Twilio', '{}'::text[], $3::jsonb, $4, $5::jsonb)",
    [
      tenant,
      account,
      JSON.stringify({ access_token: "f".repeat(32), secrets: { sender: "+12155550199" } }),
      user.id,
      JSON.stringify({ sender: "+12155550199", sender_kind: "number" }),
    ],
  );

const settings = (user: User, tenant: string, body: object) =>
  as(user, "select public.save_config($1, 'bookings', 'texts', $2::jsonb)", [
    tenant,
    JSON.stringify({ version: 1, ...body }),
  ]);
const ON = {
  on: true,
  reminder_hours: 48,
  messages: {
    confirmation: { on: true },
    reminder: { on: true },
    day_of: { on: false },
    followup: { on: false },
    cancelled: { on: true },
    moved: { on: true },
  },
};

type Claim = {
  send_id: string;
  booking_id: string;
  tenant_id: string;
  kind: string;
  tries: number;
};
const claim = () => service<Claim>("select * from public.claim_booking_text_sends(50)");
const finish = (id: string, outcome: string, detail = "", provider: string | null = null) =>
  service<{ r: { status: string; final: boolean; changed: boolean } }>(
    "select public.finish_booking_text_send($1, $2, $3, $4) as r",
    [id, outcome, detail, provider],
  ).then((rows) => rows[0].r);

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@example.com"), email: "alice@example.com" };
  carol = { id: await createUser(db, "carol@example.com"), email: "carol@example.com" };
  bob = { id: await createUser(db, "bob@example.com"), email: "bob@example.com" };
  tenantA = await tenantFor(alice, "Alice Studio");
  tenantB = await tenantFor(bob, "Bob Studio");
  await owner(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, carol.id],
  );
  workshopA = await workshop(alice, tenantA);
  workshopB = await workshop(bob, tenantB);
});

describe("booking texts", () => {
  let tomorrow: string;
  let texted: string;
  let noTick: string;
  let noNumber: string;

  it("hands out nothing until texts, the message and Twilio are all on", async () => {
    tomorrow = await date(alice, workshopA, 24);
    texted = await booking(alice, tenantA, tomorrow, "(215) 555-0134", true);
    noTick = await booking(alice, tenantA, tomorrow, "215-555-0135", false);
    noNumber = await booking(alice, tenantA, tomorrow, "", true);
    expect(await claim()).toEqual([]);
    await settings(alice, tenantA, ON);
    // Switched on, but no Twilio yet.
    expect(await claim()).toEqual([]);
    expect(
      (
        await service<{ r: string }>(
          "select public.queue_booking_text($1, $2, 'confirmation') as r",
          [tenantA, texted],
        )
      )[0].r,
    ).toBe("off");
    await connectTwilio(tenantA, alice, ACCOUNT_A);
  });

  it("reminds once, only the person who ticked the box and gave a number", async () => {
    const first = await claim();
    expect(first.map((c) => [c.booking_id, c.kind, c.tries])).toEqual([[texted, "reminder", 1]]);
    expect(first.some((c) => c.booking_id === noTick || c.booking_id === noNumber)).toBe(false);
    expect(await claim()).toEqual([]);
    const done = await finish(first[0].send_id, "sent", "", sid("1"));
    expect(done).toEqual({ status: "sent", final: true, changed: true });
    // A late answer for the same text changes nothing.
    expect((await finish(first[0].send_id, "refused", "late")).changed).toBe(false);
    expect(await claim()).toEqual([]);
    const [row] = await service<{ status: string; provider_id: string }>(
      "select status, provider_id from public.booking_texts where id = $1",
      [first[0].send_id],
    );
    expect(row).toEqual({ status: "sent", provider_id: sid("1") });
  });

  it("doesn't remind someone who booked inside the reminder's own stretch", async () => {
    const soonDate = await date(alice, workshopA, 30);
    const late = await booking(alice, tenantA, soonDate, "+12155550140", true);
    await owner(
      "update public.bookings set confirmed_at = now() - interval '1 hour' where id = $1",
      [late],
    );
    expect((await claim()).map((c) => c.booking_id)).not.toContain(late);
  });

  it("tries a refusal again a few times, then leaves it for a person", async () => {
    const later = await date(alice, workshopA, 40);
    const id = await booking(alice, tenantA, later, "+12155550141", true);
    const [first] = await claim();
    expect(first.booking_id).toBe(id);
    expect(await finish(first.send_id, "refused", "Twilio said: busy")).toMatchObject({
      status: "failed",
      final: false,
    });
    expect(await claim()).toEqual([]);
    for (let tries = 2; tries <= 3; tries += 1) {
      await owner(
        "update public.booking_texts set next_try_at = now() - interval '1 minute' where id = $1",
        [first.send_id],
      );
      const [again] = await claim();
      expect(again).toMatchObject({ send_id: first.send_id, tries });
      const result = await finish(first.send_id, "refused", "Twilio said: busy");
      expect(result.final).toBe(tries === 3);
    }
    await owner(
      "update public.booking_texts set next_try_at = now() - interval '1 minute' where id = $1",
      [first.send_id],
    );
    expect(await claim()).toEqual([]);
  });

  it("never resends one we never heard back about", async () => {
    const other = await date(alice, workshopA, 41);
    const id = await booking(alice, tenantA, other, "+12155550142", true);
    const [first] = await claim();
    expect(first.booking_id).toBe(id);
    await owner(
      "update public.booking_texts set claimed_at = now() - interval '20 minutes' where id = $1",
      [first.send_id],
    );
    expect(await claim()).toEqual([]);
    const [row] = await service<{ status: string }>(
      "select status from public.booking_texts where id = $1",
      [first.send_id],
    );
    expect(row.status).toBe("unsure");
    expect(await claim()).toEqual([]);
  });

  it("queues texts something set off, once, and only where they are wanted", async () => {
    const queue = async (booking: string, kind: string) =>
      (
        await service<{ r: string }>("select public.queue_booking_text($1, $2, $3) as r", [
          tenantA,
          booking,
          kind,
        ])
      )[0].r;
    expect(await queue(texted, "confirmation")).toBe("queued");
    expect(await queue(texted, "confirmation")).toBe("already");
    expect(await queue(noTick, "confirmation")).toBe("skipped");
    // Another workspace's booking is never found from here.
    const theirs = await booking(
      bob,
      tenantB,
      await date(bob, workshopB, 24),
      "+12155550150",
      true,
    );
    expect(await queue(theirs, "confirmation")).toBe("skipped");
    await expect(queue(texted, "reminder")).rejects.toThrow(/Unknown text/);
    const claimed = await claim();
    expect(claimed.map((c) => [c.booking_id, c.kind])).toEqual([[texted, "confirmation"]]);
    await finish(claimed[0].send_id, "rejected", "Twilio said: not a mobile number");
    // A text refused for good is never handed out again.
    const [row] = await service<{ status: string; next_try_at: string | null }>(
      "select status, next_try_at from public.booking_texts where id = $1",
      [claimed[0].send_id],
    );
    expect(row).toEqual({ status: "failed", next_try_at: null });
    expect(await claim()).toEqual([]);
  });

  it("keeps a STOP once and takes that workspace's bookings off, no other's", async () => {
    await connectTwilio(tenantB, bob, ACCOUNT_B);
    const theirs = await booking(
      bob,
      tenantB,
      await date(bob, workshopB, 26),
      "+12155550134",
      true,
    );
    const [{ t }] = await service<{ t: string }>("select public.twilio_workspace_for($1) as t", [
      ACCOUNT_A,
    ]);
    expect(t).toBe(tenantA);
    const enqueue = () =>
      service<{ r: boolean }>(
        "select public.enqueue_twilio_inbound($1, $2, '+12155550134', '+12155550199') as r",
        [tenantA, sid("9")],
      );
    expect((await enqueue())[0].r).toBe(true);
    expect((await enqueue())[0].r).toBe(false);
    const replies = await service<{ id: string; tenant_id: string; from_phone: string }>(
      "select * from public.claim_twilio_inbound(10)",
    );
    expect(replies).toEqual([
      { id: replies[0].id, tenant_id: tenantA, from_phone: "+12155550134" },
    ]);
    // Even handed another workspace's booking, only this workspace's are touched.
    const [{ r }] = await service<{ r: number }>("select public.apply_text_opt_out($1, $2) as r", [
      replies[0].id,
      [texted, theirs],
    ]);
    expect(r).toBe(1);
    const flags = await owner("select id, text_opt_in from public.bookings where id = any($1)", [
      [texted, theirs],
    ]);
    const rows = flags as { id: string; text_opt_in: boolean }[];
    expect(Object.fromEntries(rows.map((row) => [row.id, row.text_opt_in]))).toEqual({
      [texted]: false,
      [theirs]: true,
    });
    expect(await as(alice, "select phone from public.booking_text_opt_outs")).toEqual([
      { phone: "+12155550134" },
    ]);
    expect(await as(bob, "select phone from public.booking_text_opt_outs")).toEqual([]);
    expect(await service("select * from public.claim_twilio_inbound(10)")).toEqual([]);
  });

  it("lets a manager send three test texts an hour, and nobody else any", async () => {
    const tryOne = () =>
      as<{ ok: boolean }>(alice, "select public.claim_test_text($1) as ok", [tenantA]).then(
        (rows) => rows[0].ok,
      );
    expect([await tryOne(), await tryOne(), await tryOne(), await tryOne()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    await expect(as(carol, "select public.claim_test_text($1)", [tenantA])).rejects.toThrow(
      /owners and admins/,
    );
    await expect(as(bob, "select public.claim_test_text($1)", [tenantA])).rejects.toThrow(
      /owners and admins/,
    );
  });

  it("is only the server's to queue, claim and finish, and each workspace sees only its own", async () => {
    for (const sql of [
      "select * from public.claim_booking_text_sends(5)",
      `select public.queue_booking_text('${tenantA}', '${texted}', 'confirmation')`,
      `select public.set_booking_text_consent('${tenantA}', '${texted}', '+12155550134', true)`,
      `select public.twilio_workspace_for('${ACCOUNT_A}')`,
      "select * from public.claim_twilio_inbound(5)",
    ]) {
      await expect(as(alice, sql), sql).rejects.toThrow(/permission denied/);
    }
    await expect(
      asAnon(db, (tx) => tx.query("select * from public.booking_texts")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(
        alice,
        "insert into public.booking_texts (tenant_id, booking_id, session_id, kind, status) values ($1, $2, $3, 'reminder', 'sent')",
        [tenantA, texted, tomorrow],
      ),
    ).rejects.toThrow(/permission denied/);
    expect((await as(alice, "select id from public.booking_texts")).length).toBeGreaterThan(0);
    expect((await as(carol, "select id from public.booking_texts")).length).toBeGreaterThan(0);
    expect(await as(bob, "select id from public.booking_texts")).toEqual([]);
    await expect(as(alice, "select * from private.twilio_inbound")).rejects.toThrow(
      /permission denied/,
    );
  });
});
