"use server";

import { requireUser } from "@/lib/auth";
import { formatMoney } from "@/lib/dashboard/format";
import { getEntitlements } from "@/lib/entitlements";
import { shipFromAddress, shipToAddress } from "@/lib/shipping/labels";
import { MOST_SHOWN, PLAN_BATCH, type PlanCell } from "@/lib/shipping/list";
import {
  addressSettled,
  fingerprint,
  needsPlanning,
  planCell,
  planFor,
  planParcel,
  quoteFresh,
  type PlanSetup,
  type StoredPlan,
} from "@/lib/shipping/plan";
import { listAddressCheck, listQuote } from "@/lib/shipping/plan-quotes";
import { inQueueView, isQueueView, todayIn } from "@/lib/shipping/queue";
import { getAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";
import {
  loadBoxes,
  loadLabelConnections,
  loadOpenOrders,
  loadPlans,
  loadShippingSetup,
  type ShippingOrder,
} from "./data";

export type PlanState = {
  /** What was worked out this time, by order id. */
  cells: Record<string, PlanCell>;
  /** How many orders in this view are still to do after these. */
  left: number;
};

const NOTHING: PlanState = { cells: {}, left: 0 };
const UUID = /^[0-9a-f-]{36}$/i;
/** How many orders are asked about at once. */
const AT_ONCE = 5;

async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/shipping`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return null;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.shipping") || !entitlements.canWrite) return null;
  return { tenant: ctx.tenant, supabase: await createClient() };
}

/**
 * Works out the next few orders in a view that the list has no fresh note
 * for: checks each address (once per order and address, ever) and asks every
 * connected postage account for its best price for the usual box, or the box
 * a person picked. A handful per call, so the list is never kept waiting.
 *
 * What comes back is words for the list. Nothing here makes a quote that
 * could be bought, and `shipping_label_quotes` is never touched.
 */
export async function planNextOrders(slug: string, view: string): Promise<PlanState> {
  const ctx = await context(slug);
  if (!ctx || !isQueueView(view)) return NOTHING;
  const { tenant, supabase } = ctx;
  const [open, shipping, boxes, postage] = await Promise.all([
    loadOpenOrders(supabase, tenant.id),
    loadShippingSetup(supabase, tenant.id),
    loadBoxes(supabase, tenant.id),
    loadLabelConnections(supabase, tenant.id),
  ]);
  const now = new Date();
  const today = todayIn(tenant.timezone, now);
  const home = shipping.settings.ship_from_country;
  const setup: PlanSetup = { boxes, sources: postage.active, settings: shipping.settings };
  const shown = open
    .filter((order) => inQueueView(order, view, today, home, shipping.settings.signature_over))
    .slice(0, MOST_SHOWN);
  const stored = await loadPlans(
    supabase,
    tenant.id,
    shown.map((order) => order.id),
  );
  const planOf = (order: ShippingOrder, row: StoredPlan | undefined) =>
    planFor(order, row?.chosen_box_id, order.order_total, setup);
  const todo = shown.filter((order) =>
    needsPlanning(stored.get(order.id), planOf(order, stored.get(order.id)), now),
  );
  if (todo.length === 0) return NOTHING;
  const batch = todo.slice(0, PLAN_BATCH);

  // Only the orders nobody else's list is working out right now.
  const admin = getAdminClient();
  const { data: claimed, error } = await admin.rpc("claim_shipping_order_plans", {
    p_tenant_id: tenant.id,
    p_order_ids: batch.map((order) => order.id),
  });
  if (error) {
    console.error("could not claim orders to plan", error.message);
    return NOTHING;
  }
  const mine = new Set(
    ((claimed ?? []) as unknown[]).map((row) =>
      typeof row === "string"
        ? row
        : String((row as { claim_shipping_order_plans?: string }).claim_shipping_order_plans ?? ""),
    ),
  );

  const cells: Record<string, PlanCell> = {};
  const work = batch.filter((order) => mine.has(order.id));
  const one = async (order: ShippingOrder) => {
    const before = stored.get(order.id);
    const plan = planOf(order, before);
    const after: StoredPlan = before
      ? { ...before }
      : {
          shipping_order_id: order.id,
          chosen_box_id: null,
          plan_key: null,
          quote_status: null,
          quote_source: null,
          quote_carrier: null,
          quote_service: null,
          quote_cents: null,
          quote_currency: null,
          quoted_at: null,
          address_key: null,
          address_status: null,
          address_residential: null,
          address_checked_at: null,
        };
    const to = shipToAddress(order, home);
    const asked = new Date().toISOString();

    // The address first, as on the order page: a home or a business changes the price.
    let address: Record<string, unknown> | null = null;
    if (plan.canCheck && !addressSettled(before, plan, now)) {
      const check = await listAddressCheck(tenant.id, postage.active, to);
      after.address_key = fingerprint(plan.addressFacts);
      after.address_status = check.status;
      after.address_residential = check.residential;
      after.address_checked_at = asked;
      address = {
        address_key: after.address_key,
        status: check.status,
        residential: check.residential,
      };
    }

    let quote: Record<string, unknown> | null = null;
    if (!plan.noQuote && !quoteFresh(before, plan, now)) {
      const residential = addressSettled(after, plan, now) ? after.address_residential : null;
      const best = await listQuote(tenant.id, postage.active, {
        from: shipFromAddress(shipping.settings),
        to: { ...to, residential: residential ?? true },
        parcels: [planParcel(plan)],
        reference: order.name ?? undefined,
        signature: plan.signature ? "signature" : "none",
      });
      after.plan_key = fingerprint(plan.quoteFacts);
      after.quote_status = best.status;
      after.quoted_at = asked;
      if (best.status === "ok") {
        after.quote_source = best.source;
        after.quote_carrier = best.carrier;
        after.quote_service = best.service;
        after.quote_cents = best.cents;
        after.quote_currency = best.currency;
      }
      quote = {
        box_id: plan.box?.id ?? null,
        box_source: plan.boxSource,
        weight_tenth_oz: plan.weightTenthOz,
        plan_key: after.plan_key,
        ...best,
      };
    }

    // Always written, even with nothing new: it lets go of the order for the next list.
    const { error: failed } = await admin.rpc("save_shipping_order_plan", {
      p_tenant_id: tenant.id,
      p_shipping_order_id: order.id,
      p_quote: quote,
      p_address: address,
    });
    if (failed) console.error("could not keep an order's plan", failed.message);
    cells[order.id] = planCell(plan, after, {
      now: new Date(),
      // Whatever is still missing now was asked and didn't come: don't say "working on it".
      willFill: false,
      paidCents:
        order.shipping_paid === null ? null : Math.round(Number(order.shipping_paid) * 100),
      currency: tenant.currency,
      imperial: home === "US",
      money: formatMoney,
    });
  };
  for (let from = 0; from < work.length; from += AT_ONCE) {
    await Promise.all(work.slice(from, from + AT_ONCE).map(one));
  }
  return { cells, left: todo.length - batch.length };
}

/**
 * Remembers the box a person picked for one order, so the list shows it
 * ("your choice") and the order opens with it next time. Passing nothing
 * goes back to the usual box. Quiet: a miss here never gets in the way of
 * packing.
 */
export async function rememberOrderBox(
  slug: string,
  orderId: string,
  boxId: string | null,
): Promise<{ ok: boolean }> {
  const ctx = await context(slug);
  if (!ctx || !UUID.test(orderId) || (boxId !== null && !UUID.test(boxId))) return { ok: false };
  const { error } = await ctx.supabase.rpc("set_shipping_order_box", {
    p_shipping_order_id: orderId,
    p_box_id: boxId,
  });
  return { ok: !error };
}
