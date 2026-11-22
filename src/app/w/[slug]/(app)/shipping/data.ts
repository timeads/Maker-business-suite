import type { SupabaseClient } from "@supabase/supabase-js";
import { canSendInShopify } from "@/lib/connections/providers/shopify-fulfil";
import {
  SHIPPING_MODULE,
  SHIPPING_SETTINGS_KEY,
  parseShippingSettings,
} from "@/lib/shipping/config";

export type ShippingOrder = {
  id: string;
  name: string | null;
  placed_at: string;
  recipient: string | null;
  company: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country_code: string | null;
  phone: string | null;
  email: string | null;
  shipping_method: string | null;
  note: string | null;
  items: {
    line_id: string;
    title: string;
    variant: string | null;
    sku: string | null;
    qty: number;
    left: number;
  }[];
  units_left: number;
  cancelled: boolean;
  paid: boolean;
  on_hold: boolean;
  hold_reason: string;
  slip_printed_at: string | null;
};

export const ORDER_FIELDS =
  "id, name, placed_at, recipient, company, address1, address2, city, region, postal_code, country_code, phone, email, shipping_method, note, items, units_left, cancelled, paid, on_hold, hold_reason, slip_printed_at";

/** The workspace's shipping settings and what its shop will let us do. */
export async function loadShippingSetup(supabase: SupabaseClient, tenantId: string) {
  const [{ data: config }, { data: shop }] = await Promise.all([
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenantId)
      .eq("module", SHIPPING_MODULE)
      .eq("key", SHIPPING_SETTINGS_KEY)
      .maybeSingle(),
    supabase
      .from("connections")
      .select("status, scopes")
      .eq("tenant_id", tenantId)
      .eq("provider", "shopify")
      .maybeSingle(),
  ]);
  const connected = shop?.status === "active";
  return {
    settings: parseShippingSettings(config?.body),
    connected,
    canSend: connected && canSendInShopify(shop.scopes),
  };
}

/** "2 × Wool rug (Large), 3 × Yarn bundle" for what's still to go. */
export const itemsSummary = (order: Pick<ShippingOrder, "items">) =>
  order.items
    .filter((item) => item.left > 0)
    .map((item) => `${item.left} × ${item.title}${item.variant ? ` (${item.variant})` : ""}`)
    .join(", ");
