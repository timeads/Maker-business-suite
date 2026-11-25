import type { SupabaseClient } from "@supabase/supabase-js";
import {
  customerTiles,
  matchCustomer,
  normalEmail,
  orderCards,
  ordersFor,
  shopLinks,
  type OrderCard,
  type OrderRow,
  type Parcel,
  type PhotoItem,
  type ShipTo,
  type Tiles,
} from "@/lib/helpdesk/customer";

/** How many orders get a full card; the tiles count them all. */
const CARDS = 8;

export type CustomerSide = {
  /** The shop knows this person (a customer record or at least one order). */
  known: boolean;
  shopName: string | null;
  customerUrl: string | null;
  phone: string | null;
  tiles: Tiles;
  cards: OrderCard[];
  /** The newest orders' lines, for "Back in stock?" and saved-reply placeholders. */
  recent: OrderRow[];
};

const EMPTY: CustomerSide = {
  known: false,
  shopName: null,
  customerUrl: null,
  phone: null,
  tiles: { orders: 0, lifetime: 0, last: null },
  cards: [],
  recent: [],
};

// An address is matched whole, whatever its letter case; % and _ in it are only themselves.
const exactly = (email: string) => email.replace(/[\\%_]/g, (c) => `\\${c}`);

const ORDER =
  "id, provider, external_id, name, email, customer_external_id, processed_at, total, currency, financial_status, fulfillment_status, cancelled_at, is_test";

/**
 * The customer and their orders, from what the shop sync already stored.
 * Everything is read as the signed-in member, so row-level security decides
 * what they see; nothing here calls the shop. The parts that belong to other
 * tools (addresses and parcels from Shipping, photos from Stock) are each
 * allowed to fail without costing the conversation.
 */
export async function loadCustomerSide(
  supabase: SupabaseClient,
  tenantId: string,
  rawEmail: string,
): Promise<CustomerSide> {
  const email = normalEmail(rawEmail);
  if (!email) return EMPTY;
  const [{ data: customerRows }, { data: byEmail }, { data: shop }] = await Promise.all([
    supabase
      .from("customers")
      .select("external_id, email, provider")
      .eq("tenant_id", tenantId)
      .ilike("email", exactly(email))
      .limit(5),
    supabase
      .from("orders")
      .select(ORDER)
      .eq("tenant_id", tenantId)
      .ilike("email", exactly(email))
      .order("processed_at", { ascending: false })
      .limit(250),
    supabase
      .from("connections")
      .select("provider, external_account_id")
      .eq("tenant_id", tenantId)
      .eq("provider", "shopify")
      .maybeSingle(),
  ]);
  const customers = matchCustomer(
    email,
    (customerRows ?? []) as { external_id: string; email: string | null }[],
  );
  const customerIds = customers.map((customer) => customer.external_id);
  const { data: byCustomer } =
    customerIds.length > 0
      ? await supabase
          .from("orders")
          .select(ORDER)
          .eq("tenant_id", tenantId)
          .in("customer_external_id", customerIds)
          .order("processed_at", { ascending: false })
          .limit(250)
      : { data: [] };
  const light = [...(byEmail ?? []), ...(byCustomer ?? [])].map((row) => ({
    ...(row as unknown as OrderRow),
    order_lines: null,
  }));
  const orders = ordersFor(email, customerIds, light);
  const account =
    (shop as { external_account_id?: string | null } | null)?.external_account_id ?? null;
  const provider = (shop as { provider?: string } | null)?.provider ?? null;
  const customerUrl = shopLinks(provider, account, { customer: customerIds[0] ?? null }).customer;
  if (orders.length === 0) {
    return {
      ...EMPTY,
      known: customers.length > 0,
      shopName: provider ? "Shopify" : null,
      customerUrl,
    };
  }

  const shown = orders.slice(0, CARDS);
  const ids = shown.map((order) => order.id);
  const soft = async <T>(run: () => PromiseLike<{ data: unknown }>): Promise<T[]> => {
    try {
      return ((await run()).data ?? []) as T[];
    } catch {
      return [];
    }
  };
  const [lines, shipTos] = await Promise.all([
    soft<OrderRow["order_lines"] extends (infer L)[] | null ? L & { order_id: string } : never>(
      () =>
        supabase
          .from("order_lines")
          .select("order_id, title, quantity, sku, variant_title, product_external_id")
          .eq("tenant_id", tenantId)
          .in("order_id", ids)
          .limit(400),
    ),
    soft<ShipTo>(() =>
      supabase
        .from("shipping_orders")
        .select(
          "id, order_id, recipient, company, address1, address2, city, region, postal_code, country_code, phone, shipping_method, note, units_left, cancelled",
        )
        .eq("tenant_id", tenantId)
        .in("order_id", ids),
    ),
  ]);
  const withLines = shown.map((order) => ({
    ...order,
    order_lines: lines.filter((line) => line.order_id === order.id),
  }));
  const products = [
    ...new Set(lines.map((line) => line.product_external_id).filter(Boolean)),
  ] as string[];
  const [parcels, photos] = await Promise.all([
    shipTos.length > 0
      ? soft<Parcel>(() =>
          supabase
            .from("shipments")
            .select(
              "shipping_order_id, carrier, tracking_number, tracking_url, shipped_at, voided_at",
            )
            .eq("tenant_id", tenantId)
            .in(
              "shipping_order_id",
              shipTos.map((ship) => ship.id),
            )
            .order("shipped_at"),
        )
      : Promise.resolve([]),
    products.length > 0
      ? soft<PhotoItem>(() =>
          supabase
            .from("stock_items")
            .select("sku, product_external_id, variant_title, variant_image_url, image_url")
            .eq("tenant_id", tenantId)
            .in("product_external_id", products)
            .limit(400),
        )
      : Promise.resolve([]),
  ]);

  return {
    known: true,
    shopName: provider ? "Shopify" : null,
    customerUrl,
    phone: shipTos.find((ship) => ship.order_id === shown[0].id)?.phone?.trim() || null,
    tiles: customerTiles(orders),
    cards: orderCards(withLines, shipTos, parcels, photos, { provider, account }),
    recent: withLines.slice(0, 5),
  };
}
