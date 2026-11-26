"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { loadRevenueSettings } from "@/lib/dashboard/data";
import {
  REVENUE_FIGURES,
  REVENUE_KEY,
  REVENUE_MODULE,
  revenueSettingsSchema,
  type RevenueSettings,
} from "@/lib/dashboard/lines";
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

export type RevenueState = { error?: string; message?: string };

/** Owners and admins, on a plan that can still change things. */
async function revenueContext(slug: string) {
  const user = await requireUser(`/w/${slug}/settings/money/lines`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx || !canManage(ctx.role)) {
    return { error: "Only owners and admins can change how Money counts revenue." } as const;
  }
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.canWrite || !entitlements.can("module.dashboard")) {
    return { error: "Your plan doesn't include changing Money right now." } as const;
  }
  const supabase = await createClient();
  return { tenant: ctx.tenant, supabase } as const;
}

/** Saves the whole revenue setting, each form having changed only its own part. */
async function saveRevenue(
  slug: string,
  change: (current: RevenueSettings) => unknown,
  done: string,
): Promise<RevenueState> {
  const ctx = await revenueContext(slug);
  if ("error" in ctx) return { error: ctx.error };
  const current = await loadRevenueSettings(ctx.supabase, ctx.tenant.id);
  const parsed = revenueSettingsSchema.safeParse(change(current));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: issue?.message ?? "Something in there doesn't look right." };
  }
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: REVENUE_MODULE,
    p_key: REVENUE_KEY,
    p_body: parsed.data,
  });
  if (error) return { error: "We couldn't save that. Try again in a moment." };
  revalidatePath(`/w/${slug}/dashboard`);
  revalidatePath(`/w/${slug}/settings`, "layout");
  return { message: done };
}

/** Which figure counts as revenue, and whether classes count when they run. */
export async function saveRevenueFigure(
  slug: string,
  _prev: RevenueState,
  formData: FormData,
): Promise<RevenueState> {
  const figure = formData.get("figure");
  if (!(REVENUE_FIGURES as readonly unknown[]).includes(figure)) {
    return { error: "Choose which figure to count." };
  }
  return saveRevenue(
    slug,
    (current) => ({
      ...current,
      figure,
      by_class_date: formData.get("by_class_date") === "on",
    }),
    "Saved. Money counts it this way from now on, for every date range.",
  );
}

/** The business lines and their rules, handed over as one JSON field by the editor. */
export async function saveBusinessLines(
  slug: string,
  _prev: RevenueState,
  formData: FormData,
): Promise<RevenueState> {
  let body: { lines?: unknown; default_line?: unknown; rules?: unknown };
  try {
    body = JSON.parse(String(formData.get("body") ?? "{}"));
  } catch {
    return { error: "Something in there doesn't look right." };
  }
  return saveRevenue(
    slug,
    (current) => ({
      ...current,
      lines: body.lines,
      default_line: body.default_line ?? null,
      rules: body.rules,
    }),
    "Saved. Every chart of your lines uses these from now on, for past sales too.",
  );
}
