import type { SupabaseClient } from "@supabase/supabase-js";

export type AiUsage = {
  used: number;
  limit: number;
  /** warning from 80% of the month's allowance; exhausted at 100%. */
  state: "ok" | "warning" | "exhausted";
};

export function usageState(used: number, limit: number): AiUsage["state"] {
  if (limit <= 0 || used >= limit) return "exhausted";
  return used >= limit * 0.8 ? "warning" : "ok";
}

/** This calendar month's AI use for a workspace, read as the signed-in member. */
export async function getAiUsage(
  supabase: SupabaseClient,
  tenantId: string,
  limit: number,
): Promise<AiUsage> {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const { data } = await supabase
    .from("usage_events")
    .select("quantity")
    .eq("tenant_id", tenantId)
    .eq("type", "ai_tokens")
    .gte("occurred_at", monthStart.toISOString());
  const used = (data ?? []).reduce((sum, row) => sum + Number(row.quantity), 0);
  return { used, limit, state: usageState(used, limit) };
}

export const AI_EXHAUSTED =
  "You've used this month's AI allowance. It resets next month, or you can upgrade your plan for more.";
