import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Reconnecting a shop, or the one-off read of its history, hands the sync
 * every order of the last months again. An order for a class already over,
 * or one placed before the workshop was sold through the shop here (or
 * before its date existed here), belongs to whatever took bookings then: it
 * may be written down for the roster, but quietly. Nothing is ever sent to
 * its customer by itself: no confirmation, reminder, thank-you, cancellation
 * notice or text.
 */

type User = { id: string; email: string };
type Outcome = { result: string; booking_id?: string };

let db: PGlite;
let alice: User;
let tenant: string;
let workshop: string;
let n = 0;

const PRODUCT = "9200";
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
const as = <T>(user: User, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);

async function date(hours: number): Promise<string> {
  const rows = await as<{ id: string }>(alice, "select public.add_session($1, $2, null) as id", [
    workshop,
    hoursFromNow(Math.max(hours, 1)),
  ]);
  if (hours < 1) {
    // A class already over: moved back by hand, as a long-past date would be.
    await db.query(
      "update public.sessions set starts_at = $2, ends_at = $2::timestamptz + interval '1 hour', created_at = now() - interval '90 days' where id = $1",
      [rows[0].id, hoursFromNow(hours)],
    );
  }
  return rows[0].id;
}

/** The shop sync with one order: stored, then booked. */
async function sync(
  order: string,
  session: string,
  qty: number,
  placed = new Date().toISOString(),
): Promise<Outcome> {
  await service(
    "select public.upsert_commerce_batch($1, 'shopify', '[]'::jsonb, '[]'::jsonb, $2::jsonb)",
    [
      tenant,
      JSON.stringify([
        {
          external_id: order,
          name: `#${order}`,
          email: "sam@example.com",
          processed_at: placed,
          currency: "USD",
          cancelled_at: null,
          lines: [
            {
              external_id: `${order}1`,
              product_external_id: PRODUCT,
              title: "Rug Tufting Workshop",
              quantity: qty,
              unit_price: 90,
              session_ref: session,
            },
          ],
        },
      ]),
    ],
  );
  n += 1;
  const [{ r }] = await service<{ r: Outcome }>(
    "select public.book_from_shop($1, $2, $3, $4, 'Sam Shopper', 'sam@example.com', $5, 9000, $6) as r",
    [tenant, session, order, `#${order}`, qty, `history-token-${n}`],
  );
  return r;
}

const emailClaims = () =>
  service<{ booking_id: string; kind: string }>(
    "select booking_id, kind from public.claim_booking_email_sends(200)",
  );
const textClaims = () =>
  service<{ booking_id: string; kind: string }>(
    "select booking_id, kind from public.claim_booking_text_sends(200)",
  );

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@example.com"), email: "alice@example.com" };
  const [{ id }] = await as<{ id: string }>(
    alice,
    "select id from public.create_tenant('History studio', 'UTC', 'USD')",
  );
  tenant = id;
  const [{ id: svc }] = await as<{ id: string }>(
    alice,
    "select public.save_service($1, null, 'workshop', 'Rug tufting', '', 60, 9000, 8, true) as id",
    [tenant],
  );
  workshop = svc;
  await as(alice, "select public.set_service_shop_product($1, $2, null)", [workshop, PRODUCT]);
  // Every message on, so anything that could go would.
  await as(alice, "select public.save_config($1, 'bookings', 'emails', $2::jsonb)", [
    tenant,
    JSON.stringify({ version: 1, reminder_hours: 48, followup_on: true, followup_hours: 1 }),
  ]);
  await service(
    "select public.save_connection($1, 'twilio', $2, 'Twilio', '{}'::text[], $3::jsonb, $4, $5::jsonb)",
    [
      tenant,
      "AC" + "1".repeat(32),
      JSON.stringify({ access_token: "f".repeat(32), secrets: { sender: "+12155550199" } }),
      alice.id,
      JSON.stringify({ sender: "+12155550199", sender_kind: "number" }),
    ],
  );
  await as(alice, "select public.save_config($1, 'bookings', 'texts', $2::jsonb)", [
    tenant,
    JSON.stringify({
      version: 1,
      on: true,
      reminder_hours: 48,
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
});

const textsOn = (booking: string) =>
  service("select public.set_booking_text_consent($1, $2, '+12155550134', true)", [
    tenant,
    booking,
  ]);

describe("orders read again from the shop's history", () => {
  it("writes down a class already over quietly, and nothing is ever sent for it", async () => {
    const past = await date(-30);
    const r = await sync("8001", past, 2);
    expect(r.result).toBe("recorded");
    await textsOn(r.booking_id!);
    const [row] = (
      await db.query<{ status: string; history_only: boolean; seats: number }>(
        "select status::text, history_only, seats from public.bookings where id = $1",
        [r.booking_id],
      )
    ).rows;
    expect(row).toEqual({ status: "confirmed", history_only: true, seats: 2 });
    // The thank-you would be due for a class that ended a day ago.
    expect((await emailClaims()).filter((c) => c.booking_id === r.booking_id)).toEqual([]);
    expect((await textClaims()).filter((c) => c.booking_id === r.booking_id)).toEqual([]);
    // Told again, it stays as it is.
    expect((await sync("8001", past, 2)).result).toBe("unchanged");
  });

  it("writes down an order placed before the workshop was sold through the shop here, quietly", async () => {
    const soon = await date(24);
    const r = await sync("8002", soon, 1, hoursFromNow(-24 * 10));
    expect(r.result).toBe("recorded");
    await textsOn(r.booking_id!);
    // Its reminder would be due now (the class is a day away).
    expect((await emailClaims()).filter((c) => c.booking_id === r.booking_id)).toEqual([]);
    expect((await textClaims()).filter((c) => c.booking_id === r.booking_id)).toEqual([]);
    // A refund of it is bookkeeping: no cancellation notice, no text.
    const refunded = await sync("8002", soon, 0, hoursFromNow(-24 * 10));
    expect(refunded.result).toBe("cancelled");
    const [{ queued }] = await service<{ queued: boolean }>(
      "select public.queue_booking_cancel_email($1, $2) as queued",
      [tenant, r.booking_id],
    );
    expect(queued).toBe(false);
    const [{ t }] = await service<{ t: string }>(
      "select public.queue_booking_text($1, $2, 'cancelled') as t",
      [tenant, r.booking_id],
    );
    expect(t).toBe("skipped");
  });

  it("writes down an order placed before its date existed here, quietly", async () => {
    const soon = await date(30);
    // The date came across from the earlier app after the order was placed.
    await db.query(
      "update public.sessions set created_at = now() - interval '1 day' where id = $1",
      [soon],
    );
    const r = await sync("8003", soon, 1, hoursFromNow(-48));
    expect(r.result).toBe("recorded");
  });

  it("books a new order as before, and its messages go as usual", async () => {
    const soon = await date(26);
    const r = await sync("8004", soon, 1);
    expect(r.result).toBe("booked");
    await textsOn(r.booking_id!);
    await db.query(
      "update public.bookings set created_at = now() - interval '7 days', confirmed_at = now() - interval '7 days' where id = $1",
      [r.booking_id],
    );
    expect((await emailClaims()).filter((c) => c.booking_id === r.booking_id)).toEqual([
      { booking_id: r.booking_id, kind: "reminder" },
    ]);
    expect((await textClaims()).filter((c) => c.booking_id === r.booking_id)).toEqual([
      { booking_id: r.booking_id, kind: "reminder" },
    ]);
  });

  it("lets the bookings file take over a quiet booking: what it says wasn't sent still goes", async () => {
    const soon = await date(28);
    const r = await sync("8005", soon, 1, hoursFromNow(-24 * 10));
    expect(r.result).toBe("recorded");
    const [{ res }] = await as<{ res: { new: number; same: number; changed: number } }>(
      alice,
      "select public.import_bookings($1, gen_random_uuid(), $2::jsonb, 'bookings.csv', true) as res",
      [
        tenant,
        JSON.stringify([
          {
            line: 2,
            ref: "earlier-8005",
            session_ref: soon,
            name: "Sam Shopper",
            email: "sam@example.com",
            seats: 1,
            status: "confirmed",
            source: "online",
            shop_order_id: "8005",
            shop_order_name: "#8005",
          },
        ]),
      ],
    );
    expect(res.new).toBe(0);
    const [row] = (
      await db.query<{ history_only: boolean }>(
        "select history_only from public.bookings where id = $1",
        [r.booking_id],
      )
    ).rows;
    expect(row.history_only).toBe(false);
    expect((await emailClaims()).filter((c) => c.booking_id === r.booking_id)).toEqual([
      { booking_id: r.booking_id, kind: "reminder" },
    ]);
  });
});
