import { describe, expect, it } from "vitest";
import { buildPoDocument } from "./document";
import { renderPoPdf } from "./pdf";

const doc = (contactName: string) =>
  buildPoDocument({
    business: { name: "Wild Thread Studio", addressLines: ["1 Mill Lane"] },
    order: {
      number: 3,
      reference: "HI-202611-A7A950",
      status: "ordered",
      createdAt: "2026-11-17T15:00:00Z",
      orderedAt: null,
      expectedOn: null,
      notes: "",
      shippingCost: "0",
      taxRatePct: "0",
      adjustments: [],
    },
    supplier: {
      name: "Hill Mill Yarns",
      contactName,
      email: "orders@hillmill.example",
      moreEmails: [],
      moq: 1,
      moqAppliesTo: "order",
    },
    lines: [
      {
        sku: "Y-1",
        supplierSku: null,
        title: "Yarn",
        variantTitle: null,
        moq: null,
        qty: 2,
        unitCost: "4.00",
      },
    ],
    timezone: "America/New_York",
    currency: "USD",
  });

describe("the purchase order PDF", () => {
  it("draws a plain order with the built-in font alone", async () => {
    const pdf = await renderPoPdf(doc("Dana Reyes"));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.toString("latin1")).not.toContain("NotoSans");
  });

  it("puts the bundled font in for a name Helvetica can't draw", async () => {
    const pdf = await renderPoPdf(doc("王小明"));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    // Only the characters used travel with the file, so it stays small.
    expect(pdf.toString("latin1")).toContain("NotoSans");
    expect(pdf.length).toBeLessThan(200_000);
  });
});
