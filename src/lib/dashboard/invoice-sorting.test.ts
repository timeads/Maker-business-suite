import { describe, expect, it } from "vitest";
import {
  bookRevenue,
  decideInvoice,
  invoiceSorting,
  isWaiting,
  lineIdsOf,
  placeInvoice,
  type InvoiceGroup,
} from "./book-revenue";
import { invoiceSortSchema, placeWords, storedInvoiceSort } from "./invoices";
import { revenueSettingsSchema, type RevenueSettings } from "./lines";

/**
 * Sorting invoices into lines one at a time: the one rule (`decideInvoice`)
 * and everything built on it. Made-up customers, accounts and figures.
 */

const settings = (books: Record<string, unknown> = {}): RevenueSettings =>
  revenueSettingsSchema.parse({
    version: 1,
    lines: [
      { id: "shop", name: "Shop" },
      { id: "classes", name: "Classes" },
      { id: "custom", name: "Custom work" },
    ],
    default_line: "shop",
    books: {
      invoices: true,
      accounts: [
        { ref: "79", name: "Class income", choice: { line: "classes" } },
        { ref: null, name: "Sales", choice: { skip: "shop" } },
      ],
      customers: [
        { ref: "7", name: "Maple Library", choice: { line: "custom" } },
        { ref: null, name: "Birch Hall", choice: { skip: "other" } },
        { ref: "9", name: "Gone Co", choice: { line: "shop" } },
      ],
      ...books,
    },
  });

const S = settings();
const IDS = lineIdsOf(S);
const lineName = (id: string) => S.lines.find((l) => l.id === id)?.name ?? "a removed line";

const lines = (...parts: [string | null, string | null, number][]) =>
  parts.map(([account_ref, account, cents]) => ({ account_ref, account, cents }));

describe("which line an invoice counts in, strongest first", () => {
  it("is a person's own choice first, then the customer's, then the accounts'", () => {
    const own = { sort: "line", line_id: "shop", customer_ref: "7", customer: "Maple Library" };
    expect(decideInvoice(S.books, IDS, own)).toEqual({ by: "person", choice: { line: "shop" } });
    expect(decideInvoice(S.books, IDS, { ...own, sort: null, line_id: null })).toEqual({
      by: "customer",
      choice: { line: "custom" },
    });
    expect(decideInvoice(S.books, IDS, { customer_ref: "1", customer: "Elm Goods" })).toEqual({
      by: "account",
    });
  });

  it("finds a customer by the books' id, else by the exact name", () => {
    expect(decideInvoice(S.books, IDS, { customer_ref: "7", customer: "Renamed" }).by).toBe(
      "customer",
    );
    expect(decideInvoice(S.books, IDS, { customer_ref: "44", customer: "Birch Hall" })).toEqual({
      by: "customer",
      choice: { skip: "other" },
    });
    // A row read before the books' ids were kept still finds a choice made by id, by name.
    expect(decideInvoice(S.books, IDS, { customer_ref: null, customer: "Maple Library" }).by).toBe(
      "customer",
    );
    expect(decideInvoice(S.books, IDS, { customer_ref: null, customer: "maple library" }).by).toBe(
      "account",
    );
  });

  it("passes over a choice whose line is no longer there", () => {
    const facts = { sort: "line", line_id: "custom", customer_ref: "7", customer: "Maple Library" };
    const without = new Set([...IDS].filter((id) => id !== "custom"));
    // Its own line and its customer's (custom) are both gone: the accounts decide.
    expect(decideInvoice(S.books, without, facts)).toEqual({ by: "account" });
    expect(
      decideInvoice(S.books, without, {
        sort: "split",
        split: { shop: 50, custom: 50 },
      }),
    ).toEqual({ by: "account" });
    expect(decideInvoice(S.books, IDS, { sort: "split", split: { shop: 50, custom: 50 } })).toEqual(
      { by: "person", choice: { split: { shop: 50, custom: 50 } } },
    );
    // A stored split that doesn't add up to 100 counts for nothing.
    expect(decideInvoice(S.books, IDS, { sort: "split", split: { shop: 50, custom: 40 } })).toEqual(
      { by: "account" },
    );
  });

  it("hand-sorted whole ignores each line's account; a split shares the total to the cent", () => {
    const invoiceLines = lines(["79", "Class income", 6000], [null, "Sales", 4001]);
    const whole = placeInvoice(S, { sort: "line", line_id: "custom", lines: invoiceLines });
    expect([...whole.byLine]).toEqual([["custom", 10001]]);
    expect(whole.shop).toBe(0);

    const split = placeInvoice(S, {
      sort: "split",
      split: { shop: 33, classes: 33, custom: 34 },
      lines: invoiceLines,
    });
    const parts = Object.fromEntries(split.byLine);
    expect(parts).toEqual({ classes: 3300, custom: 3401, shop: 3300 });
    expect(Object.values(parts).reduce((a, b) => a + b, 0)).toBe(10001);

    const byAccount = placeInvoice(S, { lines: invoiceLines });
    expect([...byAccount.byLine]).toEqual([["classes", 6000]]);
    expect(byAccount.shop).toBe(4001);
  });

  it("says what still waits, line by line", () => {
    const place = placeInvoice(S, {
      customer: "Elm Goods",
      lines: lines(["79", "Class income", 6000], ["81", "Rentals", 0]),
    });
    expect(place.waiting).toBe(0);
    expect(isWaiting(place)).toBe(true);
    expect(isWaiting(placeInvoice(S, { sort: "shop", lines: lines(["81", "Rentals", 5]) }))).toBe(
      false,
    );
  });
});

describe("an invoice's line in words", () => {
  const words = (facts: Parameters<typeof placeInvoice>[1]) =>
    placeWords(placeInvoice(S, facts), lineName);
  it("says where and why", () => {
    const sold = lines(["79", "Class income", 100]);
    expect(words({ sort: "line", line_id: "custom", lines: sold })).toEqual({
      line: "Custom work",
      why: "Your choice",
      state: "sorted",
    });
    expect(words({ sort: "split", split: { shop: 40, classes: 60 }, lines: sold }).line).toBe(
      "60% Classes, 40% Shop",
    );
    expect(words({ customer_ref: "7", customer: "x", lines: sold })).toEqual({
      line: "Custom work",
      why: "Your choice for this customer",
      state: "sorted",
    });
    expect(words({ lines: sold })).toEqual({
      line: "Classes",
      why: "From its income account",
      state: "sorted",
    });
    expect(words({ lines: lines(["81", "Rentals", 100]) })).toEqual({
      line: "Not sorted yet",
      why: "Its income account has no line yet",
      state: "waiting",
    });
    expect(words({ lines: lines([null, "Sales", 100]) }).line).toBe("Already counted by your shop");
    expect(words({ sort: "left_out", lines: sold })).toMatchObject({
      line: "Left out",
      state: "left_out",
    });
    expect(words({ lines: lines(["79", "Class income", 100], ["81", "Rentals", 5]) })).toEqual({
      line: "Classes; the rest not sorted yet",
      why: "From its income accounts, one with no line yet",
      state: "waiting",
    });
  });
});

describe("the books' revenue with invoices sorted by hand", () => {
  const group = (extra: Partial<InvoiceGroup>): InvoiceGroup => ({
    period: "2026-10-01",
    account_ref: "79",
    account: "Class income",
    cents: 0,
    ...extra,
  });

  // Four invoices, as the database groups them.
  const groups: InvoiceGroup[] = [
    // A: by account only (classes 6000, shop's own 4000).
    group({ cents: 6000 }),
    group({ account_ref: null, account: "Sales", cents: 4000 }),
    // B: a person put it all in custom, whatever its accounts say.
    group({ sort: "line", line_id: "custom", cents: 2000 }),
    group({ sort: "line", line_id: "custom", account_ref: "81", account: "Rentals", cents: 500 }),
    // C: split 33 / 67, on two accounts: shared on its whole total, once.
    group({ sort: "split", split: { shop: 33, classes: 67 }, invoice_id: "c", cents: 1001 }),
    group({
      sort: "split",
      split: { shop: 33, classes: 67 },
      invoice_id: "c",
      account_ref: "81",
      account: "Rentals",
      cents: 2000,
    }),
    // D: its customer's default leaves it out; E: waiting.
    group({ customer: "Birch Hall", cents: 700 }),
    group({ period: "2026-11-01", account_ref: "81", account: "Rentals", cents: 300 }),
  ];

  it("places each by the one rule and adds back up to the cent", () => {
    const out = bookRevenue(S, groups, []);
    expect(Object.fromEntries(out.invoicesByLine)).toEqual({
      classes: 6000 + 2011,
      custom: 2500,
      shop: 990,
    });
    expect(out.leftOut).toBe(4000 + 700);
    expect(out.waiting).toBe(300);
    expect(out.byHand).toBe(2500 + 3001 + 700);
    const placed = [...out.invoicesByLine.values()].reduce((a, b) => a + b, 0);
    const all = groups.reduce((a, g) => a + g.cents, 0);
    expect(placed + out.leftOut + out.waiting).toBe(all);
    // Each line's months add up to its total.
    for (const [line, total] of out.invoicesByLine) {
      const months = [...(out.invoicesByPeriod.get(line) ?? new Map()).values()];
      expect(months.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it("gives the same answer as placing each invoice on its own", () => {
    const c = placeInvoice(S, {
      sort: "split",
      split: { shop: 33, classes: 67 },
      lines: lines(["79", "Class income", 1001], ["81", "Rentals", 2000]),
    });
    expect(Object.fromEntries(c.byLine)).toEqual({ classes: 2011, shop: 990 });
  });

  it("reads rows from before invoices were sorted by account, as before", () => {
    const old = bookRevenue(
      S,
      [{ period: "2026-10-01", account_ref: "79", account: "x", cents: 5 }],
      [],
    );
    expect(old.invoicesByLine.get("classes")).toBe(5);
  });
});

describe("what the database's filters are handed", () => {
  it("is the lines and each choice as a place, nothing else", () => {
    expect(invoiceSorting(S)).toEqual({
      lines: ["shop", "classes", "custom"],
      accounts: [
        { ref: "79", name: "Class income", place: "line:classes" },
        { ref: null, name: "Sales", place: "skip:shop" },
      ],
      customers: [
        { ref: "7", name: "Maple Library", place: "line:custom" },
        { ref: null, name: "Birch Hall", place: "skip:other" },
        { ref: "9", name: "Gone Co", place: "line:shop" },
      ],
    });
    expect(invoiceSorting(revenueSettingsSchema.parse({ version: 1 })).lines).toEqual([]);
  });
});

describe("a person's choice", () => {
  it("is a line, a split of whole percents, the shop's, left out, or none", () => {
    expect(invoiceSortSchema.safeParse({ sort: "line", line: "classes" }).success).toBe(true);
    expect(invoiceSortSchema.safeParse({ sort: "shop" }).success).toBe(true);
    expect(invoiceSortSchema.safeParse({ sort: "none" }).success).toBe(true);
    expect(
      invoiceSortSchema.safeParse({ sort: "split", split: { shop: 50, classes: 50 } }).success,
    ).toBe(true);
    for (const bad of [
      { sort: "split", split: { shop: 50, classes: 49 } },
      { sort: "split", split: { shop: 100 } },
      { sort: "split", split: { shop: 50.5, classes: 49.5 } },
      { sort: "line", line: "Not An Id" },
      { sort: "shared" },
      { sort: "shop", line: "shop" },
    ]) {
      expect(invoiceSortSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(storedInvoiceSort({ sort: "split", split: { shop: 30, custom: 70 } })).toEqual({
      sort: "split",
      split: { shop: 30, custom: 70 },
    });
    expect(storedInvoiceSort({ sort: null })).toBeNull();
  });

  it("refuses a customer default for no line, or the same customer twice", () => {
    expect(
      revenueSettingsSchema.safeParse({
        ...S,
        books: { ...S.books, customers: [{ ref: "1", name: "A", choice: { line: "gone" } }] },
      }).success,
    ).toBe(false);
    expect(
      revenueSettingsSchema.safeParse({
        ...S,
        books: {
          ...S.books,
          customers: [
            { ref: "1", name: "A", choice: { skip: "other" } },
            { ref: "1", name: "B", choice: { line: "shop" } },
          ],
        },
      }).success,
    ).toBe(false);
  });
});
