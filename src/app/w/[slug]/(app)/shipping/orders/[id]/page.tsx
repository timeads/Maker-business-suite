import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { daysFromNow } from "@/lib/bookings/slots";
import { formatMoney } from "@/lib/dashboard/format";
import { addressLines, hasAddress } from "@/lib/shipping/carriers";
import { gramsToTenthOz } from "@/lib/shipping/easypost";
import {
  boxSize,
  boxTenthOz,
  missingShipFrom,
  shipToEdit,
  shownBoxes,
  signatureByRule,
} from "@/lib/shipping/labels";
import {
  formatHoldDate,
  formatWeight,
  holdChoices,
  holdState,
  inQueueView,
  isInternational,
  isPriority,
  isQueueView,
  QUEUE_VIEWS,
  queuePlace,
  todayIn,
  type QueueView,
} from "@/lib/shipping/queue";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import {
  ORDER_FIELDS,
  loadBoxes,
  loadLabelConnection,
  loadQueueSteps,
  loadShippingSetup,
  loadUnfinishedLabels,
  type ShippingOrder,
} from "../../data";
import { HoldForm, ParcelForm, PickupForm, SeenBackFromHold, VoidButton } from "../../forms";
import { shippingAccess } from "../../gate";
import { FinishLabelButton } from "../../label-card";
import { LabelDesk } from "../../label-desk";
import { OrderSteps } from "../../order-steps";

type Sale = {
  net_sales: number | string;
  total_tax: number | string;
  total_shipping: number | string;
  total: number | string;
};

const INTERNATIONAL_NOTE =
  "International labels need a customs form, which isn't built yet. Buy this one elsewhere and record it below.";

export const metadata: Metadata = { title: "Send an order" };

export default async function ShippingOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<{ label?: string; view?: string }>;
}) {
  const { slug, id } = await params;
  const query = await searchParams;
  const justBought = Number.parseInt(query.label ?? "", 10);
  const view: QueueView = isQueueView(query.view) ? query.view : "ready";
  const access = await shippingAccess(slug, `/w/${slug}/shipping/orders/${id}`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await createClient();
  const [{ data }, setup, { data: parcels }, boxes, easypost, unfinished, steps, { data: shop }] =
    await Promise.all([
      supabase
        .from("shipping_orders")
        .select(
          `${ORDER_FIELDS}, external_id, provider, sale:orders(net_sales, total_tax, total_shipping, total)`,
        )
        .eq("tenant_id", tenant.id)
        .eq("id", id)
        .maybeSingle(),
      loadShippingSetup(supabase, tenant.id),
      supabase
        .from("shipments")
        .select(
          "id, number, carrier, service, tracking_number, tracking_url, shipped_at, items, voided_at, label_provider, label_url, label_mode, label_parcels",
        )
        .eq("tenant_id", tenant.id)
        .eq("shipping_order_id", id)
        .order("number"),
      loadBoxes(supabase, tenant.id),
      loadLabelConnection(supabase, tenant.id),
      loadUnfinishedLabels(supabase, tenant.id, id),
      loadQueueSteps(supabase, tenant.id),
      supabase
        .from("connections")
        .select("external_account_id")
        .eq("tenant_id", tenant.id)
        .eq("provider", "shopify")
        .maybeSingle(),
    ]);
  const order = data as unknown as
    | (ShippingOrder & { sale?: Sale | Sale[] | null; external_id?: string; provider?: string })
    | null;
  if (!order) notFound();
  const sale = (Array.isArray(order.sale) ? order.sale[0] : order.sale) ?? null;
  // Each item's photo, where the shop sync has noted one: by item code, else by name.
  const titles = [...new Set(order.items.map((item) => item.title).filter(Boolean))];
  const { data: pictured } = titles.length
    ? await supabase
        .from("stock_items")
        .select("title, variant_title, sku, image_url")
        .eq("tenant_id", tenant.id)
        .in("title", titles.slice(0, 200))
        .not("image_url", "is", null)
        .limit(1000)
    : { data: [] };
  const photos = new Map<string, string>();
  for (const row of (pictured ?? []) as {
    title: string;
    variant_title: string | null;
    sku: string | null;
    image_url: string;
  }[]) {
    if (row.sku) photos.set(`sku:${row.sku}`, row.image_url);
    photos.set(`name:${row.title}|${row.variant_title ?? ""}`, row.image_url);
    if (!photos.has(`name:${row.title}`)) photos.set(`name:${row.title}`, row.image_url);
  }
  const photoOf = (item: ShippingOrder["items"][number]) =>
    (item.sku ? photos.get(`sku:${item.sku}`) : undefined) ??
    photos.get(`name:${item.title}|${item.variant ?? ""}`) ??
    photos.get(`name:${item.title}`);
  const today = todayIn(tenant.timezone, new Date(daysFromNow(0)));
  const left = order.items.filter((item) => item.left > 0);
  const pickedUp = Boolean(order.picked_up_at);
  const todo = left.length > 0 && !order.cancelled && !pickedUp;
  const hold = todo ? holdState(order, today) : "none";
  const home = setup.settings.ship_from_country;
  const parcelForm = (quiet: boolean) => (
    <ParcelForm
      slug={tenant.slug}
      orderId={order.id}
      lines={left}
      defaultCarrier={setup.settings.default_carrier}
      shopOffered={setup.canSend}
      shopDefault={setup.settings.mark_sent_in_shop}
      notifyDefault={setup.settings.notify_customer}
      currency={tenant.currency}
      quiet={quiet}
    />
  );
  const chose = [
    order.shipping_method ? `chose ${order.shipping_method}` : null,
    order.shipping_paid === null
      ? null
      : Number(order.shipping_paid) === 0
        ? "free shipping"
        : `paid ${formatMoney(Number(order.shipping_paid), tenant.currency)} for shipping`,
    formatWeight(order.weight_grams, home === "US") || null,
  ].filter(Boolean);
  const base = `/w/${tenant.slug}/shipping`;
  // Up and down walk the list the person came from, oldest first, like the queue itself.
  const place = queuePlace(
    steps.filter((step) => inQueueView(step, view, today, home)),
    order,
  );
  const carry = view === "ready" ? "" : `?view=${view}`;
  const stepTo = (orderId: string | null) => (orderId ? `${base}/orders/${orderId}${carry}` : null);
  const listName = QUEUE_VIEWS.find((item) => item.key === view)?.label ?? "the list";
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    dateStyle: "medium",
    timeStyle: "short",
  });
  const sent = (parcels ?? []).filter((parcel) => !parcel.voided_at);
  const manager = canManage(role) && entitlements.canWrite;
  const fresh = sent.find((parcel) => parcel.number === justBought && parcel.label_url);
  // Every box of a parcel: one for most, several when the order went in more than one.
  const boxesOf = (parcel: (typeof sent)[number]) =>
    shownBoxes({
      tracking_number: parcel.tracking_number as string | null,
      tracking_url: parcel.tracking_url as string | null,
      label_url: parcel.label_url as string | null,
      boxes: parcel.label_parcels,
    });
  const freshBoxes = fresh ? boxesOf(fresh) : [];
  const freshLabels = freshBoxes.filter((box) => box.labelUrl);
  const linkClass = "text-ochre-text font-medium hover:underline";

  // Buying a label here: EasyPost is connected and this is a parcel to post.
  const posting = todo && entitlements.canWrite && !order.pickup;
  const abroad = isInternational(order.country_code, home);
  const fromGaps = missingShipFrom(setup.settings);
  const labelCard: "builder" | "reconnect" | "abroad" | "unfinished" | null =
    !posting || easypost.status === "none" || easypost.status === "disconnected"
      ? null
      : unfinished.length > 0
        ? "unfinished"
        : easypost.status === "needs_reconnect"
          ? "reconnect"
          : abroad
            ? "abroad"
            : "builder";
  const desk = labelCard === "builder";
  // The order's own page in the shop's admin, when both halves of its address are plain.
  const shopHandle = /^([a-z0-9][a-z0-9-]*)\.myshopify\.com$/.exec(
    String((shop as { external_account_id?: string } | null)?.external_account_id ?? ""),
  )?.[1];
  const shopOrderId = /(\d+)$/.exec(order.external_id ?? "")?.[1];
  const shopLink =
    order.provider === "shopify" && shopHandle && shopOrderId
      ? `https://admin.shopify.com/store/${shopHandle}/orders/${shopOrderId}`
      : null;
  const money = (value: number | string) => formatMoney(Number(value), tenant.currency);
  const paidWords =
    order.shipping_paid === null
      ? "Not known"
      : Number(order.shipping_paid) === 0
        ? "Free shipping"
        : money(order.shipping_paid);
  const over = setup.settings.signature_over;
  const rule =
    over !== null && signatureByRule(sale ? Number(sale.total) : null, over)
      ? `a signature is asked for on orders of ${money(over)} or more.`
      : null;
  const itemsList = (
    <ul className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
      {order.items.map((item) => {
        const photo = photoOf(item);
        return (
          <li key={item.line_id} className="flex items-center gap-3 text-sm">
            {photo ? (
              // eslint-disable-next-line @next/next/no-img-element -- the shop's own picture of the product, on the shop's image servers
              <img
                src={photo}
                alt=""
                loading="lazy"
                className="border-border size-11 shrink-0 rounded-md border object-cover"
              />
            ) : (
              <span className="bg-sunken size-11 shrink-0 rounded-md" aria-hidden />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">{item.title}</span>
              <span className="text-muted-foreground block truncate text-xs">
                {[item.variant, item.sku].filter(Boolean).join(" · ") || "No item code"}
              </span>
            </span>
            <span className="text-right tabular-nums">
              <span className="text-ochre-text block text-xs font-semibold">
                {item.left < item.qty ? `${item.left} of ${item.qty} left` : `× ${item.qty}`}
              </span>
              {item.price !== null && item.price !== undefined && (
                <span className="text-muted-foreground block text-xs">
                  {money(Number(item.price) * item.qty)}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
  const summaryRow =
    "border-border flex items-baseline justify-between gap-4 border-b py-2 last:border-b-0";

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={`${base}${carry}`} className="text-muted-foreground text-sm hover:underline">
          ← {listName}
        </Link>
        <OrderSteps
          position={place.position}
          total={place.total}
          prev={stepTo(place.prev)}
          next={stepTo(place.next)}
          close={`${base}${carry}`}
          listName={listName}
        />
      </div>
      <PageHeader
        title={`${order.name ?? "Order"} · ${order.recipient ?? "no name"}`}
        description={[
          `Ordered ${when.format(new Date(order.placed_at))}`,
          `${order.items.reduce((sum, item) => sum + item.qty, 0)} items`,
          ...chose,
        ].join(" · ")}
      >
        {order.cancelled && <Badge tone="bad">Cancelled</Badge>}
        {pickedUp && !order.cancelled && <Badge tone="good">Picked up</Badge>}
        {left.length === 0 && !order.cancelled && !pickedUp && <Badge tone="good">All sent</Badge>}
        {hold === "held" && (
          <Badge tone="bad">
            {order.hold_until ? `Hold · until ${formatHoldDate(order.hold_until)}` : "On hold"}
          </Badge>
        )}
        {hold === "back" && <Badge tone="good">Back from hold</Badge>}
        {todo && !order.paid && <Badge tone="waiting">Payment pending</Badge>}
        {todo && order.pickup && (
          <Badge tone={order.pickup_ready_at ? "good" : "open"}>
            {order.pickup_ready_at ? "Ready for pickup" : "Pickup"}
          </Badge>
        )}
        {todo && !order.pickup && isPriority(order.shipping_method) && (
          <Badge tone="waiting">Priority</Badge>
        )}
        {todo && !order.pickup && isInternational(order.country_code, home) && (
          <Badge>International</Badge>
        )}
      </PageHeader>
      {hold === "back" && entitlements.canWrite && (
        <SeenBackFromHold slug={tenant.slug} orderId={order.id} />
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex min-w-0 flex-col gap-6">
          {fresh && (
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle>Your label is ready</CardTitle>
                  {fresh.label_mode === "test" && (
                    <Badge tone="waiting">Test mode: this label is not real</Badge>
                  )}
                </div>
                <CardDescription>
                  Parcel {fresh.number} · {fresh.carrier}
                  {fresh.service ? ` ${fresh.service}` : ""} ·{" "}
                  {freshBoxes.length > 1
                    ? `${freshBoxes.length} boxes · tracking numbers `
                    : "tracking number "}
                  {freshBoxes
                    .map((box) => box.trackingNumber)
                    .filter(Boolean)
                    .join(", ") || "not given"}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Button asChild>
                  <a
                    href={(freshLabels[0]?.labelUrl ?? fresh.label_url) as string}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {freshLabels.length > 1 ? "Print label 1" : "Print label"}
                  </a>
                </Button>
                {freshLabels.slice(1).map((box, index) => (
                  <a
                    key={box.labelUrl}
                    href={box.labelUrl as string}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`${linkClass} text-sm`}
                  >
                    Print label {index + 2}
                  </a>
                ))}
                {freshLabels.length > 1 && (
                  <p className="text-muted-foreground w-full text-xs">
                    One label for each box. Print them all before you move on.
                  </p>
                )}
              </CardContent>
            </Card>
          )}
          {unfinished.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Labels to finish</CardTitle>
                <CardDescription>
                  Something interrupted these after you pressed Buy. Finish them here rather than
                  buying again.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-4 text-sm">
                  {unfinished.map((label) => {
                    const boxes = shownBoxes({ ...label, boxes: label.parcels });
                    const printable = boxes.filter((box) => box.labelUrl);
                    return (
                      <li key={label.id} className="flex flex-col gap-2">
                        {label.status === "bought" ? (
                          <p>
                            <span className="font-semibold">Bought, not recorded yet</span> ·{" "}
                            {[label.carrier, label.service].filter(Boolean).join(" ")} ·{" "}
                            {boxes.length > 1
                              ? `${boxes.length} boxes · tracking numbers `
                              : "tracking number "}
                            {boxes
                              .map((box) => box.trackingNumber)
                              .filter(Boolean)
                              .join(", ") || "not given"}
                            {label.label_mode === "test" ? " · test label" : ""}
                            {printable.map((box, index) => (
                              <span key={box.labelUrl}>
                                {" · "}
                                <a
                                  href={box.labelUrl as string}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className={linkClass}
                                >
                                  {printable.length > 1
                                    ? `Print label ${index + 1}`
                                    : "Print label"}
                                </a>
                              </span>
                            ))}
                          </p>
                        ) : (
                          <p>
                            <span className="font-semibold">We never heard back from EasyPost</span>
                            {label.buying_at ? ` (${when.format(new Date(label.buying_at))})` : ""}
                            {label.box_count > 1 ? `, for ${label.box_count} boxes` : ""}. It may or
                            may not have been bought; checking will settle it.
                          </p>
                        )}
                        {entitlements.canWrite && (
                          <FinishLabelButton
                            slug={tenant.slug}
                            quoteId={label.id}
                            unsure={label.status === "buying"}
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          )}
          {order.pickup && !order.cancelled && (left.length > 0 || pickedUp) ? (
            <Card>
              <CardHeader>
                <CardTitle>In-store pickup</CardTitle>
                <CardDescription>
                  {pickedUp
                    ? `Collected ${when.format(new Date(order.picked_up_at!))}. If your shop still shows it as unfulfilled, mark it there too.`
                    : order.pickup_ready_at
                      ? `Packed and waiting since ${when.format(new Date(order.pickup_ready_at))}. When they come by, mark it picked up.`
                      : "Nothing to post. Pack it, then mark it ready so the team knows it's waiting at the counter."}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <ul className="font-read flex flex-col gap-1 text-sm">
                  {left.map((item) => (
                    <li key={item.line_id}>
                      <span className="font-semibold tabular-nums">{item.left} ×</span> {item.title}
                      {item.variant ? ` (${item.variant})` : ""}
                    </li>
                  ))}
                </ul>
                {entitlements.canWrite && (
                  <PickupForm
                    slug={tenant.slug}
                    orderId={order.id}
                    ready={Boolean(order.pickup_ready_at)}
                    pickedUp={pickedUp}
                    canUndo={canManage(role)}
                  />
                )}
                {todo && entitlements.canWrite && (
                  <details className="border-border border-t pt-3 text-sm">
                    <summary className="text-muted-foreground cursor-pointer">
                      Posting it after all? Record a parcel instead
                    </summary>
                    <div className="pt-4">{parcelForm(true)}</div>
                  </details>
                )}
              </CardContent>
            </Card>
          ) : todo && entitlements.canWrite ? (
            <>
              {desk && (
                <LabelDesk
                  key={order.id}
                  slug={tenant.slug}
                  orderId={order.id}
                  shipTo={shipToEdit(order)}
                  country={(order.country_code || home).toUpperCase()}
                  boxes={boxes.map((box) => ({
                    id: box.id,
                    name: box.name,
                    size: boxSize(box),
                    emptyTenthOz: boxTenthOz(box),
                    length: String(Number(box.length_in)),
                    width: String(Number(box.width_in)),
                    height: String(Number(box.height_in)),
                  }))}
                  contentsTenthOz={
                    order.weight_grams ? gramsToTenthOz(Number(order.weight_grams)) : null
                  }
                  paid={{
                    cents:
                      order.shipping_paid === null
                        ? null
                        : Math.round(Number(order.shipping_paid) * 100),
                    words: paidWords,
                    method: order.shipping_method,
                  }}
                  rule={rule}
                  shop={{
                    offered: setup.canSend,
                    markSent: setup.settings.mark_sent_in_shop,
                    notify: setup.settings.notify_customer,
                  }}
                  testMode={easypost.testMode}
                  setup={
                    fromGaps.length > 0
                      ? {
                          missing: `your ship-from address needs ${fromGaps.join(", ")}.`,
                          href: manager ? `${base}/settings` : null,
                        }
                      : null
                  }
                >
                  {itemsList}
                </LabelDesk>
              )}
              {labelCard && labelCard !== "unfinished" && !desk && (
                <Card>
                  <CardHeader>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <CardTitle>Buy a label</CardTitle>
                      {easypost.testMode && (
                        <Badge tone="waiting">Test mode: labels are not real</Badge>
                      )}
                    </div>
                    <CardDescription>Postage is paid from your EasyPost account.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {labelCard === "abroad" && <p className="text-sm">{INTERNATIONAL_NOTE}</p>}
                    {labelCard === "reconnect" && (
                      <p className="text-sm">
                        EasyPost stopped accepting the saved key, so labels can&apos;t be bought
                        right now.{" "}
                        {manager ? (
                          <Link
                            href={`/w/${tenant.slug}/connections`}
                            className="text-ochre-text font-medium hover:underline"
                          >
                            Reconnect EasyPost
                          </Link>
                        ) : (
                          "Ask an owner or admin to reconnect it."
                        )}
                      </p>
                    )}
                  </CardContent>
                </Card>
              )}
              {desk ? (
                <details className="bg-card border-border rounded-xl border px-5 py-4 text-sm">
                  <summary className="cursor-pointer font-semibold">
                    Bought the postage somewhere else, or sending part of this order?
                  </summary>
                  <p className="text-muted-foreground pt-2">
                    Record the parcel by hand: put the tracking number here, and lower a number to
                    send part now.
                  </p>
                  <div className="pt-4">{parcelForm(true)}</div>
                </details>
              ) : (
                <Card>
                  <CardHeader>
                    <CardTitle>Record the parcel</CardTitle>
                    <CardDescription>
                      Buy the postage wherever you usually do, then put the tracking number here.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>{parcelForm(false)}</CardContent>
                </Card>
              )}
            </>
          ) : (
            <Card>
              <CardContent className="pt-5">
                <p className="text-sm">
                  {order.cancelled
                    ? "This order was cancelled, so there's nothing to send."
                    : left.length === 0
                      ? "Everything on this order has been sent."
                      : "This workspace is read-only right now, so parcels can't be recorded."}
                </p>
              </CardContent>
            </Card>
          )}

          {!desk && (
            <Card>
              <CardHeader>
                <CardTitle>Items</CardTitle>
              </CardHeader>
              <CardContent>{itemsList}</CardContent>
            </Card>
          )}

          {sent.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Already sent</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-3 text-sm">
                  {sent.map((parcel) => {
                    const boxes = boxesOf(parcel);
                    const tracked = boxes.filter((box) => box.trackingNumber);
                    const printable = boxes.filter((box) => box.labelUrl);
                    return (
                      <li key={parcel.id}>
                        <span className="font-semibold">Parcel {parcel.number}</span> ·{" "}
                        {parcel.carrier}
                        {parcel.service ? ` ${parcel.service}` : ""} ·{" "}
                        {boxes.length > 1 ? `${boxes.length} boxes · ` : ""}
                        {tracked.length === 0
                          ? "no tracking"
                          : tracked.map((box, index) => (
                              <span key={`${box.trackingNumber}-${index}`}>
                                {index > 0 ? ", " : ""}
                                {box.trackingUrl ? (
                                  <a
                                    href={box.trackingUrl}
                                    className={linkClass}
                                    rel="noreferrer"
                                    target="_blank"
                                  >
                                    {box.trackingNumber}
                                  </a>
                                ) : (
                                  box.trackingNumber
                                )}
                              </span>
                            ))}
                        <span className="text-muted-foreground block text-xs">
                          {when.format(new Date(parcel.shipped_at as string))} ·{" "}
                          <span className="font-read">
                            {(parcel.items as { title: string; qty: number }[])
                              .map((item) => `${item.qty} × ${item.title}`)
                              .join(", ")}
                          </span>
                        </span>
                        {parcel.label_provider && (
                          <span className="mt-1 flex flex-wrap items-center gap-2">
                            {parcel.label_mode === "test" && (
                              <Badge tone="waiting">Test label</Badge>
                            )}
                            {printable.map((box, index) => (
                              <a
                                key={box.labelUrl}
                                href={box.labelUrl as string}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={linkClass}
                              >
                                {printable.length > 1 ? `Print label ${index + 1}` : "Print label"}
                              </a>
                            ))}
                            {manager && (
                              <VoidButton
                                slug={tenant.slug}
                                shipmentId={parcel.id as string}
                                label
                              />
                            )}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>

        <aside className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Order summary</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col text-sm">
              {(
                [
                  ["Order", order.name ?? "–"],
                  ["Placed", when.format(new Date(order.placed_at))],
                  ["Customer", order.recipient ?? "No name"],
                  ["Email", order.email ?? "–"],
                  ["Phone", order.phone ?? "–"],
                  ["Payment", order.paid ? "Paid" : "Pending"],
                  ["Customer chose", order.shipping_method ?? "–"],
                  ["Weight", formatWeight(order.weight_grams, home === "US") || "–"],
                ] as const
              ).map(([label, value]) => (
                <p key={label} className={summaryRow}>
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-read min-w-0 truncate text-right font-medium">{value}</span>
                </p>
              ))}
              {order.note && (
                <p className="bg-note font-read mt-3 rounded-md px-3 py-2 whitespace-pre-wrap">
                  {order.note}
                </p>
              )}
              <div className="flex flex-wrap gap-2 pt-4">
                {order.email && (
                  <Button asChild variant="outline" size="sm">
                    <a href={`mailto:${order.email}`}>Email customer</a>
                  </Button>
                )}
                {todo && (
                  <Button asChild variant="outline" size="sm">
                    <Link href={`${base}/slips?order=${order.id}`}>
                      Packing slip{order.slip_printed_at ? " (printed)" : ""}
                    </Link>
                  </Button>
                )}
                {shopLink && (
                  <Button asChild variant="ghost" size="sm">
                    <a href={shopLink} target="_blank" rel="noopener noreferrer">
                      Open in Shopify ↗
                    </a>
                  </Button>
                )}
                {todo && (
                  <Button asChild variant="outline" size="sm">
                    <Link
                      href={`${base}/scan?code=${encodeURIComponent((order.name ?? "").replace(/^#/, ""))}`}
                    >
                      Scan &amp; pack
                    </Link>
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {sale && (
            <Card>
              <CardHeader>
                <CardTitle>Payment summary</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col text-sm">
                {(
                  [
                    ["Items, after discounts", sale.net_sales],
                    ["Shipping paid", sale.total_shipping],
                    ["Tax", sale.total_tax],
                  ] as const
                ).map(([label, value]) => (
                  <p key={label} className={summaryRow}>
                    <span className="text-muted-foreground">{label}</span>
                    <span className="font-medium tabular-nums">{money(value)}</span>
                  </p>
                ))}
                <p className={summaryRow}>
                  <span className="font-semibold">Total</span>
                  <span className="font-semibold tabular-nums">{money(sale.total)}</span>
                </p>
              </CardContent>
            </Card>
          )}

          {!desk && (
            <Card>
              <CardHeader>
                <CardTitle>{order.pickup ? "Collecting" : "Send to"}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                {order.pickup && !hasAddress(order) ? (
                  <p className="font-read">{order.recipient ?? "No name on this order"}</p>
                ) : hasAddress(order) ? (
                  <address className="font-read not-italic">
                    {addressLines(order, home).map((line, index) => (
                      <span key={index} className="block">
                        {line}
                      </span>
                    ))}
                  </address>
                ) : (
                  <p className="text-brick">
                    There&apos;s no full address on this order. Check it in your shop before you
                    pack.
                  </p>
                )}
                {order.phone && <p className="text-muted-foreground">{order.phone}</p>}
                {order.email && (
                  <a
                    href={`mailto:${order.email}`}
                    className="text-muted-foreground hover:underline"
                  >
                    {order.email}
                  </a>
                )}
                {order.note && (
                  <p className="bg-note font-read mt-1 rounded-md px-3 py-2 whitespace-pre-wrap">
                    {order.note}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {todo && entitlements.canWrite && (
            <Card>
              <CardHeader>
                <CardTitle>{hold === "held" ? "On hold" : "Not ready to send?"}</CardTitle>
              </CardHeader>
              <CardContent>
                <HoldForm
                  slug={tenant.slug}
                  orderId={order.id}
                  hold={hold}
                  reason={order.hold_reason}
                  until={order.hold_until}
                  today={today}
                  choices={holdChoices(today)}
                />
              </CardContent>
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}
