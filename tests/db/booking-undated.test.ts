import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };
type Noted = {
  new: { id: string; order_id: string; order_name: string; service_name: string; seats: number }[];
  cancelled: string[];
  known: number;
};
type Marker = {
  id: string;
  shop_order_id: string;
  line_id: string;
  seats: number;
  order_cancelled: boolean;
  booking_id: string | null;
  dismissed_at: string | null;
  service_id: string | null;
};
type BookingRow = {
  id: string;
  session_id: string;
  status: string;
  seats: number;
  oversold: boolean;
  amount_cents: number;
  customer_name: string;
  customer_email: string;
  shop_order_id: string;
  shop_order_name: string;
  source: string;
};

let db: PGlite;
let alice: User;
let member: User;
let bob: User;
let tenantA: string;
let tenantB: string;
let workshopA: string;
let n = 0;

const PRODUCT = "9001";
const soon = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();

function service<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
}
const as = <T>(user: User, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);

async function tenantFor(owner: User, name: string): Promise<string> {
  const rows = await as<{ id: string }>(
    owner,
    "select id from public.create_tenant($1, 'UTC', 'USD')",
    [name],
  );
  return rows[0].id;
}

async function workshop(owner: User, tenant: string, product: string | null, capacity = 4) {
  n += 1;
  const rows = await as<{ id: string }>(
    owner,
    "select public.save_service($1, null, 'workshop', $2, '', 60, 9000, $3, true) as id",
    [tenant, `Workshop ${n}`, capacity],
  );
  if (product) {
    await as(owner, "select public.set_service_shop_product($1, $2, null)", [rows[0].id, product]);
  }
  return rows[0].id;
}

async function date(owner: User, serviceId: string, hours: number): Promise<string> {
  const rows = await as<{ id: string }>(owner, "select public.add_session($1, $2, null) as id", [
    serviceId,
    soon(hours),
  ]);
  return rows[0].id;
}

type Line = {
  id: string;
  product?: string | null;
  qty: number;
  price?: number;
  title?: string;
  /** The date the cart line carried, if any. */
  session?: string;
};
/** Stores an order the way the shop sync does, then tells Bookings about its undated lines. */
async function shopOrder(
  tenant: string,
  id: string,
  name: string,
  lines: Line[],
  opts: { cancelled?: boolean; email?: string | null; note?: boolean; customer?: boolean } = {},
): Promise<Noted> {
  const email = opts.email === undefined ? "sam@example.com" : opts.email;
  await service(
    "select public.upsert_commerce_batch($1, 'shopify', $2::jsonb, '[]'::jsonb, $3::jsonb)",
    [
      tenant,
      JSON.stringify(
        opts.customer === false
          ? []
          : [{ external_id: `c-${id}`, email, first_name: "Sam", last_name: "Shopper" }],
      ),
      JSON.stringify([
        {
          external_id: id,
          name,
          customer_external_id: opts.customer === false ? null : `c-${id}`,
          email,
          processed_at: new Date().toISOString(),
          currency: "USD",
          cancelled_at: opts.cancelled ? new Date().toISOString() : null,
          lines: lines.map((l) => ({
            external_id: l.id,
            product_external_id: l.product === undefined ? PRODUCT : l.product,
            title: l.title ?? "Rug Tufting Workshop",
            quantity: l.qty,
            unit_price: l.price ?? 90,
          })),
        },
      ]),
    ],
  );
  if (opts.note === false) return { new: [], cancelled: [], known: 0 };
  return note(tenant, id, name, lines, opts.cancelled ?? false);
}

async function note(tenant: string, id: string, name: string, lines: Line[], cancelled = false) {
  const rows = await service<{ r: Noted }>(
    "select public.note_shop_undated_lines($1, 'shopify', $2::jsonb) as r",
    [
      tenant,
      JSON.stringify([
        {
          order_id: id,
          name,
          cancelled,
          lines: lines.map((l) => ({
            line_id: l.id,
            product_id: l.product === undefined ? PRODUCT : l.product,
            seats: l.qty,
            session_id: l.session ?? null,
          })),
        },
      ]),
    ],
  );
  return rows[0].r;
}

const markers = async (tenant: string, order: string) =>
  (
    await db.query<Marker>(
      "select id, shop_order_id, line_id, seats, order_cancelled, booking_id, dismissed_at, service_id from public.shop_undated_lines where tenant_id = $1 and shop_order_id = $2 order by line_id",
      [tenant, order],
    )
  ).rows;
const booking = async (id: string) =>
  (await db.query<BookingRow>("select * from public.bookings where id = $1", [id])).rows[0];

type Placed = {
  result: string;
  booking_id: string;
  session_id: string;
  oversold?: boolean;
  has_email?: boolean;
};
const place = async (who: User, session: string, order: string, line: string) => {
  n += 1;
  const rows = await as<{ r: Placed }>(
    who,
    "select public.place_shop_order_line($1, 'shopify', $2, $3, $4) as r",
    [session, order, line, `placed-token-${n}-long-enough-to-pass`],
  );
  return rows[0].r;
};

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
  workshopA = await workshop(alice, tenantA, PRODUCT);
});

describe("workspace isolation", () => {
  it("the list is read by its own workspace only and written by nobody directly", async () => {
    await shopOrder(tenantA, "100", "#100", [{ id: "1", qty: 1 }]);
    expect((await as(alice, "select id from public.shop_undated_lines")).length).toBe(1);
    expect((await as(member, "select id from public.shop_undated_lines")).length).toBe(1);
    expect((await as(bob, "select id from public.shop_undated_lines")).length).toBe(0);
    await expect(
      asAnon(db, (tx) => tx.query("select id from public.shop_undated_lines")),
    ).rejects.toThrow(/permission denied/);
    for (const sql of [
      "update public.shop_undated_lines set seats = 9",
      "delete from public.shop_undated_lines",
      `insert into public.shop_undated_lines (tenant_id, provider, shop_order_id, line_id) values ('${tenantA}', 'shopify', 'x', 'y')`,
    ]) {
      await expect(as(alice, sql)).rejects.toThrow(/permission denied/);
    }
    await expect(
      as(alice, `select public.note_shop_undated_lines('${tenantA}', 'shopify', '[]'::jsonb)`),
    ).rejects.toThrow(/permission denied/);
  });

  it("another workspace's manager can't place, find or set aside", async () => {
    const session = await date(alice, workshopA, 48);
    const [marker] = await markers(tenantA, "100");
    await expect(place(bob, session, "100", "1")).rejects.toThrow(/not found/i);
    await expect(
      as(bob, "select public.find_shop_order_for_session($1, '#100')", [session]),
    ).rejects.toThrow(/not found/i);
    await expect(
      as(bob, "select public.set_shop_undated_line_aside($1, true)", [marker.id]),
    ).rejects.toThrow(/not found/i);
    // Nor can Bob put Alice's order onto one of his own dates.
    const bobs = await date(bob, await workshop(bob, tenantB, PRODUCT), 48);
    await expect(place(bob, bobs, "100", "1")).rejects.toThrow(/order_missing/);
    // A member of the right workspace can look, but only managers act.
    await expect(place(member, session, "100", "1")).rejects.toThrow(/owners and admins/i);
    await expect(
      as(member, "select public.set_shop_undated_line_aside($1, true)", [marker.id]),
    ).rejects.toThrow(/owners and admins/i);
    await expect(
      asAnon(db, (tx) =>
        tx.query("select public.place_shop_order_line($1, 'shopify', '100', '1', 'x')", [session]),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("spotting an order with no date", () => {
  it("writes down workshop lines once, and ignores everything else", async () => {
    const first = await shopOrder(tenantA, "200", "#200", [
      { id: "1", qty: 2 },
      { id: "2", qty: 1, product: "555", title: "Yarn" },
      { id: "3", qty: 0 },
    ]);
    expect(first.new).toHaveLength(1);
    expect(first.new[0]).toMatchObject({ order_id: "200", order_name: "#200", seats: 2 });
    expect(first.new[0].service_name).toMatch(/^Workshop/);
    expect(first.known).toBe(0);
    expect((await markers(tenantA, "200")).map((m) => [m.line_id, m.seats])).toEqual([["1", 2]]);

    // The shop tells us again: nothing new, so nobody is told twice.
    const again = await note(tenantA, "200", "#200", [{ id: "1", qty: 2 }]);
    expect(again.new).toEqual([]);
    expect(again.known).toBe(1);
    expect(await markers(tenantA, "200")).toHaveLength(1);
  });

  it("does nothing for a cancelled order, or a workspace that sells no workshop in its shop", async () => {
    expect(
      (await shopOrder(tenantA, "201", "#201", [{ id: "1", qty: 1 }], { cancelled: true })).new,
    ).toEqual([]);
    const carol = { id: await createUser(db, "carol@c.test"), email: "carol@c.test" };
    const tenantC = await tenantFor(carol, "Carol Candles");
    await workshop(carol, tenantC, null);
    expect((await shopOrder(tenantC, "300", "#300", [{ id: "1", qty: 1 }])).new).toEqual([]);
    expect(await markers(tenantC, "300")).toEqual([]);
  });

  it("a line with a date is left to the usual road, unless that date isn't one of ours", async () => {
    const real = await date(alice, workshopA, 40);
    const bobs = await date(bob, await workshop(bob, tenantB, null), 40);
    const nowhere = "99999999-9999-4999-8999-999999999999";
    const noted = await shopOrder(tenantA, "210", "#210", [
      { id: "1", qty: 1, session: real },
      { id: "2", qty: 1, session: nowhere },
      // Another product altogether, but it carried a date: someone meant to book.
      { id: "3", qty: 2, product: "555", session: bobs, title: "Gift class" },
      { id: "4", qty: 1, product: "555", session: "not-a-date", title: "Yarn" },
    ]);
    expect(noted.new.map((l) => [l.order_name, l.seats, l.service_name]).sort()).toEqual([
      ["#210", 1, expect.stringMatching(/^Workshop/)],
      ["#210", 2, null],
    ]);
    expect((await markers(tenantA, "210")).map((m) => m.line_id)).toEqual(["2", "3"]);
  });

  it("orders from before the workshop was sold through the shop here are left alone", async () => {
    // A product linked just now: the shop's history holds older orders for it.
    const late = await workshop(alice, tenantA, "9050");
    const old = async (id: string, lines: Line[]) => {
      await shopOrder(tenantA, id, `#${id}`, lines, { note: false });
      await db.query(
        "update public.orders set processed_at = now() - interval '40 days' where tenant_id = $1 and external_id = $2",
        [tenantA, id],
      );
      return note(tenantA, id, `#${id}`, lines);
    };
    expect((await old("220", [{ id: "1", qty: 1, product: "9050" }])).new).toEqual([]);
    // Nor an old order that carried a date we don't have.
    expect(
      (
        await old("221", [
          { id: "1", qty: 1, product: "555", session: "99999999-9999-4999-8999-999999999998" },
        ])
      ).new,
    ).toEqual([]);
    expect(await markers(tenantA, "220")).toEqual([]);
    // An order placed after the link is caught.
    expect(
      (await shopOrder(tenantA, "222", "#222", [{ id: "1", qty: 1, product: "9050" }])).new,
    ).toHaveLength(1);
    // Linking again starts the clock again; unlinking clears it.
    const stamp = async () =>
      (
        await db.query<{ at: string | null }>(
          "select shop_linked_at as at from public.services where id = $1",
          [late],
        )
      ).rows[0].at;
    expect(await stamp()).not.toBeNull();
    await as(alice, "select public.set_service_shop_product($1, null, null)", [late]);
    expect(await stamp()).toBeNull();
  });

  it("a refund before anyone placed it takes it off the waiting list", async () => {
    await shopOrder(tenantA, "202", "#202", [{ id: "1", qty: 2 }]);
    await shopOrder(tenantA, "202", "#202", [{ id: "1", qty: 0 }]);
    expect((await markers(tenantA, "202"))[0]).toMatchObject({ seats: 0, booking_id: null });
    await shopOrder(tenantA, "203", "#203", [{ id: "1", qty: 1 }]);
    await shopOrder(tenantA, "203", "#203", [{ id: "1", qty: 1 }], { cancelled: true });
    expect((await markers(tenantA, "203"))[0]).toMatchObject({ order_cancelled: true });
    const session = await date(alice, workshopA, 50);
    await expect(place(alice, session, "202", "1")).rejects.toThrow(/line_refunded/);
    await expect(place(alice, session, "203", "1")).rejects.toThrow(/order_cancelled/);
  });
});

describe("putting an order onto a date", () => {
  it("makes one booking from what the sync stored, once per order line", async () => {
    const session = await date(alice, workshopA, 60);
    await shopOrder(tenantA, "400", "#400", [{ id: "1", qty: 2, price: 85.5 }]);
    const placed = await place(alice, session, "400", "1");
    expect(placed).toMatchObject({ result: "booked", oversold: false, has_email: true });
    const made = await booking(placed.booking_id);
    expect(made).toMatchObject({
      session_id: session,
      status: "confirmed",
      seats: 2,
      amount_cents: 17100,
      customer_name: "Sam Shopper",
      customer_email: "sam@example.com",
      shop_order_id: "400",
      shop_order_name: "#400",
      source: "online",
    });
    const [marker] = await markers(tenantA, "400");
    expect(marker.booking_id).toBe(placed.booking_id);

    // A second press, even for another date, finds the first booking.
    const other = await date(alice, workshopA, 62);
    expect(await place(alice, other, "400", "1")).toMatchObject({
      result: "already",
      booking_id: placed.booking_id,
      session_id: session,
    });
    const count = await db.query<{ n: number }>(
      "select count(*)::int as n from public.bookings where shop_order_id = '400'",
    );
    expect(count.rows[0].n).toBe(1);
  });

  it("a paid place is never turned away: a full date is booked and flagged, a closed or private one too", async () => {
    const small = await workshop(alice, tenantA, "9002", 1);
    const full = await date(alice, small, 70);
    await shopOrder(tenantA, "410", "#410", [{ id: "1", qty: 1, product: "9002" }]);
    await shopOrder(tenantA, "411", "#411", [{ id: "1", qty: 3, product: "9002" }]);
    expect(await place(alice, full, "410", "1")).toMatchObject({
      result: "booked",
      oversold: false,
    });
    const over = await place(alice, full, "411", "1");
    expect(over).toMatchObject({ result: "booked", oversold: true });
    expect((await booking(over.booking_id)).oversold).toBe(true);

    const closed = await date(alice, small, 72);
    await as(alice, "select public.update_session($1, 1, true, true, '')", [closed]);
    await shopOrder(tenantA, "412", "#412", [{ id: "1", qty: 1, product: "9002" }]);
    expect((await place(alice, closed, "412", "1")).result).toBe("booked");

    const off = await date(alice, small, 74);
    await as(alice, "select * from public.cancel_session($1)", [off]);
    await shopOrder(tenantA, "413", "#413", [{ id: "1", qty: 1, product: "9002" }]);
    await expect(place(alice, off, "413", "1")).rejects.toThrow(/date_cancelled/);
    expect((await markers(tenantA, "413"))[0].booking_id).toBeNull();
  });

  it("an order with no customer or email still gets its place", async () => {
    const session = await date(alice, workshopA, 64);
    await shopOrder(tenantA, "420", "#420", [{ id: "1", qty: 1 }], {
      email: null,
      customer: false,
    });
    const placed = await place(alice, session, "420", "1");
    expect(placed).toMatchObject({ result: "booked", has_email: false });
    expect(await booking(placed.booking_id)).toMatchObject({
      customer_name: "Guest",
      customer_email: "",
    });
  });

  it("refunds follow a placed order: fewer places, then cancelled", async () => {
    const session = await date(alice, workshopA, 66);
    await shopOrder(tenantA, "430", "#430", [{ id: "1", qty: 3 }]);
    const placed = await place(alice, session, "430", "1");
    expect((await booking(placed.booking_id)).seats).toBe(3);

    const less = await shopOrder(tenantA, "430", "#430", [{ id: "1", qty: 1 }]);
    expect(less.cancelled).toEqual([]);
    expect(await booking(placed.booking_id)).toMatchObject({ seats: 1, status: "confirmed" });

    const none = await shopOrder(tenantA, "430", "#430", [{ id: "1", qty: 0 }]);
    expect(none.cancelled).toEqual([placed.booking_id]);
    expect((await booking(placed.booking_id)).status).toBe("cancelled");
    // Told once.
    expect((await note(tenantA, "430", "#430", [{ id: "1", qty: 0 }])).cancelled).toEqual([]);
  });

  it("a cancelled order cancels its placed booking, by either road", async () => {
    const session = await date(alice, workshopA, 68);
    await shopOrder(tenantA, "440", "#440", [{ id: "1", qty: 1 }]);
    const a = await place(alice, session, "440", "1");
    const gone = await shopOrder(tenantA, "440", "#440", [{ id: "1", qty: 1 }], {
      cancelled: true,
    });
    expect(gone.cancelled).toEqual([a.booking_id]);

    await shopOrder(tenantA, "441", "#441", [{ id: "1", qty: 1 }]);
    const b = await place(alice, session, "441", "1");
    const ids = await service<{ id: string }>(
      "select public.cancel_shop_order_bookings($1, '441') as id",
      [tenantA],
    );
    expect(ids.map((r) => r.id)).toEqual([b.booking_id]);
  });

  it("won't double up with the booking the shopper's own date made", async () => {
    const picked = await date(alice, workshopA, 80);
    const other = await date(alice, workshopA, 82);
    // Line 1 carried a date and was booked the usual way; line 2 had none.
    await service(
      "select public.book_from_shop($1, $2, '450', '#450', 'Sam Shopper', 'sam@example.com', 1, 9000, 'dated-token-450')",
      [tenantA, picked],
    );
    await shopOrder(
      tenantA,
      "450",
      "#450",
      [
        { id: "1", qty: 1 },
        { id: "2", qty: 1 },
      ],
      { note: false },
    );
    await note(tenantA, "450", "#450", [{ id: "2", qty: 1 }]);
    await expect(place(alice, picked, "450", "2")).rejects.toThrow(/already_on_date/);
    expect((await place(alice, other, "450", "2")).result).toBe("booked");
  });

  it("a placed booking cancelled by hand can be put back, on the same date or another", async () => {
    const session = await date(alice, workshopA, 84);
    const other = await date(alice, workshopA, 86);
    await shopOrder(tenantA, "460", "#460", [{ id: "1", qty: 1 }]);
    const first = await place(alice, session, "460", "1");
    await as(alice, "select * from public.admin_cancel_booking($1)", [first.booking_id]);
    const back = await place(alice, session, "460", "1");
    expect(back).toMatchObject({ result: "booked", booking_id: first.booking_id });
    expect((await booking(first.booking_id)).status).toBe("confirmed");

    await as(alice, "select * from public.admin_cancel_booking($1)", [first.booking_id]);
    const moved = await place(alice, other, "460", "1");
    expect(moved.result).toBe("booked");
    expect(moved.booking_id).not.toBe(first.booking_id);
    expect((await markers(tenantA, "460"))[0].booking_id).toBe(moved.booking_id);
  });

  it("a line can be set aside and brought back, but not once it's placed", async () => {
    await shopOrder(tenantA, "470", "#470", [{ id: "1", qty: 1 }]);
    const [marker] = await markers(tenantA, "470");
    await as(alice, "select public.set_shop_undated_line_aside($1, true)", [marker.id]);
    expect((await markers(tenantA, "470"))[0].dismissed_at).not.toBeNull();
    await as(alice, "select public.set_shop_undated_line_aside($1, false)", [marker.id]);
    expect((await markers(tenantA, "470"))[0].dismissed_at).toBeNull();
    await as(alice, "select public.set_shop_undated_line_aside($1, true)", [marker.id]);
    // Placing it brings it back from the side.
    const placed = await place(alice, await date(alice, workshopA, 88), "470", "1");
    expect((await markers(tenantA, "470"))[0]).toMatchObject({
      dismissed_at: null,
      booking_id: placed.booking_id,
    });
    await as(alice, "select public.set_shop_undated_line_aside($1, true)", [marker.id]);
    expect((await markers(tenantA, "470"))[0].dismissed_at).toBeNull();
  });
});

describe("adding a shop order to a roster by its number", () => {
  type Found = {
    order_id: string;
    provider: string;
    name: string;
    cancelled: boolean;
    customer_name: string;
    customer_email: string;
    lines: {
      line_id: string;
      title: string;
      seats: number;
      amount_cents: number;
      state: string;
      on_session: string | null;
    }[];
  } | null;
  const find = async (who: User, session: string, typed: string) =>
    (
      await as<{ r: Found }>(who, "select public.find_shop_order_for_session($1, $2) as r", [
        session,
        typed,
      ])
    )[0].r;

  it("finds a stored order however the number is typed, and nothing that isn't there", async () => {
    const session = await date(alice, workshopA, 90);
    await shopOrder(tenantA, "500", "#68740-TG", [{ id: "1", qty: 2, title: "Private class" }], {
      note: false,
    });
    for (const typed of ["#68740-TG", "68740-tg", "68740", "#68740", " 68740 "]) {
      const found = await find(alice, session, typed);
      expect(found, typed).toMatchObject({
        order_id: "500",
        provider: "shopify",
        name: "#68740-TG",
        customer_name: "Sam Shopper",
        customer_email: "sam@example.com",
        cancelled: false,
      });
    }
    expect(await find(alice, session, "99999")).toBeNull();
    expect(await find(alice, session, "")).toBeNull();
    // Another workspace's order with the same number is never found.
    await shopOrder(tenantB, "501", "#77777", [{ id: "1", qty: 1 }], { note: false });
    expect(await find(alice, session, "77777")).toBeNull();
    await expect(find(member, session, "68740")).rejects.toThrow(/owners and admins/i);
  });

  it("says what each line can do, and a line placed from here follows refunds too", async () => {
    const session = await date(alice, workshopA, 92);
    const picked = await date(alice, workshopA, 94);
    await service(
      "select public.book_from_shop($1, $2, '510', '#510', 'Sam Shopper', 'sam@example.com', 1, 9000, 'dated-token-510')",
      [tenantA, picked],
    );
    await shopOrder(
      tenantA,
      "510",
      "#510",
      [
        { id: "1", qty: 1 },
        { id: "2", qty: 2, product: "777", title: "Private class" },
        { id: "3", qty: 0, product: "777", title: "Refunded thing" },
      ],
      { note: false },
    );
    let found = await find(alice, session, "510");
    expect(found!.lines.map((l) => [l.line_id, l.state, l.seats])).toEqual([
      ["1", "booked", 1],
      ["2", "open", 2],
      ["3", "refunded", 0],
    ]);
    expect(found!.lines[0].on_session).toBe(picked);
    expect(found!.lines[1].amount_cents).toBe(18000);

    // No marker existed for line 2 (its product isn't a workshop); placing makes one.
    const placed = await place(alice, session, "510", "2");
    expect(placed.result).toBe("booked");
    expect((await markers(tenantA, "510")).map((m) => [m.line_id, m.service_id])).toEqual([
      ["2", null],
    ]);
    found = await find(alice, session, "510");
    expect(found!.lines[1]).toMatchObject({ state: "placed", on_session: session });

    // The next sync brings the refund, and the booking follows it.
    const after = await shopOrder(tenantA, "510", "#510", [{ id: "2", qty: 0, product: "777" }]);
    expect(after.cancelled).toEqual([placed.booking_id]);
    // The booking the shopper's own date made is untouched.
    const kept = await db.query<{ status: string }>(
      "select status from public.bookings where shop_order_id = '510' and session_id = $1",
      [picked],
    );
    expect(kept.rows[0].status).toBe("confirmed");
  });
});
