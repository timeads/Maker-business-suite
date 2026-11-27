import type { SupabaseClient } from "@supabase/supabase-js";
import { shopPermission } from "../connections/shop-permission";
import { connectionFact } from "../setup/connection";
import { BUDGET_KEY } from "./budget";
import { BOOKINGS_MODULE, EMAILS_KEY } from "./config";
import type { BookingsSetupFacts, ServiceFact } from "./setup";
import { canTagInShopify } from "./shop-tags";
import { TEXTS_KEY, parseTextSettings } from "../texts/config";
import { WORDS_KEY, parseEmailWords } from "./words";

/** A `services` row as the Bookings pages read it, with the shop link. */
export type ServiceRow = {
  id: string;
  kind: string;
  name: string;
  price_cents: number;
  active: boolean;
  shop_product_id?: string | null;
  shop_linked_at?: string | null;
};

/** The columns the checklist needs from `services`. */
export const SETUP_SERVICE_COLUMNS =
  "id, kind, name, price_cents, active, shop_product_id, shop_linked_at";

export const serviceFact = (row: ServiceRow): ServiceFact => ({
  id: row.id,
  name: row.name,
  kind: row.kind === "appointment" ? "appointment" : "workshop",
  active: Boolean(row.active),
  paid: Number(row.price_cents) > 0,
  inShop: Boolean(row.shop_product_id),
});

/**
 * The facts the Bookings checklist is worked out from, read as the member.
 * `services` hands over what the first page already read (with
 * `SETUP_SERVICE_COLUMNS`). Everything else is a short list or a count: the
 * dates and hours by service only, a booking from the shop only as a count,
 * the budget only for owners and admins. A part that fails is left out
 * (counted as done), never an error, so a checklist never nags by mistake.
 */
export async function loadBookingsSetupFacts(
  supabase: SupabaseClient,
  tenant: { id: string },
  opts: {
    manager: boolean;
    can: (feature: "texts" | "eventbrite") => boolean;
    services?: ServiceRow[];
    now?: Date;
  },
): Promise<BookingsSetupFacts> {
  const now = opts.now ?? new Date();
  const servicesRead = opts.services
    ? { data: opts.services, error: null }
    : await supabase
        .from("services")
        .select(SETUP_SERVICE_COLUMNS)
        .eq("tenant_id", tenant.id)
        .limit(500);
  const rows = (servicesRead.data ?? []) as ServiceRow[];
  const linked = rows
    .map((row) => row.shop_linked_at)
    .filter((at): at is string => typeof at === "string")
    .sort();
  const none = Promise.resolve({ data: null, error: null, count: null });

  const [dates, hours, connections, configs, fromShop, any, supplies] = await Promise.all([
    supabase
      .from("sessions")
      .select("service_id")
      .eq("tenant_id", tenant.id)
      .is("cancelled_at", null)
      .gte("starts_at", now.toISOString())
      .limit(1000),
    supabase.from("availability_rules").select("service_id").eq("tenant_id", tenant.id).limit(1000),
    // Named columns only: members can't read the whole row.
    supabase
      .from("connections")
      .select("provider, status, last_synced_at, last_error, scopes, metadata")
      .eq("tenant_id", tenant.id)
      .in("provider", ["stripe", "shopify", "twilio", "eventbrite"]),
    supabase
      .from("configs")
      .select("key, body")
      .eq("tenant_id", tenant.id)
      .eq("module", BOOKINGS_MODULE)
      .in("key", [EMAILS_KEY, WORDS_KEY, TEXTS_KEY, ...(opts.manager ? [BUDGET_KEY] : [])]),
    // The one sign the theme's snippet works: a booking from the shop since a workshop was linked.
    linked.length > 0
      ? supabase
          .from("bookings")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenant.id)
          .not("shop_order_id", "is", null)
          .gte("created_at", linked[0])
      : none,
    supabase.from("bookings").select("id").eq("tenant_id", tenant.id).limit(1),
    supabase
      .from("class_supplies")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant.id),
  ]);

  const services = servicesRead.error ? [] : rows.map(serviceFact);
  const idsOf = (read: { data: unknown; error: unknown }, all: string[]) =>
    read.error
      ? all
      : [
          ...new Set(
            ((read.data ?? []) as { service_id: string }[]).map((row) => String(row.service_id)),
          ),
        ];
  const everyId = services.map((s) => s.id);
  const byProvider = new Map(
    ((connections.data ?? []) as Record<string, unknown>[]).map((row) => [
      String(row.provider),
      row,
    ]),
  );
  const stripeRow = byProvider.get("stripe");
  const stripe = connectionFact(stripeRow);
  const shopRow = byProvider.get("shopify") ?? null;
  const saved = new Map(
    ((configs.data ?? []) as { key: string; body: unknown }[]).map((row) => [row.key, row.body]),
  );
  const known = !configs.error;
  const texts = parseTextSettings(saved.get(TEXTS_KEY));
  const charges = (stripeRow?.metadata as { charges_enabled?: unknown } | null)?.charges_enabled;

  return {
    now,
    services,
    workshopsWithDates: idsOf(dates, everyId),
    appointmentsWithHours: idsOf(hours, everyId),
    stripe: connections.error
      ? { status: "active", chargesEnabled: null }
      : stripe
        ? { status: stripe.status, chargesEnabled: typeof charges === "boolean" ? charges : null }
        : null,
    shop: connections.error ? null : connectionFact(shopRow),
    shopBookings: fromShop.error ? null : (fromShop.count ?? null),
    emails: {
      timingSaved: known ? saved.has(EMAILS_KEY) : true,
      wordsSaved: known ? saved.has(WORDS_KEY) : true,
      replyTo: known ? Boolean(parseEmailWords(saved.get(WORDS_KEY)).reply_to) : true,
    },
    texts:
      opts.can("texts") && !connections.error
        ? { connected: byProvider.get("twilio")?.status === "active", on: texts.on }
        : null,
    eventbrite:
      opts.can("eventbrite") && !connections.error
        ? { connected: byProvider.get("eventbrite")?.status === "active" }
        : null,
    tagPermission: shopPermission(shopRow as Parameters<typeof shopPermission>[0], canTagInShopify)
      .state,
    bookings: any.error ? null : (any.data ?? []).length,
    supplies: supplies.error ? null : (supplies.count ?? 0),
    budget: opts.manager && known ? { saved: saved.has(BUDGET_KEY) } : null,
  };
}
