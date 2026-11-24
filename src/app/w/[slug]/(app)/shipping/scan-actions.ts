"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { formatTenthOz } from "@/lib/shipping/easypost";
import { listService } from "@/lib/shipping/list";
import { pickService } from "@/lib/shipping/rules";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";
import { purchaseLabel, quoteRates } from "./label-core";
import { assess, boughtLabels, planInput } from "./planned";

/**
 * Buying the planned label from the packing bench, once every item of an
 * order has been checked. The plan is the one the To ship list shows (box,
 * weight, service by saved choice, rule or memory). The price is asked fresh
 * and shown to the person; pressing Buy goes through `purchaseLabel`, the
 * one path every label takes. Nothing here buys on its own.
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

export type ScanPlan = {
  /** This order can't be bought from the bench: said plainly, with the order page as the way on. */
  why?: string;
  offer?: ScanOffer;
};

/** The planned label for a packed order, with a fresh price. Buys nothing. */
export async function planScanLabel(
  slug: string,
  orderId: string,
  /** "zpl" when this computer prints straight to a Zebra. */
  labelFormat?: string,
): Promise<ScanPlan> {
  const ctx = await context(slug);
  if ("error" in ctx) return { why: String(ctx.error) };
  if (!UUID.test(orderId)) return { why: "We couldn't find that order." };
  const [checked] = await assess(ctx, [orderId], false);
  if (checked.refusal || !checked.plan) {
    return { why: checked.refusal ?? "It has no box or weight to price yet." };
  }
  const { plan } = checked;
  const quoted = await quoteRates(ctx, orderId, planInput(plan, checked.stored, labelFormat));
  if ("error" in quoted) return { why: quoted.error };
  const picked = pickService(quoted.rates, plan.service);
  if (!picked) return { why: "No carrier offered a price just now." };
  const boxes = plan.boxes;
  const size =
    boxes[0]?.box?.name ?? `${boxes[0]?.length} × ${boxes[0]?.width} × ${boxes[0]?.height} in`;
  return {
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
 * what is stored and its plan rebuilt here; the rate must be one the server
 * quoted for this order, and (for UPS and Redo) the rebuilt request must be
 * exactly what was priced. Whether the shop is told follows the settings.
 */
export async function buyScanLabel(
  slug: string,
  orderId: string,
  rateId: string,
  labelFormat?: string,
): Promise<ScanBought> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: String(ctx.error) };
  if (!UUID.test(orderId)) return { error: "We couldn't find that order." };
  const [checked] = await assess(ctx, [orderId], false);
  if (checked.refusal || !checked.plan) {
    return { error: `${checked.refusal ?? "It can't be priced right now."} Nothing was bought.` };
  }
  const input = planInput(checked.plan, checked.stored, labelFormat);
  const result = await purchaseLabel(ctx, slug, orderId, rateId, undefined, [], input);
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
