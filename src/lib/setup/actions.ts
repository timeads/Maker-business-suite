"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { fingerprint } from "./items";

export type NotNowState = { error?: string; done?: boolean };

const PLAIN = /^[a-z][a-z0-9_.-]{0,60}$/;

/**
 * "Not now" on one checklist item, for the facts it shows now (kept only as
 * their fingerprint), or `back` to show it again. Owners and admins only;
 * the database checks that too.
 */
export async function setNotNow(
  slug: string,
  tool: string,
  item: string,
  facts: string,
  back: boolean,
): Promise<NotNowState> {
  const user = await requireUser(`/w/${slug}`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx || !canManage(ctx.role)) return { error: "Only owners and admins can do that." };
  if (!PLAIN.test(tool) || !PLAIN.test(item) || typeof facts !== "string") {
    return { error: "Which item is this?" };
  }
  const supabase = await createClient();
  const { error } = back
    ? await supabase.rpc("bring_back_setup_item", {
        p_tenant_id: ctx.tenant.id,
        p_tool: tool,
        p_item: item,
      })
    : await supabase.rpc("say_setup_not_now", {
        p_tenant_id: ctx.tenant.id,
        p_tool: tool,
        p_item: item,
        p_fingerprint: fingerprint(facts.slice(0, 20_000)),
      });
  if (error) return { error: "We couldn't save that. Try again in a moment." };
  revalidatePath(`/w/${slug}`, "layout");
  return { done: true };
}
