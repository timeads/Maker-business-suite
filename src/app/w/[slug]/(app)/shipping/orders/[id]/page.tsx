import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Mail, Truck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { daysFromNow } from "@/lib/bookings/slots";
import { formatMoney } from "@/lib/dashboard/format";
import { hasAddress } from "@/lib/shipping/carriers";
import { gramsToTenthOz } from "@/lib/shipping/easypost";
import { SOURCE_NAMES, isLabelSource } from "@/lib/shipping/sources/types";
import {
  boxSize,
  boxTenthOz,
  missingShipFrom,
  shipToEdit,
  shownBoxes,
} from "@/lib/shipping/labels";
import { leftBehind, parsePart, partOrder } from "@/lib/shipping/part";
import { choiceOf, planFor, type OrderPlan } from "@/lib/shipping/plan";
import { pickupTells, undoWords } from "@/lib/shipping/shop-steps";
import { boughtBoxes, slipBoxes } from "@/lib/shipping/slip-boxes";
import { combineOrders, groupHref, groupKey, parseWith, sumAmounts } from "@/lib/shipping/merge";
import {
  formatHoldDate,
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
import { shopPhotoAddress } from "@/lib/social/product-photos";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import {
  ORDER_WITH_SALE,
  loadBoxes,
  loadGroup,
  loadGroups,
  loadKnownGroup,
  loadLabelConnections,
  loadOrderExtras,
  loadPackingMemory,
  loadParcelBoxes,
  loadPlans,
  parcelTracking,
  planSetupOf,
  loadQueueSteps,
  loadShippingSetup,
  loadUnfinishedLabels,
  type OrderWithSale,
  type Sale,
  type ShippingOrder,
} from "../../data";
import {
  HoldForm,
  ParcelForm,
  PickupForm,
  SeenBackFromHold,
  VoidButton,
  type ShopStep,
} from "../../forms";
import { shippingAccess } from "../../gate";
import { ClearUnsureLabelButton, FinishLabelButton } from "../../label-card";
import { LabelDesk, type DeskStart } from "../../label-desk";
import { OrderRailActions } from "../../order-rail";
import { OrderSteps } from "../../order-steps";
import { PartPicker } from "../../part-picker";
import { LabelPrint, SlipsButton } from "../../print-ui";
import { TogetherNote } from "../../together-ui";

const saleOf = (order: OrderWithSale): Sale | null =>
  (Array.isArray(order.sale) ? order.sale[0] : order.sale) ?? null;

/** An order's plan, as the bench lays it out to start with. */
const deskStart = (plan: OrderPlan): DeskStart => ({
  boxes: plan.boxes.map((box) => ({
    boxId: box.box?.id ?? "",
    length: String(box.length),
    width: String(box.width),
    height: String(box.height),
    tenthOz: box.weightTenthOz,
    weighed: box.weighed,
    alloc: box.items,
  })),
  source: plan.boxSource,
  signature: plan.signatureKind,
  signatureNote:
    plan.signatureFrom === "rule" && plan.signatureRule
      ? `Rule: ${plan.signatureRule}`
      : plan.signatureFrom === "saved"
        ? plan.signatureRule
          ? `Your saved choice. The rule “${plan.signatureRule}” would ask for one.`
          : "Your saved choice"
        : null,
  service: plan.service,
  serviceFrom: plan.serviceFrom,
  rules: plan.rules,
  savedSignature: plan.signatureFrom === "saved" ? plan.signatureKind : null,
  savedService: plan.serviceFrom === "saved" ? plan.service : null,
});

const INTERNATIONAL_NOTE =
  "International labels need a customs form, which isn't built yet. Buy this one elsewhere and record the parcel by hand.";

/** A thumbnail is all the page needs of an item's picture. */
const THUMB_WIDTH = 120;

export const metadata: Metadata = { title: "Send an order" };

export default async function ShippingOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<{
    label?: string;
    view?: string;
    with?: string;
    apart?: string;
    /** Only these items are going now (see `lib/shipping/part.ts`). */
    part?: string;
  }>;
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
  const [
    { data },
    setup,
    { data: parcels },
    boxes,
    postage,
    unfinished,
    steps,
    { data: shop },
    plans,
  ] = await Promise.all([
    supabase
      .from("shipping_orders")
      .select(ORDER_WITH_SALE)
      .eq("tenant_id", tenant.id)
      .eq("id", id)
      .maybeSingle(),
    loadShippingSetup(supabase, tenant.id),
    supabase
      .from("shipments")
      .select(
        "id, number, order_name, carrier, service, tracking_number, tracking_url, shipped_at, items, voided_at, label_provider, label_url, label_mode, label_parcels, merged_with, label_printed_at, shop_status, notify_customer",
      )
      .eq("tenant_id", tenant.id)
      .eq("shipping_order_id", id)
      .order("number"),
    loadBoxes(supabase, tenant.id),
    loadLabelConnections(supabase, tenant.id),
    loadUnfinishedLabels(supabase, tenant.id, id),
    loadQueueSteps(supabase, tenant.id),
    supabase
      .from("connections")
      .select("external_account_id")
      .eq("tenant_id", tenant.id)
      .eq("provider", "shopify")
      .maybeSingle(),
    // The box someone picked for this order before, if any.
    loadPlans(supabase, tenant.id, [id]),
  ]);
  const own = data as unknown as OrderWithSale | null;
  if (!own) notFound();
  // What the shop has heard about this order's pickup steps and undone parcels. Asked apart
  // and allowed to fail, so the page still opens on a database from before these were kept.
  const [{ data: pickupRow }, { data: undoneRows }] = await Promise.all([
    supabase
      .from("shipping_orders")
      .select(
        "pickup_ready_shop_status, pickup_ready_shop_error, picked_up_shop_status, picked_up_shop_error",
      )
      .eq("tenant_id", tenant.id)
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("shipments")
      .select("id, number, voided_at, shop_undo_status, shop_undo_error")
      .eq("tenant_id", tenant.id)
      .eq("shipping_order_id", id)
      .not("voided_at", "is", null)
      .neq("shop_undo_status", "none")
      .order("voided_at", { ascending: false })
      .limit(10),
  ]);
  const pickupShop = {
    ready: (pickupRow?.pickup_ready_shop_status ?? "none") as ShopStep,
    readyError: (pickupRow?.pickup_ready_shop_error ?? null) as string | null,
    pickedUp: (pickupRow?.picked_up_shop_status ?? "none") as ShopStep,
    pickedUpError: (pickupRow?.picked_up_shop_error ?? null) as string | null,
  };
  const undone = (
    (undoneRows ?? []) as {
      id: string;
      number: number;
      voided_at: string;
      shop_undo_status: string;
      shop_undo_error: string | null;
    }[]
  ).flatMap((row) => {
    const words = undoWords(row.shop_undo_status, row.shop_undo_error);
    return words ? [{ ...row, words }] : [];
  });
  const base = `/w/${tenant.slug}/shipping`;
  const today = todayIn(tenant.timezone, new Date(daysFromNow(0)));

  // Several orders opened as one (`?with=`): checked here every time, and the
  // page always sits on the oldest of them, where the label will be bought.
  const riders = parseWith(query.with, id);
  let group: OrderWithSale[] | null = null;
  let groupSaved = false;
  if (riders.length > 0) {
    const ids = [own.id, ...riders];
    const [loaded, stored] = await Promise.all([
      loadGroup(supabase, tenant.id, ids, today),
      loadGroups(supabase, tenant.id),
    ]);
    if (!loaded.check.ok) redirect(`${base}/orders/${own.id}?apart=1`);
    if (loaded.orders[0].id !== own.id) {
      redirect(
        groupHref(
          base,
          loaded.orders.map((each) => each.id),
        ),
      );
    }
    group = loaded.orders;
    const key = groupKey(ids);
    groupSaved = stored.some((each) => each.saved_at && groupKey(each.order_ids) === key);
  }
  const combined = group ? combineOrders(group) : null;
  // One order to draw: its own, or everything in the group on the oldest order's details.
  const order: OrderWithSale = combined
    ? {
        ...own,
        name: combined.name,
        items: combined.items,
        units_left: combined.units_left,
        shipping_paid: combined.shipping_paid,
        weight_grams: combined.weight_grams,
        paid: group!.every((each) => each.paid),
      }
    : own;
  const cameFrom = new Map(combined?.items.map((item) => [item.line_id, item.order_name]));
  const sales = (group ?? [own]).map(saleOf).filter((each): each is Sale => each !== null);
  // Tags and the figures before discounts: there for orders synced since they were kept.
  const shown = group ?? [own];
  const extras = await loadOrderExtras(
    supabase,
    tenant.id,
    shown.map((each) => each.id),
  );
  const tags = [...new Set(shown.flatMap((each) => extras.get(each.id)?.tags ?? []))].slice(0, 20);
  const figures = shown.map((each) => extras.get(each.id));
  const allKnown = (key: "gross_sales" | "total_discounts") =>
    figures.every((each) => each && each[key] !== null)
      ? (sumAmounts(figures.map((each) => each![key])) ?? null)
      : null;
  const products = sales.length === shown.length ? allKnown("gross_sales") : null;
  const discounts = products === null ? null : allKnown("total_discounts");
  const sale: Sale | null =
    sales.length === 0
      ? null
      : {
          net_sales: sumAmounts(sales.map((each) => each.net_sales)) ?? 0,
          total_tax: sumAmounts(sales.map((each) => each.total_tax)) ?? 0,
          total_shipping: sumAmounts(sales.map((each) => each.total_shipping)) ?? 0,
          total: sumAmounts(sales.map((each) => each.total)) ?? 0,
        };
  // On its own page, an order that is waiting to go out with others says so.
  const waitingWith =
    !group && own.units_left > 0 && !own.cancelled
      ? await loadKnownGroup(supabase, tenant.id, own.id, today)
      : null;
  // Parcels that went with other orders: the one that carried the label.
  const leadIds = [
    ...new Set((parcels ?? []).map((parcel) => parcel.merged_with as string | null)),
  ].filter((each): each is string => Boolean(each));
  const { data: leadRows } = leadIds.length
    ? await supabase
        .from("shipments")
        .select("id, number, order_name, shipping_order_id, label_parcels, label_printed_at")
        .eq("tenant_id", tenant.id)
        .in("id", leadIds)
    : { data: [] };
  const leads = new Map(
    (
      (leadRows ?? []) as {
        id: string;
        number: number;
        order_name: string | null;
        shipping_order_id: string | null;
        label_parcels: unknown;
        label_printed_at: string | null;
      }[]
    ).map((lead) => [lead.id, lead]),
  );
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
  // The picture of the very option that was ordered comes first; then the product's.
  const photoOf = (item: ShippingOrder["items"][number]) =>
    shopPhotoAddress(item.image, THUMB_WIDTH) ??
    (item.sku ? photos.get(`sku:${item.sku}`) : undefined) ??
    photos.get(`name:${item.title}|${item.variant ?? ""}`) ??
    photos.get(`name:${item.title}`);
  const left = order.items.filter((item) => item.left > 0);
  const pickedUp = Boolean(order.picked_up_at);
  const todo = left.length > 0 && !order.cancelled && !pickedUp;
  // Orders only open together when none of them is set aside.
  const hold = todo && !group ? holdState(order, today) : "none";
  const home = setup.settings.ship_from_country;
  const parcelForm = (quiet: boolean, key?: string) => (
    <ParcelForm
      key={key}
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
  // Up and down walk the list the person came from, oldest first, like the queue itself.
  const place = queuePlace(
    steps.filter((step) => inQueueView(step, view, today, home, setup.settings.signature_over)),
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
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tenant.timezone, dateStyle: "medium" });
  // "Nov 20, 5:03 PM"
  const placed = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const sent = (parcels ?? []).filter((parcel) => !parcel.voided_at);
  const manager = canManage(role) && entitlements.canWrite;
  // A label from UPS or Redo is a file we keep rather than a link, so the label's source is what counts.
  const fresh = sent.find((parcel) => parcel.number === justBought && parcel.label_provider);
  // Every box of a parcel: one for most, several when the order went in more than one.
  const boxesOf = (parcel: (typeof sent)[number]) =>
    shownBoxes({
      tracking_number: parcel.tracking_number as string | null,
      tracking_url: parcel.tracking_url as string | null,
      label_url: parcel.label_url as string | null,
      // An order that rode along shows every box of the parcel it went in.
      boxes: parcel.label_parcels ?? leads.get(parcel.merged_with as string)?.label_parcels ?? null,
    });
  const freshBoxes = fresh ? boxesOf(fresh) : [];
  // Which kept label files are in a Zebra's own format: opened in a browser they are text, not a picture.
  const fileIdOf = (href: string | null) =>
    /\/label-file\/([0-9a-f-]{36})$/i.exec(href ?? "")?.[1] ?? null;
  const keptIds = [
    ...new Set(
      sent
        .flatMap((parcel) => boxesOf(parcel))
        .map((box) => fileIdOf(box.labelUrl))
        .filter((each): each is string => Boolean(each)),
    ),
  ];
  const { data: keptFiles } = keptIds.length
    ? await supabase
        .from("shipping_label_files")
        .select("id, content_type")
        .eq("tenant_id", tenant.id)
        .in("id", keptIds)
    : { data: [] };
  const zplFiles = new Set(
    ((keptFiles ?? []) as { id: string; content_type: string }[])
      .filter((file) => file.content_type === "text/plain")
      .map((file) => file.id),
  );
  const isZpl = (href: string) => zplFiles.has(fileIdOf(href) ?? "") || /\.zpl(\?|$)/i.test(href);
  /** Each box's label to open in the browser, said as what it is. */
  const labelLinks = (parcel: (typeof sent)[number]) => {
    const printable = boxesOf(parcel).filter((box) => box.labelUrl);
    return printable.map((box, index) => {
      const href = box.labelUrl as string;
      const n = printable.length > 1 ? ` ${index + 1}` : "";
      return {
        href,
        text: isZpl(href) ? `Label${n} file for a Zebra` : `Print label${n}`,
      };
    });
  };
  const printedOf = (parcel: (typeof sent)[number]) =>
    ((parcel.label_printed_at as string | null) ??
      leads.get(parcel.merged_with as string)?.label_printed_at ??
      null) as string | null;
  const linkClass = "text-ochre-text font-medium hover:underline";
  // Parcels that went out in several boxes, with what went in each: those can have a slip per box.
  const splitParcels = new Set(
    (await loadParcelBoxes(supabase, tenant.id, { orderId: id }))
      .filter(
        (parcel) => slipBoxes(boughtBoxes(parcel.box_items, parcelTracking(parcel))).length > 0,
      )
      .map((parcel) => parcel.id),
  );

  // Buying a label here: a postage account (EasyPost, UPS or Redo) is connected and this is a parcel to post.
  const lapsed = postage.needsReconnect.map((key) => SOURCE_NAMES[key]);
  const posting = todo && entitlements.canWrite && !order.pickup;
  const abroad = isInternational(order.country_code, home);
  const fromGaps = missingShipFrom(setup.settings);
  const labelCard: "builder" | "reconnect" | "abroad" | "unfinished" | null =
    !posting || (postage.active.length === 0 && postage.needsReconnect.length === 0)
      ? null
      : unfinished.length > 0
        ? "unfinished"
        : postage.active.length === 0
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
  // Sending part of the order with its own label (`?part=`): only for one order on its own,
  // where a label can be bought. Held to what is still left; the server checks it again.
  const part = !group && desk ? parsePart(query.part, left) : null;
  const sending: OrderWithSale = part ? partOrder(order, part) : order;
  const sendingLines = part ? sending.items.filter((item) => item.left > 0) : left;
  // The plan the bench starts from: what a person saved for this order, else a rule's box,
  // the packing remembered for these items, or the usual box. Several orders in one parcel
  // are planned as one, with nothing saved.
  const planSetup = planSetupOf(
    {
      shipping: setup,
      boxes,
      postage,
      memory: await loadPackingMemory(supabase, tenant.id, todo ? [sending] : []),
    },
    tenant.currency,
  );
  const total = sale ? Number(sale.total) : null;
  // What a person saved is for the whole order; part of it starts from the plan alone.
  const choice = group || part ? {} : choiceOf(plans.get(order.id));
  const plan = planFor(sending, choice, total, planSetup);
  // Where "Reset" goes back to: the plan with nothing saved, and the usual box.
  const planOnly = choice.saved || choice.boxId ? planFor(order, {}, total, planSetup) : plan;
  const usual = planFor(order, {}, total, { ...planSetup, rules: [], memory: undefined });
  const itemCount = order.items.reduce((sum, item) => sum + item.qty, 0);
  const itemsList = (
    <ul className="grid gap-x-5 sm:grid-cols-2 xl:grid-cols-3">
      {order.items.map((item) => {
        const photo = photoOf(item);
        return (
          <li
            key={item.line_id}
            className="border-border flex items-start gap-3 border-t py-2 text-sm"
          >
            {photo ? (
              // eslint-disable-next-line @next/next/no-img-element -- the shop's own picture of the product, on the shop's image servers
              <img
                src={photo}
                alt=""
                loading="lazy"
                className="border-border size-12 shrink-0 rounded-md border bg-white object-cover"
              />
            ) : (
              <span
                className="bg-sunken border-border size-12 shrink-0 rounded-md border"
                aria-hidden
              />
            )}
            <span className="min-w-0 flex-1">
              <span className="block leading-snug font-semibold">{item.title}</span>
              <span className="text-muted-foreground block text-xs break-words">
                {cameFrom.has(item.line_id) && (
                  <span className="text-foreground font-semibold tabular-nums">
                    {cameFrom.get(item.line_id)} ·{" "}
                  </span>
                )}
                {[item.variant, item.sku].filter(Boolean).join(" · ") || "No item code"}
              </span>
            </span>
            <span className="text-right tabular-nums">
              <span className="text-ochre-text block font-extrabold whitespace-nowrap">
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
  // Why there's no Buy button here, when there isn't; the page keeps its shape either way.
  const connections = `/w/${tenant.slug}/connections`;
  const offReason: React.ReactNode = !posting ? null : labelCard === null ? (
    <>
      Connect EasyPost, your own UPS account or Redo and labels can be bought right here.{" "}
      {manager ? (
        <>
          <Link href={connections} className={linkClass}>
            Open Connections
          </Link>{" "}
          to add one.
        </>
      ) : (
        "Ask an owner or admin to connect one."
      )}{" "}
      Until then, buy the postage wherever you usually do and record the parcel by hand.
    </>
  ) : labelCard === "reconnect" ? (
    <>
      {lapsed.join(" and ")} stopped accepting the saved {lapsed.length > 1 ? "keys" : "key"}, so
      labels can&apos;t be bought right now.{" "}
      {manager ? (
        <Link href={connections} className={linkClass}>
          Reconnect {lapsed.join(" and ")}
        </Link>
      ) : (
        "Ask an owner or admin to reconnect it."
      )}
    </>
  ) : labelCard === "abroad" ? (
    INTERNATIONAL_NOTE
  ) : labelCard === "unfinished" ? (
    "A label for this order is waiting to be finished above. Finish that one rather than buying again."
  ) : null;
  const pickupCard = Boolean(order.pickup && !order.cancelled && (left.length > 0 || pickedUp));
  const off = desk
    ? null
    : pickupCard
      ? { bar: null, service: null, boxes: false }
      : posting
        ? {
            bar: group ? (
              <>
                {offReason} Sending orders together works by buying one label here. To record a
                parcel you bought elsewhere, open each order on its own and put the same tracking
                number on each.
              </>
            ) : (
              offReason
            ),
            service: offReason,
            boxes: true,
          }
        : {
            bar: order.cancelled
              ? "This order was cancelled, so there's nothing to send."
              : left.length === 0
                ? "Everything on this order has been sent."
                : "This workspace is read-only right now, so parcels can't be recorded.",
            service: null,
            boxes: false,
          };
  const stillToSend = left.reduce((sum, item) => sum + item.left, 0);
  const summaryRow = "flex items-baseline justify-between gap-4 py-1";

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav aria-label="Where you are" className="text-muted-foreground min-w-0 truncate text-sm">
          <Link href={`${base}${carry}`} className="hover:underline" title={`Back to ${listName}`}>
            Shipping
          </Link>{" "}
          /{" "}
          <span className="text-foreground font-semibold tabular-nums">
            {order.name ?? "Order"}
          </span>
        </nav>
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
        title={
          <span className="text-[26px] font-extrabold tabular-nums">{order.name ?? "Order"}</span>
        }
        description={
          <>
            {group
              ? `${group.length} orders, the oldest from ${day.format(new Date(order.placed_at))}`
              : day.format(new Date(order.placed_at))}{" "}
            · {itemCount} {itemCount === 1 ? "item" : "items"}
            {sale ? ` · ${money(sale.total)}` : ""}
            {order.shipping_method && (
              <>
                {" · "}
                <span
                  className="bg-sunken text-foreground inline-flex items-center gap-1 rounded-full px-2 py-px align-middle text-[13px] font-semibold"
                  title="The shipping option picked at checkout"
                >
                  <Truck className="size-[13px]" aria-hidden />
                  {order.shipping_method}
                  {order.shipping_paid === null ? "" : ` · ${money(order.shipping_paid)}`}
                </span>
              </>
            )}
          </>
        }
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
      {group && (
        <TogetherNote
          slug={tenant.slug}
          orderIds={group.map((each) => each.id)}
          names={group.map((each) => each.name ?? "Order")}
          saved={groupSaved}
          canWrite={entitlements.canWrite}
        />
      )}
      {query.apart === "1" && !group && (
        <p role="status" className="bg-note rounded-md px-4 py-2.5 text-sm">
          Those orders can&apos;t go together any more: one of them was sent, set aside or changed.
          This is {own.name ?? "the first one"} on its own.
        </p>
      )}
      {waitingWith && (
        <p role="status" className="bg-note rounded-md px-4 py-2.5 text-sm">
          This order is waiting to go out together with{" "}
          <span className="font-semibold tabular-nums">
            {waitingWith.names.filter((_, index) => waitingWith.ids[index] !== own.id).join(" + ")}
          </span>
          .{" "}
          <Link
            href={groupHref(base, waitingWith.ids)}
            className="font-semibold underline underline-offset-2"
          >
            Open them together
          </Link>
        </p>
      )}

      <div className="grid items-start gap-[18px] lg:grid-cols-[minmax(0,1fr)_21.25rem]">
        <div className="flex min-w-0 flex-col gap-3.5">
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
                <LabelPrint
                  slug={tenant.slug}
                  shipmentId={fresh.id as string}
                  links={labelLinks(fresh)}
                  printedAt={printedOf(fresh)}
                  printedText={printedOf(fresh) ? when.format(new Date(printedOf(fresh)!)) : null}
                  auto
                  primary
                />
                {freshBoxes.length > 1 && (
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
                    const via = isLabelSource(label.provider)
                      ? SOURCE_NAMES[label.provider]
                      : "EasyPost";
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
                        ) : via === "EasyPost" ? (
                          <p>
                            <span className="font-semibold">We never heard back from EasyPost</span>
                            {label.buying_at ? ` (${when.format(new Date(label.buying_at))})` : ""}
                            {label.box_count > 1 ? `, for ${label.box_count} boxes` : ""}. It may or
                            may not have been bought; checking will settle it.
                          </p>
                        ) : (
                          <p>
                            <span className="font-semibold">We never heard back from {via}</span>
                            {label.buying_at ? ` (${when.format(new Date(label.buying_at))})` : ""}
                            {label.box_count > 1 ? `, for ${label.box_count} boxes` : ""}. It may or
                            may not have been bought, and {via} can&apos;t be asked from here. Look
                            in your {via} account for a label for this order. If there is one, void
                            it there, or use it and record the parcel by hand below.{" "}
                            {manager
                              ? "Then clear this so the order is free again."
                              : "Then ask an owner or admin to clear this."}
                          </p>
                        )}
                        {entitlements.canWrite &&
                          (label.status === "buying" && via !== "EasyPost" ? (
                            manager && (
                              <ClearUnsureLabelButton
                                slug={tenant.slug}
                                quoteId={label.id}
                                via={via}
                              />
                            )
                          ) : (
                            <FinishLabelButton
                              slug={tenant.slug}
                              quoteId={label.id}
                              unsure={label.status === "buying"}
                              via={via}
                            />
                          ))}
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          )}
          {pickupCard && (
            <Card>
              <CardHeader>
                <CardTitle>In-store pickup</CardTitle>
                <CardDescription>
                  {pickedUp
                    ? `Collected ${when.format(new Date(order.picked_up_at!))}.${pickupShop.pickedUp === "none" ? " Your shop wasn't told, so if it still shows the order as unfulfilled, mark it there too." : ""}`
                    : order.pickup_ready_at
                      ? `Packed and waiting since ${when.format(new Date(order.pickup_ready_at))}. When they come by, mark it picked up.`
                      : "Nothing to post. Pack it, then mark it ready so the team knows it's waiting at the counter."}
                </CardDescription>
              </CardHeader>
              {entitlements.canWrite && (
                <CardContent className="flex flex-col gap-4">
                  <PickupForm
                    slug={tenant.slug}
                    orderId={order.id}
                    ready={Boolean(order.pickup_ready_at)}
                    pickedUp={pickedUp}
                    canUndo={canManage(role)}
                    tells={pickupTells({
                      wanted: setup.settings.tell_shop_pickups && order.provider === "shopify",
                      canSend: setup.canSend,
                      connected: setup.connected,
                    })}
                    shop={pickupShop}
                  />
                  {todo && (
                    <details className="border-border border-t pt-3 text-sm">
                      <summary className="text-muted-foreground cursor-pointer">
                        Posting it after all? Record a parcel instead
                      </summary>
                      <div className="pt-4">{parcelForm(true, "pickup")}</div>
                    </details>
                  )}
                </CardContent>
              )}
            </Card>
          )}
          <LabelDesk
            key={`${order.id}:${riders.join(",")}:${part ? (query.part ?? "") : ""}`}
            slug={tenant.slug}
            orderId={order.id}
            withIds={group ? group.slice(1).map((each) => each.id) : undefined}
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
            start={deskStart(plan)}
            resets={
              group || part
                ? undefined
                : {
                    plan: deskStart(planOnly),
                    // Only the boxes go back to the usual one; the rules still have their say.
                    usual: { ...deskStart(planOnly), boxes: deskStart(usual).boxes },
                  }
            }
            contentsTenthOz={
              sending.weight_grams ? gramsToTenthOz(Number(sending.weight_grams)) : null
            }
            part={
              part
                ? {
                    items: part,
                    leaving: leftBehind(left, part),
                    exitHref: `${base}/orders/${order.id}${carry}`,
                  }
                : null
            }
            partPicker={
              desk && !group && stillToSend > 1 ? (
                <PartPicker
                  href={`${base}/orders/${order.id}${carry}`}
                  lines={left}
                  going={
                    part
                      ? Object.fromEntries(part.map((item) => [item.line_id, item.qty]))
                      : undefined
                  }
                />
              ) : null
            }
            paid={{
              cents:
                order.shipping_paid === null ? null : Math.round(Number(order.shipping_paid) * 100),
              words: paidWords,
              amount: order.shipping_paid === null ? null : money(order.shipping_paid),
              method: order.shipping_method,
            }}
            shop={{
              offered: setup.canSend,
              markSent: setup.settings.mark_sent_in_shop,
              notify: setup.settings.notify_customer,
            }}
            sources={postage.active}
            testSources={postage.testMode}
            lines={sendingLines.map((item) => ({
              id: item.line_id,
              title: item.title,
              detail: [cameFrom.get(item.line_id), item.variant, item.sku]
                .filter(Boolean)
                .join(" · "),
              qty: item.left,
              tenthOz: item.grams ? gramsToTenthOz(Number(item.grams)) : null,
              photo: photoOf(item) ?? null,
            }))}
            itemCount={itemCount}
            toTitle={order.pickup ? "Collecting" : "Ship to"}
            record={posting && !group ? parcelForm(desk) : null}
            recordOpen={!desk}
            off={
              off && {
                ...off,
                addressNote:
                  !order.pickup && !hasAddress(order) && stillToSend > 0
                    ? "There's no full address on this order. Check it in your shop before you pack."
                    : null,
              }
            }
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

          {undone.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Undone parcels</CardTitle>
                <CardDescription>
                  Parcels that were marked as sent in your shop and then undone here.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-2 text-sm">
                  {undone.map((row) => (
                    <li key={row.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-semibold">Parcel {row.number}</span>
                      <span className="text-muted-foreground">
                        undone {when.format(new Date(row.voided_at))}
                      </span>
                      <Badge tone={row.words.tone}>{row.words.text}</Badge>
                      {row.words.detail && (
                        <span className="text-muted-foreground w-full text-xs">
                          {row.words.detail}
                          {shopLink && (
                            <>
                              {" "}
                              <a
                                href={shopLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={linkClass}
                              >
                                Open the order in your shop
                              </a>
                            </>
                          )}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </CardContent>
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
                        {parcel.merged_with ? (
                          <span className="text-muted-foreground block text-xs">
                            Sent together with{" "}
                            {(() => {
                              const lead = leads.get(parcel.merged_with as string);
                              const others = (lead?.order_name ?? "another order")
                                .split(" + ")
                                .filter((name) => name !== own.name)
                                .join(" + ");
                              return lead?.shipping_order_id ? (
                                <Link
                                  href={`${base}/orders/${lead.shipping_order_id}`}
                                  className={linkClass}
                                >
                                  {others || "another order"}
                                </Link>
                              ) : (
                                others || "another order"
                              );
                            })()}
                            {leads.get(parcel.merged_with as string)
                              ? `, in parcel ${leads.get(parcel.merged_with as string)!.number}. The label is on that order.`
                              : "."}
                          </span>
                        ) : (
                          String(parcel.order_name ?? "").includes(" + ") && (
                            <span className="text-muted-foreground block text-xs">
                              Sent together: {parcel.order_name as string}. Voiding this label
                              undoes every one of them.
                            </span>
                          )
                        )}
                        {parcel.label_provider && (
                          <span className="mt-1 flex flex-wrap items-center gap-2">
                            {parcel.label_mode === "test" && (
                              <Badge tone="waiting">Test label</Badge>
                            )}
                            <LabelPrint
                              slug={tenant.slug}
                              shipmentId={parcel.id as string}
                              links={labelLinks(parcel)}
                              printedAt={printedOf(parcel)}
                              printedText={
                                printedOf(parcel) ? when.format(new Date(printedOf(parcel)!)) : null
                              }
                            />
                            {splitParcels.has(parcel.id as string) && (
                              <SlipsButton
                                slug={tenant.slug}
                                href={`${base}/slips?parcel=${parcel.id}`}
                                selection={{ parcel: parcel.id as string }}
                                title="A packing slip for each box, listing what went in it, with that box's tracking number"
                              >
                                Slip for each box
                              </SlipsButton>
                            )}
                            {manager && (
                              <VoidButton
                                slug={tenant.slug}
                                shipmentId={parcel.id as string}
                                label
                                source={parcel.label_provider as string}
                                inShop={{
                                  sent: parcel.shop_status === "sent",
                                  emailed:
                                    parcel.shop_status === "sent" &&
                                    parcel.notify_customer === true,
                                  canUndo: setup.canSend,
                                }}
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

        <aside className="flex min-w-0 flex-col gap-3.5">
          <Card>
            <CardHeader>
              <CardTitle>Order summary</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col pt-2.5 text-sm">
              {group?.map((each) => (
                <p key={each.id} className={summaryRow}>
                  <Link
                    href={`${base}/orders/${each.id}`}
                    className="text-ochre-text font-semibold tabular-nums hover:underline"
                    title="Open this order on its own"
                  >
                    {each.name ?? "Order"}
                  </Link>
                  <span className="font-read min-w-0 truncate text-right">
                    {placed.format(new Date(each.placed_at))} ·{" "}
                    {each.items.reduce((sum, item) => sum + item.left, 0)} to send
                    {each.paid ? "" : " · payment pending"}
                  </span>
                </p>
              ))}
              {(
                [
                  ...(group
                    ? []
                    : ([
                        ["Order", order.name ?? "–"],
                        ["Placed", placed.format(new Date(order.placed_at))],
                      ] as const)),
                  ["Customer", order.recipient ?? "No name"],
                  ["Email", order.email ?? "–"],
                  ["Phone", order.phone ?? "–"],
                  ["Payment", order.paid ? "Paid" : "Pending"],
                  ["Customer chose", order.shipping_method ?? "–"],
                ] as const
              ).map(([label, value]) => (
                <p key={label} className={summaryRow}>
                  <span className="text-muted-foreground shrink-0">{label}</span>
                  <span className="font-read min-w-0 truncate text-right font-medium" title={value}>
                    {value}
                  </span>
                </p>
              ))}
              {tags.length > 0 && (
                <ul
                  aria-label="Tags on this order in your shop"
                  className="flex flex-wrap gap-1 pt-2"
                >
                  {tags.map((tag) => (
                    <li key={tag}>
                      <Badge className="max-w-full truncate">{tag}</Badge>
                    </li>
                  ))}
                </ul>
              )}
              {order.note && (
                <p className="bg-note font-read mt-3 rounded-md px-3 py-2 whitespace-pre-wrap">
                  {order.note}
                </p>
              )}
              {order.email && (
                <Button asChild variant="outline" size="sm" className="mt-2.5 w-full">
                  <a href={`mailto:${order.email}`}>
                    <Mail aria-hidden />
                    Email customer
                  </a>
                </Button>
              )}
              <div className="pt-3 empty:hidden">
                <OrderRailActions
                  slug={tenant.slug}
                  slip={
                    todo
                      ? {
                          href: group
                            ? `${base}/slips?together=${group.map((each) => each.id).join(",")}`
                            : `${base}/slips?order=${order.id}`,
                          selection: group
                            ? { together: group.map((each) => each.id).join(",") }
                            : { order: order.id },
                          label: group ? "One packing slip" : "Packing slip",
                          printed: !group && Boolean(order.slip_printed_at),
                        }
                      : null
                  }
                  shopLink={group ? null : shopLink}
                  hold={
                    todo && entitlements.canWrite && !group
                      ? {
                          held: hold === "held",
                          form: (
                            <HoldForm
                              slug={tenant.slug}
                              orderId={order.id}
                              hold={hold}
                              reason={order.hold_reason}
                              until={order.hold_until}
                              today={today}
                              choices={holdChoices(today)}
                            />
                          ),
                        }
                      : null
                  }
                  scanHref={
                    todo && !group
                      ? `${base}/scan?code=${encodeURIComponent((order.name ?? "").replace(/^#/, ""))}`
                      : null
                  }
                />
              </div>
            </CardContent>
          </Card>

          {sale && (
            <Card>
              <CardHeader>
                <CardTitle>Payment summary</CardTitle>
                {group && (
                  <CardDescription>All {group.length} orders added together.</CardDescription>
                )}
              </CardHeader>
              <CardContent className="flex flex-col pt-2.5 text-sm">
                <p className={summaryRow}>
                  <span className="text-muted-foreground">
                    {products === null ? "Products, after discounts" : "Products"}
                  </span>
                  <span className="font-medium tabular-nums">
                    {money(products ?? sale.net_sales)}
                  </span>
                </p>
                {products !== null && discounts !== null && discounts > 0 && (
                  <p className={summaryRow}>
                    <span className="text-muted-foreground">Discounts</span>
                    <span className="font-medium tabular-nums">−{money(discounts)}</span>
                  </p>
                )}
                {(
                  [
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
                  <span className="font-bold">Total</span>
                  <span className="font-bold tabular-nums">{money(sale.total)}</span>
                </p>
              </CardContent>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}
