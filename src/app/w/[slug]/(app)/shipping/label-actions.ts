"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { isLabelKind, verifyAddress, type AddressCheck } from "@/lib/shipping/easypost";
import { withLabelSource, type Held } from "@/lib/shipping/label-access";
import {
  missingShipTo,
  parseInches,
  parseOunces,
  shipToAddress,
  withShipToEdit,
  type ShipToEdit,
  type SavedBox,
} from "@/lib/shipping/labels";
import { labelSource } from "@/lib/shipping/sources";
import { sourceRateChoice, type SourceRateChoice } from "@/lib/shipping/sources/rates";
import { isLabelSource, type LabelSourceKey, type SourceLabel } from "@/lib/shipping/sources/types";
import { upsChecksAddress, validateUpsAddress } from "@/lib/shipping/sources/ups";
import { getAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import type { ShippingState } from "./actions";
import {
  BOX_FIELDS,
  ORDER_FIELDS,
  loadLabelConnections,
  loadShippingSetup,
  type ShippingOrder,
} from "./data";
import {
  explain,
  keepLabel,
  labelAccess,
  purchaseLabel,
  quoteRates,
  type BoxInput,
  type RatesInput,
} from "./label-core";

export type { BoxInput, RatesInput };

export type RatesState = {
  error?: string;
  /** One list from every connected source, cheapest first. */
  rates?: SourceRateChoice[];
  /** A short word on each source that couldn't be asked, so its prices are missing. */
  notes?: string[];
};
/** `bought`: money was spent. The screen must stop offering to buy. */
export type BuyState = { error?: string; bought?: boolean };

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
  return { user, tenant: ctx.tenant, supabase: await createClient() } as const;
}

const text = (formData: FormData, name: string) => String(formData.get(name) ?? "").trim();
const done = (slug: string) => revalidatePath(`/w/${slug}/shipping`, "layout");

// ---------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------

export async function saveBox(
  slug: string,
  _prev: ShippingState,
  formData: FormData,
): Promise<ShippingState> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return { error: ctx.error };
  const name = text(formData, "name");
  const kind = text(formData, "kind") || "box";
  const length = parseInches(text(formData, "length"));
  const width = parseInches(text(formData, "width"));
  const height = parseInches(text(formData, "height"));
  const empty = parseOunces(text(formData, "empty_weight"));
  if (!name || name.length > 60) return { error: "Give the box a short name." };
  if (!["box", "envelope", "soft"].includes(kind)) return { error: OOPS };
  if (!(length && width && height)) {
    return { error: "Length, width and height are in inches, up to 108 each." };
  }
  if (empty === null) return { error: "The empty weight is in ounces, like 6 or 6.5." };
  const { error } = await ctx.supabase.rpc("save_shipping_box", {
    p_tenant_id: ctx.tenant.id,
    p_box_id: null,
    p_name: name,
    p_kind: kind,
    p_length_in: length,
    p_width_in: width,
    p_height_in: height,
    p_empty_weight_oz: empty,
    p_default: formData.get("default") === "on",
  });
  if (error) {
    return {
      error: error.message.includes("Too many")
        ? "That's a lot of boxes. Remove one you no longer use first."
        : OOPS,
    };
  }
  done(slug);
  return { message: `${name} added.` };
}

export async function makeDefaultBox(
  slug: string,
  boxId: string,
  _prev: ShippingState,
  _formData: FormData,
): Promise<ShippingState> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(boxId)) return { error: OOPS };
  const { data } = await ctx.supabase
    .from("shipping_boxes")
    .select(BOX_FIELDS)
    .eq("tenant_id", ctx.tenant.id)
    .eq("id", boxId)
    .is("archived_at", null)
    .maybeSingle();
  const box = data as unknown as SavedBox | null;
  if (!box) return { error: OOPS };
  const { error } = await ctx.supabase.rpc("save_shipping_box", {
    p_tenant_id: ctx.tenant.id,
    p_box_id: box.id,
    p_name: box.name,
    p_kind: box.kind,
    p_length_in: box.length_in,
    p_width_in: box.width_in,
    p_height_in: box.height_in,
    p_empty_weight_oz: box.empty_weight_oz,
    p_default: true,
  });
  if (error) return { error: OOPS };
  done(slug);
  return { message: `${box.name} is your usual box now.` };
}

export async function archiveBox(
  slug: string,
  boxId: string,
  _prev: ShippingState,
  _formData: FormData,
): Promise<ShippingState> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(boxId)) return { error: OOPS };
  const { error } = await ctx.supabase.rpc("archive_shipping_box", { p_id: boxId });
  if (error) return { error: OOPS };
  done(slug);
  return { message: "Removed." };
}
// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

/**
 * Asks every connected source what this order would cost to send, and puts
 * the answers in one list, cheapest first (see `quoteRates`). The list is
 * kept server-side as a quote, which is what a purchase is later checked
 * against; the browser is shown the prices and never the sources' own ids.
 */
export async function getLabelRates(
  slug: string,
  orderId: string,
  input: RatesInput,
): Promise<RatesState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const quoted = await quoteRates(ctx, orderId, input);
  if ("error" in quoted) return { error: quoted.error };
  return {
    rates: quoted.rates.map(sourceRateChoice),
    ...(quoted.notes.length > 0 ? { notes: quoted.notes } : {}),
  };
}

export type AddressState = {
  error?: string;
  check?: AddressCheck;
  /** No connected account can check addresses: nothing to show, and nothing wrong. */
  skipped?: boolean;
};

/**
 * Asks the carriers' address book about the address on the screen: EasyPost's
 * when it is connected, else UPS's own (US addresses), else not at all.
 * Nothing is saved: the answer only tells the person whether to look again.
 */
export async function checkLabelAddress(
  slug: string,
  orderId: string,
  shipTo: ShipToEdit,
): Promise<AddressState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(orderId)) return { error: OOPS };
  const [{ data }, setup, connections] = await Promise.all([
    ctx.supabase
      .from("shipping_orders")
      .select(ORDER_FIELDS)
      .eq("tenant_id", ctx.tenant.id)
      .eq("id", orderId)
      .maybeSingle(),
    loadShippingSetup(ctx.supabase, ctx.tenant.id),
    loadLabelConnections(ctx.supabase, ctx.tenant.id),
  ]);
  const stored = data as unknown as ShippingOrder | null;
  if (!stored) return { error: "We couldn't find that order." };
  const order = withShipToEdit(stored, shipTo);
  if (!order) return { error: "That address doesn't look right. Check each box and try again." };
  const gaps = missingShipTo(order);
  if (gaps.length > 0) return { error: `The address is missing ${gaps.join(", ")}.` };
  const to = shipToAddress(order, setup.settings.ship_from_country);
  const checker: "easypost" | "ups" | null = connections.active.includes("easypost")
    ? "easypost"
    : connections.active.includes("ups") && upsChecksAddress(to.country)
      ? "ups"
      : null;
  if (!checker) return { skipped: true };
  const held = await labelAccess(ctx.tenant.id, checker);
  if ("error" in held) return { error: held.error };
  try {
    return {
      check:
        checker === "easypost"
          ? await verifyAddress((held as Held<"easypost">).access.key, to)
          : await withLabelSource(
              ctx.tenant.id,
              "ups",
              (access) => validateUpsAddress(access, to),
              held as Held<"ups">,
            ),
    };
  } catch (err) {
    return { error: await explain(err, held.connectionId, checker) };
  }
}

// ---------------------------------------------------------------------------
// Buying
// ---------------------------------------------------------------------------
/**
 * Buys the chosen rate and records the parcel, then moves on to the finished
 * label. All of it happens in `purchaseLabel`, the one path every purchase
 * takes: claimed first, only what the server quoted, the label written down
 * before the parcel is recorded.
 */
export async function buyLabel(
  slug: string,
  orderId: string,
  rateId: string,
  /** The two ticks beside the button; left out, the workspace's settings decide. */
  shop?: { markSent: boolean; notify: boolean },
  /** Other orders going in the same parcel, exactly as they were when rates were asked for. */
  withIds?: string[],
  /** The boxes and address as they stood when rates were asked for. */
  input?: RatesInput,
): Promise<BuyState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const result = await purchaseLabel(ctx, slug, orderId, rateId, shop, withIds, input);
  if (result.state === "refused") return { error: result.error };
  if (result.state === "unsure") return { bought: true, error: result.error };
  redirect(`/w/${slug}/shipping/orders/${orderId}?label=${result.number}`);
}

type OpenQuote = {
  id: string;
  shipping_order_id: string;
  provider: string;
  provider_shipment_id: string;
  status: string;
  label_kind: string;
  buying_at: string | null;
};
const OPEN_QUOTE =
  "id, shipping_order_id, provider, provider_shipment_id, status, label_kind, buying_at";

/**
 * Finishes a label that was bought (or may have been) but isn't a parcel
 * yet: asks the source what really happened if we never heard, then records
 * it. A source that can't be asked (UPS, Redo) leaves that to a person: see
 * `clearUnsureLabel`.
 */
export async function finishLabel(
  slug: string,
  quoteId: string,
  _prev: ShippingState,
  _formData: FormData,
): Promise<ShippingState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(quoteId)) return { error: OOPS };
  const { data } = await ctx.supabase
    .from("shipping_label_quotes")
    .select(OPEN_QUOTE)
    .eq("tenant_id", ctx.tenant.id)
    .eq("id", quoteId)
    .maybeSingle();
  const quote = data as OpenQuote | null;
  if (!quote || !["buying", "bought"].includes(quote.status)) {
    done(slug);
    return { error: "That label is already sorted. Reload this page." };
  }

  if (quote.status === "buying") {
    const sourceKey: LabelSourceKey = isLabelSource(quote.provider) ? quote.provider : "easypost";
    const source = labelSource(sourceKey);
    if (!source.canLookUp) {
      return {
        error: `We can't ask ${source.name} about a label from here. Look in your ${source.name} account for one bought for this order. If it's there, void it there or use it and record the parcel by hand; then an owner or admin can clear this.`,
      };
    }
    const held = await labelAccess(ctx.tenant.id, sourceKey);
    if ("error" in held) return { error: held.error };
    let settled: { label: SourceLabel | null };
    try {
      settled = await withLabelSource(
        ctx.tenant.id,
        sourceKey,
        (access) =>
          source.lookUp(access as never, {
            kind: isLabelKind(quote.label_kind) ? quote.label_kind : "shipment",
            shipmentId: quote.provider_shipment_id,
          }),
        held,
      );
    } catch (err) {
      return { error: await explain(err, held.connectionId, sourceKey) };
    }
    if (!settled.label) {
      const { error } = await getAdminClient().rpc("release_label_purchase", {
        p_tenant_id: ctx.tenant.id,
        p_quote_id: quote.id,
      });
      if (error) return { error: OOPS };
      done(slug);
      return {
        message: `${source.name} says that label was never bought, so nothing was charged. You can get rates again.`,
      };
    }
    if (!(await keepLabel(ctx.tenant.id, quote.id, settled.label))) {
      return {
        error:
          "The label was bought, but we still couldn't save it here. Try again in a minute; don't buy another.",
      };
    }
  }

  const setup = await loadShippingSetup(ctx.supabase, ctx.tenant.id);
  const push = setup.canSend && setup.settings.mark_sent_in_shop;
  const { data: number, error } = await ctx.supabase.rpc("record_label_shipment", {
    p_quote_id: quote.id,
    p_push: push,
    p_notify: push && setup.settings.notify_customer,
  });
  done(slug);
  if (error) {
    console.error("could not record label parcel", error.message);
    return {
      error:
        "The label is bought and safe, but recording the parcel still didn't go through. Try again in a minute; don't buy another.",
    };
  }
  redirect(`/w/${slug}/shipping/orders/${quote.shipping_order_id}?label=${number as number}`);
}

/** How long a purchase is left alone before a person may say what became of it. */
const UNSURE_WAIT_MS = 2 * 60_000;

/**
 * For a purchase at UPS or Redo that we never heard back about. Neither can
 * be asked from here, so an owner or admin looks in that account and then
 * presses this to free the order. It buys nothing and voids nothing: it only
 * stops this page waiting. Never offered for EasyPost, which can be asked.
 */
export async function clearUnsureLabel(
  slug: string,
  quoteId: string,
  _prev: ShippingState,
  _formData: FormData,
): Promise<ShippingState> {
  const ctx = await context(slug, true);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(quoteId)) return { error: OOPS };
  const { data } = await ctx.supabase
    .from("shipping_label_quotes")
    .select(OPEN_QUOTE)
    .eq("tenant_id", ctx.tenant.id)
    .eq("id", quoteId)
    .maybeSingle();
  const quote = data as OpenQuote | null;
  if (!quote || quote.status !== "buying") {
    done(slug);
    return { error: "That label is already sorted. Reload this page." };
  }
  const sourceKey: LabelSourceKey = isLabelSource(quote.provider) ? quote.provider : "easypost";
  if (labelSource(sourceKey).canLookUp) {
    return { error: "Press Check this label instead: it can be looked up." };
  }
  if (!quote.buying_at || Date.now() - new Date(quote.buying_at).getTime() < UNSURE_WAIT_MS) {
    return { error: "This purchase may still be going through. Give it a couple of minutes." };
  }
  const { data: freed, error } = await getAdminClient().rpc("release_label_purchase", {
    p_tenant_id: ctx.tenant.id,
    p_quote_id: quote.id,
  });
  if (error || freed !== true) return { error: OOPS };
  done(slug);
  return { message: "Cleared. You can get rates for this order again." };
}
