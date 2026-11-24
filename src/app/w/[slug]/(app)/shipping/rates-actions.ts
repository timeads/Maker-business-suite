"use server";

import { requireUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { formatTenthOz } from "@/lib/shipping/easypost";
import { shipFromAddress } from "@/lib/shipping/labels";
import { listRates } from "@/lib/shipping/plan-quotes";
import { calcRequest, calcRows, type CalcInput, type CalcRow } from "@/lib/shipping/rate-calc";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";
import { loadBoxes, loadLabelConnections, loadShippingSetup } from "./data";
import { NOTHING_CONNECTED, needsConnecting } from "./label-core";

/**
 * The rate calculator. A ZIP, a box and a weight go to the connected postage
 * accounts and nowhere else, exactly as an order's would; what comes back is
 * shown as words. Nothing is written down: no quote is kept, so nothing
 * priced here can be bought.
 */

export type CalcState = {
  error?: string;
  /** "12534 → 90210 · 2 lb 4 oz with the box · 16 × 12 × 10 in" */
  summary?: string;
  rows?: CalcRow[];
};

const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.slice(0, max) : "";

export async function getCalcRates(slug: string, asked: CalcInput): Promise<CalcState> {
  const user = await requireUser(`/w/${slug}/shipping/rates`);
  const ctx = await getTenantContext(slug, user.id);
  const entitlements = ctx ? await getEntitlements(ctx.tenant.id) : null;
  if (!ctx || !entitlements?.can("module.shipping")) {
    return { error: "Shipping isn't part of this workspace's plan right now." };
  }
  const from = asked && typeof asked === "object" ? asked : ({} as Partial<CalcInput>);
  const input: CalcInput = {
    fromZip: text(from.fromZip, 10),
    toZip: text(from.toZip, 10),
    weightLb: text(from.weightLb, 10),
    weightOz: text(from.weightOz, 10),
    boxId: text(from.boxId, 36),
    length: text(from.length, 10),
    width: text(from.width, 10),
    height: text(from.height, 10),
    residential: from.residential !== false,
    signature: text(from.signature, 20),
  };
  const supabase = await createClient();
  const [setup, boxes, postage] = await Promise.all([
    loadShippingSetup(supabase, ctx.tenant.id),
    loadBoxes(supabase, ctx.tenant.id),
    loadLabelConnections(supabase, ctx.tenant.id),
  ]);
  if (postage.active.length === 0) {
    return {
      error:
        postage.needsReconnect.length > 0
          ? needsConnecting(postage.needsReconnect[0])
          : NOTHING_CONNECTED,
    };
  }
  const built = calcRequest(input, shipFromAddress(setup.settings), boxes);
  if ("error" in built) return { error: built.error };
  const { request, boxName } = built;
  const rows = calcRows(await listRates(ctx.tenant.id, postage.active, request));
  if (rows.length === 0) {
    return { error: "No prices came back for that. Check the ZIPs, the size and the weight." };
  }
  const [parcel] = request.parcels;
  return {
    rows,
    summary: `${request.from.zip} → ${request.to.zip} · ${formatTenthOz(parcel.weightTenthOz)}${
      boxName ? ` with the ${boxName.toLowerCase()}` : ""
    } · ${parcel.length} × ${parcel.width} × ${parcel.height} in`,
  };
}
