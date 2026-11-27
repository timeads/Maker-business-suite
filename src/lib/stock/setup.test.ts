import { describe, expect, it } from "vitest";
import { requiredItems } from "../setup/items";
import { DEFAULT_STOCK_SETTINGS } from "./config";
import { buildStockRows, type ItemRow, type SupplierRow } from "./plan";
import { STOCK_STEPS, stockRowFacts, stockSetupItems, type StockSetupFacts } from "./setup";

const NOW = new Date("2026-11-27T15:00:00Z");
const fresh = { status: "active" as const, lastSyncedAt: "2026-11-27T12:00:00Z", lastError: null };

/** A workspace with nothing left to do. */
const done = (more: Partial<StockSetupFacts> = {}): StockSetupFacts => ({
  now: NOW,
  shop: fresh,
  items: 40,
  planned: 30,
  noSupplier: [],
  suppliersNoLead: [],
  settingsSaved: true,
  costsUnknown: 0,
  orders: 12,
  gmail: { offered: true, connected: true },
  bills: { setUp: true },
  seasons: { count: 2, seasonality: true },
  ...more,
});
const ids = (facts: StockSetupFacts) => stockSetupItems(facts).map((item) => item.id);
const one = (facts: StockSetupFacts, id: string) =>
  stockSetupItems(facts).find((item) => item.id === id);

describe("stockSetupItems", () => {
  it("has nothing to say when everything is in place", () => {
    expect(stockSetupItems(done())).toEqual([]);
  });

  it("asks for the shop first: connect, connect again, a read that failed, the first read, an old read", () => {
    expect(ids(done({ shop: null }))).toEqual(["shop.connect"]);
    expect(ids(done({ shop: { ...fresh, status: "needs_reconnect" } }))).toEqual([
      "shop.reconnect",
    ]);
    expect(ids(done({ shop: { ...fresh, lastError: "Timed out" } }))).toEqual(["shop.failed"]);
    expect(ids(done({ shop: { ...fresh, lastSyncedAt: null } }))).toEqual(["shop.first-read"]);
    expect(ids(done({ shop: { ...fresh, lastSyncedAt: "2026-11-20T12:00:00Z" } }))).toEqual([
      "shop.old",
    ]);
    expect(one(done({ shop: null }), "shop.connect")).toMatchObject({ managersOnly: true });
  });

  it("names items with nobody to order from, by count so the fingerprint stays small", () => {
    const item = one(
      done({
        noSupplier: [
          { id: "i1", name: "Wool rug · Large" },
          { id: "i2", name: "Yarn" },
        ],
      }),
      "suppliers.missing",
    )!;
    expect(item).toMatchObject({
      title: "Give 2 items a supplier",
      count: 2,
      facts: "2",
      to: "stock/items?show=nosupplier",
      managersOnly: true,
    });
    expect(item.names).toEqual(["Wool rug · Large", "Yarn"]);
    expect(item.optional).toBeUndefined();
  });

  it("asks for suppliers' delivery days only while the usual figure was never chosen", () => {
    const lacking = [{ id: "s1", name: "Hill Mill" }];
    expect(
      one(done({ suppliersNoLead: lacking, settingsSaved: false }), "suppliers.lead"),
    ).toMatchObject({
      title: "Say how long 1 supplier takes to deliver",
      to: "stock/suppliers/s1",
      facts: "s1",
    });
    expect(ids(done({ suppliersNoLead: lacking }))).not.toContain("suppliers.lead");
  });

  it("asks to check the planning figures until they're saved, once there's something to plan", () => {
    expect(ids(done({ settingsSaved: false }))).toContain("planning.defaults");
    expect(ids(done({ settingsSaved: false, planned: 0 }))).not.toContain("planning.defaults");
  });

  it("asks for costs when more than a fifth are unknown, and never to someone who doesn't see costs", () => {
    expect(ids(done({ costsUnknown: 6 }))).not.toContain("costs.unknown");
    expect(one(done({ costsUnknown: 7 }), "costs.unknown")).toMatchObject({
      title: "Add what 7 items cost you",
      facts: "2",
    });
    expect(one(done({ costsUnknown: 1, planned: 1 }), "costs.unknown")?.title).toBe(
      "Add what 1 item costs you",
    );
    expect(ids(done({ costsUnknown: null }))).not.toContain("costs.unknown");
  });

  it("offers the extras as optional, never on the card", () => {
    const facts = done({
      orders: 0,
      gmail: { offered: true, connected: false },
      bills: { setUp: false },
      seasons: { count: 0, seasonality: true },
    });
    const items = stockSetupItems(facts);
    expect(items.map((i) => i.id)).toEqual(["history.import", "gmail", "bills", "seasons"]);
    expect(items.every((i) => i.optional && i.managersOnly)).toBe(true);
    expect(requiredItems(items)).toEqual([]);
  });

  it("leaves out extras that aren't on offer or don't apply", () => {
    // Gmail isn't set up on this server, the bills are for owners and admins only, seasons are off.
    expect(
      ids(
        done({
          gmail: { offered: false, connected: false },
          bills: null,
          seasons: { count: 0, seasonality: false },
        }),
      ),
    ).toEqual([]);
    // No shop yet: bringing history across waits.
    expect(ids(done({ shop: null, orders: 0 }))).toEqual(["shop.connect"]);
    expect(ids(done({ orders: null }))).toEqual([]);
  });

  it("puts every item in a step that exists", () => {
    const all = stockSetupItems(
      done({
        shop: null,
        noSupplier: [{ id: "i", name: "I" }],
        suppliersNoLead: [{ id: "s", name: "S" }],
        settingsSaved: false,
        costsUnknown: 30,
        gmail: { offered: true, connected: false },
        bills: { setUp: false },
        seasons: { count: 0, seasonality: true },
      }),
    );
    const steps = new Set(STOCK_STEPS.map((s) => s.id));
    expect(all.every((item) => steps.has(item.step))).toBe(true);
  });
});

describe("stockRowFacts", () => {
  const item = (id: string, overrides: Partial<ItemRow> = {}): ItemRow => ({
    id,
    title: `Item ${id}`,
    variant_title: null,
    sku: id,
    on_hand: 4,
    unit_cost: null,
    tracked: true,
    product_status: "ACTIVE",
    supplier_id: "s1",
    lead_time_days: null,
    coverage_days: null,
    safety_stock: 0,
    hidden: false,
    ...overrides,
  });
  const supplier = (id: string, more: Partial<SupplierRow> = {}): SupplierRow => ({
    id,
    name: `Supplier ${id}`,
    lead_time_days: null,
    coverage_days: 30,
    moq: 1,
    moq_applies_to: "order",
    ...more,
  });
  const rows = buildStockRows({
    items: [
      item("a", { unit_cost: "3.00" }),
      item("b", { supplier_id: null }),
      item("c", { supplier_id: "s2" }),
      item("d", { supplier_id: "s3", hidden: true }),
      item("e", { supplier_id: "s4", own_cost: "1.00" }),
    ],
    suppliers: [
      supplier("s1"),
      supplier("s2", { archived_at: "2026-01-01" }),
      supplier("s3"),
      supplier("s4", { lead_time_days: 12 }),
    ],
    sales: [],
    openLines: [],
    settings: DEFAULT_STOCK_SETTINGS,
    today: "2026-11-27",
  });
  const suppliers = [
    supplier("s1"),
    supplier("s2", { archived_at: "2026-01-01" }),
    supplier("s3"),
    supplier("s4", { lead_time_days: 12 }),
  ];

  it("counts planned items, those with nobody to order from, and suppliers with no days of their own", () => {
    const facts = stockRowFacts(rows, suppliers, true);
    expect(facts.items).toBe(5);
    expect(facts.planned).toBe(4);
    // No supplier, or one no longer used.
    expect(facts.noSupplier.map((r) => r.id)).toEqual(["b", "c"]);
    // Only suppliers in use by planned items: s3's only item is hidden, s4 has its own days.
    expect(facts.suppliersNoLead.map((r) => r.id)).toEqual(["s1"]);
    expect(facts.costsUnknown).toBe(2);
  });

  it("counts no costs for someone who doesn't see them", () => {
    expect(stockRowFacts(rows, suppliers, false).costsUnknown).toBeNull();
  });
});
