/**
 * Every tool's settings used to live inside the tool. They now sit under
 * workspace Settings; these are the old addresses and where each went, so a
 * bookmark or an old link in an email still lands in the right place.
 *
 * Both sides are what follows `/w/<slug>/`. Longer old paths come first so
 * "stock/settings/import" isn't caught by "stock/settings".
 */
export const MOVED_SETTINGS: readonly (readonly [from: string, to: string])[] = [
  ["shipping/settings", "settings/shipping"],
  ["stock/settings/import", "settings/stock/import"],
  ["stock/settings", "settings/stock"],
  ["stock/balances/email", "settings/stock/bills"],
  ["stock/michaels/settings", "settings/stock/michaels"],
  ["bookings/settings", "settings/bookings"],
  ["helpdesk/settings", "settings/helpdesk"],
];

/** The new address for an old settings page, or null when the path never moved. */
export function movedSettingsPath(pathname: string): string | null {
  const match = /^\/w\/([^/]+)\/(.+?)\/?$/.exec(pathname);
  if (!match) return null;
  const [, slug, rest] = match;
  for (const [from, to] of MOVED_SETTINGS) {
    if (rest === from) return `/w/${slug}/${to}`;
  }
  return null;
}

/**
 * Shipping's settings were one long page with anchors; each card now has a
 * screen of its own. A server never sees the "#…" part of an address, so the
 * first Shipping screen looks at it in the browser and goes to the right one.
 * Values are what follows `/w/<slug>/settings/`; the anchor is kept, and each
 * card still carries its old id.
 */
export const SHIPPING_ANCHORS: Readonly<Record<string, string>> = {
  printing: "shipping/printing",
  slip: "shipping/slip",
  rules: "shipping/rules",
  memory: "shipping/rules",
};

/** Where an old `…/shipping/settings#anchor` link should end up, anchor included. */
export function shippingAnchorPath(slug: string, hash: string): string | null {
  const anchor = hash.replace(/^#/, "");
  if (!Object.hasOwn(SHIPPING_ANCHORS, anchor)) return null;
  return `/w/${slug}/settings/${SHIPPING_ANCHORS[anchor]}#${anchor}`;
}
