import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { orderRevenueCents, splitCents, type RevenueFigure } from "../../src/lib/dashboard/lines";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Revenue by business line: the database's twin of the revenue rule, the
 * sharing of an order among its items, class dates from Bookings, and the
 * order-totals versions of the sales queries. Everything runs as a member.
 */

type User = { id: string; email: string };

let db: PGlite;
let alice: User;
let bob: User;
let tenantA: string;
let tenantB: string;

async function tenantFor(owner: User, name: string): Promise<string> {
  return asUser(db, owner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select id from public.create_tenant($1, 'America/New_York', 'USD')",
      [name],
    );
    return rows[0].id;
  });
}

function load(tenantId: string, orders: unknown[], products: unknown[] = []) {
  return asService(db, (tx) =>
    tx.query(
      "select public.upsert_commerce_batch($1, 'shopify', '[]'::jsonb, $2::jsonb, $3::jsonb)",
      [tenantId, JSON.stringify(products), JSON.stringify(orders)],
    ),
  );
}

// The shop's own product ids are digits.
const RUG = "701";
const KIT = "702";
const CLASS = "703";

type Item = {
  external_id: string;
  product_external_id?: string | null;
  quantity: number;
  unit_price: number;
  session_ref?: string | null;
  class_date?: string | null;
};

type Fixture = {
  external_id: string;
  net_sales: number;
  total: number;
  financial_status: string;
  cancelled_at?: string;
  is_test?: boolean;
  lines: Item[];
};

const order = (
  id: string,
  processedAt: string,
  money: { net: number; total: number },
  items: Item[],
  extra: Record<string, unknown> = {},
) => ({
  external_id: id,
  name: `#${id}`,
  processed_at: processedAt,
  currency: "USD",
  net_sales: money.net,
  total: money.total,
  channel: "Online Store",
  financial_status: "PAID",
  tags: [] as string[],
  lines: items.map((item) => ({ title: "Item", session_ref: null, class_date: null, ...item })),
  ...extra,
});

type Group = {
  period: string;
  order_tags: string[] | null;
  product_external_id: string | null;
  product_tags: string[] | null;
  product_type: string | null;
  workshop: boolean;
  dated: boolean;
  revenue_cents: string;
  units: string;
};

function lineRevenue(
  user: User,
  tenant: string,
  from: string,
  to: string,
  options: { figure?: RevenueFigure; byClass?: boolean; datedOnly?: boolean } = {},
) {
  return asUser(db, user, async (tx) => {
    const { rows } = await tx.query<Group>(
      `select period::text, order_tags, product_external_id, product_tags, product_type, workshop,
              dated, revenue_cents::text, units::text
       from public.money_line_revenue($1, $2, $3, 'month', 'America/New_York', $4, $5, $6)`,
      [
        tenant,
        from,
        to,
        options.figure ?? "net_sales",
        options.byClass ?? false,
        options.datedOnly ?? false,
      ],
    );
    return rows;
  });
}

const cents = (rows: Group[]) => rows.reduce((sum, row) => sum + Number(row.revenue_cents), 0);
const units = (rows: Group[]) => rows.reduce((sum, row) => sum + Number(row.units), 0);
const forProduct = (rows: Group[], product: string | null) =>
  cents(rows.filter((row) => row.product_external_id === product));

// Local month starts in New York, as Money's ranges resolve them.
const OCT = "2026-10-01T04:00:00Z";
const NOV = "2026-11-01T04:00:00Z"; // the clocks go back later this very morning
const DEC = "2026-12-01T05:00:00Z";
const JAN = "2027-01-01T05:00:00Z";
const FEB = "2027-02-01T05:00:00Z";
const WIDE = ["2026-01-01T00:00:00Z", "2028-01-01T00:00:00Z"] as const;

const SESSION_DEC = "6f1c2b3a-1111-4222-8333-444455556666";
const SESSION_JAN = "7a2d3c4b-2222-4333-8444-555566667777";

const ORDERS = [
  order(
    "3001",
    "2026-11-10T15:00:00Z",
    { net: 300, total: 330 },
    [
      { external_id: "a", product_external_id: RUG, quantity: 1, unit_price: 200 },
      { external_id: "b", product_external_id: KIT, quantity: 1, unit_price: 100 },
    ],
    { tags: ["Custom rug"] },
  ),
  // A class on the date the product page put on the line: December.
  order("3002", "2026-11-03T15:00:00Z", { net: 90, total: 97.2 }, [
    {
      external_id: "a",
      product_external_id: CLASS,
      quantity: 2,
      unit_price: 45,
      session_ref: SESSION_DEC,
    },
  ]),
  // A class with no date on the line, booked from this order in Bookings: January.
  order("3003", "2026-10-20T15:00:00Z", { net: 45, total: 48.6 }, [
    { external_id: "a", product_external_id: CLASS, quantity: 1, unit_price: 45 },
  ]),
  // A date another booking app wrote on the line: the day the clocks go back.
  order("3004", "2026-10-15T15:00:00Z", { net: 60, total: 60 }, [
    { external_id: "a", quantity: 1, unit_price: 60, class_date: "2026-11-01" },
  ]),
  order(
    "3005",
    "2026-11-12T15:00:00Z",
    { net: 0, total: 50 },
    [{ external_id: "a", product_external_id: KIT, quantity: 0, unit_price: 50 }],
    { financial_status: "REFUNDED" },
  ),
  order(
    "3006",
    "2026-11-12T16:00:00Z",
    { net: 500, total: 540 },
    [{ external_id: "a", product_external_id: RUG, quantity: 2, unit_price: 250 }],
    { cancelled_at: "2026-11-12T17:00:00Z" },
  ),
  // No items at all.
  order("3007", "2026-11-14T15:00:00Z", { net: 10, total: 10.8 }, []),
  // Three items that split ten dollars three ways.
  order("3008", "2026-11-15T15:00:00Z", { net: 10, total: 10 }, [
    { external_id: "a", product_external_id: KIT, quantity: 1, unit_price: 1 },
    { external_id: "b", product_external_id: KIT, quantity: 1, unit_price: 1 },
    { external_id: "c", product_external_id: RUG, quantity: 1, unit_price: 1 },
  ]),
];

const expected = (figure: RevenueFigure) =>
  (ORDERS as Fixture[]).reduce(
    (sum, o) =>
      sum +
      orderRevenueCents(
        {
          net_sales: o.net_sales,
          total: o.total,
          cancelled: Boolean(o.cancelled_at),
          is_test: Boolean(o.is_test),
          financial_status: o.financial_status,
        },
        figure,
      ),
    0,
  );

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");

  const {
    rows: [service],
  } = await db.query<{ id: string }>(
    `insert into public.services (tenant_id, kind, name, slug, duration_minutes, capacity, shop_product_id)
     values ($1, 'workshop', 'Rug class', 'rug-class', 180, 10, $2) returning id`,
    [tenantA, CLASS],
  );
  for (const [id, starts] of [
    [SESSION_DEC, "2026-12-05T19:00:00Z"],
    [SESSION_JAN, "2027-01-10T19:00:00Z"],
  ]) {
    await db.query(
      `insert into public.sessions (id, tenant_id, service_id, starts_at, ends_at, capacity)
       values ($1, $2, $3, $4::timestamptz, $4::timestamptz + interval '3 hours', 10)`,
      [id, tenantA, service.id, starts],
    );
  }
  await load(tenantA, ORDERS, [
    { external_id: RUG, title: "Wool rug", product_type: "Rugs", tags: ["wool"] },
    { external_id: KIT, title: "Starter kit", product_type: "Kits", tags: [] },
    { external_id: CLASS, title: "Rug class", product_type: "Classes", tags: ["teaching"] },
  ]);
  await db.query(
    `insert into public.bookings (tenant_id, session_id, customer_name, customer_email, seats,
       status, currency, manage_token_hash, shop_order_id, shop_order_name)
     values ($1, $2, 'Sam', 'sam@example.com', 1, 'confirmed', 'USD', 'hash-3003', '3003', '#3003')`,
    [tenantA, SESSION_JAN],
  );
  await load(tenantB, [
    order(
      "9001",
      "2026-11-10T15:00:00Z",
      { net: 7000, total: 7500 },
      [{ external_id: "a", product_external_id: "999", quantity: 7, unit_price: 1000 }],
      { tags: ["b-only"] },
    ),
  ]);
});

describe("what an order counts as revenue, in the database", () => {
  it("matches the TypeScript rule case by case", async () => {
    const cases = [
      ["250.00", "275.10", false, false, "PAID"],
      ["250.00", "275.10", true, false, "PAID"],
      ["250.00", "275.10", false, true, "PAID"],
      ["0.00", "50.00", false, false, "REFUNDED"],
      ["40.00", "50.00", false, false, "voided"],
      ["137.55", "150.01", false, false, "PARTIALLY_REFUNDED"],
      ["-4.05", "-4.40", false, false, null],
    ] as const;
    for (const figure of ["net_sales", "order_totals"] as const) {
      for (const [net, total, cancelled, isTest, status] of cases) {
        const { rows } = await db.query<{ cents: string }>(
          "select private.money_order_cents($1, $2, $3, $4, $5, $6)::text as cents",
          [net, total, cancelled, isTest, status, figure],
        );
        expect(Number(rows[0].cents), `${figure} ${net}/${total}/${status}`).toBe(
          orderRevenueCents(
            { net_sales: net, total, cancelled, is_test: isTest, financial_status: status },
            figure,
          ),
        );
      }
    }
  });
});

describe("revenue for every set of facts a rule reads", () => {
  it("adds every order's revenue up to the cent, under either figure", async () => {
    for (const figure of ["net_sales", "order_totals"] as const) {
      const rows = await lineRevenue(alice, tenantA, WIDE[0], WIDE[1], { figure });
      expect(cents(rows), figure).toBe(expected(figure));
    }
  });

  it("shares an order among its items by what each sold for, as splitCents does", async () => {
    const nov = await lineRevenue(alice, tenantA, NOV, DEC, { figure: "order_totals" });
    const custom = nov.filter((row) => row.order_tags?.includes("Custom rug"));
    expect(forProduct(custom, RUG)).toBe(22000);
    expect(forProduct(custom, KIT)).toBe(11000);
    // Ten dollars over three one-dollar items: 334 / 333 / 333, the first item first.
    const [first, second, third] = splitCents(1000, [100, 100, 100]);
    const net = await lineRevenue(alice, tenantA, NOV, DEC);
    const plain = net.filter((row) => !row.order_tags?.length);
    expect(forProduct(plain, KIT)).toBe(first + second);
    expect(forProduct(plain, RUG)).toBe(third);
  });

  it("keeps an order with no items whole, on a row with no product", async () => {
    const rows = await lineRevenue(alice, tenantA, NOV, DEC);
    expect(forProduct(rows, null)).toBe(1000);
  });

  it("brings each product's tags and type, and marks the product a workshop sells through", async () => {
    const rows = await lineRevenue(alice, tenantA, WIDE[0], WIDE[1]);
    const classRow = rows.find((row) => row.product_external_id === CLASS);
    expect(classRow).toMatchObject({
      product_tags: ["teaching"],
      product_type: "Classes",
      workshop: true,
    });
    const rugRow = rows.find((row) => row.product_external_id === RUG);
    expect(rugRow).toMatchObject({ product_tags: ["wool"], product_type: "Rugs", workshop: false });
  });

  it("counts a sale when it was bought, unless asked to count classes when they run", async () => {
    const byPurchase = await lineRevenue(alice, tenantA, NOV, DEC);
    expect(forProduct(byPurchase, CLASS)).toBe(9000);

    const nov = await lineRevenue(alice, tenantA, NOV, DEC, { byClass: true });
    const dec = await lineRevenue(alice, tenantA, DEC, JAN, { byClass: true });
    const jan = await lineRevenue(alice, tenantA, JAN, FEB, { byClass: true });
    const oct = await lineRevenue(alice, tenantA, OCT, NOV, { byClass: true });
    // The date on the cart line: December.
    expect(forProduct(nov, CLASS)).toBe(0);
    expect(forProduct(dec, CLASS)).toBe(9000);
    // No date on the line, but Bookings booked it from this order: January.
    expect(forProduct(jan, CLASS)).toBe(4500);
    expect(forProduct(oct, CLASS)).toBe(0);
    // Another app's date of 1 November counts from midnight New York time,
    // which that morning is still daylight time: November, not October.
    expect(forProduct(nov, null)).toBe(6000 + 1000);
    expect(nov.every((row) => row.period === "2026-11-01")).toBe(true);
    expect(nov.find((row) => row.product_external_id === CLASS)).toBeUndefined();
    expect(nov.filter((row) => row.dated).length).toBe(1);
  });

  it("finds what's paid for classes still to come, with how many places", async () => {
    const today = "2026-12-01T05:00:00Z";
    const later = "2031-12-01T05:00:00Z";
    const rows = await lineRevenue(alice, tenantA, today, later, { datedOnly: true });
    expect(cents(rows)).toBe(9000 + 4500);
    expect(units(rows)).toBe(3);
    expect(rows.every((row) => row.dated)).toBe(true);
  });
});

describe("sales under the order-totals figure", () => {
  it("gives the same net sales as the earlier query, and order totals beside them", async () => {
    await asUser(db, alice, async (tx) => {
      const earlier = await tx.query<{ period: string; order_count: string; net_sales: string }>(
        `select period::text, order_count::text, net_sales::text
         from public.dashboard_sales_by_period($1, $2, $3, 'month', 'America/New_York')`,
        [tenantA, OCT, DEC],
      );
      const net = await tx.query<{ period: string; order_count: string; revenue: string }>(
        `select period::text, order_count::text, revenue::text
         from public.money_sales_by_period($1, $2, $3, 'month', 'America/New_York', 'net_sales')`,
        [tenantA, OCT, DEC],
      );
      expect(net.rows.map((r) => [r.period, r.order_count, Number(r.revenue)])).toEqual(
        earlier.rows.map((r) => [r.period, r.order_count, Number(r.net_sales)]),
      );
      const totals = await tx.query<{ period: string; order_count: string; revenue: string }>(
        `select period::text, order_count::text, revenue::text
         from public.money_sales_by_period($1, $2, $3, 'month', 'America/New_York', 'order_totals')`,
        [tenantA, NOV, DEC],
      );
      // 3001, 3002, 3007, 3008: the refunded 3005 and the cancelled 3006 don't count.
      expect(totals.rows).toEqual([{ period: "2026-11-01", order_count: "4", revenue: "448.00" }]);
      const channels = await tx.query<{ channel: string; order_count: string; revenue: string }>(
        `select channel, order_count::text, revenue::text
         from public.money_sales_by_channel($1, $2, $3, 'order_totals')`,
        [tenantA, NOV, DEC],
      );
      expect(channels.rows).toEqual([
        { channel: "Online Store", order_count: "4", revenue: "448.00" },
      ]);
    });
  });
});

describe("recent orders for the settings page", () => {
  it("gives one row per item, and one for an order with no items", async () => {
    const rows = await asUser(
      db,
      alice,
      async (tx) =>
        (
          await tx.query<{
            order_id: string;
            product_external_id: string | null;
            workshop: boolean;
          }>(
            "select order_id, product_external_id, workshop from public.money_recent_order_lines($1, $2)",
            [tenantA, NOV],
          )
        ).rows,
    );
    // 3001 (2 items), 3002 (1), 3005 (1), 3007 (none), 3008 (3); not the cancelled 3006.
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((r) => r.order_id)).size).toBe(5);
    expect(rows.filter((r) => r.product_external_id === null)).toHaveLength(1);
    expect(rows.filter((r) => r.workshop)).toHaveLength(1);
  });
});

describe("cross-tenant isolation for revenue by line", () => {
  it("asking for another workspace returns nothing", async () => {
    await asUser(db, alice, async (tx) => {
      for (const [sql, params] of [
        [
          "select * from public.money_line_revenue($1, $2, $3, 'month', 'UTC', 'net_sales', true, false)",
          [tenantB, ...WIDE],
        ],
        [
          "select * from public.money_sales_by_period($1, $2, $3, 'month', 'UTC', 'order_totals')",
          [tenantB, ...WIDE],
        ],
        [
          "select * from public.money_sales_by_channel($1, $2, $3, 'order_totals')",
          [tenantB, ...WIDE],
        ],
        ["select * from public.money_recent_order_lines($1, $2)", [tenantB, WIDE[0]]],
      ] as const) {
        const { rows } = await tx.query(sql, [...params]);
        expect(rows, sql).toEqual([]);
      }
    });
    const own = await lineRevenue(bob, tenantB, WIDE[0], WIDE[1]);
    expect(cents(own)).toBe(700000);
    expect(own.flatMap((row) => row.order_tags ?? [])).toEqual(["b-only"]);
  });

  it("is closed to anyone signed out", async () => {
    await expect(
      asAnon(db, (tx) =>
        tx.query("select * from public.money_line_revenue($1, $2, $3, 'month', 'UTC')", [
          tenantA,
          ...WIDE,
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
