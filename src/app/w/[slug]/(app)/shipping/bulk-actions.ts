"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { formatMoney } from "@/lib/dashboard/format";
import { getEntitlements } from "@/lib/entitlements";
import {
  bulkEstimate,
  orderRefusal,
  planRefusal,
  priceMoved,
  type BulkOutcome,
} from "@/lib/shipping/bulk";
import { priceToCents, tenthOzToLbOz } from "@/lib/shipping/easypost";
import { shownBoxes } from "@/lib/shipping/labels";
import { listService } from "@/lib/shipping/list";
import { dismissedKeys, liveSavedGroups, mergeSuggestions } from "@/lib/shipping/merge";
import {
  addressSettled,
  choiceOf,
  planFor,
  quoteFresh,
  type OrderPlan,
  type StoredPlan,
} from "@/lib/shipping/plan";
import { holdState, isInternational, todayIn } from "@/lib/shipping/queue";
import { pickService } from "@/lib/shipping/rules";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";
import {
  loadBoxes,
  loadGroups,
  loadLabelConnections,
  loadOpenLabelOrders,
  loadOpenOrders,
  loadPackingMemory,
  loadPlans,
  loadShippingSetup,
  planSetupOf,
  withRuleFacts,
  type ShippingOrder,
} from "./data";
import { purchaseLabel, quoteRates, type LabelCtx, type RatesInput } from "./label-core";

/**
 * Buying labels for several ticked orders. A run is a list of orders and a
 * record of what became of each; the buying itself is one order at a time,
 * each through `quoteRates` and `purchaseLabel`: the very path a single
 * label takes. So for every order: a fresh quote the server keeps, a claim
 * under a lock on the order, only a rate from that quote, the label written
 * down before the parcel is recorded. An order that fails stops nothing else,
 * and no order can be bought twice.
 */

const NO_ACCESS = "Shipping isn't part of this workspace's plan right now.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const UUID = /^[0-9a-f-]{36}$/i;
const GONE = "It isn't waiting to ship any more.";

async function context(slug: string) {
  const user = await requireUser(`/w/${slug}/shipping`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: NO_ACCESS } as const;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.shipping")) return { error: NO_ACCESS } as const;
  if (!entitlements.canWrite) return { error: READ_ONLY } as const;
  return { user, tenant: ctx.tenant, supabase: await createClient() } as const;
}
type Ctx = Exclude<Awaited<ReturnType<typeof context>>, { error: string }>;

type Assessed = {
  id: string;
  name: string;
  /** Why the run leaves it out; null when it may be bought. */
  refusal: string | null;
  order: ShippingOrder | null;
  plan: OrderPlan | null;
  stored: StoredPlan | null;
  /** The list's price for this plan, when one stands. */
  cents: number | null;
  currency: string | null;
};

/**
 * Looks at each order afresh, from what is stored: is it still waiting, free
 * of holds and other labels, going somewhere the carriers know, with a plan
 * and a price the list worked out for that very plan? Nothing from the
 * browser is believed but the ids.
 */
async function assess(ctx: Ctx, ids: string[]): Promise<Assessed[]> {
  const { tenant, supabase } = ctx;
  const [loaded, shipping, boxes, postage, groups, labelOpen, stored] = await Promise.all([
    loadOpenOrders(supabase, tenant.id),
    loadShippingSetup(supabase, tenant.id),
    loadBoxes(supabase, tenant.id),
    loadLabelConnections(supabase, tenant.id),
    loadGroups(supabase, tenant.id),
    loadOpenLabelOrders(supabase, tenant.id),
    loadPlans(supabase, tenant.id, ids),
  ]);
  const now = new Date();
  const today = todayIn(tenant.timezone, now);
  const home = shipping.settings.ship_from_country;
  const bare = planSetupOf(
    { shipping, boxes, postage, memory: { exact: new Map(), similar: new Map() } },
    tenant.currency,
  );
  const ruled = withRuleFacts(loaded, bare);
  const ruleHolds = new Map(ruled.holds.map((hold) => [hold.id, hold.note]));
  const open = new Map(ruled.orders.map((order) => [order.id, order]));
  const wanted = ids.map((id) => open.get(id)).filter((order): order is ShippingOrder => !!order);
  const setup = { ...bare, memory: await loadPackingMemory(supabase, tenant.id, wanted) };

  // Orders that are waiting to go in one parcel, or could: those are for the group's own page.
  const partners = new Map<string, string[]>();
  const names = new Map(ruled.orders.map((order) => [order.id, order.name ?? "another order"]));
  for (const group of [
    ...liveSavedGroups(groups, ruled.orders, today),
    ...mergeSuggestions(ruled.orders, dismissedKeys(groups), today),
  ]) {
    for (const id of group.orderIds) {
      const others = group.orderIds
        .filter((other) => other !== id)
        .map((other) => names.get(other)!);
      partners.set(id, [...new Set([...(partners.get(id) ?? []), ...others])].slice(0, 3));
    }
  }

  return ids.map((id): Assessed => {
    const order = open.get(id) ?? null;
    const row = stored.get(id) ?? null;
    if (!order) {
      return {
        id,
        name: "Order",
        refusal: GONE,
        order,
        plan: null,
        stored: row,
        cents: null,
        currency: null,
      };
    }
    const name = order.name ?? "Order";
    const derived = ruleHolds.get(id) ?? null;
    const first = orderRefusal({
      cancelled: order.cancelled,
      unitsLeft: order.units_left,
      pickedUp: Boolean(order.picked_up_at),
      // A hold a rule calls for that isn't written down yet is said as the rule's.
      hold: derived === null ? holdState(order, today) : "none",
      ruleHold: derived,
      paid: order.paid,
      pickup: order.pickup,
      abroad: isInternational(order.country_code, home),
      partSent: order.items.some((item) => item.left < item.qty),
      labelOpen: labelOpen.has(id),
      togetherWith: partners.get(id) ?? [],
    });
    const plan = planFor(order, choiceOf(row), order.order_total, setup);
    const fresh = quoteFresh(row, plan, now);
    const refusal =
      first ??
      planRefusal({
        noQuote: plan.noQuote,
        canCheck: plan.canCheck,
        address:
          addressSettled(row, plan, now) && row?.address_status === "found"
            ? "found"
            : addressSettled(row, plan, now) && row?.address_status === "not_found"
              ? "not_found"
              : "unchecked",
        quote: !fresh ? "missing" : row?.quote_status === "ok" ? "ok" : "none",
      });
    const priced = fresh && row?.quote_status === "ok" && row.quote_cents !== null;
    return {
      id,
      name,
      refusal,
      order,
      plan,
      stored: row,
      cents: priced ? row!.quote_cents : null,
      currency: priced ? (row!.quote_currency ?? tenant.currency) : null,
    };
  });
}

export type RunStart = {
  error?: string;
  /** The run, once started. */
  batchId?: string;
  /** The orders it will buy for, in order. */
  buy?: { id: string; name: string }[];
  /** The orders left out, each with why. */
  leftOut?: { id: string; name: string; why: string }[];
};

/**
 * Starts a run for the ticked orders: checks each one on the server, leaves
 * out (and names) any that can't be bought this way, and writes the run down
 * as a label batch. Nothing is bought here.
 */
export async function startLabelRun(slug: string, orderIds: string[]): Promise<RunStart> {
  const ctx = await context(slug);
  if ("error" in ctx) return { error: ctx.error };
  const ids = [...new Set((Array.isArray(orderIds) ? orderIds : []).filter((id) => UUID.test(id)))];
  if (ids.length < 1) return { error: "Tick the orders to buy labels for first." };
  if (ids.length > 300) return { error: "That's a lot at once. Tick fewer orders and try again." };
  const estimate = bulkEstimate(await assess(ctx, ids));
  if (estimate.buy.length === 0) {
    return {
      error: "None of those orders can have a label bought this way right now.",
      leftOut: estimate.leftOut,
    };
  }
  const { data, error } = await ctx.supabase.rpc("start_label_batch", {
    p_tenant_id: ctx.tenant.id,
    p_order_ids: estimate.buy.map((row) => row.id),
  });
  if (error || typeof data !== "string") {
    console.error("could not start a label run", error?.message);
    return { error: "We couldn't start that run. Nothing was bought; try again." };
  }
  return {
    batchId: data,
    buy: estimate.buy.map((row) => ({ id: row.id, name: row.name })),
    leftOut: estimate.leftOut,
  };
}

/** What the screen is told about one order of a run. */
export type RunStep = BulkOutcome & {
  /** For a bought label: the parcel, and each box's label to open or print. */
  shipmentId?: string;
  labels?: { href: string; text: string }[];
};

/** The rates request for an order's plan: the same shape the order page sends. */
function planInput(plan: OrderPlan, stored: StoredPlan | null, labelFormat?: string): RatesInput {
  return {
    boxes: plan.boxes.map((box) => {
      const weight = tenthOzToLbOz(box.weightTenthOz ?? 0);
      return {
        boxId: box.box?.id ?? "",
        length: String(box.length),
        width: String(box.width),
        height: String(box.height),
        weightLb: weight.lb,
        weightOz: weight.oz,
        alloc: box.items,
      };
    }),
    residential: stored?.address_residential ?? true,
    signature: plan.signatureKind,
    ...(labelFormat === "zpl" ? { labelFormat: "zpl" } : {}),
  };
}

/**
 * Buys the label for one order of a run, then writes down what happened.
 * Called once per order, one after another. The order is checked again from
 * scratch, the carriers are asked for a fresh quote for its plan, and the
 * plan's service (a rule's or a saved one when offered, else the cheapest)
 * is bought through `purchaseLabel`. Whether the shop is told and the
 * customer emailed follows the workspace's settings.
 */
export async function buyRunOrder(
  slug: string,
  batchId: string,
  orderId: string,
  /** "zpl" when this computer prints straight to a Zebra. */
  labelFormat?: string,
): Promise<RunStep> {
  const ctx = await context(slug);
  if ("error" in ctx) return { status: "skipped", reason: String(ctx.error) };
  if (!UUID.test(batchId) || !UUID.test(orderId)) {
    return { status: "skipped", reason: "We couldn't find that order in this run." };
  }
  // Once per order and run: a second press, a retry or another tab stops here.
  const { data: mine, error: claimError } = await ctx.supabase.rpc("claim_label_batch_order", {
    p_batch_id: batchId,
    p_shipping_order_id: orderId,
  });
  if (claimError || mine !== true) {
    return {
      status: "skipped",
      reason: "This run has already dealt with that order. Nothing more was bought.",
    };
  }
  const outcome = await buyPlanned(ctx, slug, orderId, labelFormat);
  const { error } = await ctx.supabase.rpc("note_label_batch_order", {
    p_batch_id: batchId,
    p_shipping_order_id: orderId,
    p_outcome:
      outcome.status === "bought"
        ? {
            status: "bought",
            service: outcome.service,
            price: outcome.price,
            currency: outcome.currency,
            shipment_number: outcome.number,
          }
        : { status: outcome.status, reason: outcome.reason },
  });
  if (error) console.error("could not note a run's order", error.message);
  revalidatePath(`/w/${slug}/shipping`, "layout");
  return outcome;
}

async function buyPlanned(
  ctx: Ctx,
  slug: string,
  orderId: string,
  labelFormat?: string,
): Promise<RunStep> {
  const [checked] = await assess(ctx, [orderId]);
  if (checked.refusal || !checked.plan || checked.cents === null || !checked.currency) {
    return { status: "skipped", reason: checked.refusal ?? "It has no price yet." };
  }
  const { plan } = checked;
  const input = planInput(plan, checked.stored, labelFormat);
  const core: LabelCtx = ctx;
  const quoted = await quoteRates(core, orderId, input);
  if ("error" in quoted)
    return { status: "skipped", reason: `${quoted.error} Nothing was bought.` };
  const picked = pickService(quoted.rates, plan.service);
  if (!picked) {
    return {
      status: "skipped",
      reason: "No carrier offered a price just now. Nothing was bought.",
    };
  }
  const fresh = priceToCents(picked.rate.price);
  const money = (cents: number, currency: string) => formatMoney(cents / 100, currency);
  if (fresh === null || picked.rate.currency !== checked.currency) {
    return {
      status: "skipped",
      reason: "The price came back in a way we couldn't compare. Open the order to buy it.",
    };
  }
  // What a person saw on the list is what a run may spend, give or take a little.
  if (priceMoved(checked.cents, Number(fresh))) {
    return {
      status: "skipped",
      reason: `The price went from about ${money(checked.cents, checked.currency)} to ${money(Number(fresh), checked.currency)} since the list worked it out. Open the order to check it. Nothing was bought.`,
    };
  }

  const result = await purchaseLabel(core, slug, orderId, picked.rate.id, undefined, [], input);
  if (result.state === "refused") return { status: "skipped", reason: result.error };
  if (result.state === "unsure") return { status: "unsure", reason: result.error };

  // The parcel, for printing its label from the run.
  const { data: parcel } = await ctx.supabase
    .from("shipments")
    .select("id, tracking_number, tracking_url, label_url, label_parcels")
    .eq("tenant_id", ctx.tenant.id)
    .eq("number", result.number)
    .maybeSingle();
  const boxes = parcel
    ? shownBoxes({
        tracking_number: parcel.tracking_number as string | null,
        tracking_url: parcel.tracking_url as string | null,
        label_url: parcel.label_url as string | null,
        boxes: parcel.label_parcels,
      }).filter((box) => box.labelUrl)
    : [];
  return {
    status: "bought",
    service: listService(result.carrier, result.service),
    price: result.price,
    currency: result.currency,
    number: result.number,
    shipmentId: (parcel?.id as string | undefined) ?? undefined,
    labels: boxes.map((box, index) => ({
      href: box.labelUrl as string,
      text: boxes.length > 1 ? `Label ${index + 1}` : "Label",
    })),
  };
}
