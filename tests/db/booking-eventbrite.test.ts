import { createHash, randomBytes } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Eventbrite as a second place to sell, in the database:
 *   - links and switches are manager-only and per workspace;
 *   - pushes are handed out once, only where everything is switched on, and
 *     a refusal / an unclear answer is written down (unsure never by itself);
 *   - seats left count bookings from every place and shared rooms;
 *   - orders become bookings once, under the seat rules, oversold when full;
 *   - refunds and fewer tickets give places back;
 *   - the webhook's secret finds only its own workspace.
 */
type User = { id: string; email: string };
type Push = {
  id: string;
  tenant_id: string;
  session_id: string;
  event_id: string;
  ticket_class_id: string;
  seats_left: number;
};
type Result = {
  result: string;
  booking_id?: string;
  oversold?: boolean;
  date_cancelled?: boolean;
  cancelled?: string[];
};

let db: PGlite;
let alice: User; // owner of A
let mel: User; // member of A
let bob: User; // owner of B
let tenantA: string;
let tenantB: string;
let n = 0;

const soon = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
const as = <T>(user: User, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);
const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

async function tenantFor(owner: User, name: string): Promise<string> {
  const rows = await as<{ id: string }>(
    owner,
    "select id from public.create_tenant($1, 'America/New_York', 'USD')",
    [name],
  );
  return rows[0].id;
}

async function workshop(owner: User, tenant: string, capacity: number) {
  n += 1;
  const rows = await as<{ id: string }>(
    owner,
    "select public.save_service($1, null, 'workshop', $2, '', 120, 0, $3, true) as id",
    [tenant, `Workshop ${n}`, capacity],
  );
  return rows[0].id;
}

async function date(owner: User, serviceId: string, hours = 48): Promise<string> {
  const rows = await as<{ id: string }>(owner, "select public.add_session($1, $2, null) as id", [
    serviceId,
    soon(hours),
  ]);
  return rows[0].id;
}

const connect = (tenant: string, owner: User) =>
  service(
    "select public.save_connection($1, 'eventbrite', $2, 'Studio on Eventbrite', '{}'::text[], $3::jsonb, $4, '{}'::jsonb)",
    [
      tenant,
      `org-${tenant.slice(0, 8)}`,
      JSON.stringify({ access_token: "fake-eb-token" }),
      owner.id,
    ],
  );

const switchOn = (who: User, serviceId: string, on = true) =>
  as(who, "select public.set_service_eventbrite($1, $2)", [serviceId, on]);

const link = (who: User, session: string, event: string | null, ticket: string | null = "77") =>
  as<{ id: string | null }>(
    who,
    "select public.link_session_eventbrite($1, $2, $3, 'Rug night') as id",
    [session, event, ticket],
  );

const claim = () => service<Push>("select * from public.claim_eventbrite_pushes(50)");
const finish = (id: string, outcome: string, detail: string | null = null) =>
  service<{ s: string }>("select public.finish_eventbrite_push($1, $2, $3, 10, 2, false, 8) as s", [
    id,
    outcome,
    detail,
  ]);
const listing = async (session: string) =>
  (
    await service<{ status: string; detail: string; tries: number; check_due_at: string }>(
      "select status, detail, tries, check_due_at from public.eventbrite_listings where session_id = $1",
      [session],
    )
  )[0];
const makeDue = (session: string) =>
  db.query(
    "update public.eventbrite_listings set check_due_at = now() - interval '1 minute', next_try_at = now() - interval '1 minute' where session_id = $1",
    [session],
  );

async function book(tenant: string, event: string, order: string, seats: number) {
  n += 1;
  const rows = await service<{ r: Result }>(
    "select public.book_from_eventbrite($1, $2, $3, 'Jo Ng', 'Jo@Example.com', '215-555-0100', $4, $5) as r",
    [tenant, event, order, seats, `eb-token-${n}`],
  );
  return rows[0].r;
}

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  mel = { id: await createUser(db, "mel@a.test"), email: "mel@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, mel.id],
  );
});

describe("linking dates to Eventbrite events", () => {
  it("needs the workshop switched on and Eventbrite connected, and only a manager", async () => {
    const w = await workshop(alice, tenantA, 10);
    const d = await date(alice, w);
    await expect(link(alice, d, "1001")).rejects.toThrow(/switched on/);
    await expect(switchOn(mel, w)).rejects.toThrow(/owners and admins/);
    await switchOn(alice, w);
    await expect(link(alice, d, "1001")).rejects.toThrow(/isn't connected/);
    await connect(tenantA, alice);
    await expect(link(mel, d, "1001")).rejects.toThrow(/owners and admins/);
    const [{ id }] = await link(alice, d, "1001");
    expect(id).toBeTruthy();
    // One event sells one date.
    const other = await date(alice, w, 72);
    await expect(link(alice, other, "1001")).rejects.toThrow(/event_taken/);
    await expect(link(alice, other, "not-an-id")).rejects.toThrow(/isn't an Eventbrite event/);
    // Unlinking is an empty event.
    expect((await link(alice, other, "1002"))[0].id).toBeTruthy();
    expect((await link(alice, other, null))[0].id).toBeNull();
  });

  it("are read only by their own workspace, and never written directly", async () => {
    const mine = await as<{ event_id: string }>(
      mel,
      "select event_id from public.eventbrite_listings",
    );
    expect(mine.map((r) => r.event_id)).toEqual(["1001"]);
    expect(await as(bob, "select id from public.eventbrite_listings")).toHaveLength(0);
    await expect(
      as(alice, "update public.eventbrite_listings set status = 'done'"),
    ).rejects.toThrow(/permission denied/);
    await expect(as(alice, "delete from public.eventbrite_listings")).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      asAnon(db, (tx) => tx.query("select * from public.eventbrite_listings")),
    ).rejects.toThrow(/permission denied/);
    // Bob can't switch A's workshop or link A's dates.
    const [{ id: aService }] = await service<{ id: string }>(
      "select id from public.services where tenant_id = $1 limit 1",
      [tenantA],
    );
    await expect(switchOn(bob, aService)).rejects.toThrow(/owners and admins/);
    // Nor reach the worker's functions.
    await expect(as(alice, "select * from public.claim_eventbrite_pushes(5)")).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      as(alice, "select public.book_from_eventbrite($1, '1001', '1', 'x', 'x@x.co', '', 1, 't')", [
        tenantA,
      ]),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("pushing seats left", () => {
  let w: string;
  let d: string;

  beforeAll(async () => {
    w = await workshop(alice, tenantA, 8);
    d = await date(alice, w);
    await switchOn(alice, w);
    await link(alice, d, "2001", "88");
  });

  it("hands a due date out once, with places left from every source", async () => {
    // A booking made on our own page, and one from the shop.
    await service(
      "select public.hold_booking($1, $2, null, null, 'Pat', 'pat@x.co', 2, '{}', 'h1')",
      [tenantA, d],
    );
    await service(
      "select public.book_from_shop($1, $2, 'o-1', '#1', 'Sam', 'sam@x.co', 1, 5000, 's1')",
      [tenantA, d],
    );
    const first = (await claim()).filter((p) => p.session_id === d);
    expect(first).toEqual([
      expect.objectContaining({ event_id: "2001", ticket_class_id: "88", seats_left: 5 }),
    ]);
    // Handed out once: a second claim gets nothing while it is out.
    expect((await claim()).filter((p) => p.session_id === d)).toEqual([]);
    expect(await finish(first[0].id, "done")).toEqual([{ s: "done" }]);
    // Finished once only.
    expect(await finish(first[0].id, "done")).toEqual([{ s: null }]);
    expect(await listing(d)).toMatchObject({ status: "done", tries: 0 });
    // Not due again for a few minutes.
    expect((await claim()).filter((p) => p.session_id === d)).toEqual([]);
  });

  it("is due again at once when a booking changes the places", async () => {
    await service(
      "select public.hold_booking($1, $2, null, null, 'Lee', 'lee@x.co', 1, '{}', 'h2')",
      [tenantA, d],
    );
    const due = (await claim()).filter((p) => p.session_id === d);
    expect(due.map((p) => p.seats_left)).toEqual([4]);
    await finish(due[0].id, "done");
  });

  it("counts a shared room", async () => {
    const w2 = await workshop(alice, tenantA, 8);
    const d2 = await date(alice, w2);
    await service(
      "select public.hold_booking($1, $2, null, null, 'Kim', 'kim@x.co', 3, '{}', 'h3')",
      [tenantA, d2],
    );
    // The two share a room of 9: 4 taken on d, 3 on d2.
    await as(alice, "select public.share_session_seats($1, 9)", [[d, d2]]);
    const due = (await claim()).filter((p) => p.session_id === d);
    expect(due.map((p) => p.seats_left)).toEqual([2]);
    await finish(due[0].id, "done");
  });

  it("tries a refusal again a few times, then waits for a manager", async () => {
    await makeDue(d);
    let [push] = (await claim()).filter((p) => p.session_id === d);
    await finish(push.id, "refused", "Eventbrite: INVALID (quantity_total)");
    expect(await listing(d)).toMatchObject({ status: "failed", tries: 1 });
    // Not before its time.
    expect((await claim()).filter((p) => p.session_id === d)).toEqual([]);
    for (const tries of [2, 3]) {
      await makeDue(d);
      [push] = (await claim()).filter((p) => p.session_id === d);
      expect(push).toBeTruthy();
      await finish(push.id, "refused", "Still no");
      expect((await listing(d)).tries).toBe(tries);
    }
    await makeDue(d);
    expect((await claim()).filter((p) => p.session_id === d)).toEqual([]);
    expect(await listing(d)).toMatchObject({ status: "failed", detail: "Still no" });
    // Only a manager can try again.
    const [{ id }] = await service<{ id: string }>(
      "select id from public.eventbrite_listings where session_id = $1",
      [d],
    );
    await expect(as(mel, "select public.retry_eventbrite_listing($1)", [id])).rejects.toThrow(
      /owners and admins/,
    );
    await expect(as(bob, "select public.retry_eventbrite_listing($1)", [id])).rejects.toThrow(
      /not found/,
    );
    await as(alice, "select public.retry_eventbrite_listing($1)", [id]);
    [push] = (await claim()).filter((p) => p.session_id === d);
    expect(push).toBeTruthy();
    await finish(push.id, "done");
    await expect(as(alice, "select public.retry_eventbrite_listing($1)", [id])).rejects.toThrow(
      /nothing to try again/,
    );
  });

  it("never asks again by itself after an unclear answer, or a claim never finished", async () => {
    await makeDue(d);
    let [push] = (await claim()).filter((p) => p.session_id === d);
    await finish(push.id, "unsure");
    await makeDue(d);
    expect((await claim()).filter((p) => p.session_id === d)).toEqual([]);
    expect((await listing(d)).status).toBe("unsure");

    const [{ id }] = await service<{ id: string }>(
      "select id from public.eventbrite_listings where session_id = $1",
      [d],
    );
    await as(alice, "select public.retry_eventbrite_listing($1)", [id]);
    [push] = (await claim()).filter((p) => p.session_id === d);
    // The worker dies part-way through.
    await db.query(
      "update public.eventbrite_listings set claimed_at = now() - interval '20 minutes' where id = $1",
      [push.id],
    );
    await makeDue(d);
    expect((await claim()).filter((p) => p.session_id === d)).toEqual([]);
    expect(await listing(d)).toMatchObject({ status: "unsure" });
    expect((await listing(d)).detail).toMatch(/can't tell/);
  });

  it("pushes nothing for a workshop switched off, or a workspace not connected", async () => {
    const [{ id }] = await service<{ id: string }>(
      "select id from public.eventbrite_listings where session_id = $1",
      [d],
    );
    await as(alice, "select public.retry_eventbrite_listing($1)", [id]);
    await switchOn(alice, w, false);
    expect((await claim()).filter((p) => p.session_id === d)).toEqual([]);
    await switchOn(alice, w, true);
    // Bob's workspace has a switched-on workshop but no connection: nothing.
    const bw = await workshop(bob, tenantB, 5);
    await switchOn(bob, bw);
    const claimed = await claim();
    expect(claimed.some((p) => p.tenant_id === tenantB)).toBe(false);
    const push = claimed.find((p) => p.session_id === d);
    expect(push).toBeTruthy();
    await finish(push!.id, "done");
  });

  it("pushes no places left for a date that was called off", async () => {
    const w3 = await workshop(alice, tenantA, 6);
    await switchOn(alice, w3);
    const d3 = await date(alice, w3);
    await link(alice, d3, "2003", "89");
    await as(alice, "select * from public.cancel_session($1)", [d3]);
    const push = (await claim()).find((p) => p.session_id === d3);
    expect(push?.seats_left).toBe(0);
    await finish(push!.id, "done");
  });
});

describe("orders becoming bookings", () => {
  let w: string;
  let d: string;

  beforeAll(async () => {
    w = await workshop(alice, tenantA, 3);
    d = await date(alice, w);
    await switchOn(alice, w);
    await link(alice, d, "3001", "99");
  });

  it("books an order once, on the linked date, keeping only what a booking keeps", async () => {
    const first = await book(tenantA, "3001", "9001", 2);
    expect(first).toMatchObject({ result: "booked", oversold: false, date_cancelled: false });
    expect(await book(tenantA, "3001", "9001", 2)).toMatchObject({
      result: "unchanged",
      booking_id: first.booking_id,
    });
    const [row] = await service<{
      source: string;
      customer_email: string;
      customer_phone: string;
      text_opt_in: boolean;
      amount_cents: number;
      status: string;
    }>(
      "select source, customer_email, customer_phone, text_opt_in, amount_cents, status from public.bookings where id = $1",
      [first.booking_id],
    );
    expect(row).toEqual({
      source: "eventbrite",
      customer_email: "jo@example.com",
      customer_phone: "215-555-0100",
      text_opt_in: false,
      amount_cents: 0,
      status: "confirmed",
    });
    // An event nobody linked: nothing booked, nothing lost (the worker tells the team).
    expect(await book(tenantA, "3999", "9002", 1)).toEqual({ result: "no_listing" });
    // Bob's workspace can't book onto A's event.
    expect(await book(tenantB, "3001", "9003", 1)).toEqual({ result: "no_listing" });
  });

  it("books a full date anyway and flags it oversold", async () => {
    const over = await book(tenantA, "3001", "9004", 2);
    expect(over).toMatchObject({ result: "booked", oversold: true });
    // Even a closed date takes a paid order.
    await db.query("update public.sessions set bookings_closed = true where id = $1", [d]);
    expect(await book(tenantA, "3001", "9005", 1)).toMatchObject({
      result: "booked",
      oversold: true,
    });
  });

  it("follows fewer tickets and refunds, giving the places back", async () => {
    expect(await book(tenantA, "3001", "9004", 1)).toMatchObject({ result: "resized" });
    const back = await book(tenantA, "3001", "9005", 0);
    expect(back.result).toBe("cancelled");
    expect(back.cancelled).toHaveLength(1);
    expect(await book(tenantA, "3001", "9005", 0)).toMatchObject({ result: "unchanged" });
    // A refund for an order we never booked is nothing at all.
    expect(await book(tenantA, "3001", "9006", 0)).toEqual({ result: "nothing" });
    const { rows } = await db.query<{ left: number }>("select private.seats_left($1) as left", [d]);
    const left = rows[0].left;
    expect(left).toBe(0); // 2 + 1 of 3
  });

  it("finds an order after it was moved, and after its event was unlinked", async () => {
    const d2 = await date(alice, w, 96);
    const [{ id: booking }] = await service<{ id: string }>(
      "select id from public.bookings where eventbrite_order_id = '9001'",
    );
    await as(alice, "select * from public.admin_move_booking($1, $2)", [booking, d2]);
    expect(await book(tenantA, "3001", "9001", 1)).toMatchObject({
      result: "resized",
      booking_id: booking,
    });
    await link(alice, d, null);
    const gone = await book(tenantA, "3001", "9001", 0);
    expect(gone).toMatchObject({ result: "cancelled", booking_id: booking });
  });
});

describe("the webhook's secret", () => {
  const tokenA = randomBytes(24).toString("base64url");
  const tokenB = randomBytes(24).toString("base64url");

  const enqueue = async (
    token: string,
    order: string,
    refunded = false,
    hook: string | null = null,
  ) =>
    (
      await service<{ r: string }>("select public.enqueue_eventbrite_event($1, $2, $3, $4) as r", [
        hash(token),
        order,
        refunded,
        hook,
      ])
    )[0].r;

  it("is set by a manager and only ever kept as a hash", async () => {
    await expect(
      as(mel, "select public.begin_eventbrite_hook($1, $2)", [tenantA, hash(tokenA)]),
    ).rejects.toThrow(/owners and admins/);
    await as(alice, "select public.begin_eventbrite_hook($1, $2)", [tenantA, hash(tokenA)]);
    // Not listened to until Eventbrite took the address.
    expect(await enqueue(tokenA, "5001")).toBe("unknown");
    expect(
      (
        await as<{ m: boolean }>(alice, "select public.eventbrite_hook_matches($1, $2) as m", [
          tenantA,
          [hash("something else"), hash(tokenA)],
        ])
      )[0].m,
    ).toBe(true);
    await as(alice, "select public.finish_eventbrite_hook($1, '4242')", [tenantA]);
    const state = await as<{ webhook_id: string }>(
      mel,
      "select webhook_id from public.eventbrite_order_updates($1)",
      [tenantA],
    );
    expect(state).toEqual([{ webhook_id: "4242" }]);
    expect(
      await as(bob, "select * from public.eventbrite_order_updates($1)", [tenantA]),
    ).toHaveLength(0);
    await expect(as(alice, "select * from private.eventbrite_hooks")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("queues an order once for its own workspace, and nothing for a stranger", async () => {
    expect(await enqueue(tokenA, "5001")).toBe("queued");
    expect(await enqueue(tokenA, "5001", true)).toBe("queued");
    expect(await enqueue(tokenA, "5001", false, "4242")).toBe("queued");
    expect(await enqueue(tokenA, "5001", false, "9999")).toBe("unknown");
    expect(await enqueue(tokenB, "5001")).toBe("unknown");
    expect(await enqueue(tokenA, "../users/me")).toBe("unknown");
    // B has no Eventbrite connection, so its hook is never listened to.
    await as(bob, "select public.begin_eventbrite_hook($1, $2)", [tenantB, hash(tokenB)]);
    await as(bob, "select public.finish_eventbrite_hook($1, '4343')", [tenantB]);
    expect(await enqueue(tokenB, "5001")).toBe("unknown");

    const claimed = await service<{
      id: string;
      tenant_id: string;
      order_id: string;
      refunded: boolean;
      tries: number;
    }>("select * from public.claim_eventbrite_events(10)");
    expect(claimed).toEqual([
      expect.objectContaining({ tenant_id: tenantA, order_id: "5001", refunded: true, tries: 1 }),
    ]);
    expect(await service("select * from public.claim_eventbrite_events(10)")).toEqual([]);
    await service("select public.finish_eventbrite_event($1, 'retry', 'Eventbrite was busy')", [
      claimed[0].id,
    ]);
    await db.query(
      "update private.eventbrite_events set next_try_at = now() - interval '1 minute'",
    );
    const again = await service<{ id: string; tries: number }>(
      "select * from public.claim_eventbrite_events(10)",
    );
    expect(again.map((r) => r.tries)).toEqual([2]);
    await service("select public.finish_eventbrite_event($1, 'done', 'booked')", [again[0].id]);
    // A new nudge after it was read is a new read.
    expect(await enqueue(tokenA, "5001")).toBe("queued");
    expect(await service("select * from public.claim_eventbrite_events(10)")).toHaveLength(1);
  });
});
