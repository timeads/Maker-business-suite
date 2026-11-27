import { z } from "zod";
import { splitCents } from "./lines";
import { DASHBOARD_MODULE } from "./schema";

/**
 * The 3-year projection, the earlier dashboard's rule on whole cents:
 *
 *   the starting year is the books' last twelve complete months: their
 *   revenue, shared among the business lines as the shop (and the books'
 *   own revenue, where it counts) split it over the same months, or all of
 *   it as "other" with nothing to split it by; their cost of goods; and
 *   their running costs. Each year after grows each line, cost of goods
 *   and running costs by their own yearly rate.
 *
 * The rates are this config (`dashboard` / `projection`), with the earlier
 * dashboard's starting rates (a tenth a year, running costs three in a
 * hundred). Pure.
 */
export const PROJECTION_MODULE = DASHBOARD_MODULE;
export const PROJECTION_KEY = "projection";
export const PROJECTION_YEARS = 3;

const id = z.string().regex(/^[a-z0-9-]{1,40}$/);
const rate = z.number().int().min(-100).max(1000);

export const projectionSettingsSchema = z.object({
  version: z.literal(1),
  /** Yearly growth per line, whole percents; a line not listed grows by `other_growth`. */
  line_growth: z.record(id, rate).default({}),
  other_growth: rate.default(10),
  cogs_growth: rate.default(10),
  fixed_growth: rate.default(3),
});
export type ProjectionSettings = z.infer<typeof projectionSettingsSchema>;

export const DEFAULT_PROJECTION_SETTINGS: ProjectionSettings = projectionSettingsSchema.parse({
  version: 1,
});

export function parseProjectionSettings(body: unknown): ProjectionSettings {
  const parsed = projectionSettingsSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_PROJECTION_SETTINGS;
}

export type ProjectionYear = {
  label: string;
  /** Per line id (and "other"), whole cents. */
  byLine: Map<string, number>;
  revenue: number;
  cogs: number;
  grossProfit: number;
  costs: number;
  net: number;
  grossShare: number | null;
  netShare: number | null;
};

const grow = (cents: number, percent: number) => Math.round((cents * (100 + percent)) / 100);

const year = (label: string, byLine: Map<string, number>, cogs: number, costs: number) => {
  const revenue = [...byLine.values()].reduce((a, b) => a + b, 0);
  const grossProfit = revenue - cogs;
  const net = grossProfit - costs;
  return {
    label,
    byLine,
    revenue,
    cogs,
    grossProfit,
    costs,
    net,
    grossShare: revenue !== 0 ? grossProfit / revenue : null,
    netShare: revenue !== 0 ? net / revenue : null,
  };
};

export const OTHER = "other";

export function projection(input: {
  lines: readonly { id: string }[];
  /** The books' twelve months: revenue, cost of goods and running costs, whole cents. */
  books: { revenue: number; cogs: number; costs: number };
  /** How the shop (and the books, where counted) split revenue over the same months, by line id. */
  mix: ReadonlyMap<string, number>;
  settings: ProjectionSettings;
  /** The year the first projected year is, e.g. 2027. */
  firstYear: number;
}): ProjectionYear[] {
  const ids = input.lines.map((l) => l.id);
  const weights = ids.map((lineId) => Math.max(0, input.mix.get(lineId) ?? 0));
  const shared =
    weights.some((w) => w > 0) && input.books.revenue !== 0
      ? splitCents(input.books.revenue, weights)
      : null;
  const start = new Map<string, number>(
    shared && shared.length === ids.length
      ? ids.map((lineId, i) => [lineId, shared[i]])
      : [[OTHER, input.books.revenue]],
  );
  const years: ProjectionYear[] = [
    year("Last 12 months", start, input.books.cogs, input.books.costs),
  ];
  for (let i = 1; i <= PROJECTION_YEARS; i++) {
    const prev = years[i - 1];
    const next = new Map<string, number>();
    for (const [lineId, cents] of prev.byLine) {
      const pct =
        lineId === OTHER
          ? input.settings.other_growth
          : (input.settings.line_growth[lineId] ?? input.settings.other_growth);
      next.set(lineId, grow(cents, pct));
    }
    years.push(
      year(
        String(input.firstYear + i - 1),
        next,
        grow(prev.cogs, input.settings.cogs_growth),
        grow(prev.costs, input.settings.fixed_growth),
      ),
    );
  }
  return years;
}

/** The projection as spreadsheet rows, the heading first; dollars and percents as numbers. */
export function projectionTable(
  years: readonly ProjectionYear[],
  lineName: (id: string) => string,
): (string | number | null)[][] {
  const keys = [...(years[0]?.byLine.keys() ?? [])];
  const dollars = (cents: number) => Math.round(cents) / 100;
  const pct = (share: number | null) => (share === null ? null : Math.round(share * 1000) / 10);
  return [
    ["", ...years.map((y) => y.label)],
    ...keys.map((k) => [
      k === OTHER ? "Other revenue" : `${lineName(k)} revenue`,
      ...years.map((y) => dollars(y.byLine.get(k) ?? 0)),
    ]),
    ["Revenue", ...years.map((y) => dollars(y.revenue))],
    ["Cost of goods", ...years.map((y) => dollars(y.cogs))],
    ["Gross profit", ...years.map((y) => dollars(y.grossProfit))],
    ["Gross margin, %", ...years.map((y) => pct(y.grossShare))],
    ["Running costs", ...years.map((y) => dollars(y.costs))],
    ["Net income", ...years.map((y) => dollars(y.net))],
    ["Net margin, %", ...years.map((y) => pct(y.netShare))],
  ];
}
