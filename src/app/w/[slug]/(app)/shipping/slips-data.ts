import type { SupabaseClient } from "@supabase/supabase-js";
import { daysFromNow } from "@/lib/bookings/slots";
import { combineOrders, groupKey } from "@/lib/shipping/merge";
import { inQueueView, todayIn } from "@/lib/shipping/queue";
import { buildSlipData, type SlipData } from "@/lib/shipping/zebra/slip";
import { ORDER_FIELDS, loadGroup, loadGroups, loadShippingSetup, type ShippingOrder } from "./data";

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
};

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
              // The first order's own number: scanning it opens that order, which leads to the group.
              code: together[0].name ?? "",
              from: new Map(combined.items.map((item) => [item.line_id, item.order_name])),
              orderIds: shown.map((order) => order.id),
              name: combined.name,
            },
          ]
        : shown.map((order) => ({
            key: order.id,
            order,
            orderIds: [order.id],
            name: order.name ?? "Order",
          }));

  return {
    setup,
    entries,
    shown,
    ready,
    chosen,
    one: Boolean(one),
    ticked: ticked.length,
    together: combined && together && shown.length > 0 ? combined.name : null,
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
