import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Rules, packing memory, saved choices and bulk label runs in the database:
 *   - a rule's hold lands once, and never again on an order a person released;
 *   - `shipping_packings` and `shipping_label_batches` are each workspace's own,
 *     read by members and written only through functions;
 *   - what a person saved for an order is kept on its plan and can be cleared;
 *   - a run's order is taken once, and an order can never have two labels
 *     bought for it, in one run or across two.
 */
type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let carol: User; // member of A
let bob: User; // owner of B
let tenantA: string;
let tenantB: string;
let orderA: string;
let orderA2: string;
let orderA3: string;
let orderB: string;
let boxA: string;

const service = <T>(sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query<T>(sql, params)).rows);
const as = <T>(user: User, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);

async function tenantFor(owner: User, name: string): Promise<string> {
  return asUser(db, owner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select id from public.create_tenant($1, 'America/New_York', 'USD')",
      [name],
    );
    return rows[0].id;
  });
}

async function order(tenant: string, id: string): Promise<string> {
  await service(
    "select public.upsert_commerce_batch($1, 'shopify', $2::jsonb, '[]'::jsonb, $3::jsonb)",
    [
      tenant,
      JSON.stringify([
        { external_id: `c${id}`, email: `c${id}@example.com`, first_name: "Sam", last_name: "S" },
      ]),
      JSON.stringify([
        {
          external_id: id,
          name: `#${id}`,
          customer_external_id: `c${id}`,
          email: `c${id}@example.com`,
          processed_at: "2026-11-20T22:03:00Z",
          currency: "USD",
          net_sales: 285.6,
          total_shipping: 14,
          total: 299.6,
          lines: [],
        },
      ]),
    ],
  );
  await service("select public.upsert_shipping_orders($1, 'shopify', $2::jsonb)", [
    tenant,
    JSON.stringify([
      {
        external_id: id,
        recipient: "Sam Shopper",
        address1: `${id} Mill Lane`,
        city: "Brooklyn",
        region: "NY",
        postal_code: "11201",
        country_code: "us",
        paid: true,
        shipping_paid: 14,
        weight_grams: 1871,
        items: [{ line_id: "l1", title: "Yarn", variant: "Red", sku: "Y-R", qty: 2, left: 2 }],
      },
    ]),
  ]);
  const { rows } = await db.query<{ id: string }>(
    "select id from public.shipping_orders where tenant_id = $1 and external_id = $2",
    [tenant, id],
  );
  return rows[0].id;
}

const RATE = "rate_0123456789abcdef";
const quote = (tenant: string, orderId: string, by: User, shipment: string) =>
  service<{ id: string }>(
    "select public.save_label_quote_from($1, $2, $3, 'easypost', $4, $5::jsonb, 'shipment', 1, '{}'::uuid[], null) as id",
    [
      tenant,
      orderId,
      by.id,
      shipment,
      JSON.stringify([
        {
          id: RATE,
          carrier: "USPS",
          service: "GroundAdvantage",
          name: "Ground Advantage",
          price: "6.40",
          currency: "USD",
          days: 4,
          source: "easypost",
        },
      ]),
    ],
  ).then((rows) => rows[0].id);
const claim = (user: User, orderId: string) =>
  as<{ c: { quote_id: string } }>(user, "select public.claim_label_purchase($1, $2) as c", [
    orderId,
    RATE,
  ]).then((rows) => rows[0].c);

const held = async (orderId: string) =>
  (
    await db.query<{ on_hold: boolean; hold_reason: string; settled: boolean }>(
      "select on_hold, hold_reason, rule_hold_settled_at is not null as settled from public.shipping_orders where id = $1",
      [orderId],
    )
  ).rows[0];
const holdByRule = (user: User, tenant: string, holds: { id: string; note: string }[]) =>
  as<{ n: number }>(user, "select public.hold_shipping_orders_by_rule($1, $2::jsonb) as n", [
    tenant,
    JSON.stringify(holds),
  ]).then((rows) => rows[0].n);

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  carol = { id: await createUser(db, "carol@a.test"), email: "carol@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
  const invited = await asUser(db, alice, async (tx) => {
    const { rows } = await tx.query<{ token: string }>(
      "select * from public.create_invite($1, $2, 'member'::public.membership_role)",
      [tenantA, carol.email],
    );
    return rows[0];
  });
  await as(carol, "select public.accept_invite($1)", [invited.token]);
  orderA = await order(tenantA, "7001");
  orderA2 = await order(tenantA, "7002");
  orderA3 = await order(tenantA, "7003");
  orderB = await order(tenantB, "8001");
  boxA = (
    await as<{ id: string }>(
      alice,
      "select public.save_shipping_box($1, null, 'Medium', 'box', 12, 9, 4, 6, true) as id",
      [tenantA],
    )
  )[0].id;
});

describe("a rule's hold", () => {
  it("holds a waiting order once, with the rule's note", async () => {
    expect(await holdByRule(carol, tenantA, [{ id: orderA, note: "Check the dye lot" }])).toBe(1);
    expect(await held(orderA)).toEqual({
      on_hold: true,
      hold_reason: "Check the dye lot",
      settled: true,
    });
    // Asked again, nothing changes: it is already on hold.
    expect(await holdByRule(carol, tenantA, [{ id: orderA, note: "Something else" }])).toBe(0);
    expect((await held(orderA)).hold_reason).toBe("Check the dye lot");
  });

  it("never holds again an order a person released", async () => {
    await as(carol, "select public.release_shipping_orders($1, $2::uuid[])", [tenantA, [orderA]]);
    expect(await held(orderA)).toMatchObject({ on_hold: false, settled: true });
    expect(await holdByRule(carol, tenantA, [{ id: orderA, note: "Check the dye lot" }])).toBe(0);
    expect((await held(orderA)).on_hold).toBe(false);
  });

  it("counts a release from a person's own hold too, before any rule existed", async () => {
    await as(carol, "select public.set_shipping_hold($1, true, 'Waiting on yarn')", [orderA2]);
    expect(await held(orderA2)).toMatchObject({ on_hold: true, settled: false });
    await as(carol, "select public.set_shipping_hold($1, false, '')", [orderA2]);
    expect(await held(orderA2)).toMatchObject({ on_hold: false, settled: true });
    expect(await holdByRule(carol, tenantA, [{ id: orderA2, note: "By rule" }])).toBe(0);
    // A person can still hold it by hand afterwards.
    await as(carol, "select public.hold_shipping_orders($1, $2::uuid[], 'By hand', null)", [
      tenantA,
      [orderA2],
    ]);
    expect(await held(orderA2)).toMatchObject({ on_hold: true, hold_reason: "By hand" });
    await as(carol, "select public.release_shipping_orders($1, $2::uuid[])", [tenantA, [orderA2]]);
  });

  it("is only for the workspace's own members and its own orders", async () => {
    await expect(holdByRule(bob, tenantA, [{ id: orderA3, note: "x" }])).rejects.toThrow(
      /Workspace not found/,
    );
    // Bob naming his own workspace can't reach Alice's order.
    expect(await holdByRule(bob, tenantB, [{ id: orderA3, note: "x" }])).toBe(0);
    expect((await held(orderA3)).on_hold).toBe(false);
    expect(await holdByRule(carol, tenantA, [])).toBe(0);
  });
});

describe("packing memory", () => {
  const boxes = (weight: number) => [
    { box_id: null, length: 12, width: 9, height: 4, weight_tenth_oz: weight, items: { "y-r": 2 } },
  ];
  const learn = (tenant: string, key: string, body: object[], products = "y-r") =>
    service<{ id: string }>(
      "select public.learn_shipping_packing($1, $2, $3, '2 × Yarn (Red)', $4::jsonb) as id",
      [tenant, key, products, JSON.stringify(body)],
    ).then((rows) => rows[0].id);
  let packingA: string;

  it("remembers a packing per workspace and set of items, and counts each use", async () => {
    packingA = await learn(tenantA, "y-r×2", boxes(660));
    expect(await learn(tenantA, "y-r×2", boxes(700))).toBe(packingA);
    await learn(tenantB, "y-r×2", boxes(500));
    const { rows } = await db.query<{ tenant_id: string; uses: number; boxes: unknown }>(
      "select tenant_id, uses, boxes from public.shipping_packings order by uses desc",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ tenant_id: tenantA, uses: 2 });
    expect((rows[0].boxes as { weight_tenth_oz: number }[])[0].weight_tenth_oz).toBe(700);
    // Nothing about who it was sent to.
    const columns = await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'shipping_packings'",
    );
    expect(columns.rows.map((c) => c.column_name).join(" ")).not.toMatch(
      /address|city|postal|recipient|email|order_id/,
    );
  });

  it("members read their own workspace's and nobody else's", async () => {
    const mine = await as<{ tenant_id: string }>(carol, "select * from public.shipping_packings");
    expect(mine).toHaveLength(1);
    expect(mine[0].tenant_id).toBe(tenantA);
    const theirs = await as<{ tenant_id: string }>(bob, "select * from public.shipping_packings");
    expect(theirs).toHaveLength(1);
    expect(theirs[0].tenant_id).toBe(tenantB);
  });

  it("is written only by the server, through its function", async () => {
    await expect(
      as(alice, "update public.shipping_packings set uses = 99 where tenant_id = $1", [tenantA]),
    ).rejects.toThrow(/permission denied/);
    await expect(as(alice, "delete from public.shipping_packings")).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      as(
        alice,
        "insert into public.shipping_packings (tenant_id, item_key, boxes) values ($1, 'x', '[{}]'::jsonb)",
        [tenantA],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(alice, "select public.learn_shipping_packing($1, 'x×1', 'x', '', $2::jsonb)", [
        tenantA,
        JSON.stringify(boxes(100)),
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(learn(tenantA, "x×1", [])).rejects.toThrow(/Not a packing/);
    await expect(learn(tenantA, "x×1", [{ length: 0, width: 1, height: 1 }])).rejects.toThrow(
      /Not a packing/,
    );
    await expect(learn(tenantA, "", boxes(100))).rejects.toThrow(/Not a packing/);
  });

  it("can be forgotten by an owner or admin of that workspace only", async () => {
    await expect(
      as(carol, "select public.forget_shipping_packing($1)", [packingA]),
    ).rejects.toThrow(/Only owners and admins/);
    // To another workspace it simply isn't there.
    expect(
      (
        await as<{ ok: boolean }>(bob, "select public.forget_shipping_packing($1) as ok", [
          packingA,
        ])
      )[0].ok,
    ).toBe(false);
    expect(
      (
        await as<{ ok: boolean }>(alice, "select public.forget_shipping_packing($1) as ok", [
          packingA,
        ])
      )[0].ok,
    ).toBe(true);
    expect(await as(carol, "select 1 from public.shipping_packings")).toHaveLength(0);
    expect(await as(bob, "select 1 from public.shipping_packings")).toHaveLength(1);
  });
});

describe("what a person saved for an order", () => {
  const choice = {
    v: 1,
    boxes: [
      { box_id: null, length: 12, width: 9, height: 4, weight_tenth_oz: 660, items: { l1: 2 } },
    ],
    signature: "adult",
    service: "UPS Ground",
  };
  const plan = async (orderId: string) =>
    (
      await db.query<{
        saved_choice: typeof choice | null;
        saved_by: string | null;
        saved_at: string | null;
        chosen_box_id: string | null;
        plan_key: string | null;
        box_source: string;
        quote_by_rule: boolean;
      }>("select * from public.shipping_order_plans where shipping_order_id = $1", [orderId])
    ).rows[0];
  const save = (user: User, orderId: string, body: unknown) =>
    as(user, "select public.save_shipping_order_choice($1, $2::jsonb)", [
      orderId,
      body === null ? null : JSON.stringify(body),
    ]);

  it("is kept on the order's plan, in place of the one remembered box and its old price", async () => {
    await as(carol, "select public.set_shipping_order_box($1, $2)", [orderA3, boxA]);
    await service("select public.save_shipping_order_plan($1, $2, $3::jsonb, null)", [
      tenantA,
      orderA3,
      JSON.stringify({
        box_id: boxA,
        box_source: "learned-similar",
        weight_tenth_oz: 720,
        plan_key: "salt:hash",
        status: "ok",
        source: "ups",
        carrier: "UPS",
        service: "UPS Ground",
        cents: 943,
        currency: "usd",
        by_rule: true,
      }),
    ]);
    expect(await plan(orderA3)).toMatchObject({
      box_source: "learned-similar",
      quote_by_rule: true,
      plan_key: "salt:hash",
      chosen_box_id: boxA,
    });
    await save(carol, orderA3, choice);
    const row = await plan(orderA3);
    expect(row.saved_choice).toEqual(choice);
    expect(row.saved_by).toBe(carol.id);
    expect(row.saved_at).not.toBeNull();
    expect(row.chosen_box_id).toBeNull();
    expect(row.plan_key).toBeNull();
    // Members of the workspace read it; nobody else does.
    expect(
      await as(alice, "select 1 from public.shipping_order_plans where saved_choice is not null"),
    ).toHaveLength(1);
    expect(
      await as(bob, "select 1 from public.shipping_order_plans where saved_choice is not null"),
    ).toHaveLength(0);
  });

  it("Reset forgets it", async () => {
    await save(alice, orderA3, null);
    expect(await plan(orderA3)).toMatchObject({
      saved_choice: null,
      saved_by: null,
      saved_at: null,
    });
  });

  it("is only for a member's own order, and only something shaped like a choice", async () => {
    await expect(save(bob, orderA3, choice)).rejects.toThrow(/Order not found/);
    await expect(save(carol, orderB, choice)).rejects.toThrow(/Order not found/);
    await expect(save(carol, orderA3, [choice])).rejects.toThrow(/Not a saved choice/);
    await expect(save(carol, orderA3, { v: 1, boxes: [] })).rejects.toThrow(/Not a saved choice/);
    await expect(save(carol, orderA3, { v: 1 })).rejects.toThrow(/Not a saved choice/);
    await expect(
      as(carol, "update public.shipping_order_plans set saved_choice = '{}'::jsonb"),
    ).rejects.toThrow(/permission denied/);
    // A plan from the list that names a box source we don't know is filed as the usual box.
    await service("select public.save_shipping_order_plan($1, $2, $3::jsonb, null)", [
      tenantA,
      orderA3,
      JSON.stringify({ box_source: "guess", plan_key: "k", status: "none" }),
    ]);
    expect(await plan(orderA3)).toMatchObject({ box_source: "default", quote_by_rule: false });
  });
});

describe("a bulk run of labels", () => {
  type Entry = {
    order_id: string;
    name: string;
    status: string;
    reason?: string;
    service?: string;
    price?: string;
    currency?: string;
    shipment_number?: number;
  };
  type Batch = {
    id: string;
    tenant_id: string;
    number: number;
    created_by: string;
    finished_at: string | null;
    orders: Entry[];
    order_count: number;
    bought_count: number;
    total: string;
    currency: string | null;
  };
  const start = (user: User, tenant: string, ids: string[]) =>
    as<{ id: string }>(user, "select public.start_label_batch($1, $2::uuid[]) as id", [
      tenant,
      ids,
    ]).then((rows) => rows[0].id);
  const take = (user: User, batch: string, orderId: string) =>
    as<{ ok: boolean }>(user, "select public.claim_label_batch_order($1, $2) as ok", [
      batch,
      orderId,
    ]).then((rows) => rows[0].ok);
  const note = (user: User, batch: string, orderId: string, outcome: object) =>
    as<{ ok: boolean }>(user, "select public.note_label_batch_order($1, $2, $3::jsonb) as ok", [
      batch,
      orderId,
      JSON.stringify(outcome),
    ]).then((rows) => rows[0].ok);
  const batchRow = async (id: string) =>
    (await db.query<Batch>("select * from public.shipping_label_batches where id = $1", [id]))
      .rows[0];
  let run: string;

  it("is started by anyone on the team, for the workspace's own orders, 25 at most", async () => {
    run = await start(carol, tenantA, [orderA, orderA2, orderA, orderA3]);
    const row = await batchRow(run);
    expect(row).toMatchObject({
      tenant_id: tenantA,
      number: 1,
      created_by: carol.id,
      order_count: 3,
      bought_count: 0,
      finished_at: null,
    });
    // Each order once, in the order ticked, by its name and nothing about who it's for.
    expect(row.orders).toEqual([
      { order_id: orderA, name: "#7001", status: "waiting" },
      { order_id: orderA2, name: "#7002", status: "waiting" },
      { order_id: orderA3, name: "#7003", status: "waiting" },
    ]);
    expect(JSON.stringify(row)).not.toMatch(/Sam Shopper|Mill Lane|11201|example\.com/);
    await expect(start(carol, tenantA, [orderA, orderB])).rejects.toThrow(/Order not found/);
    await expect(start(bob, tenantA, [orderA])).rejects.toThrow(/Workspace not found/);
    await expect(start(carol, tenantA, [])).rejects.toThrow(/1 to 25/);
    const tooMany = Array.from(
      { length: 26 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    await expect(start(carol, tenantA, tooMany)).rejects.toThrow(/1 to 25/);
  });

  it("members read their own workspace's runs and nobody else's; only functions write", async () => {
    const other = await start(bob, tenantB, [orderB]);
    const mine = await as<Batch>(alice, "select * from public.shipping_label_batches");
    expect(mine.map((row) => row.id)).toEqual([run]);
    const theirs = await as<Batch>(bob, "select * from public.shipping_label_batches");
    expect(theirs.map((row) => row.id)).toEqual([other]);
    // Each workspace counts its own runs.
    expect(theirs[0].number).toBe(1);
    await expect(
      as(carol, "update public.shipping_label_batches set bought_count = 9"),
    ).rejects.toThrow(/permission denied/);
    await expect(as(carol, "delete from public.shipping_label_batches")).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      as(carol, "insert into public.shipping_label_batches (tenant_id, number) values ($1, 9)", [
        tenantA,
      ]),
    ).rejects.toThrow(/permission denied/);
    // Not another workspace's run, and not a teammate's either: a run is its starter's to work.
    await expect(take(bob, run, orderA)).rejects.toThrow(/Run not found/);
    await expect(take(alice, run, orderA)).rejects.toThrow(/Run not found/);
    await expect(note(bob, run, orderA, { status: "skipped", reason: "x" })).rejects.toThrow(
      /Run not found/,
    );
  });

  it("takes each order once, however many times it is asked", async () => {
    expect(await take(carol, run, orderA)).toBe(true);
    // A second press, a retry, another tab: no.
    expect(await take(carol, run, orderA)).toBe(false);
    expect(await take(carol, run, orderB)).toBe(false);
    expect((await batchRow(run)).orders[0].status).toBe("buying");
  });

  it("buys through the same claim as a single label, so an order is never bought twice", async () => {
    // The run's turn for #7001: a quote the server made, then the claim every purchase needs.
    await quote(tenantA, orderA, carol, "shp_run_1");
    const mine = await claim(carol, orderA);
    // While that purchase is under way, nothing else can start one for the order:
    // not the same person again, not a teammate with a quote of their own.
    await expect(claim(carol, orderA)).rejects.toThrow(/still being finished|not quoted/);
    await quote(tenantA, orderA, alice, "shp_other_1");
    await expect(claim(alice, orderA)).rejects.toThrow(/still being finished/);

    // Bought, written down, recorded.
    await service(
      "select public.mark_label_bought($1, $2, 'USPS', 'Ground Advantage', '9400100000000000000001', 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400100000000000000001', 'https://labels.example/a.png', 'test', 6.40)",
      [tenantA, mine.quote_id],
    );
    const [{ n }] = await as<{ n: number }>(
      carol,
      "select public.record_label_shipment($1, false, false) as n",
      [mine.quote_id],
    );
    expect(
      await note(carol, run, orderA, {
        status: "bought",
        service: "USPS Ground Advantage",
        price: "6.40",
        currency: "usd",
        shipment_number: n,
      }),
    ).toBe(true);
    // Its outcome is written once.
    expect(await note(carol, run, orderA, { status: "skipped", reason: "again" })).toBe(false);

    // A second run on the same order: the run's own turn is new, but the order has nothing
    // left to send, and the purchase is refused whatever was quoted.
    const again = await start(carol, tenantA, [orderA]);
    expect(await take(carol, again, orderA)).toBe(true);
    await quote(tenantA, orderA, carol, "shp_run_2");
    await expect(claim(carol, orderA)).rejects.toThrow(/Nothing left to send/);
    await note(carol, again, orderA, { status: "skipped", reason: "Everything has gone." });
    const { rows } = await db.query(
      "select 1 from public.shipments where shipping_order_id = $1 and voided_at is null",
      [orderA],
    );
    expect(rows).toHaveLength(1);
    const second = await batchRow(again);
    expect(second).toMatchObject({ number: 2, bought_count: 0, total: "0.00" });
    expect(second.finished_at).not.toBeNull();
  });

  it("writes down what became of each order, and finishes when all have had their turn", async () => {
    expect(await take(carol, run, orderA2)).toBe(true);
    await note(carol, run, orderA2, { status: "skipped", reason: "It's on hold." });
    expect((await batchRow(run)).finished_at).toBeNull();
    await expect(note(carol, run, orderA3, { status: "bought?" })).rejects.toThrow(
      /Not an outcome/,
    );
    // An order that never got its turn can still be noted (the run stopped): unsure.
    await note(carol, run, orderA3, {
      status: "unsure",
      reason: "We can't tell whether this label was bought.",
      price: "not a price",
    });
    const row = await batchRow(run);
    expect(row.orders).toEqual([
      {
        order_id: orderA,
        name: "#7001",
        status: "bought",
        service: "USPS Ground Advantage",
        price: "6.40",
        currency: "USD",
        shipment_number: 1,
      },
      { order_id: orderA2, name: "#7002", status: "skipped", reason: "It's on hold." },
      {
        order_id: orderA3,
        name: "#7003",
        status: "unsure",
        reason: "We can't tell whether this label was bought.",
      },
    ]);
    expect(row).toMatchObject({ bought_count: 1, total: "6.40", currency: "USD" });
    expect(row.finished_at).not.toBeNull();
  });
});
