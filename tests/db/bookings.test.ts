import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };
type Booking = { id: string; status: string; session_id: string; oversold: boolean };

let db: PGlite;
let alice: User;
let bob: User;
let tenantA: string;
let tenantB: string;
let n = 0;

const TABLES = ["services", "sessions", "availability_rules", "bookings", "waitlist"];
const soon = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();

async function tenantFor(owner: User, name: string): Promise<string> {
  return asUser(db, owner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select id from public.create_tenant($1, 'UTC', 'USD')",
      [name],
    );
    return rows[0].id;
  });
}

function service<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
}

async function makeService(
  owner: User,
  tenant: string,
  kind: "workshop" | "appointment",
  price: number,
  capacity = 2,
): Promise<string> {
  n += 1;
  return asUser(db, owner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select public.save_service($1, null, $2, $3, '', 60, $4, $5, true) as id",
      [tenant, kind, `Service ${n}`, price, capacity],
    );
    return rows[0].id;
  });
}

async function makeSession(owner: User, serviceId: string, hours: number): Promise<string> {
  return asUser(db, owner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select public.add_session($1, $2, null) as id",
      [serviceId, soon(hours)],
    );
    return rows[0].id;
  });
}

async function hold(
  tenant: string,
  sessionId: string | null,
  opts: { serviceId?: string; startsAt?: string; seats?: number; email?: string } = {},
): Promise<{ booking: Booking; token: string }> {
  n += 1;
  const token = `token-${n}`;
  const rows = await service<Booking>(
    "select * from public.hold_booking($1, $2, $3, $4, 'Sam', $5, $6, '{}'::jsonb, $7, 30)",
    [
      tenant,
      sessionId,
      opts.serviceId ?? null,
      opts.startsAt ?? null,
      opts.email ?? `sam${n}@example.com`,
      opts.seats ?? 1,
      token,
    ],
  );
  return { booking: rows[0], token };
}

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
});

describe("workspace isolation", () => {
  it("members see their own bookings data and nobody else's", async () => {
    const svc = await makeService(alice, tenantA, "workshop", 0);
    const session = await makeSession(alice, svc, 48);
    await hold(tenantA, session);
    await service("select public.join_waitlist($1, $2, 'Wen', 'wen@example.com', 1)", [
      tenantA,
      session,
    ]);
    await asUser(db, alice, (tx) =>
      tx.query("select public.set_availability($1, $2)", [
        svc,
        JSON.stringify([{ weekday: 1, start_minute: 540, end_minute: 600 }]),
      ]),
    );

    for (const table of TABLES) {
      const mine = await asUser(db, alice, (tx) => tx.query(`select id from public.${table}`));
      const theirs = await asUser(db, bob, (tx) => tx.query(`select id from public.${table}`));
      expect(mine.rows.length, table).toBeGreaterThan(0);
      expect(theirs.rows.length, table).toBe(0);
      await expect(
        asAnon(db, (tx) => tx.query(`select id from public.${table}`)),
        table,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("members cannot write the tables directly or read the manage-link hash", async () => {
    await expect(
      asUser(db, alice, (tx) => tx.query("update public.bookings set status = 'confirmed'")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(db, alice, (tx) => tx.query("select manage_token_hash from public.bookings")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(db, alice, (tx) => tx.query("delete from public.sessions")),
    ).rejects.toThrow(/permission denied/);
  });

  it("an owner of one workspace cannot change another's services or sessions", async () => {
    const svc = await makeService(alice, tenantA, "workshop", 0);
    const session = await makeSession(alice, svc, 48);
    await expect(
      asUser(db, bob, (tx) => tx.query("select public.add_session($1, $2, null)", [svc, soon(72)])),
    ).rejects.toThrow(/Only owners and admins/);
    await expect(
      asUser(db, bob, (tx) => tx.query("select public.cancel_session($1)", [session])),
    ).rejects.toThrow(/Only owners and admins/);
    await expect(
      asUser(db, bob, (tx) =>
        tx.query("select public.save_service($1, null, 'workshop', 'X', '', 60, 0, 1, true)", [
          tenantA,
        ]),
      ),
    ).rejects.toThrow(/Only owners and admins/);
  });

  it("the public booking functions are closed to signed-in users and visitors", async () => {
    await expect(
      asUser(db, alice, (tx) =>
        tx.query("select public.confirm_booking($1, gen_random_uuid(), 'pi')", [tenantA]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asAnon(db, (tx) => tx.query("select public.cancel_booking_by_token('x')")),
    ).rejects.toThrow(/permission denied/);
  });

  it("a session can't be booked through another workspace", async () => {
    const svc = await makeService(alice, tenantA, "workshop", 0);
    const session = await makeSession(alice, svc, 48);
    await expect(hold(tenantB, session)).rejects.toThrow(/Session not found/);
  });
});

describe("seats", () => {
  it("a free booking is confirmed at once; a paid one holds its seats", async () => {
    const free = await makeService(alice, tenantA, "workshop", 0);
    const paid = await makeService(alice, tenantA, "workshop", 4500);
    const a = await hold(tenantA, await makeSession(alice, free, 48));
    const b = await hold(tenantA, await makeSession(alice, paid, 48), { seats: 2 });
    expect(a.booking.status).toBe("confirmed");
    expect(b.booking.status).toBe("pending_payment");
    expect((b.booking as unknown as { amount_cents: number }).amount_cents).toBe(9000);
  });

  it("a full session refuses more, counting holds, and frees lapsed holds", async () => {
    const svc = await makeService(alice, tenantA, "workshop", 1000, 2);
    const session = await makeSession(alice, svc, 48);
    const first = await hold(tenantA, session, { seats: 2 });
    await expect(hold(tenantA, session)).rejects.toThrow(/full/);

    await db.query(
      "update public.bookings set hold_expires_at = now() - interval '1 minute' where id = $1",
      [first.booking.id],
    );
    const left = await service<{ seats_left: number }>(
      "select seats_left from public.session_availability($1, $2)",
      [tenantA, svc],
    );
    expect(left[0].seats_left).toBe(2);
    const second = await hold(tenantA, session, { seats: 2 });
    expect(second.booking.status).toBe("pending_payment");
  });

  it("confirming is true once, then a no-op", async () => {
    const svc = await makeService(alice, tenantA, "workshop", 1000);
    const { booking } = await hold(tenantA, await makeSession(alice, svc, 48));
    const confirm = () =>
      service<{ ok: boolean }>("select public.confirm_booking($1, $2, 'pi_1') as ok", [
        tenantA,
        booking.id,
      ]);
    expect((await confirm())[0].ok).toBe(true);
    expect((await confirm())[0].ok).toBe(false);
  });

  it("a payment that lands after the hold lapsed and the session filled is kept and flagged", async () => {
    const svc = await makeService(alice, tenantA, "workshop", 1000, 1);
    const session = await makeSession(alice, svc, 48);
    const late = await hold(tenantA, session);
    await db.query(
      "update public.bookings set hold_expires_at = now() - interval '1 minute' where id = $1",
      [late.booking.id],
    );
    const quick = await hold(tenantA, session);
    await service("select public.confirm_booking($1, $2, 'pi_q')", [tenantA, quick.booking.id]);
    await service("select public.confirm_booking($1, $2, 'pi_l')", [tenantA, late.booking.id]);
    const rows = await service<Booking>(
      "select id, status, oversold from public.bookings where session_id = $1 order by created_at",
      [session],
    );
    expect(rows.map((r) => [r.status, r.oversold])).toEqual([
      ["confirmed", true],
      ["confirmed", false],
    ]);
  });

  it("releasing an abandoned checkout frees the seats but never undoes a paid booking", async () => {
    const svc = await makeService(alice, tenantA, "workshop", 1000, 1);
    const session = await makeSession(alice, svc, 48);
    const a = await hold(tenantA, session);
    await service("select public.release_booking($1, $2)", [tenantA, a.booking.id]);
    const b = await hold(tenantA, session);
    await service("select public.confirm_booking($1, $2, 'pi')", [tenantA, b.booking.id]);
    await service("select public.release_booking($1, $2)", [tenantA, b.booking.id]);
    const rows = await service<Booking>("select status from public.bookings where id = $1", [
      b.booking.id,
    ]);
    expect(rows[0].status).toBe("confirmed");
  });

  it("past and cancelled sessions can't be booked", async () => {
    const svc = await makeService(alice, tenantA, "workshop", 0);
    const session = await makeSession(alice, svc, 48);
    await hold(tenantA, session);
    const cancelled = await asUser(db, alice, (tx) =>
      tx.query<Booking>("select * from public.cancel_session($1)", [session]),
    );
    expect(cancelled.rows).toHaveLength(1);
    expect(cancelled.rows[0].status).toBe("cancelled");
    await expect(hold(tenantA, session)).rejects.toThrow(/no longer available/);

    const past = await makeSession(alice, svc, 72);
    await db.query(
      "update public.sessions set starts_at = now() - interval '1 hour' where id = $1",
      [past],
    );
    await expect(hold(tenantA, past)).rejects.toThrow(/no longer available/);
  });
});

describe("appointments", () => {
  it("a slot can be taken once, and overlapping slots of other services are blocked", async () => {
    const consult = await makeService(alice, tenantA, "appointment", 0, 1);
    const fitting = await makeService(alice, tenantA, "appointment", 0, 1);
    const at = soon(100);
    const first = await hold(tenantA, null, { serviceId: consult, startsAt: at });
    expect(first.booking.status).toBe("confirmed");
    await expect(hold(tenantA, null, { serviceId: consult, startsAt: at })).rejects.toThrow(/full/);
    const overlapping = new Date(new Date(at).getTime() + 30 * 60_000).toISOString();
    await expect(
      hold(tenantA, null, { serviceId: fitting, startsAt: overlapping }),
    ).rejects.toThrow(/taken/);

    const busy = await service<{ starts_at: string }>(
      "select starts_at from public.busy_appointment_times($1, now() + interval '99 hours', now() + interval '102 hours')",
      [tenantA],
    );
    expect(busy).toHaveLength(1);
    expect(
      await service(
        "select 1 from public.busy_appointment_times($1, now() + interval '99 hours', now() + interval '102 hours')",
        [tenantB],
      ),
    ).toHaveLength(0);
  });

  it("a cancelled appointment frees its slot", async () => {
    const svc = await makeService(alice, tenantA, "appointment", 0, 1);
    const at = soon(200);
    const first = await hold(tenantA, null, { serviceId: svc, startsAt: at });
    await service("select * from public.cancel_booking_by_token($1)", [first.token]);
    const again = await hold(tenantA, null, { serviceId: svc, startsAt: at });
    expect(again.booking.status).toBe("confirmed");
  });

  it("workshops can't be booked as appointments", async () => {
    const svc = await makeService(alice, tenantA, "workshop", 0);
    await expect(hold(tenantA, null, { serviceId: svc, startsAt: soon(300) })).rejects.toThrow(
      /Service not found/,
    );
  });
});

describe("manage link", () => {
  it("finds the booking by token, and only by the right token", async () => {
    const svc = await makeService(alice, tenantA, "workshop", 0);
    const { token, booking } = await hold(tenantA, await makeSession(alice, svc, 48));
    const found = await service<{ booking_id: string; workspace_slug: string }>(
      "select * from public.booking_details(null, null, $1)",
      [token],
    );
    expect(found[0].booking_id).toBe(booking.id);
    expect(found[0].workspace_slug).toBe("alice-rugs");
    expect(await service("select * from public.booking_details(null, null, 'wrong')")).toHaveLength(
      0,
    );
    expect(
      await service("select * from public.booking_details($1, $2, null)", [tenantB, booking.id]),
    ).toHaveLength(0);
  });

  it("cancelling tells the waitlist once", async () => {
    const svc = await makeService(alice, tenantA, "workshop", 0, 1);
    const session = await makeSession(alice, svc, 48);
    const { token } = await hold(tenantA, session);
    await service("select public.join_waitlist($1, $2, 'Wen', 'Wen@Example.com', 1)", [
      tenantA,
      session,
    ]);
    const told = await service<{ customer_email: string }>(
      "select * from public.cancel_booking_by_token($1)",
      [token],
    );
    expect(told.map((w) => w.customer_email)).toEqual(["wen@example.com"]);
    expect(await service("select * from public.cancel_booking_by_token($1)", [token])).toHaveLength(
      0,
    );
  });

  it("moves a booking to another session of the same service with room", async () => {
    const svc = await makeService(alice, tenantA, "workshop", 0, 1);
    const other = await makeService(alice, tenantA, "workshop", 0, 1);
    const from = await makeSession(alice, svc, 48);
    const to = await makeSession(alice, svc, 72);
    const full = await makeSession(alice, svc, 96);
    const elsewhere = await makeSession(alice, other, 48);
    await hold(tenantA, full);
    const { token, booking } = await hold(tenantA, from);

    await expect(
      service("select public.move_booking_by_token($1, $2)", [token, full]),
    ).rejects.toThrow(/full/);
    await expect(
      service("select public.move_booking_by_token($1, $2)", [token, elsewhere]),
    ).rejects.toThrow(/not available/);
    await service("select public.join_waitlist($1, $2, 'Wen', 'wen@example.com', 1)", [
      tenantA,
      from,
    ]);
    const told = await service<{ customer_email: string }>(
      "select * from public.move_booking_by_token($1, $2)",
      [token, to],
    );
    // The date they left has a free place, so its waitlist hears about it.
    expect(told.map((w) => w.customer_email)).toEqual(["wen@example.com"]);
    const rows = await service<Booking>("select session_id from public.bookings where id = $1", [
      booking.id,
    ]);
    expect(rows[0].session_id).toBe(to);
    await expect(
      service("select * from public.move_booking_by_token($1, $2)", [token, to]),
    ).rejects.toThrow(/not available/);
  });

  it("a workshop blocks appointment times even before anyone books it", async () => {
    const svc = await makeService(bob, tenantB, "workshop", 0, 4);
    await makeSession(bob, svc, 400);
    const busy = await service<{ starts_at: string }>(
      "select starts_at from public.busy_appointment_times($1, now() + interval '399 hours', now() + interval '402 hours')",
      [tenantB],
    );
    expect(busy).toHaveLength(1);
  });
});

describe("reminders", () => {
  it("the older claims hand nothing out any more (tests/db/booking-emails.test.ts has the new path)", async () => {
    const svc = await makeService(bob, tenantB, "workshop", 0, 5);
    const tomorrow = await makeSession(bob, svc, 12);
    await hold(tenantB, tomorrow);
    expect(await service("select * from public.claim_booking_reminders(50)")).toHaveLength(0);
    expect(await service("select * from public.claim_booking_emails('reminder', 50)")).toHaveLength(
      0,
    );
    const stamped = await service<{ n: number }>(
      "select count(*)::int as n from public.bookings where session_id = $1 and reminder_sent_at is not null",
      [tomorrow],
    );
    expect(stamped[0].n).toBe(0);
  });
});

describe("the business's own changes", () => {
  const asOwner = <T>(sql: string, params: unknown[]) =>
    asUser(db, alice, async (tx) => (await tx.query<T>(sql, params)).rows);

  it("repeat weekly keeps the local time across a clock change and skips existing dates", async () => {
    const owner = { id: await createUser(db, "nyc@c.test"), email: "nyc@c.test" };
    const tenant = await asUser(db, owner, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        "select id from public.create_tenant('NYC Studio', 'America/New_York', 'USD')",
      );
      return rows[0].id;
    });
    const svc = await makeService(owner, tenant, "workshop", 0, 4);
    // Saturday 6 March 2027, 10:00 in New York; clocks go forward on the 14th.
    const add = () =>
      asUser(db, owner, async (tx) => {
        const { rows } = await tx.query<{ n: number }>(
          "select public.add_sessions($1, '2027-03-06T15:00:00Z', null, 3, false) as n",
          [svc],
        );
        return rows[0].n;
      });
    expect(await add()).toBe(3);
    expect(await add()).toBe(0);
    const { rows } = await db.query<{ starts_at: Date }>(
      "select starts_at from public.sessions where service_id = $1 order by starts_at",
      [svc],
    );
    expect(rows.map((r) => new Date(r.starts_at).toISOString())).toEqual([
      "2027-03-06T15:00:00.000Z",
      "2027-03-13T15:00:00.000Z",
      "2027-03-20T14:00:00.000Z",
    ]);
  });

  it("closed and private dates take no online bookings but the owner can still add people", async () => {
    const svc = await makeService(alice, tenantA, "workshop", 0, 2);
    const closed = await makeSession(alice, svc, 48);
    const hidden = await makeSession(alice, svc, 72);
    await asOwner("select public.update_session($1, 2, true, false, '')", [closed]);
    await asOwner("select public.update_session($1, 2, false, true, 'Birthday party')", [hidden]);
    await expect(hold(tenantA, closed)).rejects.toThrow(/no longer available/);
    await expect(hold(tenantA, hidden)).rejects.toThrow(/no longer available/);
    const listed = await service("select * from public.session_availability($1, $2)", [
      tenantA,
      svc,
    ]);
    expect(listed).toHaveLength(0);

    await asOwner(
      "select public.add_manual_booking($1, 'Pat', 'Pat@Example.com', 2, 'paid cash', 'tok-manual-1', false)",
      [hidden],
    );
    await expect(
      asOwner(
        "select public.add_manual_booking($1, 'Extra', 'x@example.com', 1, '', 'tok-manual-2', false)",
        [hidden],
      ),
    ).rejects.toThrow(/full/);
    await asOwner(
      "select public.add_manual_booking($1, 'Extra', 'x@example.com', 1, '', 'tok-manual-3', true)",
      [hidden],
    );
    const { rows } = await db.query<{ source: string; status: string; customer_email: string }>(
      "select source, status, customer_email from public.bookings where session_id = $1 order by created_at",
      [hidden],
    );
    expect(rows[0]).toEqual({
      source: "manual",
      status: "confirmed",
      customer_email: "pat@example.com",
    });
    expect(rows).toHaveLength(2);
  });

  it("the owner can move and cancel a booking; the waitlist of the date it left is told", async () => {
    const svc = await makeService(alice, tenantA, "workshop", 0, 1);
    const from = await makeSession(alice, svc, 48);
    const to = await makeSession(alice, svc, 72);
    const { booking } = await hold(tenantA, from);
    await service("select public.join_waitlist($1, $2, 'Wen', 'wen@example.com', 1)", [
      tenantA,
      from,
    ]);
    const told = await asOwner<{ customer_email: string }>(
      "select * from public.admin_move_booking($1, $2)",
      [booking.id, to],
    );
    expect(told.map((w) => w.customer_email)).toEqual(["wen@example.com"]);
    await asOwner("select * from public.admin_cancel_booking($1)", [booking.id]);
    const { rows } = await db.query<{ status: string; session_id: string }>(
      "select status, session_id from public.bookings where id = $1",
      [booking.id],
    );
    expect(rows[0]).toEqual({ status: "cancelled", session_id: to });
  });

  it("anyone on the team can check people in and keep notes; outsiders and members can't do owner jobs", async () => {
    const svc = await makeService(alice, tenantA, "workshop", 0, 3);
    const session = await makeSession(alice, svc, 48);
    const { booking } = await hold(tenantA, session);
    const staff = { id: await createUser(db, "staff@a.test"), email: "staff@a.test" };
    await db.query(
      "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
      [tenantA, staff.id],
    );
    await asUser(db, staff, (tx) =>
      tx.query("select public.set_booking_attendance($1, 'attended')", [booking.id]),
    );
    await asUser(db, staff, (tx) =>
      tx.query("select public.set_booking_notes($1, 'Left-handed', $2)", [
        booking.id,
        ["VIP", " gift ", "bad tag!!"],
      ]),
    );
    const { rows } = await db.query<{ attendance: string; notes: string; tags: string[] }>(
      "select attendance, notes, tags from public.bookings where id = $1",
      [booking.id],
    );
    expect(rows[0].attendance).toBe("attended");
    expect(rows[0].notes).toBe("Left-handed");
    expect([...rows[0].tags].sort()).toEqual(["gift", "vip"]);

    await expect(
      asUser(db, staff, (tx) =>
        tx.query("select * from public.admin_cancel_booking($1)", [booking.id]),
      ),
    ).rejects.toThrow(/Only owners and admins/);
    for (const sql of [
      "select public.set_booking_attendance($1, 'no_show')",
      "select * from public.admin_cancel_booking($1)",
      "select public.set_booking_notes($1, 'x', '{}')",
    ]) {
      await expect(asUser(db, bob, (tx) => tx.query(sql, [booking.id]))).rejects.toThrow(
        /Booking not found/,
      );
    }
  });

  it("reminders use the chosen lead time, follow-ups come after, and both respect email-off", async () => {
    const owner = { id: await createUser(db, "mail@d.test"), email: "mail@d.test" };
    const tenant = await asUser(db, owner, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        "select id from public.create_tenant('Mail Test', 'UTC', 'USD')",
      );
      return rows[0].id;
    });
    const svc = await makeService(owner, tenant, "workshop", 0, 5);
    const in40h = await makeSession(owner, svc, 40);
    const a = await hold(tenant, in40h);
    const quiet = await hold(tenant, in40h);
    await asUser(db, owner, (tx) =>
      tx.query("select public.update_booking_contact($1, 'Quiet', 'quiet@example.com', false)", [
        quiet.booking.id,
      ]),
    );
    const setEmails = (body: object) =>
      asUser(db, owner, (tx) =>
        tx.query("select public.save_config($1, 'bookings', 'emails', $2::jsonb)", [
          tenant,
          JSON.stringify(body),
        ]),
      );
    // Claims every kind that is due and says each one went.
    const claim = async (kind: string) => {
      const rows = await service<{ send_id: string; booking_id: string; kind: string }>(
        "select * from public.claim_booking_email_sends(200)",
      );
      for (const row of rows) {
        await service("select public.finish_booking_email_send($1, 'sent')", [row.send_id]);
      }
      const ours = await service<{ id: string }>(
        "select id from public.bookings where session_id = $1",
        [in40h],
      );
      return rows
        .filter((r) => r.kind === kind && ours.some((b) => b.id === r.booking_id))
        .map((r) => r.booking_id);
    };
    // A day ahead by default, so nothing is due 40 hours out.
    expect(await claim("reminder")).toEqual([]);
    await setEmails({ version: 1, reminder_hours: 48 });
    expect(await claim("reminder")).toEqual([a.booking.id]);
    expect(await claim("reminder")).toEqual([]);

    await db.query(
      "update public.sessions set starts_at = now() - interval '30 hours', ends_at = now() - interval '29 hours' where id = $1",
      [in40h],
    );
    // Thank-yous are off until the workspace switches them on.
    expect(await claim("followup")).toEqual([]);
    await setEmails({ version: 1, reminder_hours: 48, followup_on: true, followup_hours: 24 });
    expect(await claim("followup")).toEqual([a.booking.id]);
    expect(await claim("followup")).toEqual([]);
  });

  it("messages sent to a date are logged by owners and hidden from other workspaces", async () => {
    const svc = await makeService(alice, tenantA, "workshop", 0, 3);
    const session = await makeSession(alice, svc, 48);
    await asOwner("select public.log_booking_message($1, 'Parking', 'Use the back lot.', 4)", [
      session,
    ]);
    await expect(
      asUser(db, bob, (tx) =>
        tx.query("select public.log_booking_message($1, 'Hi', 'x', 1)", [session]),
      ),
    ).rejects.toThrow(/Session not found/);
    const seenByBob = await asUser(
      db,
      bob,
      async (tx) => (await tx.query("select id from public.booking_messages")).rows,
    );
    expect(seenByBob).toHaveLength(0);
    const seenByAlice = await asOwner<{ subject: string }>(
      "select subject from public.booking_messages where session_id = $1",
      [session],
    );
    expect(seenByAlice).toEqual([{ subject: "Parking" }]);
    await expect(
      asUser(db, alice, (tx) =>
        tx.query(
          "insert into public.booking_messages (tenant_id, session_id, subject, body, recipients) values ($1, $2, 'x', 'y', 1)",
          [tenantA, session],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("bookings sold through the shop", () => {
  const as = <T>(user: User, sql: string, params: unknown[] = []) =>
    asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);
  type Result = { result: string; booking_id?: string; oversold?: boolean };
  const book = async (
    tenant: string,
    session: string,
    order: string,
    seats: number,
    email = "shopper@example.com",
  ) =>
    (
      await service<{ r: Result }>(
        "select public.book_from_shop($1, $2, $3, '#1001', 'Sam Shopper', $4, $5, 9000, $6) as r",
        [tenant, session, order, email, seats, `shop-token-${order}-${session}`],
      )
    )[0].r;

  it("a workshop is tied to one shop product, by its managers only", async () => {
    const svc = await makeService(alice, tenantA, "workshop", 0, 3);
    await as(alice, "select public.set_service_shop_product($1, '8001', '9001')", [svc]);
    const other = await makeService(alice, tenantA, "workshop", 0, 3);
    await expect(
      as(alice, "select public.set_service_shop_product($1, '8001', '9002')", [other]),
    ).rejects.toThrow(/product_taken/);
    await expect(
      as(bob, "select public.set_service_shop_product($1, '8009', '9009')", [svc]),
    ).rejects.toThrow(/Workspace not found|Only owners/);
    await expect(
      as(alice, "select public.set_service_shop_product($1, 'abc', null)", [svc]),
    ).rejects.toThrow(/check/);
    // The same product number in another workspace is that workspace's own business.
    const bobs = await makeService(bob, tenantB, "workshop", 0, 3);
    await as(bob, "select public.set_service_shop_product($1, '8001', '9001')", [bobs]);
  });

  it("the date picker sees coming, open dates with seats left, and nothing else", async () => {
    const svc = await makeService(alice, tenantA, "workshop", 0, 2);
    await as(alice, "select public.set_service_shop_product($1, '8100', '9100')", [svc]);
    const open = await makeSession(alice, svc, 48);
    const hidden = await makeSession(alice, svc, 72);
    await as(alice, "select public.update_session($1, null, null, true, true, '')", [hidden]).catch(
      () => db.query("update public.sessions set private = true where id = $1", [hidden]),
    );
    await book(tenantA, open, "501", 1);
    const data = (
      await service<{
        d: { service: { variant_id: string }; sessions: { id: string; seats_left: number }[] };
      }>("select public.shop_booking_dates($1, '8100') as d", [tenantA])
    )[0].d;
    expect(data.service.variant_id).toBe("9100");
    expect(data.sessions).toEqual([expect.objectContaining({ id: open, seats_left: 1 })]);
    expect(JSON.stringify(data)).not.toContain("shopper@example.com");
    // Another workspace asking for that product gets nothing.
    expect(
      (
        await service<{ d: unknown }>("select public.shop_booking_dates($1, '8100') as d", [
          tenantB,
        ])
      )[0]?.d ?? null,
    ).toBeNull();
    await expect(
      as(alice, "select public.shop_booking_dates($1, '8100')", [tenantA]),
    ).rejects.toThrow(/permission denied/);
  });

  it("an order becomes one booking however often the shop repeats it, and follows refunds", async () => {
    const svc = await makeService(alice, tenantA, "workshop", 0, 4);
    const session = await makeSession(alice, svc, 48);
    const first = await book(tenantA, session, "601", 2);
    expect(first).toMatchObject({ result: "booked", oversold: false });
    expect(await book(tenantA, session, "601", 2)).toMatchObject({
      result: "unchanged",
      booking_id: first.booking_id,
    });
    // One of the two seats was refunded.
    expect(await book(tenantA, session, "601", 1)).toMatchObject({ result: "resized" });
    const { rows } = await db.query<{ seats: number; status: string; shop_order_name: string }>(
      "select seats, status, shop_order_name from public.bookings where id = $1",
      [first.booking_id],
    );
    expect(rows[0]).toEqual({ seats: 1, status: "confirmed", shop_order_name: "#1001" });
    // The rest was refunded too.
    expect(await book(tenantA, session, "601", 0)).toMatchObject({ result: "cancelled" });
    expect(await book(tenantA, session, "601", 0)).toMatchObject({ result: "unchanged" });
    // A cancelled order frees its seats.
    await book(tenantA, session, "602", 3);
    expect(
      (
        await service<{ n: number }>("select public.cancel_shop_order($1, '602') as n", [tenantA])
      )[0].n,
    ).toBe(1);
    expect(
      (
        await service<{ n: number }>("select public.cancel_shop_order($1, '602') as n", [tenantA])
      )[0].n,
    ).toBe(0);
  });

  it("a paid order is never dropped: a full, closed or cancelled date is booked and flagged", async () => {
    const svc = await makeService(alice, tenantA, "workshop", 0, 2);
    const session = await makeSession(alice, svc, 48);
    await book(tenantA, session, "701", 2);
    expect(await book(tenantA, session, "702", 1)).toMatchObject({
      result: "booked",
      oversold: true,
    });
    await db.query(
      "update public.sessions set bookings_closed = true, private = true where id = $1",
      [session],
    );
    expect(await book(tenantA, session, "703", 1)).toMatchObject({ result: "booked" });
  });

  it("an order can't book into another workspace's date, and only the server can call it", async () => {
    const svc = await makeService(alice, tenantA, "workshop", 0, 2);
    const session = await makeSession(alice, svc, 48);
    expect(await book(tenantB, session, "801", 1)).toEqual({ result: "no_session" });
    await expect(
      as(alice, "select public.book_from_shop($1, $2, '802', '#1', 'A', 'a@a.test', 1, 0, 't')", [
        tenantA,
        session,
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(alice, "select public.cancel_shop_order($1, '801')", [tenantA]),
    ).rejects.toThrow(/permission denied/);
    // The same order number in two workspaces stays apart.
    const bobSvc = await makeService(bob, tenantB, "workshop", 0, 2);
    const bobSession = await makeSession(bob, bobSvc, 48);
    await book(tenantA, session, "900", 1);
    await book(tenantB, bobSession, "900", 1);
    await service("select public.cancel_shop_order($1, '900')", [tenantB]);
    const mine = await as<{ status: string }>(
      alice,
      "select status from public.bookings where shop_order_id = '900'",
    );
    expect(mine).toEqual([{ status: "confirmed" }]);
  });
});
