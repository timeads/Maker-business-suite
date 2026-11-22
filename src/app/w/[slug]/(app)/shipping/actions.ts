"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { tidyTracking, trackingUrl } from "@/lib/shipping/carriers";
import {
  SHIPPING_MODULE,
  SHIPPING_SETTINGS_KEY,
  shippingSettingsSchema,
} from "@/lib/shipping/config";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

export type ShippingState = { error?: string; message?: string };

const NO_ACCESS = "Shipping isn't part of this workspace's plan right now.";
const NOT_ALLOWED = "Only owners and admins can do that.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const OOPS = "That didn't save. Please try again.";
const UUID = /^[0-9a-f-]{36}$/i;

async function context(slug: string, managersOnly = false) {
  const user = await requireUser(`/w/${slug}/shipping`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.shipping")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  if (managersOnly && !canManage(ctx.role)) return { error: NOT_ALLOWED } as const;
  return { tenant: ctx.tenant, supabase: await createClient() } as const;
}

const text = (formData: FormData, name: string) => String(formData.get(name) ?? "").trim();
const done = (slug: string) => revalidatePath(`/w/${slug}/shipping`, "layout");

/** Records a parcel: for an order (all of it, or the amounts typed), or on its own. */
export async function recordParcel(
  slug: string,
  orderId: string | null,
  _prev: ShippingState,
  formData: FormData,
): Promise<ShippingState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const carrier = text(formData, "carrier");
  const tracking = tidyTracking(text(formData, "tracking"));
  const costText = text(formData, "cost");
  const cost = costText === "" ? null : Number.parseFloat(costText);
  if (!carrier || carrier.length > 60) return { error: "Who's carrying it?" };
  if (cost !== null && !(cost >= 0 && cost <= 100_000)) {
    return { error: "That postage cost doesn't look right." };
  }
  const items: { line_id: string; qty: number }[] = [];
  let anyBox = false;
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("qty:")) continue;
    anyBox = true;
    const qty = Number.parseInt(String(value) || "0", 10);
    if (!(qty >= 0 && qty <= 100_000)) return { error: "One of those amounts isn't a number." };
    if (qty > 0) items.push({ line_id: key.slice(4), qty });
  }
  if (orderId && anyBox && items.length === 0) {
    return { error: "Say how many of at least one item are in this parcel." };
  }
  if (!orderId && !text(formData, "recipient")) return { error: "Who is it going to?" };

  const { data, error } = await ctx.supabase.rpc("record_shipment", {
    p_tenant_id: ctx.tenant.id,
    p_shipping_order_id: orderId,
    p_carrier: carrier,
    p_service: text(formData, "service").slice(0, 80),
    p_tracking_number: tracking,
    p_tracking_url: tracking ? trackingUrl(carrier, tracking) : null,
    p_cost: cost,
    p_items: items,
    p_note: text(formData, "note"),
    p_push: formData.get("push") === "on",
    p_notify: formData.get("notify") === "on",
    p_recipient: text(formData, "recipient").slice(0, 120) || null,
    p_destination: text(formData, "destination").slice(0, 120) || null,
  });
  if (error) {
    return {
      error: error.message.includes("Nothing left")
        ? "Everything on this order has already been sent."
        : OOPS,
    };
  }
  done(slug);
  if (orderId) redirect(`/w/${slug}/shipping?sent=${data as number}`);
  return { message: `Parcel ${data as number} recorded.` };
}

export async function setHold(
  slug: string,
  orderId: string,
  hold: boolean,
  _prev: ShippingState,
  formData: FormData,
): Promise<ShippingState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const { error } = await ctx.supabase.rpc("set_shipping_hold", {
    p_id: orderId,
    p_hold: hold,
    p_reason: text(formData, "reason"),
  });
  if (error) return { error: OOPS };
  done(slug);
  return { message: hold ? "On hold." : "Back in the queue." };
}

/** Notes that these slips have been printed, so they aren't printed twice. */
export async function markPrinted(slug: string, ids: string[]): Promise<void> {
  const ctx = await context(slug);
  if ("error" in ctx) return;
  await ctx.supabase.rpc("mark_slips_printed", {
    p_tenant_id: ctx.tenant.id,
    p_ids: ids.filter((id) => UUID.test(id)).slice(0, 500),
  });
  done(slug);
  redirect(`/w/${slug}/shipping`);
}

export async function voidParcel(
  slug: string,
  shipmentId: string,
  _prev: ShippingState,
  _formData: FormData,
): Promise<ShippingState> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return { error: ctx.error };
  const { data, error } = await ctx.supabase.rpc("void_shipment", { p_id: shipmentId });
  if (error) return { error: OOPS };
  done(slug);
  return {
    message:
      data === "sent"
        ? "Undone here. Your shop still shows it as sent, so cancel the fulfilment there too."
        : "Undone. Its items are back on the to-send list.",
  };
}

export async function saveShippingSettings(
  slug: string,
  _prev: ShippingState,
  formData: FormData,
): Promise<ShippingState> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return { error: ctx.error };
  const parsed = shippingSettingsSchema.safeParse({
    version: 1,
    ship_from: {
      name: text(formData, "from_name"),
      address1: text(formData, "from_address1"),
      address2: text(formData, "from_address2"),
      city_line: text(formData, "from_city_line"),
      country: text(formData, "from_country"),
    },
    slip_note: text(formData, "slip_note"),
    slip_show_sku: formData.get("slip_show_sku") === "on",
    default_carrier: text(formData, "default_carrier") || "USPS",
    mark_sent_in_shop: formData.get("mark_sent_in_shop") === "on",
    notify_customer: formData.get("notify_customer") === "on",
  });
  if (!parsed.success) {
    return { error: "Keep each address line under 120 characters and the note under 600." };
  }
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: SHIPPING_MODULE,
    p_key: SHIPPING_SETTINGS_KEY,
    p_body: parsed.data,
  });
  if (error) return { error: OOPS };
  done(slug);
  return { message: "Saved." };
}
