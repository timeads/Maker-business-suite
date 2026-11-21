import type Stripe from "stripe";
import { RETENTION_DAYS, planFromLookupKey } from "./plans";
import type { SubscriptionRow, SubscriptionStatus } from "./types";

const STATUSES: readonly SubscriptionStatus[] = [
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "paused",
  "incomplete",
  "incomplete_expired",
  "canceled",
];

const ENDED: readonly SubscriptionStatus[] = ["canceled", "incomplete_expired"];

const iso = (seconds: number | null | undefined) =>
  seconds == null ? null : new Date(seconds * 1000).toISOString();

export type SyncableRow = Omit<SubscriptionRow, "selected_modules">;

/**
 * Turns a Stripe subscription into our row. Throws when the subscription
 * isn't one of ours to track (no workspace on it, or an unknown price), so
 * the event is retried and then surfaced rather than silently dropped.
 */
export function subscriptionToRow(sub: Stripe.Subscription): SyncableRow {
  const tenantId = sub.metadata?.tenant_id;
  if (!tenantId) throw new Error(`Subscription ${sub.id} has no tenant_id in its metadata`);

  const item = sub.items.data[0];
  const plan = planFromLookupKey(item?.price.lookup_key);
  if (!item || !plan) {
    throw new Error(`Subscription ${sub.id} is on a price this app doesn't know`);
  }
  if (!STATUSES.includes(sub.status as SubscriptionStatus)) {
    throw new Error(`Subscription ${sub.id} has unknown status ${sub.status}`);
  }
  const status = sub.status as SubscriptionStatus;

  const endedAt = iso(sub.ended_at);
  let purgeAfter: string | null = null;
  if (ENDED.includes(status)) {
    const from = sub.ended_at ? sub.ended_at * 1000 : Date.now();
    purgeAfter = new Date(from + RETENTION_DAYS * 86_400_000).toISOString();
  }

  return {
    tenant_id: tenantId,
    stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    stripe_subscription_id: sub.id,
    plan,
    status,
    trial_end: iso(sub.trial_end),
    current_period_end: iso(item.current_period_end),
    cancel_at_period_end: sub.cancel_at_period_end,
    ended_at: endedAt,
    purge_after: purgeAfter,
  };
}

export type StripeEventLike = {
  id: string;
  type: string;
  payload: { data?: { object?: Record<string, unknown> } };
};

export type SyncDeps = {
  /** Reads the subscription's current state from Stripe. */
  retrieveSubscription(id: string): Promise<Stripe.Subscription>;
  /** The subscription we currently hold for a workspace, if any. */
  currentSubscriptionId(tenantId: string): Promise<{ id: string; ended: boolean } | null>;
  upsertSubscription(row: SyncableRow): Promise<void>;
};

/** Which Stripe subscription an event is about, if it concerns one at all. */
export function subscriptionIdForEvent(event: StripeEventLike): string | null {
  const object = event.payload.data?.object;
  if (!object) return null;
  if (event.type.startsWith("customer.subscription.")) {
    return typeof object.id === "string" ? object.id : null;
  }
  if (event.type === "checkout.session.completed") {
    const sub = object.subscription;
    if (typeof sub === "string") return sub;
    if (sub && typeof sub === "object" && typeof (sub as { id?: unknown }).id === "string") {
      return (sub as { id: string }).id;
    }
  }
  return null;
}

/**
 * Applies one Stripe event. The event only tells us *which* subscription
 * changed; the state we store always comes from Stripe at processing time.
 * That makes replays and out-of-order deliveries harmless: handling the same
 * event twice, or an old event late, writes the same current truth.
 */
export async function processStripeEvent(
  event: StripeEventLike,
  deps: SyncDeps,
): Promise<"applied" | "ignored"> {
  const subscriptionId = subscriptionIdForEvent(event);
  if (!subscriptionId) return "ignored";

  const row = subscriptionToRow(await deps.retrieveSubscription(subscriptionId));

  // A late event about an old, ended subscription must not overwrite the
  // live one the workspace has since started.
  const current = await deps.currentSubscriptionId(row.tenant_id);
  const rowEnded = ENDED.includes(row.status);
  if (current && current.id !== row.stripe_subscription_id && rowEnded && !current.ended) {
    return "ignored";
  }

  await deps.upsertSubscription(row);
  return "applied";
}
