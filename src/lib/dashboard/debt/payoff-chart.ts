import { DASHES, MARKERS, SLOTS, type Marker } from "../../charts/palette";
import { niceTicks } from "../format";
import type { Projection } from "./projection";

/**
 * The payoff projection as ONE line chart, a colour per debt (the owner's
 * choice, like the earlier dashboard's "Payoff projection + emergency fund";
 * the one exception to the house's single series colour, see
 * `lib/charts/palette.ts`). Pure: the projection's figures in, every word
 * and figure the chart draws out, worked out on the server so server and
 * browser always agree.
 *
 * - Each debt is a line in its own slot, largest balance first (slot 1). A
 *   plan that pays other debts is one debt here, as everywhere: covered
 *   debts are already folded into it.
 * - Past eight, the eight largest keep their own lines and the rest are
 *   added up as one "Other debts" line in the neutral ink, dotted, and the
 *   caption says which.
 * - The emergency fund is a line of its own in the neutral ink (it's money
 *   put by, not a debt), long-dashed.
 * - The total of every debt isn't drawn (it would dwarf the rest); it is in
 *   the tooltip and the table.
 */

export type ChartLine = {
  id: string;
  kind: "debt" | "other" | "fund";
  name: string;
  /** 1..8 for a debt's own colour; null for the neutral ink. */
  slot: number | null;
  dash: string;
  marker: Marker;
  /** End-of-month figures, whole cents. */
  values: number[];
  /** Each figure in words. */
  texts: string[];
  /** "Paid off Nov 2027". */
  words: string;
  /** For "Other debts": the debts in it. */
  members: string[];
};

export type ChartMonth = { key: string; label: string; longLabel: string };

export type PayoffChart = {
  months: ChartMonth[];
  lines: ChartLine[];
  /** Every debt together, per month (the plan's total), and its words. */
  total: { values: number[]; texts: string[]; words: string };
  /** Round steps for the one money axis, in cents, with their labels. */
  ticks: { value: number; label: string }[];
  /** What the chart shows, in a sentence or two. */
  caption: string;
};

export function payoffChart(
  projection: Projection,
  words: {
    money: (cents: number) => string;
    /** A compact amount for the axis ("$12K"). */
    axisMoney: (cents: number) => string;
    monthLabel: (month: string) => string;
    monthLong: (month: string) => string;
  },
): PayoffChart {
  const months = projection.months.map((month) => ({
    key: month,
    label: words.monthLabel(month),
    longLabel: words.monthLong(month),
  }));
  const texts = (values: number[]) => values.map((v) => words.money(v));

  // Largest owed first (at the plan's first month), then by name: slot 1 is the biggest.
  const debts = projection.series
    .filter((s) => s.kind === "debt")
    .map((s, at) => ({ s, at }))
    .sort(
      (a, b) =>
        (b.s.values[0] ?? 0) - (a.s.values[0] ?? 0) ||
        a.s.name.localeCompare(b.s.name) ||
        a.at - b.at,
    )
    .map((one) => one.s);
  const own = debts.slice(0, SLOTS);
  const rest = debts.slice(SLOTS);

  const lines: ChartLine[] = own.map((s, i) => ({
    id: s.id,
    kind: "debt",
    name: s.name,
    slot: i + 1,
    dash: DASHES[i],
    marker: MARKERS[i],
    values: s.values,
    texts: texts(s.values),
    words: s.words,
    members: [],
  }));
  if (rest.length > 0) {
    const values = months.map((_, i) => rest.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
    const lastPaid = rest.every((s) => s.payoff)
      ? rest.map((s) => s.payoff as string).sort()[rest.length - 1]
      : null;
    lines.push({
      id: "other",
      kind: "other",
      name: "Other debts",
      slot: null,
      dash: "1.5 3",
      marker: "circle",
      values,
      texts: texts(values),
      words: lastPaid
        ? `All paid off ${words.monthLong(lastPaid)}`
        : "Not all paid off within five years",
      members: rest.map((s) => s.name),
    });
  }
  const fund = projection.series.find((s) => s.kind === "fund");
  if (fund) {
    lines.push({
      id: "fund",
      kind: "fund",
      name: fund.name,
      slot: null,
      dash: "10 4",
      marker: "square",
      values: fund.values,
      texts: texts(fund.values),
      words: fund.words,
      members: [],
    });
  }

  const total = projection.series.find((s) => s.kind === "total");
  const totalValues = total?.values ?? months.map(() => 0);
  const top = Math.max(1, ...lines.flatMap((l) => l.values));
  const ticks = niceTicks(0, top / 100).map((value) => ({
    value: Math.round(value * 100),
    label: words.axisMoney(Math.round(value * 100)),
  }));

  const counted = debts.length;
  const caption = [
    counted === 0
      ? "Nothing owed for the plan to pay down."
      : `What's owed on ${counted === 1 ? "your debt" : `each of your ${counted} debts`} at the end of each month, all on one scale, with the emergency fund.`,
    rest.length > 0
      ? `The ${SLOTS} largest have a line each; the other ${rest.length} (${rest.map((s) => s.name).join(", ")}) are added together as “Other debts”.`
      : "",
    "A plan that pays other debts is one line.",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    months,
    lines,
    total: { values: totalValues, texts: texts(totalValues), words: total?.words ?? "" },
    ticks,
    caption,
  };
}

export type TooltipRow = {
  id: string;
  name: string;
  text: string;
  slot: number | null;
  kind: ChartLine["kind"] | "total";
};

/**
 * What the tooltip lists at a month: every debt line shown (in the legend's
 * order), then "Other debts", the total of every debt, and the fund. A line
 * switched off in the legend is left out; the total always counts every debt.
 */
export function tooltipRows(
  chart: PayoffChart,
  index: number,
  hidden: ReadonlySet<string> = new Set(),
): TooltipRow[] {
  if (index < 0 || index >= chart.months.length) return [];
  const row = (l: ChartLine): TooltipRow => ({
    id: l.id,
    name: l.name,
    text: l.values[index] <= 0 && l.kind !== "fund" ? "Paid off" : l.texts[index],
    slot: l.slot,
    kind: l.kind,
  });
  const shown = chart.lines.filter((l) => !hidden.has(l.id));
  return [
    ...shown.filter((l) => l.kind !== "fund").map(row),
    {
      id: "total",
      name: "All your debts",
      text: chart.total.texts[index],
      slot: null,
      kind: "total" as const,
    },
    ...shown.filter((l) => l.kind === "fund").map(row),
  ];
}

/**
 * Direct labels at the end of each line (its last month still owing, or the
 * last month for the fund), kept only where they don't collide: a legend
 * always names every line as well. `y` maps cents to pixels; `x` a month's
 * index to pixels. Returns the label for each line that fits.
 */
export function endLabels(
  lines: readonly Pick<ChartLine, "id" | "name" | "values">[],
  place: { x: (index: number) => number; y: (cents: number) => number; right: number },
  charWidth = 6.4,
  lineHeight = 14,
): { id: string; x: number; y: number; name: string }[] {
  const boxes: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const out: { id: string; x: number; y: number; name: string }[] = [];
  const candidates = lines
    .map((l) => {
      const last = l.values.reduce((at, v, i) => (v > 0 ? i : at), -1);
      return { l, last };
    })
    .filter((c) => c.last >= 0)
    .sort((a, b) => b.l.values[b.last] - a.l.values[a.last]);
  for (const { l, last } of candidates) {
    const width = l.name.length * charWidth;
    let x = place.x(last) + 6;
    if (x + width > place.right) x = place.x(last) - 6 - width;
    const y = place.y(l.values[last]);
    const box = { x0: x, x1: x + width, y0: y - lineHeight / 2, y1: y + lineHeight / 2 };
    const clash = boxes.some(
      (b) => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1,
    );
    if (clash || x < 0) continue;
    boxes.push(box);
    out.push({ id: l.id, x, y, name: l.name });
  }
  return out;
}
