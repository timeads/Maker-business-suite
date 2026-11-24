import { z } from "zod";
import { PLANS, isPlanKey } from "@/lib/billing/plans";
import type { SubscriptionStatus, SubscriptionSummary } from "@/lib/billing/types";
import { resolveEntitlements, type Entitlements, type PlanGrant } from "@/lib/entitlements";
import type { BadgeTone } from "@/components/ui/badge";

/**
 * What the platform admin area knows about a workspace. All of it comes from
 * the `admin_*` database functions, which only hand out operational facts:
 * nothing a workspace's customers wrote or bought, and no tokens.
 */

const HEALTH = ["active", "needs reconnect", "last sync failed", "disconnected"] as const;
export type ConnectionHealth = (typeof HEALTH)[number];

const count = z.coerce.number().int().nonnegative();
const when = z.string().nullable();

export const workspaceRowSchema = z.object({
  tenant_id: z.string(),
  name: z.string(),
  slug: z.string(),
  created_at: z.string(),
  owner_email: z.string().nullable(),
  member_count: count,
  plan: z.string().nullable(),
  status: z.string().nullable(),
  trial_end: when,
  current_period_end: when,
  cancel_at_period_end: z.boolean().nullable(),
  grant_plan: z.string().nullable(),
  grant_ends_at: when,
  connections: z.array(z.object({ provider: z.string(), health: z.enum(HEALTH) })),
  last_synced_at: when,
  failed_jobs_7d: count,
  ai_tokens_month: count,
});
export type WorkspaceRow = z.infer<typeof workspaceRowSchema>;

export const healthSchema = z.object({
  workspaces: count,
  trialing: count,
  paying: count,
  past_due: count,
  internal: count,
  failed_jobs_24h: count,
  needs_reconnect: count,
  stuck_jobs: count,
  stripe_events_waiting: count,
  inbound_emails_waiting: count,
});
export type Health = z.infer<typeof healthSchema>;

export const workspaceDetailSchema = z.object({
  workspace: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    timezone: z.string(),
    currency: z.string(),
    created_at: z.string(),
  }),
  members: z.array(
    z.object({ email: z.string().nullable(), role: z.string(), joined_at: z.string() }),
  ),
  subscription: z
    .object({
      plan: z.string(),
      status: z.string(),
      stripe_customer_id: z.string(),
      stripe_subscription_id: z.string(),
      trial_end: when,
      current_period_end: when,
      cancel_at_period_end: z.boolean(),
      ended_at: when,
      purge_after: when,
      selected_modules: z.array(z.string()),
    })
    .nullable(),
  grant: z
    .object({
      plan: z.string(),
      ends_at: when,
      note: z.string(),
      selected_modules: z.array(z.string()),
      granted_at: z.string(),
      granted_by: z.string().nullable(),
    })
    .nullable(),
  connections: z.array(
    z.object({
      id: z.string(),
      provider: z.string(),
      status: z.string(),
      health: z.enum(HEALTH),
      last_synced_at: when,
      last_error: z.string().nullable(),
      connected_at: z.string(),
    }),
  ),
  jobs: z.array(
    z.object({
      id: z.coerce.number(),
      provider: z.string(),
      type: z.string(),
      topic: z.string().nullable(),
      status: z.string(),
      attempts: count,
      error: z.string().nullable(),
      created_at: z.string(),
      finished_at: when,
    }),
  ),
  failed_jobs_7d: count,
  counts: z.object({
    orders: count,
    tickets: count,
    bookings: count,
    posts: count,
    stock_items: count,
    parcels: count,
  }),
  ai_tokens_month: count,
  audit: z.array(
    z.object({
      id: z.coerce.number(),
      admin_email: z.string().nullable(),
      action: z.string(),
      details: z.record(z.string(), z.unknown()),
      note: z.string().nullable(),
      created_at: z.string(),
    }),
  ),
});
export type WorkspaceDetail = z.infer<typeof workspaceDetailSchema>;

type BillingFacts = {
  plan: string | null;
  status: string | null;
  trial_end: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
  selected_modules?: string[];
};

/** The same answer the workspace itself gets, from the same resolver. */
export function entitlementsFor(
  tenantId: string,
  billing: BillingFacts | null,
  grant: { plan: string; ends_at: string | null; selected_modules?: string[] } | null,
  now: Date = new Date(),
): Entitlements {
  const subscription: SubscriptionSummary | null =
    billing && isPlanKey(billing.plan) && billing.status
      ? {
          tenant_id: tenantId,
          plan: billing.plan,
          status: billing.status as SubscriptionStatus,
          trial_end: billing.trial_end,
          current_period_end: billing.current_period_end,
          cancel_at_period_end: Boolean(billing.cancel_at_period_end),
          ended_at: null,
          purge_after: null,
          selected_modules: billing.selected_modules ?? [],
        }
      : null;
  const planGrant: PlanGrant | null =
    grant && isPlanKey(grant.plan)
      ? {
          plan: grant.plan,
          ends_at: grant.ends_at,
          selected_modules: grant.selected_modules ?? [],
        }
      : null;
  return resolveEntitlements(subscription, planGrant, now);
}

export function rowEntitlements(row: WorkspaceRow, now: Date = new Date()): Entitlements {
  return entitlementsFor(
    row.tenant_id,
    row,
    row.grant_plan ? { plan: row.grant_plan, ends_at: row.grant_ends_at } : null,
    now,
  );
}

export type PlanWords = {
  /** "Growth", or "No plan". */
  plan: string;
  /** One word for the badge. */
  word: "Internal" | "Trialing" | "Active" | "Past due" | "Ended" | "No plan";
  tone: BadgeTone;
  /** The date that matters next, if there is one. */
  date: { label: string; at: string } | null;
};

/** Plan and status as the list shows them. */
export function planWords(e: Entitlements, billing: BillingFacts | null): PlanWords {
  if (e.internal) {
    return {
      plan: e.plan?.name ?? "",
      word: "Internal",
      tone: "open",
      date: e.internal.endsAt ? { label: "until", at: e.internal.endsAt } : null,
    };
  }
  const name = e.plan?.name ?? (isPlanKey(billing?.plan) ? PLANS[billing.plan].name : "No plan");
  switch (e.access) {
    case "trialing":
      return {
        plan: name,
        word: "Trialing",
        tone: "waiting",
        date: e.trialEndsAt ? { label: "trial ends", at: e.trialEndsAt } : null,
      };
    case "active":
      return {
        plan: name,
        word: "Active",
        tone: "good",
        date: e.renewsAt
          ? { label: e.cancelsAtPeriodEnd ? "ends" : "renews", at: e.renewsAt }
          : null,
      };
    case "past_due":
      return {
        plan: name,
        word: "Past due",
        tone: "bad",
        date: e.renewsAt ? { label: "period ends", at: e.renewsAt } : null,
      };
    case "read_only":
      return { plan: name, word: "Ended", tone: "closed", date: null };
    case "none":
      return { plan: "No plan", word: "No plan", tone: "closed", date: null };
  }
}

export const HEALTH_TONE: Record<ConnectionHealth, BadgeTone> = {
  active: "good",
  "needs reconnect": "bad",
  "last sync failed": "waiting",
  disconnected: "closed",
};

/** Why a workspace wants a look, in plain words. Empty when it doesn't. */
export function attentionReasons(row: WorkspaceRow, now: Date = new Date()): string[] {
  const reasons: string[] = [];
  if (rowEntitlements(row, now).access === "past_due") reasons.push("Payment is past due");
  const reconnect = row.connections.filter((c) => c.health === "needs reconnect");
  if (reconnect.length > 0) {
    reasons.push(`${reconnect.map((c) => c.provider).join(", ")} needs reconnecting`);
  }
  if (row.failed_jobs_7d > 0) {
    reasons.push(
      `${row.failed_jobs_7d} failed ${row.failed_jobs_7d === 1 ? "job" : "jobs"} this week`,
    );
  }
  return reasons;
}

export type WorkspaceSort = "newest" | "attention";

/** Search by name, slug or owner's email; newest first, or the ones needing a look first. */
export function filterAndSort(
  rows: WorkspaceRow[],
  query: string,
  sort: WorkspaceSort,
  now: Date = new Date(),
): WorkspaceRow[] {
  const q = query.trim().toLowerCase();
  const found = q
    ? rows.filter((row) =>
        [row.name, row.slug, row.owner_email ?? ""].some((text) => text.toLowerCase().includes(q)),
      )
    : [...rows];
  const newest = (a: WorkspaceRow, b: WorkspaceRow) => b.created_at.localeCompare(a.created_at);
  if (sort === "newest") return found.sort(newest);
  const weight = new Map(found.map((row) => [row.tenant_id, attentionReasons(row, now).length]));
  return found.sort(
    (a, b) =>
      weight.get(b.tenant_id)! - weight.get(a.tenant_id)! ||
      b.failed_jobs_7d - a.failed_jobs_7d ||
      newest(a, b),
  );
}

/** "412k of 1M", for the AI allowance. */
export function compactNumber(n: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    n,
  );
}

const DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const DATE_TIME = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

/** Admin pages span workspaces in many timezones, so times are shown in UTC. */
export function formatDay(iso: string | null): string {
  return iso ? DATE.format(new Date(iso)) : "—";
}
export function formatMoment(iso: string | null): string {
  return iso ? `${DATE_TIME.format(new Date(iso))} UTC` : "—";
}

/** A date typed into the grant form ("2027-03-31") means through the end of that day, UTC. */
export function endOfDayUtc(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const at = new Date(`${day}T23:59:59.000Z`);
  return Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== day
    ? null
    : at.toISOString();
}

const ACTION_WORDS: Record<string, string> = {
  "plan_grant.set": "Set an internal plan",
  "plan_grant.ended": "Ended the internal plan",
  "sync.requeued": "Asked for a fresh sync",
};

export function auditWords(action: string, details: Record<string, unknown>): string {
  const base = ACTION_WORDS[action] ?? action;
  if (action === "plan_grant.set") {
    const plan = isPlanKey(details.plan) ? PLANS[details.plan].name : "";
    const until = typeof details.ends_at === "string" ? ` until ${formatDay(details.ends_at)}` : "";
    return `${base}: ${plan}${until || ", no end date"}`;
  }
  if (action === "sync.requeued") {
    const provider = typeof details.provider === "string" ? ` for ${details.provider}` : "";
    return `${base}${provider}${details.queued === false ? " (nothing queued: one was already waiting, or the connection isn't active)" : ""}`;
  }
  return base;
}
