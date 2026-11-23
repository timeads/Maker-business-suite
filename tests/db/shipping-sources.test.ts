import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Labels from more than one place: UPS and Redo as connections, quotes whose
 * rates each name their source, the purchase claimed for the source that
 * quoted it, a bought label kept with its own file, and that file staying
 * inside its workspace.
 */
type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let bob: User; // owner of B
let carol: User; // plain member of A
let tenantA: string;
let tenantB: string;
let orderA: string;
let orderB: string;

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

async function shopOrder(tenant: string, id: string, email: string, customer: string) {
  await service(
    "select public.upsert_commerce_batch($1, 'shopify', $2::jsonb, '[]'::jsonb, $3::jsonb)",
    [
      tenant,
      JSON.stringify([{ external_id: customer, email, first_name: "Sam", last_name: "Shopper" }]),
      JSON.stringify([
        {
          external_id: id,
          name: `#${id}`,
          customer_external_id: customer,
          email,
          processed_at: "2026-11-18T15:00:00Z",
          currency: "USD",
          net_sales: 120,
          total: 130,
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
        address1: "12 Mill Lane",
        city: "Hudson",
        region: "NY",
        postal_code: "12534",
        country_code: "us",
        phone: "555-0100",
        paid: true,
        items: [{ line_id: "l1", title: "Wool rug", variant: null, sku: null, qty: 1, left: 1 }],
      },
    ]),
  ]);
  return (
    await db.query<{ id: string }>(
      "select id from public.shipping_orders where tenant_id = $1 and external_id = $2",
      [tenant, id],
    )
  ).rows[0].id;
}

// One merged list, as the server stores it: each rate with its source and that source's own ids.
const RATES = [
  {
    id: "rate_ep_ground",
    carrier: "USPS",
    carrierCode: "USPS",
    service: "GroundAdvantage",
    name: "USPS Ground Advantage",
    price: "6.40",
    currency: "USD",
    days: 4,
    source: "easypost",
    ref: { shipment_id: "shp_ep_1", kind: "shipment" },
  },
  {
    id: "upsrate_0123456789abcdef",
    carrier: "UPS",
    carrierCode: "UPS",
    service: "03",
    name: "UPS Ground",
    price: "9.80",
    currency: "USD",
    days: 3,
    source: "ups",
    ref: { service_code: "03" },
    others: [{ source: "redo", price: "10.10" }],
  },
  {
    id: "redorate_0123456789abcdef",
    carrier: "FedEx",
    carrierCode: "FedEx",
    service: "FEDEX_GROUND",
    name: "FedEx Ground",
    price: "11.25",
    currency: "USD",
    days: 3,
    source: "redo",
    ref: { mode: "1", account: "ca_1" },
  },
];
// Not a real fingerprint of anything: a salt and a hash, the shape the server stores.
const HASH = `${"ab".repeat(16)}:${"cd".repeat(32)}`;

const quote = (
  tenant: string,
  order: string,
  by: User,
  opts: {
    provider?: string;
    shipment?: string;
    rates?: object[];
    kind?: string;
    boxes?: number;
    riders?: string[];
  } = {},
) =>
  service<{ id: string }>(
    "select public.save_label_quote_from($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::uuid[], $10) as id",
    [
      tenant,
      order,
      by.id,
      opts.provider ?? "easypost",
      opts.shipment ?? "shp_ep_1",
      JSON.stringify(opts.rates ?? RATES),
      opts.kind ?? "shipment",
      opts.boxes ?? 1,
      opts.riders ?? [],
      HASH,
    ],
  ).then((rows) => rows[0].id);

type Claim = {
  quote_id: string;
  provider: string;
  provider_shipment_id: string;
  kind: string;
  boxes: number;
  request_hash: string | null;
  rate: { id: string; source?: string; ref?: Record<string, string> };
  riders?: string[];
};
const claim = (user: User, order: string, rate: string) =>
  as<{ c: Claim }>(user, "select public.claim_label_purchase($1, $2) as c", [order, rate]).then(
    (rows) => rows[0].c,
  );
const release = (tenant: string, id: string) =>
  service("select public.release_label_purchase($1, $2)", [tenant, id]);
const quoteRow = async (id: string) =>
  (
    await db.query<{
      status: string;
      provider: string;
      provider_shipment_id: string;
      request_hash: string | null;
      tracking_number: string | null;
      label_url: string | null;
      price: string | null;
      parcels: Record<string, unknown>[] | null;
    }>("select * from public.shipping_label_quotes where id = $1", [id])
  ).rows[0];

// A tiny picture's worth of base64; not a real label.
const GIF = "R0lGODlhAQABAAAAACw=";
const keep = (
  tenant: string,
  quoteId: string,
  shipment: string,
  parcels: object[],
  files: object[],
) =>
  service<{ ok: boolean }>(
    "select public.mark_label_bought_from($1, $2, $3, 'UPS', 'Ground', 'live', 9.80, $4::jsonb, $5::jsonb) as ok",
    [tenant, quoteId, shipment, JSON.stringify(parcels), JSON.stringify(files)],
  ).then((rows) => rows[0].ok);

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  carol = { id: await createUser(db, "carol@a.test"), email: "carol@a.test" };
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
  orderA = await shopOrder(tenantA, "7001", "lee@example.com", "c70");
  orderB = await shopOrder(tenantB, "8001", "ash@example.com", "c80");
});

describe("UPS and Redo as connections", () => {
  it("can be saved like any other, with every key in Vault and none on the row", async () => {
    await service(
      "select public.save_connection($1, 'ups', 'ups-a', 'UPS', '{}', $2::jsonb, $3, $4::jsonb)",
      [
        tenantA,
        JSON.stringify({
          access_token: "fake-ups-token",
          expires_at: 1,
          secrets: {
            client_id: "fake-client-id",
            client_secret: "fake-client-secret",
            account: "A1B2C3",
            env: "test",
          },
        }),
        alice.id,
        JSON.stringify({ mode: "test" }),
      ],
    );
    await service(
      "select public.save_connection($1, 'redo', 'redo-a', 'Redo', '{}', $2::jsonb, $3, '{}'::jsonb)",
      [
        tenantA,
        JSON.stringify({ access_token: "fake-redo-token", secrets: { store_id: "store0000fake" } }),
        alice.id,
      ],
    );
    const seen = await as<Record<string, unknown>>(
      carol,
      "select provider, status, display_name, metadata from public.connections where provider in ('ups', 'redo') order by provider",
    );
    expect(seen).toEqual([
      { provider: "redo", status: "active", display_name: "Redo", metadata: {} },
      { provider: "ups", status: "active", display_name: "UPS", metadata: { mode: "test" } },
    ]);
    const everything = await db.query("select * from public.connections where tenant_id = $1", [
      tenantA,
    ]);
    expect(JSON.stringify(everything.rows)).not.toMatch(/fake-|A1B2C3|store0000fake/);
    // Another workspace sees neither.
    expect(
      await as(bob, "select id from public.connections where provider in ('ups', 'redo')"),
    ).toEqual([]);
    // The server reads the whole secret back through the one function; a member can't call it.
    const token = await service<{ token: { secrets: Record<string, string> } }>(
      "select token from public.get_provider_token($1, 'ups')",
      [tenantA],
    );
    expect(token[0].token.secrets).toEqual({
      client_id: "fake-client-id",
      client_secret: "fake-client-secret",
      account: "A1B2C3",
      env: "test",
    });
    for (const provider of ["ups", "redo"]) {
      await expect(
        as(alice, "select * from public.get_provider_token($1, $2)", [tenantA, provider]),
      ).rejects.toThrow(/permission denied/);
    }
    await expect(
      service("select public.save_connection($1, 'fedex', 'x', 'x', '{}', '{}'::jsonb, $2)", [
        tenantA,
        alice.id,
      ]),
    ).rejects.toThrow(/connections_provider_check/);
  });
});

describe("one list of rates from several sources", () => {
  it("only the server stores it; each rate keeps its source and that source's own ids", async () => {
    const id = await quote(tenantA, orderA, carol);
    const row = await quoteRow(id);
    expect(row).toMatchObject({
      status: "quoted",
      provider: "easypost",
      provider_shipment_id: "shp_ep_1",
      request_hash: HASH,
    });
    // Prices and ids. No name, no street.
    expect(JSON.stringify(row)).not.toMatch(/Sam Shopper|Mill Lane|12534|555-0100/);
    await expect(
      as(
        alice,
        "select public.save_label_quote_from($1, $2, $3, 'ups', 'quote_x', '[]'::jsonb, 'shipment', 1, '{}'::uuid[], null)",
        [tenantA, orderA, alice.id],
      ),
    ).rejects.toThrow(/permission denied/);
    // Not for another workspace's order, a stranger, a source we don't know, or an id that isn't one.
    await expect(quote(tenantA, orderB, alice)).rejects.toThrow(/Order not found/);
    await expect(quote(tenantA, orderA, bob)).rejects.toThrow(/Workspace not found/);
    await expect(quote(tenantA, orderA, carol, { provider: "fedex" })).rejects.toThrow(
      /Unknown label source/,
    );
    await expect(
      quote(tenantA, orderA, carol, { rates: [{ ...RATES[1], source: "fedex" }] }),
    ).rejects.toThrow(/Rates are not a list/);
    await expect(
      quote(tenantA, orderA, carol, { rates: [{ ...RATES[1], id: "x'; drop" }] }),
    ).rejects.toThrow(/Rates are not a list/);
  });

  it("the rate that is claimed decides where the label is bought", async () => {
    const id = await quote(tenantA, orderA, carol);
    // A rate id made up in the browser, even one shaped like ours, buys nothing.
    await expect(claim(carol, orderA, "upsrate_ffffffffffffffff")).rejects.toThrow(
      /not quoted for this order/,
    );
    await expect(claim(bob, orderA, RATES[1].id)).rejects.toThrow(/Order not found/);

    const ups = await claim(carol, orderA, RATES[1].id);
    expect(ups).toMatchObject({
      quote_id: id,
      provider: "ups",
      kind: "shipment",
      boxes: 1,
      request_hash: HASH,
      rate: { id: RATES[1].id, source: "ups", ref: { service_code: "03" } },
    });
    expect((await quoteRow(id)).provider).toBe("ups");
    // While it is being bought, nothing else can be: not from another source either.
    await expect(claim(alice, orderA, RATES[0].id)).rejects.toThrow(/still being finished/);
    await release(tenantA, id);

    // The same list again; this time EasyPost's rate, with EasyPost's own id for what it quoted.
    const again = await quote(tenantA, orderA, carol, { provider: "ups", shipment: "quote_ours" });
    expect((await quoteRow(again)).provider_shipment_id).toBe("quote_ours");
    const easypost = await claim(carol, orderA, RATES[0].id);
    expect(easypost).toMatchObject({ provider: "easypost", provider_shipment_id: "shp_ep_1" });
    expect(await quoteRow(again)).toMatchObject({
      status: "buying",
      provider: "easypost",
      provider_shipment_id: "shp_ep_1",
    });
    await release(tenantA, again);
  });

  it("a quote stored the old way is still EasyPost's", async () => {
    const [{ id }] = await service<{ id: string }>(
      "select public.save_label_quote($1, $2, $3, 'shp_old', $4::jsonb) as id",
      [
        tenantA,
        orderA,
        carol.id,
        JSON.stringify([
          { id: "rate_old", carrier: "USPS", service: "Priority", name: "x", price: "9.85" },
        ]),
      ],
    );
    expect(await claim(carol, orderA, "rate_old")).toMatchObject({
      quote_id: id,
      provider: "easypost",
      provider_shipment_id: "shp_old",
      rate: { id: "rate_old" },
    });
    await release(tenantA, id);
  });
});

describe("a label bought from UPS or Redo", () => {
  let quoteId: string;
  let fileId: string;

  it("is kept with its own id, every box and its file before the parcel exists", async () => {
    quoteId = await quote(tenantA, orderA, carol, {
      provider: "ups",
      shipment: "quote_two",
      kind: "order",
      boxes: 2,
    });
    // Nothing to keep until it is being bought, and never from a browser session.
    expect(await keep(tenantA, quoteId, "1ZSHIP0001", [], [])).toBe(false);
    await claim(carol, orderA, RATES[1].id);
    await expect(
      as(
        alice,
        "select public.mark_label_bought_from($1, $2, 'x', 'UPS', '', 'live', 1, '[]'::jsonb)",
        [tenantA, quoteId],
      ),
    ).rejects.toThrow(/permission denied/);
    // Another workspace's server call can't touch it either.
    expect(await keep(tenantB, quoteId, "1ZSHIP0001", [], [])).toBe(false);

    const parcels = [
      {
        shipment_id: "1ZSHIP0001",
        tracking_number: "1Z0010000000000001",
        tracking_url: "https://www.ups.com/track?tracknum=1Z0010000000000001",
        label_url: null,
      },
      {
        shipment_id: "1ZSHIP0001",
        tracking_number: "1Z0010000000000002",
        tracking_url: "javascript:alert(1)",
        label_url: "http://not-https.example/l.gif",
      },
    ];
    expect(
      await keep(tenantA, quoteId, "1ZSHIP0001", parcels, [
        { box: 1, content_type: "image/gif", data: GIF },
        // Not a kind of file we keep, a box that doesn't exist, and something that isn't base64.
        { box: 2, content_type: "text/html", data: GIF },
        { box: 5, content_type: "image/gif", data: GIF },
        { box: 2, content_type: "image/gif", data: "<script>" },
      ]),
    ).toBe(true);
    const row = await quoteRow(quoteId);
    expect(row).toMatchObject({
      status: "bought",
      provider: "ups",
      provider_shipment_id: "1ZSHIP0001",
      tracking_number: "1Z0010000000000001",
      label_url: null,
      price: "9.80",
      // No longer needed once it is bought.
      request_hash: null,
    });
    expect(row.parcels).toHaveLength(2);
    expect(row.parcels![0]).toMatchObject({
      shipment_id: "1ZSHIP0001",
      tracking_number: "1Z0010000000000001",
      tracking_url: "https://www.ups.com/track?tracknum=1Z0010000000000001",
      label_url: null,
    });
    fileId = row.parcels![0].label_file as string;
    expect(fileId).toMatch(/^[0-9a-f-]{36}$/);
    // The bad file was left out, and the bad links with it; the box is still there.
    expect(row.parcels![1]).toEqual({
      shipment_id: "1ZSHIP0001",
      tracking_number: "1Z0010000000000002",
      tracking_url: null,
      label_url: null,
      label_file: null,
    });
    // Once kept, it can't be kept again or released.
    expect(await keep(tenantA, quoteId, "1ZOTHER", parcels, [])).toBe(false);
    await release(tenantA, quoteId);
    expect((await quoteRow(quoteId)).status).toBe("bought");
  });

  it("the label's file stays inside its workspace, and only the server writes it", async () => {
    const mine = await as<{ id: string; tenant_id: string; content_type: string; data: string }>(
      carol,
      "select id, tenant_id, content_type, data from public.shipping_label_files",
    );
    expect(mine).toEqual([
      { id: fileId, tenant_id: tenantA, content_type: "image/gif", data: GIF },
    ]);
    expect(await as(bob, "select id from public.shipping_label_files")).toEqual([]);
    expect(
      await as(bob, "select id from public.shipping_label_files where id = $1", [fileId]),
    ).toEqual([]);
    for (const [sql, params] of [
      [
        "insert into public.shipping_label_files (tenant_id, quote_id, box, content_type, data) values ($1, $2, 2, 'image/gif', 'AAAA')",
        [tenantA, quoteId],
      ],
      ["update public.shipping_label_files set data = 'AAAA' where tenant_id = $1", [tenantA]],
      ["delete from public.shipping_label_files where tenant_id = $1", [tenantA]],
    ] as [string, unknown[]][]) {
      await expect(as(alice, sql, params), sql).rejects.toThrow(/permission denied/);
    }
    // Even the server role only reads the table; files arrive through the one function.
    await expect(
      service("delete from public.shipping_label_files where tenant_id = $1", [tenantA]),
    ).rejects.toThrow(/permission denied/);
  });

  it("becomes one parcel that remembers where it was bought, and voids like any label", async () => {
    const [{ n }] = await as<{ n: number }>(carol, "select public.record_label_shipment($1) as n", [
      quoteId,
    ]);
    const { rows } = await db.query<{
      id: string;
      label_provider: string;
      label_shipment_id: string;
      label_url: string | null;
      label_parcels: Record<string, unknown>[];
      cost: string;
    }>("select * from public.shipments where tenant_id = $1 and number = $2", [tenantA, n]);
    expect(rows[0]).toMatchObject({
      label_provider: "ups",
      label_shipment_id: "1ZSHIP0001",
      label_url: null,
      cost: "9.80",
    });
    expect(rows[0].label_parcels.map((box) => box.label_file)).toEqual([fileId, null]);
    expect((await quoteRow(quoteId)).status).toBe("recorded");

    // A plain member can't void; an owner can, and the refund is marked as asked for.
    await expect(as(carol, "select public.void_label_shipment($1)", [rows[0].id])).rejects.toThrow(
      /Only owners and admins/,
    );
    await as(alice, "select public.void_label_shipment($1)", [rows[0].id]);
    const after = await db.query<{ voided_at: string | null; label_refund_status: string }>(
      "select voided_at, label_refund_status from public.shipments where id = $1",
      [rows[0].id],
    );
    expect(after.rows[0].voided_at).not.toBeNull();
    expect(after.rows[0].label_refund_status).toBe("requested");
    // A label from somewhere we don't know can't be written onto a parcel at all.
    await expect(
      db.query("update public.shipments set label_provider = 'fedex' where id = $1", [rows[0].id]),
    ).rejects.toThrow(/shipments_label_provider_check/);
  });

  it("a paid label that says too little is still kept", async () => {
    await db.query(
      "update public.shipments set shipped_at = now() - interval '5 minutes' where tenant_id = $1",
      [tenantA],
    );
    const id = await quote(tenantA, orderA, carol, { provider: "redo", shipment: "quote_three" });
    expect((await claim(carol, orderA, RATES[2].id)).provider).toBe("redo");
    // No boxes came back, and the id is one another quote already holds: nothing is lost.
    await db.query(
      "update public.shipping_label_quotes set provider = 'redo', provider_shipment_id = 'sh_taken' where id = $1",
      [quoteId],
    );
    expect(await keep(tenantA, id, "sh_taken", [], [])).toBe(true);
    const row = await quoteRow(id);
    expect(row).toMatchObject({
      status: "bought",
      provider: "redo",
      provider_shipment_id: "quote_three",
      tracking_number: "",
    });
    expect(row.parcels).toEqual([
      {
        shipment_id: "sh_taken",
        tracking_number: "",
        tracking_url: null,
        label_url: null,
        label_file: null,
      },
    ]);
    await as(carol, "select public.record_label_shipment($1)", [id]);
  });
});

describe("several orders on one label, bought from another source", () => {
  it("claims every order and names the source of the chosen rate", async () => {
    const one = await shopOrder(tenantA, "7101", "pat@example.com", "c71");
    const two = await shopOrder(tenantA, "7102", "pat@example.com", "c71");
    // The same moment for both, so the label goes on the lower id.
    const [first, rider] = [one, two].sort();
    const id = await quote(tenantA, first, carol, {
      provider: "redo",
      shipment: "quote_group",
      riders: [rider],
    });
    // The pair's rates can't be bought for the one order on its own.
    await expect(claim(carol, first, RATES[2].id)).rejects.toThrow(/not quoted for this order/);
    const [{ c }] = await as<{ c: Claim }>(
      carol,
      "select public.claim_group_label_purchase($1, $2::uuid[], $3) as c",
      [first, [rider], RATES[2].id],
    );
    expect(c).toMatchObject({
      quote_id: id,
      provider: "redo",
      request_hash: HASH,
      riders: [rider],
      rate: { source: "redo", ref: { mode: "1", account: "ca_1" } },
    });
    expect(
      await keep(
        tenantA,
        id,
        "sh_group_1",
        [
          {
            shipment_id: "sh_group_1",
            tracking_number: "794600000001",
            tracking_url: "https://www.fedex.com/fedextrack/?trknbr=794600000001",
            label_url: "https://files.redo.example/label.pdf",
          },
        ],
        [{ box: 1, content_type: "application/pdf", data: "JVBERi0x" }],
      ),
    ).toBe(true);
    await as(carol, "select public.record_label_shipment($1)", [id]);
    const { rows } = await db.query<{
      shipping_order_id: string;
      label_provider: string | null;
      merged_with: string | null;
      tracking_number: string;
    }>(
      "select shipping_order_id, label_provider, merged_with, tracking_number from public.shipments where shipping_order_id = any ($1::uuid[]) order by number",
      [[first, rider]],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      shipping_order_id: first,
      label_provider: "redo",
      merged_with: null,
    });
    expect(rows[1]).toMatchObject({ shipping_order_id: rider, label_provider: null });
    expect(rows[1].merged_with).not.toBeNull();
    expect(rows.map((row) => row.tracking_number)).toEqual(["794600000001", "794600000001"]);
  });
});

describe("privacy", () => {
  const files = async (tenant: string) =>
    (await db.query("select id from public.shipping_label_files where tenant_id = $1", [tenant]))
      .rows.length;

  it("forgetting a shopper removes their label's picture and the quote's fingerprint, in that workspace only", async () => {
    // A label with a file in the other workspace, and an open quote (with a fingerprint) in this one.
    const theirs = await quote(tenantB, orderB, bob, { provider: "ups", shipment: "quote_b" });
    await claim(bob, orderB, RATES[1].id);
    await keep(
      tenantB,
      theirs,
      "1ZSHIPB001",
      [
        {
          shipment_id: "1ZSHIPB001",
          tracking_number: "1ZB001",
          tracking_url: null,
          label_url: null,
        },
      ],
      [{ box: 1, content_type: "image/gif", data: GIF }],
    );
    const lee = await shopOrder(tenantA, "7201", "lee@example.com", "c70");
    const open = await quote(tenantA, lee, carol, { provider: "ups", shipment: "quote_lee" });
    expect((await quoteRow(open)).request_hash).toBe(HASH);
    const before = await files(tenantA);
    expect(before).toBeGreaterThanOrEqual(2);

    // Pat's two orders shared one label: forgetting Pat takes its file.
    await service("select public.redact_customer($1, 'shopify', 'c71', 'pat@example.com')", [
      tenantA,
    ]);
    expect(await files(tenantA)).toBe(before - 1);
    await service("select public.redact_customer($1, 'shopify', 'c70', 'lee@example.com')", [
      tenantA,
    ]);
    expect(await files(tenantA)).toBe(0);
    expect((await quoteRow(open)).request_hash).toBeNull();
    expect(await files(tenantB)).toBe(1);
  });

  it("disconnecting the shop takes the label files with the orders", async () => {
    await service("select public.purge_provider_data($1, 'shopify')", [tenantB]);
    expect(await files(tenantB)).toBe(0);
  });
});
