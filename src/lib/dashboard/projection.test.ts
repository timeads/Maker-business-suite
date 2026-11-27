import { describe, expect, it } from "vitest";
import { projectionExplained } from "./explain";
import {
  DEFAULT_PROJECTION_SETTINGS,
  OTHER,
  parseProjectionSettings,
  projection,
  projectionTable,
} from "./projection";

const LINES = [
  { id: "shop", name: "Shop" },
  { id: "classes", name: "Classes" },
];

describe("the 3-year projection", () => {
  it("shares the books' revenue by the shop's mix and grows each part by its own rate", () => {
    const years = projection({
      lines: LINES,
      books: { revenue: 1000000, cogs: 300000, costs: 400000 },
      mix: new Map([
        ["shop", 30000],
        ["classes", 10000],
      ]),
      settings: { ...DEFAULT_PROJECTION_SETTINGS, line_growth: { classes: 20 } },
      firstYear: 2027,
    });
    expect(years.map((y) => y.label)).toEqual(["Last 12 months", "2027", "2028", "2029"]);
    expect([...years[0].byLine]).toEqual([
      ["shop", 750000],
      ["classes", 250000],
    ]);
    expect(years[0]).toMatchObject({ revenue: 1000000, grossProfit: 700000, net: 300000 });
    // Shop at the standard 10%, classes at 20%, cost of goods 10%, running costs 3%.
    expect([...years[1].byLine]).toEqual([
      ["shop", 825000],
      ["classes", 300000],
    ]);
    expect(years[1]).toMatchObject({ cogs: 330000, costs: 412000, net: 1125000 - 330000 - 412000 });
    expect(years[3].byLine.get("classes")).toBe(432000);
  });

  it("puts everything in other revenue with nothing to split it by", () => {
    const [start, next] = projection({
      lines: LINES,
      books: { revenue: 500, cogs: 0, costs: 0 },
      mix: new Map(),
      settings: { ...DEFAULT_PROJECTION_SETTINGS, other_growth: -10 },
      firstYear: 2027,
    });
    expect([...start.byLine]).toEqual([[OTHER, 500]]);
    expect(next.byLine.get(OTHER)).toBe(450);
    expect(start.grossShare).toBe(1);
  });

  it("starts from the earlier dashboard's rates and writes a spreadsheet", () => {
    expect(parseProjectionSettings(null)).toEqual({
      version: 1,
      line_growth: {},
      other_growth: 10,
      cogs_growth: 10,
      fixed_growth: 3,
    });
    const years = projection({
      lines: [],
      books: { revenue: 10000, cogs: 2500, costs: 5000 },
      mix: new Map(),
      settings: DEFAULT_PROJECTION_SETTINGS,
      firstYear: 2027,
    });
    const table = projectionTable(years, () => "x");
    expect(table[0]).toEqual(["", "Last 12 months", "2027", "2028", "2029"]);
    expect(table.find((r) => r[0] === "Gross margin, %")?.[1]).toBe(75);
    expect(projectionExplained(DEFAULT_PROJECTION_SETTINGS, LINES)).toContain(
      "Classes grows 10% a year.",
    );
  });
});
