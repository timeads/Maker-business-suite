import { describe, expect, it } from "vitest";
import {
  MAX_ROWS,
  NO_FILTERS,
  RECENT_ROWS,
  activityPage,
  activityType,
  balanceQuery,
  filterActivity,
  filterBills,
  isFiltered,
  matchesSearch,
  parseBalanceFilters,
  sourceLabel,
  type ActivityEntry,
} from "./activity";

const MILL = "60000000-0000-4000-8000-000000000001";
const GLUE = "60000000-0000-4000-8000-000000000002";

const row = (over: Partial<ActivityEntry>): ActivityEntry => ({
  supplierId: MILL,
  supplierName: "Hill Mill Yarns",
  type: "INVOICE",
  date: "2026-11-10",
  amount: "100.00",
  reference: null,
  description: "",
  createdAt: "2026-11-10T12:00:00Z",
  ...over,
});

const ROWS: ActivityEntry[] = [
  row({ reference: "INV-2041", date: "2026-10-27" }),
  row({ reference: "INV-2077", date: "2026-11-12" }),
  row({ type: "PAYMENT", date: "2026-11-16", amount: "640.00", description: "Wire" }),
  row({ type: "STATEMENT", date: "2026-10-30", amount: "0.00" }),
  row({ type: "ADJUSTMENT", date: "2026-11-18", amount: "-60.00", description: "Damaged cones" }),
  row({ type: "ADJUSTMENT", date: "2026-11-19", amount: "12.00", description: "Pallet fee" }),
  row({ supplierId: GLUE, supplierName: "Bond & Co", reference: "B-118", date: "2026-11-21" }),
];

describe("parseBalanceFilters", () => {
  it("reads every filter out of the address", () => {
    expect(
      parseBalanceFilters({
        supplier: MILL.toUpperCase(),
        type: "payment",
        from: "2026-11-01",
        to: "2026-11-30",
        q: "  inv 20 ",
        rows: "all",
      }),
    ).toEqual({
      supplier: MILL,
      type: "payment",
      from: "2026-11-01",
      to: "2026-11-30",
      q: "inv 20",
      all: true,
    });
  });

  it("drops anything that isn't a real value", () => {
    expect(
      parseBalanceFilters({
        supplier: "everyone'; drop",
        type: "refund",
        from: "2026-02-30",
        to: "soon",
        rows: "some",
      }),
    ).toEqual(NO_FILTERS);
  });

  it("takes dates the wrong way round as meant", () => {
    const f = parseBalanceFilters({ from: "2026-11-30", to: "2026-11-01" });
    expect([f.from, f.to]).toEqual(["2026-11-01", "2026-11-30"]);
  });

  it("uses the first value when one is given twice, and caps the search", () => {
    const f = parseBalanceFilters({ type: ["invoice", "payment"], q: "x".repeat(200) });
    expect(f.type).toBe("invoice");
    expect(f.q).toHaveLength(80);
  });
});

describe("balanceQuery", () => {
  it("writes the filters back so a link keeps them, and nothing when there are none", () => {
    expect(balanceQuery(NO_FILTERS)).toBe("");
    const f = parseBalanceFilters({ supplier: MILL, q: "inv 20", type: "invoice" });
    expect(balanceQuery(f)).toBe(`?supplier=${MILL}&type=invoice&q=inv+20`);
    expect(parseBalanceFilters(Object.fromEntries(new URLSearchParams(balanceQuery(f))))).toEqual(
      f,
    );
  });

  it("changes one thing and keeps the rest", () => {
    const f = parseBalanceFilters({ supplier: MILL, type: "invoice" });
    expect(balanceQuery(f, { type: null, all: true })).toBe(`?supplier=${MILL}&rows=all`);
  });
});

describe("filterActivity", () => {
  const filtered = (params: Record<string, string>) =>
    filterActivity(ROWS, parseBalanceFilters(params));

  it("lists everything newest first when nothing is filtered", () => {
    expect(filtered({}).map((r) => r.date)).toEqual([
      "2026-11-21",
      "2026-11-19",
      "2026-11-18",
      "2026-11-16",
      "2026-11-12",
      "2026-10-30",
      "2026-10-27",
    ]);
  });

  it("narrows by supplier", () => {
    expect(filtered({ supplier: GLUE }).map((r) => r.reference)).toEqual(["B-118"]);
  });

  it("tells a credit from an extra charge", () => {
    expect(filtered({ type: "credit" }).map((r) => r.description)).toEqual(["Damaged cones"]);
    expect(filtered({ type: "charge" }).map((r) => r.description)).toEqual(["Pallet fee"]);
    expect(filtered({ type: "statement" })).toHaveLength(1);
  });

  it("keeps both ends of a date range", () => {
    expect(filtered({ from: "2026-11-12", to: "2026-11-18" }).map((r) => r.date)).toEqual([
      "2026-11-18",
      "2026-11-16",
      "2026-11-12",
    ]);
  });

  it("searches invoice numbers, notes and supplier names", () => {
    expect(filtered({ q: "inv 2077" }).map((r) => r.reference)).toEqual(["INV-2077"]);
    expect(filtered({ q: "wire" }).map((r) => r.type)).toEqual(["PAYMENT"]);
    expect(filtered({ q: "bond" }).map((r) => r.reference)).toEqual(["B-118"]);
    expect(filtered({ q: "nothing like this" })).toEqual([]);
  });

  it("puts filters together", () => {
    expect(filtered({ supplier: MILL, type: "invoice", q: "2041" })).toHaveLength(1);
  });

  it("orders entries of one day by when they were written down", () => {
    const sameDay = [
      row({ reference: "first", createdAt: "2026-11-10T09:00:00Z" }),
      row({ reference: "second", createdAt: "2026-11-10T10:00:00Z" }),
    ];
    expect(filterActivity(sameDay, NO_FILTERS).map((r) => r.reference)).toEqual([
      "second",
      "first",
    ]);
  });
});

describe("matchesSearch", () => {
  it("ignores capitals, spaces and dashes", () => {
    expect(matchesSearch("inv2041", { reference: "INV-2041" })).toBe(true);
    expect(matchesSearch("INV 2041", { reference: "inv-2041" })).toBe(true);
    expect(matchesSearch("", { reference: null })).toBe(true);
    expect(matchesSearch("2042", { reference: "INV-2041" })).toBe(false);
  });
});

describe("activityPage", () => {
  const many = Array.from({ length: 60 }, (_, i) => i);

  it("shows the latest rows until asked for everything", () => {
    expect(activityPage(many, NO_FILTERS)).toMatchObject({ more: 60 - RECENT_ROWS });
    expect(activityPage(many, NO_FILTERS).shown).toHaveLength(RECENT_ROWS);
    expect(activityPage(many, { ...NO_FILTERS, all: true })).toMatchObject({ more: 0 });
  });

  it("shows every match of a filter, up to the cap", () => {
    expect(activityPage(many, { ...NO_FILTERS, q: "x" }).shown).toHaveLength(60);
    const huge = Array.from({ length: MAX_ROWS + 5 }, (_, i) => i);
    expect(activityPage(huge, { ...NO_FILTERS, all: true })).toMatchObject({ more: 5 });
  });
});

describe("filterBills", () => {
  const bills = [
    { supplierId: MILL, vendor: "Hill Mill Yarns", reference: "INV-2077" },
    { supplierId: GLUE, vendor: "Bond & Co", reference: "B-118" },
  ];

  it("narrows open bills by supplier and search, never by type or dates", () => {
    expect(filterBills(bills, { ...NO_FILTERS, supplier: GLUE })).toHaveLength(1);
    expect(filterBills(bills, { ...NO_FILTERS, q: "2077" })).toHaveLength(1);
    expect(
      filterBills(bills, { ...NO_FILTERS, type: "payment", from: "2030-01-01", to: "2030-01-02" }),
    ).toHaveLength(2);
  });
});

describe("small things", () => {
  it("knows when a list is narrowed", () => {
    expect(isFiltered(NO_FILTERS)).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, all: true })).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, q: "a" })).toBe(true);
  });

  it("names an entry's kind and where it came from", () => {
    expect(activityType({ type: "ADJUSTMENT", amount: "-1.00" })).toBe("credit");
    expect(activityType({ type: "ADJUSTMENT", amount: "1.00" })).toBe("charge");
    expect(sourceLabel("manual")).toBe("Typed in");
    expect(sourceLabel("import")).toBe("Spreadsheet");
    expect(sourceLabel("books")).toBe("Your books");
  });
});
