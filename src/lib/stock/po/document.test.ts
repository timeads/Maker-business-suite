import { describe, expect, it } from "vitest";
import { Money } from "../balance/money";
import {
  buildPoDocument,
  currencyAmount,
  plainAmount,
  poDate,
  type PoDocumentInput,
} from "./document";
import { renderPoPdf } from "./pdf";

const input = (overrides: Partial<PoDocumentInput> = {}): PoDocumentInput => ({
  business: {
    name: "Wild Thread Studio",
    addressLines: ["1 Mill Lane", "", "Hudson, NY 12534", ""],
  },
  order: {
    number: 12,
    status: "ordered",
    createdAt: "2026-11-17T15:00:00Z",
    // 03:30 UTC on the 18th is still the evening of the 17th in New York.
    orderedAt: "2026-11-18T03:30:00Z",
    expectedOn: "2027-01-01",
    notes: " Please pack the cones upright. ",
    shippingCost: "40.00",
    taxRatePct: "8.875",
    adjustments: [
      { label: "Pallet fee", amount: "25.00" },
      { label: "Credit", amount: "-5.50" },
    ],
  },
  supplier: {
    name: "Hill Mill Yarns",
    contactName: "Dana Reyes",
    email: "orders@hillmill.example",
    moreEmails: ["accounts@hillmill.example", "orders@hillmill.example"],
    moq: 6,
    moqAppliesTo: "sku",
  },
  lines: [
    {
      sku: "YARN-OCH",
      supplierSku: "HM-77",
      title: "Wool yarn cone",
      variantTitle: "Ochre",
      moq: 24,
      qty: 48,
      unitCost: "4.75",
    },
    {
      sku: null,
      supplierSku: null,
      title: "Tufting frame",
      variantTitle: null,
      moq: null,
      qty: 16,
      unitCost: 26,
    },
    // Taken off the order: never printed.
    {
      sku: "GONE",
      supplierSku: null,
      title: "Old line",
      variantTitle: null,
      moq: null,
      qty: 0,
      unitCost: 9,
    },
  ],
  timezone: "America/New_York",
  currency: "USD",
  ...overrides,
});

describe("a purchase order as the supplier receives it", () => {
  it("lays out who, when, what and how much", () => {
    const doc = buildPoDocument(input());
    expect(doc.business).toEqual({
      name: "Wild Thread Studio",
      addressLines: ["1 Mill Lane", "Hudson, NY 12534"],
    });
    expect(doc.number).toBe("No. 12");
    expect(doc.status).toBe("Ordered");
    expect(doc.supplier).toEqual({
      name: "Hill Mill Yarns",
      contact: "Dana Reyes",
      emails: "orders@hillmill.example, accounts@hillmill.example",
    });
    expect(doc.lines).toEqual([
      {
        sku: "YARN-OCH",
        supplierSku: "HM-77",
        item: "Wool yarn cone — Ochre",
        moq: "24",
        qty: "48",
        unit: "4.75",
        total: "228.00",
      },
      // No code of its own; the supplier's per-item minimum stands in for the item's.
      {
        sku: "—",
        supplierSku: "—",
        item: "Tufting frame",
        moq: "6",
        qty: "16",
        unit: "26.00",
        total: "416.00",
      },
    ]);
    expect(doc.notes).toBe("Please pack the cones upright.");
  });

  it("takes its totals from the order sums, in whole cents", () => {
    const doc = buildPoDocument(input());
    // 228.00 + 416.00 = 644.00; tax 8.875% = 57.155 → 57.16 (half up).
    expect(doc.totals).toEqual([
      { label: "Subtotal", value: "$644.00" },
      { label: "Shipping", value: "$40.00" },
      { label: "Tax (8.875%)", value: "$57.16" },
      { label: "Adjustments", value: "$19.50" },
      { label: "Total", value: "$760.66", strong: true },
    ]);
    const plain = buildPoDocument(
      input({ order: { ...input().order, shippingCost: 0, taxRatePct: 0, adjustments: [] } }),
    );
    expect(plain.totals.map((row) => row.value)).toEqual([
      "$644.00",
      "$0.00",
      "$0.00",
      "$0.00",
      "$644.00",
    ]);
    expect(plain.totals[2].label).toBe("Tax (0.00%)");
  });

  it("says dates on the workspace's own calendar", () => {
    const doc = buildPoDocument(input());
    expect(doc.dates).toEqual({
      created: "Nov 17, 2026",
      sent: "Nov 17, 2026",
      expected: "Jan 1, 2027",
    });
    // The same moment is already the 18th in Tokyo; a plain day never moves.
    const tokyo = buildPoDocument(input({ timezone: "Asia/Tokyo" }));
    expect(tokyo.dates).toEqual({
      created: "Nov 18, 2026",
      sent: "Nov 18, 2026",
      expected: "Jan 1, 2027",
    });
    expect(poDate(null, "America/New_York")).toBe("—");
    expect(poDate("not a date", "America/New_York")).toBe("—");
    // The night the clocks go back in New York is still one day.
    expect(poDate("2026-11-01T05:30:00Z", "America/New_York")).toBe("Nov 1, 2026");
    expect(poDate("2026-11-01T03:30:00Z", "America/New_York")).toBe("Oct 31, 2026");
  });

  it("a draft with no dates, contact or minimums still reads cleanly", () => {
    const doc = buildPoDocument(
      input({
        order: { ...input().order, status: "draft", orderedAt: null, expectedOn: null, notes: "" },
        supplier: {
          name: "Clay Co",
          contactName: " ",
          email: null,
          moreEmails: [],
          moq: 50,
          moqAppliesTo: "order",
        },
      }),
    );
    expect(doc.status).toBe("Draft");
    expect(doc.dates.sent).toBe("—");
    expect(doc.dates.expected).toBe("—");
    expect(doc.supplier).toEqual({ name: "Clay Co", contact: null, emails: null });
    // A minimum counted across the whole order isn't any one line's.
    expect(doc.lines[1].moq).toBe("—");
    expect(doc.notes).toBeNull();
  });

  it("writes money without ever rounding through a float", () => {
    expect(plainAmount(new Money("1234567.89"))).toBe("1,234,567.89");
    expect(plainAmount(new Money("-1000.5"))).toBe("-1,000.50");
    expect(currencyAmount(new Money("5818"), "USD")).toBe("$5,818.00");
    expect(currencyAmount(new Money("-12.3"), "USD")).toBe("-$12.30");
    expect(currencyAmount(new Money("12"), "EUR")).toBe("€12.00");
    expect(currencyAmount(new Money("12"), "nonsense")).toBe("12.00 nonsense");
  });

  it("draws a PDF, with or without a logo", async () => {
    const pdf = await renderPoPdf(buildPoDocument(input()));
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1000);
    // A one-pixel PNG stands in for a workspace's logo.
    const pixel = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const withLogo = await renderPoPdf(buildPoDocument(input()), { data: pixel, format: "png" });
    expect(withLogo.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(withLogo.length).toBeGreaterThan(pdf.length);
  }, 30_000);
});
