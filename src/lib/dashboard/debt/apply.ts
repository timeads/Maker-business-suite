import type { SupabaseClient } from "@supabase/supabase-js";
import { DEBT_COLUMNS, withBasics, type DebtBasics } from "./basics";

/**
 * Changes a debt's basics as the signed-in owner or admin: read the debt as
 * stored (row-level security hands it only to them), lay the change over it
 * and save through the checked `save_money_debt`. A plan that pays other
 * debts is changed on Money → Debts instead. Server only.
 */
export async function applyDebtBasics(
  supabase: SupabaseClient,
  tenantId: string,
  debtId: string,
  change: DebtBasics,
): Promise<{ error?: string }> {
  const { data, error } = await supabase
    .from("money_debts")
    .select(DEBT_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("id", debtId)
    .maybeSingle();
  if (error) return { error: "We couldn't read that debt just now." };
  if (!data) return { error: "That debt isn't here any more." };
  const row = data as unknown as Record<string, unknown>;
  if (row.consolidated === true) {
    return { error: "That's a plan that pays other debts: change it on Money → Debts." };
  }
  const fields = withBasics(row, change);
  if (!fields) return { error: "Something about that debt doesn't look right." };
  const saved = await supabase.rpc("save_money_debt", {
    p_tenant_id: tenantId,
    p_debt_id: debtId,
    p_fields: fields,
  });
  if (saved.error) return { error: "We couldn't save that. Try again in a moment." };
  return {};
}
