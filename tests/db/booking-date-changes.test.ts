import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };
type Claim = { send_id: string; booking_id: string; kind: string };

let db: PGlite;
let alice: User;
let member: User;
let bob: User;
let tenantA: string;
let tenantB: string;
let n = 0;

const soon = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
const as = <T>(user: User, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);
const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);

async function tenantFor(owner: User, name: string): Promise<string> {
  const rows = await as<{ id: string }>(
    owner,
    "select id from public.create_tenant($1, 'America/New_York', 'USD')",
    [name],
  );
  return rows[0].id;
}

async function workshop(owner: User, tenant: string, capacity = 8) {
  n += 1;
  const rows = await as<{ id: string }>(
    owner,
    "select public.save_service($1, null, 'workshop', $2, '', 120, 0, $3, true) as id",
    [tenant, `Workshop ${n}`, capacity],
  );
  return rows[0].id;
}

async function date(owner: User, serviceId: string, hours: number): Promise<string> {
  const rows = await as<{ id: string }>(owner, "select public.add_session($1, $2, null) as id", [
    serviceId,
    soon(hours),
  ]);
  return rows[0].id;
}

async function hold(tenant: string, session: string, seats: number) {
  n += 1;
  const rows = await service<{ id: string }>(
    "select id from public.hold_booking($1, $2, null, null, 'Pat', $3, $4, '{}', $5)",
    [tenant, session, `pat${n}@example.com`, seats, `hold-token-${n}`],
  );
  return rows[0].id;
}

const sessionRow = async (id: string) =>
  (
    await db.query<{ starts_at: Date; ends_at: Date; capacity: number }>(
      "select starts_at, ends_at, capacity from public.sessions where id = $1",
      [id],
    )
  ).rows[0];

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  member = { id: await createUser(db, "mel@a.test"), email: "mel@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, member.id],
  );
});

describe("a place on each workshop", () => {
  it("is set by managers of its own workspace and reaches the shop's picker", async () => {
    const svc = await workshop(alice, tenantA);
    await as(alice, "select public.set_service_location($1, $2)", [
      svc,
      "  Studio 2,   4th floor ",
    ]);
    const [row] = await as<{ location: string }>(
      alice,
      "select location from public.services where id = $1",
      [svc],
    );
    expect(row.location).toBe("Studio 2, 4th floor");
    await expect(as(member, "select public.set_service_location($1, 'x')", [svc])).rejects.toThrow(
      /owners and admins/i,
    );
    await expect(as(bob, "select public.set_service_location($1, 'x')", [svc])).rejects.toThrow(
      /not found/i,
    );
    await as(alice, "select public.set_service_shop_product($1, '4001', null)", [svc]);
    const [{ r }] = await service<{ r: { service: { location: string } } }>(
      "select public.shop_booking_dates($1, '4001') as r",
      [tenantA],
    );
    expect(r.service.location).toBe("Studio 2, 4th floor");
  });
});

describe("changing a date's day or time", () => {
  it("moves it, keeping its length and everyone on it", async () => {
    const svc = await workshop(alice, tenantA);
    const id = await date(alice, svc, 100);
    const booked = await hold(tenantA, id, 2);
    const [{ r }] = await as<{ r: { moved: boolean; people: number } }>(
      alice,
      "select public.move_session($1, $2) as r",
      [id, soon(130)],
    );
    expect(r).toEqual({ moved: true, people: 1 });
    const row = await sessionRow(id);
    expect(row.ends_at.getTime() - row.starts_at.getTime()).toBe(120 * 60_000);
    expect(Math.abs(row.starts_at.getTime() - Date.parse(soon(130)))).toBeLessThan(5000);
    const [b] = (
      await db.query<{ session_id: string; status: string }>(
        "select session_id, status from public.bookings where id = $1",
        [booked],
      )
    ).rows;
    expect(b).toEqual({ session_id: id, status: "confirmed" });
  });

  it("is for managers of the workspace only", async () => {
    const id = await date(alice, await workshop(alice, tenantA), 150);
    await expect(as(member, "select public.move_session($1, $2)", [id, soon(160)])).rejects.toThrow(
      /owners and admins/i,
    );
    await expect(as(bob, "select public.move_session($1, $2)", [id, soon(160)])).rejects.toThrow(
      /not found/i,
    );
    const bobs = await date(bob, await workshop(bob, tenantB), 150);
    await expect(
      as(alice, "select public.move_session($1, $2)", [bobs, soon(160)]),
    ).rejects.toThrow(/not found/i);
  });

  it("refuses the past, a clash with the same workshop, and a cancelled date", async () => {
    const svc = await workshop(alice, tenantA);
    const id = await date(alice, svc, 200);
    const other = await date(alice, svc, 210);
    await expect(as(alice, "select public.move_session($1, $2)", [id, soon(-1)])).rejects.toThrow(
      /in_the_past/,
    );
    const [{ starts_at }] = (
      await db.query<{ starts_at: Date }>("select starts_at from public.sessions where id = $1", [
        other,
      ])
    ).rows;
    await expect(
      as(alice, "select public.move_session($1, $2)", [id, starts_at.toISOString()]),
    ).rejects.toThrow(/date_taken/);
    await as(alice, "select * from public.cancel_session($1)", [other]);
    await expect(
      as(alice, "select public.move_session($1, $2)", [other, soon(300)]),
    ).rejects.toThrow(/date_cancelled/);
  });

  it("won't pull a date out of time with the class it shares a room with", async () => {
    const one = await date(alice, await workshop(alice, tenantA), 400);
    const two = await date(alice, await workshop(alice, tenantA), 400);
    await as(alice, "select public.share_session_seats($1, 10)", [[one, two]]);
    await expect(as(alice, "select public.move_session($1, $2)", [one, soon(410)])).rejects.toThrow(
      /shared_apart/,
    );
    // Half an hour later still overlaps.
    await as(alice, "select public.move_session($1, $2)", [one, soon(400.5)]);
  });

  it("a reminder already sent isn't sent again; one not yet sent follows the new time", async () => {
    const svc = await workshop(alice, tenantA);
    const id = await date(alice, svc, 10); // inside the usual 24-hour lead
    const booked = await hold(tenantA, id, 1);
    const first = (
      await service<Claim>("select * from public.claim_booking_email_sends(200)")
    ).filter((c) => c.booking_id === booked);
    expect(first.map((c) => c.kind)).toEqual(["reminder"]);
    await service("select public.finish_booking_email_send($1, 'sent')", [first[0].send_id]);

    // Pushed back by a week, then brought close again: no second reminder.
    await as(alice, "select public.move_session($1, $2)", [id, soon(170)]);
    await as(alice, "select public.move_session($1, $2)", [id, soon(12)]);
    const after = (
      await service<Claim>("select * from public.claim_booking_email_sends(200)")
    ).filter((c) => c.booking_id === booked);
    expect(after).toHaveLength(0);

    // A date whose reminder hadn't gone yet: it goes before the new start.
    const later = await date(alice, svc, 60);
    const other = await hold(tenantA, later, 1);
    const none = (
      await service<Claim>("select * from public.claim_booking_email_sends(200)")
    ).filter((c) => c.booking_id === other);
    expect(none).toHaveLength(0);
    await as(alice, "select public.move_session($1, $2)", [later, soon(20)]);
    const now = (
      await service<Claim>("select * from public.claim_booking_email_sends(200)")
    ).filter((c) => c.booking_id === other);
    expect(now.map((c) => c.kind)).toEqual(["reminder"]);
  });
});

describe("deleting a date", () => {
  it("only works while nobody has ever booked it", async () => {
    const svc = await workshop(alice, tenantA);
    const empty = await date(alice, svc, 500);
    const used = await date(alice, svc, 510);
    const b = await hold(tenantA, used, 1);
    await as(alice, "select * from public.admin_cancel_booking($1)", [b]);
    await expect(as(alice, "select public.delete_session($1)", [used])).rejects.toThrow(
      /has_bookings/,
    );
    await expect(as(member, "select public.delete_session($1)", [empty])).rejects.toThrow(
      /owners and admins/i,
    );
    await expect(as(bob, "select public.delete_session($1)", [empty])).rejects.toThrow(
      /not found/i,
    );
    await as(alice, "select public.delete_session($1)", [empty]);
    expect(
      (await db.query("select 1 from public.sessions where id = $1", [empty])).rows,
    ).toHaveLength(0);
  });

  it("unties a shared room left with one date", async () => {
    const one = await date(alice, await workshop(alice, tenantA), 600);
    const two = await date(alice, await workshop(alice, tenantA), 600);
    const [{ g }] = await as<{ g: string }>(
      alice,
      "select public.share_session_seats($1, 10) as g",
      [[one, two]],
    );
    await as(alice, "select public.delete_session($1)", [one]);
    expect(
      (await db.query("select 1 from public.session_seat_groups where id = $1", [g])).rows,
    ).toHaveLength(0);
    const [left] = (
      await db.query<{ seat_group_id: string | null }>(
        "select seat_group_id from public.sessions where id = $1",
        [two],
      )
    ).rows;
    expect(left.seat_group_id).toBeNull();
  });
});

describe("raising the limit to fit", () => {
  it("lifts the date's limit (and only lifts it) and clears the over-the-limit marks", async () => {
    const svc = await workshop(alice, tenantA, 4);
    const id = await date(alice, svc, 700);
    await hold(tenantA, id, 4);
    n += 1;
    const [{ r: paid }] = await service<{ r: { booking_id: string; oversold: boolean } }>(
      "select public.book_from_shop($1, $2, $3, '#9', 'Sam', 'sam@example.com', 2, 9000, $4) as r",
      [tenantA, id, `fit-${n}`, `fit-token-${n}`],
    );
    expect(paid.oversold).toBe(true);
    await expect(as(member, "select public.raise_limit_to_fit($1)", [id])).rejects.toThrow(
      /owners and admins/i,
    );
    const [{ r }] = await as<{ r: { capacity: number } }>(
      alice,
      "select public.raise_limit_to_fit($1) as r",
      [id],
    );
    expect(r.capacity).toBe(6);
    const [b] = (
      await db.query<{ oversold: boolean }>("select oversold from public.bookings where id = $1", [
        paid.booking_id,
      ])
    ).rows;
    expect(b.oversold).toBe(false);
    // Pressing it again, or on a date that fits, changes nothing.
    const [{ r: again }] = await as<{ r: { capacity: number } }>(
      alice,
      "select public.raise_limit_to_fit($1) as r",
      [id],
    );
    expect(again.capacity).toBe(6);
  });

  it("lifts the shared room's limit when that is what's over", async () => {
    const one = await date(alice, await workshop(alice, tenantA, 8), 800);
    const two = await date(alice, await workshop(alice, tenantA, 8), 800);
    const [{ g }] = await as<{ g: string }>(
      alice,
      "select public.share_session_seats($1, 6) as g",
      [[one, two]],
    );
    await hold(tenantA, one, 6);
    n += 1;
    await service(
      "select public.book_from_shop($1, $2, $3, '#10', 'Sam', 'sam@example.com', 3, 9000, $4)",
      [tenantA, two, `fit-${n}`, `fit-token-${n}`],
    );
    const [{ r }] = await as<{ r: { capacity: number; shared_capacity: number } }>(
      alice,
      "select public.raise_limit_to_fit($1) as r",
      [two],
    );
    expect(r).toEqual({ capacity: 8, shared_capacity: 9 });
    const [group] = (
      await db.query<{ capacity: number }>(
        "select capacity from public.session_seat_groups where id = $1",
        [g],
      )
    ).rows;
    expect(group.capacity).toBe(9);
    expect((await sessionRow(two)).capacity).toBe(8);
  });
});
