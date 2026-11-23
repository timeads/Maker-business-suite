import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { daysFromNow } from "@/lib/bookings/slots";
import { combineOrders, groupKey } from "@/lib/shipping/merge";
import { inQueueView, todayIn } from "@/lib/shipping/queue";
import { buildSlipData } from "@/lib/shipping/zebra/slip";
import { createClient } from "@/lib/supabase/server";
import { markPrinted } from "../actions";
import {
  ORDER_FIELDS,
  loadGroup,
  loadGroups,
  loadShippingSetup,
  type ShippingOrder,
} from "../data";
import { PrintButton } from "../forms";
import { shippingAccess } from "../gate";
import { ZebraSlipsButton } from "../print-ui";
import { PackingSlip } from "../slip";

export const metadata: Metadata = { title: "Packing slips" };

export default async function PackingSlipsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ order?: string; ids?: string; all?: string; together?: string }>;
}) {
  const { slug } = await params;
  const access = await shippingAccess(slug, `/w/${slug}/shipping/slips`);
  if (!access.ok) return access.upsell;
  const { tenant, entitlements } = access;
  const query = await searchParams;
  const one = /^[0-9a-f-]{36}$/i.test(query.order ?? "") ? query.order! : null;
  // The orders ticked in the queue.
  const ticked = one
    ? []
    : [...new Set((query.ids ?? "").split(",").filter((id) => /^[0-9a-f-]{36}$/i.test(id)))].slice(
        0,
        150,
      );
  const supabase = await createClient();
  const today = todayIn(tenant.timezone, new Date(daysFromNow(0)));
  // Orders going out together share one slip: asked for from their page, or
  // ticked in the queue after someone saved them (or said they're one place).
  const asked = [
    ...new Set(
      (query.together ?? "")
        .toLowerCase()
        .split(",")
        .filter((id) => /^[0-9a-f-]{36}$/.test(id)),
    ),
  ].slice(0, 10);
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
  const base = `/w/${tenant.slug}/shipping`;
  // The same slips as plain words, for a computer that sends them to its Zebra.
  const slipSetup = {
    settings: setup.settings,
    layout: setup.slip,
    workspaceName: tenant.name,
    timeZone: tenant.timezone,
    currency: tenant.currency,
  };
  const zebraSlips =
    shown.length === 0
      ? []
      : combined && together
        ? [
            buildSlipData({
              ...slipSetup,
              order: {
                ...together[0],
                name: combined.name,
                items: combined.items,
              },
              code: together[0].name ?? "",
              from: new Map(combined.items.map((item) => [item.line_id, item.order_name])),
            }),
          ]
        : shown.map((order) => buildSlipData({ ...slipSetup, order }));

  return (
    <>
      <div className="print:hidden">
        <PageHeader
          back={{ href: base, label: "To ship" }}
          title={
            combined
              ? "1 packing slip"
              : `${shown.length} packing slip${shown.length === 1 ? "" : "s"}`
          }
          description={
            combined
              ? `One slip for ${combined.name}, going out together. Each line says which order it's from.`
              : one
                ? "One slip, ready to print."
                : ticked.length > 0
                  ? "The orders you ticked, oldest first. One to a page."
                  : shown.length === ready.length
                    ? "Every order that's ready to send, oldest first. One to a page."
                    : `Only the ones you haven't printed yet. ${ready.length - shown.length} already printed are left out.`
          }
        >
          {!chosen && shown.length !== ready.length && (
            <Button asChild variant="ghost" size="sm">
              <a href={`${base}/slips?all=1`}>Include printed ones</a>
            </Button>
          )}
          {shown.length > 0 && <PrintButton label="Print these" />}
          <ZebraSlipsButton slips={zebraSlips} />
          {shown.length > 0 && entitlements.canWrite && (
            <form
              action={markPrinted.bind(
                null,
                tenant.slug,
                shown.map((order) => order.id),
              )}
            >
              <Button type="submit" variant="outline" size="sm">
                I&apos;ve printed them
              </Button>
            </form>
          )}
        </PageHeader>
      </div>
      {shown.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing is waiting for a slip.</p>
      ) : combined && together ? (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 print:max-w-none print:gap-0">
          <PackingSlip
            order={{
              ...together[0],
              name: combined.name,
              items: combined.items,
              units_left: combined.units_left,
            }}
            // The first order's own number: scanning it opens that order, which leads to the group.
            code={together[0].name ?? ""}
            from={new Map(combined.items.map((item) => [item.line_id, item.order_name]))}
            settings={setup.settings}
            layout={setup.slip}
            workspaceName={tenant.name}
            timeZone={tenant.timezone}
            currency={tenant.currency}
          />
        </div>
      ) : (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 print:max-w-none print:gap-0">
          {shown.map((order) => (
            <PackingSlip
              key={order.id}
              order={order}
              settings={setup.settings}
              layout={setup.slip}
              workspaceName={tenant.name}
              timeZone={tenant.timezone}
              currency={tenant.currency}
            />
          ))}
        </div>
      )}
    </>
  );
}
