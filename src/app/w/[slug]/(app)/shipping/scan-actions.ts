"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { formatTenthOz, tenthOzToLbOz } from "@/lib/shipping/easypost";
import { listService } from "@/lib/shipping/list";
import { parseSavedChoice } from "@/lib/shipping/choices";
import { pickService } from "@/lib/shipping/rules";
import { benchSplitChoice, type BenchSplitBox } from "@/lib/shipping/scan";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";
import { ORDER_FIELDS, loadOpenLabelOrders, loadPlans, type ShippingOrder } from "./data";
import { purchaseLabel, quoteRates } from "./label-core";
import { benchAssess, boughtLabels, type BenchAsk } from "./planned";
import type { OrderPlan } from "@/lib/shipping/plan";

/**
 * Buying a label from the packing bench. The plan is the one the To ship
 * list shows (box, weight, service by saved choice, rule or memory), with
 * the box row as the bench changed it; or the scanned part of an order; or
 * several orders in one parcel. The price is asked fresh and shown on the
 * bench; buying goes through `purchaseLabel`, the one path every label
 * takes, with every order, item and amount checked again from what is
 * stored.
 */

const NO_ACCESS = "Shipping isn't part of this workspace's plan right now.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const UUID = /^[0-9a-f-]{36}$/i;

async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/shipping/scan`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.shipping")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  return { user, tenant: ctx.tenant, supabase: await createClient() } as const;
}

export type ScanOffer = {
  /** The rate to buy, from the quote the server just kept for this order. */
  rateId: string;
  /** "UPS Ground" */
  service: string;
  price: string;
  currency: string;
  days: number | null;
  /** "Medium box · 2 lb 4 oz", or "2 boxes · 5 lb". */
  packing: string;
  /** A signature is asked for on delivery. */
  signature: boolean;
};

/** The planned box, as the bench's box row shows it. */
export type ScanBox = {
  boxId: string;
  length: string;
  width: string;
  height: string;
  weightLb: string;
  weightOz: string;
};

export type ScanPlan = {
  /** This order can't be bought from the bench as it stands: said plainly. */
  why?: string;
  /** All that is missing is a weight: the box row asks for it. */
  needsWeight?: boolean;
  offer?: ScanOffer;
  /** The one planned box, for the box row. Null when it is planned in several. */
  box?: ScanBox | null;
  /** Each planned box by name, when there are several. */
  boxNames?: string[];
  /** Every planned box with what is in it, for "Change boxes". A weight nobody typed is left blank. */
  boxes?: BenchSplitBox[];
  signature?: boolean;
};

const boxOf = (plan: OrderPlan): Pick<ScanPlan, "box" | "boxNames" | "boxes" | "signature"> => {
  const [first] = plan.boxes;
  const weight =
    first && first.weightTenthOz !== null ? tenthOzToLbOz(first.weightTenthOz) : { lb: "", oz: "" };
  return {
    box:
      plan.boxes.length === 1
        ? {
            boxId: first.box?.id ?? "",
            length: String(first.length),
            width: String(first.width),
            height: String(first.height),
            weightLb: weight.lb,
            weightOz: weight.oz,
          }
        : null,
    boxNames: plan.boxes.map((box) => box.box?.name ?? "custom size"),
    boxes: plan.boxes.map((box) => {
      const typed =
        box.weighed && box.weightTenthOz !== null
          ? tenthOzToLbOz(box.weightTenthOz)
          : { lb: "", oz: "" };
      return {
        boxId: box.box?.id ?? "",
        length: String(box.length),
        width: String(box.width),
        height: String(box.height),
        weightLb: typed.lb,
        weightOz: typed.oz,
        items: box.items,
      };
    }),
    signature: plan.signature,
  };
};

const cleanAsk = (ask: BenchAsk | undefined): BenchAsk => {
  const from = ask && typeof ask === "object" ? ask : {};
  return {
    labelFormat: from.labelFormat === "zpl" ? "zpl" : undefined,
    withIds: Array.isArray(from.withIds)
      ? from.withIds.filter((id) => typeof id === "string" && UUID.test(id)).slice(0, 20)
      : undefined,
    part: Array.isArray(from.part) ? from.part.slice(0, 250) : undefined,
    holdRest: from.holdRest !== false,
    box: from.box && typeof from.box === "object" ? from.box : undefined,
    unpaidOk: from.unpaidOk === true,
  };
};

/** The label the bench would buy, with a fresh price. Buys nothing. */
export async function planScanLabel(
  slug: string,
  orderId: string,
  asked?: BenchAsk,
): Promise<ScanPlan> {
  const ctx = await context(slug);
  if ("error" in ctx) return { why: String(ctx.error) };
  if (!UUID.test(orderId)) return { why: "We couldn't find that order." };
  const ask = cleanAsk(asked);
  const checked = await benchAssess(ctx, orderId, ask);
  if ("refusal" in checked) {
    return {
      why: checked.refusal,
      needsWeight: checked.needsWeight,
      ...(checked.plan ? boxOf(checked.plan) : {}),
    };
  }
  const { plan } = checked;
  if (checked.keep) {
    // The box a person set at the bench is the order's own from here on: the
    // list, the order page and a bulk run all start from it.
    const { error } = await ctx.supabase.rpc("save_shipping_order_choice", {
      p_shipping_order_id: orderId,
      p_choice: checked.keep,
    });
    if (error) console.error("could not keep the bench's box", error.message);
  }
  const quoted = await quoteRates(ctx, orderId, checked.input);
  if ("error" in quoted) return { why: quoted.error, ...boxOf(plan) };
  const picked = pickService(quoted.rates, plan.service);
  if (!picked) return { why: "No carrier offered a price just now.", ...boxOf(plan) };
  const boxes = plan.boxes;
  const size =
    boxes[0]?.box?.name ?? `${boxes[0]?.length} × ${boxes[0]?.width} × ${boxes[0]?.height} in`;
  return {
    ...boxOf(plan),
    offer: {
      rateId: picked.rate.id,
      service: listService(picked.rate.carrier, picked.rate.name),
      price: picked.rate.price,
      currency: picked.rate.currency,
      days: picked.rate.days,
      packing: `${boxes.length > 1 ? `${boxes.length} boxes` : size}${
        plan.weightTenthOz ? ` · ${formatTenthOz(plan.weightTenthOz)}` : ""
      }`,
      signature: plan.signature,
    },
  };
}

export type ScanBought = {
  /** Nothing was bought: why. */
  error?: string;
  /** Money was or may have been spent and the parcel isn't recorded: stop offering to buy. */
  unsure?: boolean;
  /** Bought and recorded. */
  bought?: {
    number: number;
    service: string;
    price: string;
    currency: string;
    shipmentId?: string;
    labels: { href: string; text: string }[];
  };
};

/**
 * Buys the rate the bench was just shown. The order is checked again from
 * what is stored and its plan rebuilt here (the same orders, the same part,
 * the same box row); the rate must be one the server quoted for exactly
 * that, and (for UPS and Redo) the rebuilt request must be exactly what was
 * priced. Whether the shop is told follows the settings.
 */
export async function buyScanLabel(
  slug: string,
  orderId: string,
  rateId: string,
  asked?: BenchAsk,
): Promise<ScanBought> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: String(ctx.error) };
  if (!UUID.test(orderId)) return { error: "We couldn't find that order." };
  const ask = cleanAsk(asked);
  const checked = await benchAssess(ctx, orderId, ask);
  if ("refusal" in checked) return { error: `${checked.refusal} Nothing was bought.` };
  const result = await purchaseLabel(
    ctx,
    slug,
    orderId,
    rateId,
    undefined,
    checked.input.withIds ?? [],
    checked.input,
  );
  revalidatePath(`/w/${slug}/shipping`, "layout");
  if (result.state === "refused") return { error: result.error };
  if (result.state === "unsure") return { unsure: true, error: result.error };
  const printable = await boughtLabels(ctx, result.number);
  return {
    bought: {
      number: result.number,
      service: listService(result.carrier, result.service),
      price: result.price,
      currency: result.currency,
      ...printable,
    },
  };
}

/**
 * "Change boxes" at the bench, before any label is bought: which boxes the
 * order goes in and how many of each item is in each. Checked here against
 * the order as it is stored (every unit still to send in exactly one box),
 * then kept as the order's own saved choice, so the order page, the packing
 * slips, the list and a bulk run all see the same boxes. Nothing is priced or
 * bought here, and buying later rebuilds the boxes from what was stored.
 */
export async function saveBenchBoxes(
  slug: string,
  orderId: string,
  boxes: unknown,
): Promise<{ error?: string; ok?: boolean }> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: String(ctx.error) };
  if (!UUID.test(orderId)) return { error: "We couldn't find that order." };
  const [{ data }, labelOpen, plans] = await Promise.all([
    ctx.supabase
      .from("shipping_orders")
      .select(ORDER_FIELDS)
      .eq("tenant_id", ctx.tenant.id)
      .eq("id", orderId)
      .maybeSingle(),
    loadOpenLabelOrders(ctx.supabase, ctx.tenant.id),
    loadPlans(ctx.supabase, ctx.tenant.id, [orderId]),
  ]);
  const order = data as unknown as ShippingOrder | null;
  if (!order || order.cancelled || order.picked_up_at || order.units_left <= 0) {
    return { error: "It isn't waiting to ship any more, so its boxes can't change." };
  }
  if (labelOpen.has(orderId)) {
    return { error: "Its label is already being bought, so its boxes are fixed." };
  }
  const built = benchSplitChoice(
    boxes,
    order.items,
    parseSavedChoice(plans.get(orderId)?.saved_choice),
  );
  if ("error" in built) return { error: built.error };
  const { error } = await ctx.supabase.rpc("save_shipping_order_choice", {
    p_shipping_order_id: orderId,
    p_choice: built.choice,
  });
  if (error) return { error: "That didn't save. Please try again." };
  revalidatePath(`/w/${slug}/shipping`, "layout");
  return { ok: true };
}
