import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createTestDb, createUser } from "./harness";

/**
 * A shop order is told to us many times over its life. A booking made from
 * one of its lines may have been moved to another date since (by a manager
 * here, or in the earlier app before it was brought across); the next time
 * the order comes round, that line must never be booked a second time on the
 * date the cart named, and the existing booking keeps following the order.
 */

type User = { id: string; email: string };
type Outcome = { result: string; booking_id?: string };
type BookingRow = { id: string; session_id: string; status: string; seats: number };

let db: PGlite;
let alice: User;
let tenant: string;
let workshop: string;
let n = 0;

const PRODUCT = "9100";
const soon = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
const as = <T>(user: User, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);

async function date(hours: number): Promise<string> {
  const rows = await as<{ id: string }>(alice, "select public.add_session($1, $2, null) as id", [
    workshop,
    soon(hours),
  ]);
  return rows[0].id;
}

type Line = { id: string; session: string; qty: number };

/**
 * What the shop sync does with an order: store it (each line keeps the date
 * its cart carried), then book each date it names, its lines added together.
 */
async function sync(order: string, lines: Line[], cancelled = false): Promise<Outcome[]> {
  await service(
    "select public.upsert_commerce_batch($1, 'shopify', '[]'::jsonb, '[]'::jsonb, $2::jsonb)",
    [
      tenant,
      JSON.stringify([
        {
          external_id: order,
          name: `#${order}`,
          email: "sam@example.com",
          processed_at: new Date().toISOString(),
          currency: "USD",
          cancelled_at: cancelled ? new Date().toISOString() : null,
          lines: lines.map((l) => ({
            external_id: l.id,
            product_external_id: PRODUCT,
            title: "Rug Tufting Workshop",
            quantity: l.qty,
            unit_price: 90,
            session_ref: l.session,
          })),
        },
      ]),
    ],
  );
  const byDate = new Map<string, number>();
  for (const l of lines) byDate.set(l.session, (byDate.get(l.session) ?? 0) + l.qty);
  const out: Outcome[] = [];
  for (const [session, seats] of byDate) {
    n += 1;
    const [{ r }] = await service<{ r: Outcome }>(
      "select public.book_from_shop($1, $2, $3, $4, 'Sam Shopper', 'sam@example.com', $5, 9000, $6) as r",
      [tenant, session, order, `#${order}`, seats, `token-${n}`],
    );
    out.push(r);
  }
  return out;
}

const bookingsOf = (order: string) =>
  service<BookingRow>(
    "select id, session_id, status::text as status, seats from public.bookings where tenant_id = $1 and shop_order_id = $2 order by created_at, id",
    [tenant, order],
  );

const move = (booking: string, to: string) =>
  as(alice, "select public.admin_move_booking($1, $2)", [booking, to]);

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@example.com"), email: "alice@example.com" };
  const [{ id }] = await as<{ id: string }>(
    alice,
    "select id from public.create_tenant('Moves studio', 'UTC', 'USD')",
  );
  tenant = id;
  const [{ id: svc }] = await as<{ id: string }>(
    alice,
    "select public.save_service($1, null, 'workshop', 'Rug tufting', '', 60, 9000, 8, true) as id",
    [tenant],
  );
  workshop = svc;
  await as(alice, "select public.set_service_shop_product($1, $2, null)", [workshop, PRODUCT]);
});

describe("a shop booking moved to another date", () => {
  it("is never booked again on the date the cart named", async () => {
    const a = await date(100);
    const c = await date(124);
    const [first] = await sync("7001", [{ id: "11", session: a, qty: 2 }]);
    expect(first.result).toBe("booked");
    await move(first.booking_id!, c);

    const again = await sync("7001", [{ id: "11", session: a, qty: 2 }]);
    expect(again.map((o) => o.result)).toEqual(["unchanged"]);
    expect(again[0].booking_id).toBe(first.booking_id);
    const rows = await bookingsOf("7001");
    expect(rows).toEqual([{ id: first.booking_id, session_id: c, status: "confirmed", seats: 2 }]);
  });

  it("also holds for a booking made before the shop's lines were kept", async () => {
    const a = await date(102);
    const c = await date(126);
    const [first] = await sync("7002", [{ id: "21", session: a, qty: 1 }]);
    // As a booking made by the earlier code looks: only the order and the date.
    await db.query(
      "update public.bookings set shop_line_ids = null, shop_cart_session_id = null where id = $1",
      [first.booking_id],
    );
    await move(first.booking_id!, c);
    const again = await sync("7002", [{ id: "21", session: a, qty: 1 }]);
    expect(again[0]).toMatchObject({ result: "unchanged", booking_id: first.booking_id });
    expect((await bookingsOf("7002")).map((b) => b.session_id)).toEqual([c]);
    // And from then on it is known by its line.
    const [{ lines, cart }] = await service<{ lines: string[]; cart: string }>(
      "select shop_line_ids as lines, shop_cart_session_id as cart from public.bookings where id = $1",
      [first.booking_id],
    );
    expect(lines).toEqual(["21"]);
    expect(cart).toBe(a);
  });

  it("follows a refund wherever it now sits", async () => {
    const a = await date(104);
    const c = await date(128);
    const [first] = await sync("7003", [{ id: "31", session: a, qty: 2 }]);
    await move(first.booking_id!, c);
    const refunded = await sync("7003", [{ id: "31", session: a, qty: 0 }]);
    expect(refunded[0]).toMatchObject({ result: "cancelled", booking_id: first.booking_id });
    const rows = await bookingsOf("7003");
    expect(rows).toEqual([{ id: first.booking_id, session_id: c, status: "cancelled", seats: 2 }]);
    // Told again later: still nothing new.
    expect((await sync("7003", [{ id: "31", session: a, qty: 0 }]))[0].result).toBe("unchanged");
    expect(await bookingsOf("7003")).toHaveLength(1);
  });

  it("follows fewer places wherever it now sits", async () => {
    const a = await date(106);
    const c = await date(130);
    const [first] = await sync("7004", [{ id: "41", session: a, qty: 3 }]);
    await move(first.booking_id!, c);
    const fewer = await sync("7004", [{ id: "41", session: a, qty: 1 }]);
    expect(fewer[0]).toMatchObject({ result: "resized", booking_id: first.booking_id });
    expect(await bookingsOf("7004")).toEqual([
      { id: first.booking_id, session_id: c, status: "confirmed", seats: 1 },
    ]);
  });

  it("isn't booked again after a manager cancelled it by hand", async () => {
    const a = await date(108);
    const c = await date(132);
    const [first] = await sync("7005", [{ id: "51", session: a, qty: 1 }]);
    await move(first.booking_id!, c);
    await as(alice, "select public.admin_cancel_booking($1)", [first.booking_id]);
    const again = await sync("7005", [{ id: "51", session: a, qty: 1 }]);
    expect(again[0]).toMatchObject({ result: "unchanged", booking_id: first.booking_id });
    expect(await bookingsOf("7005")).toHaveLength(1);
  });

  it("still books a genuinely new line on the same order for another date", async () => {
    const a = await date(110);
    const b = await date(112);
    const c = await date(134);
    const [first] = await sync("7006", [{ id: "61", session: a, qty: 1 }]);
    await move(first.booking_id!, c);
    // The order is edited in the shop: a second line, for another date.
    const edited = await sync("7006", [
      { id: "61", session: a, qty: 1 },
      { id: "62", session: b, qty: 2 },
    ]);
    expect(edited.map((o) => o.result)).toEqual(["unchanged", "booked"]);
    const rows = await bookingsOf("7006");
    expect(rows.map((r) => [r.session_id, r.seats])).toEqual([
      [c, 1],
      [b, 2],
    ]);
  });

  it("gives a moved legacy booking to the older line when a new line names another date", async () => {
    const a = await date(114);
    const b = await date(116);
    const c = await date(136);
    const [first] = await sync("7007", [{ id: "71", session: a, qty: 1 }]);
    await db.query(
      "update public.bookings set shop_line_ids = null, shop_cart_session_id = null where id = $1",
      [first.booking_id],
    );
    await move(first.booking_id!, c);
    // The new line is told first; the moved booking still belongs to line 71.
    await service(
      "select public.upsert_commerce_batch($1, 'shopify', '[]'::jsonb, '[]'::jsonb, $2::jsonb)",
      [
        tenant,
        JSON.stringify([
          {
            external_id: "7007",
            name: "#7007",
            email: "sam@example.com",
            processed_at: new Date().toISOString(),
            currency: "USD",
            cancelled_at: null,
            lines: [
              {
                external_id: "71",
                product_external_id: PRODUCT,
                title: "Rug",
                quantity: 1,
                unit_price: 90,
                session_ref: a,
              },
              {
                external_id: "72",
                product_external_id: PRODUCT,
                title: "Rug",
                quantity: 1,
                unit_price: 90,
                session_ref: b,
              },
            ],
          },
        ]),
      ],
    );
    const [{ r: forB }] = await service<{ r: Outcome }>(
      "select public.book_from_shop($1, $2, '7007', '#7007', 'Sam', 'sam@example.com', 1, 9000, 'tok-7007-b') as r",
      [tenant, b],
    );
    expect(forB.result).toBe("booked");
    const [{ r: forA }] = await service<{ r: Outcome }>(
      "select public.book_from_shop($1, $2, '7007', '#7007', 'Sam', 'sam@example.com', 1, 9000, 'tok-7007-a') as r",
      [tenant, a],
    );
    expect(forA).toMatchObject({ result: "unchanged", booking_id: first.booking_id });
    expect((await bookingsOf("7007")).map((r) => r.session_id).sort()).toEqual([b, c].sort());
  });

  it("isn't booked again when the earlier app had already moved it before the import", async () => {
    const a = await date(118);
    const c = await date(138);
    // The earlier app booked order 7008 on date A, then moved it to C; the
    // bookings file says C and the order's number.
    const [{ r: imported }] = await as<{ r: { new: number } }>(
      alice,
      "select public.import_bookings($1, gen_random_uuid(), $2::jsonb, 'bookings.csv', true) as r",
      [
        tenant,
        JSON.stringify([
          {
            line: 2,
            ref: "earlier-7008",
            session_ref: c,
            name: "Sam Shopper",
            email: "sam@example.com",
            seats: 2,
            status: "confirmed",
            source: "online",
            shop_order_id: "7008",
            shop_order_name: "#7008",
          },
        ]),
      ],
    );
    expect(imported.new).toBe(1);
    const again = await sync("7008", [{ id: "81", session: a, qty: 2 }]);
    expect(again[0].result).toBe("unchanged");
    const rows = await bookingsOf("7008");
    expect(rows.map((r) => [r.session_id, r.seats])).toEqual([[c, 2]]);
    // A refund of it is still followed.
    expect((await sync("7008", [{ id: "81", session: a, qty: 0 }]))[0].result).toBe("cancelled");
  });

  it("asks a person when a new line names the date a moved booking already sits on", async () => {
    const a = await date(140);
    const c = await date(142);
    const [first] = await sync("7009", [{ id: "91", session: a, qty: 1 }]);
    await move(first.booking_id!, c);
    const edited = await sync("7009", [
      { id: "91", session: a, qty: 1 },
      { id: "92", session: c, qty: 1 },
    ]);
    expect(edited.map((o) => o.result)).toEqual(["unchanged", "clash"]);
    expect(await bookingsOf("7009")).toHaveLength(1);
  });
});
