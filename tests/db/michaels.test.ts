import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { adoptionBlocked } from "../../src/lib/michaels/mapping";
import { asAnon, asService, asUser, createTestDb, createUser } from "./harness";

/**
 * The Michaels connector's tables and functions: who can see what, what the
 * worker may claim and record, pairing by hand, and the rule that nothing may
 * be sent, least of all when more than a tenth of the listings have no item.
 * All data here is made up.
 */

type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let bob: User; // owner of B
let carol: User; // plain member of A
let tenantA: string;
let tenantB: string;
let itemA: string;
let itemA2: string;
let itemB: string;

const TABLES = [
  "michaels_runs",
  "michaels_listings",
  "michaels_pairings",
  "michaels_orders",
  "michaels_order_lines",
  "michaels_alerts",
] as const;

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

const connect = (tenant: string, user: User) =>
  service(
    "select public.save_connection($1, 'michaels', $2, 'Michaels Marketplace', '{}', $3::jsonb, $4, $5::jsonb)",
    [
      tenant,
      `michaels-${tenant}`,
      JSON.stringify({ access_token: "made-up-key", secrets: { env: "sandbox" } }),
      user.id,
      JSON.stringify({ environment: "sandbox", key_created_on: "2026-09-01" }),
    ],
  );
const switchOn = (user: User, tenant: string, enabled = true) =>
  as(user, "select public.save_config($1, 'michaels', 'settings', $2::jsonb)", [
    tenant,
    JSON.stringify({ version: 1, enabled, mode: "watch", units_held_back: 1 }),
  ]);
const claim = () =>
  service<{ id: string; tenant_id: string; source: string }>(
    "select * from public.claim_michaels_runs(10)",
  );
const finish = async (
  run: string,
  status = "done",
  changes: unknown = [],
  error: string | null = null,
) =>
  (
    await service<{ result: { send_blocked: string; failed_in_row: number } }>(
      "select public.finish_michaels_run($1, $2, $3::jsonb, $4::jsonb, $5) as result",
      [run, status, JSON.stringify({ listings: { skus: 1 } }), JSON.stringify(changes), error],
    )
  )[0].result;
const record = (tenant: string, run: string, rows: unknown[]) =>
  service<{ n: number }>("select public.record_michaels_listings($1, $2, $3::jsonb) as n", [
    tenant,
    run,
    JSON.stringify(rows),
  ]);
const listing = (n: number, itemId: string | null, over: Record<string, unknown> = {}) => ({
  michaels_sku_number: `90000000000000000${String(n).padStart(2, "0")}`,
  primary_sku_number: `90000000000000000${String(n).padStart(2, "0")}`,
  seller_sku: `SKU-${n}`,
  item_name: `Sample ${n}`,
  listing_status: "ACTIVE",
  stock_item_id: itemId,
  matched_by: itemId ? "exact" : null,
  problem: itemId ? null : "no_match",
  problem_detail: itemId ? null : "Nothing in your shop has this SKU",
  michaels_qty: 3,
  michaels_price: 12.5,
  ...over,
});
/** Ages every run of a tenant so the next claim sees it as due again. */
const age = (tenant: string, minutes: number) =>
  db.query(
    "update public.michaels_runs set created_at = created_at - make_interval(mins => $2), started_at = started_at - make_interval(mins => $2) where tenant_id = $1",
    [tenant, minutes],
  );
const blockedFor = async (tenant: string) =>
  (await service<{ r: string }>("select public.michaels_send_blocked($1) as r", [tenant]))[0].r;

async function stockItems(tenant: string, prefix: string) {
  await service("select public.upsert_stock_items($1, 'shopify', $2::jsonb)", [
    tenant,
    JSON.stringify([
      {
        external_id: `${prefix}-v1`,
        title: "Sample cone",
        sku: `${prefix}-CONE`,
        on_hand: 10,
        tracked: true,
        price: 20,
      },
      {
        external_id: `${prefix}-v2`,
        title: "Sample cloth",
        sku: `${prefix}-CLOTH`,
        on_hand: 3,
        tracked: true,
        price: 7.5,
      },
      {
        external_id: `${prefix}-v3`,
        title: "Twin one",
        sku: `${prefix}-TWIN`,
        on_hand: 1,
        tracked: true,
      },
      {
        external_id: `${prefix}-v4`,
        title: "Twin two",
        sku: `${prefix}-twin `,
        on_hand: 1,
        tracked: true,
      },
    ]),
  ]);
  const { rows } = await db.query<{ id: string; sku: string }>(
    "select id, sku from public.stock_items where tenant_id = $1 order by external_id",
    [tenant],
  );
  return rows;
}

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  carol = { id: await createUser(db, "carol@a.test"), email: "carol@a.test" };
  tenantA = await tenantFor(alice, "Thread & Loom");
  tenantB = await tenantFor(bob, "Other Shop");
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, carol.id],
  );
  const a = await stockItems(tenantA, "A");
  itemA = a[0].id;
  itemA2 = a[1].id;
  itemB = (await stockItems(tenantB, "B"))[0].id;
});

describe("connecting", () => {
  it("accepts michaels as a provider and keeps the key out of everyone's sight", async () => {
    await connect(tenantA, alice);
    await connect(tenantB, bob);
    const row = await one<{ everything: string }>(
      "select to_jsonb(c)::text as everything from public.connections c where tenant_id = $1 and provider = 'michaels'",
      [tenantA],
    );
    expect(row.everything).not.toContain("made-up-key");
    expect(
      await as(
        carol,
        "select status, metadata from public.connections where provider = 'michaels'",
      ),
    ).toEqual([
      { status: "active", metadata: { environment: "sandbox", key_created_on: "2026-09-01" } },
    ]);
    await expect(
      as(alice, "select * from public.get_provider_token($1, 'michaels')", [tenantA]),
    ).rejects.toThrow(/permission denied/);
    const [token] = await service<{ token: { access_token: string } }>(
      "select token from public.get_provider_token($1, 'michaels')",
      [tenantA],
    );
    expect(token.token.access_token).toBe("made-up-key");
  });
});

describe("looks: claiming and finishing", () => {
  it("hands out nothing until a workspace switches the connector on", async () => {
    expect(await claim()).toEqual([]);
    await switchOn(alice, tenantA);
    const claimed = await claim();
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ tenant_id: tenantA, source: "schedule" });
  });

  it("gives a look to one worker only, and not again within the hour", async () => {
    expect(await claim()).toEqual([]);
    const run = await one<{ id: string; status: string }>(
      "select id, status from public.michaels_runs where tenant_id = $1",
      [tenantA],
    );
    expect(run.status).toBe("running");
    expect(await finish(run.id)).toEqual({ send_blocked: "no_scan", failed_in_row: 0 });
    expect(await claim()).toEqual([]);
    await age(tenantA, 61);
    expect(await claim()).toHaveLength(1);
  });

  it("marks a look that never finished as failed, and does not run it again", async () => {
    const stuck = await one<{ id: string }>(
      "select id from public.michaels_runs where tenant_id = $1 and status = 'running'",
      [tenantA],
    );
    await age(tenantA, 31);
    // Not due yet (31 minutes), so nothing new is handed out; the stuck one is closed.
    expect(await claim()).toEqual([]);
    expect(
      await one("select status, error, send_blocked from public.michaels_runs where id = $1", [
        stuck.id,
      ]),
    ).toEqual({ status: "failed", error: "This look never finished.", send_blocked: "no_scan" });
    await expect(finish(stuck.id)).rejects.toThrow(/not underway/);
  });

  it("records every run as watch-only and refuses any other kind", async () => {
    const rows = await db.query<{ watch_only: boolean }>(
      "select distinct watch_only from public.michaels_runs",
    );
    expect(rows.rows).toEqual([{ watch_only: true }]);
    await expect(
      db.query("update public.michaels_runs set watch_only = false where tenant_id = $1", [
        tenantA,
      ]),
    ).rejects.toThrow(/check/);
    await expect(
      db.query(
        "insert into public.michaels_runs (tenant_id, status, watch_only, send_blocked) values ($1, 'done', false, 'watch_only')",
        [tenantB],
      ),
    ).rejects.toThrow(/check/);
    // A finished look must say why nothing could be sent.
    await expect(
      db.query("insert into public.michaels_runs (tenant_id, status) values ($1, 'done')", [
        tenantB,
      ]),
    ).rejects.toThrow(/check/);
  });

  it("closes a waiting look when the workspace switches off, and queues no more", async () => {
    await age(tenantA, 61);
    await db.query("insert into public.michaels_runs (tenant_id) values ($1)", [tenantA]);
    await switchOn(alice, tenantA, false);
    expect(await claim()).toEqual([]);
    expect(
      await one<{ status: string }>(
        "select status from public.michaels_runs where tenant_id = $1 order by created_at desc limit 1",
        [tenantA],
      ),
    ).toEqual({ status: "failed" });
    await switchOn(alice, tenantA);
  });

  it("does not look for a workspace whose connection is gone", async () => {
    await switchOn(bob, tenantB);
    await db.query(
      "update public.connections set status = 'needs_reconnect' where tenant_id = $1 and provider = 'michaels'",
      [tenantB],
    );
    await age(tenantA, 600);
    const claimed = await claim();
    expect(claimed.map((c) => c.tenant_id)).toEqual([tenantA]);
    await finish(claimed[0].id);
    await db.query(
      "update public.connections set status = 'active' where tenant_id = $1 and provider = 'michaels'",
      [tenantB],
    );
  });

  it("counts failures in a row since the last look that worked", async () => {
    const fail = async () => {
      await age(tenantA, 61);
      const [run] = (await claim()).filter((c) => c.tenant_id === tenantA);
      return finish(run.id, "failed", [], "listings: made-up failure");
    };
    // The earlier never-finished and switched-off looks are older than the last one that worked.
    expect((await fail()).failed_in_row).toBe(1);
    expect((await fail()).failed_in_row).toBe(2);
    expect((await fail()).failed_in_row).toBe(3);
    await age(tenantA, 61);
    const [run] = (await claim()).filter((c) => c.tenant_id === tenantA);
    expect((await finish(run.id)).failed_in_row).toBe(0);
  });

  it("keeps at most 500 would-be changes and only ones shaped like changes", async () => {
    await age(tenantA, 61);
    const [run] = (await claim()).filter((c) => c.tenant_id === tenantA);
    const changes = [
      "not a change",
      ...Array.from({ length: 510 }, (_, i) => ({ kind: "stock", seller_sku: `S-${i}`, to: "1" })),
    ];
    await finish(run.id, "done", changes);
    const kept = await one<{ n: number; first: string }>(
      "select jsonb_array_length(changes) as n, changes -> 0 ->> 'seller_sku' as first from public.michaels_runs where id = $1",
      [run.id],
    );
    expect(kept).toEqual({ n: 499, first: "S-0" });
    await expect(finish(run.id, "sent")).rejects.toThrow(/Unknown status|not underway/);
  });

  it("lets only the worker claim, record and finish", async () => {
    for (const sql of [
      "select * from public.claim_michaels_runs(1)",
      `select public.finish_michaels_run('${tenantA}', 'done', '{}', '[]', null)`,
      `select public.record_michaels_listings('${tenantA}', '${tenantA}', '[]')`,
      `select public.prune_michaels_listings('${tenantA}', '${tenantA}')`,
      `select public.record_michaels_orders('${tenantA}', '${tenantA}', '[]')`,
      `select public.note_michaels_alert('${tenantA}', 'k')`,
      `select public.michaels_send_blocked('${tenantA}')`,
    ]) {
      await expect(as(alice, sql)).rejects.toThrow(/permission denied/);
      await expect(asAnon(db, (tx) => tx.query(sql))).rejects.toThrow(/permission denied/);
    }
  });
});

describe("listings and the safety stop", () => {
  let run: string;
  const open = async (tenant: string) => {
    await age(tenant, 61);
    const [claimed] = (await claim()).filter((c) => c.tenant_id === tenant);
    return claimed.id;
  };

  it("records what a look read, and ignores an item that belongs to someone else", async () => {
    run = await open(tenantA);
    const [{ n }] = await record(tenantA, run, [
      listing(1, itemA),
      listing(2, itemA2, { matched_by: "case" }),
      listing(3, itemB), // another workspace's item: no match
      listing(4, null, { problem: "ambiguous" }),
      listing(5, null, { seller_sku: "  ", problem: "no_seller_sku" }),
      listing(5, itemA), // the same Michaels number twice in one batch: one row
      { seller_sku: "NO-NUMBER" },
    ]);
    expect(n).toBe(5);
    const rows = await db.query(
      "select seller_sku, stock_item_id, matched_by, problem, michaels_qty, michaels_price::text, figures_at is not null as dated from public.michaels_listings where tenant_id = $1 order by michaels_sku_number",
      [tenantA],
    );
    expect(rows.rows).toEqual([
      {
        seller_sku: "SKU-1",
        stock_item_id: itemA,
        matched_by: "exact",
        problem: null,
        michaels_qty: 3,
        michaels_price: "12.50",
        dated: true,
      },
      {
        seller_sku: "SKU-2",
        stock_item_id: itemA2,
        matched_by: "case",
        problem: null,
        michaels_qty: 3,
        michaels_price: "12.50",
        dated: true,
      },
      {
        seller_sku: "SKU-3",
        stock_item_id: null,
        matched_by: null,
        problem: "no_match",
        michaels_qty: 3,
        michaels_price: "12.50",
        dated: true,
      },
      {
        seller_sku: "SKU-4",
        stock_item_id: null,
        matched_by: null,
        problem: "ambiguous",
        michaels_qty: 3,
        michaels_price: "12.50",
        dated: true,
      },
      // The Michaels number sent twice in one batch made one row.
      expect.objectContaining({ michaels_qty: 3 }),
    ]);
  });

  it("keeps the seller SKU exactly as Michaels has it, and long ids as text", async () => {
    await record(tenantA, run, [listing(6, itemA, { seller_sku: " Sku-Six " })]);
    const row = await one<{ seller_sku: string; michaels_sku_number: string }>(
      "select seller_sku, michaels_sku_number from public.michaels_listings where tenant_id = $1 and michaels_sku_number like '%06'",
      [tenantA],
    );
    expect(row).toEqual({ seller_sku: " Sku-Six ", michaels_sku_number: "9000000000000000006" });
  });

  it("leaves a figure it already knew when a look didn't read one", async () => {
    await record(tenantA, run, [listing(1, itemA, { michaels_qty: null, michaels_price: null })]);
    expect(
      await one(
        "select michaels_qty, michaels_price::text from public.michaels_listings where tenant_id = $1 and seller_sku = 'SKU-1'",
        [tenantA],
      ),
    ).toEqual({ michaels_qty: 3, michaels_price: "12.50" });
  });

  it("refuses rows for a look that isn't this workspace's, or isn't underway", async () => {
    await expect(record(tenantB, run, [listing(1, itemB)])).rejects.toThrow(/not underway/);
    await expect(
      service("select public.prune_michaels_listings($1, $2)", [tenantB, run]),
    ).rejects.toThrow(/not underway/);
  });

  it("STOPS: with more than a tenth unmatched, nothing may be sent, and the run says so", async () => {
    // 6 listings, 3 with no item: half are unmatched.
    expect(await blockedFor(tenantA)).toBe("unmatched");
    expect(await finish(run)).toMatchObject({ send_blocked: "unmatched" });
    expect(
      await one("select send_blocked, watch_only from public.michaels_runs where id = $1", [run]),
    ).toEqual({ send_blocked: "unmatched", watch_only: true });
  });

  it("draws the line exactly at a tenth, the same place the app draws it", async () => {
    const check = async (total: number, unmatched: number) => {
      const next = await open(tenantA);
      await record(
        tenantA,
        next,
        Array.from({ length: total }, (_, i) => listing(i + 1, i < unmatched ? null : itemA)),
      );
      await service("select public.prune_michaels_listings($1, $2)", [tenantA, next]);
      const { send_blocked } = await finish(next);
      expect(send_blocked === "unmatched", `${unmatched} of ${total}`).toBe(
        adoptionBlocked(total, unmatched),
      );
      return send_blocked;
    };
    expect(await check(20, 3)).toBe("unmatched");
    expect(await check(20, 2)).toBe("watch_only"); // exactly a tenth: not over
    expect(await check(10, 1)).toBe("watch_only");
    expect(await check(9, 1)).toBe("unmatched");
    expect(await check(30, 0)).toBe("watch_only");
  });

  it("never answers 'free to send' in this stage, however well everything matches", async () => {
    expect(await blockedFor(tenantA)).toBe("watch_only");
    expect(await blockedFor(tenantB)).toBe("no_scan");
    const reasons = await db.query<{ send_blocked: string | null }>(
      "select distinct send_blocked from public.michaels_runs where status in ('done', 'failed')",
    );
    expect(reasons.rows.every((r) => r.send_blocked !== null)).toBe(true);
    await expect(
      db.query("update public.michaels_runs set send_blocked = null where status = 'done'"),
    ).rejects.toThrow(/check/);
  });

  it("counts an item that has since been deleted from the shop as unmatched", async () => {
    await service("select public.upsert_stock_items($1, 'shopify', $2::jsonb)", [
      tenantA,
      JSON.stringify([
        { external_id: "A-gone", title: "Going", sku: "A-GONE", on_hand: 1, tracked: true },
      ]),
    ]);
    const gone = await one<{ id: string }>(
      "select id from public.stock_items where tenant_id = $1 and sku = 'A-GONE'",
      [tenantA],
    );
    const next = await open(tenantA);
    await record(tenantA, next, [
      listing(1, gone.id),
      listing(2, gone.id),
      listing(3, gone.id),
      ...Array.from({ length: 17 }, (_, i) => listing(i + 4, itemA)),
    ]);
    await service("select public.prune_michaels_listings($1, $2)", [tenantA, next]);
    expect(await blockedFor(tenantA)).toBe("watch_only");
    await db.query("delete from public.stock_items where id = $1", [gone.id]);
    expect(await blockedFor(tenantA)).toBe("unmatched");
    await finish(next);
  });

  it("removes listings that are no longer on Michaels after a complete read", async () => {
    const next = await open(tenantA);
    await record(tenantA, next, [
      listing(1, itemA),
      listing(2, null),
      listing(3, null, { seller_sku: "A-twin" }),
    ]);
    const [{ n }] = await service<{ n: number }>(
      "select public.prune_michaels_listings($1, $2) as n",
      [tenantA, next],
    );
    expect(n).toBe(17);
    await finish(next);
    expect(
      (await db.query("select 1 from public.michaels_listings where tenant_id = $1", [tenantA]))
        .rows,
    ).toHaveLength(3);
  });
});

describe("pairing by hand", () => {
  it("is for owners and admins only", async () => {
    await expect(
      as(carol, "select public.set_michaels_pairing($1, 'SKU-2', 'A-CLOTH')", [tenantA]),
    ).rejects.toThrow(/Only owners and admins/);
    await expect(
      as(bob, "select public.set_michaels_pairing($1, 'SKU-2', 'A-CLOTH')", [tenantA]),
    ).rejects.toThrow(/Only owners and admins/);
    await expect(
      as(carol, "select public.remove_michaels_pairing($1, 'SKU-2')", [tenantA]),
    ).rejects.toThrow(/Only owners and admins/);
    await expect(
      asAnon(db, (tx) =>
        tx.query("select public.set_michaels_pairing($1, 'SKU-2', 'A-CLOTH')", [tenantA]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("pairs a listing with the one item that has the typed SKU, straight away", async () => {
    const [{ id }] = await as<{ id: string }>(
      alice,
      "select public.set_michaels_pairing($1, 'SKU-2', ' a-cloth ') as id",
      [tenantA],
    );
    expect(id).toBe(itemA2);
    expect(
      await one(
        "select stock_item_id, matched_by, problem from public.michaels_listings where tenant_id = $1 and seller_sku = 'SKU-2'",
        [tenantA],
      ),
    ).toEqual({ stock_item_id: itemA2, matched_by: "hand", problem: null });
    expect(
      await as(carol, "select seller_sku, stock_item_id from public.michaels_pairings"),
    ).toEqual([{ seller_sku: "SKU-2", stock_item_id: itemA2 }]);
    // Pairing again replaces the first.
    await as(alice, "select public.set_michaels_pairing($1, 'SKU-2', 'A-CONE')", [tenantA]);
    expect(
      await as(
        alice,
        "select stock_item_id from public.michaels_pairings where seller_sku = 'SKU-2'",
      ),
    ).toEqual([{ stock_item_id: itemA }]);
  });

  it("refuses a SKU nobody has, one that two items share, another workspace's, and a listing that isn't there", async () => {
    const pair = (seller: string, shop: string) =>
      as(alice, "select public.set_michaels_pairing($1, $2, $3)", [tenantA, seller, shop]);
    await expect(pair("SKU-2", "NOPE")).rejects.toThrow(/no_item/);
    await expect(pair("SKU-2", "a-twin")).rejects.toThrow(/many_items/);
    await expect(pair("SKU-2", "B-CONE")).rejects.toThrow(/no_item/);
    await expect(pair("NOT-LISTED", "A-CONE")).rejects.toThrow(/no_listing/);
    await expect(pair("SKU-2", "  ")).rejects.toThrow(/no_item/);
    // An exact SKU wins over the folded twins.
    await expect(pair("A-twin", "A-TWIN")).resolves.toBeDefined();
  });

  it("takes a pairing off again, leaving the listing unmatched until the next look", async () => {
    await as(alice, "select public.remove_michaels_pairing($1, 'SKU-2')", [tenantA]);
    expect(
      await one(
        "select stock_item_id, matched_by, problem from public.michaels_listings where tenant_id = $1 and seller_sku = 'SKU-2'",
        [tenantA],
      ),
    ).toEqual({ stock_item_id: null, matched_by: null, problem: "no_match" });
    // Taking off one that isn't there is quiet.
    await as(alice, "select public.remove_michaels_pairing($1, 'SKU-2')", [tenantA]);
  });

  it("keeps a pairing whose item has gone, pointing at nothing", async () => {
    await service("select public.upsert_stock_items($1, 'shopify', $2::jsonb)", [
      tenantA,
      JSON.stringify([
        { external_id: "A-temp", title: "Temp", sku: "A-TEMP", on_hand: 1, tracked: true },
      ]),
    ]);
    await as(alice, "select public.set_michaels_pairing($1, 'SKU-2', 'A-TEMP')", [tenantA]);
    await db.query("delete from public.stock_items where tenant_id = $1 and sku = 'A-TEMP'", [
      tenantA,
    ]);
    expect(
      await as(
        alice,
        "select stock_item_id from public.michaels_pairings where seller_sku = 'SKU-2'",
      ),
    ).toEqual([{ stock_item_id: null }]);
  });
});

describe("look now", () => {
  it("is for owners and admins of a workspace that has the connector on", async () => {
    await expect(as(carol, "select public.request_michaels_run($1)", [tenantA])).rejects.toThrow(
      /Only owners and admins/,
    );
    await expect(as(bob, "select public.request_michaels_run($1)", [tenantA])).rejects.toThrow(
      /Only owners and admins/,
    );
    await switchOn(bob, tenantB, false);
    await expect(as(bob, "select public.request_michaels_run($1)", [tenantB])).rejects.toThrow(
      /not_on/,
    );
  });

  it("queues one look, finds it again on a second press, and waits ten minutes between", async () => {
    await expect(as(alice, "select public.request_michaels_run($1)", [tenantA])).rejects.toThrow(
      /too_soon/,
    );
    await age(tenantA, 11);
    const [{ id }] = await as<{ id: string }>(
      alice,
      "select public.request_michaels_run($1) as id",
      [tenantA],
    );
    const [{ id: again }] = await as<{ id: string }>(
      alice,
      "select public.request_michaels_run($1) as id",
      [tenantA],
    );
    expect(again).toBe(id);
    const claimed = await claim();
    expect(claimed).toEqual([{ id, tenant_id: tenantA, source: "manual" }]);
    expect(await one("select requested_by from public.michaels_runs where id = $1", [id])).toEqual({
      requested_by: alice.id,
    });
    await finish(id);
  });
});

describe("orders, as seen", () => {
  const order = (n: number, over: Record<string, unknown> = {}) => ({
    order_number: `ORD000000000000000${n}-1`,
    status: "READY_TO_SHIP",
    currency: "USD",
    placed_at: "2026-10-17T00:00:00Z",
    promise_ship_at: "2026-10-19T00:00:00Z",
    items_subtotal: "19.98",
    shipping: "5.00",
    tax: "1.20",
    discount: "0.00",
    grand_total: "26.18",
    lines: [
      {
        order_item_id: `77000000000000000${n}1`,
        seller_sku: "SKU-1",
        michaels_sku_number: "9000000000000000001",
        product_name: "Sample 1",
        quantity: 2,
        unit_price: "9.99",
        line_status: "READY_TO_SHIP",
      },
      {
        order_item_id: `77000000000000000${n}2`,
        seller_sku: "MYSTERY",
        quantity: 1,
        unit_price: "4.00",
      },
    ],
    ...over,
  });
  let run: string;

  it("keeps orders and their lines, marked observed", async () => {
    await age(tenantA, 61);
    run = (await claim()).filter((c) => c.tenant_id === tenantA)[0].id;
    const [{ n }] = await service<{ n: number }>(
      "select public.record_michaels_orders($1, $2, $3::jsonb) as n",
      [tenantA, run, JSON.stringify([order(1), order(2), { status: "NO-NUMBER" }])],
    );
    expect(n).toBe(2);
    expect(
      await as(
        carol,
        "select order_number, status, state, grand_total::text from public.michaels_orders order by order_number",
      ),
    ).toEqual([
      {
        order_number: "ORD0000000000000001-1",
        status: "READY_TO_SHIP",
        state: "observed",
        grand_total: "26.18",
      },
      {
        order_number: "ORD0000000000000002-1",
        status: "READY_TO_SHIP",
        state: "observed",
        grand_total: "26.18",
      },
    ]);
    expect(await as(carol, "select count(*)::int as n from public.michaels_order_lines")).toEqual([
      { n: 4 },
    ]);
  });

  it("has no way to mark an order as brought in", async () => {
    await expect(
      db.query("update public.michaels_orders set state = 'imported' where tenant_id = $1", [
        tenantA,
      ]),
    ).rejects.toThrow(/check/);
    const columns = await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'michaels_orders'",
    );
    const names = columns.rows.map((c) => c.column_name);
    // Nothing about the buyer, and nothing that links to an order in the shop.
    for (const never of [
      "first_name",
      "last_name",
      "name",
      "phone",
      "email",
      "address1",
      "city",
      "zip",
      "shop_order_id",
      "imported_at",
    ]) {
      expect(names).not.toContain(never);
    }
  });

  it("updates an order it has seen before, and drops a line Michaels took off", async () => {
    const changed = order(1, { status: "FULFILLED" });
    changed.lines = [changed.lines[0]];
    await service("select public.record_michaels_orders($1, $2, $3::jsonb)", [
      tenantA,
      run,
      JSON.stringify([changed]),
    ]);
    expect(
      await one(
        "select o.status, (select count(*)::int from public.michaels_order_lines l where l.order_id = o.id) as lines from public.michaels_orders o where o.tenant_id = $1 and o.order_number = 'ORD0000000000000001-1'",
        [tenantA],
      ),
    ).toEqual({ status: "FULFILLED", lines: 1 });
    await finish(run);
  });
});

describe("heads-ups", () => {
  it("are said once per key, per workspace", async () => {
    const note = async (tenant: string, key: string) =>
      (
        await service<{ ok: boolean }>("select public.note_michaels_alert($1, $2) as ok", [
          tenant,
          key,
        ])
      )[0].ok;
    expect(await note(tenantA, "replace:2026-10-31:14")).toBe(true);
    expect(await note(tenantA, "replace:2026-10-31:14")).toBe(false);
    expect(await note(tenantB, "replace:2026-10-31:14")).toBe(true);
    expect(await note(tenantA, " ")).toBe(false);
  });
});

describe("who can see and change what", () => {
  it("has row security on every table, with a tenant on every row", async () => {
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class where relname = any($1)",
      [TABLES],
    );
    expect(rls.rows).toHaveLength(TABLES.length);
    expect(rls.rows.every((r) => r.relrowsecurity)).toBe(true);
    const tenantColumns = await db.query(
      "select table_name from information_schema.columns where table_schema = 'public' and table_name = any($1) and column_name = 'tenant_id' and is_nullable = 'NO'",
      [TABLES],
    );
    expect(tenantColumns.rows).toHaveLength(TABLES.length);
  });

  it("shows a workspace's rows to its whole team and to nobody else", async () => {
    // Give B something of everything.
    await switchOn(bob, tenantB);
    await age(tenantB, 61);
    const [runB] = (await claim()).filter((c) => c.tenant_id === tenantB);
    await record(tenantB, runB.id, [listing(1, itemB, { seller_sku: "B-ONLY" })]);
    await service("select public.record_michaels_orders($1, $2, $3::jsonb)", [
      tenantB,
      runB.id,
      JSON.stringify([
        {
          order_number: "ORD-B-ONLY",
          status: "READY_TO_SHIP",
          lines: [{ order_item_id: "B-LINE-1", quantity: 1 }],
        },
      ]),
    ]);
    await finish(runB.id);
    await as(bob, "select public.set_michaels_pairing($1, 'B-ONLY', 'B-CONE')", [tenantB]);

    for (const table of TABLES.filter((t) => t !== "michaels_alerts")) {
      const mine = await as<{ tenant_id: string }>(carol, `select tenant_id from public.${table}`);
      expect(mine.length, table).toBeGreaterThan(0);
      expect(
        mine.every((r) => r.tenant_id === tenantA),
        table,
      ).toBe(true);
      const theirs = await as<{ tenant_id: string }>(bob, `select tenant_id from public.${table}`);
      expect(theirs.length, table).toBeGreaterThan(0);
      expect(
        theirs.every((r) => r.tenant_id === tenantB),
        table,
      ).toBe(true);
      await expect(asAnon(db, (tx) => tx.query(`select 1 from public.${table}`))).rejects.toThrow(
        /permission denied/,
      );
    }
    // The alerts ledger is the worker's own.
    await expect(as(alice, "select 1 from public.michaels_alerts")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("lets nobody write a row directly, not even an owner", async () => {
    for (const table of TABLES) {
      await expect(
        as(alice, `insert into public.${table} (tenant_id) values ($1)`, [tenantA]),
      ).rejects.toThrow(/permission denied/);
      await expect(as(alice, `delete from public.${table}`)).rejects.toThrow(/permission denied/);
      await expect(
        as(alice, `update public.${table} set tenant_id = $1`, [tenantB]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        service(`insert into public.${table} (tenant_id) values ($1)`, [tenantA]),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("can't pair across workspaces or ask for another workspace's look", async () => {
    await expect(
      as(alice, "select public.set_michaels_pairing($1, 'B-ONLY', 'B-CONE')", [tenantB]),
    ).rejects.toThrow(/Only owners and admins/);
    await expect(
      as(alice, "select public.remove_michaels_pairing($1, 'B-ONLY')", [tenantB]),
    ).rejects.toThrow(/Only owners and admins/);
    await expect(as(alice, "select public.request_michaels_run($1)", [tenantB])).rejects.toThrow(
      /Only owners and admins/,
    );
    // And A's manager can't reach B's listing by naming it under their own workspace.
    await expect(
      as(alice, "select public.set_michaels_pairing($1, 'B-ONLY', 'A-CONE')", [tenantA]),
    ).rejects.toThrow(/no_listing/);
  });

  it("goes with the workspace when it is deleted", async () => {
    const fks = await db.query<{ n: number }>(
      "select count(*)::int as n from pg_constraint c join pg_class t on t.oid = c.conrelid where t.relname = any($1) and c.contype = 'f' and c.confrelid = 'public.tenants'::regclass and c.confdeltype = 'c'",
      [TABLES],
    );
    expect(fks.rows[0].n).toBe(TABLES.length);
  });
});
