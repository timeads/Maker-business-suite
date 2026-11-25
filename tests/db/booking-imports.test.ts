import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };
type Counts = {
  new: number;
  changed: number;
  same: number;
  refused: { line: number; reason: string }[];
  repeated: boolean;
  ids_not_kept?: number;
  shared_rooms?: number;
  oversold?: number;
  emails_marked?: number;
};

let db: PGlite;
let alice: User;
let member: User;
let bob: User;
let tenantA: string;
let tenantB: string;

const at = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();
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

type Kind = "import_booking_workshops" | "import_booking_dates" | "import_bookings";
async function run(
  who: User,
  tenant: string,
  fn: Kind,
  rows: Record<string, unknown>[],
  key: string | null = null,
): Promise<Counts> {
  const [{ r }] = await as<{ r: Counts }>(
    who,
    `select public.${fn}($1, $2, $3::jsonb, 'file.csv', $4) as r`,
    [tenant, key, JSON.stringify(rows), key !== null],
  );
  return r;
}
let keys = 0;
const key = () => `00000000-0000-4000-8000-${String(++keys).padStart(12, "0")}`;

// The ids the earlier app gave its dates: they sit in carts and on orders.
const DATE_1 = "11111111-1111-4111-8111-111111111111";
const DATE_2 = "22222222-2222-4222-8222-222222222222";
const DATE_PAST = "33333333-3333-4333-8333-333333333333";
const DATE_OTHER = "44444444-4444-4444-8444-444444444444";

const workshops = [
  {
    line: 2,
    ref: "w-mini",
    name: "Mini tufting",
    duration_minutes: 180,
    capacity: 8,
    location: "Studio 2",
    shop_product_id: "9001",
    shop_variant_id: "9101",
    active: true,
  },
  { line: 3, ref: "w-day", name: "One-day rug", duration_minutes: 360, capacity: 6 },
];
const SATURDAY = at(48);
const BEFORE = at(-72);
const dates = () => [
  {
    line: 2,
    ref: DATE_1,
    keep_id: DATE_1,
    workshop_ref: "w-mini",
    starts_at: SATURDAY,
    capacity: 8,
    shared_group: "sat",
    shared_capacity: 12,
  },
  {
    line: 3,
    ref: DATE_2,
    keep_id: DATE_2,
    workshop_ref: "w-day",
    starts_at: SATURDAY,
    capacity: 6,
    shared_group: "sat",
    shared_capacity: 12,
  },
  { line: 4, ref: DATE_PAST, keep_id: DATE_PAST, workshop_ref: "w-mini", starts_at: BEFORE },
];
const bookings = (): Record<string, unknown>[] => [
  {
    line: 2,
    ref: "b-1",
    session_ref: DATE_1,
    name: "Pat Example",
    email: "pat@example.com",
    phone: "+1 555 0100",
    text_opt_in: true,
    seats: 2,
    status: "confirmed",
    source: "online",
    shop_order_id: "5001",
    shop_order_name: "#1001",
    tags: ["gift"],
    reminder_sent_at: at(-1),
  },
  {
    line: 3,
    ref: "b-2",
    session_ref: DATE_PAST,
    name: "Sam Example",
    email: "sam@example.com",
    seats: 1,
    status: "confirmed",
    attendance: "attended",
    source: "manual",
  },
  {
    line: 4,
    ref: "b-3",
    session_ref: DATE_2,
    name: "Kim Example",
    email: "kim@example.com",
    seats: 1,
    status: "cancelled",
    source: "manual",
  },
];

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

describe("who can bring bookings in", () => {
  it("only owners and admins of the workspace", async () => {
    await expect(run(member, tenantA, "import_booking_workshops", workshops)).rejects.toThrow(
      /owners and admins/i,
    );
    await expect(run(bob, tenantA, "import_booking_workshops", workshops)).rejects.toThrow(
      /owners and admins/i,
    );
    await expect(
      asAnon(db, (tx) =>
        tx.query("select public.import_bookings($1, null, '[]'::jsonb, '', false)", [tenantA]),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("keeps its record of imports to the workspace's managers", async () => {
    await run(bob, tenantB, "import_booking_workshops", [{ line: 2, name: "Bob's class" }], key());
    expect(await as(bob, "select id from public.booking_imports")).toHaveLength(1);
    expect(
      await as(alice, "select id from public.booking_imports where tenant_id = $1", [tenantB]),
    ).toHaveLength(0);
    expect(await as(member, "select id from public.booking_imports")).toHaveLength(0);
    await expect(
      as(
        alice,
        `insert into public.booking_imports (tenant_id, kind, request_key, counts) values ('${tenantA}', 'dates', gen_random_uuid(), '{}')`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("workshops", () => {
  it("a look changes nothing and says what would happen", async () => {
    const look = await run(alice, tenantA, "import_booking_workshops", workshops);
    expect(look).toMatchObject({ new: 2, changed: 0, same: 0, refused: [], repeated: false });
    expect(
      await as(alice, "select id from public.services where tenant_id = $1", [tenantA]),
    ).toHaveLength(0);
  });

  it("brings them in once; a second press and the same file again change nothing", async () => {
    const k = key();
    expect(await run(alice, tenantA, "import_booking_workshops", workshops, k)).toMatchObject({
      new: 2,
      repeated: false,
    });
    expect(await run(alice, tenantA, "import_booking_workshops", workshops, k)).toMatchObject({
      new: 2,
      repeated: true,
    });
    expect(await run(alice, tenantA, "import_booking_workshops", workshops, key())).toMatchObject({
      new: 0,
      changed: 0,
      same: 2,
    });
    const [mini] = await as<{
      location: string;
      shop_product_id: string;
      price_cents: number;
      capacity: number;
    }>(
      alice,
      "select location, shop_product_id, price_cents, capacity from public.services where import_ref = 'w-mini'",
    );
    expect(mini).toEqual({
      location: "Studio 2",
      shop_product_id: "9001",
      price_cents: 0,
      capacity: 8,
    });
  });
});

describe("dates", () => {
  it("keep the earlier app's ids, and share a room as the file says", async () => {
    const look = await run(alice, tenantA, "import_booking_dates", dates());
    expect(look).toMatchObject({ new: 3, refused: [], shared_rooms: 1 });
    const done = await run(alice, tenantA, "import_booking_dates", dates(), key());
    expect(done).toMatchObject({ new: 3, refused: [], shared_rooms: 1 });
    const rows = await as<{
      id: string;
      seat_group_id: string | null;
      ends_at: Date;
      starts_at: Date;
    }>(
      alice,
      "select id, seat_group_id, starts_at, ends_at from public.sessions where id = any($1) order by id",
      [[DATE_1, DATE_2, DATE_PAST]],
    );
    expect(rows.map((r) => r.id)).toEqual([DATE_1, DATE_2, DATE_PAST]);
    expect(rows[0].seat_group_id).toBeTruthy();
    expect(rows[0].seat_group_id).toBe(rows[1].seat_group_id);
    // No end given: the workshop's length.
    expect(rows[0].ends_at.getTime() - rows[0].starts_at.getTime()).toBe(180 * 60_000);
  });

  it("the same file again changes nothing", async () => {
    expect(await run(alice, tenantA, "import_booking_dates", dates(), key())).toMatchObject({
      new: 0,
      changed: 0,
      same: 3,
      shared_rooms: 0,
      refused: [],
    });
  });

  it("an id in use by another workspace is refused, in words that give nothing away", async () => {
    await run(
      bob,
      tenantB,
      "import_booking_workshops",
      [{ line: 2, ref: "w-b", name: "Throwing" }],
      key(),
    );
    await run(
      bob,
      tenantB,
      "import_booking_dates",
      [{ line: 2, ref: DATE_OTHER, keep_id: DATE_OTHER, workshop_ref: "w-b", starts_at: at(100) }],
      key(),
    );
    // Alice's file names Bob's date id.
    const r = await run(alice, tenantA, "import_booking_dates", [
      { line: 7, ref: DATE_OTHER, keep_id: DATE_OTHER, workshop_ref: "w-mini", starts_at: at(200) },
    ]);
    expect(r.new).toBe(0);
    expect(r.refused).toEqual([
      { line: 7, reason: "This date's id can't be used here, so the date was left out." },
    ]);
    expect(r.refused[0].reason).not.toMatch(/workspace|another|exists|taken/i);
    // And bookings for it from Alice's file find no date, with the usual words.
    const b = await run(alice, tenantA, "import_bookings", [
      {
        line: 9,
        session_ref: DATE_OTHER,
        name: "X",
        email: "x@example.com",
        seats: 1,
        status: "confirmed",
        source: "manual",
      },
    ]);
    expect(b.refused).toEqual([
      { line: 9, reason: "No date here has this id. Bring the dates file in first." },
    ]);
    const unknown = await run(alice, tenantA, "import_bookings", [
      {
        line: 9,
        session_ref: "55555555-5555-4555-8555-555555555555",
        name: "X",
        email: "x@example.com",
        seats: 1,
        status: "confirmed",
        source: "manual",
      },
    ]);
    expect(unknown.refused).toEqual(b.refused);
  });

  it("refuses a date for a workshop that isn't here", async () => {
    const r = await run(alice, tenantA, "import_booking_dates", [
      { line: 5, workshop_ref: "nope", starts_at: at(300) },
    ]);
    expect(r.refused[0]).toMatchObject({ line: 5 });
  });
});

describe("bookings", () => {
  it("are brought in without sending anything, carrying what was already sent", async () => {
    const look = await run(alice, tenantA, "import_bookings", bookings());
    expect(look).toMatchObject({ new: 3, refused: [] });
    expect(
      await db
        .query("select 1 from public.bookings where import_ref like 'b-%'")
        .then((r) => r.rows),
    ).toHaveLength(0);

    const done = await run(alice, tenantA, "import_bookings", bookings(), key());
    expect(done).toMatchObject({ new: 3, refused: [], repeated: false });

    const rows = (
      await db.query<{
        import_ref: string;
        status: string;
        attendance: string | null;
        customer_phone: string;
        text_opt_in: boolean;
        source: string;
        shop_order_id: string | null;
        reminder_sent_at: Date | null;
        tags: string[];
      }>(
        "select import_ref, status, attendance, customer_phone, text_opt_in, source, shop_order_id, reminder_sent_at, tags from public.bookings where tenant_id = $1 order by import_ref",
        [tenantA],
      )
    ).rows;
    expect(rows[0]).toMatchObject({
      import_ref: "b-1",
      status: "confirmed",
      customer_phone: "+1 555 0100",
      text_opt_in: true,
      source: "online",
      shop_order_id: "5001",
      tags: ["gift"],
    });
    expect(rows[0].reminder_sent_at).not.toBeNull();
    expect(rows[1]).toMatchObject({ import_ref: "b-2", attendance: "attended", source: "manual" });
    expect(rows[2]).toMatchObject({ import_ref: "b-3", status: "cancelled" });

    // Nothing is handed to the worker to send: the reminder already went, and
    // the class that already happened gets no thank-you, even with it switched on.
    await db.query(
      "insert into public.configs (tenant_id, module, key, body) values ($1, 'bookings', 'emails', $2::jsonb)",
      [tenantA, JSON.stringify({ version: 1, followup_on: true, reminder_hours: 72 })],
    );
    const claims = await service<{ booking_id: string; kind: string }>(
      "select booking_id, kind from public.claim_booking_email_sends(200)",
    );
    expect(claims).toHaveLength(0);
  });

  it("the same file again changes nothing", async () => {
    expect(await run(alice, tenantA, "import_bookings", bookings(), key())).toMatchObject({
      new: 0,
      changed: 0,
      same: 3,
      refused: [],
    });
  });

  it("a later change in the file is followed for bookings brought in", async () => {
    const changed = bookings();
    changed[0] = { ...changed[0], seats: 3, notes: "Bringing a friend" };
    expect(await run(alice, tenantA, "import_bookings", changed, key())).toMatchObject({
      new: 0,
      changed: 1,
      same: 2,
    });
  });

  it("the shop's order sync finds an imported booking instead of making a second", async () => {
    const [{ r }] = await service<{ r: { result: string; booking_id: string } }>(
      "select public.book_from_shop($1, $2, '5001', '#1001', 'Pat Example', 'pat@example.com', 3, 9000, 'sync-token') as r",
      [tenantA, DATE_1],
    );
    expect(r.result).toBe("unchanged");
    const count = await db.query<{ n: number }>(
      "select count(*)::int as n from public.bookings where tenant_id = $1 and shop_order_id = '5001'",
      [tenantA],
    );
    expect(count.rows[0].n).toBe(1);
    // A refund in the shop still follows it.
    const [{ r: refunded }] = await service<{ r: { result: string } }>(
      "select public.book_from_shop($1, $2, '5001', '#1001', 'Pat Example', 'pat@example.com', 0, 0, 'sync-token') as r",
      [tenantA, DATE_1],
    );
    expect(refunded.result).toBe("cancelled");
  });

  it("an order the sync booked first is matched, not doubled, and gains only what the sync can't know", async () => {
    await service(
      "select public.book_from_shop($1, $2, '5002', '#1002', 'Lee Example', 'lee@example.com', 1, 9000, 'sync-token-2')",
      [tenantA, DATE_2],
    );
    const r = await run(
      alice,
      tenantA,
      "import_bookings",
      [
        {
          line: 2,
          ref: "b-9",
          session_ref: DATE_2,
          name: "Lee Example",
          email: "lee@example.com",
          phone: "555 0199",
          seats: 4,
          status: "confirmed",
          source: "online",
          shop_order_id: "5002",
          shop_order_name: "#1002",
        },
      ],
      key(),
    );
    expect(r).toMatchObject({ new: 0, changed: 1 });
    const [b] = (
      await db.query<{ seats: number; customer_phone: string; import_ref: string }>(
        "select seats, customer_phone, import_ref from public.bookings where tenant_id = $1 and shop_order_id = '5002'",
        [tenantA],
      )
    ).rows;
    expect(b).toEqual({ seats: 1, customer_phone: "555 0199", import_ref: "b-9" });
  });

  it("a paid booking over the shared room's limit is kept and flagged", async () => {
    const r = await run(
      alice,
      tenantA,
      "import_bookings",
      [
        {
          line: 2,
          ref: "b-big",
          session_ref: DATE_2,
          name: "Group",
          email: "group@example.com",
          seats: 5,
          status: "confirmed",
          source: "online",
          shop_order_id: "5003",
        },
        {
          line: 3,
          ref: "b-big-2",
          session_ref: DATE_1,
          name: "Group two",
          email: "group2@example.com",
          // Room under this date's own 8, but not under the shared 12.
          seats: 7,
          status: "confirmed",
          source: "online",
          shop_order_id: "5004",
        },
      ],
      key(),
    );
    expect(r).toMatchObject({ new: 2, oversold: 1, refused: [] });
  });
});
