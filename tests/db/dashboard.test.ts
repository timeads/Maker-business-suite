import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

type User = { id: string; email: string };

let db: PGlite;
let alice: User;
let bob: User;
let carol: User; // plain member of tenant A
let tenantA: string;
let tenantB: string;

const TABLES = ["customers", "products", "orders", "order_lines", "financial_snapshots", "configs"];

async function tenantFor(owner: User, name: string): Promise<string> {
  return asUser(db, owner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select id from public.create_tenant($1, 'America/New_York', 'USD')",
      [name],
    );
    return rows[0].id;
  });
}

function service<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
}

type Line = {
  external_id: string;
  title: string;
  quantity: number;
  unit_price: number;
  unit_cost?: number | null;
};
function order(
  id: string,
  processedAt: string,
  netSales: number,
  lines: Line[],
  extra: Record<string, unknown> = {},
) {
  return {
    external_id: id,
    name: `#${id}`,
    customer_external_id: "cust-1",
    email: "Shopper@Example.com",
    processed_at: processedAt,
    currency: "USD",
    net_sales: netSales,
    total: netSales,
    channel: "Online Store",
    lines,
    ...extra,
  };
}

function load(
  tenantId: string,
  orders: unknown[],
  customers: unknown[] = [],
  products: unknown[] = [],
) {
  return service(
    "select public.upsert_commerce_batch($1, 'shopify', $2::jsonb, $3::jsonb, $4::jsonb)",
    [tenantId, JSON.stringify(customers), JSON.stringify(products), JSON.stringify(orders)],
  );
}

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  carol = { id: await createUser(db, "carol@a.test"), email: "carol@a.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, carol.id],
  );

  const customers = [
    {
      external_id: "cust-1",
      email: "Shopper@Example.com",
      first_name: "Sam",
      last_name: "Shopper",
    },
  ];
  const products = [{ external_id: "prod-1", title: "Wool Rug" }];
  await load(
    tenantA,
    [
      // Late evening on Oct 31 in New York is already November in UTC.
      order("1001", "2026-11-01T02:30:00Z", 100, [
        { external_id: "l1", title: "Wool Rug", quantity: 1, unit_price: 100, unit_cost: 40 },
      ]),
      order("1002", "2026-11-10T15:00:00Z", 250, [
        { external_id: "l1", title: "Wool Rug", quantity: 2, unit_price: 100, unit_cost: 40 },
        { external_id: "l2", title: "Yarn Kit", quantity: 1, unit_price: 50 },
      ]),
      order(
        "1003",
        "2026-11-12T15:00:00Z",
        80,
        [{ external_id: "l1", title: "Yarn Kit", quantity: 2, unit_price: 40 }],
        {
          channel: "Point of Sale",
        },
      ),
      order(
        "1004",
        "2026-11-13T15:00:00Z",
        999,
        [{ external_id: "l1", title: "Wool Rug", quantity: 9, unit_price: 111 }],
        {
          cancelled_at: "2026-11-13T16:00:00Z",
        },
      ),
      order(
        "1005",
        "2026-11-14T15:00:00Z",
        555,
        [{ external_id: "l1", title: "Wool Rug", quantity: 5, unit_price: 111 }],
        {
          is_test: true,
        },
      ),
    ],
    customers,
    products,
  );
  await load(
    tenantB,
    [
      order("9001", "2026-11-10T15:00:00Z", 7000, [
        { external_id: "l1", title: "Big Vase", quantity: 7, unit_price: 1000, unit_cost: 100 },
      ]),
    ],
    [{ external_id: "cust-9", email: "b-customer@example.com" }],
    [{ external_id: "prod-9", title: "Big Vase" }],
  );
  for (const [tenant, cash] of [
    [tenantA, 1200],
    [tenantB, 99000],
  ] as const) {
    await service("select public.save_financial_snapshots($1, 'quickbooks', $2::jsonb)", [
      tenant,
      JSON.stringify([
        {
          kind: "balance_sheet",
          period_start: "2026-11-21",
          period_end: "2026-11-21",
          data: { cash },
        },
      ]),
    ]);
  }
  await asUser(db, alice, (tx) =>
    tx.query("select public.save_config($1, 'dashboard', 'main', '{\"name\":\"A\"}')", [tenantA]),
  );
  await asUser(db, bob, (tx) =>
    tx.query("select public.save_config($1, 'dashboard', 'main', '{\"name\":\"B\"}')", [tenantB]),
  );
});

describe("cross-tenant isolation for dashboard data", () => {
  it("user A sees only tenant A's rows in every new table", async () => {
    await asUser(db, alice, async (tx) => {
      for (const table of TABLES) {
        const { rows } = await tx.query<{ tenant_id: string }>(
          `select tenant_id from public.${table}`,
        );
        expect(rows.length, `${table} should have rows for A`).toBeGreaterThan(0);
        expect(
          rows.every((r) => r.tenant_id === tenantA),
          `${table} leaked`,
        ).toBe(true);
      }
    });
    await asUser(db, bob, async (tx) => {
      for (const table of TABLES) {
        const { rows } = await tx.query<{ tenant_id: string }>(
          `select tenant_id from public.${table}`,
        );
        expect(rows.length, `${table} should have rows for B`).toBeGreaterThan(0);
        expect(
          rows.every((r) => r.tenant_id === tenantB),
          `${table} leaked`,
        ).toBe(true);
      }
    });
  });

  it("asking the dashboard queries for another tenant returns nothing", async () => {
    await asUser(db, alice, async (tx) => {
      const range = ["2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"];
      const sales = await tx.query(
        "select * from public.dashboard_sales_by_period($1, $2, $3, 'month', 'UTC')",
        [tenantB, ...range],
      );
      const top = await tx.query("select * from public.dashboard_top_products($1, $2, $3, 5)", [
        tenantB,
        ...range,
      ]);
      const channels = await tx.query(
        "select * from public.dashboard_sales_by_channel($1, $2, $3)",
        [tenantB, ...range],
      );
      expect([sales.rows, top.rows, channels.rows]).toEqual([[], [], []]);
    });
  });

  it("clients cannot write synced data, call sync functions, or read as a signed-out visitor", async () => {
    const attempts = [
      `insert into public.orders (tenant_id, provider, external_id, processed_at) values ('${tenantA}', 'shopify', 'x', now())`,
      "update public.orders set net_sales = 0",
      "delete from public.orders",
      "delete from public.customers",
      "update public.financial_snapshots set data = '{}'",
      `insert into public.configs (tenant_id, module, key, body) values ('${tenantA}', 'dashboard', 'x', '{}')`,
      "update public.configs set body = '{}'",
      `select public.upsert_commerce_batch('${tenantA}', 'shopify')`,
      `select public.save_financial_snapshots('${tenantA}', 'quickbooks', '[]')`,
      `select public.redact_customer('${tenantA}', 'shopify', 'cust-1')`,
      `select public.purge_provider_data('${tenantB}', 'shopify')`,
      `select public.record_usage('${tenantA}', 'sync_calls', 1)`,
      "select public.requeue_sync_job(1, '{}')",
    ];
    for (const sql of attempts) {
      await expect(
        asUser(db, alice, (tx) => tx.query(sql)),
        sql,
      ).rejects.toThrow(/permission denied/i);
    }
    for (const table of TABLES) {
      await expect(
        asAnon(db, (tx) => tx.query(`select 1 from public.${table}`)),
        table,
      ).rejects.toThrow(/permission denied/i);
    }
  });
});

describe("configs", () => {
  it("owners and admins can save their own workspace's config; nobody else can", async () => {
    await expect(
      asUser(db, alice, (tx) =>
        tx.query("select public.save_config($1, 'dashboard', 'main', '{}')", [tenantB]),
      ),
    ).rejects.toThrow(/owners and admins/i);
    await expect(
      asUser(db, carol, (tx) =>
        tx.query("select public.save_config($1, 'dashboard', 'main', '{}')", [tenantA]),
      ),
    ).rejects.toThrow(/owners and admins/i);
    // Members can still read it.
    await asUser(db, carol, async (tx) => {
      const { rows } = await tx.query<{ body: object }>("select body from public.configs");
      expect(rows).toEqual([{ body: { name: "A" } }]);
    });
  });

  it("saving again replaces the body, records who did it, and rejects junk", async () => {
    await asUser(db, alice, (tx) =>
      tx.query("select public.save_config($1, 'dashboard', 'main', '{\"name\":\"A2\"}')", [
        tenantA,
      ]),
    );
    const { rows } = await db.query<{ body: object; updated_by: string }>(
      "select body, updated_by from public.configs where tenant_id = $1",
      [tenantA],
    );
    expect(rows).toEqual([{ body: { name: "A2" }, updated_by: alice.id }]);
    for (const bad of [
      "'Dashboard!', 'main', '{}'",
      "'dashboard', 'Bad Key', '{}'",
      "'dashboard', 'main', '[]'",
    ]) {
      await expect(
        asUser(db, alice, (tx) => tx.query(`select public.save_config('${tenantA}', ${bad})`)),
        bad,
      ).rejects.toThrow(/not valid/i);
    }
  });
});

describe("dashboard queries", () => {
  const from = "2026-10-01T00:00:00Z";
  const to = "2026-12-01T00:00:00Z";

  it("groups sales by month in the workspace's timezone and leaves out cancelled and test orders", async () => {
    await asUser(db, alice, async (tx) => {
      const { rows } = await tx.query<{
        period: string;
        order_count: number;
        net_sales: string;
        cost: string;
        costed_sales: string;
      }>(
        "select period::text, order_count::int, net_sales, cost, costed_sales from public.dashboard_sales_by_period($1, $2, $3, 'month', 'America/New_York')",
        [tenantA, from, to],
      );
      expect(rows).toEqual([
        // Order 1001 was placed at 10:30pm on Oct 31 New York time.
        {
          period: "2026-10-01",
          order_count: 1,
          net_sales: "100.00",
          cost: "40.00",
          costed_sales: "100.00",
        },
        // 1002 + 1003. Only the rug lines have a cost: 2 × 40 against 2 × 100.
        {
          period: "2026-11-01",
          order_count: 2,
          net_sales: "330.00",
          cost: "80.00",
          costed_sales: "200.00",
        },
      ]);
    });
  });

  it("the same orders fall in different months when the timezone changes", async () => {
    await asUser(db, alice, async (tx) => {
      const { rows } = await tx.query<{ period: string; net_sales: string }>(
        "select period::text, net_sales from public.dashboard_sales_by_period($1, $2, $3, 'month', 'UTC')",
        [tenantA, from, to],
      );
      expect(rows).toEqual([{ period: "2026-11-01", net_sales: "430.00" }]);
    });
  });

  it("ranks products by revenue and splits sales by channel", async () => {
    await asUser(db, alice, async (tx) => {
      const top = await tx.query<{ title: string; units: number; revenue: string }>(
        "select title, units::int, revenue from public.dashboard_top_products($1, $2, $3, 5)",
        [tenantA, from, to],
      );
      expect(top.rows).toEqual([
        { title: "Wool Rug", units: 3, revenue: "300.00" },
        { title: "Yarn Kit", units: 3, revenue: "130.00" },
      ]);
      const channels = await tx.query<{ channel: string; order_count: number; net_sales: string }>(
        "select channel, order_count::int, net_sales from public.dashboard_sales_by_channel($1, $2, $3)",
        [tenantA, from, to],
      );
      expect(channels.rows).toEqual([
        { channel: "Online Store", order_count: 2, net_sales: "350.00" },
        { channel: "Point of Sale", order_count: 1, net_sales: "80.00" },
      ]);
    });
  });
});

describe("syncing", () => {
  it("re-sending an order updates it in place and replaces its lines", async () => {
    await load(tenantA, [
      order(
        "1003",
        "2026-11-12T15:00:00Z",
        40,
        [{ external_id: "l1", title: "Yarn Kit", quantity: 1, unit_price: 40 }],
        {
          channel: "Point of Sale",
        },
      ),
    ]);
    const orders = await db.query<{ net_sales: string }>(
      "select net_sales from public.orders where tenant_id = $1 and external_id = '1003'",
      [tenantA],
    );
    expect(orders.rows).toEqual([{ net_sales: "40.00" }]);
    const lines = await db.query<{ quantity: number }>(
      "select l.quantity from public.order_lines l join public.orders o on o.id = l.order_id where o.tenant_id = $1 and o.external_id = '1003'",
      [tenantA],
    );
    expect(lines.rows).toEqual([{ quantity: 1 }]);
  });

  it("the same order number in two workspaces stays two separate orders", async () => {
    await load(tenantB, [order("1001", "2026-11-02T15:00:00Z", 1, [])]);
    const { rows } = await db.query<{ tenant_id: string; net_sales: string }>(
      "select tenant_id, net_sales from public.orders where external_id = '1001' order by net_sales",
    );
    expect(rows).toEqual([
      { tenant_id: tenantB, net_sales: "1.00" },
      { tenant_id: tenantA, net_sales: "100.00" },
    ]);
  });

  it("replaces a cached report for the same period", async () => {
    await service("select public.save_financial_snapshots($1, 'quickbooks', $2::jsonb)", [
      tenantA,
      JSON.stringify([
        {
          kind: "balance_sheet",
          period_start: "2026-11-21",
          period_end: "2026-11-21",
          data: { cash: 1500 },
        },
      ]),
    ]);
    const { rows } = await db.query<{ data: object }>(
      "select data from public.financial_snapshots where tenant_id = $1",
      [tenantA],
    );
    expect(rows).toEqual([{ data: { cash: 1500 } }]);
  });

  it("puts a long sync back on the queue with its place saved", async () => {
    const [conn] = await service<{ id: string }>(
      "select public.save_connection($1, 'shopify', 'alice.myshopify.com', 'Alice', '{}', '{}'::jsonb, $2) as id",
      [tenantA, alice.id],
    );
    const [job] = await service<{ id: number }>("select id from public.claim_sync_jobs(1)");
    await service('select public.requeue_sync_job($1, \'{"after":"page-2"}\')', [job.id]);
    const again = await service<{ id: number; cursor: object; attempts: number }>(
      "select id, cursor, attempts from public.claim_sync_jobs(1)",
    );
    expect(again).toEqual([{ id: job.id, cursor: { after: "page-2" }, attempts: 1 }]);
    await service("select public.finish_sync_job($1)", [job.id]);
    expect(conn.id).toBeTruthy();
  });
});

describe("privacy requests", () => {
  it("erasing a shopper removes their details but keeps the sales figures, in that workspace only", async () => {
    const [{ n }] = await service<{ n: number }>(
      "select public.redact_customer($1, 'shopify', 'cust-1', 'shopper@example.com') as n",
      [tenantA],
    );
    expect(n).toBeGreaterThan(0);
    const customers = await db.query("select 1 from public.customers where tenant_id = $1", [
      tenantA,
    ]);
    expect(customers.rows).toHaveLength(0);
    const orders = await db.query<{
      email: string | null;
      customer_external_id: string | null;
      net_sales: string;
    }>(
      "select email, customer_external_id, net_sales from public.orders where tenant_id = $1 and external_id = '1002'",
      [tenantA],
    );
    expect(orders.rows).toEqual([{ email: null, customer_external_id: null, net_sales: "250.00" }]);
    // Tenant B's customer is untouched.
    const other = await db.query("select 1 from public.customers where tenant_id = $1", [tenantB]);
    expect(other.rows).toHaveLength(1);
  });

  it("a privacy webhook reaches a store that already disconnected; ordinary ones don't", async () => {
    const [conn] = await service<{ id: string }>(
      "select id from public.connections where tenant_id = $1",
      [tenantA],
    );
    await service("select public.mark_connection($1, 'disconnected', 'App was uninstalled')", [
      conn.id,
    ]);
    const hook = async (topic: string, id: string) =>
      (
        await service<{ r: string }>(
          "select public.enqueue_provider_webhook('shopify', 'alice.myshopify.com', $1, $2, '{}'::jsonb) as r",
          [topic, id],
        )
      )[0].r;
    expect(await hook("orders/create", "d1")).toBe("unknown_account");
    expect(await hook("shop/redact", "d2")).toBe("queued");
    expect(await hook("shop/redact", "d2")).toBe("duplicate");
  });

  it("erasing a store removes everything synced from it for that workspace only", async () => {
    await service("select public.purge_provider_data($1, 'shopify')", [tenantA]);
    for (const table of ["orders", "order_lines", "customers", "products"]) {
      const mine = await db.query(`select 1 from public.${table} where tenant_id = $1`, [tenantA]);
      expect(mine.rows, table).toHaveLength(0);
      const theirs = await db.query(`select 1 from public.${table} where tenant_id = $1`, [
        tenantB,
      ]);
      expect(theirs.rows.length, `${table} for B`).toBeGreaterThan(0);
    }
    // QuickBooks data is a different provider and stays.
    const snaps = await db.query("select 1 from public.financial_snapshots where tenant_id = $1", [
      tenantA,
    ]);
    expect(snaps.rows).toHaveLength(1);
  });
});
