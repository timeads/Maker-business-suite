import { describe, expect, it } from "vitest";
import {
  DEFAULT_FALLBACK,
  DEFAULT_SHOP_PAGE,
  cartGuardSnippet,
  pageSnippet,
  parseShopPage,
  shopPageFacts,
  shopPageSchema,
} from "./shop-page";

const where = { slug: "alice-rugs", site: "https://app.example.com" };

describe("the shop product page settings", () => {
  it("start out as the picker behaved before they were a setting", () => {
    expect(DEFAULT_SHOP_PAGE).toEqual({
      version: 1,
      product_tag: "workshop",
      cutoff_hours: 12,
      accent: "#edc2ff",
      contact_url: "",
      contact_email: "",
      fallback_message: "",
      hide_selector: "",
    });
    expect(parseShopPage(null)).toEqual(DEFAULT_SHOP_PAGE);
    expect(parseShopPage({ version: 1, cutoff_hours: 99999 })).toEqual(DEFAULT_SHOP_PAGE);
  });

  it("refuse anything that could break out of the snippet", () => {
    const bad = (over: object) => shopPageSchema.safeParse({ version: 1, ...over }).success;
    expect(bad({ product_tag: "work'shop" })).toBe(false);
    expect(bad({ product_tag: "{{ x }}" })).toBe(false);
    expect(bad({ product_tag: "" })).toBe(false);
    expect(bad({ accent: "red" })).toBe(false);
    expect(bad({ accent: "#fff;}" })).toBe(false);
    expect(bad({ contact_url: "http://example.com" })).toBe(false);
    expect(bad({ contact_url: "javascript:alert(1)" })).toBe(false);
    expect(bad({ contact_email: "not an email" })).toBe(false);
    expect(bad({ hide_selector: "</style><script>" })).toBe(false);
    expect(bad({ hide_selector: 'a"b' })).toBe(false);
    expect(bad({ hide_selector: "a{b}" })).toBe(false);
    expect(bad({ hide_selector: ".product-form__buttons, .buy-now" })).toBe(true);
    expect(bad({ product_tag: "Class 2026", contact_url: "https://example.com/contact" })).toBe(
      true,
    );
  });

  it("tell the picker the timing and where a shopper can turn", () => {
    expect(shopPageFacts(DEFAULT_SHOP_PAGE)).toEqual({
      cutoff_hours: 12,
      contact_url: "",
      contact_email: "",
      message: DEFAULT_FALLBACK,
    });
    expect(
      shopPageFacts({ ...DEFAULT_SHOP_PAGE, fallback_message: "Dates are having a nap." }).message,
    ).toBe("Dates are having a nap.");
  });
});

describe("the product page snippet", () => {
  const snippet = pageSnippet(DEFAULT_SHOP_PAGE, where);

  it("draws only for products with the workshop tag", () => {
    expect(snippet).toContain("{% if product.tags contains 'workshop' %}");
    expect(snippet.trimEnd().endsWith("{% endif %}")).toBe(true);
    expect(pageSnippet({ ...DEFAULT_SHOP_PAGE, product_tag: "Class" }, where)).toContain(
      "contains 'Class'",
    );
  });

  it("hides the theme's buy button with a style rule, from the first paint, with no script", () => {
    const style = snippet.slice(snippet.indexOf("<style>"), snippet.indexOf("</style>"));
    expect(style).toContain('form[action*="/cart/add"] [type="submit"]');
    expect(style).toContain(".shopify-payment-button");
    expect(style).toContain("display: none !important");
    // Only inside the product's own section, so cards for other products keep their buttons.
    expect(style).toContain("#shopify-section-{{ section.id }}");
    expect(snippet.indexOf("<style>")).toBeLessThan(snippet.indexOf("<script"));
  });

  it("keeps the button's room and carries a plain message with a way to get in touch", () => {
    expect(snippet).toContain("min-height: 52px");
    expect(snippet).toContain('<p class="mbs-fallback">');
    expect(snippet).toContain(DEFAULT_FALLBACK);
    expect(snippet).toContain("Please get in touch and we'll book you in.");
    // Shown by the style sheet alone after a few seconds, so a script that never loads still leaves it.
    expect(snippet).toMatch(/animation: mbs-fallback 0s linear \d+s forwards/);
    expect(snippet).toContain("[data-mbs-booking].mbs-failed .mbs-fallback { opacity: 1");

    const linked = pageSnippet(
      { ...DEFAULT_SHOP_PAGE, contact_url: "https://shop.example.com/pages/contact?a=1&b=2" },
      where,
    );
    expect(linked).toContain(
      '<a href="https://shop.example.com/pages/contact?a=1&amp;b=2">Get in touch</a>',
    );
    const mailed = pageSnippet({ ...DEFAULT_SHOP_PAGE, contact_email: "hi@example.com" }, where);
    expect(mailed).toContain('<a href="mailto:hi@example.com">Get in touch</a>');
  });

  it("names the workspace and loads the picker late, from our own address", () => {
    expect(snippet).toContain('data-workspace="alice-rugs"');
    expect(snippet).toContain('data-product-id="{{ product.id }}"');
    expect(snippet).toContain('data-accent="#edc2ff"');
    expect(snippet).toContain('<script src="https://app.example.com/booking-widget.js" defer>');
    // The cut-off is a setting the picker is told each time, not a number baked in.
    expect(snippet).not.toContain("data-cutoff-hours");
    expect(snippet).not.toContain("data-hide");
  });

  it("uses the business's own rule for what to hide, and its own words, made safe", () => {
    const custom = pageSnippet(
      {
        ...DEFAULT_SHOP_PAGE,
        hide_selector: ".product-form__buttons, .buy-now",
        fallback_message: "Dates <b>aren't</b> loading {{ shop.name }} {% raw %}",
      },
      where,
    );
    expect(custom).toContain(":is(.product-form__buttons, .buy-now) { display: none !important; }");
    expect(custom).toContain('data-hide=".product-form__buttons, .buy-now"');
    expect(custom).toContain("Dates &lt;b&gt;aren't&lt;/b&gt; loading { { shop.name }} { % raw %}");
    expect(custom).not.toContain("<b>");
  });
});

describe("the cart guard snippet", () => {
  const guard = cartGuardSnippet({ ...DEFAULT_SHOP_PAGE, product_tag: "class" });

  it("looks for the workshop tag with no date, and prints nothing otherwise", () => {
    expect(guard).toContain("item.product.tags contains 'class'");
    expect(guard).toContain("item.properties['Session ID']");
    // Everything it adds to a page sits inside the one condition.
    const start = guard.indexOf("{%- if mbs_keys != '' -%}");
    expect(start).toBeGreaterThan(0);
    expect(guard.indexOf("<style>")).toBeGreaterThan(start);
    expect(guard.indexOf("<script>")).toBeGreaterThan(start);
    expect(guard.trimEnd().endsWith("{%- endif -%}")).toBe(true);
  });

  it("holds checkout back on the cart page and leads to the picker", () => {
    expect(guard).toContain('form[action^="/cart"] button[name="checkout"]');
    expect(guard).toContain("needs a date.");
    expect(guard).toContain("Choose a date");
    expect(guard).toContain("/cart/change.js");
    expect(guard).toContain("quantity: 0");
    expect(guard).toContain("{{ mbs_title_list | escape }}");
    // A product page's "Buy it now" is left alone: only cart checkouts are caught.
    expect(guard).toContain("dynamic-checkout-cart");
    expect(guard).not.toContain("shopify-payment-button");
  });
});
