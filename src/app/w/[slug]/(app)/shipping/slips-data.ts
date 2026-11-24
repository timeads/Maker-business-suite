import type { SupabaseClient } from "@supabase/supabase-js";
import { daysFromNow } from "@/lib/bookings/slots";
import { combineOrders, groupKey } from "@/lib/shipping/merge";
import { choiceOf, planFor } from "@/lib/shipping/plan";
import { inQueueView, todayIn } from "@/lib/shipping/queue";
import {
  boughtBoxes,
  groupSlipCode,
  sizeName,
  slipBoxes,
  type BoxContents,
  type SlipBox,
} from "@/lib/shipping/slip-boxes";
import { buildSlipData, type SlipData } from "@/lib/shipping/zebra/slip";
import {
  ORDER_FIELDS,
  loadBoxes,
  loadGroup,
  loadGroups,
  loadLabelConnections,
  loadPackingMemory,
  loadParcelBoxes,
  loadPlans,
  loadShippingSetup,
  parcelTracking,
  planSetupOf,
  withOrderTotal,
  type ShippingOrder,
} from "./data";

/**
 * Which packing slips a press asks for, worked out once so the slips page,
 * a button that sends them straight to a Zebra, and the "already printed"
 * question all mean the same slips. Server-only, and not a "use server" file.
 */

const UUID = /^[0-9a-f-]{36}$/i;

/** What was asked for, as it arrives from a link or a button. Nothing here is trusted but ids. */
export type SlipSelection = {
  /** One order. */
  order?: string;
  /** The orders ticked in the queue, as "id,id". */
  ids?: string;
  /** Orders going out together, on one slip, as "id,id". */
  together?: string;
  /** With nothing chosen: every ready order, printed or not. */
  all?: string;
  /** One parcel with a bought label: a slip for each of its boxes, with their tracking numbers. */
  parcel?: string;
};

export type SlipTenant = {
  id: string;
  name: string;
  timezone: string;
  currency: string;
};

/** One slip to draw. */
export type SlipEntry = {
  key: string;
  /** The order it is drawn from (several orders' lines on one, when they go together). */
  order: ShippingOrder;
  /** What the barcode says, when it isn't the order's own number. */
  code?: string;
  /** For orders sent together: which order each line came from, by line id. */
  from?: ReadonlyMap<string, string>;
  /** One box of an order going out in several: the slip lists only what is in it. */
  box?: SlipBox;
  /** On a slip for the whole order: the boxes it is planned in, by name. */
  boxNames?: string[];
  /** The orders this slip stands for: what is marked printed when it prints. */
  orderIds: string[];
  /** "#1042", or "#1042 + #1055" for orders going together. */
  name: string;
};

export type SlipRun = {
  setup: Awaited<ReturnType<typeof loadShippingSetup>>;
  entries: SlipEntry[];
  /** The orders the slips are for. */
  shown: ShippingOrder[];
  /** Every order that could have had one (with nothing chosen: all that are ready). */
  ready: ShippingOrder[];
  /** A person picked these orders, rather than "whatever is ready". */
  chosen: boolean;
  one: boolean;
  ticked: number;
  /** The name of the group, when the run is one slip for orders going together. */
  together: string | null;
  /** The run is one parcel that already has its label: "Parcel 12". */
  parcel: string | null;
  /** How many of the shown orders are split into a slip per box. */
  split: number;
};

type Setup = Awaited<ReturnType<typeof loadShippingSetup>>;

/**
 * The boxes each order is planned to go in, with what goes in each: the same
 * plan the To ship list and the order page work from (a saved choice, a
 * rule's box, packing memory, the usual box). Allowed to fail: an order
 * without a plan simply has one slip.
 */
export async function plannedBoxes(
  supabase: SupabaseClient,
  tenant: SlipTenant,
  shipping: Setup,
  orders: ShippingOrder[],
): Promise<Map<string, BoxContents[]>> {
  const planned = new Map<string, BoxContents[]>();
  if (orders.length === 0) return planned;
  try {
    const ids = orders.map((order) => order.id);
    const totals = new Map<string, number | null>();
    for (let from = 0; from < ids.length; from += 100) {
      const { data } = await supabase
        .from("shipping_orders")
        .select("id, sale:orders(total)")
        .eq("tenant_id", tenant.id)
        .in("id", ids.slice(from, from + 100));
      for (const row of (data ?? []) as unknown as { id: string }[]) {
        totals.set(row.id, withOrderTotal(row).order_total);
      }
    }
    const [boxes, postage, stored, memory] = await Promise.all([
      loadBoxes(supabase, tenant.id),
      loadLabelConnections(supabase, tenant.id),
      loadPlans(supabase, tenant.id, ids),
      loadPackingMemory(supabase, tenant.id, orders),
    ]);
    const setup = planSetupOf({ shipping, boxes, postage, memory }, tenant.currency);
    for (const order of orders) {
      const total = totals.get(order.id) ?? null;
      const plan = planFor(order, choiceOf(stored.get(order.id)), total, setup);
      planned.set(
        order.id,
        plan.boxes.map((box) => ({
          name: box.box?.name ?? sizeName(box),
          tracking: null,
          items: box.items,
        })),
      );
    }
  } catch (err) {
    console.error("could not plan boxes for slips", err instanceof Error ? err.message : err);
  }
  return planned;
}

/** A parcel that already has its label: a slip for each box, listing what went in it. */
async function parcelRun(
  supabase: SupabaseClient,
  tenant: SlipTenant,
  shipmentId: string,
): Promise<SlipRun> {
  const [[parcel], setup] = await Promise.all([
    loadParcelBoxes(supabase, tenant.id, { shipmentId }),
    loadShippingSetup(supabase, tenant.id),
  ]);
  const empty: SlipRun = {
    setup,
    entries: [],
    shown: [],
    ready: [],
    chosen: true,
    one: false,
    ticked: 0,
    together: null,
    parcel: null,
    split: 0,
  };
  if (!parcel?.shipping_order_id) return empty;
  const { data } = await supabase
    .from("shipping_orders")
    .select(ORDER_FIELDS)
    .eq("tenant_id", tenant.id)
    .eq("id", parcel.shipping_order_id)
    .maybeSingle();
  const stored = data as unknown as ShippingOrder | null;
  if (!stored) return empty;
  // The parcel's own lines say what went in it: nothing is left on the order by now.
  const went = new Map<string, number>();
  for (const item of Array.isArray(parcel.items) ? (parcel.items as unknown[]) : []) {
    const line = item as { line_id?: unknown; qty?: unknown };
    if (typeof line?.line_id === "string" && typeof line.qty === "number" && line.qty > 0) {
      went.set(line.line_id, line.qty);
    }
  }
  const order: ShippingOrder = {
    ...stored,
    items: stored.items
      .filter((item) => went.has(item.line_id))
      .map((item) => ({ ...item, qty: went.get(item.line_id)!, left: went.get(item.line_id)! })),
  };
  const boxes = slipBoxes(boughtBoxes(parcel.box_items, parcelTracking(parcel)));
  const name = order.name ?? "Order";
  return {
    ...empty,
    shown: [order],
    ready: [order],
    parcel: `Parcel ${parcel.number}`,
    split: boxes.length > 0 ? 1 : 0,
    entries:
      boxes.length > 0
        ? boxes.map((box) => ({
            key: `${parcel.id}:${box.n}`,
            order,
            box,
            // Already sent: printing these again changes nothing about what is waiting.
            orderIds: [],
            name: `${name} (box ${box.n} of ${box.of})`,
          }))
        : [{ key: parcel.id, order, orderIds: [], name }],
  };
}

const idList = (value: string | undefined, most: number) =>
  [
    ...new Set(
      (value ?? "")
        .toLowerCase()
        .split(",")
        .filter((id) => UUID.test(id)),
    ),
  ].slice(0, most);

export async function loadSlipRun(
  supabase: SupabaseClient,
  tenant: SlipTenant,
  query: SlipSelection,
): Promise<SlipRun> {
  if (UUID.test(query.parcel ?? "")) return parcelRun(supabase, tenant, query.parcel!);
  const one = UUID.test(query.order ?? "") ? query.order! : null;
  // The orders ticked in the queue.
  const ticked = one ? [] : idList(query.ids, 150);
  const today = todayIn(tenant.timezone, new Date(daysFromNow(0)));
  // Orders going out together share one slip: asked for from their page, or
  // ticked in the queue after someone saved them (or said they're one place).
  const asked = idList(query.together, 10);
  let together: ShippingOrder[] | null = null;
  if (!one && (asked.length >= 2 || ticked.length >= 2)) {
    const ids = asked.length >= 2 ? asked : ticked;
    const known =
      asked.length >= 2 ||
      (ids.length <= 10 &&
        (await loadGroups(supabase, tenant.id)).some(
          (group) =>
            (group.saved_at || group.approved_at) && groupKey(group.order_ids) === groupKey(ids),
        ));
    if (known) {
      const loaded = await loadGroup(supabase, tenant.id, ids, today);
      // Can't go together after all (one went on hold, say): each gets its own slip.
      if (loaded.check.ok) together = loaded.orders;
    }
  }
  if (!one && ticked.length === 0 && asked.length > 0 && !together) ticked.push(...asked);
  const chosen = Boolean(one) || ticked.length > 0 || Boolean(together);

  let request = supabase
    .from("shipping_orders")
    .select(ORDER_FIELDS)
    .eq("tenant_id", tenant.id)
    .gt("units_left", 0)
    .eq("cancelled", false)
    .order("placed_at")
    .limit(200);
  if (one) request = request.eq("id", one);
  else if (together)
    request = request.in(
      "id",
      together.map((order) => order.id),
    );
  else if (ticked.length > 0) request = request.in("id", ticked);
  const [{ data }, setup] = await Promise.all([request, loadShippingSetup(supabase, tenant.id)]);
  const combined = together ? combineOrders(together) : null;
  const ready = ((data ?? []) as unknown as ShippingOrder[]).filter(
    (order) => chosen || inQueueView(order, "ready", today, setup.settings.ship_from_country),
  );
  const fresh = ready.filter((order) => !order.slip_printed_at);
  // By default only what hasn't been printed yet, so a second run doesn't repeat the first.
  const shown = chosen || query.all === "1" || fresh.length === 0 ? ready : fresh;

  // An order planned in several boxes gets a slip for each, listing just that box's items.
  const planned =
    shown.length > 0 && !(combined && together)
      ? await plannedBoxes(supabase, tenant, setup, shown)
      : new Map<string, BoxContents[]>();
  let split = 0;
  const entries: SlipEntry[] =
    shown.length === 0
      ? []
      : combined && together
        ? [
            {
              key: together.map((order) => order.id).join("+"),
              order: {
                ...together[0],
                name: combined.name,
                items: combined.items,
                units_left: combined.units_left,
              },
              // Every order's number, which opens the group at the bench; when that is too
              // long for a barcode, the first order's own, which leads to the group.
              code: groupSlipCode(
                combined.order_ids.map(
                  (id) => together.find((order) => order.id === id)?.name ?? null,
                ),
              ),
              from: new Map(combined.items.map((item) => [item.line_id, item.order_name])),
              orderIds: shown.map((order) => order.id),
              name: combined.name,
            },
          ]
        : shown.flatMap((order): SlipEntry[] => {
            const name = order.name ?? "Order";
            const plan = planned.get(order.id) ?? [];
            const boxes = slipBoxes(plan);
            if (boxes.length > 0) {
              split += 1;
              return boxes.map((box) => ({
                key: `${order.id}:${box.n}`,
                order,
                box,
                orderIds: [order.id],
                name: `${name} (box ${box.n} of ${box.of})`,
              }));
            }
            return [
              {
                key: order.id,
                order,
                boxNames: plan.map((box) => box.name ?? "Custom size"),
                orderIds: [order.id],
                name,
              },
            ];
          });

  return {
    setup,
    entries,
    shown,
    ready,
    chosen,
    one: Boolean(one),
    ticked: ticked.length,
    together: combined && together && shown.length > 0 ? combined.name : null,
    parcel: null,
    split,
  };
}

/** A slip as plain words, for a computer that sends it to its Zebra. */
export const slipWords = (run: SlipRun, tenant: SlipTenant, entry: SlipEntry): SlipData =>
  buildSlipData({
    settings: run.setup.settings,
    layout: run.setup.slip,
    workspaceName: tenant.name,
    timeZone: tenant.timezone,
    currency: tenant.currency,
    order: entry.order,
    code: entry.code,
    from: entry.from,
    box: entry.box,
    boxNames: entry.boxNames,
  });

/** One slip, ready for the browser to turn into the printer's own commands. */
export type SlipToPrint = {
  key: string;
  name: string;
  orderIds: string[];
  data: SlipData;
};

/** An order whose slip has been printed before, and when, in the workspace's own time. */
export type SlipPrinted = { id: string; name: string; when: string };

export function slipsToPrint(
  run: SlipRun,
  tenant: SlipTenant,
): { slips: SlipToPrint[]; printed: SlipPrinted[] } {
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return {
    slips: run.entries.map((entry) => ({
      key: entry.key,
      name: entry.name,
      orderIds: entry.orderIds,
      data: slipWords(run, tenant, entry),
    })),
    printed: run.shown
      .filter((order) => order.slip_printed_at)
      .map((order) => ({
        id: order.id,
        name: order.name ?? "Order",
        when: when.format(new Date(order.slip_printed_at!)),
      })),
  };
}
