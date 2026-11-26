import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };
type Claim = { send_id: string; tenant_id: string; user_id: string; email: string; day: string };

let db: PGlite;
let alice: User;
let mel: User;
let bob: User;
let stranger: User;
let tenantA: string;
let tenantB: string;

const as = <T>(user: User, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);
const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);

const claim = (at: string) =>
  service<Claim>(
    "select send_id, tenant_id, user_id, email, day::text as day from public.claim_booking_daily_emails($1::timestamptz)",
    [at],
  );
const finish = (id: string, outcome: string, detail = "") =>
  service<{ r: string }>("select public.finish_booking_daily_email($1, $2, $3) as r", [
    id,
    outcome,
    detail,
  ]).then((rows) => rows[0].r);

async function settings(owner: User, tenant: string, body: object) {
  await as(owner, "select public.save_config($1, 'bookings', 'daily_email', $2::jsonb)", [
    tenant,
    JSON.stringify(body),
  ]);
}

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  mel = { id: await createUser(db, "mel@a.test"), email: "mel@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  stranger = { id: await createUser(db, "x@x.test"), email: "x@x.test" };
  const make = async (owner: User, name: string) =>
    (
      await as<{ id: string }>(
        owner,
        "select id from public.create_tenant($1, 'America/New_York', 'USD')",
        [name],
      )
    )[0].id;
  tenantA = await make(alice, "Alice Rugs");
  tenantB = await make(bob, "Bob Pottery");
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, mel.id],
  );
});

describe("the owner's daily email", () => {
  it("is off until switched on", async () => {
    expect(await claim("2027-03-10T15:00:00Z")).toEqual([]);
  });

  it("goes once a day at the chosen local hour, across the spring clock change", async () => {
    // Bob is not a member of A; the stranger is nobody's. Neither gets A's email.
    await settings(alice, tenantA, {
      version: 1,
      on: true,
      hour: 7,
      recipients: [alice.id, mel.id, bob.id, stranger.id, alice.id],
    });
    // 14 March 2027 is the day New York's clocks go forward. 10:30 UTC is 6:30 EDT.
    expect(await claim("2027-03-14T10:30:00Z")).toEqual([]);
    // 11:05 UTC is 7:05 EDT: due, for Alice and Mel only, for the 14th.
    const due = await claim("2027-03-14T11:05:00Z");
    expect(due.map((c) => c.email).sort()).toEqual(["alice@a.test", "mel@a.test"]);
    expect(due.every((c) => c.day === "2027-03-14" && c.tenant_id === tenantA)).toBe(true);
    // Never twice for the same day, however often the worker asks.
    expect(await claim("2027-03-14T11:10:00Z")).toEqual([]);
    for (const c of due) expect(await finish(c.send_id, "sent")).toBe("sent");
    expect(await claim("2027-03-14T23:59:00Z")).toEqual([]);
    // The next morning, again.
    expect(await claim("2027-03-15T11:05:00Z")).toHaveLength(2);
  });

  it("follows the autumn change too: 7 a.m. is an hour later in UTC", async () => {
    await settings(alice, tenantA, { version: 1, on: true, hour: 7, recipients: [alice.id] });
    // 7 November 2027: clocks go back. 11:30 UTC is 6:30 EST.
    expect(await claim("2027-11-07T11:30:00Z")).toEqual([]);
    const due = await claim("2027-11-07T12:05:00Z");
    expect(due.map((c) => c.day)).toEqual(["2027-11-07"]);
  });

  it("tries a refusal again later that day, never an unsure one", async () => {
    await settings(alice, tenantA, { version: 1, on: true, hour: 9, recipients: [alice.id] });
    const [first] = await claim("2027-05-03T13:30:00Z");
    expect(await finish(first.send_id, "refused", "The mail service refused it (500).")).toBe(
      "failed",
    );
    // The next try is set from the database's own clock; bring it forward to "now".
    await db.query("update public.booking_daily_emails set next_try_at = $2 where id = $1", [
      first.send_id,
      "2027-05-03T13:40:00Z",
    ]);
    const [again] = await claim("2027-05-03T13:45:00Z");
    expect(again.send_id).toBe(first.send_id);
    expect(await finish(again.send_id, "unsure")).toBe("unsure");
    await db.query("update public.booking_daily_emails set next_try_at = $2 where id = $1", [
      first.send_id,
      "2027-05-03T13:40:00Z",
    ]);
    expect(await claim("2027-05-03T14:30:00Z")).toEqual([]);
    // A late answer never overwrites what was written down.
    expect(await finish(first.send_id, "sent")).toBe("unsure");
  });

  it("marks a claim nobody finished as unsure, and stops for someone taken off the list", async () => {
    await settings(alice, tenantA, { version: 1, on: true, hour: 8, recipients: [mel.id] });
    const [c] = await claim("2027-06-01T12:30:00Z");
    await claim("2027-06-01T13:00:00Z");
    const [row] = await db
      .query<{ status: string }>("select status from public.booking_daily_emails where id = $1", [
        c.send_id,
      ])
      .then((r) => r.rows);
    expect(row.status).toBe("unsure");
    await settings(alice, tenantA, { version: 1, on: true, hour: 8, recipients: [] });
    expect(await claim("2027-06-02T12:30:00Z")).toEqual([]);
  });

  it("is read only by its own workspace, written by nobody but the server", async () => {
    expect((await as(alice, "select id from public.booking_daily_emails")).length).toBeGreaterThan(
      0,
    );
    expect(await as(bob, "select id from public.booking_daily_emails")).toHaveLength(0);
    for (const sql of [
      `insert into public.booking_daily_emails (tenant_id, user_id, day, status) values ('${tenantA}', '${alice.id}', '2030-01-01', 'sent')`,
      "update public.booking_daily_emails set status = 'sent'",
      "delete from public.booking_daily_emails",
      "select * from public.claim_booking_daily_emails()",
    ]) {
      await expect(as(alice, sql), sql).rejects.toThrow(/permission denied/i);
    }
    await expect(
      asAnon(db, (tx) => tx.query("select id from public.booking_daily_emails")),
    ).rejects.toThrow(/permission denied/i);
    // Bob can't switch it on for A, or pick A's people.
    await expect(
      settings(bob, tenantA, { version: 1, on: true, hour: 7, recipients: [bob.id] }),
    ).rejects.toThrow();
    // Mel is a member, not an owner or admin: she can't choose who gets it.
    await expect(
      settings(mel, tenantA, { version: 1, on: true, hour: 7, recipients: [mel.id] }),
    ).rejects.toThrow();
    expect(tenantB).toBeTruthy();
  });
});
