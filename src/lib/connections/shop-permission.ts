/**
 * Where a workspace's shop stands on one permission, for the settings screens
 * that need one (Bookings → Order tags, Shipping's "tell the shop", Stock's
 * deliveries). Worked out from the connection's `scopes` (what the store
 * reported it granted), its `metadata.asked_scopes` (what the connection
 * asked for) and `metadata.watch_only`. Pure; the words live beside it so the
 * screens all say the same thing (docs/shopify-permissions.md).
 */
export type ShopPermissionState =
  /** No shop connected. */
  | "not_connected"
  /** Connected once, but the shop needs connecting again. */
  | "reconnect"
  /** Connected to watch only: nothing is ever changed, by our own promise. */
  | "watch_only"
  | "allowed"
  /** We asked for it and the store didn't grant it. */
  | "asked_not_granted"
  /** Not granted, and this connection never asked (or we can't tell). */
  | "not_granted";

export type ShopConnectionFacts = {
  status?: string | null;
  scopes?: unknown;
  metadata?: unknown;
} | null;

export type ShopPermission = {
  state: ShopPermissionState;
  /** When the store was last asked what it granted (ISO), if ever. */
  checkedAt: string | null;
};

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/**
 * `allows` is the screen's own gate (`canTagInShopify`, `canSendInShopify`,
 * `canWriteShopifyStock`), so the answer is the same one the gate gives.
 */
export function shopPermission(
  shop: ShopConnectionFacts,
  allows: (scopes: string[]) => boolean,
): ShopPermission {
  const meta = (shop?.metadata ?? {}) as Record<string, unknown>;
  const checkedAt = typeof meta.scopes_checked_at === "string" ? meta.scopes_checked_at : null;
  const state = ((): ShopPermissionState => {
    if (!shop || !shop.status || shop.status === "disconnected") return "not_connected";
    if (shop.status !== "active") return "reconnect";
    if (meta.watch_only === true) return "watch_only";
    if (allows(list(shop.scopes))) return "allowed";
    return allows(list(meta.asked_scopes)) ? "asked_not_granted" : "not_granted";
  })();
  return { state, checkedAt };
}

/** Whether a "Check again" press makes sense: only for a live, full connection not yet allowed. */
export const canCheckAgain = (permission: ShopPermission): boolean =>
  permission.state === "asked_not_granted" || permission.state === "not_granted";

/**
 * Plain words for a state. `what` finishes "permission to …" (for example
 * "add tags to its orders").
 */
export function shopPermissionWords(
  state: ShopPermissionState,
  what: string,
): { headline: string; next: string | null } {
  switch (state) {
    case "allowed":
      return { headline: `Your shop lets us ${what}.`, next: null };
    case "not_connected":
      return { headline: "Your shop isn't connected.", next: "Connect it under Connections." };
    case "reconnect":
      return {
        headline: "Your shop needs connecting again.",
        next: "Connect it again under Connections, then come back here.",
      };
    case "watch_only":
      return {
        headline:
          "Your shop is connected to watch only, so nothing in it is ever changed from here.",
        next: null,
      };
    case "asked_not_granted":
      return {
        headline: `We asked your shop for permission to ${what}, and Shopify didn't give it.`,
        next: "Shopify only hands our app the permissions its current version lists, so connecting again won't change this. In your Shopify admin, open our app under Apps and approve any update it's waiting on, then press Check again. If there's nothing to approve, this permission isn't on offer yet: get in touch and we'll let you know when it is.",
      };
    case "not_granted":
      return {
        headline: `Your shop hasn't given permission to ${what}.`,
        next: "If Shopify has asked you to approve an update to our app, approve it in your Shopify admin (our app, under Apps), then press Check again.",
      };
  }
}
