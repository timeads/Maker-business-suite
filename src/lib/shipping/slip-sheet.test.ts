import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SlipSheet } from "../../app/w/[slug]/(app)/shipping/slip-sheet";
import {
  DEFAULT_SHIPPING_SETTINGS,
  DEFAULT_SLIP_LAYOUT,
  parseSlipLayout,
  slipLayoutSchema,
  type SlipLayout,
} from "./config";
import { SLIP_CSS, slipPageCss } from "./slip-css";
import { slipBoxes } from "./slip-boxes";
import { buildSlipData, type SlipOrder } from "./zebra/slip";

// Made-up people and places: nothing here is a real customer's.
const order: SlipOrder = {
  name: "#68000-AB",
  placed_at: "2026-10-01T16:00:00Z",
  recipient: "Robin Example",
  company: null,
  address1: "100 Sample Street",
  address2: "Apt 2",
  city: "Springfield",
  region: "NY",
  postal_code: "12345",
  country_code: "US",
  phone: null,
  shipping_method: "Standard Large",
  pickup: false,
  note: null,
  items: [
    {
      line_id: "a",
      title: "Reflect Wool Yarn",
      variant: "Royal",
      sku: "Y-ROYAL",
      barcode: "0012345",
      image: "https://cdn.shopify.com/s/files/1/0000/royal.jpg",
      price: 14,
      qty: 1,
      left: 1,
    },
    {
      line_id: "b",
      title: "Tufting <cloth> & frame",
      variant: null,
      sku: null,
      image: "https://evil.example/x.jpg",
      qty: 2,
      left: 2,
    },
  ],
};
const settings = {
  ...DEFAULT_SHIPPING_SETTINGS,
  ship_from: {
    ...DEFAULT_SHIPPING_SETTINGS.ship_from,
    name: "Wild Thread",
    address1: "1 Mill Lane",
    city: "Hudson",
    region: "NY",
    postal_code: "12534",
  },
};
const sheet = (
  over: Partial<SlipLayout> = {},
  more: Partial<Parameters<typeof buildSlipData>[0]> = {},
  props: { logo?: string | null; size?: "4x6" | "letter" } = {},
) =>
  renderToStaticMarkup(
    createElement(SlipSheet, {
      slip: buildSlipData({
        order,
        settings,
        layout: { ...DEFAULT_SLIP_LAYOUT, message: "Thanks for making with us!", ...over },
        workspaceName: "Wild Thread Studio",
        timeZone: "America/New_York",
        currency: "USD",
        boxNames: ["Standard"],
        ...more,
      }),
      ...props,
    }),
  );
const LOGO = "data:image/png;base64,iVBORw0KGgo=";
/** Where each piece of text first appears, to check the order down the sheet. */
const at = (html: string, text: string) => {
  const index = html.indexOf(text);
  expect(index, `"${text}" is on the slip`).toBeGreaterThan(-1);
  return index;
};

describe("the packing slip sheet", () => {
  it("is laid out like the slip on the bench by default", () => {
    const html = sheet({}, {}, { logo: LOGO });
    // Logo centred at the top with the address under it, then the order and its date.
    expect(html).toContain('<div class="head center">');
    expect(html).toContain(`<img class="logo medium" src="${LOGO}" alt=""/>`);
    // The logo carries the name, so it isn't written out as well.
    expect(html).not.toContain('class="brand"');
    const order = [
      "1 Mill Lane · Hudson, NY 12534",
      "#68000-AB",
      "Oct 1, 2026",
      "Ship to",
      "Robin Example",
      "Shipping",
      "Standard Large",
      "Box",
      "Standard</div>",
      "Qty",
      "Reflect Wool Yarn",
      "Royal",
      'class="push"',
      "Thanks for making with us!",
      'data-slip-code="68000-AB"',
      '<div class="v">68000-AB</div>',
    ].map((text) => at(html, text));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Ship to and Shipping sit side by side.
    expect(html).toMatch(/<div class="cols"><div class="sec"><div class="lbl">Ship to/);
    // No codes, photos or prices unless they're switched on.
    expect(html).not.toContain("SKU");
    expect(html).not.toContain("Barcode 0012345");
    expect(html).not.toContain("cdn.shopify.com");
    expect(html).not.toContain('class="p"');
  });

  it("writes the name when there is no logo to show, and keeps a customer's words as text", () => {
    const html = sheet();
    expect(html).toContain('<div class="brand">Wild Thread</div>');
    expect(html).not.toContain("<img");
    expect(html).toContain("Tufting &lt;cloth&gt; &amp; frame");
    expect(sheet({ store_name: "WT Yarn Co" })).toContain('<div class="brand">WT Yarn Co</div>');
    expect(sheet({ show_store_name: "never" })).not.toContain('class="brand"');
    expect(sheet({ show_store_name: "always" }, {}, { logo: LOGO })).toContain('class="brand"');
    expect(sheet({ show_logo: false }, {}, { logo: LOGO })).not.toContain("<img");
    expect(sheet({ show_return_address: false })).not.toContain("1 Mill Lane");
  });

  it("shows what each switch adds, and only photos from the shop's own image servers", () => {
    const html = sheet({
      show_sku: true,
      show_barcode: true,
      show_photo: true,
      show_price: true,
      align: "left",
      logo_size: "large",
      text_size: "large",
      footer: "wildthread.example",
    });
    expect(html).toContain("<span>Royal</span><span><br/>SKU Y-ROYAL · Barcode 0012345</span>");
    expect(html).toContain('<td class="img"><img src="https://cdn.shopify.com/');
    expect(html).not.toContain("evil.example");
    expect(html).toContain('<td class="p">$14.00</td>');
    expect(html).toContain('<div class="head left">');
    expect(html).toContain("f-large");
    expect(html).toContain('<div class="foot">wildthread.example</div>');
  });

  it("follows the sections' order and leaves out what is switched off", () => {
    const html = sheet({
      sections: [
        { id: "barcode", on: true },
        { id: "items", on: true },
        { id: "shipto", on: true },
        { id: "method", on: false },
        { id: "note", on: true },
        { id: "message", on: false },
      ],
    });
    expect(at(html, "data-slip-code")).toBeLessThan(at(html, "Reflect Wool Yarn"));
    expect(at(html, "Reflect Wool Yarn")).toBeLessThan(at(html, "Ship to"));
    expect(html).not.toContain("Standard Large");
    expect(html).not.toContain("Thanks for making");
    expect(html).not.toContain('class="cols"');
  });

  it("draws a box's slip and a group's slip with their own codes", () => {
    const [, second] = slipBoxes([
      { name: "Standard", tracking: null, items: { a: 1 } },
      { name: "Mailer", tracking: "1Z999", items: { b: 2 } },
    ]);
    const boxed = sheet({}, { box: second, boxNames: undefined });
    expect(boxed).toContain('<div class="boxno">Box 2 of 2</div>');
    expect(boxed).toContain('data-slip-code="68000-AB/B2"');
    expect(boxed).toContain("68000-AB · Box 2 of 2");
    expect(boxed).toContain("Tracking");
    expect(boxed).not.toContain("Reflect Wool Yarn");
    const group = sheet({}, { code: "68000-AB+68001-AB", from: new Map([["a", "#68001-AB"]]) });
    expect(group).toContain('data-slip-code="68000-AB+68001-AB"');
    expect(group).toContain("Order #68001-AB");
  });

  it("comes in a 4 × 6 label and a letter page", () => {
    expect(sheet()).toContain('class="slip s4x6 f-normal"');
    expect(sheet({}, {}, { size: "letter" })).toContain('class="slip letter f-normal"');
    expect(slipPageCss("4x6")).toContain("size: 4in 6in");
    expect(slipPageCss("letter")).toContain("size: 8.5in 11in");
  });

  it("is styled by its own stylesheet alone, which fetches nothing", () => {
    expect(SLIP_CSS).not.toMatch(/url\(|@import|@font-face/);
    // Every rule is scoped to the sheet, so it can't leak into the app around it.
    const selectors = SLIP_CSS.split("}")
      .map((rule) => rule.split("{")[0].trim())
      .filter(Boolean);
    expect(selectors.every((selector) => selector.startsWith(".slip-root"))).toBe(true);
  });
});

describe("the slip layout config", () => {
  it("starts out like the photo: centred, logo, address, no codes", () => {
    expect(DEFAULT_SLIP_LAYOUT).toMatchObject({
      show_logo: true,
      logo_size: "medium",
      align: "center",
      show_store_name: "without_logo",
      show_return_address: true,
      show_sku: false,
      show_barcode: false,
      show_photo: false,
      show_price: false,
      text_size: "normal",
    });
    expect(DEFAULT_SLIP_LAYOUT.sections.map((section) => section.id)).toEqual([
      "shipto",
      "method",
      "items",
      "note",
      "message",
      "barcode",
    ]);
  });

  it("reads a layout saved before the new switches existed, keeping what it said", () => {
    const old = {
      version: 1,
      sections: [
        { id: "items", on: true },
        { id: "shipto", on: false },
      ],
      show_sku: true,
      show_price: true,
      text_size: "large",
      message: "Thank you!",
      footer: "",
    };
    const layout = parseSlipLayout(old);
    expect(layout).toMatchObject({
      show_sku: true,
      show_price: true,
      text_size: "large",
      message: "Thank you!",
      align: "center",
      show_logo: true,
    });
    expect(layout.sections.slice(0, 2)).toEqual(old.sections);
    expect(layout.sections).toHaveLength(6);
  });

  it("refuses what isn't a layout", () => {
    expect(slipLayoutSchema.safeParse({ version: 1, align: "right" }).success).toBe(false);
    expect(slipLayoutSchema.safeParse({ version: 1, store_name: "x".repeat(61) }).success).toBe(
      false,
    );
    expect(slipLayoutSchema.safeParse({ version: 1, logo_size: "huge" }).success).toBe(false);
    // With nothing saved, the older settings' note is the message.
    expect(
      parseSlipLayout(null, { ...DEFAULT_SHIPPING_SETTINGS, slip_note: "Care: shake out." }),
    ).toMatchObject({ message: "Care: shake out.", show_sku: false });
  });
});
