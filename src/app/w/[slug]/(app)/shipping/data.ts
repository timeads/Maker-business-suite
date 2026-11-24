import type { SupabaseClient } from "@supabase/supabase-js";
import { canSendInShopify } from "@/lib/connections/providers/shopify-fulfil";
import {
  SHIPPING_MODULE,
  SHIPPING_SETTINGS_KEY,
  SLIP_LAYOUT_KEY,
  parseShippingSettings,
  parseSlipLayout,
} from "@/lib/shipping/config";
import { formatMoney } from "@/lib/dashboard/format";
import type { SavedBox } from "@/lib/shipping/labels";
import {
  NO_MEMORY,
  buildMemory,
  itemsKey,
  parseLearned,
  productsKey,
  type Learned,
  type PackingMemory,
} from "@/lib/shipping/memory";
import {
  checkGroup,
  isApproved,
  knownGroupOf,
  type GroupCheck,
  type StoredGroup,
} from "@/lib/shipping/merge";
import {
  PLAN_FIELDS,
  memoryItems,
  ruleOrder,
  type PlanOrder,
  type PlanSetup,
  type StoredPlan,
} from "@/lib/shipping/plan";
import {
  SHIPPING_RULES_KEY,
  evaluateRules,
  parseShippingRules,
  signatureOverName,
} from "@/lib/shipping/rules";
import type { QueueFacts } from "@/lib/shipping/queue";
import { LABEL_SOURCES, type LabelSourceKey } from "@/lib/shipping/sources/types";

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
    /** One unit's weight in grams, on orders synced since the shop started sharing it. */
    grams?: number | null;
    /** A small picture of the option that was ordered, on orders synced since it was kept. */
    image?: string | null;
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
  /** A rule has held this order, or a person has released it: no rule holds it again. */
  rule_hold_settled_at?: string | null;
  /** What the whole order came to, on the lists that ask for it (rules look at it). */
  order_total?: number | null;
  /** A rule asks for a signature on it, on the lists that work that out. */
  needs_signature?: boolean;
};

export const ORDER_FIELDS =
  "id, name, placed_at, recipient, company, address1, address2, city, region, postal_code, country_code, phone, email, shipping_method, note, items, units_left, cancelled, paid, on_hold, hold_reason, hold_until, shipping_paid, weight_grams, pickup, pickup_ready_at, picked_up_at, slip_printed_at, rule_hold_settled_at";

/** The workspace's shipping settings and what its shop will let us do. */
export async function loadShippingSetup(supabase: SupabaseClient, tenantId: string) {
  const [{ data: configs }, { data: shop }] = await Promise.all([
    supabase
      .from("configs")
      .select("key, body")
      .eq("tenant_id", tenantId)
      .eq("module", SHIPPING_MODULE)
      .in("key", [SHIPPING_SETTINGS_KEY, SLIP_LAYOUT_KEY, SHIPPING_RULES_KEY]),
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
    /** The workspace's shipping rules, top to bottom. */
    rules: parseShippingRules(body(SHIPPING_RULES_KEY)),
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

export type LabelConnections = {
  /** Sources ready to quote and buy, in the order they are asked. */
  active: LabelSourceKey[];
  /** Sources whose saved key has stopped working. */
  needsReconnect: LabelSourceKey[];
  /** Sources that say their labels are practice ones (a test key, UPS's test system). */
  testMode: LabelSourceKey[];
};

/**
 * Which places the workspace can buy labels from. Only what members may read
 * is named here: each connection's status and details (test or production).
 * The keys themselves are in Vault and never come near this query.
 */
export async function loadLabelConnections(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<LabelConnections> {
  const { data } = await supabase
    .from("connections")
    .select("provider, status, metadata")
    .eq("tenant_id", tenantId)
    .in("provider", [...LABEL_SOURCES]);
  const rows = (data ?? []) as {
    provider: string;
    status: string;
    metadata: Record<string, unknown> | null;
  }[];
  const withStatus = (status: string) =>
    LABEL_SOURCES.filter((key) =>
      rows.some((row) => row.provider === key && row.status === status),
    );
  const active = withStatus("active");
  return {
    active,
    needsReconnect: withStatus("needs_reconnect"),
    testMode: active.filter((key) =>
      rows.some((row) => row.provider === key && row.metadata?.mode === "test"),
    ),
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
  /** Where it was (or may have been) bought. */
  provider: string;
  buying_at: string | null;
  /** How many boxes the purchase covers. */
  box_count: number;
  /** Every box's tracking number and label, once bought (see `labelBoxes`). */
  parcels: unknown;
};

export async function loadUnfinishedLabels(
  supabase: SupabaseClient,
  tenantId: string,
  orderId: string,
): Promise<UnfinishedLabel[]> {
  const { data } = await supabase
    .from("shipping_label_quotes")
    .select(
      "id, status, provider, carrier, service, tracking_number, label_url, label_mode, buying_at, box_count, parcels",
    )
    .eq("tenant_id", tenantId)
    // On the order the label was bought on, or on one that is riding along with it.
    .or(`shipping_order_id.eq.${orderId},rider_ids.cs.{${orderId}}`)
    .in("status", ["buying", "bought"])
    .order("buying_at");
  return (data ?? []) as unknown as UnfinishedLabel[];
}

/** What people have decided about orders going together: saved, "not now", approved. */
export async function loadGroups(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<StoredGroup[]> {
  const { data } = await supabase
    .from("shipping_groups")
    .select("order_ids, saved_at, dismissed_at, approved_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(1000);
  return (data ?? []) as unknown as StoredGroup[];
}

export type Sale = {
  net_sales: number | string;
  total_tax: number | string;
  total_shipping: number | string;
  total: number | string;
};
/**
 * What the order page shows when the sync has it: the shop's tags on the
 * order, and the products before discounts with the discounts themselves.
 */
export type OrderExtras = {
  tags: string[];
  gross_sales: number | null;
  total_discounts: number | null;
};

/**
 * Asked apart from the order itself and allowed to fail, so the page still
 * opens for orders (or a database) from before these were kept.
 */
export async function loadOrderExtras(
  supabase: SupabaseClient,
  tenantId: string,
  ids: string[],
): Promise<Map<string, OrderExtras>> {
  const found = new Map<string, OrderExtras>();
  if (ids.length === 0) return found;
  const { data, error } = await supabase
    .from("shipping_orders")
    .select("id, tags, sale:orders(gross_sales, total_discounts)")
    .eq("tenant_id", tenantId)
    .in("id", ids.slice(0, 20));
  if (error || !data) return found;
  type Figures = { gross_sales: number | string | null; total_discounts: number | string | null };
  const amount = (value: number | string | null | undefined) =>
    value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
  for (const row of data as unknown as {
    id: string;
    tags: unknown;
    sale: Figures | Figures[] | null;
  }[]) {
    const sale = (Array.isArray(row.sale) ? row.sale[0] : row.sale) ?? null;
    found.set(row.id, {
      tags: Array.isArray(row.tags)
        ? row.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim() !== "")
        : [],
      gross_sales: amount(sale?.gross_sales),
      total_discounts: amount(sale?.total_discounts),
    });
  }
  return found;
}

export type OrderWithSale = ShippingOrder & {
  sale?: Sale | Sale[] | null;
  external_id?: string;
  provider?: string;
};
export const ORDER_WITH_SALE = `${ORDER_FIELDS}, external_id, provider, sale:orders(net_sales, total_tax, total_shipping, total)`;

/**
 * The orders someone wants to send together, checked: all there, all still
 * waiting, and going to one place (or approved as one). Oldest first when ok.
 */
export async function loadGroup(
  supabase: SupabaseClient,
  tenantId: string,
  ids: string[],
  today: string,
): Promise<{ check: GroupCheck; orders: OrderWithSale[] }> {
  const wanted = [...new Set(ids)].slice(0, 20);
  const [{ data }, groups] = await Promise.all([
    supabase
      .from("shipping_orders")
      .select(ORDER_WITH_SALE)
      .eq("tenant_id", tenantId)
      .in("id", wanted),
    loadGroups(supabase, tenantId),
  ]);
  const found = (data ?? []) as unknown as OrderWithSale[];
  const check = checkGroup(ids, found, isApproved(groups, ids), today);
  const byId = new Map(found.map((order) => [order.id, order]));
  return {
    check,
    orders: check.ok ? check.orders.map((order) => byId.get(order.id)!) : [],
  };
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

/** The sale's total beside each order, for the signature rule. */
const WITH_TOTAL = ", sale:orders(total)";
type TotalJoin = {
  sale?: { total: number | string | null } | { total: number | string | null }[] | null;
};

/** The joined sale's total as a plain number on the row itself. */
function withOrderTotal<T extends object>(row: T & TotalJoin): T & { order_total: number | null } {
  const { sale, ...rest } = row;
  const total = (Array.isArray(sale) ? sale[0] : sale)?.total;
  const amount = total === null || total === undefined ? Number.NaN : Number(total);
  return { ...(rest as T), order_total: Number.isFinite(amount) ? amount : null };
}

/**
 * Every open order, oldest first, in pages. The sale's total is asked for
 * alongside; if that can't be read the orders still load, without it.
 */
async function loadOpen<T extends object>(
  supabase: SupabaseClient,
  tenantId: string,
  fields: string,
): Promise<(T & { order_total: number | null })[]> {
  const rows: (T & { order_total: number | null })[] = [];
  let totals = true;
  for (let from = 0; from < MOST; from += PAGE) {
    const read = (select: string) =>
      supabase
        .from("shipping_orders")
        .select(select)
        .eq("tenant_id", tenantId)
        .gt("units_left", 0)
        .eq("cancelled", false)
        .is("picked_up_at", null)
        .order("placed_at")
        .order("id")
        .range(from, from + PAGE - 1);
    let { data, error } = await read(totals ? `${fields}${WITH_TOTAL}` : fields);
    if (error && totals) {
      totals = false;
      ({ data, error } = await read(fields));
    }
    const page = ((data ?? []) as unknown as (T & TotalJoin)[]).map(withOrderTotal);
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

/** Every order with something still to send, oldest first. */
export const loadOpenOrders = (
  supabase: SupabaseClient,
  tenantId: string,
): Promise<ShippingOrder[]> => loadOpen<ShippingOrder>(supabase, tenantId, ORDER_FIELDS);

export type QueueStep = QueueFacts & { id: string; placed_at: string };

/** The open orders with only what's needed to say which view each is in, oldest first. */
export const loadQueueSteps = (supabase: SupabaseClient, tenantId: string): Promise<QueueStep[]> =>
  loadOpen<QueueStep>(
    supabase,
    tenantId,
    "id, placed_at, units_left, cancelled, paid, on_hold, hold_until, pickup, pickup_ready_at, picked_up_at, shipping_method, country_code",
  );

/**
 * What the list remembers about these orders (box, best price, address
 * check), by order id. Allowed to fail: the list still opens without it.
 */
export async function loadPlans(
  supabase: SupabaseClient,
  tenantId: string,
  orderIds: string[],
): Promise<Map<string, StoredPlan>> {
  const found = new Map<string, StoredPlan>();
  for (let from = 0; from < orderIds.length; from += 100) {
    const { data, error } = await supabase
      .from("shipping_order_plans")
      .select(PLAN_FIELDS)
      .eq("tenant_id", tenantId)
      .in("shipping_order_id", orderIds.slice(from, from + 100));
    if (error || !data) break;
    for (const row of data as unknown as StoredPlan[]) found.set(row.shipping_order_id, row);
  }
  return found;
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

/**
 * The group an order is waiting in (saved, or approved as one place) if it
 * can still go, oldest first. Null for an order on its own.
 */
export async function loadKnownGroup(
  supabase: SupabaseClient,
  tenantId: string,
  orderId: string,
  today: string,
): Promise<{ ids: string[]; names: string[] } | null> {
  const groups = (await loadGroups(supabase, tenantId)).filter(
    (group) => (group.saved_at || group.approved_at) && group.order_ids.includes(orderId),
  );
  if (groups.length === 0) return null;
  const ids = [...new Set(groups.flatMap((group) => group.order_ids))].slice(0, 200);
  const { data } = await supabase
    .from("shipping_orders")
    .select(ORDER_FIELDS)
    .eq("tenant_id", tenantId)
    .in("id", ids);
  const orders = (data ?? []) as unknown as ShippingOrder[];
  const found = knownGroupOf(orderId, groups, orders, today);
  if (!found) return null;
  return {
    ids: found,
    names: found.map((id) => orders.find((order) => order.id === id)?.name ?? "Order"),
  };
}

/** A remembered packing, as the settings page lists it. */
export type RememberedPacking = {
  id: string;
  label: string;
  boxes: Learned["boxes"];
  uses: number;
  updated_at: string;
};

const PACKING_FIELDS = "id, item_key, products_key, label, boxes, uses, updated_at";
/** Up to this many remembered packings are simply read whole; past it, they are looked up by key. */
const MEMORY_PAGE = 1000;

/**
 * What the workspace remembers about packing these orders: by their exact
 * items, and by their products in any quantities. Allowed to fail: planning
 * goes on without memory.
 */
export async function loadPackingMemory(
  supabase: SupabaseClient,
  tenantId: string,
  orders: Pick<PlanOrder, "items">[],
): Promise<PackingMemory> {
  if (orders.length === 0) return NO_MEMORY;
  type Row = { item_key: string; products_key: string | null; boxes: unknown; updated_at: string };
  const learned = (rows: Row[]) =>
    rows.map(parseLearned).filter((row): row is Learned => row !== null);
  const { data, error } = await supabase
    .from("shipping_packings")
    .select(PACKING_FIELDS)
    .eq("tenant_id", tenantId)
    .order("updated_at", { ascending: false })
    .limit(MEMORY_PAGE);
  if (error || !data) return NO_MEMORY;
  // Oldest first, so the latest packing of a set of products is the one kept.
  if (data.length < MEMORY_PAGE) return buildMemory(learned((data as Row[]).reverse()));

  // A long memory: only what these orders could match.
  const items = orders.map(memoryItems).filter((lines) => lines.length > 0);
  const found: Row[] = [];
  const lookUp = async (column: "item_key" | "products_key", keys: string[]) => {
    for (let from = 0; from < keys.length; from += 50) {
      const { data: rows } = await supabase
        .from("shipping_packings")
        .select(PACKING_FIELDS)
        .eq("tenant_id", tenantId)
        .in(column, keys.slice(from, from + 50))
        .order("updated_at")
        .limit(MEMORY_PAGE);
      found.push(...((rows ?? []) as Row[]));
    }
  };
  await lookUp("products_key", [...new Set(items.map(productsKey))]);
  await lookUp("item_key", [...new Set(items.map(itemsKey))]);
  return buildMemory(learned(found));
}

/** The latest remembered packings, for the settings page. */
export async function loadRememberedPackings(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<RememberedPacking[]> {
  const { data } = await supabase
    .from("shipping_packings")
    .select(PACKING_FIELDS)
    .eq("tenant_id", tenantId)
    .order("updated_at", { ascending: false })
    .limit(200);
  return ((data ?? []) as (RememberedPacking & { item_key: string; products_key: string | null })[])
    .map((row) => {
      const parsed = parseLearned(row);
      return parsed ? { ...row, boxes: parsed.boxes } : null;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
}

/** Everything planning an order needs: boxes, accounts, settings, rules and memory. */
export function planSetupOf(
  parts: {
    shipping: Awaited<ReturnType<typeof loadShippingSetup>>;
    boxes: SavedBox[];
    postage: LabelConnections;
    memory: PackingMemory;
  },
  currency: string,
): PlanSetup {
  const over = parts.shipping.settings.signature_over;
  return {
    boxes: parts.boxes,
    sources: parts.postage.active,
    settings: parts.shipping.settings,
    rules: parts.shipping.rules,
    memory: parts.memory,
    signatureName:
      over === null
        ? undefined
        : signatureOverName(over, (amount) => formatMoney(amount, currency)),
  };
}

/**
 * The orders with a label being bought, or bought and not yet a parcel: on
 * their own, or riding along on another order's. A bulk run leaves them be.
 */
export async function loadOpenLabelOrders(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<Set<string>> {
  const { data } = await supabase
    .from("shipping_label_quotes")
    .select("shipping_order_id, rider_ids")
    .eq("tenant_id", tenantId)
    .in("status", ["buying", "bought"])
    .limit(1000);
  const ids = new Set<string>();
  for (const row of (data ?? []) as { shipping_order_id: string; rider_ids: string[] | null }[]) {
    ids.add(row.shipping_order_id);
    for (const rider of row.rider_ids ?? []) ids.add(rider);
  }
  return ids;
}

/**
 * The open orders as the rules see them: whether a signature is asked for,
 * and any hold a rule calls for laid over the order, so the list is right
 * the moment it is read. `holds` are those rule holds that still have to be
 * written down (`hold_shipping_orders_by_rule`); an order a rule has held
 * before, or a person has released, is never held again.
 */
export function withRuleFacts(
  orders: ShippingOrder[],
  setup: Pick<PlanSetup, "rules" | "settings" | "signatureName">,
): { orders: ShippingOrder[]; holds: { id: string; note: string }[] } {
  const holds: { id: string; note: string }[] = [];
  const home = setup.settings.ship_from_country;
  const seen = orders.map((order) => {
    const ruled = evaluateRules(ruleOrder(order, order.order_total, home), setup.rules ?? [], {
      signatureOver: setup.settings.signature_over,
      name: setup.signatureName,
    });
    const hold = ruled.hold !== null && !order.on_hold && !order.rule_hold_settled_at;
    if (hold) holds.push({ id: order.id, note: ruled.hold!.slice(0, 300) });
    return {
      ...order,
      needs_signature: ruled.signature !== null,
      ...(hold ? { on_hold: true, hold_reason: ruled.hold!.slice(0, 300), hold_until: null } : {}),
    };
  });
  return { orders: seen, holds };
}
