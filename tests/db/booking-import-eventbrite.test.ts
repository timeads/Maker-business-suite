import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Eventbrite bookings brought across keep their Eventbrite order number, so
 * bringing the bookings file in again never doubles one, whether it came in
 * with the file or the suite booked it itself after the switch, and a later
 * Eventbrite change finds the imported booking instead of booking again.
 * And a shop order the sync already booked on the date its cart named is
 * never added a second time from the file on the date the earlier app had
 * moved it to.
 */

type User = { id: string; email: string };
type Counts = {
  new: number;
  changed: number;
  same: number;
  refused: { line: number; reason: string }[];
};

let db: PGlite;
let alice: User;
let tenant: string;
let workshop: string;
let saturday: string;
let sunday: string;

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

const fromEventbrite = (line: number, ref: string | null, order: string, session: string) => ({
  line,
  ref,
  session_ref: session,
  name: `Person ${order}`,
  email: `p${order}@example.com`,
  seats: 2,
  status: "confirmed",
  source: "manual",
  tags: ["eventbrite"],
  eventbrite_order_id: order,
});

const bookingsOfOrder = (order: string) =>
  db.query<{ id: string; session_id: string; source: string; import_ref: string | null }>(
    "select id, session_id, source, import_ref from public.bookings where tenant_id = $1 and eventbrite_order_id = $2",
    [tenant, order],
  );

const eventbriteOrder = async (order: string, seats: number) =>
  (
    await service<{ r: { result: string; booking_id?: string } }>(
      "select public.book_from_eventbrite($1, '555', $2, 'Pat', 'pat@example.com', '', $3, $4) as r",
      [tenant, order, seats, `eb-token-${order}-${seats}`],
    )
  )[0].r;

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@example.com"), email: "alice@example.com" };
  [{ id: tenant }] = await as<{ id: string }>(
    alice,
    "select id from public.create_tenant('Eventbrite studio', 'UTC', 'USD')",
  );
  [{ id: workshop }] = await as<{ id: string }>(
    alice,
    "select public.save_service($1, null, 'workshop', 'Rug tufting', '', 60, 9000, 8, true) as id",
    [tenant],
  );
  await as(alice, "select public.set_service_shop_product($1, '9300', null)", [workshop]);
  [{ id: saturday }] = await as<{ id: string }>(
    alice,
    "select public.add_session($1, $2, null) as id",
    [workshop, hoursFromNow(72)],
  );
  [{ id: sunday }] = await as<{ id: string }>(
    alice,
    "select public.add_session($1, $2, null) as id",
    [workshop, hoursFromNow(96)],
  );
  // Saturday is linked to its Eventbrite event.
  await db.query(
    "insert into public.eventbrite_listings (tenant_id, session_id, event_id) values ($1, $2, '555')",
    [tenant, saturday],
  );
});

describe("Eventbrite bookings in the bookings file", () => {
  it("keep their order number, so Eventbrite later finds them instead of booking again", async () => {
    const first = await importBookings([fromEventbrite(2, "e-1", "1001", saturday)]);
    expect(first.new).toBe(1);
    const { rows } = await bookingsOfOrder("1001");
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("eventbrite");
    // Eventbrite tells us the order again (a ticket refunded).
    const r = await eventbriteOrder("1001", 1);
    expect(r).toMatchObject({ result: "resized", booking_id: rows[0].id });
    expect((await bookingsOfOrder("1001")).rows).toHaveLength(1);
  });

  it("aren't doubled when the suite already booked the same Eventbrite order itself", async () => {
    const own = await eventbriteOrder("1002", 2);
    expect(own.result).toBe("booked");
    // The next morning's file has it too, from the earlier app.
    const again = await importBookings([fromEventbrite(2, "e-2", "1002", saturday)]);
    expect(again).toMatchObject({ new: 0, refused: [] });
    const { rows } = await bookingsOfOrder("1002");
    expect(rows).toHaveLength(1);
    expect(rows[0].import_ref).toBe("e-2");
  });

  it("the same file again changes nothing, even without the earlier app's ids", async () => {
    const file = [
      fromEventbrite(2, null, "1003", saturday),
      fromEventbrite(3, "e-4", "1004", sunday),
    ];
    expect((await importBookings(file)).new).toBe(2);
    const again = await importBookings(file);
    expect(again).toMatchObject({ new: 0, changed: 0, same: 2, refused: [] });
    expect((await bookingsOfOrder("1003")).rows).toHaveLength(1);
    expect((await bookingsOfOrder("1004")).rows).toHaveLength(1);
  });

  it("an earlier import without the number picks it up when the file has it", async () => {
    const plain = { ...fromEventbrite(2, "e-5", "1005", sunday), eventbrite_order_id: null };
    expect((await importBookings([plain])).new).toBe(1);
    const withNumber = await importBookings([fromEventbrite(2, "e-5", "1005", sunday)]);
    expect(withNumber).toMatchObject({ new: 0, changed: 1 });
    expect((await bookingsOfOrder("1005")).rows).toHaveLength(1);
  });
});

describe("a shop order the earlier app had moved", () => {
  it("isn't added again from the file when the shop sync already booked it on its cart's date", async () => {
    // The sync heard of order 7100 before the bookings file: booked on
    // Saturday, the date its cart named.
    await service(
      "select public.upsert_commerce_batch($1, 'shopify', '[]'::jsonb, '[]'::jsonb, $2::jsonb)",
      [
        tenant,
        JSON.stringify([
          {
            external_id: "7100",
            name: "#7100",
            email: "sam@example.com",
            processed_at: new Date().toISOString(),
            currency: "USD",
            cancelled_at: null,
            lines: [
              {
                external_id: "1",
                product_external_id: "9300",
                title: "Rug",
                quantity: 1,
                unit_price: 90,
                session_ref: saturday,
              },
            ],
          },
        ]),
      ],
    );
    await service(
      "select public.book_from_shop($1, $2, '7100', '#7100', 'Sam', 'sam@example.com', 1, 9000, 'sync-7100')",
      [tenant, saturday],
    );
    // The earlier app had moved it to Sunday.
    const r = await importBookings([
      {
        line: 2,
        ref: "s-7100",
        session_ref: sunday,
        name: "Sam",
        email: "sam@example.com",
        seats: 1,
        status: "confirmed",
        source: "online",
        shop_order_id: "7100",
        shop_order_name: "#7100",
      },
    ]);
    expect(r.new).toBe(0);
    expect(r.refused).toHaveLength(1);
    expect(r.refused[0].reason).toMatch(/another date/);
    const { rows } = await db.query(
      "select id from public.bookings where tenant_id = $1 and shop_order_id = '7100'",
      [tenant],
    );
    expect(rows).toHaveLength(1);
  });
});
