"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { DECISIONS } from "@/lib/dashboard/recurring";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

export type CutterActionState = { error?: string; message?: string };

const decisionSchema = z.object({
  key: z.string().trim().min(1).max(200),
  decision: z.enum(DECISIONS).nullable(),
  note: z.string().max(500).default(""),
  payee: z.string().max(200),
  monthly_cents: z.number().int().min(0).max(100_000_000_000),
});

/**
 * Keep, look into it, cancel it or cancelled, for one recurring charge, with
 * a note for the team. It cancels nothing anywhere: that's done with the
 * company that charges.
 */
export async function decideCharge(slug: string, input: unknown): Promise<CutterActionState> {
  const user = await requireUser(`/w/${slug}/dashboard/cost-cutter`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx || !canManage(ctx.role)) {
    return { error: "Only owners and admins can decide about charges." };
  }
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.canWrite || !entitlements.can("module.dashboard")) {
    return { error: "Your plan doesn't include changing Money right now." };
  }
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) return { error: "Something in there doesn't look right." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("decide_money_charge", {
    p_tenant_id: ctx.tenant.id,
    p_key: parsed.data.key,
    p_decision: parsed.data.decision,
    p_note: parsed.data.note,
    p_payee: parsed.data.payee,
    p_monthly_cents: parsed.data.monthly_cents,
  });
  if (error) return { error: "We couldn't save that. Try again in a moment." };
  revalidatePath(`/w/${slug}/dashboard`, "layout");
  return { message: parsed.data.decision ? "Saved." : "Cleared." };
}
