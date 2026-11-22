"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { DASHBOARD_KEY, DASHBOARD_MODULE, dashboardSchema } from "@/lib/dashboard/schema";
import { isTemplateKey, templateConfig } from "@/lib/dashboard/templates";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

export type TemplateState = { error?: string };

/** Replaces the workspace's dashboard with one of the starting layouts. */
export async function applyTemplate(
  slug: string,
  _prev: TemplateState,
  formData: FormData,
): Promise<TemplateState> {
  const user = await requireUser(`/w/${slug}/dashboard`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx || !canManage(ctx.role)) {
    return { error: "Only owners and admins can change the dashboard." };
  }
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.canWrite || !entitlements.can("module.dashboard")) {
    return { error: "Your plan doesn't include changing the dashboard right now." };
  }
  const key = formData.get("template");
  if (!isTemplateKey(key)) return { error: "Pick a layout to use." };

  // Validated on the way in, exactly as it is on the way out.
  const body = dashboardSchema.parse(templateConfig(key));
  const supabase = await createClient();
  const { error } = await supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: DASHBOARD_MODULE,
    p_key: DASHBOARD_KEY,
    p_body: body,
  });
  if (error) return { error: "We couldn't save that layout. Try again in a moment." };
  revalidatePath(`/w/${slug}/dashboard`);
  return {};
}
