/**
 * Background worker. Runs as its own Railway service (`pnpm worker`).
 *
 * Jobs:
 *  - on start, make sure Stripe has the plans from plans.ts
 *  - apply queued Stripe events to the subscriptions table
 *  - run sync jobs for connected accounts (first sync, webhooks, scheduled pulls)
 *  - every few minutes, queue pulls for providers that don't push changes
 *  - once an hour, delete workspaces whose retention window has passed
 *    (only when ENABLE_TENANT_PURGE=true)
 */
import { ensureStripeCatalog } from "../src/lib/billing/setup";
import { liveSyncDeps } from "../src/lib/billing/store";
import { billingConfigured, getStripe } from "../src/lib/billing/stripe";
import { processStripeEvent, type StripeEventLike } from "../src/lib/billing/sync";
import { PROVIDER_ORDER, getAdapter } from "../src/lib/connections/registry";
import { runSyncJob, type RunnerDeps, type SyncJob } from "../src/lib/connections/runner";
import { getProviderToken, vaultTokenStore, type TokenDeps } from "../src/lib/connections/tokens";
import { sendEmail } from "../src/lib/email";
import { getAdminClient } from "../src/lib/supabase/admin";

const POLL_MS = 5_000;
const SCHEDULE_EVERY_MS = 5 * 60 * 1000;
const PURGE_EVERY_MS = 60 * 60 * 1000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

async function drainStripeEvents(): Promise<number> {
  const admin = getAdminClient();
  const { data, error } = await admin.rpc("claim_stripe_events", { p_limit: 10 });
  if (error) throw new Error(`Could not claim Stripe events: ${error.message}`);
  const events = (data ?? []) as (StripeEventLike & { attempts: number })[];
  const deps = liveSyncDeps(admin);

  for (const event of events) {
    let failure: string | null = null;
    try {
      const result = await processStripeEvent(event, deps);
      console.log(`stripe event ${event.id} (${event.type}): ${result}`);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      console.error(`stripe event ${event.id} failed (attempt ${event.attempts}): ${failure}`);
    }
    const { error: completeError } = await admin.rpc("complete_stripe_event", {
      p_id: event.id,
      p_error: failure,
    });
    if (completeError) console.error(`could not mark ${event.id}: ${completeError.message}`);
  }
  return events.length;
}

/** Tells a workspace's owners that a connection stopped working. */
async function notifyNeedsReconnect(info: { tenantId: string; provider: string; reason: string }) {
  const admin = getAdminClient();
  const [{ data: owners }, { data: tenants }] = await Promise.all([
    admin.rpc("tenant_owner_emails", { p_tenant_id: info.tenantId }),
    admin.from("tenants").select("name, slug").eq("id", info.tenantId),
  ]);
  const tenant = (tenants as { name: string; slug: string }[] | null)?.[0];
  if (!tenant) return;
  const name = PROVIDER_ORDER.includes(info.provider as never)
    ? getAdapter(info.provider as (typeof PROVIDER_ORDER)[number]).name
    : info.provider;
  const site = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/+$/, "");
  for (const { email } of (owners ?? []) as { email: string }[]) {
    await sendEmail({
      to: email,
      subject: `${name} needs reconnecting for ${tenant.name}`,
      text: [
        `Maker Business Suite can no longer reach ${name} for ${tenant.name}, so its data has stopped updating.`,
        "",
        "This usually happens when access was removed or expired. Reconnecting takes a minute:",
        `${site}/w/${tenant.slug}/connections`,
      ].join("\n"),
    });
  }
}

function runnerDeps(): RunnerDeps {
  const admin = getAdminClient();
  const tokenDeps: TokenDeps = {
    store: vaultTokenStore(admin),
    adapter: getAdapter,
    now: Date.now,
    wait: sleep,
    onNeedsReconnect: notifyNeedsReconnect,
  };
  const check = (what: string, error: { message: string } | null) => {
    if (error) throw new Error(`${what}: ${error.message}`);
  };
  return {
    adapter: getAdapter,
    getToken: (tenantId, provider) => getProviderToken(tenantId, provider, tokenDeps),
    async finish(jobId, outcome) {
      const { error } = await admin.rpc("finish_sync_job", {
        p_id: jobId,
        p_error: outcome.error ?? null,
        p_cursor: outcome.cursor ?? null,
        p_retry: outcome.retry ?? true,
      });
      check("Could not finish sync job", error);
    },
    async updateAccount(connectionId, account) {
      const { error } = await admin.rpc("update_connection_details", {
        p_connection_id: connectionId,
        p_display_name: account.displayName ?? null,
        p_metadata: account.metadata ?? {},
      });
      check("Could not update connection", error);
    },
    async disconnect(connectionId, reason) {
      const { error } = await admin.rpc("mark_connection", {
        p_connection_id: connectionId,
        p_status: "disconnected",
        p_error: reason,
      });
      check("Could not disconnect", error);
    },
  };
}

async function drainSyncJobs(): Promise<number> {
  const admin = getAdminClient();
  const { data, error } = await admin.rpc("claim_sync_jobs", { p_limit: 5 });
  if (error) throw new Error(`Could not claim sync jobs: ${error.message}`);
  const jobs = (data ?? []) as SyncJob[];
  const deps = runnerDeps();
  for (const job of jobs) {
    const outcome = await runSyncJob(job, deps);
    console.log(`sync job ${job.id} (${job.provider} ${job.topic ?? job.type}): ${outcome}`);
  }
  return jobs.length;
}

async function queueScheduledSyncs() {
  const admin = getAdminClient();
  for (const key of PROVIDER_ORDER) {
    const hours = getAdapter(key).pollEveryHours;
    if (!hours) continue;
    const { data, error } = await admin.rpc("enqueue_scheduled_syncs", {
      p_provider: key,
      p_every: `${hours} hours`,
    });
    if (error) throw new Error(`Could not schedule ${key} syncs: ${error.message}`);
    if (data) console.log(`queued ${data} scheduled ${key} sync(s)`);
  }
}

async function purgeExpiredTenants() {
  if (process.env.ENABLE_TENANT_PURGE !== "true") return;
  const { data, error } = await getAdminClient().rpc("purge_expired_tenants");
  if (error) throw new Error(`Purge failed: ${error.message}`);
  if (data) console.log(`purged ${data} expired workspace(s)`);
}

/** Runs a task so that one failing job never stops the others. */
async function attempt<T>(task: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await task();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return fallback;
  }
}

async function main() {
  console.log("worker started");
  // Keep Stripe's products and prices in step with plans.ts.
  if (billingConfigured()) {
    await attempt(
      () => ensureStripeCatalog(getStripe(), (m) => console.log(`stripe setup: ${m}`)),
      undefined,
    );
  }
  let lastSchedule = 0;
  let lastPurge = 0;
  while (!stopping) {
    const handled = (await attempt(drainStripeEvents, 0)) + (await attempt(drainSyncJobs, 0));

    if (Date.now() - lastSchedule > SCHEDULE_EVERY_MS) {
      lastSchedule = Date.now();
      await attempt(queueScheduledSyncs, undefined);
    }
    if (Date.now() - lastPurge > PURGE_EVERY_MS) {
      lastPurge = Date.now();
      await attempt(purgeExpiredTenants, undefined);
    }
    if (handled === 0) await sleep(POLL_MS);
  }
  console.log("worker stopped");
}

void main();
