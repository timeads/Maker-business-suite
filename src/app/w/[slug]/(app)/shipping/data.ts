import type { SupabaseClient } from "@supabase/supabase-js";
import { canSendInShopify } from "@/lib/connections/providers/shopify-fulfil";
import {
  SHIPPING_MODULE,
  SHIPPING_SETTINGS_KEY,
  SLIP_LAYOUT_KEY,
  parseShippingSettings,
  parseSlipLayout,
} from "@/lib/shipping/config";
import type { SavedBox } from "@/lib/shipping/labels";
import type { QueueFacts } from "@/lib/shipping/queue";

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
  /** The option the shopper picked at checkout, and what they paid for it. */
  shipping_method: string | null;
  shipping_paid: number | null;
  weight_grams: number | null;
  pickup: boolean;
  note: string | null;
  items: {
    line_id: string;
    title: string;
    variant: string | null;
    sku: string | null;
    barcode?: string | null;
    price?: number | null;
    qty: number;
    left: number;
  }[];
  units_left: number;
  cancelled: boolean;
  paid: boolean;
  on_hold: boolean;
  hold_reason: string;
  hold_until: string | null;
  pickup_ready_at: string | null;
  picked_up_at: string | null;
  slip_printed_at: string | null;
};

export const ORDER_FIELDS =
  "id, name, placed_at, recipient, company, address1, address2, city, region, postal_code, country_code, phone, email, shipping_method, note, items, units_left, cancelled, paid, on_hold, hold_reason, hold_until, shipping_paid, weight_grams, pickup, pickup_ready_at, picked_up_at, slip_printed_at";

/** The workspace's shipping settings and what its shop will let us do. */
export async function loadShippingSetup(supabase: SupabaseClient, tenantId: string) {
  const [{ data: configs }, { data: shop }] = await Promise.all([
    supabase
      .from("configs")
      .select("key, body")
      .eq("tenant_id", tenantId)
      .eq("module", SHIPPING_MODULE)
      .in("key", [SHIPPING_SETTINGS_KEY, SLIP_LAYOUT_KEY]),
    supabase
      .from("connections")
      .select("status, scopes")
      .eq("tenant_id", tenantId)
      .eq("provider", "shopify")
      .maybeSingle(),
  ]);
  const connected = shop?.status === "active";
  const body = (key: string) => (configs ?? []).find((config) => config.key === key)?.body;
  const settings = parseShippingSettings(body(SHIPPING_SETTINGS_KEY));
  return {
    settings,
    slip: parseSlipLayout(body(SLIP_LAYOUT_KEY), settings),
    connected,
    canSend: connected && canSendInShopify(shop.scopes),
  };
}

export const BOX_FIELDS =
  "id, name, kind, length_in, width_in, height_in, empty_weight_oz, is_default";

/** The boxes the workspace packs in, the usual one first. */
export async function loadBoxes(supabase: SupabaseClient, tenantId: string): Promise<SavedBox[]> {
  const { data } = await supabase
    .from("shipping_boxes")
    .select(BOX_FIELDS)
    .eq("tenant_id", tenantId)
    .is("archived_at", null)
    .order("is_default", { ascending: false })
    .order("created_at")
    .limit(100);
  return (data ?? []) as unknown as SavedBox[];
}

/**
 * Whether the workspace can buy labels. Only what members may read is named
 * here: the status and the details (test or production). The key itself is
 * in Vault and never comes near this query.
 */
export async function loadLabelConnection(supabase: SupabaseClient, tenantId: string) {
  const { data } = await supabase
    .from("connections")
    .select("status, metadata")
    .eq("tenant_id", tenantId)
    .eq("provider", "easypost")
    .maybeSingle();
  const metadata = (data?.metadata ?? {}) as Record<string, unknown>;
  return {
    status: (data?.status ?? "none") as "active" | "needs_reconnect" | "disconnected" | "none",
    testMode: metadata.mode === "test",
  };
}

/** A label that was paid for (or may have been) and isn't a parcel yet. */
export type UnfinishedLabel = {
  id: string;
  status: "buying" | "bought";
  carrier: string | null;
  service: string | null;
  tracking_number: string | null;
  label_url: string | null;
  label_mode: string | null;
  buying_at: string | null;
};

export async function loadUnfinishedLabels(
  supabase: SupabaseClient,
  tenantId: string,
  orderId: string,
): Promise<UnfinishedLabel[]> {
  const { data } = await supabase
    .from("shipping_label_quotes")
    .select("id, status, carrier, service, tracking_number, label_url, label_mode, buying_at")
    .eq("tenant_id", tenantId)
    .eq("shipping_order_id", orderId)
    .in("status", ["buying", "bought"])
    .order("buying_at");
  return (data ?? []) as unknown as UnfinishedLabel[];
}

/** "2 × Wool rug (Large), 3 × Yarn bundle" for what's still to go. */
export const itemsSummary = (order: Pick<ShippingOrder, "items">) =>
  order.items
    .filter((item) => item.left > 0)
    .map((item) => `${item.left} × ${item.title}${item.variant ? ` (${item.variant})` : ""}`)
    .join(", ");

/** A request returns 1,000 rows at most, so a busy shop's open orders are read in pages. */
const PAGE = 1000;
const MOST = 5000;

/** Every order with something still to send, oldest first. */
export async function loadOpenOrders(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<ShippingOrder[]> {
  const orders: ShippingOrder[] = [];
  for (let from = 0; from < MOST; from += PAGE) {
    const { data } = await supabase
      .from("shipping_orders")
      .select(ORDER_FIELDS)
      .eq("tenant_id", tenantId)
      .gt("units_left", 0)
      .eq("cancelled", false)
      .is("picked_up_at", null)
      .order("placed_at")
      .order("id")
      .range(from, from + PAGE - 1);
    const page = (data ?? []) as unknown as ShippingOrder[];
    orders.push(...page);
    if (page.length < PAGE) break;
  }
  return orders;
}

export type QueueStep = QueueFacts & { id: string; placed_at: string };

/** The open orders with only what's needed to say which view each is in, oldest first. */
export async function loadQueueSteps(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<QueueStep[]> {
  const steps: QueueStep[] = [];
  for (let from = 0; from < MOST; from += PAGE) {
    const { data } = await supabase
      .from("shipping_orders")
      .select(
        "id, placed_at, units_left, cancelled, paid, on_hold, hold_until, pickup, pickup_ready_at, picked_up_at, shipping_method, country_code",
      )
      .eq("tenant_id", tenantId)
      .gt("units_left", 0)
      .eq("cancelled", false)
      .is("picked_up_at", null)
      .order("placed_at")
      .order("id")
      .range(from, from + PAGE - 1);
    const page = (data ?? []) as unknown as QueueStep[];
    steps.push(...page);
    if (page.length < PAGE) break;
  }
  return steps;
}

/** "Hudson, NY" at home, "Toronto, ON, Canada" abroad. */
export const placeOf = (
  order: Pick<ShippingOrder, "city" | "region" | "country_code">,
  homeCountry: string,
  countryLabel: (code: string) => string,
) =>
  [
    order.city,
    order.region,
    order.country_code && order.country_code !== homeCountry.toUpperCase()
      ? countryLabel(order.country_code)
      : null,
  ]
    .filter(Boolean)
    .join(", ");
