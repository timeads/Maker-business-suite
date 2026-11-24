import { describe, expect, it } from "vitest";
import { DEFAULT_STOCK_SETTINGS } from "./config";
import {
  buildStockRows,
  draftOrders,
  isPlanned,
  itemName,
  relativeDay,
  type ItemRow,
} from "./plan";

const TODAY = "2026-11-20";
const item = (id: string, overrides: Partial<ItemRow> = {}): ItemRow => ({
  id,
  title: "Wool rug",
  variant_title: "Large",
  sku: id,
  on_hand: 10,
  unit_cost: "12.50",
  tracked: true,
  product_status: "ACTIVE",
  supplier_id: "s1",
  lead_time_days: null,
  coverage_days: null,
  safety_stock: 0,
  hidden: false,
  ...overrides,
});
const mill = {
  id: "s1",
  name: "Hill Mill",
  lead_time_days: 20,
  coverage_days: 30,
  moq: 1,
  moq_applies_to: "order" as const,
};
/** One a day for the last `days` days. */
const steady = (id: string, days: number, perDay = 1) =>
  Array.from({ length: days }, (_, i) => {
    const d = new Date(2026, 10, 20 - i);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { stock_item_id: id, day, units: perDay };
  });
const settings = { ...DEFAULT_STOCK_SETTINGS, seasonality: false };

describe("stock rows", () => {
  it("uses the item's own lead time, then the supplier's, then the workspace default", () => {
    const rows = buildStockRows({
      items: [item("a", { lead_time_days: 5 }), item("b"), item("c", { supplier_id: null })],
      suppliers: [mill],
      sales: [],
      openLines: [],
      settings,
      today: TODAY,
    });
    expect(rows.map((r) => r.leadTimeDays)).toEqual([5, 20, 30]);
    expect(rows[2].supplier).toBeNull();
  });

  it("an item selling one a day with ten left is due, and says how many to order", () => {
    const [row] = buildStockRows({
      items: [item("a")],
      suppliers: [mill],
      sales: steady("a", 90),
      openLines: [],
      settings,
      today: TODAY,
    });
    expect(row.plan.unitsPerDay).toBeCloseTo(1, 5);
    // 1/day × (20 lead + 30 cover) − 10 on hand.
    expect(row.plan.suggestedQty).toBe(40);
    expect(row.due).toBe(true);
    expect(row.health.health).toBe("under");
    expect(row.unitCost).toBe(12.5);
  });

  it("counts what's on its way from orders that have gone out, not drafts", () => {
    const rows = buildStockRows({
      items: [item("a")],
      suppliers: [mill],
      sales: steady("a", 90),
      openLines: [
        { stock_item_id: "a", qty_ordered: 30, qty_received: 10, status: "partial" },
        { stock_item_id: "a", qty_ordered: 50, qty_received: 0, status: "draft" },
      ],
      settings,
      today: TODAY,
    });
    expect(rows[0].onOrder).toBe(20);
    expect(rows[0].plan.suggestedQty).toBe(20);
  });

  it("something that hasn't sold in three months gets no suggestion", () => {
    const [row] = buildStockRows({
      items: [item("a")],
      suppliers: [mill],
      sales: [],
      openLines: [],
      settings,
      today: TODAY,
    });
    expect(row.plan.suggestedQty).toBe(0);
    expect(row.due).toBe(false);
    expect(row.health.health).toBe("nosales");
  });
});

describe("suggested orders", () => {
  const rows = () =>
    buildStockRows({
      items: [
        item("a"),
        item("b", { variant_title: "Small", unit_cost: 5 }),
        item("c", { supplier_id: null }),
        item("d", { hidden: true }),
      ],
      suppliers: [{ ...mill, moq: 100 }],
      sales: [...steady("a", 90), ...steady("b", 90), ...steady("c", 90), ...steady("d", 90)],
      openLines: [],
      settings,
      today: TODAY,
    });

  it("groups what's due by supplier, leaving out hidden items and ones with no supplier", () => {
    const [order, ...rest] = draftOrders(rows(), TODAY);
    expect(rest).toEqual([]);
    expect(order.lines.map((l) => l.stock_item_id).sort()).toEqual(["a", "b"]);
    expect(order.expectedOn).toBe("2026-12-10");
  });

  it("scales the order up to the supplier's minimum", () => {
    const [order] = draftOrders(rows(), TODAY);
    expect(order.bumpedToMinimum).toBe(true);
    expect(order.totalUnits).toBe(100);
    expect(order.lines.map((l) => l.qty)).toEqual([50, 50]);
    expect(order.totalCost).toBe(50 * 12.5 + 50 * 5);
  });

  it("knows which items are worth planning", () => {
    const planned = rows().filter(isPlanned);
    expect(planned.map((r) => r.item.id)).toEqual(["a", "b", "c"]);
  });
});

describe("wording", () => {
  it("names an item with its option", () => {
    expect(itemName({ title: "Wool rug", variant_title: "Large" })).toBe("Wool rug · Large");
    expect(itemName({ title: "Yarn", variant_title: null })).toBe("Yarn");
  });
  it("says how far away a date is", () => {
    expect(relativeDay(new Date(2026, 10, 20), TODAY)).toBe("today");
    expect(relativeDay(new Date(2026, 10, 25), TODAY)).toBe("in 5 days");
    expect(relativeDay(new Date(2026, 10, 17), TODAY)).toBe("3 days ago");
    // Said the way TuftStock's list says it.
    expect(relativeDay(new Date(2026, 11, 4), TODAY)).toBe("in 14 days");
    expect(relativeDay(new Date(2026, 9, 21), TODAY)).toBe("about 1 month ago");
    expect(relativeDay(new Date(2026, 11, 25), TODAY)).toBe("in about 1 month");
    expect(relativeDay(new Date(2027, 0, 9), TODAY)).toBe("in about 2 months");
    expect(relativeDay(new Date(2027, 0, 25), TODAY)).toBe("in 2 months");
    expect(relativeDay(new Date(2027, 10, 20), TODAY)).toBe("in about 1 year");
    expect(relativeDay(null, TODAY)).toBe("–");
  });
});
