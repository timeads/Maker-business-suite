import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCutterSettings } from "./data";
import { dayIn } from "./range";
import {
  cutterSince,
  findRecurring,
  type Decision,
  type RecurringCharge,
  type SpendRow,
} from "./recurring";

const PAGE = 1000;
const PAGES = 20;

/**
 * The recurring charges the cost cutter finds, with each one's decision, as
 * the member (row-level security applies). For the assistant; the page reads
 * the same tables the same way.
 */
export async function loadRecurringCharges(
  supabase: SupabaseClient,
  tenant: { id: string; timezone: string },
  now: Date = new Date(),
): Promise<{
  charges: RecurringCharge[];
  decisions: Map<string, { decision: Decision; note: string | null }>;
}> {
  const settings = await loadCutterSettings(supabase, tenant.id);
  const today = dayIn(now, tenant.timezone);
  const since = cutterSince(today, settings);
  const spend: SpendRow[] = [];
  for (let page = 0; page < PAGES; page++) {
    const { data, error } = await supabase
      .from("book_expenses")
      .select("txn_date, amount_cents, payee, account, sort")
      .eq("tenant_id", tenant.id)
      .is("removed_at", null)
      .eq("is_move", false)
      .gt("amount_cents", 0)
      .gte("txn_date", since)
      .order("txn_date")
      .order("id")
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`Could not load expenses: ${error.message}`);
    const batch = (data ?? []) as Record<string, unknown>[];
    for (const row of batch) {
      spend.push({
        txn_date: String(row.txn_date),
        amount_cents: Number(row.amount_cents),
        payee: (row.payee as string | null) ?? null,
        account: (row.account as string | null) ?? null,
        sort: (row.sort as string | null) ?? null,
      });
    }
    if (batch.length < PAGE) break;
  }
  const { data: decided, error } = await supabase
    .from("money_charge_decisions")
    .select("charge_key, decision, note")
    .eq("tenant_id", tenant.id)
    .limit(PAGE);
  if (error) throw new Error(`Could not load decisions: ${error.message}`);
  return {
    charges: findRecurring(spend, today, settings),
    decisions: new Map(
      ((decided ?? []) as { charge_key: string; decision: Decision; note: string | null }[]).map(
        (d) => [d.charge_key, { decision: d.decision, note: d.note }],
      ),
    ),
  };
}
