"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { ReconnectRequiredError } from "@/lib/connections/types";
import { getEntitlements } from "@/lib/entitlements";
import { trackingUrl } from "@/lib/shipping/carriers";
import {
  EasyPostError,
  MAX_BOXES,
  buyLabel as buyFromEasyPost,
  buyOrder,
  getPurchase,
  getRates,
  isLabelKind,
  isSignature,
  serviceWithoutCarrier,
  verifyAddress,
  type AddressCheck,
  type BoughtLabel,
  type LabelKind,
} from "@/lib/shipping/easypost";
import { flagLabelKey, getLabelKey } from "@/lib/shipping/label-key";
import {
  missingShipFrom,
  missingShipTo,
  parcelsFrom,
  parseInches,
  parseOunces,
  rateChoice,
  shipFromAddress,
  shipToAddress,
  withShipToEdit,
  type RateChoice,
  type ShipToEdit,
  type SavedBox,
} from "@/lib/shipping/labels";
import { isInternational } from "@/lib/shipping/queue";
import { getAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import type { ShippingState } from "./actions";
import { BOX_FIELDS, ORDER_FIELDS, loadShippingSetup, type ShippingOrder } from "./data";

export type RatesState = { error?: string; rates?: RateChoice[] };
/** `bought`: money was spent. The screen must stop offering to buy. */
export type BuyState = { error?: string; bought?: boolean };

const NO_ACCESS = "Shipping isn't part of this workspace's plan right now.";
const NOT_ALLOWED = "Only owners and admins can do that.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const OOPS = "That didn't save. Please try again.";
const NOT_CONNECTED =
  "EasyPost needs connecting again. An owner or admin can do that under Connections.";
const INTERNATIONAL =
  "International labels need a customs form, which isn't built yet. Buy this one elsewhere and record it below.";
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

/** The workspace's key, or a sentence saying why there isn't one. */
async function labelKey(tenantId: string) {
  try {
    return await getLabelKey(tenantId);
  } catch (err) {
    if (!(err instanceof ReconnectRequiredError)) {
      console.error("easypost key read failed", err instanceof Error ? err.message : err);
    }
    return { error: NOT_CONNECTED } as const;
  }
}

/** A sentence for the person, whatever went wrong talking to EasyPost. */
async function explain(err: unknown, connectionId: string): Promise<string> {
  if (err instanceof ReconnectRequiredError) {
    await flagLabelKey(connectionId);
    return err.message;
  }
  if (err instanceof EasyPostError) return err.message;
  console.error("easypost call failed", err instanceof Error ? err.message : err);
  return "Something went wrong talking to EasyPost. Try again in a moment.";
}

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

/** One box as it stands on the screen. */
export type BoxInput = {
  /** A saved box's id, or empty for a size typed in. */
  boxId: string;
  length: string;
  width: string;
  height: string;
  weightLb: string;
  weightOz: string;
};

export type RatesInput = {
  /** One to six boxes; several are bought together as one purchase. */
  boxes: BoxInput[];
  /** The address boxes as they stand on the screen, for this label only. */
  shipTo?: ShipToEdit;
  residential?: boolean;
  /** "none", "signature" or "adult". */
  signature?: string;
};

/**
 * Asks EasyPost what this order would cost to send. Both addresses come from
 * what is stored (the order, the settings): the browser only says which boxes
 * and what each weighs. The answer is kept server-side as a quote, which is
 * what a purchase is later checked against.
 */
export async function getLabelRates(
  slug: string,
  orderId: string,
  input: RatesInput,
): Promise<RatesState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(orderId)) return { error: OOPS };

  const [{ data }, setup] = await Promise.all([
    ctx.supabase
      .from("shipping_orders")
      .select(ORDER_FIELDS)
      .eq("tenant_id", ctx.tenant.id)
      .eq("id", orderId)
      .maybeSingle(),
    loadShippingSetup(ctx.supabase, ctx.tenant.id),
  ]);
  const stored = data as unknown as ShippingOrder | null;
  if (!stored) return { error: "We couldn't find that order." };
  if (stored.cancelled) return { error: "This order was cancelled, so there's nothing to send." };
  if (stored.units_left <= 0) return { error: "Everything on this order has already been sent." };
  const home = setup.settings.ship_from_country;
  if (isInternational(stored.country_code, home)) return { error: INTERNATIONAL };
  // What a person changed on the screen goes on this label and nowhere else.
  const order = withShipToEdit(stored, input.shipTo);
  if (!order) return { error: "That address doesn't look right. Check each box and try again." };
  const fromGaps = missingShipFrom(setup.settings);
  if (fromGaps.length > 0) {
    return {
      error: `Your ship-from address is missing: ${fromGaps.join(", ")}. Add it in Shipping settings.`,
    };
  }
  const toGaps = missingShipTo(order);
  if (toGaps.length > 0) {
    return {
      error: `The address is missing ${toGaps.join(", ")}. Fill it in under Ship to.`,
    };
  }

  const asked = Array.isArray(input.boxes) ? input.boxes : [];
  if (asked.length < 1 || asked.some((box) => !box || typeof box !== "object")) {
    return { error: "Add a box first." };
  }
  if (asked.length > MAX_BOXES) {
    return { error: `One label purchase covers up to ${MAX_BOXES} boxes.` };
  }
  const boxIds = [...new Set(asked.map((box) => String(box.boxId ?? "")).filter(Boolean))];
  if (boxIds.some((id) => !UUID.test(id))) return { error: "Pick a box." };
  const saved = new Map<string, SavedBox>();
  if (boxIds.length > 0) {
    const { data: rows } = await ctx.supabase
      .from("shipping_boxes")
      .select(BOX_FIELDS)
      .eq("tenant_id", ctx.tenant.id)
      .in("id", boxIds)
      .is("archived_at", null);
    for (const row of (rows ?? []) as unknown as SavedBox[]) saved.set(row.id, row);
    if (boxIds.some((id) => !saved.has(id))) {
      return { error: "That box isn't on your list any more. Pick another." };
    }
  }
  const parsed = parcelsFrom(
    asked.map((box) => ({
      box: box.boxId ? (saved.get(String(box.boxId)) ?? null) : null,
      length: String(box.length ?? ""),
      width: String(box.width ?? ""),
      height: String(box.height ?? ""),
      weightLb: String(box.weightLb ?? ""),
      weightOz: String(box.weightOz ?? ""),
    })),
  );
  if ("error" in parsed) return { error: parsed.error };

  const held = await labelKey(ctx.tenant.id);
  if ("error" in held) return { error: held.error };
  try {
    const quote = await getRates(held.key, {
      from: shipFromAddress(setup.settings),
      to: {
        ...shipToAddress(order, home),
        ...(typeof input.residential === "boolean" ? { residential: input.residential } : {}),
      },
      parcels: parsed.parcels,
      reference: stored.name ?? undefined,
      signature: isSignature(input.signature) ? input.signature : "none",
    });
    if (quote.rates.length === 0) {
      return {
        error:
          quote.kind === "order"
            ? "No carrier offered a rate for these boxes together. Check the address, sizes and weights, or send them as separate parcels."
            : "No carrier offered a rate for this box. Check the address, size and weight, and that a carrier is switched on in EasyPost.",
      };
    }
    // Only prices and EasyPost's own ids are kept: no address.
    const { error } = await getAdminClient().rpc("save_label_quote", {
      p_tenant_id: ctx.tenant.id,
      p_shipping_order_id: stored.id,
      p_created_by: ctx.user.id,
      p_provider_shipment_id: quote.shipmentId,
      p_rates: quote.rates,
      p_kind: quote.kind,
      p_boxes: quote.boxes,
    });
    if (error) {
      console.error("could not save label quote", error.message);
      return { error: "We got rates but couldn't keep them. Try again." };
    }
    return { rates: quote.rates.map(rateChoice) };
  } catch (err) {
    return { error: await explain(err, held.connectionId) };
  }
}

export type AddressState = { error?: string; check?: AddressCheck };

/**
 * Asks the carriers' address book about the address on the screen. Nothing
 * is saved: the answer only tells the person whether to look again.
 */
export async function checkLabelAddress(
  slug: string,
  orderId: string,
  shipTo: ShipToEdit,
): Promise<AddressState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(orderId)) return { error: OOPS };
  const [{ data }, setup] = await Promise.all([
    ctx.supabase
      .from("shipping_orders")
      .select(ORDER_FIELDS)
      .eq("tenant_id", ctx.tenant.id)
      .eq("id", orderId)
      .maybeSingle(),
    loadShippingSetup(ctx.supabase, ctx.tenant.id),
  ]);
  const stored = data as unknown as ShippingOrder | null;
  if (!stored) return { error: "We couldn't find that order." };
  const order = withShipToEdit(stored, shipTo);
  if (!order) return { error: "That address doesn't look right. Check each box and try again." };
  const gaps = missingShipTo(order);
  if (gaps.length > 0) return { error: `The address is missing ${gaps.join(", ")}.` };
  const held = await labelKey(ctx.tenant.id);
  if ("error" in held) return { error: held.error };
  try {
    return {
      check: await verifyAddress(held.key, shipToAddress(order, setup.settings.ship_from_country)),
    };
  } catch (err) {
    return { error: await explain(err, held.connectionId) };
  }
}

// ---------------------------------------------------------------------------
// Buying
// ---------------------------------------------------------------------------

type Claim = {
  quote_id: string;
  provider_shipment_id: string;
  /** A shipment (one box) or an order (several). */
  kind?: unknown;
  /** The rate as the server stored it when it was quoted. */
  rate?: { carrierCode?: unknown; service?: unknown } | null;
};

const CLAIM_ERRORS: [match: string, message: string][] = [
  ["cancelled", "This order was cancelled, so there's nothing to send."],
  ["Nothing left", "Everything on this order has already been sent."],
  [
    "still being finished",
    "A label for this order has already been bought or is being bought right now. Reload this page to see it.",
  ],
  [
    "moments ago",
    "A label for this order was bought a moment ago. Reload this page to see it before buying another.",
  ],
  ["not quoted", "Those rates have run out. Press Get rates again, then choose one."],
];

/** Keeps a paid-for label's details; tried twice, because losing them matters. */
async function keepLabel(tenantId: string, quoteId: string, label: BoughtLabel): Promise<boolean> {
  const save = () =>
    getAdminClient().rpc("mark_label_bought", {
      p_tenant_id: tenantId,
      p_quote_id: quoteId,
      p_carrier: label.carrier,
      p_service: serviceWithoutCarrier(label.carrier, label.name),
      p_tracking_number: label.trackingCode,
      p_tracking_url: label.trackingCode ? trackingUrl(label.carrier, label.trackingCode) : null,
      p_label_url: label.labelUrl,
      p_label_mode: label.mode,
      // Text, so the price reaches the database exactly as EasyPost gave it.
      p_price: label.price,
      // Every box: what a refund is asked for by, its tracking and its label.
      p_parcels: label.boxes.map((box) => ({
        shipment_id: box.shipmentId,
        tracking_number: box.trackingCode,
        tracking_url: box.trackingCode ? trackingUrl(label.carrier, box.trackingCode) : null,
        label_url: box.labelUrl,
      })),
    });
  for (let attempt = 0; attempt < 2; attempt++) {
    const { error } = await save();
    if (!error) return true;
    console.error("could not keep bought label", error.message);
  }
  return false;
}

const tracked = (label: BoughtLabel) => {
  const codes = label.boxes.map((box) => box.trackingCode).filter(Boolean);
  if (codes.length === 0) return "";
  return codes.length === 1
    ? ` (tracking number ${codes[0]})`
    : ` (tracking numbers ${codes.join(", ")})`;
};

/**
 * Buys the chosen rate and records the parcel. This spends real money, so:
 *  - the purchase is claimed in the database first, under a lock on the
 *    order; a second press, another tab or another person is refused;
 *  - only a rate the server itself quoted for this order can be bought;
 *  - several boxes are bought in one call, so it is all of them or none;
 *  - once EasyPost has taken the money the label is written down before the
 *    parcel is recorded, and every message from then on says it WAS bought.
 */
export async function buyLabel(
  slug: string,
  orderId: string,
  rateId: string,
  /** The two ticks beside the button; left out, the workspace's settings decide. */
  shop?: { markSent: boolean; notify: boolean },
): Promise<BuyState> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  if (!UUID.test(orderId) || !/^[A-Za-z0-9_]{4,120}$/.test(String(rateId))) {
    return { error: "Choose a rate first." };
  }
  const setup = await loadShippingSetup(ctx.supabase, ctx.tenant.id);

  const { data: claimed, error: claimError } = await ctx.supabase.rpc("claim_label_purchase", {
    p_shipping_order_id: orderId,
    p_rate_id: rateId,
  });
  if (claimError || !claimed) {
    const known = CLAIM_ERRORS.find(([match]) => claimError?.message.includes(match));
    return { error: known ? known[1] : "We couldn't start that purchase. Nothing was bought." };
  }
  const claim = claimed as Claim;
  const kind: LabelKind = isLabelKind(claim.kind) ? claim.kind : "shipment";
  const release = async () => {
    const { error } = await getAdminClient().rpc("release_label_purchase", {
      p_tenant_id: ctx.tenant.id,
      p_quote_id: claim.quote_id,
    });
    if (error) console.error("could not release label purchase", error.message);
  };

  const held = await labelKey(ctx.tenant.id);
  if ("error" in held) {
    await release();
    return { error: `${held.error} Nothing was bought.` };
  }

  let label: BoughtLabel;
  try {
    label =
      kind === "order"
        ? await buyOrder(held.key, claim.provider_shipment_id, {
            // EasyPost's own codes, from the quote the server kept; nothing from the browser.
            carrierCode: String(claim.rate?.carrierCode ?? ""),
            service: String(claim.rate?.service ?? ""),
          })
        : await buyFromEasyPost(held.key, claim.provider_shipment_id, rateId);
  } catch (err) {
    const refused = !(err instanceof EasyPostError && err.uncertain);
    // One box: a plain "no" means nothing was charged. Several boxes are
    // bought one after another on EasyPost's side, so even a plain "no" is
    // checked before we say nothing was bought (a bad key aside: that buys nothing).
    if (refused && (kind === "shipment" || !(err instanceof EasyPostError))) {
      await release();
      return { error: `${await explain(err, held.connectionId)} Nothing was bought.` };
    }
    // No clear answer. Ask EasyPost whether the label exists before saying anything.
    const settled = await getPurchase(held.key, kind, claim.provider_shipment_id).catch(() => null);
    if (settled === null) {
      done(slug);
      return {
        bought: true,
        error:
          "EasyPost stopped answering part-way through, so we can't tell yet whether this label was bought. Please don't buy another. Reload this page in a minute and press Check this label; your EasyPost account will also show it if it went through.",
      };
    }
    if (!settled.label) {
      await release();
      return {
        error: refused
          ? `${await explain(err, held.connectionId)} Nothing was bought.`
          : "EasyPost didn't finish that purchase. Nothing was bought; try again.",
      };
    }
    label = settled.label;
  }

  // From here on the money is spent.
  if (!(await keepLabel(ctx.tenant.id, claim.quote_id, label))) {
    done(slug);
    return {
      bought: true,
      error: `Your label WAS bought${tracked(label)}, but we couldn't save it here just now. Please don't buy another. Reload this page in a minute and press Check this label to finish; the label is also in your EasyPost account.`,
    };
  }

  const push = setup.canSend && (shop ? shop.markSent === true : setup.settings.mark_sent_in_shop);
  const { data: number, error: recordError } = await ctx.supabase.rpc("record_label_shipment", {
    p_quote_id: claim.quote_id,
    p_push: push,
    p_notify: push && (shop ? shop.notify === true : setup.settings.notify_customer),
  });
  done(slug);
  if (recordError) {
    console.error("could not record label parcel", recordError.message);
    return {
      bought: true,
      error: `Your label WAS bought${tracked(label)} and is saved on this order, but recording the parcel didn't go through. Please don't buy another. Reload this page: the label is under "Labels to finish", where you can print it and finish recording.`,
    };
  }
  redirect(`/w/${slug}/shipping/orders/${orderId}?label=${number as number}`);
}

/**
 * Finishes a label that was bought (or may have been) but isn't a parcel
 * yet: asks EasyPost what really happened if we never heard, then records it.
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
    .select("id, shipping_order_id, provider_shipment_id, status, label_kind")
    .eq("tenant_id", ctx.tenant.id)
    .eq("id", quoteId)
    .maybeSingle();
  const quote = data as {
    id: string;
    shipping_order_id: string;
    provider_shipment_id: string;
    status: string;
    label_kind: string;
  } | null;
  if (!quote || !["buying", "bought"].includes(quote.status)) {
    done(slug);
    return { error: "That label is already sorted. Reload this page." };
  }

  if (quote.status === "buying") {
    const held = await labelKey(ctx.tenant.id);
    if ("error" in held) return { error: held.error };
    let settled: Awaited<ReturnType<typeof getPurchase>>;
    try {
      settled = await getPurchase(
        held.key,
        isLabelKind(quote.label_kind) ? quote.label_kind : "shipment",
        quote.provider_shipment_id,
      );
    } catch (err) {
      return { error: await explain(err, held.connectionId) };
    }
    if (!settled.label) {
      const { error } = await getAdminClient().rpc("release_label_purchase", {
        p_tenant_id: ctx.tenant.id,
        p_quote_id: quote.id,
      });
      if (error) return { error: OOPS };
      done(slug);
      return {
        message:
          "EasyPost says that label was never bought, so nothing was charged. You can get rates again.",
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
