import { cache } from "react";
import { PLANS, SEATS_WITHOUT_PLAN, type Plan, type PlanKey } from "@/lib/billing/plans";
import type { SubscriptionStatus, SubscriptionSummary } from "@/lib/billing/types";
import type { ModuleKey } from "@/lib/modules";

/**
 * The one place feature gates are decided (CLAUDE.md rule 7). Everything
 * that depends on a workspace's plan or billing state asks here.
 */

export type Feature = `module.${ModuleKey}` | "mcp";
export type Limit = "seats" | "ai_credits";

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
  can(feature: Feature): boolean;
  limit(name: Limit): number;
};

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

export function resolveEntitlements(subscription: SubscriptionSummary | null): Entitlements {
  const access: Access = subscription ? ACCESS_BY_STATUS[subscription.status] : "none";
  const usable = access === "trialing" || access === "active" || access === "past_due";
  const plan = subscription && usable ? PLANS[subscription.plan as PlanKey] : null;
  const chosen = new Set(
    plan ? (subscription?.selected_modules ?? []).slice(0, plan.moduleChoices) : [],
  );

  return {
    access,
    plan,
    canWrite: access !== "read_only",
    trialEndsAt: access === "trialing" ? (subscription?.trial_end ?? null) : null,
    renewsAt: usable ? (subscription?.current_period_end ?? null) : null,
    cancelsAtPeriodEnd: Boolean(usable && subscription?.cancel_at_period_end),
    purgeAfter: access === "read_only" ? (subscription?.purge_after ?? null) : null,
    can(feature) {
      if (!plan) return false;
      if (feature === "mcp") return plan.mcp;
      const moduleKey = feature.slice("module.".length) as ModuleKey;
      return plan.includedModules.includes(moduleKey) || chosen.has(moduleKey);
    },
    limit(name) {
      if (name === "seats") return plan?.seats ?? SEATS_WITHOUT_PLAN;
      return plan?.aiCredits ?? 0;
    },
  };
}

const SUMMARY_COLUMNS =
  "tenant_id, plan, status, trial_end, current_period_end, cancel_at_period_end, ended_at, purge_after, selected_modules";

/** Entitlements for a workspace the signed-in user belongs to. */
export const getEntitlements = cache(async (tenantId: string): Promise<Entitlements> => {
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("subscriptions")
    .select(SUMMARY_COLUMNS)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(`Could not load the workspace's plan: ${error.message}`);
  return resolveEntitlements(data as SubscriptionSummary | null);
});
