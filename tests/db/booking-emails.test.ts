import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };
type Claim = {
  send_id: string;
  booking_id: string;
  tenant_id: string;
  kind: string;
  tries: number;
};
type Row = {
  id: string;
  status: string;
  tries: number;
  detail: string;
  next_try_at: string | null;
  kind: string;
};

let db: PGlite;
let alice: User;
let bob: User;
let tenantA: string;
let tenantB: string;
let n = 0;

const soon = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();

function service<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
}

async function tenantFor(owner: User, name: string): Promise<string> {
  return asUser(db, owner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select id from public.create_tenant($1, 'UTC', 'USD')",
      [name],
    );
    return rows[0].id;
  });
}

async function workshop(owner: User, tenant: string): Promise<string> {
  n += 1;
  return asUser(db, owner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select public.save_service($1, null, 'workshop', $2, '', 60, 0, 8, true) as id",
      [tenant, `Workshop ${n}`],
    );
    return rows[0].id;
  });
}

async function date(owner: User, serviceId: string, hours: number): Promise<string> {
  return asUser(db, owner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select public.add_session($1, $2, null) as id",
      [serviceId, soon(hours)],
    );
    return rows[0].id;
  });
}

/** A confirmed, free booking, made a while ago unless told otherwise. */
async function book(tenant: string, sessionId: string, hoursAgo = 100): Promise<string> {
  n += 1;
  const rows = await service<{ id: string }>(
    "select id from public.hold_booking($1, $2, null, null, 'Sam', $3, 1, '{}'::jsonb, $4, 30)",
    [tenant, sessionId, `sam${n}@example.com`, `mail-token-${n}`],
  );
  await db.query(
    "update public.bookings set confirmed_at = now() - make_interval(hours => $2), created_at = now() - make_interval(hours => $2) where id = $1",
    [rows[0].id, hoursAgo],
  );
  return rows[0].id;
}

const setEmails = (owner: User, tenant: string, body: object) =>
  asUser(db, owner, (tx) =>
    tx.query("select public.save_config($1, 'bookings', 'emails', $2::jsonb)", [
      tenant,
      JSON.stringify({ version: 1, ...body }),
    ]),
  );

const claim = () => service<Claim>("select * from public.claim_booking_email_sends(200)");
const finish = async (id: string, outcome: string, detail = "") =>
  (
    await service<{ r: { status: string; final: boolean; changed: boolean } }>(
      "select public.finish_booking_email_send($1, $2, $3) as r",
      [id, outcome, detail],
    )
  )[0].r;
const rowsFor = async (bookingId: string) =>
  (
    await db.query<Row>(
      "select id, status, tries, detail, next_try_at, kind from public.booking_emails where booking_id = $1 order by created_at",
      [bookingId],
    )
  ).rows;
const stamp = async (bookingId: string) =>
  (
    await db.query<{ reminder_sent_at: string | null; followup_sent_at: string | null }>(
      "select reminder_sent_at, followup_sent_at from public.bookings where id = $1",
      [bookingId],
    )
  ).rows[0];
/** Makes a failed send's next try due now. */
const dueNow = (bookingId: string) =>
  db.query(
    "update public.booking_emails set next_try_at = now() - interval '1 minute' where booking_id = $1 and next_try_at is not null",
    [bookingId],
  );
/** Clears whatever else is due, so each test sees only its own. */
async function settle() {
  for (const c of await claim()) await finish(c.send_id, "sent");
}

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
});

describe("the record of booking emails", () => {
  it("is read by its own workspace only, and written by nobody but the server", async () => {
    const svc = await workshop(alice, tenantA);
    const booking = await book(tenantA, await date(alice, svc, 12));
    const claims = await claim();
    expect(claims.map((c) => c.booking_id)).toContain(booking);

    const mine = await asUser(db, alice, (tx) => tx.query("select id from public.booking_emails"));
    const theirs = await asUser(db, bob, (tx) => tx.query("select id from public.booking_emails"));
    expect(mine.rows.length).toBeGreaterThan(0);
    expect(theirs.rows.length).toBe(0);
    await expect(
      asAnon(db, (tx) => tx.query("select id from public.booking_emails")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(db, alice, (tx) => tx.query("update public.booking_emails set status = 'sent'")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(db, alice, (tx) => tx.query("delete from public.booking_emails")),
    ).rejects.toThrow(/permission denied/);
    for (const call of [
      "select * from public.claim_booking_email_sends(10)",
      `select public.finish_booking_email_send('${claims[0].send_id}', 'sent', '')`,
    ]) {
      await expect(asUser(db, alice, (tx) => tx.query(call))).rejects.toThrow(/permission denied/);
      await expect(asAnon(db, (tx) => tx.query(call))).rejects.toThrow(/permission denied/);
    }
    await settle();
  });
});

describe("a reminder that fails is not lost", () => {
  it("is stamped only once it really went, and handed out once", async () => {
    const svc = await workshop(alice, tenantA);
    const booking = await book(tenantA, await date(alice, svc, 12));
    const first = (await claim()).filter((c) => c.booking_id === booking);
    expect(first.map((c) => [c.kind, c.tries])).toEqual([["reminder", 1]]);
    // Claimed is not sent: the booking carries no stamp yet.
    expect((await stamp(booking)).reminder_sent_at).toBeNull();
    // While it is being tried nobody else is handed it.
    expect((await claim()).filter((c) => c.booking_id === booking)).toEqual([]);

    expect(await finish(first[0].send_id, "sent")).toMatchObject({ status: "sent", final: true });
    expect((await stamp(booking)).reminder_sent_at).not.toBeNull();
    expect((await claim()).filter((c) => c.booking_id === booking)).toEqual([]);
    // A late second answer changes nothing.
    expect(await finish(first[0].send_id, "refused", "late")).toMatchObject({
      status: "sent",
      changed: false,
    });
  });

  it("a refusal is tried again later, three times in all, then left for a person", async () => {
    const svc = await workshop(alice, tenantA);
    const booking = await book(tenantA, await date(alice, svc, 12));
    const mine = async () => (await claim()).filter((c) => c.booking_id === booking);

    let got = await mine();
    expect(await finish(got[0].send_id, "refused", "The mail service refused it (500).")).toEqual({
      status: "failed",
      final: false,
      changed: true,
    });
    expect((await stamp(booking)).reminder_sent_at).toBeNull();
    let rows = await rowsFor(booking);
    expect(rows[0]).toMatchObject({ status: "failed", tries: 1 });
    expect(rows[0].detail).toContain("500");
    expect(rows[0].next_try_at).not.toBeNull();
    // Not before its time.
    expect(await mine()).toEqual([]);

    await dueNow(booking);
    got = await mine();
    expect(got.map((c) => c.tries)).toEqual([2]);
    expect(await finish(got[0].send_id, "refused")).toMatchObject({ final: false });

    await dueNow(booking);
    got = await mine();
    expect(got.map((c) => c.tries)).toEqual([3]);
    expect(await finish(got[0].send_id, "refused")).toEqual({
      status: "failed",
      final: true,
      changed: true,
    });
    rows = await rowsFor(booking);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "failed", tries: 3, next_try_at: null });
    await dueNow(booking);
    expect(await mine()).toEqual([]);
    expect((await stamp(booking)).reminder_sent_at).toBeNull();
  });

  it("a refusal that then goes through is stamped", async () => {
    const svc = await workshop(alice, tenantA);
    const booking = await book(tenantA, await date(alice, svc, 12));
    const mine = async () => (await claim()).filter((c) => c.booking_id === booking);
    await finish((await mine())[0].send_id, "refused");
    await dueNow(booking);
    expect(await finish((await mine())[0].send_id, "sent")).toMatchObject({ status: "sent" });
    expect((await stamp(booking)).reminder_sent_at).not.toBeNull();
    expect((await rowsFor(booking))[0]).toMatchObject({ status: "sent", tries: 2, detail: "" });
  });

  it("an address the mail service won't write to is not tried again", async () => {
    const svc = await workshop(alice, tenantA);
    const booking = await book(tenantA, await date(alice, svc, 12));
    const got = (await claim()).filter((c) => c.booking_id === booking);
    expect(await finish(got[0].send_id, "rejected", "No good.")).toMatchObject({
      status: "failed",
      final: true,
    });
    await dueNow(booking);
    expect((await claim()).filter((c) => c.booking_id === booking)).toEqual([]);
  });

  it("a send we never heard back about is unsure and never sent again by itself", async () => {
    const svc = await workshop(alice, tenantA);
    const said = await book(tenantA, await date(alice, svc, 12));
    const silent = await book(tenantA, await date(alice, svc, 13));
    const got = await claim();
    // One the worker reported as unsure…
    expect(await finish(got.find((c) => c.booking_id === said)!.send_id, "unsure")).toMatchObject({
      status: "unsure",
      final: true,
    });
    // …and one whose worker died before saying anything.
    await db.query(
      "update public.booking_emails set claimed_at = now() - interval '20 minutes' where booking_id = $1",
      [silent],
    );
    const again = await claim();
    expect(again.filter((c) => [said, silent].includes(c.booking_id))).toEqual([]);
    for (const id of [said, silent]) {
      expect((await rowsFor(id))[0]).toMatchObject({ status: "unsure", next_try_at: null });
      expect((await stamp(id)).reminder_sent_at).toBeNull();
    }
    // A late answer for the silent one can't flip it to something else.
    expect(
      await finish(got.find((c) => c.booking_id === silent)!.send_id, "refused"),
    ).toMatchObject({ status: "unsure", changed: false });
  });

  it("a retry is dropped once the date has started or the booking is cancelled", async () => {
    const svc = await workshop(bob, tenantB);
    const started = await date(bob, svc, 12);
    const late = await book(tenantB, started);
    const gone = await book(tenantB, await date(bob, svc, 14));
    const got = await claim();
    for (const id of [late, gone]) {
      await finish(got.find((c) => c.booking_id === id)!.send_id, "refused");
      await dueNow(id);
    }
    await db.query(
      "update public.sessions set starts_at = now() - interval '1 hour' where id = $1",
      [started],
    );
    await db.query(
      "update public.bookings set status = 'cancelled', cancelled_at = now() where id = $1",
      [gone],
    );
    expect((await claim()).filter((c) => [late, gone].includes(c.booking_id))).toEqual([]);
  });

  it("a booking reminded before this record existed is not reminded again", async () => {
    const svc = await workshop(bob, tenantB);
    const booking = await book(tenantB, await date(bob, svc, 12));
    await db.query("update public.bookings set reminder_sent_at = now() where id = $1", [booking]);
    expect((await claim()).filter((c) => c.booking_id === booking)).toEqual([]);
  });

  it("a booking moved to another date is reminded for the new one", async () => {
    const svc = await workshop(bob, tenantB);
    const from = await date(bob, svc, 12);
    const to = await date(bob, svc, 20);
    const booking = await book(tenantB, from);
    await finish((await claim()).find((c) => c.booking_id === booking)!.send_id, "sent");
    await asUser(db, bob, (tx) =>
      tx.query("select * from public.admin_move_booking($1, $2)", [booking, to]),
    );
    const again = (await claim()).filter((c) => c.booking_id === booking);
    expect(again.map((c) => c.kind)).toEqual(["reminder"]);
    await finish(again[0].send_id, "sent");
    expect((await rowsFor(booking)).map((r) => r.status)).toEqual(["sent", "sent"]);
  });
});

describe("the day-of reminder", () => {
  it("is off until switched on, comes after the first reminder, and skips late bookers", async () => {
    const owner = { id: await createUser(db, "dayof@c.test"), email: "dayof@c.test" };
    const tenant = await tenantFor(owner, "Day Of Studio");
    const svc = await workshop(owner, tenant);
    const inAnHour = await date(owner, svc, 1);
    const tomorrow = await date(owner, svc, 20);
    const early = await book(tenant, inAnHour);
    const justBooked = await book(tenant, inAnHour, 0);
    const later = await book(tenant, tomorrow);
    const mine = async () =>
      (await claim())
        .filter((c) => c.tenant_id === tenant)
        .map((c) => [c.booking_id, c.kind] as const);
    const done = async () => {
      for (const c of await claim()) await finish(c.send_id, "sent");
    };

    // Off by default: only the ordinary reminders are due.
    const first = await mine();
    expect(first.every(([, kind]) => kind === "reminder")).toBe(true);
    expect(first.map(([id]) => id).sort()).toEqual([early, justBooked, later].sort());
    await db.query("update public.booking_emails set status = 'sent' where tenant_id = $1", [
      tenant,
    ]);

    await setEmails(owner, tenant, { day_of_on: true, day_of_hours: 2 });
    // Only the person who booked before the last two hours; not tomorrow's date yet.
    expect(await mine()).toEqual([[early, "day_of"]]);
    await db.query("update public.booking_emails set status = 'sent' where tenant_id = $1", [
      tenant,
    ]);
    expect(await mine()).toEqual([]);

    // A day-of reminder no shorter than the first reminder would be a twin of it: not sent.
    const other = await book(tenant, await date(owner, svc, 1.5));
    await db.query("update public.bookings set reminder_sent_at = now() where id = $1", [other]);
    await setEmails(owner, tenant, { day_of_on: true, day_of_hours: 24, reminder_hours: 24 });
    expect(await mine()).toEqual([]);
    await setEmails(owner, tenant, { day_of_on: true, day_of_hours: 2 });
    expect(await mine()).toEqual([[other, "day_of"]]);
    await done();
  });
});

describe("when the shop cancels a booking", () => {
  const order = async (tenant: string, session: string, id: string, seats: number) =>
    (
      await service<{ r: { result: string; booking_id: string } }>(
        "select public.book_from_shop($1, $2, $3, '#2001', 'Sam Shopper', 'shopper@example.com', $4, 9000, $5) as r",
        [tenant, session, id, seats, `shop-mail-${id}-${session}`],
      )
    )[0].r;
  const queue = async (tenant: string, booking: string) =>
    (
      await service<{ q: boolean }>("select public.queue_booking_cancel_email($1, $2) as q", [
        tenant,
        booking,
      ])
    )[0].q;

  it("the customer's email is queued once, sent by the worker, and retried like the rest", async () => {
    const svc = await workshop(alice, tenantA);
    const session = await date(alice, svc, 72);
    const made = await order(tenantA, session, "9001", 2);
    await settle();
    // Not for a booking that is still on.
    expect(await queue(tenantA, made.booking_id)).toBe(false);
    // A refund of every place cancels it.
    expect((await order(tenantA, session, "9001", 0)).result).toBe("cancelled");
    expect(await queue(tenantA, made.booking_id)).toBe(true);
    expect(await queue(tenantA, made.booking_id)).toBe(false);

    let got = (await claim()).filter((c) => c.booking_id === made.booking_id);
    expect(got.map((c) => [c.kind, c.tries])).toEqual([["cancelled", 1]]);
    await finish(got[0].send_id, "refused");
    await dueNow(made.booking_id);
    got = (await claim()).filter((c) => c.booking_id === made.booking_id);
    expect(got.map((c) => c.tries)).toEqual([2]);
    expect(await finish(got[0].send_id, "sent")).toMatchObject({ status: "sent" });
    expect((await claim()).filter((c) => c.booking_id === made.booking_id)).toEqual([]);
  });

  it("a cancelled order says which bookings went; nothing is queued for a past date, a switched-off workspace or another workspace", async () => {
    const svc = await workshop(bob, tenantB);
    const coming = await date(bob, svc, 72);
    const past = await date(bob, svc, 80);
    const a = await order(tenantB, coming, "9100", 1);
    const b = await order(tenantB, past, "9100", 1);
    await settle();
    const gone = await service<{ id: string }>(
      "select public.cancel_shop_order_bookings($1, '9100') as id",
      [tenantB],
    );
    expect(gone.map((g) => g.id).sort()).toEqual([a.booking_id, b.booking_id].sort());
    expect(
      await service("select public.cancel_shop_order_bookings($1, '9100') as id", [tenantB]),
    ).toEqual([]);

    await db.query(
      "update public.sessions set starts_at = now() - interval '2 hours' where id = $1",
      [past],
    );
    expect(await queue(tenantB, b.booking_id)).toBe(false);
    // Another workspace can't queue it.
    expect(await queue(tenantA, a.booking_id)).toBe(false);
    await setEmails(bob, tenantB, { shop_cancel_email: false });
    expect(await queue(tenantB, a.booking_id)).toBe(false);
    await setEmails(bob, tenantB, { shop_cancel_email: true });
    expect(await queue(tenantB, a.booking_id)).toBe(true);
    await settle();

    for (const call of [
      `select public.cancel_shop_order_bookings('${tenantB}', '9100')`,
      `select public.queue_booking_cancel_email('${tenantB}', '${a.booking_id}')`,
    ]) {
      await expect(asUser(db, bob, (tx) => tx.query(call))).rejects.toThrow(/permission denied/);
    }
  });
});

describe("sending the confirmation again", () => {
  it("gives the booking a new link, for its own managers only", async () => {
    const owner = { id: await createUser(db, "resend@e.test"), email: "resend@e.test" };
    const member = { id: await createUser(db, "member@e.test"), email: "member@e.test" };
    const tenant = await tenantFor(owner, "Resend Studio");
    await db.query(
      "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
      [tenant, member.id],
    );
    const svc = await workshop(owner, tenant);
    const booking = await book(tenant, await date(owner, svc, 48));
    const oldToken = `mail-token-${n}`;
    const fresh = "a-brand-new-link-token-of-good-length";
    const byToken = async (token: string) =>
      (
        await service<{ booking_id: string }>(
          "select booking_id from public.booking_details(null, null, $1)",
          [token],
        )
      ).map((r) => r.booking_id);
    expect(await byToken(oldToken)).toEqual([booking]);

    const renew = (who: User, token = fresh) =>
      asUser(db, who, (tx) =>
        tx.query("select public.renew_booking_link($1, $2)", [booking, token]),
      );
    await expect(renew(member)).rejects.toThrow(/owners and admins/i);
    await expect(renew(bob)).rejects.toThrow(/not found/i);
    await expect(renew(owner, "short")).rejects.toThrow(/too short/i);
    await expect(
      asAnon(db, (tx) => tx.query("select public.renew_booking_link($1, $2)", [booking, fresh])),
    ).rejects.toThrow(/permission denied/);
    expect(await byToken(oldToken)).toEqual([booking]);

    await renew(owner);
    expect(await byToken(fresh)).toEqual([booking]);
    expect(await byToken(oldToken)).toEqual([]);
  });
});
