import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createTestDb, createUser } from "./harness";

/**
 * "Pause messages to customers" (bookings / emails `paused`): while it is
 * on, nothing is handed out to send or stamped, by email or text. When it
 * comes off, nothing fires late in a heap:
 *   - a reminder (or day-of reminder) goes only while its class is still
 *     ahead and inside its usual lead time, as always;
 *   - a thank-you that fell due while paused is skipped;
 *   - a message set off by something that happened while paused (a refund's
 *     notice, a text) is never sent, and is written down as held.
 */

type User = { id: string; email: string };
type Claim = { booking_id: string; kind: string };

let db: PGlite;
let alice: User;
let tenant: string;
let other: string;
let workshop: string;
let n = 0;

const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
const as = <T>(user: User, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);

const EMAILS = { version: 1, reminder_hours: 24, followup_on: true, followup_hours: 1 };
const setEmails = (t: string, body: object) =>
  as(alice, "select public.save_config($1, 'bookings', 'emails', $2::jsonb)", [
    t,
    JSON.stringify(body),
  ]);

/** A date of the workshop, starting `hours` from now (negative: over), an hour long. */
async function date(hours: number, svc = workshop): Promise<string> {
  const [{ id }] = await as<{ id: string }>(
    alice,
    "select public.add_session($1, $2, null) as id",
    [svc, hoursFromNow(100)],
  );
  await db.query(
    "update public.sessions set starts_at = $2, ends_at = $2::timestamptz + interval '1 hour' where id = $1",
    [id, hoursFromNow(hours)],
  );
  return id;
}

/** A booking made a week ago, with texts agreed. */
async function book(session: string): Promise<string> {
  n += 1;
  const [{ id }] = await as<{ id: string }>(
    alice,
    "select public.add_manual_booking($1, $2, $3, 1, '', $4, true) as id",
    [session, `Person ${n}`, `p${n}@example.com`, `pause-token-${n}-${"x".repeat(20)}`],
  );
  const [{ t }] = await db
    .query<{ t: string }>("select tenant_id as t from public.bookings where id = $1", [id])
    .then((r) => r.rows);
  await service("select public.set_booking_text_consent($1, $2, '+12155550134', true)", [t, id]);
  await db.query(
    "update public.bookings set created_at = now() - interval '7 days', confirmed_at = now() - interval '7 days' where id = $1",
    [id],
  );
  return id;
}

const emails = () =>
  service<Claim>("select booking_id, kind from public.claim_booking_email_sends(200)");
const texts = () =>
  service<Claim>("select booking_id, kind from public.claim_booking_text_sends(200)");
const mine = (claims: Claim[], ids: string[]) =>
  claims
    .filter((c) => ids.includes(c.booking_id))
    .map((c) => [ids.indexOf(c.booking_id), c.kind])
    .sort();

/** Moves the times this workspace's emails settings were saved: paused, then resumed. */
async function pausedBetween(t: string, fromHoursAgo: number, toHoursAgo: number) {
  await db.query(
    `update public.config_versions set created_at = case
       when (body -> 'paused') = 'true'::jsonb then now() - make_interval(hours => $2)
       else now() - make_interval(hours => $3) end
     where tenant_id = $1 and module = 'bookings' and key = 'emails'
       and created_at > now() - interval '1 minute'`,
    [t, fromHoursAgo, toHoursAgo],
  );
}

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@example.com"), email: "alice@example.com" };
  [{ id: tenant }] = await as<{ id: string }>(
    alice,
    "select id from public.create_tenant('Pause studio', 'UTC', 'USD')",
  );
  [{ id: other }] = await as<{ id: string }>(
    alice,
    "select id from public.create_tenant('Other studio', 'UTC', 'USD')",
  );
  [{ id: workshop }] = await as<{ id: string }>(
    alice,
    "select public.save_service($1, null, 'workshop', 'Rug tufting', '', 60, 9000, 8, true) as id",
    [tenant],
  );
  for (const [t, account] of [
    [tenant, "AC" + "3".repeat(32)],
    [other, "AC" + "4".repeat(32)],
  ]) {
    await service(
      "select public.save_connection($1, 'twilio', $2, 'Twilio', '{}'::text[], $3::jsonb, $4, $5::jsonb)",
      [
        t,
        account,
        JSON.stringify({ access_token: "f".repeat(32), secrets: { sender: "+12155550199" } }),
        alice.id,
        JSON.stringify({ sender: "+12155550199", sender_kind: "number" }),
      ],
    );
    await as(alice, "select public.save_config($1, 'bookings', 'texts', $2::jsonb)", [
      t,
      JSON.stringify({
        version: 1,
        on: true,
        reminder_hours: 24,
        followup_hours: 1,
        messages: {
          confirmation: { on: true },
          reminder: { on: true },
          day_of: { on: false },
          followup: { on: true },
          cancelled: { on: true },
          moved: { on: true },
        },
      }),
    ]);
  }
});

describe("pausing messages to customers", () => {
  it("hands nothing out and stamps nothing while paused, in that workspace only", async () => {
    await setEmails(tenant, { ...EMAILS, paused: true });
    await setEmails(other, EMAILS);
    const reminderDue = await book(await date(10));
    const thanksDue = await book(await date(-3));
    const [{ id: otherWorkshop }] = await as<{ id: string }>(
      alice,
      "select public.save_service($1, null, 'workshop', 'Other', '', 60, 9000, 8, true) as id",
      [other],
    );
    const elsewhere = await book(await date(10, otherWorkshop));

    expect(mine(await emails(), [reminderDue, thanksDue, elsewhere])).toEqual([[2, "reminder"]]);
    expect(mine(await texts(), [reminderDue, thanksDue, elsewhere])).toEqual([[2, "reminder"]]);
    const stamped = await db.query<{ reminder_sent_at: string | null }>(
      "select reminder_sent_at from public.bookings where id = $1",
      [reminderDue],
    );
    expect(stamped.rows[0].reminder_sent_at).toBeNull();
    const rows = await db.query(
      "select 1 from public.booking_emails where booking_id = any($1) union all select 1 from public.booking_texts where booking_id = any($1) and kind <> 'confirmation'",
      [[reminderDue, thanksDue]],
    );
    expect(rows.rows).toEqual([]);
  });

  it("when it comes off, sends what is still timely and skips what fell due while paused", async () => {
    // Paused from 10 hours ago until 3 hours ago.
    await setEmails(tenant, { ...EMAILS, paused: true });
    await setEmails(tenant, { ...EMAILS, paused: false });
    await pausedBetween(tenant, 10, 3);

    const stillAhead = await book(await date(5)); // its reminder fell due while paused
    const started = await book(await date(-0.5)); // started: no reminder now
    const thanksMissed = await book(await date(-7)); // thank-you due 5 hours ago
    const thanksAfter = await book(await date(-3.5)); // thank-you due 1.5 hours ago
    const ids = [stillAhead, started, thanksMissed, thanksAfter];

    expect(mine(await emails(), ids)).toEqual([
      [0, "reminder"],
      [3, "followup"],
    ]);
    expect(mine(await texts(), ids)).toEqual([
      [0, "reminder"],
      [3, "followup"],
    ]);
    // Asked again: nothing more, ever, for what was skipped.
    expect(mine(await emails(), ids)).toEqual([]);
    expect(mine(await texts(), ids)).toEqual([]);
  });

  it("never sends late what something set off while paused, and says why", async () => {
    await setEmails(tenant, { ...EMAILS, paused: true });
    const s = await date(48);
    const refunded = await book(s);
    await db.query(
      "update public.bookings set status = 'cancelled', shop_order_id = 'x1' where id = $1",
      [refunded],
    );
    const [{ q }] = await service<{ q: boolean }>(
      "select public.queue_booking_cancel_email($1, $2) as q",
      [tenant, refunded],
    );
    expect(q).toBe(true);
    await service("select public.queue_booking_text($1, $2, 'cancelled')", [tenant, refunded]);
    expect(mine(await emails(), [refunded])).toEqual([]);
    expect(mine(await texts(), [refunded])).toEqual([]);

    await setEmails(tenant, { ...EMAILS, paused: false });
    expect(mine(await emails(), [refunded])).toEqual([]);
    expect(mine(await texts(), [refunded])).toEqual([]);
    const held = await db.query<{ status: string; detail: string }>(
      "select status, detail from public.booking_emails where booking_id = $1 union all select status, detail from public.booking_texts where booking_id = $1",
      [refunded],
    );
    expect(held.rows).toHaveLength(2);
    for (const row of held.rows) {
      expect(row.status).toBe("failed");
      expect(row.detail).toMatch(/paused/);
    }

    // Something set off after the pause goes as usual.
    const later = await book(s);
    await db.query(
      "update public.bookings set status = 'cancelled', shop_order_id = 'x2' where id = $1",
      [later],
    );
    await service("select public.queue_booking_cancel_email($1, $2)", [tenant, later]);
    expect(mine(await emails(), [later])).toEqual([[0, "cancelled"]]);
  });
});
