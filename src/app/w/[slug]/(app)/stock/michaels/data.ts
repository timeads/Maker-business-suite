import type { SupabaseClient } from "@supabase/supabase-js";
import { localDay } from "@/lib/bookings/slots";
import {
  MICHAELS_MODULE,
  MICHAELS_SETTINGS_KEY,
  parseMichaelsSettings,
} from "@/lib/michaels/config";
import { syncHealth } from "@/lib/michaels/health";
import {
  MATCH_PROBLEMS,
  MATCH_RULES,
  centsText,
  keyExpiry,
  toCents,
  type MatchProblem,
  type MatchRule,
} from "@/lib/michaels/mapping";
import type { OrderLineRecord } from "@/lib/michaels/orders";
import type { RunCounts } from "@/lib/michaels/run";
import { parseChanges } from "@/lib/michaels/would-send";

const PAGE = 1000;

/** A stored amount as "12.50", on whole cents. */
const moneyText = (value: number | string | null): string | null => {
  const cents = toCents(value);
  return cents === null ? null : centsText(cents);
};

/** Reads every row of a query, a page at a time (the API hands back 1,000 at most). */
async function all<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
  limit = 60_000,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; from < limit; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) break;
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

export type RunRow = {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  source: "schedule" | "manual";
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  counts: Partial<RunCounts>;
  send_blocked: "watch_only" | "unmatched" | "no_scan" | null;
  error: string | null;
};

const RUN_COLUMNS =
  "id, status, source, created_at, started_at, finished_at, counts, send_blocked, error";

/** The connection, the switches and the latest looks: what every Michaels page starts from. */
export async function loadMichaels(
  supabase: SupabaseClient,
  tenant: { id: string; timezone: string },
) {
  const [{ data: connection }, { data: config }, { data: runs }] = await Promise.all([
    supabase
      .from("connections")
      .select("status, display_name, metadata")
      .eq("tenant_id", tenant.id)
      .eq("provider", "michaels")
      .maybeSingle(),
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenant.id)
      .eq("module", MICHAELS_MODULE)
      .eq("key", MICHAELS_SETTINGS_KEY)
      .maybeSingle(),
    supabase
      .from("michaels_runs")
      .select(RUN_COLUMNS)
      .eq("tenant_id", tenant.id)
      .order("created_at", { ascending: false })
      .limit(12),
  ]);
  const settings = parseMichaelsSettings(config?.body);
  const recent = ((runs ?? []) as RunRow[]).map((run) => ({ ...run, counts: run.counts ?? {} }));
  const finished = recent.filter((run) => run.status === "done" || run.status === "failed");
  const lastFinished = finished[0] ?? null;
  const lastDone = finished.find((run) => run.status === "done") ?? null;
  const metadata = (connection?.metadata ?? {}) as Record<string, unknown>;
  const status = (connection?.status ?? "none") as
    "active" | "needs_reconnect" | "disconnected" | "none";
  const today = localDay(new Date(), tenant.timezone);
  return {
    connected: status === "active" || status === "needs_reconnect",
    status,
    environment:
      metadata.environment === "sandbox" ? ("sandbox" as const) : ("production" as const),
    key: keyExpiry(
      typeof metadata.key_created_on === "string" ? metadata.key_created_on : null,
      today,
    ),
    settings,
    runs: recent,
    openRun: recent.find((run) => run.status === "queued" || run.status === "running") ?? null,
    lastFinished,
    lastDone,
    health: syncHealth({
      enabled: settings.enabled && status === "active",
      lastSuccessAt: lastDone?.finished_at ? new Date(lastDone.finished_at) : null,
      lastRunAt: recent[0] ? new Date(recent[0].created_at) : null,
      lastError: recent[0]?.status === "failed" ? recent[0].error : null,
    }),
  };
}

export type ListingView = {
  id: string;
  michaels_sku_number: string;
  primary_sku_number: string;
  seller_sku: string | null;
  item_name: string | null;
  listing_status: string | null;
  stock_item_id: string | null;
  matched_by: MatchRule | null;
  problem: MatchProblem | null;
  problem_detail: string | null;
  michaels_qty: number | null;
  michaels_price: string | null;
  michaels_updated_at: string | null;
  item: {
    id: string;
    name: string;
    sku: string | null;
    on_hand: number;
    tracked: boolean;
    price: number | null;
  } | null;
};

type ItemRow = {
  id: string;
  title: string;
  variant_title: string | null;
  sku: string | null;
  on_hand: number;
  tracked: boolean;
  price: number | null;
};

const nameOf = (row: ItemRow) =>
  row.variant_title ? `${row.title} (${row.variant_title})` : row.title;

/** Every Michaels SKU with the item it is matched to, read as the signed-in member. */
export async function loadListings(supabase: SupabaseClient, tenantId: string) {
  const rows = await all<
    Omit<ListingView, "item" | "michaels_price" | "matched_by" | "problem"> & {
      michaels_price: number | null;
      matched_by: string | null;
      problem: string | null;
    }
  >((from, to) =>
    supabase
      .from("michaels_listings")
      .select(
        "id, michaels_sku_number, primary_sku_number, seller_sku, item_name, listing_status, stock_item_id, matched_by, problem, problem_detail, michaels_qty, michaels_price, michaels_updated_at",
      )
      .eq("tenant_id", tenantId)
      .order("michaels_sku_number")
      .range(from, to),
  );
  const ids = [...new Set(rows.map((row) => row.stock_item_id).filter((id): id is string => !!id))];
  const items = new Map<string, ItemRow>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await supabase
      .from("stock_items")
      .select("id, title, variant_title, sku, on_hand, tracked, price")
      .eq("tenant_id", tenantId)
      .in("id", ids.slice(i, i + 200));
    for (const item of (data ?? []) as ItemRow[]) items.set(item.id, item);
  }
  return rows.map((row): ListingView => {
    const item = row.stock_item_id ? items.get(row.stock_item_id) : undefined;
    return {
      ...row,
      michaels_price: moneyText(row.michaels_price),
      matched_by: MATCH_RULES.includes(row.matched_by as MatchRule)
        ? (row.matched_by as MatchRule)
        : null,
      // No item means unmatched, whatever else the row says.
      problem: item
        ? null
        : MATCH_PROBLEMS.includes(row.problem as MatchProblem)
          ? (row.problem as MatchProblem)
          : "no_match",
      item: item
        ? {
            id: item.id,
            name: nameOf(item),
            sku: item.sku,
            on_hand: item.on_hand,
            tracked: item.tracked,
            price: item.price,
          }
        : null,
    };
  });
}

/** The latest look that got as far as comparing, with what it would have sent. */
export async function loadWouldSend(supabase: SupabaseClient, tenantId: string) {
  const { data } = await supabase
    .from("michaels_runs")
    .select(`${RUN_COLUMNS}, changes`)
    .eq("tenant_id", tenantId)
    .in("status", ["done", "failed"])
    .order("created_at", { ascending: false })
    .limit(6);
  const runs = (data ?? []) as (RunRow & { changes: unknown })[];
  const run = runs.find((r) => r.counts?.listings) ?? null;
  return run ? { run, changes: parseChanges(run.changes) } : null;
}

export type OrderView = {
  id: string;
  order_number: string;
  status: string;
  currency: string | null;
  placed_at: string | null;
  promise_ship_at: string | null;
  grand_total: string | null;
  lines: OrderLineRecord[];
};

/** Recent Michaels orders with their lines, and what's needed to say what each would become. */
export async function loadOrders(supabase: SupabaseClient, tenantId: string) {
  const { data: orderRows } = await supabase
    .from("michaels_orders")
    .select("id, order_number, status, currency, placed_at, promise_ship_at, grand_total")
    .eq("tenant_id", tenantId)
    .order("placed_at", { ascending: false, nullsFirst: false })
    .limit(100);
  const orders = (orderRows ?? []) as (Omit<OrderView, "lines" | "grand_total"> & {
    grand_total: number | null;
  })[];
  const lines = new Map<string, OrderLineRecord[]>();
  const ids = orders.map((order) => order.id);
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await supabase
      .from("michaels_order_lines")
      .select(
        "order_id, order_item_id, seller_sku, michaels_sku_number, product_name, quantity, unit_price, line_status",
      )
      .eq("tenant_id", tenantId)
      .in("order_id", ids.slice(i, i + 100))
      .order("order_item_id");
    for (const row of (data ?? []) as (Omit<OrderLineRecord, "unit_price"> & {
      order_id: string;
      unit_price: number | null;
    })[]) {
      const { order_id, ...line } = row;
      lines.set(order_id, [
        ...(lines.get(order_id) ?? []),
        { ...line, unit_price: moneyText(line.unit_price) },
      ]);
    }
  }
  const [listings, items] = await Promise.all([
    all<{ michaels_sku_number: string; seller_sku: string | null; stock_item_id: string | null }>(
      (from, to) =>
        supabase
          .from("michaels_listings")
          .select("michaels_sku_number, seller_sku, stock_item_id")
          .eq("tenant_id", tenantId)
          .order("michaels_sku_number")
          .range(from, to),
    ),
    all<ItemRow>((from, to) =>
      supabase
        .from("stock_items")
        .select("id, title, variant_title, sku, on_hand, tracked, price")
        .eq("tenant_id", tenantId)
        .order("id")
        .range(from, to),
    ),
  ]);
  return {
    orders: orders.map((order): OrderView => ({
      ...order,
      grand_total: moneyText(order.grand_total),
      lines: lines.get(order.id) ?? [],
    })),
    listings,
    items: items.map((item) => ({ id: item.id, sku: item.sku, name: nameOf(item) })),
  };
}
