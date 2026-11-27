import type { SupabaseClient } from "@supabase/supabase-js";
import { localDay } from "../bookings/slots";
import { googleMailConfigured } from "../connections/providers/google-mail";
import { connectionFact } from "../setup/connection";
import {
  STOCK_MODULE,
  STOCK_SEASONS_KEY,
  STOCK_SETTINGS_KEY,
  parseSeasons,
  parseStockSettings,
  type SeasonConfig,
  type StockSettings,
} from "./config";
import { STOCK_EMAIL_SOURCES_KEY } from "./mail/config";
import {
  buildStockRows,
  type ItemRow,
  type ReceivedCostRow,
  type StockRow,
  type SupplierRow,
} from "./plan";
import { stockRowFacts, type StockSetupFacts } from "./setup";

const PAGE = 1000;

async function all<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
  limit = 60_000,
): Promise<T[] | null> {
  const rows: T[] = [];
  for (let from = 0; from < limit; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) return null;
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

/** What a Stock page already read, so the card needn't read it again. */
export type StockLoaded = {
  rows: StockRow[];
  suppliers: SupplierRow[];
  settings: StockSettings;
  seasons: SeasonConfig[];
};

/**
 * The facts the Stock checklist is worked out from, read as the member.
 * `loaded` hands over what the page already read (items, suppliers,
 * settings); without it they are read here, without sales (the checklist
 * doesn't need them). Costs are read only for people who see them, and
 * bills by email only for owners and admins. A part that fails is left out.
 */
export async function loadStockSetupFacts(
  supabase: SupabaseClient,
  tenant: { id: string; timezone: string },
  opts: { manager: boolean; seesCosts: boolean; loaded?: StockLoaded; now?: Date },
): Promise<StockSetupFacts> {
  const now = opts.now ?? new Date();
  const [connections, configs, orders, loaded] = await Promise.all([
    supabase
      .from("connections")
      .select("provider, status, last_synced_at, last_error")
      .eq("tenant_id", tenant.id)
      .in("provider", ["shopify", "google_mail"]),
    supabase
      .from("configs")
      .select("key")
      .eq("tenant_id", tenant.id)
      .eq("module", STOCK_MODULE)
      .in("key", [STOCK_SETTINGS_KEY, STOCK_EMAIL_SOURCES_KEY]),
    supabase
      .from("purchase_orders")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenant.id),
    opts.loaded
      ? Promise.resolve(opts.loaded)
      : readItems(supabase, tenant, opts.seesCosts, now).catch(() => null),
  ]);
  const byProvider = new Map(
    ((connections.data ?? []) as Record<string, unknown>[]).map((row) => [
      String(row.provider),
      row,
    ]),
  );
  const saved = new Set(((configs.data ?? []) as { key: string }[]).map((row) => row.key));
  const rows = loaded
    ? stockRowFacts(loaded.rows, loaded.suppliers, opts.seesCosts)
    : { items: 0, planned: 0, noSupplier: [], suppliersNoLead: [], costsUnknown: null };
  const settings = loaded?.settings ?? parseStockSettings(null);
  return {
    now,
    shop: connections.error ? null : connectionFact(byProvider.get("shopify")),
    ...rows,
    settingsSaved: configs.error ? true : saved.has(STOCK_SETTINGS_KEY),
    orders: orders.error ? null : (orders.count ?? 0),
    gmail: {
      offered: googleMailConfigured(),
      connected: byProvider.get("google_mail")?.status === "active",
    },
    bills: opts.manager && !configs.error ? { setUp: saved.has(STOCK_EMAIL_SOURCES_KEY) } : null,
    seasons: { count: loaded?.seasons.length ?? 0, seasonality: settings.seasonality },
  };
}

/** Items, suppliers and settings, as the Stock pages read them, without sales. */
async function readItems(
  supabase: SupabaseClient,
  tenant: { id: string; timezone: string },
  seesCosts: boolean,
  now: Date,
): Promise<StockLoaded | null> {
  const fields = `id, title, variant_title, sku, on_hand, tracked, product_status, supplier_id, lead_time_days, coverage_days, safety_stock, hidden, dont_reorder, tags, case_pack, moq${
    seesCosts ? ", unit_cost, own_cost" : ""
  }`;
  const [items, suppliers, received, { data: configs, error }] = await Promise.all([
    all<ItemRow>((from, to) =>
      supabase
        .from("stock_items")
        .select(fields)
        .eq("tenant_id", tenant.id)
        .order("title")
        .order("id")
        .range(from, to),
    ),
    all<SupplierRow>((from, to) =>
      supabase
        .from("suppliers")
        .select("id, name, lead_time_days, coverage_days, moq, moq_applies_to, archived_at")
        .eq("tenant_id", tenant.id)
        .order("name")
        .range(from, to),
    ),
    seesCosts
      ? all<ReceivedCostRow>((from, to) =>
          supabase
            .rpc("stock_received_costs", { p_tenant_id: tenant.id })
            .order("stock_item_id")
            .range(from, to),
        )
      : Promise.resolve([] as ReceivedCostRow[]),
    supabase
      .from("configs")
      .select("key, body")
      .eq("tenant_id", tenant.id)
      .eq("module", STOCK_MODULE)
      .in("key", [STOCK_SETTINGS_KEY, STOCK_SEASONS_KEY]),
  ]);
  if (!items || !suppliers || error) return null;
  const body = (key: string) =>
    ((configs ?? []) as { key: string; body: unknown }[]).find((row) => row.key === key)?.body;
  const settings = parseStockSettings(body(STOCK_SETTINGS_KEY));
  const plain = seesCosts
    ? items
    : items.map((item) => ({ ...item, unit_cost: null, own_cost: null }));
  return {
    rows: buildStockRows({
      items: plain,
      suppliers,
      sales: [],
      openLines: [],
      received: received ?? [],
      settings,
      today: localDay(now, tenant.timezone),
    }),
    suppliers,
    settings,
    seasons: parseSeasons(body(STOCK_SEASONS_KEY)).seasons,
  };
}
