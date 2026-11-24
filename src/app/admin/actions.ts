"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isPlatformAdmin } from "@/lib/admin/platform";
import { endOfDayUtc } from "@/lib/admin/facts";
import { getUser } from "@/lib/auth";
import { isPlanKey } from "@/lib/billing/plans";
import { createClient } from "@/lib/supabase/server";

export type AdminState = { error?: string; done?: string };

const uuid = z.uuid();
const NOT_FOUND = "We couldn't find that.";
const FAILED = "That didn't save. Try again in a moment.";

/**
 * Every action here is a database function that checks the caller is a
 * platform admin and writes its own audit row. The check below only spares a
 * round trip; the database is the gate.
 */
async function adminClient() {
  const user = await getUser();
  if (!user || !(await isPlatformAdmin())) return null;
  return createClient();
}

function noteFrom(formData: FormData): string {
  return String(formData.get("note") ?? "").trim();
}

/** Gives a workspace a plan without Stripe, or changes the one it has. */
export async function setPlanGrant(
  tenantId: string,
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const supabase = await adminClient();
  if (!supabase || !uuid.safeParse(tenantId).success) return { error: NOT_FOUND };

  const plan = formData.get("plan");
  if (!isPlanKey(plan)) return { error: "Pick a plan." };
  const note = noteFrom(formData);
  if (!note) return { error: "Add a note saying why, so the next person knows." };
  if (note.length > 500) return { error: "Keep the note under 500 characters." };

  const day = String(formData.get("ends_on") ?? "").trim();
  let endsAt: string | null = null;
  if (day) {
    endsAt = endOfDayUtc(day);
    if (!endsAt) return { error: "That end date doesn't look right." };
    if (new Date(endsAt).getTime() <= Date.now()) {
      return { error: "Pick an end date in the future, or leave it empty." };
    }
  }

  const { error } = await supabase.rpc("admin_set_plan_grant", {
    p_tenant_id: tenantId,
    p_plan: plan,
    p_ends_at: endsAt,
    p_note: note,
  });
  if (error) return { error: FAILED };
  revalidatePath(`/admin/${tenantId}`);
  revalidatePath("/admin");
  return { done: "Saved. The workspace is on that plan now." };
}

/** Ends a grant now; the workspace goes back to whatever Stripe says. */
export async function endPlanGrant(
  tenantId: string,
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const supabase = await adminClient();
  if (!supabase || !uuid.safeParse(tenantId).success) return { error: NOT_FOUND };
  const note = noteFrom(formData);
  if (!note) return { error: "Add a note saying why, so the next person knows." };

  const { error } = await supabase.rpc("admin_end_plan_grant", {
    p_tenant_id: tenantId,
    p_note: note,
  });
  if (error) return { error: FAILED };
  revalidatePath(`/admin/${tenantId}`);
  revalidatePath("/admin");
  return { done: "Ended. The workspace follows its Stripe subscription again." };
}

/** Queues a fresh sync for one connection. */
export async function requeueSync(
  tenantId: string,
  connectionId: string,
  _prev: AdminState,
): Promise<AdminState> {
  const supabase = await adminClient();
  if (!supabase || !uuid.safeParse(tenantId).success || !uuid.safeParse(connectionId).success) {
    return { error: NOT_FOUND };
  }
  const { data, error } = await supabase.rpc("admin_requeue_sync", {
    p_connection_id: connectionId,
  });
  if (error) return { error: "That sync couldn't be queued. Try again in a moment." };
  revalidatePath(`/admin/${tenantId}`);
  return data === true
    ? { done: "Queued. The worker will pick it up shortly." }
    : {
        error:
          "Nothing was queued: a sync is already waiting or running, or the connection isn't active.",
      };
}
