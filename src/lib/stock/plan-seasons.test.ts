import { describe, expect, it } from "vitest";
import { DEFAULT_STOCK_SETTINGS } from "./config";
import { buildStockRows, peakMark, seasonGroupItems, seasonLeadGroups, type ItemRow } from "./plan";
import { toGridRow } from "./views";

const TODAY = "2026-11-20";
const item = (id: string, overrides: Partial<ItemRow> = {}): ItemRow => ({
  id,
  title: "Wool rug",
  variant_title: id,
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
const steady = (id: string, days: number) =>
  Array.from({ length: days }, (_, i) => {
    const d = new Date(2026, 10, 20 - i);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { stock_item_id: id, day, units: 1 };
  });
const december = {
  id: "holiday001",
  name: "Holiday rush",
  inStockBy: "2026-12-10",
  liftPct: 50,
  note: "",
};
const rows = (seasons = [december], seasonality = true) =>
  buildStockRows({
    items: [item("a")],
    suppliers: [mill],
    sales: steady("a", 90),
    openLines: [],
    seasons,
    settings: { ...DEFAULT_STOCK_SETTINGS, seasonality },
    today: TODAY,
  });

describe("a season's lift", () => {
  it("raises the suggestion for the days that fall in its month, and marks the row", () => {
    const [plain] = rows([]);
    const [lifted] = rows();
    expect(lifted.plan.suggestedQty).toBeGreaterThan(plain.plan.suggestedQty);
    expect(lifted.seasonalFactor).toBe(1.5);
    expect(peakMark(lifted)).toBe("↑1.50×");
    expect(toGridRow(lifted, TODAY).peak).toBe("↑1.50×");
    expect(plain.seasonalFactor).toBe(1);
    expect(peakMark(plain)).toBeNull();
    expect(toGridRow(plain, TODAY).peak).toBeNull();
  });

  it("counts for nothing while planning for busy seasons is switched off", () => {
    const [off] = rows([december], false);
    const [none] = rows([], false);
    expect(off.plan.suggestedQty).toBe(none.plan.suggestedQty);
    expect(off.seasonalFactor).toBe(1);
  });

  it("is ignored once the season's day has passed", () => {
    const [past] = rows([{ ...december, inStockBy: "2026-11-01" }]);
    const [none] = rows([]);
    expect(past.plan.suggestedQty).toBe(none.plan.suggestedQty);
  });

  it("isn't marked when the busy month is past the days the order has to cover", () => {
    const [far] = rows([{ ...december, inStockBy: "2027-06-15" }]);
    expect(peakMark(far)).toBeNull();
  });
});

describe("a season's lead-time groups", () => {
  const built = buildStockRows({
    items: [
      item("a"),
      item("b"),
      item("slow", { lead_time_days: 60 }),
      item("off", { hidden: true }),
      item("loose", { supplier_id: null }),
      item("old", { supplier_id: "s2" }),
    ],
    suppliers: [mill, { ...mill, id: "s2", name: "Gone Co", archived_at: "2026-01-01T00:00:00Z" }],
    sales: [...steady("a", 90), ...steady("slow", 90)],
    openLines: [],
    settings: { ...DEFAULT_STOCK_SETTINGS, seasonality: false },
    today: TODAY,
  });

  it("groups planned items by supplier and days to arrive, leaving out the rest", () => {
    expect(
      seasonLeadGroups(built)
        .map((g) => `${g.supplierName}|${g.leadDays}|${g.itemCount}`)
        .sort(),
    ).toEqual(["Hill Mill|20|2", "Hill Mill|60|1"]);
  });

  it("names the items of a group that have something to order", () => {
    expect(seasonGroupItems(built, "s1", 20).map((row) => row.item.id)).toEqual(["a"]);
    expect(seasonGroupItems(built, "s1", 60).map((row) => row.item.id)).toEqual(["slow"]);
    expect(seasonGroupItems(built, "s2", 20)).toEqual([]);
  });
});
