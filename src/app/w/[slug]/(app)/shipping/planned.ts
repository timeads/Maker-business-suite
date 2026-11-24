import { orderRefusal, planRefusal } from "@/lib/shipping/bulk";
import { tenthOzToLbOz } from "@/lib/shipping/easypost";
import { shownBoxes } from "@/lib/shipping/labels";
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
import type { LabelCtx, RatesInput } from "./label-core";

/**
 * Buying an order's planned label without a person laying it out first: a
 * bulk run, or the packing bench once every item is scanned. Server-only,
 * and not a "use server" file. This only decides whether an order may be
 * bought this way and what would be asked of the carriers; the buying itself
 * is always `quoteRates` and `purchaseLabel` in `label-core.ts`.
 */

const GONE = "It isn't waiting to ship any more.";
/** As `LabelCtx`, with the currency the workspace prices in. */
export type PlannedCtx = LabelCtx & { tenant: { id: string; timezone: string; currency: string } };
type Ctx = PlannedCtx;

export type Assessed = {
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
export async function assess(
  ctx: Ctx,
  ids: string[],
  /**
   * A bulk run only buys at a price the list already showed. The packing
   * bench shows the person a fresh price before they press Buy, so it
   * doesn't need the list's.
   */
  needListPrice = true,
): Promise<Assessed[]> {
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
        quote: !needListPrice
          ? "ok"
          : !fresh
            ? "missing"
            : row?.quote_status === "ok"
              ? "ok"
              : "none",
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

/** The rates request for an order's plan: the same shape the order page sends. */
export function planInput(
  plan: OrderPlan,
  stored: StoredPlan | null,
  labelFormat?: string,
): RatesInput {
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

/** A recorded parcel's labels, for printing straight after buying. */
export async function boughtLabels(
  ctx: Ctx,
  number: number,
): Promise<{ shipmentId?: string; labels: { href: string; text: string }[] }> {
  const { data: parcel } = await ctx.supabase
    .from("shipments")
    .select("id, tracking_number, tracking_url, label_url, label_parcels")
    .eq("tenant_id", ctx.tenant.id)
    .eq("number", number)
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
    shipmentId: (parcel?.id as string | undefined) ?? undefined,
    labels: boxes.map((box, index) => ({
      href: box.labelUrl as string,
      text: boxes.length > 1 ? `Label ${index + 1}` : "Label",
    })),
  };
}
