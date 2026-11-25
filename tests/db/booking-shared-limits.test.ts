import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };
type Figures = {
  session_id: string;
  taken: number;
  capacity: number;
  seat_group_id: string | null;
  shared_capacity: number | null;
  shared_taken: number | null;
  seats_left: number;
};

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

async function workshop(owner: User, tenant: string, capacity: number, minutes = 120, price = 0) {
  n += 1;
  const rows = await as<{ id: string }>(
    owner,
    "select public.save_service($1, null, 'workshop', $2, '', $3, $4, $5, true) as id",
    [tenant, `Workshop ${n}`, minutes, price, capacity],
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

/** Books from the public page as the server would (free, so confirmed at once). */
async function hold(tenant: string, session: string, seats: number) {
  n += 1;
  return service<{ id: string; status: string }>(
    "select id, status from public.hold_booking($1, $2, null, null, 'Pat', $3, $4, '{}', $5)",
    [tenant, session, `pat${n}@example.com`, seats, `hold-token-${n}`],
  );
}

async function shop(tenant: string, session: string, seats: number) {
  n += 1;
  const rows = await service<{ r: { result: string; booking_id: string; oversold: boolean } }>(
    "select public.book_from_shop($1, $2, $3, $4, 'Sam', 'sam@example.com', $5, 9000, $6) as r",
    [tenant, session, `order-${n}`, `#${n}`, seats, `shop-token-${n}`],
  );
  return rows[0].r;
}

async function share(who: User, ids: string[], capacity: number): Promise<string> {
  const rows = await as<{ id: string }>(who, "select public.share_session_seats($1, $2) as id", [
    ids,
    capacity,
  ]);
  return rows[0].id;
}

const figures = (who: User, ids: string[]) =>
  as<Figures>(who, "select * from public.session_seat_figures($1) order by session_id", [ids]);

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

describe("shared limits between workspaces", () => {
  it("are read only by their own workspace, and written by nobody directly", async () => {
    const one = await date(alice, await workshop(alice, tenantA, 8), 48);
    const two = await date(alice, await workshop(alice, tenantA, 8), 48);
    const group = await share(alice, [one, two], 12);

    const mine = await as<{ id: string }>(alice, "select id from public.session_seat_groups");
    expect(mine.map((r) => r.id)).toContain(group);
    expect(await as(member, "select id from public.session_seat_groups")).toHaveLength(1);
    expect(await as(bob, "select id from public.session_seat_groups")).toHaveLength(0);
    // Bob's figures for A's dates come back empty, not as an error that says they exist.
    expect(await figures(bob, [one, two])).toHaveLength(0);

    for (const sql of [
      `insert into public.session_seat_groups (tenant_id, capacity) values ('${tenantA}', 5)`,
      `update public.session_seat_groups set capacity = 99`,
      `delete from public.session_seat_groups`,
      `update public.sessions set seat_group_id = null where id = '${one}'`,
    ]) {
      await expect(as(alice, sql), sql).rejects.toThrow(/permission denied/i);
    }
    await expect(
      asAnon(db, (tx) => tx.query("select * from public.session_seat_groups")),
    ).rejects.toThrow(/permission denied/i);
  });

  it("can't be changed or undone from another workspace", async () => {
    const one = await date(alice, await workshop(alice, tenantA, 8), 72);
    const two = await date(alice, await workshop(alice, tenantA, 8), 72);
    const group = await share(alice, [one, two], 10);
    await expect(as(bob, "select public.set_shared_limit($1, 50)", [group])).rejects.toThrow(
      /not found/i,
    );
    await expect(as(bob, "select public.unshare_session_seats($1)", [group])).rejects.toThrow(
      /not found/i,
    );
    const bobs = await date(bob, await workshop(bob, tenantB, 8), 72);
    // Bob can't pull A's date into a limit of his.
    await expect(share(bob, [bobs, one], 10)).rejects.toThrow(/not found/i);
    const [row] = await db
      .query<{ capacity: number }>(
        "select capacity from public.session_seat_groups where id = $1",
        [group],
      )
      .then((r) => r.rows);
    expect(row.capacity).toBe(10);
  });

  it("a date can't point at another workspace's limit, even by the service role", async () => {
    const one = await date(alice, await workshop(alice, tenantA, 8), 96);
    const two = await date(alice, await workshop(alice, tenantA, 8), 96);
    const group = await share(alice, [one, two], 10);
    const bobs = await date(bob, await workshop(bob, tenantB, 8), 96);
    await expect(
      db.query("update public.sessions set seat_group_id = $1 where id = $2", [group, bobs]),
    ).rejects.toThrow(/not found/i);
  });
});

describe("setting one up", () => {
  it("is for owners and admins only", async () => {
    const one = await date(alice, await workshop(alice, tenantA, 8), 120);
    const two = await date(alice, await workshop(alice, tenantA, 8), 120);
    await expect(share(member, [one, two], 12)).rejects.toThrow(/owners and admins/i);
    const group = await share(alice, [one, two], 12);
    await expect(as(member, "select public.set_shared_limit($1, 20)", [group])).rejects.toThrow(
      /owners and admins/i,
    );
    await expect(as(member, "select public.unshare_session_seats($1)", [group])).rejects.toThrow(
      /owners and admins/i,
    );
  });

  it("only ties dates that run at the same time", async () => {
    const a = await workshop(alice, tenantA, 8, 120);
    const b = await workshop(alice, tenantA, 8, 120);
    const morning = await date(alice, a, 200);
    const evening = await date(alice, b, 206); // starts after the morning one ends
    await expect(share(alice, [morning, evening], 12)).rejects.toThrow(/not_same_time/);
    // Overlapping by an hour is enough.
    const late = await date(alice, b, 201);
    await expect(share(alice, [morning, late], 12)).resolves.toBeTruthy();
    // And a date can share only one limit.
    const third = await date(alice, await workshop(alice, tenantA, 8, 120), 200);
    await expect(share(alice, [morning, third], 12)).rejects.toThrow(/already_shared/);
  });

  it("won't start below the places already taken", async () => {
    const one = await date(alice, await workshop(alice, tenantA, 8), 300);
    const two = await date(alice, await workshop(alice, tenantA, 8), 300);
    await hold(tenantA, one, 5);
    await hold(tenantA, two, 4);
    await expect(share(alice, [one, two], 8)).rejects.toThrow(/below_booked:9/);
    const group = await share(alice, [one, two], 9);
    await expect(as(alice, "select public.set_shared_limit($1, 7)", [group])).rejects.toThrow(
      /below_booked:9/,
    );
    await as(alice, "select public.set_shared_limit($1, 14)", [group]);
    const [f] = await figures(alice, [one]);
    expect(f.shared_capacity).toBe(14);
  });
});

describe("the limit at work", () => {
  it("counts bookings on both dates against one number, and each date keeps its own", async () => {
    const one = await date(alice, await workshop(alice, tenantA, 8), 400);
    const two = await date(alice, await workshop(alice, tenantA, 8), 401);
    const alone = await date(alice, await workshop(alice, tenantA, 8), 420); // later that day
    await share(alice, [one, two], 12);

    await hold(tenantA, one, 6);
    await hold(tenantA, two, 5);
    // One place left between them, though each date alone has room.
    await expect(hold(tenantA, one, 2)).rejects.toThrow(/full/);
    await expect(hold(tenantA, two, 2)).rejects.toThrow(/full/);
    await hold(tenantA, two, 1);
    await expect(hold(tenantA, one, 1)).rejects.toThrow(/full/);
    // A date that isn't sharing is untouched by it.
    await hold(tenantA, alone, 8);

    const rows = await figures(alice, [one, two, alone]);
    const by = Object.fromEntries(rows.map((r) => [r.session_id, r]));
    expect(by[one]).toMatchObject({
      taken: 6,
      capacity: 8,
      shared_capacity: 12,
      shared_taken: 12,
      seats_left: 0,
    });
    expect(by[two]).toMatchObject({ taken: 6, shared_taken: 12, seats_left: 0 });
    expect(by[alone]).toMatchObject({ taken: 8, seat_group_id: null, seats_left: 0 });
  });

  it("each date's own limit still holds under a roomy shared one", async () => {
    const one = await date(alice, await workshop(alice, tenantA, 4), 500);
    const two = await date(alice, await workshop(alice, tenantA, 8), 500);
    await share(alice, [one, two], 20);
    await hold(tenantA, one, 4);
    await expect(hold(tenantA, one, 1)).rejects.toThrow(/full/);
    await hold(tenantA, two, 8);
    const [f] = await figures(alice, [one]);
    expect(f.seats_left).toBe(0);
  });

  it("shows in what the public page and the shop's picker read", async () => {
    const wsA = await workshop(alice, tenantA, 8);
    const wsB = await workshop(alice, tenantA, 8);
    const one = await date(alice, wsA, 600);
    const two = await date(alice, wsB, 600);
    await share(alice, [one, two], 10);
    await hold(tenantA, two, 7);

    const avail = await service<{ session_id: string; seats_left: number }>(
      "select session_id, seats_left from public.session_availability($1, $2)",
      [tenantA, wsA],
    );
    expect(avail.find((r) => r.session_id === one)?.seats_left).toBe(3);

    await as(alice, "select public.set_service_shop_product($1, '7001', null)", [wsA]);
    const [{ r }] = await service<{ r: { sessions: { id: string; seats_left: number }[] } }>(
      "select public.shop_booking_dates($1, '7001') as r",
      [tenantA],
    );
    expect(r.sessions.find((s) => s.id === one)?.seats_left).toBe(3);
  });

  it("a paid shop order into a full shared limit is booked and flagged, never dropped", async () => {
    const one = await date(alice, await workshop(alice, tenantA, 8), 700);
    const two = await date(alice, await workshop(alice, tenantA, 8), 700);
    await share(alice, [one, two], 6);
    await hold(tenantA, one, 6);
    const paid = await shop(tenantA, two, 2);
    expect(paid).toMatchObject({ result: "booked", oversold: true });
    const [b] = (
      await db.query<{ status: string; oversold: boolean }>(
        "select status, oversold from public.bookings where id = $1",
        [paid.booking_id],
      )
    ).rows;
    expect(b).toEqual({ status: "confirmed", oversold: true });
    // The same order again changes nothing.
    const [{ r: again }] = await service<{ r: { result: string } }>(
      "select public.book_from_shop($1, $2, $3, '#x', 'Sam', 'sam@example.com', 2, 9000, 'other-token') as r",
      [tenantA, two, `order-${n}`],
    );
    expect(again.result).toBe("unchanged");
  });

  it("a payment that lands after its hold lapsed into a full shared limit is kept and flagged", async () => {
    const one = await date(alice, await workshop(alice, tenantA, 8, 120, 5000), 800);
    const two = await date(alice, await workshop(alice, tenantA, 8), 800);
    await share(alice, [one, two], 6);
    const [pending] = await hold(tenantA, one, 2);
    expect(pending.status).toBe("pending_payment");
    // Let the hold lapse, then someone else fills the room.
    await db.query(
      "update public.bookings set hold_expires_at = now() - interval '1 minute' where id = $1",
      [pending.id],
    );
    await hold(tenantA, two, 6);
    const [{ ok }] = await service<{ ok: boolean }>(
      "select public.confirm_booking($1, $2, 'pi_test') as ok",
      [tenantA, pending.id],
    );
    expect(ok).toBe(true);
    const [b] = (
      await db.query<{ status: string; oversold: boolean }>(
        "select status, oversold from public.bookings where id = $1",
        [pending.id],
      )
    ).rows;
    expect(b).toEqual({ status: "confirmed", oversold: true });
  });

  it("adding someone by hand respects it unless told to go over", async () => {
    const one = await date(alice, await workshop(alice, tenantA, 8), 900);
    const two = await date(alice, await workshop(alice, tenantA, 8), 900);
    await share(alice, [one, two], 5);
    await hold(tenantA, one, 5);
    await expect(
      as(
        alice,
        "select public.add_manual_booking($1, 'Kim', 'kim@example.com', 1, '', 'manual-token-1')",
        [two],
      ),
    ).rejects.toThrow(/full/);
    await as(
      alice,
      "select public.add_manual_booking($1, 'Kim', 'kim@example.com', 1, '', 'manual-token-2', true)",
      [two],
    );
  });

  it("moving between two dates that share a limit isn't counted twice", async () => {
    const svc = await workshop(alice, tenantA, 8);
    const one = await date(alice, svc, 1000);
    const two = await date(alice, svc, 1001);
    await share(alice, [one, two], 6);
    const [b] = await hold(tenantA, one, 6);
    // The room is full, but this booking is already in it.
    await as(alice, "select * from public.admin_move_booking($1, $2)", [b.id, two]);
    const rows = await figures(alice, [one, two]);
    expect(rows.every((r) => r.shared_taken === 6)).toBe(true);
  });

  it("untying gives each date back its own limit", async () => {
    const one = await date(alice, await workshop(alice, tenantA, 8), 1100);
    const two = await date(alice, await workshop(alice, tenantA, 8), 1100);
    const group = await share(alice, [one, two], 8);
    await hold(tenantA, one, 8);
    await expect(hold(tenantA, two, 1)).rejects.toThrow(/full/);
    await as(alice, "select public.unshare_session_seats($1)", [group]);
    await hold(tenantA, two, 8);
    expect(
      await db
        .query("select 1 from public.session_seat_groups where id = $1", [group])
        .then((r) => r.rows),
    ).toHaveLength(0);
    const rows = await figures(alice, [one, two]);
    expect(rows.every((r) => r.seat_group_id === null)).toBe(true);
  });
});
