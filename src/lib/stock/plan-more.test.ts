import { describe, expect, it } from "vitest";
import { DEFAULT_STOCK_SETTINGS, parseStockSettings } from "./config";
import {
  buildStockRows,
  draftOrders,
  draftOrdersForItems,
  explainSuggestion,
  isAtRisk,
  isPlanned,
  matchesSkipWords,
  notPlannedReason,
  topSellerIds,
  type ItemRow,
  type SupplierRow,
} from "./plan";
import { csvTable, searchRows, sortRows, toGridRow, viewRows } from "./views";

const TODAY = "2026-11-20";
const item = (id: string, overrides: Partial<ItemRow> = {}): ItemRow => ({
  id,
  title: `Item ${id}`,
  variant_title: null,
  sku: `SKU-${id}`,
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
const mill: SupplierRow = {
  id: "s1",
  name: "Hill Mill",
  lead_time_days: 20,
  coverage_days: 30,
  moq: 1,
  moq_applies_to: "order",
};
const dye: SupplierRow = { ...mill, id: "s2", name: "Dye Works" };
/** `perDay` a day for the last `days` days. */
const steady = (id: string, days: number, perDay = 1) =>
  Array.from({ length: days }, (_, i) => {
    const d = new Date(2026, 10, 20 - i);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { stock_item_id: id, day, units: perDay };
  });
const settings = { ...DEFAULT_STOCK_SETTINGS, seasonality: false };
const build = (items: ItemRow[], suppliers: SupplierRow[] = [mill], ids?: string[]) =>
  buildStockRows({
    items,
    suppliers,
    sales: (ids ?? items.map((i) => i.id)).flatMap((id) => steady(id, 90)),
    openLines: [],
    settings,
    today: TODAY,
  });

describe("case packs and smallest orders", () => {
  // One a day, ten on hand, 20 days to arrive + 30 of cover: the engine says 40.
  it("rounds the suggestion up to whole cases, and keeps the engine's own figure", () => {
    const [row] = build([item("a", { case_pack: 36 })]);
    expect(row.plan.suggestedQty).toBe(40);
    expect(row.suggestedQty).toBe(72);
    expect(row.casePack).toBe(36);
    expect(toGridRow(row, TODAY).cases).toBe("2 cases of 36");
  });

  it("an item with no case pack (or a case of one) is ordered in units", () => {
    const [a, b] = build([item("a"), item("b", { case_pack: 1 })]);
    expect([a.suggestedQty, a.casePack, b.suggestedQty, b.casePack]).toEqual([40, null, 40, null]);
  });

  it("the item's own smallest order wins over the supplier's, and counts per item", () => {
    const perItem: SupplierRow = { ...mill, moq: 50, moq_applies_to: "sku" };
    const [own, theirs] = build([item("a", { moq: 60 }), item("b")], [perItem]);
    expect([own.suggestedQty, own.minimum, own.plan.moqApplied]).toEqual([60, 60, true]);
    expect([theirs.suggestedQty, theirs.minimum]).toEqual([50, 50]);
    // Under a supplier whose minimum is for the whole order, only the item's own applies here.
    const [mine, plain] = build([item("a", { moq: 60 }), item("b")], [{ ...mill, moq: 500 }]);
    expect([mine.suggestedQty, mine.minimum]).toEqual([60, 60]);
    expect([plain.suggestedQty, plain.minimum]).toEqual([40, 1]);
  });

  it("smallest order first, then whole cases", () => {
    const [row] = build([item("a", { moq: 50, case_pack: 24 })]);
    expect(row.plan.suggestedQty).toBe(50);
    expect(row.suggestedQty).toBe(72);
  });

  it("an order raised to the supplier's minimum still comes out in whole cases", () => {
    const rows = build([item("a", { case_pack: 36 }), item("b")], [{ ...mill, moq: 200 }]);
    const [order] = draftOrders(rows, TODAY);
    // 72 + 40 = 112, scaled to 200 by largest remainder (129 / 71), then a to whole cases.
    expect(order.bumpedToMinimum).toBe(true);
    expect(order.lines.map((l) => [l.stock_item_id, l.qty, l.cases])).toEqual([
      ["a", 144, "4 cases of 36"],
      ["b", 71, null],
    ]);
    expect(order.totalUnits).toBe(215);
    expect(order.totalCost).toBe(215 * 12.5);
  });

  it("nothing to order stays at nothing, whatever the case size", () => {
    const [row] = build([item("a", { on_hand: 500, case_pack: 36 })]);
    expect(row.suggestedQty).toBe(0);
  });
});

describe("leaving items out of reordering", () => {
  it("reads the words from settings, with gift cards left out from the start", () => {
    expect(DEFAULT_STOCK_SETTINGS.skip_words).toEqual(["gift card"]);
    expect(parseStockSettings({ version: 1 }).skip_words).toEqual(["gift card"]);
    expect(parseStockSettings({ version: 1, skip_words: [] }).skip_words).toEqual([]);
  });

  it("matches a word anywhere in the name, whatever the capitals", () => {
    expect(matchesSkipWords({ title: "Tuft Gift Card", variant_title: "$50" }, ["gift card"])).toBe(
      true,
    );
    expect(matchesSkipWords({ title: "Yarn", variant_title: "Sample pack" }, ["SAMPLE"])).toBe(
      true,
    );
    expect(matchesSkipWords({ title: "Gift wrap", variant_title: null }, ["gift card"])).toBe(
      false,
    );
    expect(matchesSkipWords({ title: "Gift card", variant_title: null }, [])).toBe(false);
    expect(matchesSkipWords({ title: "Anything", variant_title: null }, [" ", "x"])).toBe(false);
  });

  it("hidden items and rule matches are never suggested, and say why", () => {
    const rows = build([
      item("a"),
      item("b", { hidden: true }),
      item("c", { title: "Gift card" }),
      item("d", { tracked: false }),
      item("e", { product_status: "ARCHIVED" }),
    ]);
    expect(rows.map(notPlannedReason)).toEqual([null, "hidden", "rule", "untracked", "archived"]);
    expect(rows.filter(isPlanned).map((r) => r.item.id)).toEqual(["a"]);
    expect(draftOrders(rows, TODAY).flatMap((o) => o.lines.map((l) => l.stock_item_id))).toEqual([
      "a",
    ]);
    const views = viewRows(rows, TODAY);
    expect(views.hidden.map((r) => r.item.id)).toEqual(["b", "c", "d", "e"]);
    expect(views.all.map((r) => r.item.id)).toEqual(["a"]);
    expect(toGridRow(rows[1], TODAY)).toMatchObject({
      left: "You said don't reorder",
      hiddenByHand: true,
    });
    expect(toGridRow(rows[2], TODAY).hiddenByHand).toBe(false);
  });
});

describe("drafting orders from ticked items", () => {
  const rows = () =>
    buildStockRows({
      items: [
        item("a"),
        item("b", { supplier_id: "s2", case_pack: 12 }),
        item("c", { supplier_id: "s2", supplier_sku: "DW-9" }),
        item("none", { supplier_id: null }),
        item("gone", { supplier_id: "s3" }),
        item("plenty", { on_hand: 900 }),
        item("off", { hidden: true }),
        item("unticked"),
      ],
      suppliers: [mill, dye, { ...mill, id: "s3", name: "Old Mill", archived_at: "2026-01-01" }],
      sales: ["a", "b", "c", "none", "gone", "plenty", "off", "unticked"].flatMap((id) =>
        steady(id, 90),
      ),
      openLines: [],
      settings,
      today: TODAY,
    });
  const ticked = ["a", "b", "c", "none", "gone", "plenty", "off", "not-an-item"];

  it("makes one order per supplier, with suggested quantities in whole cases", () => {
    const { orders } = draftOrdersForItems(rows(), ticked, TODAY);
    expect(orders.map((o) => o.supplier.name).sort()).toEqual(["Dye Works", "Hill Mill"]);
    const dyeOrder = orders.find((o) => o.supplier.id === "s2")!;
    expect(dyeOrder.lines.map((l) => [l.stock_item_id, l.qty, l.cases, l.supplier_sku])).toEqual([
      ["b", 48, "4 cases of 12", null],
      ["c", 40, null, "DW-9"],
    ]);
    expect(orders.find((o) => o.supplier.id === "s1")!.lines.map((l) => l.stock_item_id)).toEqual([
      "a",
    ]);
  });

  it("hands back what couldn't go on an order, by reason, instead of dropping it", () => {
    const picked = draftOrdersForItems(rows(), ticked, TODAY);
    expect(picked.noSupplier.map((r) => r.item.id)).toEqual(["none", "gone"]);
    expect(picked.nothingToOrder.map((r) => r.item.id)).toEqual(["plenty"]);
    expect(picked.notPlanned.map((r) => r.item.id)).toEqual(["off"]);
  });

  it("takes ticked items whatever their order-by date, unlike the suggested orders", () => {
    // 45 on hand at one a day: order by is more than two weeks off, so it isn't "due"...
    const far = build([item("a", { on_hand: 45 })]);
    expect(far[0].due).toBe(false);
    expect(draftOrders(far, TODAY)).toEqual([]);
    // ...but ticking it still drafts what the engine suggests.
    const { orders } = draftOrdersForItems(far, ["a"], TODAY);
    expect(orders[0].lines.map((l) => l.qty)).toEqual([5]);
  });

  it("nothing ticked that can be ordered means no orders", () => {
    expect(draftOrdersForItems(rows(), ["none", "plenty"], TODAY).orders).toEqual([]);
  });
});

describe("saying how the number was reached", () => {
  it("in plain words: what sells, what's here, when it runs out, how it was rounded", () => {
    const [row] = build([item("a", { case_pack: 36 })]);
    expect(explainSuggestion(row, TODAY)).toBe(
      "Sells about 30 a month. 10 on the shelf, runs out in 10 days. To last the 20 days it takes to arrive and 30 days after, order 40, rounded up to 2 cases of 36 (72).",
    );
  });

  it("mentions what's on the way, spare stock and a smallest order", () => {
    const [row] = buildStockRows({
      items: [item("a", { safety_stock: 5, moq: 60 })],
      suppliers: [mill],
      sales: steady("a", 90),
      openLines: [{ stock_item_id: "a", qty_ordered: 8, qty_received: 0, status: "ordered" }],
      settings,
      today: TODAY,
    });
    expect(explainSuggestion(row, TODAY)).toBe(
      "Sells about 30 a month. 10 on the shelf, 8 on the way, runs out in 3 weeks. To last the 20 days it takes to arrive and 30 days after, keeping 5 spare, order 60 (raised to the smallest order of 60).",
    );
  });

  it("says so when there's enough, or when nothing sells", () => {
    const [enough] = build([item("a", { on_hand: 500 })]);
    expect(explainSuggestion(enough, TODAY)).toMatch(
      /^Sells about 30 a month\. 500 on the shelf: enough for now, runs out in \d+ months\.$/,
    );
    const [dead] = build([item("a")], [mill], []);
    expect(explainSuggestion(dead, TODAY)).toBe(
      "Nothing sold in 90 days, so there's nothing to suggest.",
    );
  });
});

describe("the Everything grid", () => {
  const rows = () =>
    buildStockRows({
      items: [
        item("top", { price: 100, on_hand: 5 }),
        item("slow", { price: 1, on_hand: 5 }),
        item("dead", { on_hand: 7 }),
        item("fine", { price: 1, on_hand: 400, supplier_id: null }),
        item("b1", { price: 1, on_hand: 400 }),
      ],
      suppliers: [mill],
      sales: ["top", "slow", "fine", "b1"].flatMap((id) => steady(id, 90)),
      openLines: [{ stock_item_id: "fine", qty_ordered: 9, qty_received: 0, status: "ordered" }],
      settings,
      today: TODAY,
    });

  it("at-risk top sellers: the top fifth by sales that need ordering within a week", () => {
    const all = rows();
    const top = topSellerIds(all);
    // Five planned items: the top fifth is one, by units × price. "slow" needs
    // ordering just as soon, but isn't a best seller.
    expect([...top]).toEqual(["top"]);
    expect(all.filter((row) => isAtRisk(row, top, TODAY)).map((r) => r.item.id)).toEqual(["top"]);
    expect(viewRows(all, TODAY).atrisk.map((r) => r.item.id)).toEqual(["top"]);
  });

  it("dead stock, on its way and no supplier each have their view", () => {
    const views = viewRows(rows(), TODAY);
    expect(views.nosales.map((r) => r.item.id)).toEqual(["dead"]);
    expect(views.onorder.map((r) => r.item.id)).toEqual(["fine"]);
    expect(views.nosupplier.map((r) => r.item.id)).toEqual(["fine"]);
  });

  it("sorts by any column, keeping items with no date at the bottom either way", () => {
    const all = rows();
    const soonest = sortRows(all, "orderBy", "asc").map((r) => r.item.id);
    expect(soonest.slice(0, 2).sort()).toEqual(["slow", "top"]);
    expect(soonest.at(-1)).toBe("dead");
    expect(sortRows(all, "orderBy", "desc").at(-1)!.item.id).toBe("dead");
    expect(sortRows(all, "have", "desc")[0].item.on_hand).toBe(400);
    expect(sortRows(all, "price", "desc")[0].item.id).toBe("top");
    expect(sortRows(all, "item", "asc").map((r) => r.item.id)).toEqual([
      "b1",
      "dead",
      "fine",
      "slow",
      "top",
    ]);
    // The original is left as it was.
    expect(all[0].item.id).toBe("top");
  });

  it("searches by name, SKU, supplier or the supplier's own code", () => {
    const all = build([item("a", { supplier_sku: "HM-77" }), item("b")]);
    expect(searchRows(all, "hm-77").map((r) => r.item.id)).toEqual(["a"]);
    expect(searchRows(all, "sku-b").map((r) => r.item.id)).toEqual(["b"]);
    expect(searchRows(all, "hill mill")).toHaveLength(2);
    expect(searchRows(all, "  ")).toHaveLength(2);
  });

  it("writes the view as a spreadsheet, with the columns asked for", () => {
    const all = build([item("a", { case_pack: 36, supplier_sku: "HM-77", price: "20" })]);
    expect(csvTable(all, ["have", "suggest", "casePack", "runsOut", "price"])).toEqual([
      ["Item", "SKU", "Supplier's code", "Sells for", "Case", "Have", "Runs out", "Suggest"],
      ["Item a", "SKU-a", "HM-77", "20.00", 36, 10, "2026-11-30", 72],
    ]);
  });
});
