/**
 * Background worker. Runs as its own Railway service (`pnpm worker`).
 *
 * Jobs:
 *  - on start, make sure Stripe has the plans from plans.ts
 *  - apply queued Stripe events to the subscriptions table
 *  - file inbound emails into help desk tickets
 *  - confirm booking payments and send booking reminders
 *  - publish scheduled social posts
 *  - ask UPS where incoming stock orders are, a few parcels at a time
 *  - look at Michaels for workspaces that sell there (reads only: nothing is sent)
 *  - read supplier emails into supplier balances (Gmail looks, and bills forwarded in)
 *  - run sync jobs for connected accounts (first sync, webhooks, scheduled pulls)
 *  - every few minutes, queue pulls for providers that don't push changes
 *  - once an hour, delete workspaces whose retention window has passed
 *    (only when ENABLE_TENANT_PURGE=true)
 */
import { ensureStripeCatalog } from "../src/lib/billing/setup";
import { liveSyncDeps } from "../src/lib/billing/store";
import { billingConfigured, getStripe } from "../src/lib/billing/stripe";
import { processStripeEvent, type StripeEventLike } from "../src/lib/billing/sync";
import { followupEmail, reminderEmail } from "../src/lib/bookings/emails";
import { isConnectEvent, processConnectEvent } from "../src/lib/bookings/payments";
import { getBookingDetails, getBookingEmails, livePaymentDeps } from "../src/lib/bookings/server";
import { PROVIDER_ORDER, getAdapter } from "../src/lib/connections/registry";
import { runSyncJob, type RunnerDeps, type SyncJob } from "../src/lib/connections/runner";
import { rpcSyncStore } from "../src/lib/connections/store";
import {
  SHOP_NO_PERMISSION,
  ShopPermissionError,
  createShopifySender,
} from "../src/lib/connections/providers/shopify-fulfil";
import {
  StockWriteUnsureError,
  createShopifyStockWriter,
} from "../src/lib/connections/providers/shopify-stock";
import { getProviderToken, vaultTokenStore, type TokenDeps } from "../src/lib/connections/tokens";
import { ReconnectRequiredError } from "../src/lib/connections/types";
import { sendEmail } from "../src/lib/email";
import { inboundDomain } from "../src/lib/helpdesk/addresses";
import { HELPDESK_MODULE, RULES_KEY, parseRules } from "../src/lib/helpdesk/config";
import {
  processInboundEmail,
  type InboundDeps,
  type IngestResult,
  type PostmarkInbound,
} from "../src/lib/helpdesk/inbound";
import { postAlert } from "../src/lib/messages/alerts";
import { runClaimedLook, type ClaimedLook } from "../src/lib/michaels/worker";
import { moduleOpen } from "../src/lib/module-access";
import { trackWithUps } from "../src/lib/shipping/label-access";
import { SourceError } from "../src/lib/shipping/sources/types";
import type { UpsTracking } from "../src/lib/shipping/sources/ups";
import { publishPost } from "../src/lib/social/publish";
import { publishDuePosts } from "../src/lib/social/worker";
import {
  billsTokenOf,
  processForwardedBill,
  type ForwardedPayload,
} from "../src/lib/stock/mail/forward";
import { runClaimedRead, type ClaimedRead } from "../src/lib/stock/mail/gmail-run";
import { readMail } from "../src/lib/stock/mail/reader";
import { carrierResult } from "../src/lib/stock/tracking";
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

/**
 * Files queued inbound emails: into help desk tickets, or, for mail sent to
 * a workspace's bills address, through the bills reader (never a ticket).
 */
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
    async onCreated(email, result, outcome) {
      if (!result.tenant_id || !result.ticket_id) return;
      if (outcome.priority || outcome.assignTo) {
        const { error: rulesError } = await admin.rpc("apply_ticket_rules", {
          p_tenant_id: result.tenant_id,
          p_ticket_id: result.ticket_id,
          p_priority: outcome.priority,
          p_assignee_id: outcome.assignTo,
        });
        if (rulesError) console.error(`could not apply rules: ${rulesError.message}`);
      }
      // Machines writing to the help desk don't need a heads-up.
      if (email.automated) return;
      await postAlert(
        admin,
        result.tenant_id,
        "helpdesk",
        `New conversation #${result.number} from ${email.fromName ?? email.fromEmail}: ${email.subject || "(no subject)"}${outcome.priority === "urgent" ? " (urgent)" : ""}`,
      );
    },
  };

  for (const email of emails) {
    let failure: string | null = null;
    try {
      const billsToken = billsTokenOf(email.payload as ForwardedPayload, domain);
      if (billsToken) {
        // The token is a secret: it is never logged.
        const result = await processForwardedBill(email.payload as ForwardedPayload, billsToken, {
          admin,
          read: (message, hint) => readMail(message, hint),
          now: () => new Date(),
          async tenantFor(token) {
            const { data: tenantId, error: lookupError } = await admin.rpc("receive_bills_mail", {
              p_token: token,
            });
            if (lookupError) throw new Error("could not look up a bills address");
            return (tenantId as string | null) ?? null;
          },
        });
        console.log(`inbound email ${email.id}: bills ${result}`);
      } else {
        const result = await processInboundEmail(email.payload, domain, deps);
        console.log(`inbound email ${email.id}: ${result}`);
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      console.error(`inbound email ${email.id} failed (attempt ${email.attempts}): ${failure}`);
      // A bill is never kept waiting in the queue with its text and files: after
      // the last try it is let go, and the person forwards it again.
      if (email.attempts >= 8 && billsTokenOf(email.payload as ForwardedPayload, domain)) {
        failure = null;
      }
    }
    const { error: completeError } = await admin.rpc("complete_inbound_email", {
      p_id: email.id,
      p_error: failure,
    });
    if (completeError) console.error(`could not mark ${email.id}: ${completeError.message}`);
  }
  return emails.length;
}

/**
 * Emails reminders ahead of each date and thank-yous after it. The database
 * decides what's due from each workspace's own settings; the words the
 * business added are read here.
 */
async function sendBookingReminders(): Promise<number> {
  const admin = getAdminClient();
  let sent = 0;
  for (const kind of ["reminder", "followup"] as const) {
    const { data, error } = await admin.rpc("claim_booking_emails", { p_kind: kind, p_limit: 50 });
    if (error) throw new Error(`Could not claim booking ${kind}s: ${error.message}`);
    const due = (data ?? []) as { id: string; tenant_id: string }[];
    const settings = new Map<string, Awaited<ReturnType<typeof getBookingEmails>>>();
    for (const booking of due) {
      try {
        const details = await getBookingDetails(
          { tenantId: booking.tenant_id, bookingId: booking.id },
          admin,
        );
        if (!details) continue;
        if (!settings.has(booking.tenant_id)) {
          settings.set(booking.tenant_id, await getBookingEmails(booking.tenant_id));
        }
        const words = settings.get(booking.tenant_id)!;
        await sendEmail(
          kind === "reminder"
            ? reminderEmail(details, words.reminder_note)
            : followupEmail(details, words.followup_message),
        );
        sent += 1;
      } catch (err) {
        console.error(`booking ${kind} ${booking.id}:`, err instanceof Error ? err.message : err);
      }
    }
  }
  if (sent) console.log(`sent ${sent} booking email(s)`);
  return sent;
}

/**
 * Adds deliveries that were checked in to the shop's own count, for
 * workspaces that asked for that. Each receipt is tried once; a failure is
 * recorded on it and told to the team rather than retried blindly, because a
 * repeat could add the same boxes twice. When the shop certainly added
 * nothing (it said no, or was never asked), an owner or admin may press "Try
 * the shop again", which queues one new try; when we can't tell, they can't.
 */
async function drainStockReceipts(): Promise<number> {
  const admin = getAdminClient();
  const { data, error } = await admin.rpc("claim_stock_receipt_tries", { p_limit: 20 });
  if (error) throw new Error(`Could not claim stock receipts: ${error.message}`);
  const receipts = (data ?? []) as {
    id: string;
    tenant_id: string;
    quantity: number;
    provider: string;
    inventory_item_id: string | null;
    po_number: number;
    attempt: number;
    shop_key: string;
  }[];
  if (receipts.length === 0) return 0;
  const writer = createShopifyStockWriter();
  const tokenDeps: TokenDeps = {
    store: vaultTokenStore(admin),
    adapter: getAdapter,
    now: Date.now,
    wait: sleep,
    onNeedsReconnect: notifyNeedsReconnect,
  };
  for (const receipt of receipts) {
    let failure: string | null = null;
    let unsure = false;
    try {
      if (receipt.provider !== "shopify" || !receipt.inventory_item_id) {
        throw new Error("This item isn't one the shop keeps a count of");
      }
      if (!(await moduleOpen(receipt.tenant_id, "stock", admin))) {
        throw new Error("Stock isn't part of this workspace's plan right now");
      }
      const stored = await getProviderToken(receipt.tenant_id, "shopify", tokenDeps);
      await writer.add(stored.externalAccountId, stored.token, {
        inventoryItemId: receipt.inventory_item_id,
        delta: receipt.quantity,
        reference: `app://stock/receipt/${receipt.id}`,
        key: receipt.shop_key,
      });
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      unsure = err instanceof StockWriteUnsureError;
      console.error(`stock receipt ${receipt.id} (try ${receipt.attempt}): ${failure}`);
    }
    const { error: finishError } = await admin.rpc("finish_stock_receipt_try", {
      p_id: receipt.id,
      p_error: failure,
      p_can_retry: failure !== null && !unsure,
    });
    if (finishError) console.error(`could not mark receipt ${receipt.id}: ${finishError.message}`);
    if (failure) {
      await postAlert(
        admin,
        receipt.tenant_id,
        "stock",
        `A delivery on order ${receipt.po_number} (${receipt.quantity} units) couldn't be added to your shop's count: ${failure}. ${
          unsure
            ? "Check the count in your shop and add it there by hand if it's missing."
            : "Once that's sorted, an owner or admin can press “Try the shop again” on the order, or add it in your shop by hand."
        }`,
      );
    }
  }
  return receipts.length;
}

/**
 * Asks UPS where incoming parcels are, for workspaces that have connected
 * their own UPS account. The database decides which are due (every four
 * hours until delivered, for 45 days, or when a manager presses "Check now")
 * and hands out a few at a time; each is asked about once and what UPS said
 * is written down with the time. A failure is noted on the parcel and waits
 * its turn like any other: nothing here retries by itself.
 */
async function drainShipmentChecks(): Promise<number> {
  const admin = getAdminClient();
  const { data, error } = await admin.rpc("claim_po_shipment_checks", { p_limit: 10 });
  if (error) throw new Error(`Could not claim parcel checks: ${error.message}`);
  const parcels = (data ?? []) as { id: string; tenant_id: string; tracking: string }[];
  // One number on two orders is asked about once in a pass.
  const asked = new Map<string, Promise<UpsTracking>>();
  for (const parcel of parcels) {
    let result: Record<string, string | null>;
    try {
      if (!(await moduleOpen(parcel.tenant_id, "stock", admin))) {
        throw new SourceError("Stock isn't part of this workspace's plan right now", null, false);
      }
      const key = `${parcel.tenant_id}:${parcel.tracking}`;
      let pending = asked.get(key);
      if (!pending) {
        pending = trackWithUps(parcel.tenant_id, parcel.tracking);
        asked.set(key, pending);
      }
      result = carrierResult(await pending);
    } catch (err) {
      // Only words written for people go on the parcel; anything else stays in the log.
      const said =
        err instanceof SourceError
          ? err.message
          : err instanceof ReconnectRequiredError
            ? "Your UPS connection needs reconnecting, under Connections."
            : "We couldn't reach UPS. We'll try again later.";
      console.error(
        `parcel check ${parcel.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      result = { error: said };
    }
    const { error: finishError } = await admin.rpc("finish_po_shipment_check", {
      p_id: parcel.id,
      p_result: result,
    });
    if (finishError) console.error(`could not note parcel ${parcel.id}: ${finishError.message}`);
  }
  return parcels.length;
}

/**
 * Marks recorded parcels as sent in the shop, for workspaces that asked for
 * that. Tried once each, like stock receipts: a repeat could tell a customer
 * twice that their order has shipped.
 */
async function drainShipments(): Promise<number> {
  const admin = getAdminClient();
  const { data, error } = await admin.rpc("claim_shipments_to_send", { p_limit: 20 });
  if (error) throw new Error(`Could not claim shipments: ${error.message}`);
  const shipments = (data ?? []) as {
    id: string;
    tenant_id: string;
    number: number;
    provider: string | null;
    order_external_id: string | null;
    carrier: string;
    tracking_number: string;
    tracking_url: string | null;
    tracking_numbers?: string[] | null;
    tracking_urls?: (string | null)[] | null;
    items: { line_id: string; qty: number }[];
    notify_customer: boolean;
  }[];
  if (shipments.length === 0) return 0;
  const sender = createShopifySender();
  const tokenDeps: TokenDeps = {
    store: vaultTokenStore(admin),
    adapter: getAdapter,
    now: Date.now,
    wait: sleep,
    onNeedsReconnect: notifyNeedsReconnect,
  };
  for (const shipment of shipments) {
    let failure: string | null = null;
    let fulfilmentId: string | null = null;
    try {
      if (shipment.provider !== "shopify" || !shipment.order_external_id) {
        throw new Error("This parcel isn't for an order in the shop");
      }
      if (!(await moduleOpen(shipment.tenant_id, "shipping", admin))) {
        throw new Error("Shipping isn't part of this workspace's plan right now");
      }
      const stored = await getProviderToken(shipment.tenant_id, "shopify", tokenDeps);
      ({ fulfilmentId } = await sender.send(stored.externalAccountId, stored.token, {
        orderExternalId: shipment.order_external_id,
        carrier: shipment.carrier,
        trackingNumber: shipment.tracking_number,
        trackingUrl: shipment.tracking_url,
        // A parcel in several boxes: every tracking number, on the one fulfilment.
        trackingNumbers: shipment.tracking_numbers ?? undefined,
        trackingUrls: shipment.tracking_urls ?? undefined,
        items: shipment.items,
        notifyCustomer: shipment.notify_customer,
      }));
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      console.error(`shipment ${shipment.id}: ${failure}`);
    }
    // The shop's id for what it made is kept, so the parcel can be undone there later.
    const { error: finishError } = await admin.rpc("finish_shipment_send_with", {
      p_id: shipment.id,
      p_error: failure,
      p_fulfilment_id: fulfilmentId,
    });
    if (finishError)
      console.error(`could not mark shipment ${shipment.id}: ${finishError.message}`);
    if (failure) {
      await postAlert(
        admin,
        shipment.tenant_id,
        "shipping",
        `Parcel ${shipment.number} couldn't be marked as sent in your shop: ${failure}. Mark it there by hand so your customer gets their tracking.`,
      );
    }
  }
  return shipments.length;
}

/** What a shop step came to, in the words the database keeps. */
function shopStepFailure(err: unknown): { outcome: "not_allowed" | "failed"; error: string } {
  const error = err instanceof Error ? err.message : String(err);
  return { outcome: err instanceof ShopPermissionError ? "not_allowed" : "failed", error };
}

/**
 * Undoes voided parcels in the shop, so their orders show as unfulfilled
 * again. Tried once each, like everything else we tell a shop: what happened
 * is written on the parcel, and a failure is told to the team to fix there.
 * Runs before parcels are sent, so an order that was voided and sent again
 * is free in the shop by the time the new parcel reaches it.
 */
async function drainShipmentUndos(): Promise<number> {
  const admin = getAdminClient();
  const { data, error } = await admin.rpc("claim_shipment_undos", { p_limit: 20 });
  if (error) throw new Error(`Could not claim parcels to undo: ${error.message}`);
  const undos = (data ?? []) as {
    id: string;
    tenant_id: string;
    number: number;
    order_name: string | null;
    provider: string | null;
    order_external_id: string | null;
    fulfilment_id: string | null;
    tracking_numbers: string[] | null;
    can_write: boolean;
  }[];
  if (undos.length === 0) return 0;
  const sender = createShopifySender();
  const tokenDeps: TokenDeps = {
    store: vaultTokenStore(admin),
    adapter: getAdapter,
    now: Date.now,
    wait: sleep,
    onNeedsReconnect: notifyNeedsReconnect,
  };
  for (const undo of undos) {
    let outcome: "done" | "not_found" | "not_allowed" | "failed" = "failed";
    let failure: string | null = null;
    try {
      if (undo.provider !== "shopify" || !undo.order_external_id) {
        throw new Error("This parcel isn't for an order in the shop");
      }
      // A shop connected to watch only is never written to.
      if (!undo.can_write) throw new ShopPermissionError(SHOP_NO_PERMISSION);
      if (!(await moduleOpen(undo.tenant_id, "shipping", admin))) {
        throw new Error("Shipping isn't part of this workspace's plan right now");
      }
      const stored = await getProviderToken(undo.tenant_id, "shopify", tokenDeps);
      const result = await sender.cancel(stored.externalAccountId, stored.token, {
        orderExternalId: undo.order_external_id,
        fulfilmentId: undo.fulfilment_id,
        trackingNumbers: undo.tracking_numbers ?? [],
      });
      outcome = result === "cancelled" ? "done" : "not_found";
    } catch (err) {
      ({ outcome, error: failure } = shopStepFailure(err));
      console.error(`undo of shipment ${undo.id}: ${failure}`);
    }
    const { error: finishError } = await admin.rpc("finish_shipment_undo", {
      p_id: undo.id,
      p_outcome: outcome,
      p_error: failure,
    });
    if (finishError) console.error(`could not mark undo ${undo.id}: ${finishError.message}`);
    if (outcome !== "done") {
      const why =
        outcome === "not_found"
          ? "your shop has no fulfilment with its tracking number"
          : outcome === "not_allowed"
            ? "your shop is connected without permission to change orders"
            : failure;
      await postAlert(
        admin,
        undo.tenant_id,
        "shipping",
        `Parcel ${undo.number}${undo.order_name ? ` (${undo.order_name})` : ""} was undone here, but we couldn't undo it in your shop: ${why}. Cancel the fulfilment there so the order shows as unfulfilled again.`,
      );
    }
  }
  return undos.length;
}

/**
 * Passes pickup steps on to the shop: "ready for pickup" (the shop emails the
 * customer to come and collect) and "picked up" (the order is marked
 * fulfilled there). Tried once each; what happened is kept on the order.
 */
async function drainPickupSteps(): Promise<number> {
  const admin = getAdminClient();
  const { data, error } = await admin.rpc("claim_pickup_steps", { p_limit: 20 });
  if (error) throw new Error(`Could not claim pickup steps: ${error.message}`);
  const steps = (data ?? []) as {
    id: string;
    tenant_id: string;
    name: string | null;
    provider: string | null;
    order_external_id: string | null;
    step: "ready" | "picked_up";
    can_write: boolean;
  }[];
  if (steps.length === 0) return 0;
  const sender = createShopifySender();
  const tokenDeps: TokenDeps = {
    store: vaultTokenStore(admin),
    adapter: getAdapter,
    now: Date.now,
    wait: sleep,
    onNeedsReconnect: notifyNeedsReconnect,
  };
  for (const step of steps) {
    let outcome: "sent" | "not_allowed" | "failed" = "sent";
    let failure: string | null = null;
    try {
      if (step.provider !== "shopify" || !step.order_external_id) {
        throw new Error("This order isn't one from the shop");
      }
      if (!step.can_write) throw new ShopPermissionError(SHOP_NO_PERMISSION);
      if (!(await moduleOpen(step.tenant_id, "shipping", admin))) {
        throw new Error("Shipping isn't part of this workspace's plan right now");
      }
      const stored = await getProviderToken(step.tenant_id, "shopify", tokenDeps);
      if (step.step === "ready") {
        await sender.readyForPickup(stored.externalAccountId, stored.token, step.order_external_id);
      } else {
        await sender.pickedUp(stored.externalAccountId, stored.token, step.order_external_id);
      }
    } catch (err) {
      ({ outcome, error: failure } = shopStepFailure(err));
      console.error(`pickup step for order ${step.id}: ${failure}`);
    }
    const { error: finishError } = await admin.rpc("finish_pickup_step", {
      p_id: step.id,
      p_step: step.step,
      p_outcome: outcome,
      p_error: failure,
    });
    if (finishError) console.error(`could not mark pickup step ${step.id}: ${finishError.message}`);
    if (outcome !== "sent") {
      const name = step.name ?? "A pickup order";
      await postAlert(
        admin,
        step.tenant_id,
        "shipping",
        step.step === "ready"
          ? `${name} is marked ready for pickup here, but your shop couldn't be told: ${failure}. Mark it ready in your shop so your customer hears about it.`
          : `${name} is marked picked up here, but your shop couldn't be told: ${failure}. Mark it fulfilled in your shop.`,
      );
    }
  }
  return steps.length;
}

/**
 * Looks at Michaels for workspaces that connected their seller account and
 * switched the connector on: about once an hour each, or when a manager
 * presses "Look now". The database decides who is due and hands each look to
 * one worker; a look that never finishes is marked failed, not run again.
 * Watch-only: a look reads Michaels and writes down what it WOULD send. It
 * sends nothing to Michaels and nothing to the shop.
 */
async function drainMichaelsLooks(): Promise<number> {
  const admin = getAdminClient();
  const { data, error } = await admin.rpc("claim_michaels_runs", { p_limit: 3 });
  if (error) throw new Error(`Could not claim Michaels looks: ${error.message}`);
  const looks = (data ?? []) as ClaimedLook[];
  if (looks.length === 0) return 0;
  const tokenDeps: TokenDeps = {
    store: vaultTokenStore(admin),
    adapter: getAdapter,
    now: Date.now,
    wait: sleep,
    onNeedsReconnect: notifyNeedsReconnect,
  };
  for (const look of looks) {
    const outcome = await runClaimedLook(look, { admin, tokenDeps });
    console.log(`michaels look ${look.id} (${look.source}): ${outcome}`);
  }
  return looks.length;
}

/**
 * Reads supplier emails for workspaces that switched it on and gave Gmail
 * the permission to read: once a day each at the hour they chose, or when a
 * manager presses "Read now". The database decides who is due and hands each
 * look to one worker; a look that never finishes is marked failed, not run
 * again. Only mail matching the workspace's own sources is looked at.
 */
async function drainEmailReads(): Promise<number> {
  const admin = getAdminClient();
  const { data, error } = await admin.rpc("claim_stock_email_reads", { p_limit: 2 });
  if (error) throw new Error(`Could not claim email reads: ${error.message}`);
  const reads = (data ?? []) as ClaimedRead[];
  if (reads.length === 0) return 0;
  const tokenDeps: TokenDeps = {
    store: vaultTokenStore(admin),
    adapter: getAdapter,
    now: Date.now,
    wait: sleep,
    onNeedsReconnect: notifyNeedsReconnect,
  };
  for (const read of reads) {
    const outcome = await runClaimedRead(read, {
      admin,
      tokenDeps,
      read: (message, hint) => readMail(message, hint),
      now: () => new Date(),
    });
    console.log(`email read ${read.id} (${read.source}): ${outcome}`);
  }
  return reads.length;
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
      await postAlert(
        admin,
        tenantId,
        "social",
        `A scheduled post didn't go out: "${caption.slice(0, 100)}". ${reason}`,
      );
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
      (await attempt(drainSocialPosts, 0)) +
      (await attempt(drainStockReceipts, 0)) +
      (await attempt(drainShipmentUndos, 0)) +
      (await attempt(drainShipments, 0)) +
      (await attempt(drainPickupSteps, 0)) +
      (await attempt(drainShipmentChecks, 0)) +
      (await attempt(drainMichaelsLooks, 0)) +
      (await attempt(drainEmailReads, 0));

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
