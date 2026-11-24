"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { formatMoney } from "@/lib/dashboard/format";
import { getEntitlements } from "@/lib/entitlements";
import { bulkEstimate, priceMoved, type BulkOutcome } from "@/lib/shipping/bulk";
import { priceToCents } from "@/lib/shipping/easypost";
import { listService } from "@/lib/shipping/list";
import { pickService } from "@/lib/shipping/rules";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";
import { purchaseLabel, quoteRates, type LabelCtx } from "./label-core";
import { assess, boughtLabels, planInput } from "./planned";

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

  const printable = await boughtLabels(ctx, result.number);
  return {
    status: "bought",
    service: listService(result.carrier, result.service),
    price: result.price,
    currency: result.currency,
    number: result.number,
    shipmentId: printable.shipmentId,
    labels: printable.labels,
  };
}
