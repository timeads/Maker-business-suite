/**
 * Background worker. Runs as its own Railway service (`pnpm worker`).
 *
 * Jobs:
 *  - on start, make sure Stripe has the plans from plans.ts
 *  - apply queued Stripe events to the subscriptions table
 *  - file inbound emails into help desk tickets
 *  - confirm booking payments and send booking reminders
 *  - publish scheduled social posts
 *  - run sync jobs for connected accounts (first sync, webhooks, scheduled pulls)
 *  - every few minutes, queue pulls for providers that don't push changes
 *  - once an hour, delete workspaces whose retention window has passed
 *    (only when ENABLE_TENANT_PURGE=true)
 */
import { ensureStripeCatalog } from "../src/lib/billing/setup";
import { liveSyncDeps } from "../src/lib/billing/store";
import { billingConfigured, getStripe } from "../src/lib/billing/stripe";
import { processStripeEvent, type StripeEventLike } from "../src/lib/billing/sync";
import { reminderEmail } from "../src/lib/bookings/emails";
import { isConnectEvent, processConnectEvent } from "../src/lib/bookings/payments";
import { getBookingDetails, livePaymentDeps } from "../src/lib/bookings/server";
import { PROVIDER_ORDER, getAdapter } from "../src/lib/connections/registry";
import { runSyncJob, type RunnerDeps, type SyncJob } from "../src/lib/connections/runner";
import { rpcSyncStore } from "../src/lib/connections/store";
import { getProviderToken, vaultTokenStore, type TokenDeps } from "../src/lib/connections/tokens";
import { sendEmail } from "../src/lib/email";
import { inboundDomain } from "../src/lib/helpdesk/addresses";
import { HELPDESK_MODULE, RULES_KEY, parseRules } from "../src/lib/helpdesk/config";
import {
  processInboundEmail,
  type InboundDeps,
  type IngestResult,
  type PostmarkInbound,
} from "../src/lib/helpdesk/inbound";
import { moduleOpen } from "../src/lib/module-access";
import { publishPost } from "../src/lib/social/publish";
import { publishDuePosts } from "../src/lib/social/worker";
import { getAdminClient, withTenant } from "../src/lib/supabase/admin";

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
  const paymentDeps = livePaymentDeps(admin);

  for (const event of events) {
    let failure: string | null = null;
    try {
      // Events from a business's own Stripe account are booking payments.
      const result = isConnectEvent(event)
        ? await processConnectEvent(event, paymentDeps)
        : await processStripeEvent(event, deps);
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

async function emailOwners(tenantId: string, subject: string, text: string) {
  const { data: owners } = await getAdminClient().rpc("tenant_owner_emails", {
    p_tenant_id: tenantId,
  });
  for (const { email } of (owners ?? []) as { email: string }[]) {
    await sendEmail({ to: email, subject, text });
  }
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
    store: (job) =>
      rpcSyncStore(admin, { tenantId: job.tenant_id, provider: job.provider }, (subject, text) =>
        emailOwners(job.tenant_id, subject, text),
      ),
    async requeue(jobId, cursor) {
      const { error } = await admin.rpc("requeue_sync_job", { p_id: jobId, p_cursor: cursor });
      check("Could not requeue sync job", error);
    },
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

/** Files queued inbound emails into help desk tickets. */
async function drainInboundEmails(): Promise<number> {
  const domain = inboundDomain();
  if (!domain) return 0;
  const admin = getAdminClient();
  const { data, error } = await admin.rpc("claim_inbound_emails", { p_limit: 10 });
  if (error) throw new Error(`Could not claim inbound emails: ${error.message}`);
  const emails = (data ?? []) as { id: string; payload: PostmarkInbound; attempts: number }[];

  const deps: InboundDeps = {
    async rulesFor(slug) {
      const { data: tenants } = await admin.from("tenants").select("id").eq("slug", slug);
      const tenantId = (tenants as { id: string }[] | null)?.[0]?.id;
      if (!tenantId) return null;
      return withTenant(
        tenantId,
        async (scope) => {
          const { data: config } = await scope
            .select("configs", "body")
            .eq("module", HELPDESK_MODULE)
            .eq("key", RULES_KEY)
            .maybeSingle();
          return parseRules((config as { body?: unknown } | null)?.body);
        },
        admin,
      );
    },
    async ingest(email, tags) {
      const { data: result, error: ingestError } = await admin.rpc("ingest_inbound_email", {
        p_slug: email.slug,
        p_provider_message_id: email.providerMessageId,
        p_from_email: email.fromEmail,
        p_from_name: email.fromName,
        p_subject: email.subject,
        p_body: email.body,
        p_message_id: email.messageId,
        p_reply_key: email.replyKey,
        p_references: email.references,
        p_tags: tags,
      });
      if (ingestError) throw new Error(ingestError.message);
      return result as IngestResult;
    },
  };

  for (const email of emails) {
    let failure: string | null = null;
    try {
      const result = await processInboundEmail(email.payload, domain, deps);
      console.log(`inbound email ${email.id}: ${result}`);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      console.error(`inbound email ${email.id} failed (attempt ${email.attempts}): ${failure}`);
    }
    const { error: completeError } = await admin.rpc("complete_inbound_email", {
      p_id: email.id,
      p_error: failure,
    });
    if (completeError) console.error(`could not mark ${email.id}: ${completeError.message}`);
  }
  return emails.length;
}

/** Emails a reminder for each booking that starts within a day. */
async function sendBookingReminders(): Promise<number> {
  const admin = getAdminClient();
  const { data, error } = await admin.rpc("claim_booking_reminders", { p_limit: 50 });
  if (error) throw new Error(`Could not claim booking reminders: ${error.message}`);
  const due = (data ?? []) as { id: string; tenant_id: string }[];
  for (const booking of due) {
    const details = await getBookingDetails(
      { tenantId: booking.tenant_id, bookingId: booking.id },
      admin,
    );
    if (details) await sendEmail(reminderEmail(details));
  }
  if (due.length) console.log(`sent ${due.length} booking reminder(s)`);
  return due.length;
}

/** Sends scheduled social posts whose time has come. */
async function drainSocialPosts(): Promise<number> {
  const admin = getAdminClient();
  const site = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/+$/, "");
  return publishDuePosts({
    admin,
    moduleOpen: (tenantId) => moduleOpen(tenantId, "social", admin),
    getToken: (tenantId) =>
      getProviderToken(tenantId, "meta", {
        store: vaultTokenStore(admin),
        adapter: getAdapter,
        now: Date.now,
        wait: sleep,
        onNeedsReconnect: notifyNeedsReconnect,
      }),
    publish: publishPost,
    async notifyFailed(tenantId, caption, reason) {
      const { data: tenants } = await admin.from("tenants").select("slug").eq("id", tenantId);
      const slug = (tenants as { slug: string }[] | null)?.[0]?.slug;
      await emailOwners(
        tenantId,
        "A scheduled post didn't go out",
        [
          "One of your scheduled posts couldn't be published:",
          "",
          `"${caption.slice(0, 140)}"`,
          "",
          `What we were told: ${reason}`,
          "",
          `You can fix it and schedule it again here: ${site}/w/${slug}/social`,
        ].join("\n"),
      );
    },
  });
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
    const handled =
      (await attempt(drainStripeEvents, 0)) +
      (await attempt(drainSyncJobs, 0)) +
      (await attempt(drainInboundEmails, 0)) +
      (await attempt(drainSocialPosts, 0));

    if (Date.now() - lastSchedule > SCHEDULE_EVERY_MS) {
      lastSchedule = Date.now();
      await attempt(queueScheduledSyncs, undefined);
      await attempt(sendBookingReminders, 0);
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
