import { describe, expect, it } from "vitest";
import { DEFAULT_STOCK_SETTINGS, parseSavedViews, parseStockSettings } from "./config";
import {
  buildStockRows,
  closureOrders,
  draftOrders,
  draftOrdersForItems,
  emptyDaysSince,
  explainSuggestion,
  isAtRisk,
  isPlanned,
  matchesSkipWords,
  notPlannedReason,
  topSellerIds,
  type ItemRow,
  type SupplierRow,
} from "./plan";
import {
  closureNote,
  csvTable,
  rankRows,
  searchRows,
  sortRows,
  toGridRow,
  viewRows,
} from "./views";

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

  it("suggests no order for a supplier that isn't used any more", () => {
    const all = rows();
    expect(all.find((r) => r.item.id === "gone")!.due).toBe(true);
    const suggested = draftOrders(all, TODAY);
    expect(suggested.map((o) => o.supplier.name)).not.toContain("Old Mill");
    expect(suggested.flatMap((o) => o.lines.map((l) => l.stock_item_id))).not.toContain("gone");
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
      "Sells about 30 a month. 10 on the shelf, 8 on the way, runs out in 18 days. To last the 20 days it takes to arrive and 30 days after, keeping 5 spare, order 60 (raised to the smallest order of 60).",
    );
  });

  it("says so when there's enough, or when nothing sells", () => {
    const [enough] = build([item("a", { on_hand: 500 })]);
    expect(explainSuggestion(enough, TODAY)).toMatch(
      /^Sells about 30 a month\. 500 on the shelf: enough for now, runs out in over 1 year\.$/,
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
      ["Product", "SKU", "Supplier's code", "Stock", "Stock Out", "Suggest", "Sells for", "Case"],
      ["Item a", "SKU-a", "HM-77", 10, "2026-11-30", 72, "20.00", 36],
    ]);
  });
});

describe("sold-out days", () => {
  // Sold one a day for the last 30 days; before that the shelf was empty for 60.
  // (One older sale, so the item isn't treated as brand new.)
  const longAgo = (id: string) => ({ stock_item_id: id, day: "2026-07-23", units: 1 });
  const sales = [...steady("a", 30), longAgo("a")];
  const emptyDays = Array.from({ length: 60 }, (_, i) => {
    const d = new Date(2026, 10, 20 - 30 - i);
    return {
      stock_item_id: "a",
      day: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    };
  });
  const build = (days?: typeof emptyDays) =>
    buildStockRows({
      items: [item("a", { on_hand: 5 }), item("b", { on_hand: 5 })],
      suppliers: [mill],
      sales: [...sales, ...steady("b", 30), longAgo("b")],
      openLines: [],
      emptyDays: days,
      settings,
      today: TODAY,
    });

  it("are left out of the sales rate, so an item that keeps selling out isn't under-ordered", () => {
    const [plain] = build();
    const [censored, untouched] = build(emptyDays);
    // Without the count: 30 units over 90 days at 75%, plus the last 30 days at 25%.
    expect(plain.plan.unitsPerDay).toBeCloseTo(0.5, 4);
    expect(plain.soldOutDays).toBe(0);
    // With it: 30 units over the 30 days it could be bought.
    expect(censored.plan.unitsPerDay).toBeCloseTo(1, 4);
    expect(censored.soldOutDays).toBe(60);
    expect(censored.plan.explain).toContain("60 out-of-stock days excluded");
    expect(censored.suggestedQty).toBeGreaterThan(plain.suggestedQty);
    expect(explainSuggestion(censored, TODAY)).toContain("60 sold-out days left out");
    // Another item's empty days change nothing for this one.
    expect(untouched.plan.unitsPerDay).toBeCloseTo(0.5, 4);
    expect(explainSuggestion(untouched, TODAY)).not.toContain("sold-out");
  });

  it("a day with a sale is never counted as sold out", () => {
    const [row] = build([{ stock_item_id: "a", day: TODAY }]);
    expect(row.soldOutDays).toBe(0);
    expect(row.plan.unitsPerDay).toBeCloseTo(0.5, 4);
  });

  it("only asks for the days the sums can use", () => {
    expect(emptyDaysSince("2026-11-20")).toBe("2026-05-24");
  });
});

describe("costs on stock rows", () => {
  const build = () =>
    buildStockRows({
      items: [
        item("own", { own_cost: "9.00", unit_cost: "12.50" }),
        item("avg", { unit_cost: "12.50" }),
        item("shop", { unit_cost: "12.50" }),
        item("none", { unit_cost: null }),
      ],
      suppliers: [mill],
      sales: ["own", "avg", "shop", "none"].flatMap((id) => steady(id, 90)),
      openLines: [],
      received: [
        { stock_item_id: "own", units: 10, total: "200.00" },
        { stock_item_id: "avg", units: "3", total: "20.00" },
      ],
      settings,
      today: TODAY,
    });

  it("takes your own figure, then the average of deliveries, then the shop's", () => {
    const rows = build();
    expect(rows.map((r) => [r.cost.source, r.cost.cost.toFixed(2), r.unitCost])).toEqual([
      ["own", "9.00", 9],
      ["average", "6.67", 6.67],
      ["shop", "12.50", 12.5],
      ["none", "0.00", 0],
    ]);
    const grid = rows.map((r) => toGridRow(r, TODAY));
    expect(grid.map((g) => [g.cost, g.costFrom])).toEqual([
      [9, "your own figure"],
      [6.67, "average of your deliveries"],
      [12.5, "from your shop"],
      [null, "not set"],
    ]);
    expect(csvTable(rows, ["cost"]).map((line) => line[3])).toEqual([
      "Costs you",
      "9.00",
      "6.67",
      "12.50",
      "",
    ]);
  });

  it("suggested orders start each line from that cost", () => {
    const [order] = draftOrders(build(), TODAY);
    const cost = Object.fromEntries(order.lines.map((l) => [l.stock_item_id, l.unit_cost]));
    expect(cost).toEqual({ own: 9, avg: 6.67, shop: 12.5, none: 0 });
  });
});

describe("planning figures in the grid", () => {
  it("shows what's used, and keeps the item's own figures beside it for changing", () => {
    const rows = buildStockRows({
      items: [
        item("own", {
          lead_time_days: 7,
          coverage_days: 45,
          safety_stock: 4,
          moq: 6,
          case_pack: 12,
          own_cost: "3.20",
        }),
        item("plain"),
      ],
      suppliers: [mill],
      sales: [],
      openLines: [],
      settings,
      today: TODAY,
    });
    const [own, plain] = rows.map((r) => toGridRow(r, TODAY));
    expect([own.lead, own.cover, own.spare, own.minimum, own.casePack]).toEqual([7, 45, 4, 6, 12]);
    expect(own.own).toEqual({ cost: "3.20", lead: "7", cover: "45", moq: "6" });
    // Nothing typed: the supplier's figures are used, and the boxes start empty.
    expect([plain.lead, plain.cover, plain.spare]).toEqual([
      mill.lead_time_days,
      mill.coverage_days,
      0,
    ]);
    expect(plain.own).toEqual({ cost: "", lead: "", cover: "", moq: "" });
    expect(sortRows(rows, "cover", "desc").map((r) => r.item.id)).toEqual(["own", "plain"]);
    expect(sortRows(rows, "spare", "asc").map((r) => r.item.id)).toEqual(["plain", "own"]);
    expect(csvTable(rows, ["cover", "spare"])).toEqual([
      ["Product", "SKU", "Supplier's code", "Order covers (days)", "Keep spare"],
      ["Item own", "SKU-own", "", 45, 4],
      ["Item plain", "SKU-plain", "", mill.coverage_days, 0],
    ]);
  });
});

describe("the reorder list as TuftStock shows it", () => {
  const rows = () =>
    buildStockRows({
      items: [
        item("top", { on_hand: 5, variant_image_url: "https://cdn.shopify.com/top-red.jpg" }),
        item("slow", { on_hand: 5, image_url: "https://cdn.shopify.com/slow.jpg" }),
        item("dead", { on_hand: 7 }),
        item("gone", { on_hand: 0 }),
        item("off", { on_hand: 5, hidden: true }),
      ],
      suppliers: [mill],
      sales: ["top", "slow", "off"].flatMap((id) => steady(id, 90)),
      openLines: [
        // Two sent orders still owing some of "slow"; the older one is number 7.
        {
          stock_item_id: "slow",
          qty_ordered: 9,
          qty_received: 0,
          status: "ordered",
          order_number: 12,
          order_created_at: "2026-11-10T10:00:00Z",
        },
        {
          stock_item_id: "slow",
          qty_ordered: 6,
          qty_received: 2,
          status: "partial",
          order_number: 7,
          order_created_at: "2026-11-01T10:00:00Z",
        },
        // All of this line has arrived: it no longer counts as an order to wait for.
        {
          stock_item_id: "slow",
          qty_ordered: 4,
          qty_received: 4,
          status: "partial",
          order_number: 3,
          order_created_at: "2026-10-01T10:00:00Z",
        },
      ],
      revenue: [
        { stock_item_id: "top", revenue: "750.00" },
        { stock_item_id: "slow", revenue: "150.00" },
        { stock_item_id: "off", revenue: "100.00" },
      ],
      settings,
      today: TODAY,
    });

  it("% of revenue is each item's share of everything sold in 90 days", () => {
    const all = rows();
    const share = Object.fromEntries(all.map((r) => [r.item.id, r.revenueShare]));
    // Hidden items still count in the total, as in TuftStock.
    expect(share).toEqual({ top: 0.75, slow: 0.15, dead: 0, gone: 0, off: 0.1 });
    expect(toGridRow(all[0], TODAY).pctRev).toBe("75.0%");
    expect(toGridRow(all[2], TODAY).pctRev).toBe("0.0%");
  });

  it("with no sales to add up, the share falls back to units × today's price", () => {
    const all = buildStockRows({
      items: [item("a", { price: 30 }), item("b", { price: 10 })],
      suppliers: [mill],
      sales: ["a", "b"].flatMap((id) => steady(id, 90)),
      openLines: [],
      settings,
      today: TODAY,
    });
    expect(all.map((r) => r.revenueShare)).toEqual([0.75, 0.25]);
  });

  it("the 30-day forecast is the engine's own, and nothing for dead stock", () => {
    const [top, , dead] = rows();
    expect(top.plan.forecast30d).toBe(30);
    expect(toGridRow(top, TODAY).forecast).toBe(30);
    expect(dead.plan.forecast30d).toBe(0);
  });

  it("dead stock: nothing sold in 90 days and some still on the shelf", () => {
    const views = viewRows(rows(), TODAY);
    // "gone" hasn't sold either, but there's none left to be stuck with.
    expect(views.nosales.map((r) => r.item.id)).toEqual(["dead"]);
    expect(views.hidden.map((r) => r.item.id)).toEqual(["off"]);
  });

  it("at-risk top sellers: the top fifth by share, due within a week, with a supplier in use", () => {
    const all = rows();
    // Five items: the top fifth is one.
    expect([...topSellerIds(all)]).toEqual(["top"]);
    expect(viewRows(all, TODAY).atrisk.map((r) => r.item.id)).toEqual(["top"]);
    // The same best seller from a supplier no longer used is nobody's to order.
    const retired = buildStockRows({
      items: [item("top", { on_hand: 5 })],
      suppliers: [{ ...mill, archived_at: "2026-01-01T00:00:00Z" }],
      sales: steady("top", 90),
      openLines: [],
      settings,
      today: TODAY,
    });
    expect(viewRows(retired, TODAY).atrisk).toEqual([]);
  });

  it("the on-order chip counts orders still owing some, and links to the oldest", () => {
    const slow = rows()[1];
    expect(slow.onOrder).toBe(13);
    expect(slow.openOrders).toEqual({ count: 2, firstNumber: 7 });
    expect(toGridRow(slow, TODAY)).toMatchObject({ coming: 13, comingOrders: 2, comingOrder: 7 });
    // The chip's tooltip carries the oldest order's parcels, when there are any.
    expect(toGridRow(slow, TODAY).comingNote).toBeNull();
    expect(
      toGridRow(slow, TODAY, {
        tracking: new Map([
          [7, ["UPS …6784: out for delivery, due Nov 26", "Parcel PRO12: on its way"]],
          [12, ["UPS …0001: on the way"]],
        ]),
      }).comingNote,
    ).toBe("UPS …6784: out for delivery, due Nov 26; Parcel PRO12: on its way");
  });

  it("uses the option's own photo first, then the product's", () => {
    const [top, slow, dead] = rows();
    expect(top.photo).toBe("https://cdn.shopify.com/top-red.jpg");
    expect(slow.photo).toBe("https://cdn.shopify.com/slow.jpg");
    expect(dead.photo).toBeNull();
  });

  it("marks a stock-out that comes before a new order could arrive, and a late reorder", () => {
    const [top, , dead] = rows().map((r) => toGridRow(r, TODAY));
    // 5 left at one a day, 20 days to arrive.
    expect(top).toMatchObject({ runsOut: "in 5 days", runsOutSoon: true, overdue: true });
    expect(top.orderBy).toBe("22 days ago");
    expect(dead).toMatchObject({ runsOut: "–", runsOutSoon: false, overdue: false });
  });

  it("numbers rows by their place with the soonest reorder first, whatever the sort", () => {
    const planned = viewRows(rows(), TODAY).all;
    const ranks = rankRows(planned);
    // Two with no date at all come last, by name.
    expect([ranks.get("dead"), ranks.get("gone")]).toEqual([3, 4]);
    expect([ranks.get("top"), ranks.get("slow")].sort()).toEqual([1, 2]);
    const byName = sortRows(planned, "item", "desc");
    expect(toGridRow(byName[0], TODAY, { rank: ranks.get(byName[0].item.id) }).rank).toBe(
      ranks.get(byName[0].item.id),
    );
  });

  it("sorts and exports the new columns", () => {
    const all = rows();
    expect(sortRows(all, "pctRev", "desc")[0].item.id).toBe("top");
    expect(sortRows(all, "forecast", "desc").at(-1)!.plan.forecast30d).toBe(0);
    const table = csvTable(all.slice(0, 1), ["forecast", "pctRev"]);
    expect(table[0]).toEqual(["Product", "SKU", "Supplier's code", "30D Forecast", "% Rev"]);
    expect(table[1].slice(3)).toEqual([30, "75.0"]);
  });
});

describe("saved views", () => {
  it("reads what was saved and falls back to none when the body is wrong", () => {
    const body = {
      version: 1,
      views: [{ id: "yarn000001", name: "Yarn", q: "yarn", columns: ["sold30", "have"] }],
    };
    expect(parseSavedViews(body).views[0]).toEqual({
      id: "yarn000001",
      name: "Yarn",
      view: "all",
      q: "yarn",
      sort: "orderBy",
      dir: "asc",
      columns: ["sold30", "have"],
      opens_first: false,
    });
    expect(parseSavedViews({ version: 1, views: [{ id: "BAD ID", name: "" }] }).views).toEqual([]);
    expect(parseSavedViews(null).views).toEqual([]);
  });
});

describe("when a supplier is shut", () => {
  // Today is Nov 20, 2026. Hill Mill takes 20 days, an order covers 30, and
  // orders are looked at every 7. Everything here sells one a day.
  const iso = (date: Date | null) =>
    date
      ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
      : null;
  const shut = (name: string, from: string, to: string, supplier = "s1") => ({
    id: `c-${name}`,
    supplier_id: supplier,
    name,
    starts_on: from,
    ends_on: to,
  });
  const rows = (
    closures: ReturnType<typeof shut>[],
    items = [item("a", { on_hand: 60 }), item("other", { on_hand: 60, supplier_id: "s2" })],
  ) =>
    buildStockRows({
      items,
      suppliers: [mill, dye],
      sales: items.flatMap((i) => steady(i.id, 90)),
      openLines: [],
      closures,
      settings,
      today: TODAY,
    });
  const festival = shut("Spring Festival", "2027-01-05", "2027-02-01");

  it("with no closure, the order-by date is the engine's own", () => {
    const [a] = rows([]);
    // 60 on the shelf runs out Jan 19; less 20 days to arrive and 7 to review.
    expect(iso(a.plan.stockOutDate)).toBe("2027-01-19");
    expect(iso(a.plan.reorderDate)).toBe("2026-12-23");
    expect(a.closure).toBeNull();
    expect(a.buildAhead).toBeNull();
    expect(a.suggestedQty).toBe(0);
  });

  it("moves the order-by date earlier so the order lands before they shut", () => {
    const [a, other] = rows([festival]);
    // Ordered Dec 23 it would arrive Jan 12, a week into the closure. It has
    // to arrive Jan 4 instead: order by Dec 15.
    expect(iso(a.plan.reorderDate)).toBe("2026-12-15");
    expect(a.plan.isOverdue).toBe(false);
    expect(a.closure).toMatchObject({
      name: "Spring Festival",
      startsOn: "2027-01-05",
      endsOn: "2027-02-01",
      underWay: false,
    });
    expect(iso(a.closure!.movedFrom)).toBe("2026-12-23");
    // The stock-out date is the shelf's own business and doesn't move.
    expect(iso(a.plan.stockOutDate)).toBe("2027-01-19");
    // Another supplier's item isn't touched by this one's closure.
    expect(other.closure).toBeNull();
    expect(iso(other.plan.reorderDate)).toBe("2026-12-23");
    // The list says so on the row.
    const note = closureNote(a, TODAY)!;
    expect(note.label).toBe("Before Spring Festival");
    expect(note.why).toBe(
      "Hill Mill is shut for Spring Festival (Jan 5 to Feb 1). To arrive before they shut, order in 25 days rather than in about 1 month.",
    );
    expect(toGridRow(a, TODAY).closure).toEqual(note);
    expect(toGridRow(other, TODAY).closure).toBeNull();
  });

  it("sizes that order to last until the first one after they reopen could arrive", () => {
    const [a] = rows([festival]);
    // They reopen Feb 2; an order then arrives Feb 22, 94 days from today.
    // 94 days at one a day, less the 60 on the shelf.
    expect(a.buildAhead).toMatchObject({
      orderBefore: "2026-12-15",
      missed: false,
      nextArrival: "2027-02-22",
      daysToCover: 94,
      qty: 34,
    });
    // The usual sums (20 days + 30) would have asked for nothing.
    expect(a.plan.suggestedQty).toBe(0);
    expect(a.suggestedQty).toBe(34);
    expect(explainSuggestion(a, TODAY)).toBe(
      "Sells about 30 a month. 60 on the shelf, runs out in 2 months. That would do for now, but order 34 to last through Spring Festival, when Hill Mill is shut.",
    );
  });

  it("an order that isn't in the closure's way keeps its date, but is still planned ahead for", () => {
    // 20 on the shelf: runs out Dec 10, order by Nov 13, arriving Dec 3. Well clear.
    const [soon] = rows([festival], [item("soon", { on_hand: 20 })]);
    expect(soon.closure).toBeNull();
    expect(iso(soon.plan.reorderDate)).toBe("2026-11-13");
    // The usual order: 50 days less the 20 here.
    expect(soon.suggestedQty).toBe(30);
    // Before they shut it will need 94 days' worth less the 20.
    expect(soon.buildAhead?.qty).toBe(74);
  });

  it("offers one order per supplier ahead of the closure, feeding the usual draft", () => {
    const all = rows([festival]);
    const cards = closureOrders(all, TODAY);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      closure: { name: "Spring Festival", startsOn: "2027-01-05", endsOn: "2027-02-01" },
      orderBefore: "2026-12-15",
      missed: false,
      dueNow: false,
      nextArrival: "2027-02-22",
      totalUnits: 34,
      // Placed today it is here in 20 days, long before they shut.
      expectedOn: "2026-12-10",
    });
    expect(cards[0].supplier.id).toBe("s1");
    expect(cards[0].lines).toEqual([
      expect.objectContaining({ stock_item_id: "a", qty: 34, unit_cost: 12.5 }),
    ]);
    // Nothing of theirs is due in the next two weeks, so there is no usual order yet.
    expect(draftOrders(all, TODAY)).toEqual([]);
  });

  it("leaves out hidden items, suppliers no longer used and closures too far off to act on", () => {
    expect(
      closureOrders(rows([festival], [item("a", { on_hand: 60, hidden: true })]), TODAY),
    ).toEqual([]);
    const retired = buildStockRows({
      items: [item("a", { on_hand: 60 })],
      suppliers: [{ ...mill, archived_at: "2026-01-01T00:00:00Z" }],
      sales: steady("a", 90),
      openLines: [],
      closures: [festival],
      settings,
      today: TODAY,
    });
    expect(closureOrders(retired, TODAY)).toEqual([]);
    // Shut in June: the last order day is May 11, more than sixty days away.
    const far = rows([shut("Summer break", "2027-06-01", "2027-06-14")]);
    expect(far[0].buildAhead?.orderBefore).toBe("2027-05-11");
    expect(closureOrders(far, TODAY)).toEqual([]);
  });

  it("when the last order day has gone by, says so and sizes for an order placed now", () => {
    // Shut from Dec 1: to land before, the order had to go by Nov 10.
    const late = rows(
      [shut("Stocktake", "2026-12-01", "2026-12-20")],
      [item("low", { on_hand: 10 })],
    );
    const [low] = late;
    // It was already due Nov 3 to arrive Nov 23, before they shut: the date stands.
    expect(low.closure).toBeNull();
    expect(iso(low.plan.reorderDate)).toBe("2026-11-03");
    expect(low.buildAhead).toMatchObject({ orderBefore: "2026-11-10", missed: true });
    // Placed today it can't get going until Dec 21 (31 days), arriving Jan 10:
    // 20 + 30 + 31 days of sales, less the 10 here.
    expect(low.suggestedQty).toBe(71);
    expect(low.buildAhead?.qty).toBe(71);
    const [card] = closureOrders(late, TODAY);
    expect(card).toMatchObject({ missed: true, dueNow: true, expectedOn: "2027-01-10" });
    expect(card.lines[0].qty).toBe(71);
    // The usual order for that supplier says the same, date and all.
    const [usual] = draftOrders(late, TODAY);
    expect(usual.expectedOn).toBe("2027-01-10");
    expect(usual.lines[0].qty).toBe(71);
    expect(explainSuggestion(low, TODAY)).toMatch(
      /order 40\. Raised to 71 to last through Stocktake, when Hill Mill is shut\.$/,
    );
  });

  it("while they are shut, counts an order from the day they are back", () => {
    const [low] = rows(
      [shut("Stocktake", "2026-11-10", "2026-12-10")],
      [item("low", { on_hand: 10 })],
    );
    // To have arrived Nov 23 it had to land before Nov 10: order by Oct 20.
    expect(iso(low.plan.reorderDate)).toBe("2026-10-20");
    expect(low.plan.isOverdue).toBe(true);
    expect(low.closure).toMatchObject({ name: "Stocktake", underWay: true });
    expect(closureNote(low, TODAY)!.label).toBe("Shut for Stocktake");
    // No closure is *coming*, so there is nothing to order ahead of.
    expect(low.buildAhead).toBeNull();
    // Back Dec 11 (21 days): 20 + 30 + 21 days of sales, less the 10 here.
    expect(low.suggestedQty).toBe(61);
  });

  it("goes before both closures when the gap between them is shorter than the lead time", () => {
    const [a] = rows([festival, shut("Lantern week", "2027-02-10", "2027-02-14")]);
    expect(iso(a.plan.reorderDate)).toBe("2026-12-15");
    // The first order after the festival (Feb 2) would run into Lantern week:
    // it is counted from Feb 15 instead, arriving Mar 7.
    expect(a.buildAhead).toMatchObject({ nextArrival: "2027-03-07", daysToCover: 107, qty: 47 });
  });

  it("nothing is planned ahead for dead stock", () => {
    const dead = buildStockRows({
      items: [item("dead", { on_hand: 60 })],
      suppliers: [mill],
      sales: [],
      openLines: [],
      closures: [festival],
      settings,
      today: TODAY,
    });
    expect(dead[0]).toMatchObject({ closure: null, buildAhead: null, suggestedQty: 0 });
  });
});
