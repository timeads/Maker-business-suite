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
  it("are handed out once, for confirmed bookings starting within a day", async () => {
    const svc = await makeService(bob, tenantB, "workshop", 0, 5);
    const tomorrow = await makeSession(bob, svc, 12);
    const nextWeek = await makeSession(bob, svc, 24 * 7);
    const due = await hold(tenantB, tomorrow);
    await hold(tenantB, nextWeek);
    const first = await service<Booking>("select * from public.claim_booking_reminders(50)");
    expect(first.map((b) => b.id)).toEqual([due.booking.id]);
    expect(await service("select * from public.claim_booking_reminders(50)")).toHaveLength(0);
  });
});
