import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createTestDb, createUser } from "./harness";

/**
 * The bookings file carries which texts the earlier app already sent, as it
 * carries the emails, so switching texts on soon after the import never
 * texts anyone twice. Where the file says nothing about a text, a message
 * whose email went counts as gone for the text too, and a class already over
 * never gets a thank-you text. The same file again changes nothing.
 */

type User = { id: string; email: string };
type Counts = {
  new: number;
  changed: number;
  same: number;
  refused: unknown[];
  emails_marked?: number;
  texts_marked?: number;
};

let db: PGlite;
let alice: User;
let tenant: string;
let workshop: string;
let soonDate: string;
let pastDate: string;

const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
const as = <T>(user: User, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);

const importBookings = async (rows: object[]): Promise<Counts> =>
  (
    await as<{ r: Counts }>(
      alice,
      "select public.import_bookings($1, gen_random_uuid(), $2::jsonb, 'bookings.csv', true) as r",
      [tenant, JSON.stringify(rows)],
    )
  )[0].r;

const WEEK_AGO = hoursFromNow(-24 * 7);
const person = (line: number, ref: string, session: string, more: object = {}) => ({
  line,
  ref,
  session_ref: session,
  name: `Person ${ref}`,
  email: `${ref}@example.com`,
  phone: "+12155550134",
  text_opt_in: true,
  seats: 1,
  status: "confirmed",
  source: "manual",
  created_at: WEEK_AGO,
  ...more,
});

const file = () => [
  // The earlier app texted the reminder.
  person(2, "t1", soonDate, {
    reminder_sent_at: hoursFromNow(-2),
    reminder_text_sent_at: hoursFromNow(-2),
  }),
  // The file says only that the reminder email went.
  person(3, "t2", soonDate, { reminder_sent_at: hoursFromNow(-2) }),
  // Nothing went yet.
  person(4, "t3", soonDate),
  // A class already over, with no thank-you sent.
  person(5, "t4", pastDate),
  // The earlier app sent the day-of text but not the email.
  person(6, "t5", soonDate, { day_of_text_sent_at: hoursFromNow(-1) }),
];

const textClaims = () =>
  service<{ booking_id: string; kind: string }>(
    "select booking_id, kind from public.claim_booking_text_sends(200)",
  );

const idOf = async (ref: string) =>
  (
    await db.query<{ id: string }>(
      "select id from public.bookings where tenant_id = $1 and import_ref = $2",
      [tenant, ref],
    )
  ).rows[0].id;

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@example.com"), email: "alice@example.com" };
  [{ id: tenant }] = await as<{ id: string }>(
    alice,
    "select id from public.create_tenant('Texts studio', 'UTC', 'USD')",
  );
  [{ id: workshop }] = await as<{ id: string }>(
    alice,
    "select public.save_service($1, null, 'workshop', 'Rug tufting', '', 60, 9000, 8, true) as id",
    [tenant],
  );
  [{ id: soonDate }] = await as<{ id: string }>(
    alice,
    "select public.add_session($1, $2, null) as id",
    [workshop, hoursFromNow(30)],
  );
  [{ id: pastDate }] = await as<{ id: string }>(
    alice,
    "select public.add_session($1, $2, null) as id",
    [workshop, hoursFromNow(40)],
  );
  await db.query(
    "update public.sessions set starts_at = now() - interval '50 hours', ends_at = now() - interval '48 hours' where id = $1",
    [pastDate],
  );
  await service(
    "select public.save_connection($1, 'twilio', $2, 'Twilio', '{}'::text[], $3::jsonb, $4, $5::jsonb)",
    [
      tenant,
      "AC" + "2".repeat(32),
      JSON.stringify({ access_token: "f".repeat(32), secrets: { sender: "+12155550199" } }),
      alice.id,
      JSON.stringify({ sender: "+12155550199", sender_kind: "number" }),
    ],
  );
});

describe("texts the earlier app already sent", () => {
  it("are written down with the import, so switching texts on sends none twice", async () => {
    const first = await importBookings(file());
    expect(first.new).toBe(5);
    // t1 reminder, t2 reminder (from its email), t4 thank-you (class over),
    // t5 day-of.
    expect(first.texts_marked).toBe(4);

    // Texts are switched on afterwards, every message.
    await as(alice, "select public.save_config($1, 'bookings', 'texts', $2::jsonb)", [
      tenant,
      JSON.stringify({
        version: 1,
        on: true,
        reminder_hours: 48,
        day_of_hours: 40,
        followup_hours: 1,
        messages: {
          confirmation: { on: true },
          reminder: { on: true },
          day_of: { on: true },
          followup: { on: true },
          cancelled: { on: true },
          moved: { on: true },
        },
      }),
    ]);
    const claimed = await textClaims();
    const t3 = await idOf("t3");
    const t5 = await idOf("t5");
    const got = claimed.map((c) => [c.booking_id, c.kind]).sort();
    expect(got).toEqual(
      [
        // The day-of text went for nobody but t5, so the others still get it.
        [await idOf("t1"), "day_of"],
        [await idOf("t2"), "day_of"],
        [t3, "reminder"],
        [t3, "day_of"],
        [t5, "reminder"],
      ].sort(),
    );

    const [{ n }] = (
      await db.query<{ n: number }>(
        "select count(*)::int as n from public.booking_texts where tenant_id = $1 and detail like 'Brought across%'",
        [tenant],
      )
    ).rows;
    expect(n).toBe(4);
  });

  it("the same file again changes nothing", async () => {
    const before = (
      await db.query<{ n: number }>(
        "select count(*)::int as n from public.booking_texts where tenant_id = $1",
        [tenant],
      )
    ).rows[0].n;
    const again = await importBookings(file());
    expect(again).toMatchObject({ new: 0, changed: 0, same: 5, texts_marked: 0 });
    const after = (
      await db.query<{ n: number }>(
        "select count(*)::int as n from public.booking_texts where tenant_id = $1",
        [tenant],
      )
    ).rows[0].n;
    expect(after).toBe(before);
  });
});
