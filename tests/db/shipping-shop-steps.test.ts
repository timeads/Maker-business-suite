import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Keeping the shop in step, in the database:
 *   - a voided parcel that the shop was told about is queued to be undone
 *     there, once, with the shop's own id for it (riders too);
 *   - pickup steps are queued for the shop when the workspace wants that and
 *     the shop allows it, each once;
 *   - a shop connected watch-only is never queued for anything;
 *   - a label for part of an order records exactly the quoted items, holds
 *     the rest, and can't be bought twice;
 *   - none of it reaches across workspaces.
 */
type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A, whose shop allows writes
let carol: User; // member of A
let bob: User; // owner of B, whose shop is connected watch-only
let tenantA: string;
let tenantB: string;

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

const connect = (tenant: string, owner: User, scopes: string[]) =>
  service(
    "select public.save_connection($1, 'shopify', $2, 'Shop', $3::text[], $4::jsonb, $5, '{}'::jsonb)",
    [
      tenant,
      `${tenant.slice(0, 8)}.myshopify.com`,
      scopes,
      JSON.stringify({ access_token: "fake-shop-token" }),
      owner.id,
    ],
  );

async function order(
  tenant: string,
  id: string,
  options: { pickup?: boolean; items?: unknown[] } = {},
): Promise<string> {
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
          processed_at: `2026-11-20T22:${id.slice(-2)}:00Z`,
          currency: "USD",
          net_sales: 100,
          total_shipping: 10,
          total: 110,
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
        address1: "1 Mill Lane",
        city: "Brooklyn",
        region: "NY",
        postal_code: "11201",
        country_code: "us",
        paid: true,
        shipping_paid: 10,
        pickup: options.pickup ?? false,
        items: options.items ?? [
          { line_id: "l1", title: "Tufting Cloth", variant: null, sku: "TC", qty: 2, left: 2 },
          { line_id: "l2", title: "Yarn", variant: "Red", sku: "Y-R", qty: 3, left: 3 },
        ],
      },
    ]),
  ]);
  const { rows } = await db.query<{ id: string }>(
    "select id from public.shipping_orders where tenant_id = $1 and external_id = $2",
    [tenant, id],
  );
  return rows[0].id;
}

/** Records a parcel for an order by hand and returns its row id. */
async function parcel(user: User, tenant: string, orderId: string, push: boolean, tracking = "T1") {
  const [{ n }] = await as<{ n: number }>(
    user,
    "select public.record_shipment($1, $2, 'USPS', 'Ground', $3, null, 5, '[]'::jsonb, '', $4, true) as n",
    [tenant, orderId, tracking, push],
  );
  const { rows } = await db.query<{ id: string }>(
    "select id from public.shipments where tenant_id = $1 and number = $2",
    [tenant, n],
  );
  return rows[0].id;
}
const shipment = async (id: string) =>
  (
    await db.query<{
      shop_status: string;
      shop_fulfilment_id: string | null;
      shop_undo_status: string;
      shop_undo_error: string | null;
      voided: boolean;
    }>(
      "select shop_status, shop_fulfilment_id, shop_undo_status, shop_undo_error, voided_at is not null as voided from public.shipments where id = $1",
      [id],
    )
  ).rows[0];
/** The worker's push: claim everything waiting, and say it went with these ids. */
async function push(ids: Record<string, string | null>) {
  const claimed = await service<{ id: string }>(
    "select id from public.claim_shipments_to_send(50)",
  );
  for (const row of claimed) {
    await service("select public.finish_shipment_send_with($1, null, $2)", [
      row.id,
      ids[row.id] ?? null,
    ]);
  }
  return claimed.map((row) => row.id);
}
type Undo = {
  id: string;
  tenant_id: string;
  order_external_id: string;
  fulfilment_id: string | null;
  tracking_numbers: string[];
  can_write: boolean;
};
const claimUndos = () => service<Undo>("select * from public.claim_shipment_undos(50)");

const RATE = "rate_0123456789abcdef";
const rates = JSON.stringify([
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
]);
const partQuote = (tenant: string, orderId: string, by: User, shipmentId: string, part: unknown) =>
  service<{ id: string }>(
    "select public.save_part_label_quote($1, $2, $3, 'easypost', $4, $5::jsonb, 'shipment', 1, null, $6::jsonb) as id",
    [tenant, orderId, by.id, shipmentId, rates, JSON.stringify(part)],
  ).then((rows) => rows[0].id);
const wholeQuote = (tenant: string, orderId: string, by: User, shipmentId: string) =>
  service<{ id: string }>(
    "select public.save_label_quote_from($1, $2, $3, 'easypost', $4, $5::jsonb, 'shipment', 1, '{}'::uuid[], null) as id",
    [tenant, orderId, by.id, shipmentId, rates],
  ).then((rows) => rows[0].id);
const claim = (user: User, orderId: string) =>
  as<{ c: { quote_id: string; part: unknown } }>(
    user,
    "select public.claim_label_purchase($1, $2) as c",
    [orderId, RATE],
  ).then((rows) => rows[0].c);
const bought = (tenant: string, quoteId: string, tracking: string) =>
  service(
    "select public.mark_label_bought($1, $2, 'USPS', 'Ground Advantage', $3, null, 'https://labels.example/a.png', 'test', 6.40)",
    [tenant, quoteId, tracking],
  );
const orderRow = async (id: string) =>
  (
    await db.query<{
      items: { line_id: string; left: number }[];
      units_left: number;
      on_hold: boolean;
      hold_reason: string;
      pickup_ready_at: string | null;
      picked_up_at: string | null;
      pickup_ready_shop_status: string;
      picked_up_shop_status: string;
      pickup_ready_shop_error: string | null;
    }>(
      "select items, units_left, on_hold, hold_reason, pickup_ready_at, picked_up_at, pickup_ready_shop_status, picked_up_shop_status, pickup_ready_shop_error from public.shipping_orders where id = $1",
      [id],
    )
  ).rows[0];

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
  await connect(tenantA, alice, ["read_orders", "write_merchant_managed_fulfillment_orders"]);
  // Watch only: every scope is a read.
  await connect(tenantB, bob, ["read_orders", "read_merchant_managed_fulfillment_orders"]);
});

describe("a voided parcel reaches the shop", () => {
  it("keeps the shop's id when a parcel is pushed, and queues the undo when it is voided", async () => {
    const orderId = await order(tenantA, "7001");
    const id = await parcel(carol, tenantA, orderId, true, "9400A");
    expect(await push({ [id]: "gid://shopify/Fulfillment/77" })).toEqual([id]);
    expect(await shipment(id)).toMatchObject({
      shop_status: "sent",
      shop_fulfilment_id: "gid://shopify/Fulfillment/77",
      shop_undo_status: "none",
    });
    // Nothing to undo while the parcel stands.
    expect(await claimUndos()).toEqual([]);

    expect(
      (await as<{ s: string }>(alice, "select public.void_shipment($1) as s", [id]))[0].s,
    ).toBe("sent");
    expect(await shipment(id)).toMatchObject({ voided: true, shop_undo_status: "pending" });
    expect((await orderRow(orderId)).units_left).toBe(5);

    const undos = await claimUndos();
    expect(undos).toHaveLength(1);
    expect(undos[0]).toMatchObject({
      id,
      tenant_id: tenantA,
      order_external_id: "7001",
      fulfilment_id: "gid://shopify/Fulfillment/77",
      tracking_numbers: ["9400A"],
      can_write: true,
    });
    // Once only: a second worker, or the next pass, gets nothing.
    expect(await claimUndos()).toEqual([]);
    await service("select public.finish_shipment_undo($1, 'done', null)", [id]);
    expect(await shipment(id)).toMatchObject({ shop_undo_status: "done", shop_undo_error: null });
    // Finished is finished: nothing is claimed again, and a late answer changes nothing.
    await service("select public.finish_shipment_undo($1, 'failed', 'late')", [id]);
    expect((await shipment(id)).shop_undo_status).toBe("done");
    expect(await claimUndos()).toEqual([]);
  });

  it("writes down a failure, or that the shop had nothing to cancel, and never tries again", async () => {
    const orderId = await order(tenantA, "7002");
    const first = await parcel(carol, tenantA, orderId, true, "9400B");
    // Pushed before ids were kept: no fulfilment id, so the tracking number is what finds it.
    await push({});
    await as(alice, "select public.void_shipment($1)", [first]);
    const [undo] = await claimUndos();
    expect(undo).toMatchObject({ id: first, fulfilment_id: null, tracking_numbers: ["9400B"] });
    await service("select public.finish_shipment_undo($1, 'not_found', null)", [first]);
    expect((await shipment(first)).shop_undo_status).toBe("not_found");

    const second = await parcel(carol, tenantA, orderId, true, "9400C");
    await push({ [second]: "f2" });
    await as(alice, "select public.void_shipment($1)", [second]);
    await claimUndos();
    await service("select public.finish_shipment_undo($1, 'failed', $2)", [
      second,
      "Fulfillment is already cancelled",
    ]);
    expect(await shipment(second)).toMatchObject({
      shop_undo_status: "failed",
      shop_undo_error: "Fulfillment is already cancelled",
    });
    expect(await claimUndos()).toEqual([]);
    await expect(
      service("select public.finish_shipment_undo($1, 'whatever', null)", [second]),
    ).rejects.toThrow(/Unknown outcome/);
  });

  it("marks a claim that was never finished as failed rather than trying it again", async () => {
    const orderId = await order(tenantA, "7003");
    const id = await parcel(carol, tenantA, orderId, true, "9400D");
    await push({ [id]: "f3" });
    await as(alice, "select public.void_shipment($1)", [id]);
    expect(await claimUndos()).toHaveLength(1);
    await db.query(
      "update public.shipments set shop_undo_at = now() - interval '20 minutes' where id = $1",
      [id],
    );
    expect(await claimUndos()).toEqual([]);
    expect(await shipment(id)).toMatchObject({ shop_undo_status: "failed" });
    expect((await shipment(id)).shop_undo_error).toMatch(/lost touch/);
  });

  it("leaves a parcel the shop never heard about alone", async () => {
    const orderId = await order(tenantA, "7004");
    const quiet = await parcel(carol, tenantA, orderId, false, "9400E");
    await as(alice, "select public.void_shipment($1)", [quiet]);
    expect(await shipment(quiet)).toMatchObject({
      shop_status: "skipped",
      shop_undo_status: "none",
    });
    // Still waiting to be pushed when it was undone: the push is dropped, nothing to undo.
    const waiting = await parcel(carol, tenantA, orderId, true, "9400F");
    await as(alice, "select public.void_shipment($1)", [waiting]);
    expect(await shipment(waiting)).toMatchObject({
      shop_status: "skipped",
      shop_undo_status: "none",
    });
    expect(await push({})).toEqual([]);
    expect(await claimUndos()).toEqual([]);
  });

  it("catches a parcel that was undone while the shop was being told", async () => {
    const orderId = await order(tenantA, "7005");
    const id = await parcel(carol, tenantA, orderId, true, "9400G");
    const claimed = await service<{ id: string }>(
      "select id from public.claim_shipments_to_send(50)",
    );
    expect(claimed.map((row) => row.id)).toEqual([id]);
    await as(alice, "select public.void_shipment($1)", [id]);
    expect(await shipment(id)).toMatchObject({ shop_status: "skipped", shop_undo_status: "none" });
    // The shop did take it: so it has to be undone there.
    await service("select public.finish_shipment_send_with($1, null, 'f5')", [id]);
    expect(await shipment(id)).toMatchObject({
      shop_status: "sent",
      shop_fulfilment_id: "f5",
      shop_undo_status: "pending",
    });
    // Had the push failed instead, there would be nothing to undo.
    const other = await parcel(carol, tenantA, orderId, true, "9400H");
    await service("select id from public.claim_shipments_to_send(50)");
    await as(alice, "select public.void_shipment($1)", [other]);
    await service("select public.finish_shipment_send_with($1, 'The shop said no', null)", [other]);
    expect(await shipment(other)).toMatchObject({
      shop_status: "skipped",
      shop_undo_status: "none",
    });
    await claimUndos().then((rows) =>
      Promise.all(
        rows.map((row) =>
          service("select public.finish_shipment_undo($1, 'done', null)", [row.id]),
        ),
      ),
    );
  });

  it("undoes every order of a parcel that carried several, each with the parcel's tracking", async () => {
    const lead = await order(tenantA, "7010");
    const rider = await order(tenantA, "7011");
    const [{ id: quoteId }] = await service<{ id: string }>(
      "select public.save_label_quote_from($1, $2, $3, 'easypost', 'shp_together_1', $4::jsonb, 'shipment', 1, $5::uuid[], null) as id",
      [tenantA, lead, carol.id, rates, [rider]],
    );
    await as(carol, "select public.claim_group_label_purchase($1, $2::uuid[], $3)", [
      lead,
      [rider],
      RATE,
    ]);
    await service(
      "select public.mark_label_bought($1, $2, 'USPS', 'Ground Advantage', '9400T', null, 'https://labels.example/t.png', 'test', 6.40, $3::jsonb)",
      [
        tenantA,
        quoteId,
        JSON.stringify([
          {
            shipment_id: "shp_together_1",
            tracking_number: "9400T",
            tracking_url: null,
            label_url: "https://labels.example/t.png",
          },
        ]),
      ],
    );
    await as(carol, "select public.record_label_shipment($1, true, true)", [quoteId]);
    const { rows } = await db.query<{ id: string; merged_with: string | null }>(
      "select id, merged_with from public.shipments where shipping_order_id = any ($1::uuid[]) and voided_at is null order by number",
      [[lead, rider]],
    );
    const [leadParcel, riderParcel] = rows;
    expect(riderParcel.merged_with).toBe(leadParcel.id);
    await push({ [leadParcel.id]: "f-lead", [riderParcel.id]: "f-rider" });

    await as(alice, "select public.void_label_shipment($1)", [leadParcel.id]);
    const undos = await claimUndos();
    expect(
      undos.map((row) => [row.order_external_id, row.fulfilment_id, row.tracking_numbers]),
    ).toEqual(
      expect.arrayContaining([
        ["7010", "f-lead", ["9400T"]],
        ["7011", "f-rider", ["9400T"]],
      ]),
    );
    expect(undos).toHaveLength(2);
    for (const row of undos) {
      await service("select public.finish_shipment_undo($1, 'done', null)", [row.id]);
    }
  });

  it("never queues anything for a shop connected watch-only", async () => {
    const orderId = await order(tenantB, "8001");
    // Marked as sent while the shop still allowed it.
    await connect(tenantB, bob, ["read_orders", "write_merchant_managed_fulfillment_orders"]);
    const id = await parcel(bob, tenantB, orderId, true, "9400W");
    await push({ [id]: "f-b" });
    await connect(tenantB, bob, ["read_orders", "read_merchant_managed_fulfillment_orders"]);
    await as(bob, "select public.void_shipment($1)", [id]);
    expect(await shipment(id)).toMatchObject({ voided: true, shop_undo_status: "not_allowed" });
    expect(await claimUndos()).toEqual([]);
  });

  it("is each workspace's own, and the queue is the worker's alone", async () => {
    const orderId = await order(tenantA, "7020");
    const id = await parcel(carol, tenantA, orderId, true, "9400X");
    await push({ [id]: "f-x" });
    // Another workspace's owner can neither see it nor undo it.
    expect(await as(bob, "select id from public.shipments where id = $1", [id])).toEqual([]);
    await expect(as(bob, "select public.void_shipment($1)", [id])).rejects.toThrow(
      /Shipment not found/,
    );
    // A member who isn't an owner or admin can't undo it either.
    await expect(as(carol, "select public.void_shipment($1)", [id])).rejects.toThrow();
    expect((await shipment(id)).voided).toBe(false);
    for (const sql of [
      "select * from public.claim_shipment_undos(5)",
      `select public.finish_shipment_undo('${id}', 'done', null)`,
      `select public.finish_shipment_send_with('${id}', null, 'x')`,
      "select * from public.claim_pickup_steps(5)",
      `select public.finish_pickup_step('${id}', 'ready', 'sent', null)`,
    ]) {
      await expect(as(alice, sql)).rejects.toThrow(/permission denied/);
    }
  });
});

describe("pickups reach the shop", () => {
  type Step = {
    id: string;
    tenant_id: string;
    order_external_id: string;
    step: string;
    can_write: boolean;
  };
  const claimSteps = () => service<Step>("select * from public.claim_pickup_steps(50)");
  const setting = (user: User, tenant: string, on: boolean) =>
    as(user, "select public.save_config($1, 'shipping', 'settings', $2::jsonb)", [
      tenant,
      JSON.stringify({ version: 1, tell_shop_pickups: on }),
    ]);

  it("queues 'ready' and then 'picked up', each once", async () => {
    const id = await order(tenantA, "7101", { pickup: true });
    expect(
      (
        await as<{ n: number }>(carol, "select public.mark_pickup_ready($1, $2::uuid[]) as n", [
          tenantA,
          [id],
        ])
      )[0].n,
    ).toBe(1);
    expect((await orderRow(id)).pickup_ready_shop_status).toBe("pending");
    const steps = await claimSteps();
    expect(steps).toEqual([
      expect.objectContaining({
        id,
        tenant_id: tenantA,
        order_external_id: "7101",
        step: "ready",
        can_write: true,
      }),
    ]);
    expect(await claimSteps()).toEqual([]);
    // Collected while "ready" is still on its way: "picked up" waits its turn.
    await as(carol, "select public.mark_picked_up($1)", [id]);
    expect(await orderRow(id)).toMatchObject({
      pickup_ready_shop_status: "sending",
      picked_up_shop_status: "pending",
    });
    expect(await claimSteps()).toEqual([]);
    await service("select public.finish_pickup_step($1, 'ready', 'sent', null)", [id]);
    expect((await claimSteps()).map((row) => row.step)).toEqual(["picked_up"]);
    await service("select public.finish_pickup_step($1, 'picked_up', 'sent', null)", [id]);
    expect(await orderRow(id)).toMatchObject({
      pickup_ready_shop_status: "sent",
      picked_up_shop_status: "sent",
    });
    expect(await claimSteps()).toEqual([]);
  });

  it("drops a 'come and collect' that hasn't gone yet when the order is handed over", async () => {
    const id = await order(tenantA, "7102", { pickup: true });
    await as(carol, "select public.mark_pickup_ready($1, $2::uuid[])", [tenantA, [id]]);
    await as(carol, "select public.mark_picked_up($1)", [id]);
    expect(await orderRow(id)).toMatchObject({
      pickup_ready_shop_status: "none",
      picked_up_shop_status: "pending",
    });
    expect((await claimSteps()).map((row) => row.step)).toEqual(["picked_up"]);
    await service("select public.finish_pickup_step($1, 'picked_up', 'failed', $2)", [
      id,
      "Order is on hold",
    ]);
    expect((await orderRow(id)).picked_up_shop_status).toBe("failed");
    // A failure is written down, not tried again.
    expect(await claimSteps()).toEqual([]);
  });

  it("never tells the shop the same step twice, and drops an untold step when it is undone", async () => {
    const id = await order(tenantA, "7103", { pickup: true });
    await as(carol, "select public.mark_pickup_ready($1, $2::uuid[])", [tenantA, [id]]);
    // Undone before the worker got to it: the shop never hears.
    await as(alice, "select public.undo_pickup($1)", [id]);
    expect(await orderRow(id)).toMatchObject({
      pickup_ready_at: null,
      pickup_ready_shop_status: "none",
    });
    expect(await claimSteps()).toEqual([]);
    // Told, undone, marked again: the customer was emailed once and stays emailed once.
    await as(carol, "select public.mark_pickup_ready($1, $2::uuid[])", [tenantA, [id]]);
    await claimSteps();
    await service("select public.finish_pickup_step($1, 'ready', 'sent', null)", [id]);
    await as(alice, "select public.undo_pickup($1)", [id]);
    expect((await orderRow(id)).pickup_ready_shop_status).toBe("sent");
    await as(carol, "select public.mark_pickup_ready($1, $2::uuid[])", [tenantA, [id]]);
    expect((await orderRow(id)).pickup_ready_shop_status).toBe("sent");
    expect(await claimSteps()).toEqual([]);
  });

  it("fails a step that was claimed and never finished, rather than emailing twice", async () => {
    const id = await order(tenantA, "7104", { pickup: true });
    await as(carol, "select public.mark_pickup_ready($1, $2::uuid[])", [tenantA, [id]]);
    expect(await claimSteps()).toHaveLength(1);
    await db.query(
      "update public.shipping_orders set pickup_shop_synced_at = now() - interval '20 minutes' where id = $1",
      [id],
    );
    expect(await claimSteps()).toEqual([]);
    const row = await orderRow(id);
    expect(row.pickup_ready_shop_status).toBe("failed");
    expect(row.pickup_ready_shop_error).toMatch(/lost touch/);
  });

  it("keeps pickups to itself when the workspace switched the setting off", async () => {
    await setting(alice, tenantA, false);
    const id = await order(tenantA, "7105", { pickup: true });
    await as(carol, "select public.mark_pickup_ready($1, $2::uuid[])", [tenantA, [id]]);
    await as(carol, "select public.mark_picked_up($1)", [id]);
    expect(await orderRow(id)).toMatchObject({
      pickup_ready_shop_status: "none",
      picked_up_shop_status: "none",
    });
    expect((await orderRow(id)).picked_up_at).not.toBeNull();
    expect(await claimSteps()).toEqual([]);
    await setting(alice, tenantA, true);
  });

  it("keeps the suite's own record for a watch-only shop, and says the shop wasn't told", async () => {
    const id = await order(tenantB, "8101", { pickup: true });
    await as(bob, "select public.mark_pickup_ready($1, $2::uuid[])", [tenantB, [id]]);
    expect(await orderRow(id)).toMatchObject({ pickup_ready_shop_status: "not_allowed" });
    expect((await orderRow(id)).pickup_ready_at).not.toBeNull();
    await as(bob, "select public.mark_picked_up($1)", [id]);
    expect(await orderRow(id)).toMatchObject({ picked_up_shop_status: "not_allowed" });
    expect((await orderRow(id)).picked_up_at).not.toBeNull();
    // Nothing for the worker: the shop is never written to.
    expect(await claimSteps()).toEqual([]);
  });

  it("is each workspace's own", async () => {
    const id = await order(tenantA, "7106", { pickup: true });
    await expect(
      as(bob, "select public.mark_pickup_ready($1, $2::uuid[])", [tenantA, [id]]),
    ).rejects.toThrow(/Workspace not found/);
    // Naming his own workspace gets him nowhere with someone else's order.
    expect(
      (
        await as<{ n: number }>(bob, "select public.mark_pickup_ready($1, $2::uuid[]) as n", [
          tenantB,
          [id],
        ])
      )[0].n,
    ).toBe(0);
    await expect(as(bob, "select public.mark_picked_up($1)", [id])).rejects.toThrow(
      /Order not found/,
    );
    expect(await orderRow(id)).toMatchObject({
      pickup_ready_at: null,
      pickup_ready_shop_status: "none",
    });
    expect(
      await as(bob, "select pickup_ready_shop_status from public.shipping_orders where id = $1", [
        id,
      ]),
    ).toEqual([]);
  });
});

describe("a label for part of an order", () => {
  it("records exactly the quoted items, tells the shop about just those, and holds the rest", async () => {
    const orderId = await order(tenantA, "7201");
    const quoteId = await partQuote(tenantA, orderId, carol, "shp_part_1", [
      { line_id: "l1", qty: 1 },
      { line_id: "l2", qty: 3 },
    ]);
    const claimed = await claim(carol, orderId);
    expect(claimed.quote_id).toBe(quoteId);
    // The server is told which items the price was for.
    expect(claimed.part).toEqual([
      { line_id: "l1", qty: 1 },
      { line_id: "l2", qty: 3 },
    ]);
    await bought(tenantA, quoteId, "9400P1");
    const [{ n }] = await as<{ n: number }>(
      carol,
      "select public.record_label_shipment($1, true, true) as n",
      [quoteId],
    );
    const { rows } = await db.query<{
      items: { line_id: string; qty: number }[];
      shop_status: string;
    }>("select items, shop_status from public.shipments where tenant_id = $1 and number = $2", [
      tenantA,
      n,
    ]);
    expect(rows[0].items.map((item) => [item.line_id, item.qty])).toEqual([
      ["l1", 1],
      ["l2", 3],
    ]);
    // What the shop is told is this parcel's own lines.
    const pushed = await service<{ items: { line_id: string; qty: number }[] }>(
      "select items from public.claim_shipments_to_send(50)",
    );
    expect(pushed[0].items.map((item) => [item.line_id, item.qty])).toEqual([
      ["l1", 1],
      ["l2", 3],
    ]);
    const after = await orderRow(orderId);
    expect(after.units_left).toBe(1);
    expect(after.items.map((item) => item.left)).toEqual([1, 0]);
    expect(after.on_hold).toBe(true);
    expect(after.hold_reason).toBe("Part sent — waiting on: 1 × Tufting Cloth");
  });

  it("can't be bought twice, and the rest is bought as an ordinary label later", async () => {
    const orderId = await order(tenantA, "7202");
    const quoteId = await partQuote(tenantA, orderId, carol, "shp_part_2", [
      { line_id: "l2", qty: 2 },
    ]);
    await claim(carol, orderId);
    // A second press, another tab or another person: refused while the first is being finished.
    await expect(claim(alice, orderId)).rejects.toThrow(/still being finished/);
    await partQuote(tenantA, orderId, alice, "shp_part_2b", [{ line_id: "l2", qty: 2 }]);
    await expect(claim(alice, orderId)).rejects.toThrow(/still being finished/);
    await bought(tenantA, quoteId, "9400P2");
    await as(carol, "select public.record_label_shipment($1, false, false)", [quoteId]);
    // Recorded once: the same label can't be recorded again.
    await expect(
      as(carol, "select public.record_label_shipment($1, false, false)", [quoteId]),
    ).rejects.toThrow(/Label not found/);
    // And not bought again straight away either.
    await expect(claim(alice, orderId)).rejects.toThrow(/moments ago/);
    expect((await orderRow(orderId)).units_left).toBe(3);

    // Later, the rest: a whole-order quote records everything left.
    await db.query(
      "update public.shipments set shipped_at = now() - interval '5 minutes' where shipping_order_id = $1",
      [orderId],
    );
    const rest = await wholeQuote(tenantA, orderId, carol, "shp_part_2c");
    expect((await claim(carol, orderId)).part).toBeNull();
    await bought(tenantA, rest, "9400P3");
    await as(carol, "select public.record_label_shipment($1, false, false)", [rest]);
    expect(await orderRow(orderId)).toMatchObject({ units_left: 0, on_hold: false });
  });

  it("leaves the rest in the queue when the person asked for that", async () => {
    const orderId = await order(tenantA, "7203");
    const quoteId = await partQuote(tenantA, orderId, carol, "shp_part_3", [
      { line_id: "l1", qty: 2 },
    ]);
    await claim(carol, orderId);
    await as(carol, "select public.set_label_quote_hold_rest($1, false)", [quoteId]);
    await bought(tenantA, quoteId, "9400P4");
    await as(carol, "select public.record_label_shipment($1, false, false)", [quoteId]);
    expect(await orderRow(orderId)).toMatchObject({
      units_left: 3,
      on_hold: false,
      hold_reason: "",
    });
  });

  it("never records more than the quote says, whatever is said afterwards", async () => {
    const orderId = await order(tenantA, "7204");
    const quoteId = await partQuote(tenantA, orderId, carol, "shp_part_4", [
      { line_id: "l2", qty: 1 },
    ]);
    await claim(carol, orderId);
    // The only thing a member can change on the quote is the hold; the items are the server's.
    await expect(
      as(carol, "update public.shipping_label_quotes set part_items = '[]'::jsonb where id = $1", [
        quoteId,
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(
        carol,
        "select public.save_part_label_quote($1, $2, $3, 'easypost', 'x', '[]'::jsonb, 'shipment', 1, null, '[]'::jsonb)",
        [tenantA, orderId, carol.id],
      ),
    ).rejects.toThrow(/permission denied/);
    await bought(tenantA, quoteId, "9400P5");
    await as(carol, "select public.record_label_shipment($1, false, false)", [quoteId]);
    const after = await orderRow(orderId);
    expect(after.items.map((item) => item.left)).toEqual([2, 2]);
    expect(after.hold_reason).toBe("Part sent — waiting on: 2 × Tufting Cloth, 2 × Yarn (Red)");
  });

  it("refuses a part the order doesn't have left, and treats 'everything left' as the whole order", async () => {
    const orderId = await order(tenantA, "7205");
    await expect(
      partQuote(tenantA, orderId, carol, "shp_part_5", [{ line_id: "l2", qty: 4 }]),
    ).rejects.toThrow(/not left to send/);
    await expect(
      partQuote(tenantA, orderId, carol, "shp_part_5", [{ line_id: "nope", qty: 1 }]),
    ).rejects.toThrow(/not left to send/);
    await expect(
      partQuote(tenantA, orderId, carol, "shp_part_5", [{ line_id: "l2", qty: 0 }]),
    ).rejects.toThrow(/at least one item/);
    await expect(
      partQuote(tenantA, orderId, carol, "shp_part_5", [{ line_id: "l2", qty: "lots" }]),
    ).rejects.toThrow(/not a list/);
    const all = await partQuote(tenantA, orderId, carol, "shp_part_5", [
      { line_id: "l1", qty: 2 },
      { line_id: "l2", qty: 3 },
    ]);
    const { rows } = await db.query<{ part_items: unknown }>(
      "select part_items from public.shipping_label_quotes where id = $1",
      [all],
    );
    expect(rows[0].part_items).toBeNull();
  });

  it("forgets the part when rates are asked again for the whole order", async () => {
    const orderId = await order(tenantA, "7206");
    const first = await partQuote(tenantA, orderId, carol, "shp_part_6", [
      { line_id: "l1", qty: 1 },
    ]);
    await as(carol, "select public.set_label_quote_hold_rest($1, false)", [first]);
    // The same person asks again, this time for everything: the open quote is replaced.
    const again = await wholeQuote(tenantA, orderId, carol, "shp_part_6b");
    expect(again).toBe(first);
    const { rows } = await db.query<{ part_items: unknown; hold_rest: boolean }>(
      "select part_items, hold_rest from public.shipping_label_quotes where id = $1",
      [again],
    );
    expect(rows[0]).toEqual({ part_items: null, hold_rest: true });
  });

  it("is each workspace's own", async () => {
    const orderId = await order(tenantA, "7207");
    const quoteId = await partQuote(tenantA, orderId, carol, "shp_part_7", [
      { line_id: "l1", qty: 1 },
    ]);
    // Another workspace can't quote for it, see it, change its hold, claim it or record it.
    await expect(
      partQuote(tenantB, orderId, bob, "shp_part_7b", [{ line_id: "l1", qty: 1 }]),
    ).rejects.toThrow(/Order not found/);
    expect(
      await as(bob, "select id from public.shipping_label_quotes where id = $1", [quoteId]),
    ).toEqual([]);
    await as(bob, "select public.set_label_quote_hold_rest($1, false)", [quoteId]);
    const { rows } = await db.query<{ hold_rest: boolean }>(
      "select hold_rest from public.shipping_label_quotes where id = $1",
      [quoteId],
    );
    expect(rows[0].hold_rest).toBe(true);
    await expect(claim(bob, orderId)).rejects.toThrow(/Order not found/);
    await claim(carol, orderId);
    await bought(tenantA, quoteId, "9400P7");
    await expect(
      as(bob, "select public.record_label_shipment($1, false, false)", [quoteId]),
    ).rejects.toThrow(/Label not found/);
  });
});
