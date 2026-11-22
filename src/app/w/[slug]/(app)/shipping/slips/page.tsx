import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { queueOf } from "@/lib/shipping/carriers";
import { createClient } from "@/lib/supabase/server";
import { markPrinted } from "../actions";
import { ORDER_FIELDS, loadShippingSetup, type ShippingOrder } from "../data";
import { PrintButton } from "../forms";
import { shippingAccess } from "../gate";
import { PackingSlip } from "../slip";

export const metadata: Metadata = { title: "Packing slips" };

export default async function PackingSlipsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ order?: string; all?: string }>;
}) {
  const { slug } = await params;
  const access = await shippingAccess(slug, `/w/${slug}/shipping/slips`);
  if (!access.ok) return access.upsell;
  const { tenant, entitlements } = access;
  const query = await searchParams;
  const one = /^[0-9a-f-]{36}$/i.test(query.order ?? "") ? query.order! : null;

  const supabase = await createClient();
  let request = supabase
    .from("shipping_orders")
    .select(ORDER_FIELDS)
    .eq("tenant_id", tenant.id)
    .gt("units_left", 0)
    .eq("cancelled", false)
    .order("placed_at")
    .limit(200);
  if (one) request = request.eq("id", one);
  const [{ data }, setup] = await Promise.all([request, loadShippingSetup(supabase, tenant.id)]);
  const ready = ((data ?? []) as unknown as ShippingOrder[]).filter(
    (order) => one || queueOf(order) === "ready",
  );
  const fresh = ready.filter((order) => !order.slip_printed_at);
  // By default only what hasn't been printed yet, so a second run doesn't repeat the first.
  const shown = one || query.all === "1" || fresh.length === 0 ? ready : fresh;
  const base = `/w/${tenant.slug}/shipping`;

  return (
    <>
      <div className="print:hidden">
        <PageHeader
          back={{ href: base, label: "To send" }}
          title={`${shown.length} packing slip${shown.length === 1 ? "" : "s"}`}
          description={
            one
              ? "One slip, ready to print."
              : shown.length === ready.length
                ? "Every order that's ready to send, oldest first. One to a page."
                : `Only the ones you haven't printed yet. ${ready.length - shown.length} already printed are left out.`
          }
        >
          {!one && shown.length !== ready.length && (
            <Button asChild variant="ghost" size="sm">
              <a href={`${base}/slips?all=1`}>Include printed ones</a>
            </Button>
          )}
          {shown.length > 0 && <PrintButton label="Print these" />}
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
      ) : (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 print:max-w-none print:gap-0">
          {shown.map((order) => (
            <PackingSlip
              key={order.id}
              order={order}
              settings={setup.settings}
              workspaceName={tenant.name}
              timeZone={tenant.timezone}
            />
          ))}
        </div>
      )}
    </>
  );
}
