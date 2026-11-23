import { describe, expect, it } from "vitest";
import { DEFAULT_SLIP_LAYOUT, shippingSettingsSchema, type SlipLayout } from "../config";
import { buildSlipData, slipZpl, type SlipData, type SlipOrder } from "./slip";

const settings = shippingSettingsSchema.parse({
  version: 1,
  ship_from: {
    name: "Tuft Studio",
    address1: "1 Mill Lane",
    city: "Hudson",
    region: "NY",
    postal_code: "12534",
  },
  ship_from_country: "US",
});

const order: SlipOrder = {
  name: "#1042",
  placed_at: "2026-11-18T15:00:00Z",
  recipient: "Zoë Shopper",
  company: null,
  address1: "12 Mill Lane",
  address2: null,
  city: "Hudson",
  region: "NY",
  postal_code: "12534",
  country_code: "US",
  phone: "555-0100",
  shipping_method: "Standard shipping",
  pickup: false,
  note: "It's a gift ^XZ no receipt",
  items: [
    {
      line_id: "1",
      title: "Wool rug",
      variant: "Large",
      sku: "RUG-L",
      price: 120,
      qty: 1,
      left: 1,
    },
    { line_id: "2", title: "Yarn bundle", variant: null, sku: "YARN-M", price: 9, qty: 3, left: 2 },
    { line_id: "3", title: "Already gone", variant: null, sku: null, price: 5, qty: 1, left: 0 },
  ],
};

const layout: SlipLayout = {
  ...DEFAULT_SLIP_LAYOUT,
  message: "Thank you!",
  footer: "Questions? hello@tuft.example",
  show_sku: true,
  show_price: true,
};
const all = (over: Partial<SlipLayout> = {}): SlipLayout => ({
  ...layout,
  sections: layout.sections.map((section) => ({ ...section, on: true })),
  ...over,
});
const build = (over: Partial<Parameters<typeof buildSlipData>[0]> = {}): SlipData =>
  buildSlipData({
    order,
    settings,
    layout: all(),
    workspaceName: "Tuft",
    timeZone: "America/New_York",
    currency: "USD",
    ...over,
  });

describe("a packing slip's words", () => {
  it("says what the slip on screen says: from, to, what's left to send, the barcode", () => {
    const slip = build();
    expect(slip).toMatchObject({
      fromName: "Tuft Studio",
      fromLines: ["1 Mill Lane", "Hudson, NY 12534"],
      orderName: "#1042",
      placed: "November 18, 2026",
      footer: "Questions? hello@tuft.example",
    });
    const kinds = slip.parts.map((part) => part.kind);
    expect(kinds).toEqual(
      all()
        .sections.map((section) => section.id)
        .filter((id) => kinds.includes(id)),
    );
    expect(kinds).toEqual(expect.arrayContaining(["shipto", "method", "items", "note", "barcode"]));
    const shipto = slip.parts.find((part) => part.kind === "shipto");
    expect(shipto).toMatchObject({ heading: "Send to", phone: "555-0100" });
    expect(shipto?.kind === "shipto" && shipto.lines[0]).toBe("Zoë Shopper");
    const items = slip.parts.find((part) => part.kind === "items");
    expect(items?.kind === "items" && items.rows).toEqual([
      { qty: 1, title: "Wool rug", details: ["Large"], sku: "RUG-L", price: "$120.00" },
      // Two of three still to go: the count and price are for what's in this box.
      {
        qty: 2,
        title: "Yarn bundle",
        details: ["1 of 3 already sent"],
        sku: "YARN-M",
        price: "$18.00",
      },
    ]);
    // The barcode drops the "#", as Scan & pack expects.
    expect(slip.parts.find((part) => part.kind === "barcode")).toEqual({
      kind: "barcode",
      code: "1042",
    });
  });

  it("follows the layout: sections switched off, and in the saved order", () => {
    const sections = all()
      .sections.map((section) => ({ ...section, on: ["items", "barcode"].includes(section.id) }))
      .reverse();
    const slip = build({ layout: all({ sections, show_price: false, footer: "" }) });
    expect(slip.parts.map((part) => part.kind)).toEqual(
      sections.filter((section) => section.on).map((section) => section.id),
    );
    const items = slip.parts.find((part) => part.kind === "items");
    expect(items?.kind === "items" && items.priced).toBe(false);
  });

  it("orders sent together: one barcode, and each line says which order it's from", () => {
    const slip = build({
      order: { ...order, name: "#1042 + #1055" },
      code: "#1042",
      from: new Map([["2", "#1055"]]),
    });
    expect(slip.parts.find((part) => part.kind === "barcode")).toMatchObject({ code: "1042" });
    const items = slip.parts.find((part) => part.kind === "items");
    expect(items?.kind === "items" && items.rows[1].details).toEqual([
      "Order #1055",
      "1 of 3 already sent",
    ]);
  });

  it("a pickup shows who it's for, not where they live", () => {
    const slip = build({ order: { ...order, pickup: true } });
    const shipto = slip.parts.find((part) => part.kind === "shipto");
    expect(shipto).toMatchObject({ heading: "Pickup for" });
    expect(shipto?.kind === "shipto" && shipto.lines.length).toBeLessThanOrEqual(2);
  });
});

describe("a packing slip as ZPL", () => {
  it("is one 4 × 6 label with every part, and a barcode Scan & pack can read", () => {
    const zpl = slipZpl(build());
    expect(zpl.match(/\^XA/g)).toHaveLength(1);
    expect(zpl.startsWith("^XA^CI28^PW812^LL1218^LH0,0")).toBe(true);
    expect(zpl.endsWith("^XZ")).toBe(true);
    for (const words of ["Tuft Studio", "#1042", "SEND TO", "12 Mill Lane", "Wool rug", "RUG-L"]) {
      expect(zpl).toContain(`^FD${words}^FS`);
    }
    expect(zpl).toContain("^FD$120.00^FS");
    expect(zpl).toMatch(/\^BY2,3,90\^BCN,90,N,N,N\^FD1042\^FS/);
    // Every field sits on the label.
    for (const [, x, y] of zpl.matchAll(/\^FO(\d+),(\d+)/g)) {
      expect(Number(x)).toBeLessThan(812);
      expect(Number(y)).toBeLessThan(1218);
    }
  });

  it("never lets a customer's words end a field or start a command", () => {
    const zpl = slipZpl(build());
    // The note held "^XZ"; the only real one is the last thing on the label.
    expect(zpl.indexOf("^XZ")).toBe(zpl.length - 3);
    expect(zpl).toContain("It's a gift _5EXZ no receipt");
    expect(zpl).toContain("Zo_C3_AB Shopper");
    // No barcode for a number the printer would misread; the number is still printed as words.
    const odd = slipZpl(build({ order: { ...order, name: "#10^42" } }));
    expect(odd).not.toContain("^BC");
    expect(odd).toContain("^FD10_5E42^FS");
  });

  it("runs a long order onto more labels, between lines", () => {
    const many = {
      ...order,
      items: Array.from({ length: 60 }, (_, i) => ({
        line_id: String(i),
        title: `Hand-dyed merino yarn, colour number ${i + 1}`,
        variant: "100 g skein",
        sku: `YARN-${i + 1}`,
        price: 9,
        qty: 1,
        left: 1,
      })),
    };
    const zpl = slipZpl(build({ order: many }));
    const pages = zpl.split("\n");
    expect(pages.length).toBeGreaterThan(2);
    for (const page of pages) {
      expect(page.startsWith("^XA^CI28^PW812^LL1218")).toBe(true);
      expect(page.endsWith("^XZ")).toBe(true);
      for (const [, , y] of page.matchAll(/\^FO(\d+),(\d+)/g)) {
        expect(Number(y)).toBeLessThan(1218 - 32);
      }
    }
    // Nothing is lost on the way: every item is on one label or another.
    expect(zpl.match(/\^FDYARN-\d+\^FS/g)).toHaveLength(60);
  });

  it("scales to a 300 dpi printer and to the slip's text size", () => {
    const fine = slipZpl(build(), 300);
    expect(fine.startsWith("^XA^CI28^PW1200^LL1800")).toBe(true);
    expect(fine).toMatch(/\^BY3,3,133\^BCN,133/);
    const size = (zpl: string) => Number(/\^A0N,(\d+),\d+\^FH\^FD12 Mill Lane/.exec(zpl)![1]);
    expect(size(slipZpl(build({ layout: all({ text_size: "large" }) })))).toBeGreaterThan(
      size(slipZpl(build({ layout: all({ text_size: "small" }) }))),
    );
  });
});
