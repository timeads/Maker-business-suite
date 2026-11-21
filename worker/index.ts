/**
 * Background worker. Runs as its own Railway service (`pnpm worker`).
 *
 * Today it does two jobs:
 *  - applies queued Stripe events to the subscriptions table
 *  - once an hour, deletes workspaces whose retention window has passed
 *    (only when ENABLE_TENANT_PURGE=true)
 */
import { liveSyncDeps } from "../src/lib/billing/store";
import { processStripeEvent, type StripeEventLike } from "../src/lib/billing/sync";
import { getAdminClient } from "../src/lib/supabase/admin";

const POLL_MS = 5_000;
const PURGE_EVERY_MS = 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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

async function purgeExpiredTenants() {
  if (process.env.ENABLE_TENANT_PURGE !== "true") return;
  const { data, error } = await getAdminClient().rpc("purge_expired_tenants");
  if (error) throw new Error(`Purge failed: ${error.message}`);
  if (data) console.log(`purged ${data} expired workspace(s)`);
}

async function main() {
  console.log("worker started");
  let lastPurge = 0;
  while (!stopping) {
    try {
      const handled = await drainStripeEvents();
      if (Date.now() - lastPurge > PURGE_EVERY_MS) {
        lastPurge = Date.now();
        await purgeExpiredTenants();
      }
      if (handled > 0) continue;
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
    }
    await sleep(POLL_MS);
  }
  console.log("worker stopped");
}

void main();
