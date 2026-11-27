import { describe, expect, it } from "vitest";
import { DEFAULT_STOCK_SETTINGS } from "./config";
import {
  costExplained,
  coverFrom,
  leadTimeFrom,
  orderByExplained,
  salesRateExplained,
  suggestionExplained,
} from "./explain";
import { buildStockRows, relativeDay, type ItemRow, type SaleRow } from "./plan";

const TODAY = "2026-11-20";
const settings = { ...DEFAULT_STOCK_SETTINGS, seasonality: false };
const item = (overrides: Partial<ItemRow> = {}): ItemRow => ({
  id: "a",
  title: "Wool rug",
  variant_title: null,
  sku: "a",
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
const steady = (days: number, perDay = 1): SaleRow[] =>
  Array.from({ length: days }, (_, i) => {
    const d = new Date(2026, 10, 20 - i);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { stock_item_id: "a", day, units: perDay };
  });
const rowOf = (
  overrides: Partial<ItemRow> = {},
  more: Partial<Parameters<typeof buildStockRows>[0]> = {},
) =>
  buildStockRows({
    items: [item(overrides)],
    suppliers: [mill],
    sales: steady(90),
    openLines: [],
    settings,
    today: TODAY,
    ...more,
  })[0];

describe("where an item's days come from", () => {
  it("follows the same order the figures do: the item's own, the supplier's, the usual", () => {
    expect(leadTimeFrom(rowOf({ lead_time_days: 5 }))).toBe("item");
    expect(leadTimeFrom(rowOf())).toBe("supplier");
    expect(leadTimeFrom(rowOf({ supplier_id: null }))).toBe("usual");
    expect(coverFrom(rowOf({ coverage_days: 10 }))).toBe("item");
    expect(coverFrom(rowOf())).toBe("supplier");
    expect(coverFrom(rowOf({ supplier_id: null }))).toBe("usual");
  });
});

describe("orderByExplained", () => {
  it("counts back from the run-out day by the days to arrive and the review buffer", () => {
    const row = rowOf();
    const lines = orderByExplained(row, settings, TODAY);
    expect(lines[0]).toBe(
      `At the rate it sells, the 10 on the shelf run out ${relativeDay(row.plan.stockOutDate, TODAY)}.`,
    );
    expect(lines[1]).toContain("less the 20 days it takes to arrive (Hill Mill's figure)");
    expect(lines[1]).toContain(`less your 7 days between sitting down to order`);
    expect(lines[1]).toContain(relativeDay(row.plan.reorderDate, TODAY));
    // Ten left at one a day, 27 days' notice needed: it's overdue.
    expect(lines.at(-1)).toBe("That day has gone by, so it's overdue.");
  });

  it("says when a closure moved it earlier, from the date the sums gave", () => {
    const row = rowOf(
      { on_hand: 60 },
      {
        closures: [
          {
            id: "c1",
            supplier_id: "s1",
            name: "New Year",
            starts_on: "2026-12-20",
            ends_on: "2027-01-05",
          },
        ],
      },
    );
    // Runs out Jan 19; ordering Dec 23 would fall in the closure.
    expect(row.closure).not.toBeNull();
    const lines = orderByExplained(row, settings, TODAY);
    expect(lines.join(" ")).toContain("Hill Mill is shut for New Year, so it moved earlier");
    expect(lines[1]).toContain(relativeDay(row.closure!.movedFrom, TODAY));
  });

  it("says so for something that doesn't sell, or is left out", () => {
    expect(orderByExplained(rowOf({}, { sales: [] }), settings, TODAY)).toEqual([
      "Nothing sold in 90 days, so there's no order-by date.",
    ]);
    expect(orderByExplained(rowOf({ hidden: true }), settings, TODAY)[0]).toBe(
      "It's left out of reordering (hidden by you).",
    );
  });

  it("mentions the months ahead when busy seasons are on", () => {
    const lines = orderByExplained(rowOf(), { ...settings, seasonality: true }, TODAY);
    expect(lines[0]).toMatch(/^At the rate it's expected to sell over the coming months/);
  });
});

describe("suggestionExplained", () => {
  it("walks the sum the engine does", () => {
    const row = rowOf({ safety_stock: 5 });
    expect(suggestionExplained(row)).toEqual([
      "Enough to last the 20 days it takes to arrive and 30 days after (Hill Mill's figure), at the rate it sells.",
      "Plus the 5 you keep spare, less what's on the shelf (10) and on the way (0).",
      `That comes to ${row.plan.suggestedQty}.`,
    ]);
    // 1/day × 50 + 5 − 10.
    expect(row.plan.suggestedQty).toBe(45);
  });

  it("says when the smallest order or whole cases raised it", () => {
    const moq = rowOf({ moq: 100 });
    expect(suggestionExplained(moq)).toContain("Raised to this item's smallest order, 100.");
    const cased = rowOf({ case_pack: 12 });
    expect(suggestionExplained(cased)).toContain(
      `Rounded up to whole cases of 12: ${cased.suggestedQty}.`,
    );
    expect(cased.suggestedQty % 12).toBe(0);
  });

  it("has nothing to suggest when there's plenty, or nothing sells", () => {
    expect(suggestionExplained(rowOf({ on_hand: 500 })).at(-1)).toBe(
      "That comes to nothing, so there's nothing to order yet.",
    );
    expect(suggestionExplained(rowOf({}, { sales: [] }))).toEqual([
      "Nothing sold in 90 days, so nothing is suggested.",
    ]);
  });
});

describe("salesRateExplained", () => {
  it("says the window, the recent share and the seasons", () => {
    const lines = salesRateExplained(rowOf(), settings);
    expect(lines[0]).toBe("About 30 a month (1.00 a day).");
    expect(lines[1]).toBe(
      "Measured over the last 90 days, with the last 30 days counting for 25% of it.",
    );
    expect(lines.at(-1)).toBe("Busy seasons are off, so every month counts the same.");
  });

  it("says when sold-out days were left out, and when it looks further back", () => {
    const row = rowOf(
      {},
      {
        // Four sold in all, the first in October: a slow seller.
        sales: [...steady(3), { stock_item_id: "a", day: "2026-10-01", units: 1 }],
        emptyDays: [
          { stock_item_id: "a", day: "2026-11-10" },
          { stock_item_id: "a", day: "2026-11-11" },
        ],
      },
    );
    const lines = salesRateExplained(row, { seasonality: true });
    expect(lines[1]).toContain("180 days rather than 90, since it sells only now and then");
    expect(lines).toContain("2 days it was sold out are left out, since nobody could buy it then.");
    expect(lines.at(-1)).toMatch(/^Busy seasons are on/);
  });
});

describe("costExplained", () => {
  const money = (n: number) => `$${n.toFixed(2)}`;
  it("names the cost used and where it came from", () => {
    expect(costExplained(rowOf(), money)[1]).toBe("This one uses the cost in your shop: $12.50.");
    expect(costExplained(rowOf({ own_cost: "9.00" }), money)[1]).toBe(
      "This one uses your own figure: $9.00.",
    );
    expect(costExplained(rowOf({ unit_cost: null }), money)[1]).toBe(
      "None of those is known for this one yet, so orders count it as costing nothing.",
    );
  });
});
