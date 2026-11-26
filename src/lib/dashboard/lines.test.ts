import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVENUE_SETTINGS,
  defaultLineCount,
  idFrom,
  lineFor,
  orderRevenueCents,
  parseRevenueSettings,
  revenueSettingsSchema,
  sameWord,
  seriesByLine,
  splitCents,
  toCents,
  totalsByLine,
  type LineFacts,
  type LineGroup,
  type RevenueSettings,
} from "./lines";

const facts = (over: Partial<LineFacts> = {}): LineFacts => ({
  orderTags: [],
  productTags: [],
  productType: null,
  workshop: false,
  ...over,
});

/**
 * The earlier dashboard's rule (`classifyBusinessLine` / `businessLineOf`):
 * private workshop tags first, then custom rug, then workshop or education,
 * else shop products. Here it is nothing but a config.
 */
const EARLIER_RULE: RevenueSettings = revenueSettingsSchema.parse({
  version: 1,
  lines: [
    { id: "shop", name: "Shop products" },
    { id: "custom", name: "Custom rugs" },
    { id: "classes", name: "Workshops" },
    { id: "private", name: "Private workshops" },
  ],
  default_line: "shop",
  rules: [
    { id: "r1", match: "order_tag", words: ["private workshop"], line: "private" },
    { id: "r2", match: "order_tag", words: ["custom rug"], line: "custom" },
    { id: "r3", match: "order_tag", words: ["workshop", "education"], line: "classes" },
  ],
});

describe("which line a sale belongs to", () => {
  it("puts the earlier dashboard's orders where it did, from settings alone", () => {
    const tagged = (tags: string) => lineFor(EARLIER_RULE, facts({ orderTags: tags.split(",") }));
    expect(tagged("private-workshop")).toBe("private");
    expect(tagged("private_workshop")).toBe("private");
    expect(tagged(" Private Workshop ")).toBe("private");
    // Private beats plain workshop, as in the earlier code.
    expect(tagged("workshop,private-workshop")).toBe("private");
    expect(tagged("custom_rug,workshop")).toBe("custom");
    expect(tagged("Education")).toBe("classes");
    expect(tagged("wholesale")).toBe("shop");
    expect(lineFor(EARLIER_RULE, facts())).toBe("shop");
  });

  it("checks rules from the top and the first match wins", () => {
    const settings = revenueSettingsSchema.parse({
      version: 1,
      lines: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
      default_line: "a",
      rules: [
        { id: "first", match: "product_type", words: ["Kit"], line: "b" },
        { id: "second", match: "product_type", words: ["kit"], line: "a" },
      ],
    });
    expect(lineFor(settings, facts({ productType: "KIT" }))).toBe("b");
  });

  it("reads product tags, product types and Bookings workshops", () => {
    const settings = revenueSettingsSchema.parse({
      version: 1,
      lines: [
        { id: "goods", name: "Goods" },
        { id: "classes", name: "Classes" },
        { id: "supplies", name: "Supplies" },
      ],
      default_line: "goods",
      rules: [
        { id: "w", match: "workshop", line: "classes" },
        { id: "t", match: "product_tag", words: ["yarn"], line: "supplies" },
        { id: "p", match: "product_type", words: ["Tools & frames"], line: "supplies" },
      ],
    });
    expect(lineFor(settings, facts({ workshop: true, productTags: ["yarn"] }))).toBe("classes");
    expect(lineFor(settings, facts({ productTags: ["Yarn"] }))).toBe("supplies");
    expect(lineFor(settings, facts({ productType: "tools  &  frames" }))).toBe("supplies");
    expect(lineFor(settings, facts({ productType: "Rugs" }))).toBe("goods");
  });

  it("has nothing to say when no lines are set up", () => {
    expect(lineFor(DEFAULT_REVENUE_SETTINGS, facts({ orderTags: ["workshop"] }))).toBeNull();
  });

  it("treats hyphens, underscores, spaces and capitals as the same", () => {
    expect(sameWord(" Custom_Rug ")).toBe(sameWord("custom-rug"));
    expect(sameWord("custom  rug")).toBe("custom rug");
  });
});

describe("revenue settings", () => {
  it("starts as today's behaviour: net sales, purchase date, no lines", () => {
    expect(parseRevenueSettings(undefined)).toEqual(DEFAULT_REVENUE_SETTINGS);
    expect(parseRevenueSettings({ version: 1 })).toEqual(DEFAULT_REVENUE_SETTINGS);
    expect(parseRevenueSettings({ version: 2 })).toEqual(DEFAULT_REVENUE_SETTINGS);
  });

  it("refuses a rule pointing nowhere, a missing default, twin names and wordless tag rules", () => {
    const base = { version: 1, lines: [{ id: "a", name: "A" }], default_line: "a" };
    expect(revenueSettingsSchema.safeParse(base).success).toBe(true);
    expect(revenueSettingsSchema.safeParse({ ...base, default_line: null }).success).toBe(false);
    expect(revenueSettingsSchema.safeParse({ ...base, default_line: "zz" }).success).toBe(false);
    expect(
      revenueSettingsSchema.safeParse({
        ...base,
        lines: [...base.lines, { id: "b", name: "a" }],
      }).success,
    ).toBe(false);
    expect(
      revenueSettingsSchema.safeParse({
        ...base,
        rules: [{ id: "r", match: "order_tag", words: ["x"], line: "nope" }],
      }).success,
    ).toBe(false);
    expect(
      revenueSettingsSchema.safeParse({
        ...base,
        rules: [{ id: "r", match: "order_tag", words: [], line: "a" }],
      }).success,
    ).toBe(false);
    expect(
      revenueSettingsSchema.safeParse({
        ...base,
        rules: [{ id: "r", match: "order_tag", words: ["a,b"], line: "a" }],
      }).success,
    ).toBe(false);
    expect(
      revenueSettingsSchema.safeParse({
        version: 1,
        lines: [],
        default_line: "a",
      }).success,
    ).toBe(false);
  });

  it("makes short ids from names, never twice", () => {
    expect(idFrom("Private workshops!", new Set())).toBe("private-workshops");
    expect(idFrom("Shop", new Set(["shop"]))).toBe("shop-2");
    expect(idFrom("★", new Set())).toBe("line");
  });
});

describe("what an order counts as revenue", () => {
  const order = {
    net_sales: "250.00",
    total: "275.10",
    cancelled: false,
    is_test: false,
    financial_status: "PAID",
  };

  it("is net sales unless the workspace asks for order totals", () => {
    expect(orderRevenueCents(order, "net_sales")).toBe(25000);
    expect(orderRevenueCents(order, "order_totals")).toBe(27510);
  });

  it("leaves out cancelled and test orders under either figure", () => {
    for (const figure of ["net_sales", "order_totals"] as const) {
      expect(orderRevenueCents({ ...order, cancelled: true }, figure)).toBe(0);
      expect(orderRevenueCents({ ...order, is_test: true }, figure)).toBe(0);
    }
  });

  it("takes refunds out of order totals, even when the shop's total doesn't follow", () => {
    expect(orderRevenueCents({ ...order, financial_status: "REFUNDED" }, "order_totals")).toBe(0);
    expect(orderRevenueCents({ ...order, financial_status: "voided" }, "order_totals")).toBe(0);
    // A partly refunded order counts what the shop says is left.
    expect(
      orderRevenueCents(
        { ...order, total: "137.55", financial_status: "PARTIALLY_REFUNDED" },
        "order_totals",
      ),
    ).toBe(13755);
    // Net sales are exactly what Money has always shown.
    expect(orderRevenueCents({ ...order, financial_status: "REFUNDED" }, "net_sales")).toBe(25000);
  });

  it("reads amounts to whole cents without float sums", () => {
    expect(toCents("0.10")).toBe(10);
    expect(toCents("19.9")).toBe(1990);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents("-4.05")).toBe(-405);
    expect(toCents("-0.00")).toBe(0);
    expect(toCents(null)).toBe(0);
    expect(toCents("1e3")).toBe(100000);
  });
});

describe("sharing an order among its items", () => {
  it("adds back up to the cent, leftovers to the largest remainders", () => {
    expect(splitCents(1000, [1, 1, 1])).toEqual([334, 333, 333]);
    expect(splitCents(27510, [20000, 5000])).toEqual([22008, 5502]);
    for (const [total, weights] of [
      [99999, [3, 7, 11, 13]],
      [1, [5, 5]],
      [123456789, [1, 999999, 31]],
    ] as const) {
      const parts = splitCents(total, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it("gives nothing to free items, and keeps an order with no priced items whole", () => {
    expect(splitCents(500, [0, 200])).toEqual([0, 500]);
    expect(splitCents(500, [0, 0])).toEqual([500]);
    expect(splitCents(500, [])).toEqual([500]);
  });

  it("shares a negative amount the same way", () => {
    expect(splitCents(-1000, [1, 1, 1])).toEqual([-334, -333, -333]);
  });
});

describe("adding sales up by line", () => {
  const group = (over: Partial<LineGroup>): LineGroup => ({
    period: "2026-10-01",
    order_tags: null,
    product_external_id: null,
    product_tags: null,
    product_type: null,
    workshop: false,
    dated: false,
    revenue_cents: 0,
    units: 0,
    ...over,
  });
  const groups = [
    group({ order_tags: ["workshop"], revenue_cents: 9000, units: 2 }),
    group({ order_tags: ["custom-rug"], revenue_cents: 40000, units: 1 }),
    group({ period: "2026-11-01", revenue_cents: 1234, units: 3 }),
    group({ period: "2026-11-01", order_tags: ["Education"], revenue_cents: 4500, units: 1 }),
  ];

  it("totals every line, in the order it is set up, even a line with nothing", () => {
    expect(totalsByLine(EARLIER_RULE, groups)).toEqual([
      { id: "shop", name: "Shop products", cents: 1234, units: 3, isDefault: true },
      { id: "custom", name: "Custom rugs", cents: 40000, units: 1, isDefault: false },
      { id: "classes", name: "Workshops", cents: 13500, units: 3, isDefault: false },
      { id: "private", name: "Private workshops", cents: 0, units: 0, isDefault: false },
    ]);
  });

  it("spreads each line over the periods, with empty periods at zero", () => {
    const series = seriesByLine(EARLIER_RULE, groups, ["2026-09-01", "2026-10-01", "2026-11-01"]);
    expect(series.find((s) => s.id === "classes")?.cents).toEqual(
      new Map([
        ["2026-09-01", 0],
        ["2026-10-01", 9000],
        ["2026-11-01", 4500],
      ]),
    );
  });

  it("counts recent orders that had something fall to the default line", () => {
    const line = (order_id: string, tags: string[] | null) => ({
      order_id,
      order_tags: tags,
      product_tags: null,
      product_type: null,
      workshop: false,
    });
    expect(
      defaultLineCount(EARLIER_RULE, [
        line("o1", ["workshop"]),
        line("o2", null),
        line("o2", null),
        line("o3", ["custom rug"]),
      ]),
    ).toEqual({ orders: 3, toDefault: 1, wholly: 1 });
  });
});
