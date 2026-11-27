import { z } from "zod";
import { DASHBOARD_MODULE } from "./schema";

/**
 * Revenue settings for Money: which figure counts as revenue, whether a
 * class sale counts in the month the class runs, and the business's own
 * lines with the rules that put each sale in one.
 *
 * Data, like every other setting (CLAUDE.md rule 4): stored in `configs`
 * under module "dashboard", key "revenue", parsed on every read. Nothing
 * about any one business lives in code: the lines, their names and the words
 * the rules look for are all the workspace's own.
 *
 * Pure: no network, no database, safe in the browser.
 */
export const REVENUE_MODULE = DASHBOARD_MODULE;
export const REVENUE_KEY = "revenue";

export const REVENUE_FIGURES = ["net_sales", "order_totals"] as const;
export type RevenueFigure = (typeof REVENUE_FIGURES)[number];

/** How each figure is named wherever Money shows it. */
export const FIGURE_WORDS: Record<
  RevenueFigure,
  { name: string; lower: string; detail: string; choice: string }
> = {
  net_sales: {
    name: "Net sales",
    lower: "net sales",
    detail: "what items sold for after discounts and refunds, before tax and shipping",
    choice:
      "Net sales: what your items sold for, after discounts and refunds, before tax and shipping",
  },
  order_totals: {
    name: "Order totals",
    lower: "order totals",
    detail: "what shoppers paid, with tax and shipping, refunds taken out",
    choice: "Order totals: what shoppers paid, with tax and shipping in and refunds taken out",
  },
};

export const MATCH_KINDS = ["order_tag", "product_tag", "product_type", "workshop"] as const;
export type MatchKind = (typeof MATCH_KINDS)[number];

/** What each kind of rule looks at, in a maker's words. */
export const MATCH_WORDS: Record<MatchKind, { label: string; hint: string; needsWords: boolean }> =
  {
    order_tag: {
      label: "The order has a tag",
      hint: "One or more tags, with commas between",
      needsWords: true,
    },
    product_tag: {
      label: "The product has a tag",
      hint: "One or more tags, with commas between",
      needsWords: true,
    },
    product_type: {
      label: "The product's type is",
      hint: "One or more types, with commas between",
      needsWords: true,
    },
    workshop: {
      label: "It's a workshop sold through your shop (from Bookings)",
      hint: "No words needed",
      needsWords: false,
    },
  };

const id = z.string().regex(/^[a-z0-9-]{1,40}$/);
const word = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => !value.includes(","), { message: "One word or phrase per entry" });

export const businessLineSchema = z.object({
  id,
  name: z.string().trim().min(1).max(40),
});
export type BusinessLine = z.infer<typeof businessLineSchema>;

export const lineRuleSchema = z
  .object({
    id,
    match: z.enum(MATCH_KINDS),
    words: z.array(word).max(20).default([]),
    line: id,
  })
  .refine((rule) => !MATCH_WORDS[rule.match].needsWords || rule.words.length > 0, {
    message: "This kind of rule needs at least one word to look for",
    path: ["words"],
  });
export type LineRule = z.infer<typeof lineRuleSchema>;

/**
 * What one of the books' income accounts counts as, for paid invoices booked
 * to it: a business line's revenue, or left out, either because it holds the
 * shop's own sales (already counted from the shop, so counting it again would
 * count it twice) or for another reason. An account with no choice counts
 * nowhere and is shown apart until a person decides.
 */
export const bookAccountChoiceSchema = z.union([
  z.object({ line: id }).strict(),
  z.object({ skip: z.enum(["shop", "other"]) }).strict(),
]);
export type BookAccountChoice = z.infer<typeof bookAccountChoiceSchema>;

export const bookAccountSchema = z.object({
  /** The books' own id for the account, when known; else the exact name decides. */
  ref: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,60}$/)
    .nullable()
    .default(null),
  name: z.string().trim().min(1).max(200),
  choice: bookAccountChoiceSchema,
});
export type BookAccount = z.infer<typeof bookAccountSchema>;

/**
 * Revenue that didn't come through the shop, from the books. Off until a
 * person switches it on, so nothing a workspace already sees changes:
 * - `invoices`: paid invoices, before tax, by the invoice's day, each line in
 *   the line its income account is pointed at (`accounts`);
 * - `other_income`: the books' "other income" (interest, one-off income),
 *   which never holds shop sales, counted in `other_income_line` or, with no
 *   line, as other revenue beside the lines.
 */
export const booksRevenueSchema = z.object({
  invoices: z.boolean().default(false),
  other_income: z.boolean().default(false),
  other_income_line: id.nullable().default(null),
  accounts: z.array(bookAccountSchema).max(200).default([]),
});
export type BooksRevenue = z.infer<typeof booksRevenueSchema>;

export const DEFAULT_BOOKS_REVENUE: BooksRevenue = {
  invoices: false,
  other_income: false,
  other_income_line: null,
  accounts: [],
};

export const revenueSettingsSchema = z
  .object({
    version: z.literal(1),
    figure: z.enum(REVENUE_FIGURES).default("net_sales"),
    /** A class sale counts in the month the class runs, not the month it was bought. */
    by_class_date: z.boolean().default(false),
    lines: z.array(businessLineSchema).max(12).default([]),
    /** Where a sale goes when no rule matches it. Set whenever there are lines. */
    default_line: id.nullable().default(null),
    /** Checked from the top; the first that matches decides. */
    rules: z.array(lineRuleSchema).max(60).default([]),
    /** Revenue from the books beside the shop's. */
    books: booksRevenueSchema.default(DEFAULT_BOOKS_REVENUE),
  })
  .superRefine((value, ctx) => {
    const ids = new Set(value.lines.map((line) => line.id));
    if (ids.size !== value.lines.length) {
      ctx.addIssue({ code: "custom", path: ["lines"], message: "Each line needs its own id" });
    }
    const names = new Set(value.lines.map((line) => line.name.toLowerCase()));
    if (names.size !== value.lines.length) {
      ctx.addIssue({ code: "custom", path: ["lines"], message: "Each line needs its own name" });
    }
    if (value.lines.length > 0 && (!value.default_line || !ids.has(value.default_line))) {
      ctx.addIssue({
        code: "custom",
        path: ["default_line"],
        message: "Choose which line takes sales no rule matches",
      });
    }
    if (value.lines.length === 0 && value.default_line !== null) {
      ctx.addIssue({ code: "custom", path: ["default_line"], message: "There are no lines yet" });
    }
    if (new Set(value.rules.map((rule) => rule.id)).size !== value.rules.length) {
      ctx.addIssue({ code: "custom", path: ["rules"], message: "Each rule needs its own id" });
    }
    value.rules.forEach((rule, index) => {
      if (!ids.has(rule.line)) {
        ctx.addIssue({
          code: "custom",
          path: ["rules", index, "line"],
          message: "A rule must point at one of the lines",
        });
      }
    });
    const books = value.books;
    if (books.other_income_line !== null && !ids.has(books.other_income_line)) {
      ctx.addIssue({
        code: "custom",
        path: ["books", "other_income_line"],
        message: "Other income must go to one of the lines",
      });
    }
    const keys = new Set<string>();
    books.accounts.forEach((account, index) => {
      const key = account.ref ? `ref:${account.ref}` : `name:${account.name}`;
      if (keys.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["books", "accounts", index],
          message: "Each account can only be chosen once",
        });
      }
      keys.add(key);
      if ("line" in account.choice && !ids.has(account.choice.line)) {
        ctx.addIssue({
          code: "custom",
          path: ["books", "accounts", index, "choice"],
          message: "An account must point at one of the lines",
        });
      }
    });
  });
export type RevenueSettings = z.infer<typeof revenueSettingsSchema>;

export const DEFAULT_REVENUE_SETTINGS: RevenueSettings = {
  version: 1,
  figure: "net_sales",
  by_class_date: false,
  lines: [],
  default_line: null,
  rules: [],
  books: DEFAULT_BOOKS_REVENUE,
};

/** The stored settings, or the defaults when there are none or they don't parse. */
export function parseRevenueSettings(body: unknown): RevenueSettings {
  const parsed = revenueSettingsSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_REVENUE_SETTINGS;
}

export const hasLines = (settings: RevenueSettings) =>
  settings.lines.length > 0 && settings.default_line !== null;

// ---------------------------------------------------------------------------
// Which line a sale belongs to
// ---------------------------------------------------------------------------

/**
 * How a tag or type is compared: capitals, outer spaces and the choice of
 * hyphen, underscore or space between words don't matter, so "Private
 * workshop", "private-workshop" and "private_workshop" are one word. The
 * database's twin is `private.money_word()`.
 */
export function sameWord(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[-_\s]+/g, " ");
}

/** What a rule can look at for one sold item (or an order with no items). */
export type LineFacts = {
  orderTags: readonly string[];
  productTags: readonly string[];
  productType: string | null;
  /** The product is the one a Bookings workshop is sold through. */
  workshop: boolean;
};

function ruleMatches(rule: LineRule, facts: LineFacts): boolean {
  const wanted = new Set(rule.words.map(sameWord));
  const any = (values: readonly string[]) => values.some((value) => wanted.has(sameWord(value)));
  switch (rule.match) {
    case "order_tag":
      return any(facts.orderTags);
    case "product_tag":
      return any(facts.productTags);
    case "product_type":
      return facts.productType !== null && wanted.has(sameWord(facts.productType));
    case "workshop":
      return facts.workshop;
  }
}

/**
 * The line a sale belongs to: the first rule from the top that matches,
 * else the default line. Null only when the workspace has no lines.
 */
export function lineFor(settings: RevenueSettings, facts: LineFacts): string | null {
  if (!hasLines(settings)) return null;
  for (const rule of settings.rules) {
    if (ruleMatches(rule, facts)) return rule.line;
  }
  return settings.default_line;
}

// ---------------------------------------------------------------------------
// What an order counts as revenue, in whole cents
// ---------------------------------------------------------------------------

/** An amount the database holds as numeric(14, 2), to whole cents with no float sums. */
export function toCents(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const text = typeof value === "number" ? value.toFixed(2) : value.trim();
  const match = text.match(/^(-?)(\d+)(?:\.(\d{1,2})\d*)?$/);
  if (!match) {
    const parsed = Number(text);
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
  }
  const cents = Number(match[2]) * 100 + Number((match[3] ?? "0").padEnd(2, "0"));
  return match[1] === "-" && cents !== 0 ? -cents : cents;
}

export type OrderMoney = {
  net_sales: number | string;
  total: number | string;
  cancelled: boolean;
  is_test: boolean;
  financial_status: string | null;
};

/** Paid back in full, or never paid: no revenue under order totals. */
const NOT_A_SALE = new Set(["REFUNDED", "VOIDED"]);

/**
 * What one order counts as revenue under each figure, in whole cents.
 *
 * - Cancelled and test orders count for nothing, under either figure (as the
 *   suite has always done).
 * - Net sales: the shop's current subtotal, items after discounts and
 *   refunds, before tax and shipping. Exactly what Money showed before.
 * - Order totals: the shop's current total, with tax and shipping, which the
 *   shop lowers as items are refunded. An order refunded in full or voided
 *   counts for nothing (the earlier dashboard's `countsAsSale`), so a refund
 *   is always taken out, even one the shop's total doesn't follow.
 *
 * The database's twin is `private.money_order_cents()`; a test holds them equal.
 */
export function orderRevenueCents(order: OrderMoney, figure: RevenueFigure): number {
  if (order.cancelled || order.is_test) return 0;
  if (figure === "order_totals") {
    if (NOT_A_SALE.has((order.financial_status ?? "").toUpperCase())) return 0;
    return toCents(order.total);
  }
  return toCents(order.net_sales);
}

/**
 * Shares an order's revenue among its items by what each item sold for, in
 * whole cents that add back up exactly: each gets its rounded-down share,
 * and the cents left over go to the largest remainders (the first item wins
 * a tie). Items that sold for nothing get nothing; with no weight at all the
 * whole amount stays together (`[total]`). The database's twin is in
 * `money_line_revenue()`.
 */
export function splitCents(total: number, weights: readonly number[]): number[] {
  const clean = weights.map((w) => (Number.isFinite(w) && w > 0 ? Math.round(w) : 0));
  const sum = clean.reduce((a, b) => a + b, 0);
  if (sum === 0) return [total];
  const sign = total < 0 ? -1 : 1;
  const whole = Math.abs(total);
  // BigInt keeps cents × weight exact for any order the shop can hold.
  const big = BigInt(whole);
  const bigSum = BigInt(sum);
  const parts = clean.map((w, index) => {
    const product = big * BigInt(w);
    return { index, base: Number(product / bigSum), rest: product % bigSum };
  });
  let left = whole - parts.reduce((a, p) => a + p.base, 0);
  const byRest = [...parts].sort((a, b) =>
    a.rest === b.rest ? a.index - b.index : a.rest > b.rest ? -1 : 1,
  );
  for (const part of byRest) {
    if (left <= 0) break;
    part.base += 1;
    left -= 1;
  }
  return parts.map((p) => (p.base === 0 ? 0 : sign * p.base));
}

// ---------------------------------------------------------------------------
// Adding sales up by line
// ---------------------------------------------------------------------------

/** One row of `money_line_revenue()`: revenue for items that share every fact a rule reads. */
export type LineGroup = {
  period: string;
  order_tags: string[] | null;
  product_external_id: string | null;
  product_tags: string[] | null;
  product_type: string | null;
  workshop: boolean;
  dated: boolean;
  revenue_cents: number;
  units: number;
};

export const factsOf = (group: {
  order_tags: string[] | null;
  product_tags: string[] | null;
  product_type: string | null;
  workshop: boolean;
}): LineFacts => ({
  orderTags: group.order_tags ?? [],
  productTags: group.product_tags ?? [],
  productType: group.product_type,
  workshop: group.workshop,
});

export type LineTotal = {
  id: string;
  name: string;
  cents: number;
  units: number;
  isDefault: boolean;
};

/** Revenue per line, in the order the lines are set up, every line present. */
export function totalsByLine(settings: RevenueSettings, groups: readonly LineGroup[]): LineTotal[] {
  const totals = new Map(
    settings.lines.map((line) => [
      line.id,
      {
        id: line.id,
        name: line.name,
        cents: 0,
        units: 0,
        isDefault: line.id === settings.default_line,
      },
    ]),
  );
  for (const group of groups) {
    const line = lineFor(settings, factsOf(group));
    const total = line ? totals.get(line) : undefined;
    if (!total) continue;
    total.cents += group.revenue_cents;
    total.units += group.units;
  }
  return [...totals.values()];
}

/** Revenue per line per period, every period present for every line. */
export function seriesByLine(
  settings: RevenueSettings,
  groups: readonly LineGroup[],
  periods: readonly string[],
): { id: string; name: string; cents: Map<string, number> }[] {
  const series = settings.lines.map((line) => ({
    id: line.id,
    name: line.name,
    cents: new Map(periods.map((period) => [period, 0])),
  }));
  const byId = new Map(series.map((s) => [s.id, s]));
  for (const group of groups) {
    const line = lineFor(settings, factsOf(group));
    const s = line ? byId.get(line) : undefined;
    if (!s || !s.cents.has(group.period)) continue;
    s.cents.set(group.period, (s.cents.get(group.period) ?? 0) + group.revenue_cents);
  }
  return series;
}

/** One sold item (or an item-less order) of a recent order, for the settings page's count. */
export type RecentLine = {
  order_id: string;
  order_tags: string[] | null;
  product_tags: string[] | null;
  product_type: string | null;
  workshop: boolean;
};

/**
 * How many recent orders had something no rule matched, so it fell to the
 * default line, and how many orders that was out of.
 */
export function defaultLineCount(
  settings: RevenueSettings,
  lines: readonly RecentLine[],
): { orders: number; toDefault: number; wholly: number } {
  const byOrder = new Map<string, { any: boolean; all: boolean }>();
  for (const line of lines) {
    const toDefault = lineFor(settings, factsOf(line)) === settings.default_line;
    const seen = byOrder.get(line.order_id) ?? { any: false, all: true };
    byOrder.set(line.order_id, { any: seen.any || toDefault, all: seen.all && toDefault });
  }
  let toDefault = 0;
  let wholly = 0;
  for (const order of byOrder.values()) {
    if (order.any) toDefault += 1;
    if (order.all) wholly += 1;
  }
  return { orders: byOrder.size, toDefault, wholly };
}

/** A short id for a new line or rule, from its name where that works. */
export function idFrom(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "line";
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}
