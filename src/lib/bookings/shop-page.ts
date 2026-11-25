import { z } from "zod";

/**
 * The date picker on a shop's product page: what a business can vary about
 * it, and the two snippets the business pastes into its shop theme. Pure, so
 * the snippets can be tested without a page.
 *
 * The settings are a config (module "bookings", key "shop_page"). The picker
 * reads the timing and the contact details from us each time it loads; the
 * tag, the colour and the "what to hide" rule are baked into the snippets,
 * so changing those means pasting the snippet again.
 */
export const SHOP_PAGE_KEY = "shop_page";

/** Safe inside a single-quoted Liquid string and an HTML attribute. */
const TAG = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;
/** A CSS selector list, without anything that could close a style block or an attribute. */
const SELECTOR = /^[A-Za-z0-9 ,.#[\]=_\-:>()*'^$~|+]*$/;

export const shopPageSchema = z.object({
  version: z.literal(1),
  /** The shop tag that marks a product as a workshop sold by date. */
  product_tag: z.string().trim().regex(TAG).default("workshop"),
  /** Dates closer than this many hours can no longer be picked. */
  cutoff_hours: z.number().int().min(0).max(336).default(12),
  /** The picker button's colour. */
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#edc2ff"),
  /** Where a shopper goes when the dates can't be shown: a page, an email address, or both. */
  contact_url: z
    .union([z.literal(""), z.string().trim().url().startsWith("https://").max(300)])
    .default(""),
  contact_email: z.union([z.literal(""), z.string().trim().email().max(200)]).default(""),
  /** The business's own words for that moment; ours when empty. */
  fallback_message: z.string().trim().max(200).default(""),
  /**
   * For a theme whose buy button the usual rule doesn't find: a CSS selector
   * for what to hide on a workshop's product page.
   */
  hide_selector: z.string().trim().max(200).regex(SELECTOR).default(""),
});
export type ShopPage = z.infer<typeof shopPageSchema>;

export const DEFAULT_SHOP_PAGE: ShopPage = shopPageSchema.parse({ version: 1 });

export function parseShopPage(body: unknown): ShopPage {
  const parsed = shopPageSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_SHOP_PAGE;
}

/** What the picker is told each time it loads. */
export type ShopPageFacts = {
  cutoff_hours: number;
  contact_url: string;
  contact_email: string;
  message: string;
};

export const DEFAULT_FALLBACK = "We couldn't show the dates for this workshop just now.";

export function shopPageFacts(settings: ShopPage): ShopPageFacts {
  return {
    cutoff_hours: settings.cutoff_hours,
    contact_url: settings.contact_url,
    contact_email: settings.contact_email,
    message: settings.fallback_message || DEFAULT_FALLBACK,
  };
}

const html = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Liquid would read `{{` or `{%` in our words as its own. */
const noLiquid = (text: string) => text.replace(/\{(?=[{%])/g, "{ ");

/** The contact link inside the fallback, or plain words when the business gave none. */
function contactHtml(settings: ShopPage): string {
  const href =
    settings.contact_url || (settings.contact_email && `mailto:${settings.contact_email}`);
  return href
    ? `<a href="${html(href)}">Get in touch</a> and we'll book you in.`
    : "Please get in touch and we'll book you in.";
}

/** The usual home of a product page's buy buttons, scoped to the section the snippet sits in. */
export function hideRule(settings: ShopPage): string {
  if (settings.hide_selector) return settings.hide_selector;
  const section = "#shopify-section-{{ section.id }}";
  return `${section} form[action*="/cart/add"] [type="submit"], ${section} .shopify-payment-button`;
}

/**
 * The product-page snippet. It draws only for products with the workshop
 * tag, and from the first paint:
 *  - the theme's own buy buttons are hidden, so nobody can buy a workshop
 *    with no date, whether the picker has loaded, is loading or never does;
 *  - a box of the button's height is kept, so nothing jumps when it arrives;
 *  - a plain message with a way to reach the business waits, unseen, and
 *    shows by itself after a few seconds if the picker never takes over,
 *    script or no script. The picker shows it at once when it knows it failed.
 */
export function pageSnippet(settings: ShopPage, where: { slug: string; site: string }): string {
  const words = noLiquid(html(settings.fallback_message || DEFAULT_FALLBACK));
  return `{% comment %} Workshop date picker {% endcomment %}
{% if product.tags contains '${settings.product_tag}' %}
<style>
  :is(${hideRule(settings)}) { display: none !important; }
  [data-mbs-booking] { display: block; min-height: 52px; }
  [data-mbs-booking] .mbs-fallback {
    margin: 0; opacity: 0; animation: mbs-fallback 0s linear 6s forwards;
  }
  [data-mbs-booking].mbs-failed .mbs-fallback { opacity: 1; animation: none; }
  @keyframes mbs-fallback { to { opacity: 1; } }
</style>
<div data-mbs-booking
     data-workspace="${html(where.slug)}"
     data-product-id="{{ product.id }}"
     data-accent="${settings.accent}"${settings.hide_selector ? `\n     data-hide="${html(settings.hide_selector)}"` : ""}>
  <p class="mbs-fallback">${words} ${noLiquid(contactHtml(settings))}</p>
</div>
<script src="${html(where.site)}/booking-widget.js" defer></script>
{% endif %}`;
}

/**
 * The cart guard, for just before `</body>` in the theme's layout. It
 * catches a workshop that reached the cart without a date (the shop's "Buy
 * again", a quick-add button, a saved cart): on the cart page a calm notice
 * sits at the top and the checkout buttons are hidden; anywhere else a press
 * on a cart checkout leads to the cart instead. "Choose a date" takes the
 * dateless lines out and opens the product page, where the picker is.
 *
 * The check is Liquid over the cart, so on an ordinary page this prints
 * nothing at all: no script, no styles, nothing to shift.
 */
export function cartGuardSnippet(settings: ShopPage): string {
  return `{% comment %} Workshop cart guard: a workshop in the cart with no date {% endcomment %}
{%- assign mbs_keys = '' -%}
{%- assign mbs_titles = '' -%}
{%- assign mbs_url = '' -%}
{%- for item in cart.items -%}
  {%- if item.product.tags contains '${settings.product_tag}' -%}
    {%- assign mbs_sid = item.properties['Session ID'] -%}
    {%- if mbs_sid == blank -%}
      {%- assign mbs_keys = mbs_keys | append: item.key | append: '|' -%}
      {%- assign mbs_titles = mbs_titles | append: item.product.title | append: '|' -%}
      {%- if mbs_url == '' -%}{%- assign mbs_url = item.product.url -%}{%- endif -%}
    {%- endif -%}
  {%- endif -%}
{%- endfor -%}
{%- if mbs_keys != '' -%}
  {%- assign mbs_title_list = mbs_titles | split: '|' | uniq | join: ', ' -%}
  {%- assign mbs_on_cart = false -%}
  {%- if template.name == 'cart' -%}{%- assign mbs_on_cart = true -%}{%- endif -%}
  {%- if mbs_on_cart -%}
    <style>
      form[action^="/cart"] button[name="checkout"],
      form[action^="/cart"] input[name="checkout"],
      .additional-checkout-buttons,
      [data-shopify="dynamic-checkout-cart"] { display: none !important; }
      .mbs-needs-date {
        margin: 0 0 24px; padding: 14px 16px; border: 1px solid rgba(0, 0, 0, .15);
        border-left: 4px solid ${settings.accent}; border-radius: 3px;
        background: rgba(0, 0, 0, .03); font: inherit; color: inherit; line-height: 1.5;
      }
      .mbs-needs-date p { margin: 0 0 10px; }
      .mbs-needs-date button {
        font: inherit; cursor: pointer; border: 0; border-radius: 3px; padding: 9px 16px;
        background: #1f1f1f; color: #fff;
      }
      .mbs-needs-date.mbs-pulse { animation: mbs-pulse .9s ease-out; }
      @keyframes mbs-pulse {
        0% { box-shadow: 0 0 0 0 rgba(0, 0, 0, .35); }
        100% { box-shadow: 0 0 0 12px rgba(0, 0, 0, 0); }
      }
      @media (prefers-reduced-motion: reduce) { .mbs-needs-date.mbs-pulse { animation: none; } }
    </style>
    <template id="mbs-needs-date-tpl">
      <div class="mbs-needs-date" role="status">
        <p><strong>{{ mbs_title_list | escape }} needs a date.</strong>
          Pick your date to finish checking out. It only takes a moment.</p>
        <button type="button" data-mbs-choose>Choose a date &rarr;</button>
      </div>
    </template>
  {%- endif -%}
  <script>
    (function () {
      var keys = {{ mbs_keys | split: '|' | json }}.filter(Boolean);
      var dest = {{ mbs_url | json }} || {{ routes.root_url | json }};
      var onCart = {{ mbs_on_cart | json }};
      var notice = null;

      function chooseDate(btn) {
        if (btn) btn.disabled = true;
        // Take each dateless line out (by its own key), then go and pick a date.
        keys.reduce(function (p, key) {
          return p.then(function () {
            return fetch('/cart/change.js', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: key, quantity: 0 })
            });
          });
        }, Promise.resolve()).finally(function () { location.href = dest; });
      }

      function mountNotice() {
        var tpl = document.getElementById('mbs-needs-date-tpl');
        if (!tpl) return;
        notice = tpl.content.firstElementChild.cloneNode(true);
        // In the page, at the top of the cart: never a floating layer.
        var form = document.querySelector('form[action^="/cart"]');
        var host = form || document.querySelector('main') || document.body;
        host.insertBefore(notice, host.firstChild);
        notice.querySelector('[data-mbs-choose]').addEventListener('click', function (e) {
          chooseDate(e.currentTarget);
        });
      }

      // A cart checkout only. A product page's "Buy it now" buys just that
      // item, never the cart, so it is left alone.
      function isCheckout(el) {
        if (!el || !el.closest) return false;
        if (el.closest('a[href*="/checkout"]')) return true;
        return !!el.closest('button[name="checkout"], input[name="checkout"], ' +
          '.additional-checkout-buttons, [data-shopify="dynamic-checkout-cart"]');
      }
      document.addEventListener('click', function (e) {
        if (!isCheckout(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        if (onCart && notice) {
          notice.scrollIntoView({ behavior: 'smooth', block: 'center' });
          notice.classList.remove('mbs-pulse');
          void notice.offsetWidth;
          notice.classList.add('mbs-pulse');
        } else {
          location.href = {{ routes.cart_url | json }};
        }
      }, true);
      document.addEventListener('submit', function (e) {
        var f = e.target;
        var action = (f && f.getAttribute && f.getAttribute('action')) || '';
        var viaCheckout = e.submitter && e.submitter.name === 'checkout';
        if (action.indexOf('/checkout') !== -1 || viaCheckout) {
          e.preventDefault();
          if (!onCart) location.href = {{ routes.cart_url | json }};
        }
      }, true);

      if (onCart) {
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', mountNotice);
        } else {
          mountNotice();
        }
      }
    })();
  </script>
{%- endif -%}`;
}
