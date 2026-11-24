import type { SupabaseClient } from "@supabase/supabase-js";
import { localDay } from "../bookings/slots";
import type { TokenDeps } from "../connections/tokens";
import { ReconnectRequiredError } from "../connections/types";
import { postAlert } from "../messages/alerts";
import { featureOpen } from "../module-access";
import { withTenant, type TenantScope } from "../supabase/admin";
import { getMichaelsAccess } from "./access";
import { runAlerts } from "./alerts";
import { michaelsClientFor, type MichaelsClient } from "./client";
import { MICHAELS_MODULE, MICHAELS_SETTINGS_KEY, parseMichaelsSettings } from "./config";
import { keyExpiry } from "./mapping";
import {
  runMichaelsWatch,
  type RunDeps,
  type RunItem,
  type RunOutcome,
  type StoredFigures,
} from "./run";

/**
 * The worker's side of a look at Michaels: everything `runMichaelsWatch`
 * needs, read and written for one named workspace. Tenant data is only ever
 * touched through `withTenant` or a function that names the workspace.
 */

export type ClaimedLook = { id: string; tenant_id: string; source: string };

const PAGE = 1000;

/** Every row of a tenant-scoped query, a page at a time (the API hands back 1,000 at most). */
async function all<T>(
  scope: TenantScope,
  table: string,
  columns: string,
  limit = 60_000,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; from < limit; from += PAGE) {
    const { data, error } = await scope
      .select(table, columns)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read ${table}: ${error.message}`);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

type ItemRow = {
  id: string;
  title: string;
  variant_title: string | null;
  sku: string | null;
  on_hand: number;
  tracked: boolean;
  price: number | null;
};

const chunks = <T>(rows: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
};

export type LookDeps = {
  admin: SupabaseClient;
  tokenDeps: TokenDeps;
  /** For tests: the client to read Michaels with, instead of the workspace's own. */
  clientFor?: (tenantId: string) => Promise<MichaelsClient>;
  now?: () => Date;
};

/** Runs one claimed look to its end and closes it. Never throws. */
export async function runClaimedLook(look: ClaimedLook, deps: LookDeps): Promise<string> {
  const { admin } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw new Error(`${fn} failed: ${error.message}`);
    return data as T;
  };
  const finish = (outcome: Pick<RunOutcome, "status" | "counts" | "changes" | "error">) =>
    rpc<{ send_blocked: string; failed_in_row: number }>("finish_michaels_run", {
      p_run_id: look.id,
      p_status: outcome.status,
      p_counts: outcome.counts,
      p_changes: outcome.changes,
      p_error: outcome.error,
    });
  const emptyCounts = (): RunOutcome["counts"] => ({
    listings: null,
    stock: null,
    prices: null,
    changes: 0,
    more_changes: false,
    orders: null,
    job_errors: {},
  });

  let outcome: RunOutcome;
  let connectionId = "";
  let keyCreatedOn: string | null = null;
  let timezone = "America/New_York";
  try {
    if (!(await featureOpen(look.tenant_id, "michaels", admin))) {
      throw new LookStopped("Stock isn't part of this workspace's plan right now.");
    }
    const { settings, connection } = await withTenant(
      look.tenant_id,
      async (scope) => {
        const [{ data: config }, { data: conn }] = await Promise.all([
          scope
            .select("configs", "body")
            .eq("module", MICHAELS_MODULE)
            .eq("key", MICHAELS_SETTINGS_KEY)
            .maybeSingle(),
          scope.select("connections", "id, metadata").eq("provider", "michaels").maybeSingle(),
        ]);
        return {
          settings: parseMichaelsSettings((config as { body?: unknown } | null)?.body),
          connection: conn as { id: string; metadata: Record<string, unknown> | null } | null,
        };
      },
      admin,
    );
    if (!settings.enabled) throw new LookStopped("Michaels is switched off in its settings.");
    connectionId = connection?.id ?? "";
    const created = connection?.metadata?.key_created_on;
    keyCreatedOn = typeof created === "string" ? created : null;
    const { data: tenants } = await admin
      .from("tenants")
      .select("timezone")
      .eq("id", look.tenant_id);
    timezone = (tenants as { timezone: string }[] | null)?.[0]?.timezone ?? timezone;

    const client = deps.clientFor
      ? await deps.clientFor(look.tenant_id)
      : michaelsClientFor(await getMichaelsAccess(look.tenant_id, deps.tokenDeps));

    const runDeps: RunDeps = {
      client,
      settings,
      now,
      loadItems: () =>
        withTenant(
          look.tenant_id,
          async (scope) =>
            (
              await all<ItemRow>(
                scope,
                "stock_items",
                "id, title, variant_title, sku, on_hand, tracked, price",
              )
            ).map((row): RunItem => ({
              id: row.id,
              name: row.variant_title ? `${row.title} (${row.variant_title})` : row.title,
              sku: row.sku,
              on_hand: row.on_hand,
              tracked: row.tracked,
              price: row.price,
            })),
          admin,
        ),
      loadPairings: () =>
        withTenant(
          look.tenant_id,
          (scope) =>
            all<{ seller_sku: string; stock_item_id: string | null }>(
              scope,
              "michaels_pairings",
              "seller_sku, stock_item_id",
            ),
          admin,
        ),
      loadFigures: () =>
        withTenant(
          look.tenant_id,
          async (scope) =>
            (
              await all<{
                michaels_sku_number: string;
                michaels_qty: number | null;
                michaels_price: number | null;
                figures_at: string | null;
              }>(
                scope,
                "michaels_listings",
                "michaels_sku_number, michaels_qty, michaels_price, figures_at",
              )
            ).map((row): StoredFigures => ({
              ...row,
              michaels_price: row.michaels_price === null ? null : String(row.michaels_price),
            })),
          admin,
        ),
      async recordListings(rows, complete) {
        for (const batch of chunks(rows, 500)) {
          await rpc("record_michaels_listings", {
            p_tenant_id: look.tenant_id,
            p_run_id: look.id,
            p_rows: batch,
          });
        }
        // Only a whole read of the catalog can say a listing is gone.
        if (complete) {
          await rpc("prune_michaels_listings", { p_tenant_id: look.tenant_id, p_run_id: look.id });
        }
      },
      async recordOrders(orders) {
        for (const batch of chunks(orders, 200)) {
          await rpc("record_michaels_orders", {
            p_tenant_id: look.tenant_id,
            p_run_id: look.id,
            p_orders: batch,
          });
        }
      },
    };
    outcome = await runMichaelsWatch(runDeps);
  } catch (err) {
    // Only words written for people go on the run; anything else stays in the log.
    const said =
      err instanceof LookStopped
        ? err.message
        : err instanceof ReconnectRequiredError
          ? "Your Michaels connection needs reconnecting, under Connections."
          : "Something went wrong on our side. We'll try again at the next look.";
    console.error(
      `michaels look ${look.id} stopped: ${err instanceof Error ? err.message : String(err)}`,
    );
    outcome = {
      status: "failed",
      counts: emptyCounts(),
      changes: [],
      error: said,
      keyRejected: false,
    };
  }

  let closed: { send_blocked: string; failed_in_row: number };
  try {
    closed = await finish(outcome);
  } catch (err) {
    console.error(
      `could not close michaels look ${look.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "unclosed";
  }

  try {
    if (outcome.keyRejected && connectionId) {
      // The key is no good: the connection says so, and the page asks for a new one.
      await rpc("mark_connection", {
        p_connection_id: connectionId,
        p_status: "needs_reconnect",
        p_error: "Michaels didn't accept the API key",
      });
    }
    const today = localDay(now, timezone);
    const alerts = runAlerts({
      key: keyExpiry(keyCreatedOn, today),
      keyRejected: outcome.keyRejected,
      connectionId,
      blocked: closed.send_blocked === "unmatched",
      unmatched: outcome.counts.listings?.unmatched ?? 0,
      skus: outcome.counts.listings?.skus ?? 0,
      failedInRow: closed.failed_in_row,
      error: outcome.error,
      month: today.slice(0, 7),
    });
    for (const alert of alerts) {
      const fresh = await rpc<boolean>("note_michaels_alert", {
        p_tenant_id: look.tenant_id,
        p_key: alert.key,
      });
      if (fresh === true) await postAlert(admin, look.tenant_id, "stock", alert.text);
    }
  } catch (err) {
    console.error(
      `michaels look ${look.id} heads-ups: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return outcome.status;
}

/** A look that stopped for a reason worth telling the workspace. */
class LookStopped extends Error {}
