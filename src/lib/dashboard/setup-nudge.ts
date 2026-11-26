import type { SupabaseClient } from "@supabase/supabase-js";
import { postAlert } from "../messages/alerts";
import { moduleOpen } from "../module-access";

export const SETUP_NUDGE =
  "Your books are in. Money → Set up walks you through a few steps that make your figures true to your business: your business lines, your debts' rates and how expenses are sorted. Skip anything you like.";

/**
 * After a workspace's books are read for the first time: one heads-up in
 * Messages pointing at Money → Set up, once per workspace ever
 * (`claim_money_setup_nudge`), only where Money is on the plan. Never
 * throws: a sync never fails over a heads-up.
 */
export async function nudgeMoneySetup(admin: SupabaseClient, tenantId: string): Promise<boolean> {
  try {
    if (!(await moduleOpen(tenantId, "dashboard", admin))) return false;
    const { data, error } = await admin.rpc("claim_money_setup_nudge", { p_tenant_id: tenantId });
    if (error || data !== true) return false;
    await postAlert(admin, tenantId, "money", SETUP_NUDGE);
    return true;
  } catch (err) {
    console.error("Could not point at Money → Set up", err instanceof Error ? err.message : err);
    return false;
  }
}
