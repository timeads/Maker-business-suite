"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { ReconnectRequiredError } from "@/lib/connections/types";
import { getEntitlements } from "@/lib/entitlements";
import { tidyTracking, trackingUrl } from "@/lib/shipping/carriers";
import {
  SHIPPING_MODULE,
  SHIPPING_SETTINGS_KEY,
  SLIP_LAYOUT_KEY,
  SLIP_SECTIONS,
  parseShippingSettings,
  shippingSettingsSchema,
  slipLayoutSchema,
  type SlipSection,
} from "@/lib/shipping/config";
import { EasyPostError } from "@/lib/shipping/easypost";
import { getLabelAccess, withLabelSource, type Held } from "@/lib/shipping/label-access";
import { labelBoxes } from "@/lib/shipping/labels";
import { flagLabelKey } from "@/lib/shipping/label-key";
import { labelSource } from "@/lib/shipping/sources";
import {
  SourceError,
  isLabelSource,
  type LabelSourceKey,
  type Refunds,
} from "@/lib/shipping/sources/types";
import { formatHoldDate, isHoldDate, todayIn } from "@/lib/shipping/queue";
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
  if (orderId) {
    // From the packing bench, straight back to it for the next order.
    const bench = text(formData, "back") === "scan" ? "/scan" : "";
    redirect(`/w/${slug}/shipping${bench}?sent=${data as number}`);
  }
  return { message: `Parcel ${data as number} recorded.` };
}

const pick = (ids: string[]) => [...new Set(ids.filter((id) => UUID.test(id)))].slice(0, 500);
const count = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("%", `${n}`));

/**
 * Sets orders aside, with a note and (if wanted) the day they come back.
 * `until` is a YYYY-MM-DD day in the workspace's own time zone, or null.
 */
export async function holdOrders(
  slug: string,
  ids: string[],
  note: string,
  until: string | null,
): Promise<ShippingState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const day = until?.trim() || null;
  if (day && !isHoldDate(day, todayIn(ctx.tenant.timezone, new Date()))) {
    return { error: "Pick a day after today, or hold it until you release it." };
  }
  const { data, error } = await ctx.supabase.rpc("hold_shipping_orders", {
    p_tenant_id: ctx.tenant.id,
    p_ids: pick(ids),
    p_note: note.trim().slice(0, 300),
    p_until: day,
  });
  if (error) {
    return { error: error.message.includes("after today") ? "Pick a day after today." : OOPS };
  }
  done(slug);
  const n = Number(data ?? 0);
  if (n === 0) return { error: "Nothing there can be held: it's been sent or cancelled." };
  return {
    message: `${count(n, "On hold", "% orders on hold")}${day ? ` until ${formatHoldDate(day)}` : ""}.`,
  };
}

export async function releaseOrders(slug: string, ids: string[]): Promise<ShippingState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const { data, error } = await ctx.supabase.rpc("release_shipping_orders", {
    p_tenant_id: ctx.tenant.id,
    p_ids: pick(ids),
  });
  if (error) return { error: OOPS };
  done(slug);
  return { message: count(Number(data ?? 0), "Back in the queue.", "% orders back in the queue.") };
}

/** The hold form on an order's own page. */
export async function setHold(
  slug: string,
  orderId: string,
  hold: boolean,
  _prev: ShippingState,
  formData: FormData,
): Promise<ShippingState> {
  if (!hold) return releaseOrders(slug, [orderId]);
  return holdOrders(slug, [orderId], text(formData, "reason"), text(formData, "until") || null);
}

/**
 * Someone has opened an order whose hold ran out: it stops saying "Back from
 * hold". A hold that is still running is left alone.
 */
export async function seenBackFromHold(slug: string, orderId: string): Promise<void> {
  if (!UUID.test(orderId)) return;
  const ctx = await context(slug);
  if ("error" in ctx) return;
  const { data } = await ctx.supabase.rpc("clear_ended_shipping_hold", { p_id: orderId });
  if (data === true) done(slug);
}

/** What became of telling the shop about a pickup step, as the page words it. */
type ShopStep = "none" | "pending" | "sending" | "sent" | "not_allowed" | "failed";
const NOT_TOLD =
  "Your shop wasn't told: it's connected without permission to change orders. Do this step in your shop too.";

/**
 * Pickup orders are packed and waiting at the counter. Kept here, and passed
 * on to the shop (which emails the customer to come and collect) when the
 * workspace wants that and the shop allows it: the database decides, and the
 * worker does the telling.
 */
export async function markPickupReady(slug: string, ids: string[]): Promise<ShippingState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const picked = pick(ids);
  const { data, error } = await ctx.supabase.rpc("mark_pickup_ready", {
    p_tenant_id: ctx.tenant.id,
    p_ids: picked,
  });
  if (error) return { error: OOPS };
  done(slug);
  const n = Number(data ?? 0);
  if (n === 0) return { error: "None of those are pickup orders still waiting to be packed." };
  const { data: rows } = await ctx.supabase
    .from("shipping_orders")
    .select("pickup_ready_shop_status")
    .eq("tenant_id", ctx.tenant.id)
    .in("id", picked)
    .not("pickup_ready_at", "is", null);
  const steps = ((rows ?? []) as { pickup_ready_shop_status: ShopStep }[]).map(
    (row) => row.pickup_ready_shop_status,
  );
  const told = steps.some((step) => ["pending", "sending", "sent"].includes(step));
  const refused = steps.some((step) => step === "not_allowed");
  return {
    message: `${count(n, "Ready for pickup.", "% orders ready for pickup.")}${
      told
        ? n === 1
          ? " Your shop is being told, and will email the customer to come and collect."
          : " Your shop is being told, and will email each customer to come and collect."
        : ""
    }${refused ? ` ${NOT_TOLD}` : ""}`,
  };
}

export async function markPickedUp(
  slug: string,
  orderId: string,
  _prev: ShippingState,
  _formData: FormData,
): Promise<ShippingState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const { error } = await ctx.supabase.rpc("mark_picked_up", { p_id: orderId });
  if (error) return { error: OOPS };
  done(slug);
  const { data: row } = await ctx.supabase
    .from("shipping_orders")
    .select("picked_up_shop_status")
    .eq("tenant_id", ctx.tenant.id)
    .eq("id", orderId)
    .maybeSingle();
  const step = (row?.picked_up_shop_status ?? "none") as ShopStep;
  return {
    message: `Picked up. It's off your list.${
      ["pending", "sending", "sent"].includes(step)
        ? " Your shop is being told, so the order shows as fulfilled there."
        : step === "not_allowed"
          ? ` ${NOT_TOLD}`
          : ""
    }`,
  };
}

export async function undoPickup(
  slug: string,
  orderId: string,
  _prev: ShippingState,
  _formData: FormData,
): Promise<ShippingState> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return { error: ctx.error };
  const { data: before } = await ctx.supabase
    .from("shipping_orders")
    .select("picked_up_at, pickup_ready_shop_status, picked_up_shop_status")
    .eq("tenant_id", ctx.tenant.id)
    .eq("id", orderId)
    .maybeSingle();
  const { error } = await ctx.supabase.rpc("undo_pickup", { p_id: orderId });
  if (error) return { error: OOPS };
  done(slug);
  // What the shop has already heard can't be unsaid from here.
  const heard = (
    before?.picked_up_at ? before.picked_up_shop_status : before?.pickup_ready_shop_status
  ) as ShopStep | undefined;
  return {
    message:
      heard === "sent" || heard === "sending"
        ? before?.picked_up_at
          ? "Stepped back here. Your shop still shows the order as fulfilled; change that there if it matters."
          : "Stepped back here. Your shop has already told the customer it's ready, which can't be taken back from here."
        : "Stepped back.",
  };
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
  if (!UUID.test(shipmentId)) return { error: OOPS };
  const { data: parcel } = await ctx.supabase
    .from("shipments")
    .select("label_provider, label_shipment_id, label_parcels, voided_at, merged_with")
    .eq("tenant_id", ctx.tenant.id)
    .eq("id", shipmentId)
    .maybeSingle();
  // Orders sent together are undone together, from the parcel that carries the label.
  if (parcel?.merged_with && !parcel.voided_at) {
    return {
      error:
        "This order went out in another order's parcel. Undo that parcel instead and every order in it comes back.",
    };
  }
  const { count: riders } = await ctx.supabase
    .from("shipments")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", ctx.tenant.id)
    .eq("merged_with", shipmentId)
    .is("voided_at", null);
  const together = (riders ?? 0) > 0;
  // A label we bought is voided where it was bought: EasyPost, the business's own UPS account or Redo.
  const sourceKey: LabelSourceKey | null =
    parcel && !parcel.voided_at && isLabelSource(parcel.label_provider)
      ? parcel.label_provider
      : null;
  const label = sourceKey ? (parcel?.label_shipment_id as string | null) : null;
  const name = sourceKey ? labelSource(sourceKey).name : "";

  if (label && sourceKey) {
    // Ask for the money back first. If the source won't, the parcel stays exactly as it is.
    const nothingChanged = "Nothing has changed here.";
    let held: Held<LabelSourceKey>;
    try {
      held = await getLabelAccess(ctx.tenant.id, sourceKey);
    } catch {
      return {
        error: `We couldn't void this label because ${name} needs connecting again (under Connections). ${nothingChanged}`,
      };
    }
    // Each box has its own label to refund (or they share one shipment, which
    // is asked for once). A parcel from before boxes were kept one by one has
    // just the one, named by the label's own id.
    const boxIds = [
      ...new Set(
        labelBoxes(parcel?.label_parcels)
          .map((box) => box.shipmentId)
          .filter(Boolean),
      ),
    ];
    let refunds: Refunds;
    try {
      refunds = await withLabelSource(
        ctx.tenant.id,
        sourceKey,
        (access) =>
          labelSource(sourceKey).refund(access as never, boxIds.length > 0 ? boxIds : [label]),
        held,
      );
    } catch (err) {
      refunds = { asked: 0, failed: 1, error: err };
    }
    if (refunds.failed > 0) {
      const err = refunds.error;
      if (err instanceof ReconnectRequiredError) await flagLabelKey(held.connectionId, name);
      const why =
        err instanceof ReconnectRequiredError ||
        err instanceof EasyPostError ||
        err instanceof SourceError
          ? err.message
          : `${name} couldn't be reached.`;
      return {
        error:
          refunds.asked > 0
            ? `${name} took the refund request for ${refunds.asked} of this parcel's ${refunds.asked + refunds.failed} labels, but not the rest. ${why} The parcel is unchanged here; press it again to ask for the rest.`
            : `We couldn't void this label. ${why} ${nothingChanged}`,
      };
    }
  }

  const { data, error } = await ctx.supabase.rpc(label ? "void_label_shipment" : "void_shipment", {
    p_id: shipmentId,
  });
  if (error) {
    return {
      error: label
        ? `${name} has the refund request, but we couldn't undo the parcel here. Press it again in a moment.`
        : OOPS,
    };
  }
  done(slug);
  // What the shop is being told: every order in the parcel that was marked as sent there.
  const { data: undone } = await ctx.supabase
    .from("shipments")
    .select("shop_status, shop_undo_status")
    .eq("tenant_id", ctx.tenant.id)
    .or(`id.eq.${shipmentId},merged_with.eq.${shipmentId}`)
    .not("voided_at", "is", null);
  const undos = ((undone ?? []) as { shop_status: string; shop_undo_status: string }[]).filter(
    (row) => row.shop_status === "sent",
  );
  const queued = undos.some((row) => ["pending", "sending", "done"].includes(row.shop_undo_status));
  const byHand = undos.some(
    (row) => !["pending", "sending", "done"].includes(row.shop_undo_status),
  );
  const back = together
    ? " Every order that went in it is back on your to-send list."
    : " Its items are back on the to-send list.";
  const shop =
    undos.length === 0 && data !== "sent"
      ? back
      : `${back}${
          queued
            ? together
              ? " We're marking them unfulfilled in your shop too."
              : " We're marking it unfulfilled in your shop too."
            : ""
        }${
          byHand
            ? together
              ? " Your shop is connected without permission to change orders, so cancel those fulfilments there too."
              : " Your shop is connected without permission to change orders, so cancel the fulfilment there too."
            : undos.length === 0
              ? " Your shop still shows it as sent, so cancel the fulfilment there too."
              : ""
        }`;
  return {
    message: label
      ? sourceKey === "ups"
        ? `Voided with UPS, so it won't be billed to your account.${shop}`
        : sourceKey === "redo"
          ? `Cancelled through Redo. The postage goes back on your Redo labels balance once the carrier confirms the label wasn't used.${shop}`
          : `Refund requested. EasyPost pays it back once the carrier confirms the label wasn't used, which can take a few weeks.${shop}`
      : `Undone.${shop}`,
  };
}

export async function saveShippingSettings(
  slug: string,
  _prev: ShippingState,
  formData: FormData,
): Promise<ShippingState> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return { error: ctx.error };
  const country = text(formData, "ship_from_country").toUpperCase() || "US";
  if (!/^[A-Z]{2}$/.test(country)) {
    return { error: "The country parcels leave from is two letters, like US, CA or GB." };
  }
  // The older slip note and item-code switch now live in the slip layout;
  // what was saved is carried along so a workspace that hasn't moved keeps it.
  const { data: saved } = await ctx.supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", ctx.tenant.id)
    .eq("module", SHIPPING_MODULE)
    .eq("key", SHIPPING_SETTINGS_KEY)
    .maybeSingle();
  const before = parseShippingSettings(saved?.body);
  const city = text(formData, "from_city");
  const region = text(formData, "from_region");
  const postalCode = text(formData, "from_postal_code");
  const overText = text(formData, "signature_over").replace(/^\$/, "");
  if (overText && !/^\d{1,7}(\.\d{1,2})?$/.test(overText)) {
    return { error: "The signature amount should be a number, like 250." };
  }
  const signatureOver = overText ? Number(overText) : null;
  const parsed = shippingSettingsSchema.safeParse({
    version: 1,
    ship_from_country: country,
    ship_from: {
      name: text(formData, "from_name"),
      address1: text(formData, "from_address1"),
      address2: text(formData, "from_address2"),
      city,
      region,
      postal_code: postalCode,
      phone: text(formData, "from_phone"),
      // The older single line is kept for a workspace that hasn't filled in the parts.
      city_line: city || region || postalCode ? "" : before.ship_from.city_line,
      country: text(formData, "from_country"),
    },
    slip_note: before.slip_note,
    slip_show_sku: before.slip_show_sku,
    default_carrier: text(formData, "default_carrier") || "USPS",
    mark_sent_in_shop: formData.get("mark_sent_in_shop") === "on",
    notify_customer: formData.get("notify_customer") === "on",
    signature_over: signatureOver,
    // Only offered when the shop allows it; otherwise what was saved stands.
    tell_shop_pickups:
      formData.get("pickups_offered") === "1"
        ? formData.get("tell_shop_pickups") === "on"
        : before.tell_shop_pickups,
    // Set on its own form ("Remember how I pack"); carried along here.
    remember_packing: before.remember_packing,
  });
  if (!parsed.success) {
    return { error: "Keep each address line under 120 characters, and the phone number under 30." };
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

/**
 * What a packing slip shows, and in what order: the whole layout as the
 * designer holds it, checked here against the schema before it is kept.
 */
export async function saveSlipLayout(slug: string, layout: unknown): Promise<ShippingState> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return { error: ctx.error };
  const asked = layout && typeof layout === "object" ? (layout as Record<string, unknown>) : {};
  const known = (id: unknown): id is SlipSection =>
    (SLIP_SECTIONS as readonly string[]).includes(String(id));
  const listed = Array.isArray(asked.sections)
    ? (asked.sections as { id?: unknown; on?: unknown }[])
        .filter((section) => section && known(section.id))
        .map((section) => ({ id: section.id as SlipSection, on: section.on !== false }))
    : [];
  const seen = new Set<SlipSection>();
  const sections = listed.filter((section) => !seen.has(section.id) && seen.add(section.id));
  const parsed = slipLayoutSchema.safeParse({
    ...asked,
    version: 1,
    sections: [
      ...sections,
      ...SLIP_SECTIONS.filter((id) => !seen.has(id)).map((id) => ({ id, on: true })),
    ],
  });
  if (!parsed.success) {
    return {
      error:
        "Keep the store name under 60 characters, the thank-you message under 600 and the footer under 120.",
    };
  }
  const { error } = await ctx.supabase.rpc("save_config", {
    p_tenant_id: ctx.tenant.id,
    p_module: SHIPPING_MODULE,
    p_key: SLIP_LAYOUT_KEY,
    p_body: parsed.data,
  });
  if (error) return { error: OOPS };
  done(slug);
  return { message: "Saved. Your next slips will print this way." };
}
