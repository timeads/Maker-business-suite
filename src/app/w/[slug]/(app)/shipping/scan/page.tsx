import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { daysFromNow } from "@/lib/bookings/slots";
import { countryName } from "@/lib/shipping/carriers";
import { labelBoxes } from "@/lib/shipping/labels";
import { formatMoney } from "@/lib/dashboard/format";
import { combineOrders, groupHref } from "@/lib/shipping/merge";
import { formatHoldDate, holdState, todayIn } from "@/lib/shipping/queue";
import { pickupTells } from "@/lib/shipping/shop-steps";
import { boughtBoxes, parseSlipCode, slipBoxes, type SlipBox } from "@/lib/shipping/slip-boxes";
import { createClient } from "@/lib/supabase/server";
import {
  ORDER_FIELDS,
  loadBoxes,
  loadGroup,
  loadItemPhotos,
  loadKnownGroup,
  loadLabelConnections,
  loadOpenLabelOrders,
  loadParcelBoxes,
  loadShippingSetup,
  parcelTracking,
  placeOf,
  type ShippingOrder,
} from "../data";
import { shippingAccess } from "../gate";
import { plannedBoxes } from "../slips-data";
import { ShippingTabs } from "../tabs";
import { PackStation, type PackOrder } from "./pack-station";

export const metadata: Metadata = { title: "Scan & pack" };

export default async function ScanPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ code?: string; sent?: string }>;
}) {
  const { slug } = await params;
  const access = await shippingAccess(slug, `/w/${slug}/shipping/scan`);
  if (!access.ok) return access.upsell;
  const { tenant, entitlements } = access;
  const base = `/w/${tenant.slug}/shipping`;
  const query = await searchParams;
  // A slip's code: an order's number, one box of it ("1042/B2"), or several orders going together.
  const read = parseSlipCode(query.code ?? "");
  const code = read?.whole ?? "";
  const justSent = /^\d{1,9}$/.test(query.sent ?? "") ? query.sent : null;

  const supabase = await createClient();
  const find = async (name: string) => {
    const { data } = await supabase
      .from("shipping_orders")
      .select(ORDER_FIELDS)
      .eq("tenant_id", tenant.id)
      // The slip's barcode carries the number without its "#".
      .or(`name.ilike."${name}",name.ilike."#${name}"`)
      .order("cancelled")
      .order("units_left", { ascending: false })
      .limit(1);
    return ((data ?? []) as unknown as ShippingOrder[])[0] ?? null;
  };
  // An order can really be called "1042-B2", so the whole code is looked for
  // first, and only then box 2 of order 1042.
  const lookUp = async (): Promise<{ row: ShippingOrder | null; box: number | null }> => {
    if (!read) return { row: null, box: null };
    if (read.parts.length === 1 && read.whole !== read.base) {
      const exact = await find(read.whole);
      if (exact) return { row: exact, box: null };
    }
    return { row: await find(read.parts[0]), box: read.box };
  };
  const [setup, postage, found, savedBoxes] = await Promise.all([
    loadShippingSetup(supabase, tenant.id),
    loadLabelConnections(supabase, tenant.id),
    lookUp(),
    loadBoxes(supabase, tenant.id),
  ]);
  let row = found.row;
  const today = todayIn(tenant.timezone, new Date(daysFromNow(0)));
  const home = setup.settings.ship_from_country;
  const open = Boolean(row && !row.cancelled && !row.picked_up_at && row.units_left > 0);
  // Saved (or approved) to go out with other orders: the label is bought for them all at once.
  let known = row && open ? await loadKnownGroup(supabase, tenant.id, row.id, today) : null;
  // The one slip for orders going together names them all: that opens the group even before it is saved.
  if (row && open && !known && read && read.parts.length > 1) {
    const others = await Promise.all(read.parts.slice(1).map(find));
    if (others.every((other): other is ShippingOrder => other !== null)) {
      const group = await loadGroup(
        supabase,
        tenant.id,
        [row.id, ...others.map((other) => other.id)],
        today,
      );
      if (group.check.ok) {
        known = {
          ids: group.orders.map((order) => order.id),
          names: group.orders.map((order) => order.name ?? "Order"),
        };
      }
    }
  }
  // Orders going out together are packed as one, as their one slip says: every
  // order's items on the bench, and the label bought on the oldest of them.
  const loaded = row && known ? await loadGroup(supabase, tenant.id, known.ids, today) : null;
  const together = loaded?.check.ok && loaded.orders.length > 1 ? loaded.orders : null;
  const combined = together ? combineOrders(together) : null;
  if (together) row = together[0];
  const waitingWith = together ? known : null;
  const held = row && !row.cancelled && !row.picked_up_at && holdState(row, today) === "held";
  const labelOpen =
    row && open ? (await loadOpenLabelOrders(supabase, tenant.id)).has(row.id) : false;
  // Everything has gone and it wasn't collected: its label is bought.
  const hasLabel = Boolean(
    row && !row.cancelled && !row.picked_up_at && row.units_left <= 0 && !row.pickup,
  );
  const everyItem = combined ? combined.items : (row?.items ?? []);
  const photoOf = await loadItemPhotos(supabase, tenant.id, everyItem);
  const cameFrom = new Map(combined?.items.map((item) => [item.line_id, item.order_name]));
  const lineOf = (item: ShippingOrder["items"][number], left: number) => ({
    line_id: item.line_id,
    title: item.title,
    variant: item.variant,
    sku: item.sku,
    barcode: item.barcode ?? null,
    left,
    image: photoOf(item),
    from: cameFrom.get(item.line_id) ?? null,
    grams: item.grams ?? null,
  });
  const paid = combined ? combined.shipping_paid : (row?.shipping_paid ?? null);

  // An order in several boxes is packed a box at a time: from the boxes its
  // label was bought for, else from the boxes it is planned in.
  const parcels =
    row && !row.cancelled && !waitingWith
      ? await loadParcelBoxes(supabase, tenant.id, { orderId: row.id })
      : [];
  const boughtIn = (parcel: (typeof parcels)[number]) =>
    slipBoxes(boughtBoxes(parcel.box_items, parcelTracking(parcel)));
  const bought = open ? null : (parcels.find((parcel) => boughtIn(parcel).length > 0) ?? null);
  let boxes: SlipBox[] = bought ? boughtIn(bought) : [];
  if (row && open && !waitingWith && !row.pickup) {
    boxes = slipBoxes((await plannedBoxes(supabase, tenant, setup, [row])).get(row.id) ?? []);
  }
  const boxGone =
    row && found.box !== null && boxes.length > 0 && !boxes.some((box) => box.n === found.box)
      ? `${row.name ?? "This order"} doesn't have a box ${found.box} any more: its boxes changed. Print its packing slips again.`
      : null;
  const labels = bought ? labelBoxes(bought.label_parcels) : [];
  const printedBoxes =
    bought?.label_boxes_printed && typeof bought.label_boxes_printed === "object"
      ? Object.keys(bought.label_boxes_printed as Record<string, unknown>).map(Number)
      : [];
  const order: PackOrder | null =
    row && !boxGone
      ? {
          id: row.id,
          name: combined ? combined.name : (row.name ?? "Order"),
          customer: row.recipient ?? "no name",
          place: row.pickup ? "Collecting" : placeOf(row, home, countryName),
          chose: row.shipping_method ?? "",
          paid:
            row.pickup || paid === null || paid === undefined
              ? null
              : Number(paid) === 0
                ? "free shipping"
                : `paid ${formatMoney(Number(paid), tenant.currency)}`,
          paidAmount: paid === null || paid === undefined ? null : Number(paid),
          note: row.note,
          lines:
            row.cancelled || row.picked_up_at
              ? []
              : hasLabel
                ? // Nothing is left to send, but the box can still be checked against its slip.
                  row.items.map((item) => lineOf(item, item.qty))
                : everyItem.map((item) => lineOf(item, item.left)),
          pickup: row.pickup,
          pickupReady: Boolean(row.pickup_ready_at),
          held: held
            ? `On hold${row.hold_until ? ` until ${formatHoldDate(row.hold_until)}` : ""}${row.hold_reason ? `: ${row.hold_reason}` : "."}`
            : null,
          closed: row.cancelled
            ? "This order was cancelled, so there's nothing to pack."
            : row.picked_up_at
              ? "This order has been picked up."
              : null,
          unpaid: together ? together.some((each) => !each.paid) : !row.paid,
          hasLabel,
          labelOpen,
          together: waitingWith
            ? {
                ids: together!.map((each) => each.id),
                names: together!.map((each) => each.name ?? "Order"),
              }
            : null,
          builderHref: waitingWith
            ? groupHref(
                base,
                together!.map((each) => each.id),
              )
            : `${base}/orders/${row.id}`,
          // Every line, whatever is left of it: a box's slip is packed from what went in the box.
          items: row.cancelled ? [] : row.items.map((item) => lineOf(item, item.left)),
          boxes: boxes.map((box) => ({
            n: box.n,
            of: box.of,
            label: box.label,
            name: box.name,
            tracking: box.tracking,
            items: box.items,
          })),
          boxAsked: found.box,
          shipment: bought
            ? {
                id: bought.id,
                links: boxes.map((box) => labels[box.label - 1]?.labelUrl ?? null),
                printed: boxes
                  .filter((box) => printedBoxes.includes(box.label))
                  .map((box) => box.n),
              }
            : null,
          pickupTells: pickupTells({
            wanted: setup.settings.tell_shop_pickups,
            canSend: setup.canSend,
            connected: setup.connected,
          }),
        }
      : null;

  return (
    <>
      <PageHeader
        title="Shipping"
        description="Orders waiting to ship, labels from every carrier, packing slips and the packing station."
      />
      <ShippingTabs slug={tenant.slug} />
      {justSent && !order && (
        <p role="status" className="bg-mint-soft text-mint-ink rounded-md px-4 py-2.5 text-sm">
          Parcel {justSent} recorded. Scan the next slip when you&apos;re ready.{" "}
          <Link href={`${base}/sent`} className="font-semibold underline underline-offset-2">
            See what&apos;s been sent
          </Link>
        </p>
      )}
      <PackStation
        key={order?.id ?? "none"}
        slug={tenant.slug}
        order={order}
        missing={code && !row ? code : null}
        problem={boxGone}
        canWrite={entitlements.canWrite}
        labels={postage.active.length > 0}
        boxes={savedBoxes.map((box) => ({
          id: box.id,
          name: box.name,
          length: String(Number(box.length_in)),
          width: String(Number(box.width_in)),
          height: String(Number(box.height_in)),
        }))}
        parcel={{
          defaultCarrier: setup.settings.default_carrier,
          shopOffered: setup.canSend,
          shopDefault: setup.settings.mark_sent_in_shop,
          notifyDefault: setup.settings.notify_customer,
          currency: tenant.currency,
        }}
      />
    </>
  );
}
