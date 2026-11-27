import type { SupabaseClient } from "@supabase/supabase-js";
import { canSendInShopify } from "../connections/providers/shopify-fulfil";
import { shopPermission } from "../connections/shop-permission";
import { connectionFact } from "../setup/connection";
import { LOGO_TAG } from "../social/photo-match";
import {
  SHIPPING_MODULE,
  SHIPPING_SETTINGS_KEY,
  SLIP_LAYOUT_KEY,
  parseShippingSettings,
  parseSlipLayout,
} from "./config";
import { missingShipFrom } from "./labels";
import { SHIPPING_RULES_KEY, parseShippingRules } from "./rules";
import { shippingOrderFacts, type ShippingOrderFacts, type ShippingSetupFacts } from "./setup";
import { LABEL_SOURCES, type LabelSourceKey } from "./sources/types";

/** How far back "orders reached Shipping" looks. */
export const RECENT_DAYS = 30;
/** Open orders looked at for addresses and weights (the oldest first, as the list has them). */
const OPEN_LOOKED_AT = 1000;

/** What the To ship list already read, so the card needn't read it again. */
export type ShippingLoaded = {
  open: ShippingOrderFacts;
  boxes: { is_default: boolean }[];
  postage: {
    active: LabelSourceKey[];
    needsReconnect: LabelSourceKey[];
    testMode: LabelSourceKey[];
  };
};

/**
 * The facts the Shipping checklist is worked out from, read as the member.
 * Only counts come back: no address, no name. `loaded` hands over what the
 * To ship list already read. A part that fails is left out, never an error.
 */
export async function loadShippingSetupFacts(
  supabase: SupabaseClient,
  tenant: { id: string },
  opts: { loaded?: ShippingLoaded; now?: Date } = {},
): Promise<ShippingSetupFacts> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - RECENT_DAYS * 86_400_000).toISOString();
  const [connections, configs, boxes, shopOrders, shippingOrders, open, logo] = await Promise.all([
    supabase
      .from("connections")
      .select("provider, status, last_synced_at, last_error, scopes, metadata")
      .eq("tenant_id", tenant.id)
      .in("provider", ["shopify", ...LABEL_SOURCES]),
    supabase
      .from("configs")
      .select("key, body")
      .eq("tenant_id", tenant.id)
      .eq("module", SHIPPING_MODULE)
      .in("key", [SHIPPING_SETTINGS_KEY, SLIP_LAYOUT_KEY, SHIPPING_RULES_KEY]),
    opts.loaded
      ? Promise.resolve({ data: opts.loaded.boxes, error: null })
      : supabase
          .from("shipping_boxes")
          .select("is_default")
          .eq("tenant_id", tenant.id)
          .is("archived_at", null)
          .limit(100),
    // Orders the shop charged postage on: those are the ones that get posted.
    supabase
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant.id)
      .eq("provider", "shopify")
      .gt("total_shipping", 0)
      .gte("processed_at", since),
    supabase
      .from("shipping_orders")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant.id)
      .gte("placed_at", since),
    opts.loaded
      ? Promise.resolve({ data: null, error: null })
      : supabase
          .from("shipping_orders")
          .select("pickup, country_code, address1, recipient, weight_grams, items")
          .eq("tenant_id", tenant.id)
          .gt("units_left", 0)
          .eq("cancelled", false)
          .is("picked_up_at", null)
          .order("placed_at")
          .limit(OPEN_LOOKED_AT),
    supabase
      .from("social_assets")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant.id)
      .eq("hidden", false)
      .in("mime_type", ["image/png", "image/jpeg"])
      .contains("tags", [LOGO_TAG]),
  ]);

  const rows = (connections.data ?? []) as Record<string, unknown>[];
  const shopRow = rows.find((row) => row.provider === "shopify") ?? null;
  const body = (key: string) =>
    ((configs.data ?? []) as { key: string; body: unknown }[]).find((row) => row.key === key);
  const settings = parseShippingSettings(body(SHIPPING_SETTINGS_KEY)?.body);
  const slip = parseSlipLayout(body(SLIP_LAYOUT_KEY)?.body, settings);
  const withStatus = (status: string) =>
    LABEL_SOURCES.filter((key) =>
      rows.some((row) => row.provider === key && row.status === status),
    );
  const active = withStatus("active");
  const postage = opts.loaded?.postage ?? {
    active,
    needsReconnect: withStatus("needs_reconnect"),
    testMode: active.filter((key) =>
      rows.some(
        (row) =>
          row.provider === key && (row.metadata as Record<string, unknown> | null)?.mode === "test",
      ),
    ),
  };
  const boxRows = (boxes.data ?? []) as { is_default: boolean }[];
  const openFacts =
    opts.loaded?.open ??
    (open.error || !open.data
      ? null
      : shippingOrderFacts(
          open.data as Parameters<typeof shippingOrderFacts>[0],
          settings.ship_from_country,
        ));

  return {
    now,
    shop: connections.error ? null : connectionFact(shopRow),
    recent:
      shopOrders.error || shippingOrders.error
        ? null
        : { shop: shopOrders.count ?? 0, shipping: shippingOrders.count ?? 0 },
    open: openFacts,
    shipFromMissing: missingShipFrom(settings),
    boxes: { count: boxRows.length, usualMarked: boxRows.some((box) => box.is_default) },
    postage,
    permission: shopPermission(shopRow as Parameters<typeof shopPermission>[0], canSendInShopify),
    slip: {
      saved: configs.error ? true : Boolean(body(SLIP_LAYOUT_KEY)),
      logoWanted: slip.show_logo,
      // Not known counts as there: never ask for a logo we couldn't look for.
      logo: logo.error ? true : (logo.count ?? 0) > 0,
    },
    rules: {
      count: parseShippingRules(body(SHIPPING_RULES_KEY)?.body).length,
      signatureOver: settings.signature_over,
    },
  };
}
