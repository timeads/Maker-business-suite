import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MultiLineChart } from "../../../components/charts/multi-line-chart";
import { endLabels, payoffChart, tooltipRows } from "./payoff-chart";
import type { Projection, ProjectionSeries } from "./projection";

// Made-up debts and figures: nothing here is a real business's.
const months = ["2027-01", "2027-02", "2027-03"];
const debt = (id: string, values: number[], payoff: string | null = null): ProjectionSeries => ({
  id,
  kind: "debt",
  name: id,
  values,
  payoff,
  words: payoff ? `Paid off ${payoff}` : "Not paid off within five years",
});
const projectionOf = (debts: ProjectionSeries[]): Projection => {
  const totals = months.map((_, i) => debts.reduce((s, d) => s + d.values[i], 0));
  return {
    months,
    series: [
      {
        id: "total",
        kind: "total",
        name: "All your debts",
        values: totals,
        payoff: null,
        words: "x",
      },
      ...debts,
      {
        id: "fund",
        kind: "fund",
        name: "Emergency fund",
        values: [100, 200, 300],
        payoff: null,
        words: "No target set yet",
      },
    ],
  };
};
const words = {
  money: (cents: number) => `$${(cents / 100).toFixed(2)}`,
  axisMoney: (cents: number) => `$${Math.round(cents / 100)}`,
  monthLabel: (m: string) => m.slice(5),
  monthLong: (m: string) => `month ${m}`,
};

describe("the payoff chart's lines", () => {
  it("gives the largest debt the first colour, and each its own dash and marker", () => {
    const chart = payoffChart(
      projectionOf([debt("Small", [500, 0, 0], "2027-02"), debt("Big", [9000, 8000, 7000])]),
      words,
    );
    expect(chart.lines.map((l) => [l.id, l.slot])).toEqual([
      ["Big", 1],
      ["Small", 2],
      ["fund", null],
    ]);
    expect(chart.lines[0].dash).not.toBe(chart.lines[1].dash);
    expect(chart.lines[0].texts).toEqual(["$90.00", "$80.00", "$70.00"]);
    expect(chart.total.texts).toEqual(["$95.00", "$80.00", "$70.00"]);
    expect(chart.ticks[0]).toEqual({ value: 0, label: "$0" });
    expect(chart.ticks[chart.ticks.length - 1].value).toBeGreaterThanOrEqual(9000);
  });

  it("past eight, adds the smallest together as Other debts, and says so", () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      debt(`D${String(i + 1).padStart(2, "0")}`, [(12 - i) * 1000, (12 - i) * 500, 0], "2027-03"),
    );
    const chart = payoffChart(projectionOf(many), words);
    const own = chart.lines.filter((l) => l.kind === "debt");
    expect(own.map((l) => l.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(own.map((l) => l.name)).toEqual([
      "D01",
      "D02",
      "D03",
      "D04",
      "D05",
      "D06",
      "D07",
      "D08",
    ]);
    const other = chart.lines.find((l) => l.kind === "other");
    expect(other).toMatchObject({
      name: "Other debts",
      slot: null,
      members: ["D09", "D10", "D11"],
    });
    expect(other?.values).toEqual([4000 + 3000 + 2000, 2000 + 1500 + 1000, 0]);
    expect(other?.words).toBe("All paid off month 2027-03");
    expect(chart.caption).toContain("the other 3 (D09, D10, D11)");
    // Nine lines at most for debts, never a ninth colour.
    expect(new Set(chart.lines.map((l) => l.slot)).size).toBe(9);
  });

  it("lists every line, the total and the fund in the tooltip, leaving out lines switched off", () => {
    const chart = payoffChart(
      projectionOf([debt("Big", [9000, 8000, 7000]), debt("Small", [500, 0, 0], "2027-02")]),
      words,
    );
    expect(tooltipRows(chart, 1).map((r) => [r.name, r.text])).toEqual([
      ["Big", "$80.00"],
      ["Small", "Paid off"],
      ["All your debts", "$80.00"],
      ["Emergency fund", "$2.00"],
    ]);
    // Switched off: gone from the tooltip, still in the total.
    expect(tooltipRows(chart, 0, new Set(["Big"])).map((r) => [r.name, r.text])).toEqual([
      ["Small", "$5.00"],
      ["All your debts", "$95.00"],
      ["Emergency fund", "$1.00"],
    ]);
    expect(tooltipRows(chart, 7)).toEqual([]);
  });

  it("says when there is nothing to pay down", () => {
    const chart = payoffChart(projectionOf([]), words);
    expect(chart.lines.map((l) => l.id)).toEqual(["fund"]);
    expect(chart.caption).toMatch(/Nothing owed/);
  });

  it("names lines at their ends only where the names don't collide", () => {
    const lines = [
      { id: "a", name: "Alpha", values: [1000, 900] },
      { id: "b", name: "Beta", values: [1000, 890] },
      { id: "c", name: "Gamma", values: [400, 0] },
    ];
    const place = { x: (i: number) => 50 + i * 100, y: (c: number) => 300 - c / 5, right: 400 };
    const labels = endLabels(lines, place);
    // Alpha and Beta end two pixels apart: only one of them is named there.
    expect(labels.map((l) => l.id).sort()).toEqual(["a", "c"]);
  });
});

describe("the chart's table view", () => {
  it("holds every month, every line's figure and the total", () => {
    const chart = payoffChart(
      projectionOf([debt("Big", [9000, 8000, 7000]), debt("Small", [500, 0, 0], "2027-02")]),
      words,
    );
    const html = renderToStaticMarkup(
      createElement(MultiLineChart, { chart, valueLabel: "Owed at the end of the month" }),
    );
    expect(html).toContain("View as a table");
    for (const text of ["month 2027-01", "month 2027-03", "$90.00", "$70.00", "$95.00", "$3.00"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain("All your debts");
    // The legend names every line and can switch each off.
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(3);
  });
});
