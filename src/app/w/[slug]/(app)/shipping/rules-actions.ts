"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import {
  SHIPPING_MODULE,
  SHIPPING_SETTINGS_KEY,
  parseShippingSettings,
} from "@/lib/shipping/config";
import { SHIPPING_RULES_KEY, shippingRulesSchema } from "@/lib/shipping/rules";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import type { ShippingState } from "./actions";

const NO_ACCESS = "Shipping isn't part of this workspace's plan right now.";
const NOT_ALLOWED = "Only owners and admins can do that.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const OOPS = "That didn't save. Please try again.";
const UUID = /^[0-9a-f-]{36}$/i;

/** Rules and packing memory are settings: owners and admins only. */
async function managers(slug: string) {
  const user = await requireUser(`/w/${slug}/shipping/settings`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.shipping")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  if (!canManage(ctx.role)) return { error: NOT_ALLOWED } as const;
  return { tenant: ctx.tenant, supabase: await createClient() } as const;
}

const done = (slug: string) => revalidatePath(`/w/${slug}/shipping`, "layout");

/**
 * Saves the whole list of shipping rules, in order. It is a setting like any
 * other: checked against its schema, written through `save_config`, and so
 * kept as a version that can be looked back at.
 */
export async function saveShippingRules(slug: string, rules: unknown): Promise<ShippingState> {
  const ctx = await managers(slug);
  if ("error" in ctx) return { error: ctx.error };
  const parsed = shippingRulesSchema.safeParse({ version: 1, rules });
  if (!parsed.success) {
    return {
      error:
        "One of those rules isn't complete. Each needs a name, at least one condition and at least one thing to do.",
    };
  }
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: SHIPPING_MODULE,
    p_key: SHIPPING_RULES_KEY,
    p_body: parsed.data,
  });
  if (error) return { error: OOPS };
  done(slug);
  return { message: "Saved. Your rules apply to orders from now on." };
}

/** "Remember how I pack": the two switches, kept with the other shipping settings. */
export async function saveRememberPacking(
  slug: string,
  _prev: ShippingState,
  formData: FormData,
): Promise<ShippingState> {
  const ctx = await managers(slug);
  if ("error" in ctx) return { error: ctx.error };
  const { data: saved } = await ctx.supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", ctx.tenant.id)
    .eq("module", SHIPPING_MODULE)
    .eq("key", SHIPPING_SETTINGS_KEY)
    .maybeSingle();
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: SHIPPING_MODULE,
    p_key: SHIPPING_SETTINGS_KEY,
    p_body: {
      ...parseShippingSettings(saved?.body),
      remember_packing: {
        exact: formData.get("remember_exact") === "on",
        similar: formData.get("remember_similar") === "on",
      },
    },
  });
  if (error) return { error: OOPS };
  done(slug);
  return { message: "Saved." };
}

/** Forgets one remembered packing: those items go back to rules and the usual box. */
export async function forgetPacking(
  slug: string,
  packingId: string,
  _prev: ShippingState,
  _formData: FormData,
): Promise<ShippingState> {
  const ctx = await managers(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(packingId)) return { error: OOPS };
  const { data, error } = await ctx.supabase.rpc("forget_shipping_packing", { p_id: packingId });
  if (error || data !== true) return { error: OOPS };
  done(slug);
  return { message: "Forgotten." };
}
