import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Bringing stock records across from spreadsheets. What matters most:
 * nothing is written for a look, a second press does nothing, the same file
 * again changes nothing, one workspace can't reach another, and an imported
 * delivery never raises a count or goes anywhere near the shop.
 */

type User = { id: string; email: string };
type Counts = {
  new: number;
  changed: number;
  same: number;
  repeated: boolean;
  suppliers_added?: number;
  lines?: number;
  unmatched?: number;
};

let db: PGlite;
let alice: User; // owner of A
let bob: User; // owner of B
let carol: User; // plain member of A
let tenantA: string;
let tenantB: string;
let rug: string;
let yarn: string;
let bobRug: string;

async function tenantFor(owner: User, name: string): Promise<string> {
  return asUser(db, owner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select id from public.create_tenant($1, 'America/New_York', 'USD')",
      [name],
    );
    return rows[0].id;
  });
}
const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
const as = <T>(user: User, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);
const one = async <T>(sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows[0];
const count = async (sql: string, params: unknown[] = []) =>
  (await one<{ n: number }>(`select count(*)::int as n from ${sql}`, params)).n;

/** Runs one import function as a person. With no key it is only a look. */
const run = async (
  user: User,
  fn: string,
  tenant: string,
  rows: object[],
  key: string | null = null,
): Promise<Counts> =>
  (
    await as<{ out: Counts }>(
      user,
      `select public.${fn}($1, $2, $3::jsonb, 'file.csv', $4) as out`,
      [tenant, key, JSON.stringify(rows), key !== null],
    )
  )[0].out;

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

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
  for (const [tenant, prefix] of [
    [tenantA, "a"],
    [tenantB, "b"],
  ]) {
    await service("select public.upsert_stock_items($1, 'shopify', $2::jsonb)", [
      tenant,
      JSON.stringify([
        {
          external_id: `${prefix}-v1`,
          inventory_item_id: `${prefix}-i1`,
          title: "Wool rug",
          variant_title: "Large",
          sku: `${prefix}-RUG-L`,
          on_hand: 4,
          unit_cost: 60,
          tracked: true,
          vendor: "Shop Vendor",
        },
        {
          external_id: `${prefix}-v2`,
          inventory_item_id: `${prefix}-i2`,
          title: "Yarn bundle",
          on_hand: 30,
          unit_cost: 8.5,
          tracked: true,
        },
      ]),
    ]);
  }
  const id = async (tenant: string, external: string) =>
    (
      await one<{ id: string }>(
        "select id from public.stock_items where tenant_id = $1 and external_id = $2",
        [tenant, external],
      )
    ).id;
  rug = await id(tenantA, "a-v1");
  yarn = await id(tenantA, "a-v2");
  bobRug = await id(tenantB, "b-v1");
}, 120_000);

describe("who may import", () => {
  const fns = [
    "import_suppliers",
    "import_item_planning",
    "import_purchase_orders",
    "import_ledger_entries",
    "import_daily_counts",
    "import_deliveries",
  ];
  it("is owners and admins of that workspace only, for a look as much as for the real thing", async () => {
    for (const fn of fns) {
      await expect(run(carol, fn, tenantA, []), fn).rejects.toThrow(/Only owners and admins/);
      await expect(run(bob, fn, tenantA, []), fn).rejects.toThrow(/Only owners and admins/);
      await expect(run(bob, fn, tenantA, [], randomUUID()), fn).rejects.toThrow(
        /Only owners and admins/,
      );
      await expect(
        asAnon(db, (tx) =>
          tx.query(`select public.${fn}($1, null, '[]'::jsonb, '', false)`, [tenantA]),
        ),
        fn,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("needs a key to write, and refuses a file that is too big", async () => {
    await expect(
      as(alice, "select public.import_suppliers($1, null, '[]'::jsonb, '', true)", [tenantA]),
    ).rejects.toThrow(/request key/);
    const huge = Array.from({ length: 20001 }, (_, i) => ({ name: `S${i}` }));
    await expect(run(alice, "import_suppliers", tenantA, huge)).rejects.toThrow(/too big/);
  });
});

describe("importing suppliers", () => {
  const file = [
    {
      name: "Hill Mill Yarns",
      contact_name: "王小明",
      emails: ["Orders@HillMill.example", "accounts@hillmill.example"],
      lead_time_days: 45,
      moq: 22,
      moq_applies_to: "sku",
      notes: "By sea",
      archived: false,
    },
    { name: "shop vendor", lead_time_days: 14, archived: true },
  ];

  it("shows what would happen without writing anything", async () => {
    const before = await count("public.suppliers where tenant_id = $1", [tenantA]);
    expect(await run(alice, "import_suppliers", tenantA, file)).toEqual({
      new: 1,
      changed: 1,
      same: 0,
      repeated: false,
    });
    expect(await count("public.suppliers where tenant_id = $1", [tenantA])).toBe(before);
    expect(await count("public.stock_imports")).toBe(0);
  });

  it("writes once, however many times the button is pressed", async () => {
    const key = randomUUID();
    expect(await run(alice, "import_suppliers", tenantA, file, key)).toEqual({
      new: 1,
      changed: 1,
      same: 0,
      repeated: false,
    });
    const hill = await one<Record<string, unknown>>(
      "select contact_name, email, more_emails, lead_time_days, coverage_days, moq, moq_applies_to, notes, archived_at from public.suppliers where tenant_id = $1 and name = 'Hill Mill Yarns'",
      [tenantA],
    );
    expect(hill).toEqual({
      contact_name: "王小明",
      email: "orders@hillmill.example",
      more_emails: ["accounts@hillmill.example"],
      lead_time_days: 45,
      coverage_days: 30,
      moq: 22,
      moq_applies_to: "sku",
      notes: "By sea",
      archived_at: null,
    });
    // Matched whatever the capitals; the name the workspace already had is kept.
    const vendor = await one<{ lead_time_days: number; archived: boolean }>(
      "select lead_time_days, archived_at is not null as archived from public.suppliers where tenant_id = $1 and name = 'Shop Vendor'",
      [tenantA],
    );
    expect(vendor).toEqual({ lead_time_days: 14, archived: true });

    // The second press: the first one's answer, and nothing more.
    expect(await run(alice, "import_suppliers", tenantA, file, key)).toMatchObject({
      new: 1,
      changed: 1,
      repeated: true,
    });
    expect(await count("public.stock_imports where tenant_id = $1", [tenantA])).toBe(1);
    // The same file again under a new key: everything is already as it says.
    expect(await run(alice, "import_suppliers", tenantA, file, randomUUID())).toEqual({
      new: 0,
      changed: 0,
      same: 2,
      repeated: false,
    });
  });

  it("stays inside its own workspace", async () => {
    expect(
      await count("public.suppliers where tenant_id = $1 and name = 'Hill Mill Yarns'", [tenantB]),
    ).toBe(0);
    expect(await as(bob, "select id from public.stock_imports")).toEqual([]);
    expect(await as(carol, "select id from public.stock_imports")).toEqual([]);
    expect(
      (await as(alice, "select kind, file_name, counts from public.stock_imports")).length,
    ).toBe(2);
    await expect(
      as(
        alice,
        "insert into public.stock_imports (tenant_id, kind, request_key, counts) values ($1, 'suppliers', gen_random_uuid(), '{}')",
        [tenantA],
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("undoes the whole file when one row is no good", async () => {
    const before = await count("public.suppliers where tenant_id = $1", [tenantA]);
    await expect(
      run(
        alice,
        "import_suppliers",
        tenantA,
        [{ name: "Fine Co" }, { name: "Bad Co", emails: ["nope"] }],
        randomUUID(),
      ),
    ).rejects.toThrow(/Bad email/);
    await expect(
      run(
        alice,
        "import_suppliers",
        tenantA,
        [{ name: "Fine Co" }, { name: "Slow Co", lead_time_days: 999 }],
        randomUUID(),
      ),
    ).rejects.toThrow(/check constraint/);
    expect(await count("public.suppliers where tenant_id = $1", [tenantA])).toBe(before);
  });
});

describe("importing item planning", () => {
  it("sets only the figures the file has, and the supplier counts as chosen by hand", async () => {
    const file = [
      {
        stock_item_id: rug,
        supplier: "hill mill yarns",
        supplier_sku: "HM-RUG",
        own_cost: "41.50",
        lead_time_days: 60,
        case_pack: 12,
        hidden: false,
      },
      { stock_item_id: yarn, supplier: "Brand New Mill", moq: 6 },
    ];
    expect(await run(alice, "import_item_planning", tenantA, file)).toEqual({
      new: 0,
      changed: 2,
      same: 0,
      suppliers_added: 1,
      repeated: false,
    });
    // Only a look: no supplier was made.
    expect(
      await count("public.suppliers where tenant_id = $1 and name = 'Brand New Mill'", [tenantA]),
    ).toBe(0);

    await run(alice, "import_item_planning", tenantA, file, randomUUID());
    const planned = await one<Record<string, unknown>>(
      "select s.name as supplier, si.supplier_sku, si.own_cost::text, si.lead_time_days, si.coverage_days, si.case_pack, si.moq, si.hidden from public.stock_items si join public.suppliers s on s.id = si.supplier_id where si.id = $1",
      [rug],
    );
    expect(planned).toEqual({
      supplier: "Hill Mill Yarns",
      supplier_sku: "HM-RUG",
      own_cost: "41.50",
      lead_time_days: 60,
      coverage_days: null,
      case_pack: 12,
      moq: null,
      hidden: false,
    });

    // A later sync, with the shop still naming its own vendor, leaves the choice alone.
    await service("select public.upsert_stock_items($1, 'shopify', $2::jsonb)", [
      tenantA,
      JSON.stringify([
        {
          external_id: "a-v1",
          title: "Wool rug",
          sku: "a-RUG-L",
          on_hand: 4,
          vendor: "Shop Vendor",
        },
      ]),
    ]);
    expect(
      (
        await one<{ name: string }>(
          "select s.name from public.stock_items si join public.suppliers s on s.id = si.supplier_id where si.id = $1",
          [rug],
        )
      ).name,
    ).toBe("Hill Mill Yarns");

    // The same file again changes nothing; a null clears a figure.
    expect(await run(alice, "import_item_planning", tenantA, file, randomUUID())).toMatchObject({
      changed: 0,
      same: 2,
      suppliers_added: 0,
    });
    expect(
      await run(
        alice,
        "import_item_planning",
        tenantA,
        [{ stock_item_id: rug, lead_time_days: null, case_pack: 1 }],
        randomUUID(),
      ),
    ).toMatchObject({ changed: 1, same: 0 });
    expect(
      await one(
        "select lead_time_days, case_pack, supplier_sku from public.stock_items where id = $1",
        [rug],
      ),
    ).toEqual({ lead_time_days: null, case_pack: null, supplier_sku: "HM-RUG" });
  });

  it("refuses an item from another workspace", async () => {
    await expect(
      run(
        alice,
        "import_item_planning",
        tenantA,
        [{ stock_item_id: bobRug, moq: 2 }],
        randomUUID(),
      ),
    ).rejects.toThrow(/Item not found/);
    expect(
      (
        await one<{ moq: number | null }>("select moq from public.stock_items where id = $1", [
          bobRug,
        ])
      ).moq,
    ).toBeNull();
  });
});

describe("importing purchase orders", () => {
  const orders = () => [
    {
      reference: "HI-202603-E5A62F-SEA",
      supplier: "Hill Mill Yarns",
      status: "partial",
      created_at: "2026-03-02T12:00:00Z",
      ordered_at: "2026-03-04T12:00:00Z",
      expected_on: "2026-05-01",
      shipping_cost: "250.00",
      tax_rate_pct: "8.875",
      notes: "By sea",
      adjustments: [{ label: "Pallet fee", amount: "25.00" }],
      lines: [
        {
          stock_item_id: rug,
          qty_ordered: 36,
          qty_received: 12,
          unit_cost: "7.50",
          supplier_sku: "HM-RUG",
          note: "",
        },
        { stock_item_id: yarn, qty_ordered: 10, qty_received: 10, unit_cost: "2.00" },
      ],
    },
    {
      reference: "OL-202501-00CLOS",
      supplier: "Old Supplier Ltd",
      status: "closed",
      created_at: "2025-01-10T12:00:00Z",
      lines: [{ stock_item_id: rug, qty_ordered: 5, qty_received: 5, unit_cost: "6.00" }],
    },
  ];
  const onHand = async (id: string) =>
    (await one<{ on_hand: number }>("select on_hand from public.stock_items where id = $1", [id]))
      .on_hand;

  it("brings in open and part-received orders as history: no count moves, nothing is queued", async () => {
    const before = { rug: await onHand(rug), yarn: await onHand(yarn) };
    expect(await run(alice, "import_purchase_orders", tenantA, orders())).toEqual({
      new: 2,
      changed: 0,
      same: 0,
      lines: 3,
      suppliers_added: 1,
      repeated: false,
    });
    expect(
      await count("public.purchase_orders where tenant_id = $1 and source = 'import'", [tenantA]),
    ).toBe(0);

    const key = randomUUID();
    await run(alice, "import_purchase_orders", tenantA, orders(), key);
    const po = await one<Record<string, unknown>>(
      "select reference, status, source, ordered_at is not null as sent, closed_at, expected_on::text, shipping_cost::text, tax_rate_pct::text, adjustments, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as created from public.purchase_orders where tenant_id = $1 and reference = 'HI-202603-E5A62F-SEA'",
      [tenantA],
    );
    expect(po).toEqual({
      reference: "HI-202603-E5A62F-SEA",
      status: "partial",
      source: "import",
      sent: true,
      closed_at: null,
      expected_on: "2026-05-01",
      shipping_cost: "250.00",
      tax_rate_pct: "8.875",
      adjustments: [{ label: "Pallet fee", amount: "25.00" }],
      created: "2026-03-02",
    });
    const closed = await one<{ closed: boolean; status: string }>(
      "select closed_at is not null as closed, status from public.purchase_orders where tenant_id = $1 and reference = 'OL-202501-00CLOS'",
      [tenantA],
    );
    expect(closed).toEqual({ closed: true, status: "closed" });

    // What had arrived is on the lines...
    expect(
      (
        await db.query(
          "select l.qty_ordered, l.qty_received from public.purchase_order_lines l join public.purchase_orders po on po.id = l.po_id where po.reference = 'HI-202603-E5A62F-SEA' order by l.qty_ordered desc",
        )
      ).rows,
    ).toEqual([
      { qty_ordered: 36, qty_received: 12 },
      { qty_ordered: 10, qty_received: 10 },
    ]);
    // ...and nowhere else: the counts are as they were, and no receipt exists.
    expect({ rug: await onHand(rug), yarn: await onHand(yarn) }).toEqual(before);
    expect(await count("public.stock_receipts where tenant_id = $1", [tenantA])).toBe(0);
    expect(await service("select * from public.claim_stock_receipt_tries(50)")).toEqual([]);
    // The average cost of what has been delivered now has something to go on.
    expect(
      await as(
        alice,
        "select units::int, total::text from public.stock_received_costs($1) where stock_item_id = $2",
        [tenantA, rug],
      ),
    ).toEqual([{ units: 17, total: "120.00" }]);

    // Second press, then the same file under a new key: nothing more.
    expect(await run(alice, "import_purchase_orders", tenantA, orders(), key)).toMatchObject({
      new: 2,
      repeated: true,
    });
    expect(await run(alice, "import_purchase_orders", tenantA, orders(), randomUUID())).toEqual({
      new: 0,
      changed: 0,
      same: 2,
      lines: 0,
      suppliers_added: 0,
      repeated: false,
    });
    expect(
      await count("public.purchase_orders where tenant_id = $1 and source = 'import'", [tenantA]),
    ).toBe(2);
  });

  it("checking in the rest of an imported order adds only what is checked in now", async () => {
    const po = await one<{ id: string }>(
      "select id from public.purchase_orders where tenant_id = $1 and reference = 'HI-202603-E5A62F-SEA'",
      [tenantA],
    );
    const line = await one<{ id: string }>(
      "select id from public.purchase_order_lines where po_id = $1 and stock_item_id = $2",
      [po.id, rug],
    );
    const before = await onHand(rug);
    await as(alice, "select * from public.receive_delivery($1, $2, $3::jsonb, true)", [
      po.id,
      randomUUID(),
      JSON.stringify([{ line_id: line.id, quantity: 4 }]),
    ]);
    expect(await onHand(rug)).toBe(before + 4);
    // Only those 4 are offered to the shop, never the 12 from the spreadsheet.
    const claimed = await service<{ quantity: number }>(
      "select quantity from public.claim_stock_receipt_tries(50)",
    );
    expect(claimed).toEqual([{ quantity: 4 }]);
  });

  it("refuses a file that names another workspace's item, or a status it doesn't know", async () => {
    const stray = [
      {
        ...orders()[1],
        reference: "XX-1",
        lines: [{ stock_item_id: bobRug, qty_ordered: 1, qty_received: 1, unit_cost: "1" }],
      },
    ];
    await expect(
      run(alice, "import_purchase_orders", tenantA, stray, randomUUID()),
    ).rejects.toThrow(/Item not found/);
    await expect(
      run(
        alice,
        "import_purchase_orders",
        tenantA,
        [{ ...orders()[1], reference: "XX-2", status: "shipped" }],
        randomUUID(),
      ),
    ).rejects.toThrow(/can't be read/);
    expect(await count("public.purchase_orders where reference in ('XX-1', 'XX-2')")).toBe(0);
    // The same reference is free in another workspace.
    const mine = [
      {
        ...orders()[1],
        lines: [{ stock_item_id: bobRug, qty_ordered: 1, qty_received: 0, unit_cost: "1" }],
        status: "ordered",
      },
    ];
    expect(await run(bob, "import_purchase_orders", tenantB, mine, randomUUID())).toMatchObject({
      new: 1,
    });
    expect(
      await as(
        bob,
        "select count(*)::int as n from public.purchase_orders where source = 'import'",
      ),
    ).toEqual([{ n: 1 }]);
  });
});

describe("importing past deliveries", () => {
  const deliveries = () => [
    {
      reference: "hi-202603-e5a62f-sea",
      stock_item_id: rug,
      quantity: 12,
      received_at: "2026-04-28T14:05:00Z",
    },
    {
      reference: "HI-202603-E5A62F-SEA",
      stock_item_id: yarn,
      quantity: 10,
      received_at: "2026-04-28T14:05:00Z",
    },
    // No such order, and an order that has no such item: left out.
    {
      reference: "NO-SUCH-ORDER",
      stock_item_id: rug,
      quantity: 3,
      received_at: "2026-04-28T14:05:00Z",
    },
    {
      reference: "OL-202501-00CLOS",
      stock_item_id: yarn,
      quantity: 3,
      received_at: "2025-02-01T12:00:00Z",
    },
  ];

  it("records when goods arrived and nothing else, and can never reach the shop", async () => {
    const before = await db.query(
      "select si.id, si.on_hand, coalesce(sum(l.qty_received), 0)::int as got from public.stock_items si left join public.purchase_order_lines l on l.stock_item_id = si.id where si.tenant_id = $1 group by si.id order by si.id",
      [tenantA],
    );
    expect(await run(alice, "import_deliveries", tenantA, deliveries())).toEqual({
      new: 2,
      changed: 0,
      same: 0,
      unmatched: 2,
      repeated: false,
    });
    expect(await count("public.stock_receipts where source = 'import'")).toBe(0);

    const key = randomUUID();
    await run(alice, "import_deliveries", tenantA, deliveries(), key);
    const made = await db.query(
      "select quantity, shop_status, shop_can_retry, source, received_by, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day from public.stock_receipts where source = 'import' order by quantity",
    );
    expect(made.rows).toEqual([
      {
        quantity: 10,
        shop_status: "skipped",
        shop_can_retry: false,
        source: "import",
        received_by: null,
        day: "2026-04-28",
      },
      {
        quantity: 12,
        shop_status: "skipped",
        shop_can_retry: false,
        source: "import",
        received_by: null,
        day: "2026-04-28",
      },
    ]);
    // Counts and "arrived" figures are exactly as they were.
    const after = await db.query(
      "select si.id, si.on_hand, coalesce(sum(l.qty_received), 0)::int as got from public.stock_items si left join public.purchase_order_lines l on l.stock_item_id = si.id where si.tenant_id = $1 group by si.id order by si.id",
      [tenantA],
    );
    expect(after.rows).toEqual(before.rows);

    // The worker finds nothing of them to send.
    const imported = (
      await db.query<{ id: string }>("select id from public.stock_receipts where source = 'import'")
    ).rows;
    const claimed = await service<{ id: string }>(
      "select id from public.claim_stock_receipt_tries(100)",
    );
    expect(claimed.filter((c) => imported.some((r) => r.id === c.id))).toEqual([]);
    // No path puts one in the queue: the table itself refuses.
    for (const change of [
      "shop_status = 'pending'",
      "shop_status = 'sending'",
      "shop_status = 'failed'",
      "shop_can_retry = true",
    ]) {
      await expect(
        db.query(`update public.stock_receipts set ${change} where id = $1`, [imported[0].id]),
        change,
      ).rejects.toThrow(/stock_receipts_import_is_history/);
    }
    await expect(
      as(alice, "select public.retry_stock_receipt($1)", [imported[0].id]),
    ).rejects.toThrow(/isn't waiting on another try/);
    // Even a receipt forced to look pending (the rule lifted by hand) is passed over by the claim.
    await db.exec(
      "alter table public.stock_receipts drop constraint stock_receipts_import_is_history",
    );
    await db.query("update public.stock_receipts set shop_status = 'pending' where id = $1", [
      imported[0].id,
    ]);
    expect(await service("select id from public.claim_stock_receipt_tries(100)")).toEqual([]);
    await db.query("update public.stock_receipts set shop_status = 'skipped' where id = $1", [
      imported[0].id,
    ]);
    await db.exec(
      "alter table public.stock_receipts add constraint stock_receipts_import_is_history check (source <> 'import' or (shop_status = 'skipped' and not shop_can_retry))",
    );

    // Pressed twice, then brought in again: still two.
    expect(await run(alice, "import_deliveries", tenantA, deliveries(), key)).toMatchObject({
      new: 2,
      repeated: true,
    });
    expect(await run(alice, "import_deliveries", tenantA, deliveries(), randomUUID())).toEqual({
      new: 0,
      changed: 0,
      same: 2,
      unmatched: 2,
      repeated: false,
    });
    expect(await count("public.stock_receipts where source = 'import'")).toBe(2);
  });

  it("is only for orders that were themselves imported, in this workspace", async () => {
    const hill = await one<{ id: string }>(
      "select id from public.suppliers where tenant_id = $1 and name = 'Hill Mill Yarns'",
      [tenantA],
    );
    await as(alice, "select public.create_purchase_order($1, $2, $3::jsonb, '')", [
      tenantA,
      hill.id,
      JSON.stringify([{ stock_item_id: rug, qty: 2, unit_cost: 60 }]),
    ]);
    const own = await one<{ reference: string }>(
      "select reference from public.purchase_orders where tenant_id = $1 and source = 'app' order by number desc limit 1",
      [tenantA],
    );
    expect(
      await run(alice, "import_deliveries", tenantA, [
        {
          reference: own.reference,
          stock_item_id: rug,
          quantity: 2,
          received_at: "2026-04-28T14:05:00Z",
        },
      ]),
    ).toMatchObject({ new: 0, unmatched: 1 });
    // Bob can't hang a delivery on Alice's order, even knowing its reference.
    expect(
      await run(
        bob,
        "import_deliveries",
        tenantB,
        [
          {
            reference: "HI-202603-E5A62F-SEA",
            stock_item_id: bobRug,
            quantity: 2,
            received_at: "2026-04-28T14:05:00Z",
          },
        ],
        randomUUID(),
      ),
    ).toMatchObject({ new: 0, unmatched: 1 });
    await expect(
      run(alice, "import_deliveries", tenantA, [
        {
          reference: "HI-202603-E5A62F-SEA",
          stock_item_id: rug,
          quantity: 0,
          received_at: "2026-04-28T14:05:00Z",
        },
      ]),
    ).rejects.toThrow(/How many arrived/);
  });
});

describe("importing the supplier ledger", () => {
  const entries = () => [
    {
      supplier: "Hill Mill Yarns",
      type: "statement",
      entry_date: "2026-10-01",
      stated_balance: "1200.00",
      description: "October",
    },
    {
      supplier: "Hill Mill Yarns",
      type: "invoice",
      entry_date: "2026-10-12",
      amount: "2816.90",
      reference: "INV-1019",
      paid_on: "2026-11-14T12:00:00Z",
    },
    { supplier: "Hill Mill Yarns", type: "payment", entry_date: "2026-10-30", amount: "500.00" },
    { supplier: "Hill Mill Yarns", type: "payment", entry_date: "2026-10-30", amount: "500.00" },
    {
      supplier: "Ledger Only Co",
      type: "adjustment",
      entry_date: "2026-11-01",
      amount: "-25.00",
      description: "Credit note",
    },
  ];

  it("adds entries marked as imported, once", async () => {
    expect(await run(alice, "import_ledger_entries", tenantA, entries())).toEqual({
      new: 5,
      changed: 0,
      same: 0,
      suppliers_added: 1,
      repeated: false,
    });
    expect(await count("public.supplier_ledger where tenant_id = $1", [tenantA])).toBe(0);

    const key = randomUUID();
    await run(alice, "import_ledger_entries", tenantA, entries(), key);
    const rows = await as<Record<string, unknown>>(
      alice,
      "select type, entry_date::text, amount::text, stated_balance::text, reference, source, payment_sent_at is not null as paid from public.supplier_ledger order by entry_date, type, id",
    );
    expect(
      rows.map((r) => [
        r.type,
        r.entry_date,
        r.amount,
        r.stated_balance,
        r.reference,
        r.source,
        r.paid,
      ]),
    ).toEqual([
      ["statement", "2026-10-01", "0.00", "1200.00", null, "import", false],
      ["invoice", "2026-10-12", "2816.90", null, "INV-1019", "import", true],
      // Two identical payments in the file are two payments.
      ["payment", "2026-10-30", "500.00", null, null, "import", false],
      ["payment", "2026-10-30", "500.00", null, null, "import", false],
      ["adjustment", "2026-11-01", "-25.00", null, null, "import", false],
    ]);

    expect(await run(alice, "import_ledger_entries", tenantA, entries(), key)).toMatchObject({
      new: 5,
      repeated: true,
    });
    expect(await run(alice, "import_ledger_entries", tenantA, entries(), randomUUID())).toEqual({
      new: 0,
      changed: 0,
      same: 5,
      suppliers_added: 0,
      repeated: false,
    });
    expect(await count("public.supplier_ledger where tenant_id = $1", [tenantA])).toBe(5);
  });

  it("corrects an invoice that already has that number rather than adding a second", async () => {
    const fixed = [
      {
        supplier: "hill mill yarns",
        type: "invoice",
        entry_date: "2026-10-12",
        amount: "2800.00",
        reference: "inv-1019",
      },
    ];
    expect(await run(alice, "import_ledger_entries", tenantA, fixed, randomUUID())).toMatchObject({
      new: 0,
      changed: 1,
      same: 0,
    });
    expect(
      await one(
        "select amount::text, payment_sent_at is not null as paid from public.supplier_ledger where reference = 'INV-1019'",
      ),
    ).toEqual({ amount: "2800.00", paid: true });
  });

  it("keeps to its workspace and to the rules of the ledger", async () => {
    expect(await as(bob, "select id from public.supplier_ledger")).toEqual([]);
    expect(
      await count("public.suppliers where tenant_id = $1 and name = 'Ledger Only Co'", [tenantB]),
    ).toBe(0);
    await expect(
      run(
        alice,
        "import_ledger_entries",
        tenantA,
        [{ supplier: "Hill Mill Yarns", type: "invoice", entry_date: "2026-10-12", amount: "0" }],
        randomUUID(),
      ),
    ).rejects.toThrow(/not valid/);
    await expect(
      run(
        alice,
        "import_ledger_entries",
        tenantA,
        [{ supplier: "Hill Mill Yarns", type: "refund", entry_date: "2026-10-12", amount: "5" }],
        randomUUID(),
      ),
    ).rejects.toThrow(/not valid/);
  });
});

describe("importing past daily counts", () => {
  it("fills in days we didn't see, and never replaces one we did", async () => {
    const seen = await one<{ day: string; on_hand: number }>(
      "select day::text, on_hand from public.stock_daily_counts where stock_item_id = $1 order by day desc limit 1",
      [rug],
    );
    const file = [
      { stock_item_id: rug, day: day(-10), on_hand: 0 },
      { stock_item_id: rug, day: day(-11), on_hand: 0 },
      { stock_item_id: yarn, day: day(-10), on_hand: 7 },
      // The day the sync already wrote, a day too old to use, and a day to come.
      { stock_item_id: rug, day: seen.day, on_hand: 999 },
      { stock_item_id: rug, day: day(-400), on_hand: 0 },
      { stock_item_id: rug, day: day(5), on_hand: 0 },
    ];
    expect(await run(alice, "import_daily_counts", tenantA, file)).toEqual({
      new: 3,
      changed: 0,
      same: 3,
      repeated: false,
    });
    expect(
      await count("public.stock_daily_counts where stock_item_id = $1 and day = $2", [
        rug,
        day(-10),
      ]),
    ).toBe(0);

    const key = randomUUID();
    await run(alice, "import_daily_counts", tenantA, file, key);
    expect(
      (
        await db.query(
          "select on_hand from public.stock_daily_counts where stock_item_id = $1 and day = $2",
          [rug, seen.day],
        )
      ).rows,
    ).toEqual([{ on_hand: seen.on_hand }]);
    expect(
      await count("public.stock_daily_counts where stock_item_id = $1 and on_hand = 0", [rug]),
    ).toBe(2);
    expect(
      await count(
        "public.stock_daily_counts where day > current_date + 1 or day < current_date - 201",
      ),
    ).toBe(0);
    // The item's own count today is untouched.
    expect(
      (
        await one<{ on_hand: number }>("select on_hand from public.stock_items where id = $1", [
          yarn,
        ])
      ).on_hand,
    ).toBe(30);

    expect(await run(alice, "import_daily_counts", tenantA, file, key)).toMatchObject({
      new: 3,
      repeated: true,
    });
    expect(await run(alice, "import_daily_counts", tenantA, file, randomUUID())).toEqual({
      new: 0,
      changed: 0,
      same: 6,
      repeated: false,
    });
  });

  it("refuses another workspace's item", async () => {
    await expect(
      run(
        alice,
        "import_daily_counts",
        tenantA,
        [{ stock_item_id: bobRug, day: day(-3), on_hand: 0 }],
        randomUUID(),
      ),
    ).rejects.toThrow(/Item not found/);
    expect(
      await count("public.stock_daily_counts where stock_item_id = $1 and day = $2", [
        bobRug,
        day(-3),
      ]),
    ).toBe(0);
  });
});
