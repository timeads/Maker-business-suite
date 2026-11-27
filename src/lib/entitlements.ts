import { cache } from "react";
import { PLANS, SEATS_WITHOUT_PLAN, type Plan, type PlanKey } from "@/lib/billing/plans";
import type { SubscriptionStatus, SubscriptionSummary } from "@/lib/billing/types";
import type { ModuleKey } from "@/lib/modules";
import { seesCosts, toolAllowed, type PersonTools, type TeamRole } from "@/lib/team/tools";

/**
 * The one place feature gates are decided (CLAUDE.md rule 7). Everything
 * that depends on a workspace's plan or billing state asks here.
 */

/**
 * `michaels` is the Michaels Marketplace connector: an optional connection,
 * open to any workspace whose plan has Stock (it works on Stock's items and
 * lives under Stock). It has its own key so its place can move without
 * touching the pages that ask.
 *
 * `texts` is booking text reminders through the business's own Twilio
 * account: an optional connection, open to any workspace whose plan has
 * Bookings. Its own key, so it can become a paid extra without touching the
 * pages and the worker that ask.
 *
 * `eventbrite` is selling workshops on the business's own Eventbrite account
 * as well: an optional connection, open to any workspace whose plan has
 * Bookings, with its own key for the same reason.
 */
export type Feature = `module.${ModuleKey}` | "mcp" | "michaels" | "texts" | "eventbrite";
/**
 * `brands` is how many brands a workspace keeps (archived ones count: they
 * still hold their posts); `social_accounts` is how many accounts of ONE
 * network (Facebook Pages, or Instagram accounts) can be in use at once.
 * Both are generous on every plan, so nothing is blocked today; a workspace
 * always keeps at least its one brand.
 */
export type Limit = "seats" | "ai_credits" | "brands" | "social_accounts";

/**
 * - none: no plan picked yet
 * - trialing / active: full use of the plan
 * - past_due: a payment failed; still usable while the owner fixes their card
 * - read_only: the subscription ended; data is kept until `purgeAfter`
 */
export type Access = "none" | "trialing" | "active" | "past_due" | "read_only";

export type Entitlements = {
  access: Access;
  plan: Plan | null;
  /** False once the subscription has ended: nothing in the workspace can change. */
  canWrite: boolean;
  trialEndsAt: string | null;
  renewsAt: string | null;
  cancelsAtPeriodEnd: boolean;
  purgeAfter: string | null;
  /** The optional tools this workspace picked, on plans that include a choice. */
  chosenModules: ModuleKey[];
  /**
   * Set while the workspace is on a plan we gave it ourselves, outside
   * Stripe. `endsAt` is null when it has no end date.
   */
  internal: { endsAt: string | null } | null;
  /**
   * Whether this person can use a feature: the plan includes it AND, once
   * the workspace chooses tools per person, it is one of their tools
   * (docs/roles.md). Without a person (the worker, public pages) it is the
   * plan's answer alone.
   */
  can(feature: Feature): boolean;
  /** The plan's answer alone, whoever is asking: for "not on your plan" against "not one of your tools". */
  onPlan(feature: Feature): boolean;
  /**
   * What the business pays and what it earns in margin (item costs, label
   * costs, margins): owners and admins, and every member while the workspace
   * hasn't switched tools per person on.
   */
  seesCosts: boolean;
  /** The workspace chooses which tools each person can open. */
  toolsPerPerson: boolean;
  limit(name: Limit): number;
};

/** The tool a feature belongs to, for tools per person. */
export function featureTool(feature: Feature): ModuleKey | null {
  if (feature === "mcp") return null;
  if (feature === "michaels") return "stock";
  if (feature === "texts" || feature === "eventbrite") return "bookings";
  return feature.slice("module.".length) as ModuleKey;
}

const ACCESS_BY_STATUS: Record<SubscriptionStatus, Access> = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  unpaid: "past_due",
  incomplete: "none",
  paused: "read_only",
  canceled: "read_only",
  incomplete_expired: "read_only",
};

/** A plan given to a workspace without Stripe (`plan_grants`). */
export type PlanGrant = {
  plan: PlanKey;
  ends_at: string | null;
  selected_modules: string[];
};

function grantRunning(grant: PlanGrant | null | undefined, now: Date): grant is PlanGrant {
  if (!grant || !(grant.plan in PLANS)) return false;
  return grant.ends_at === null || new Date(grant.ends_at).getTime() > now.getTime();
}

/**
 * Stripe's subscription decides, unless the workspace has a running internal
 * grant: then it behaves as the granted plan, writable, whatever Stripe says.
 * When the grant ends the subscription's answer applies again.
 */
export function resolveEntitlements(
  subscription: SubscriptionSummary | null,
  grant: PlanGrant | null = null,
  now: Date = new Date(),
  person: PersonTools | null = null,
): Entitlements {
  const granted = grantRunning(grant, now) ? grant : null;
  const stripeAccess: Access = subscription ? ACCESS_BY_STATUS[subscription.status] : "none";
  const access: Access = granted ? "active" : stripeAccess;
  // Dates and cancellation come from Stripe, so they only count when Stripe decides.
  const usable =
    !granted && (access === "trialing" || access === "active" || access === "past_due");
  const plan = granted
    ? PLANS[granted.plan]
    : subscription && usable
      ? PLANS[subscription.plan as PlanKey]
      : null;
  const picked = granted ? granted.selected_modules : (subscription?.selected_modules ?? []);
  const chosen = new Set(plan ? picked.slice(0, plan.moduleChoices) : []);
  const onPlan = (feature: Feature): boolean => {
    if (!plan) return false;
    if (feature === "mcp") return plan.mcp;
    const tool = featureTool(feature);
    return tool !== null && (plan.includedModules.includes(tool) || chosen.has(tool));
  };

  return {
    access,
    plan,
    canWrite: access !== "read_only",
    trialEndsAt: access === "trialing" ? (subscription?.trial_end ?? null) : null,
    renewsAt: usable ? (subscription?.current_period_end ?? null) : null,
    cancelsAtPeriodEnd: Boolean(usable && subscription?.cancel_at_period_end),
    purgeAfter: access === "read_only" ? (subscription?.purge_after ?? null) : null,
    chosenModules: [...chosen] as ModuleKey[],
    internal: granted ? { endsAt: granted.ends_at } : null,
    can(feature) {
      if (!onPlan(feature)) return false;
      const tool = featureTool(feature);
      return !person || !tool || toolAllowed(person, tool);
    },
    onPlan,
    seesCosts: !person || seesCosts(person),
    toolsPerPerson: Boolean(person?.on),
    limit(name) {
      if (name === "seats") return plan?.seats ?? SEATS_WITHOUT_PLAN;
      if (name === "brands") return plan?.brands ?? 1;
      if (name === "social_accounts") return plan?.socialAccountsPerNetwork ?? 1;
      return plan?.aiCredits ?? 0;
    },
  };
}

export const SUMMARY_COLUMNS =
  "tenant_id, plan, status, trial_end, current_period_end, cancel_at_period_end, ended_at, purge_after, selected_modules";
export const GRANT_COLUMNS = "plan, ends_at, selected_modules";

type ToolAccessRow = { role: TeamRole; tools_on: boolean; tools: string[] | null };

/** The signed-in person's tools, from `my_tool_access`'s row. */
export function personFromRow(row: ToolAccessRow | null | undefined): PersonTools | null {
  if (!row) return null;
  return { role: row.role, on: Boolean(row.tools_on), tools: row.tools ?? null };
}

/**
 * Entitlements for a workspace the signed-in user belongs to, for that
 * person: the plan, and (once the workspace chooses tools per person) their
 * own tools.
 */
export const getEntitlements = cache(async (tenantId: string): Promise<Entitlements> => {
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const [{ data, error }, grant, access] = await Promise.all([
    supabase.from("subscriptions").select(SUMMARY_COLUMNS).eq("tenant_id", tenantId).maybeSingle(),
    supabase.rpc("workspace_plan_grant", { p_tenant_id: tenantId }),
    supabase.rpc("my_tool_access", { p_tenant_id: tenantId }),
  ]);
  if (error) throw new Error(`Could not load the workspace's plan: ${error.message}`);
  // If the grant can't be read, Stripe's answer stands: that is the safe side.
  const grantRow = grant.error ? null : ((grant.data as PlanGrant[] | null)?.[0] ?? null);
  // A database from before tools per person has no `my_tool_access`: then
  // everyone has what the plan has, as before. (The database itself holds
  // the line once the switch is on, whatever this says.)
  const person = access.error
    ? null
    : personFromRow((access.data as ToolAccessRow[] | null)?.[0] ?? null);
  return resolveEntitlements(data as SubscriptionSummary | null, grantRow, new Date(), person);
});
