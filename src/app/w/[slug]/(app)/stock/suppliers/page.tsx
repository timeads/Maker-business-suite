import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { closedOn, planBuildAhead, type Closure } from "@/lib/stock/engine/closures";
import { orderCountsBySupplier } from "@/lib/stock/po/list";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { loadIncoming, loadStock } from "../data";
import { removeSupplierClosure } from "../actions";
import { AdoptLeadTimeButton, ClosureForm, SupplierForm } from "../forms";
import { stockAccess } from "../gate";
import { StockTabs } from "../tabs";

export const metadata: Metadata = { title: "Suppliers" };

export default async function SuppliersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await stockAccess(slug, `/w/${slug}/stock/suppliers`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const canEdit = canManage(role) && entitlements.canWrite;
  const supabase = await createClient();
  const [{ suppliers, rows, closures, today, settings }, { leadTimes }, { data: orderRows }] =
    await Promise.all([
      loadStock(supabase, tenant),
      loadIncoming(supabase, tenant),
      supabase
        .from("purchase_orders")
        .select("supplier_id, status")
        .eq("tenant_id", tenant.id)
        .limit(5000),
    ]);
  // How many orders each supplier has had (drafts and cancelled ones aside).
  const orderCounts = orderCountsBySupplier(
    (orderRows ?? []).map((order) => ({
      supplierId: order.supplier_id as string,
      status: order.status as string,
    })),
  );
  // An empty "days to arrive" follows the workspace's own default.
  const leadOf = (s: { lead_time_days: number | null }) =>
    s.lead_time_days ?? settings.default_lead_time_days;
  const itemCount = (id: string) => rows.filter((row) => row.item.supplier_id === id).length;
  const closuresOf = (id: string): Closure[] =>
    closures
      .filter((c) => c.supplier_id === id)
      .map((c) => ({ id: c.id, name: c.name, startsOn: c.starts_on, endsOn: c.ends_on }));
  const day = (value: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      ...(value.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
    }).format(new Date(`${value}T12:00:00Z`));
  /** What a supplier's closures mean for ordering, using their own days to arrive. */
  const closureWords = (shut: Closure[], leadDays: number) => {
    const now = closedOn(today, shut);
    const ahead = planBuildAhead({ today, leadDays, closures: shut });
    return {
      now: now ? `Shut for ${now.name} until ${day(now.endsOn)}` : null,
      ahead: ahead
        ? ahead.missed
          ? `Shut for ${ahead.closure.name} from ${day(ahead.closure.startsOn)}. The last day to order and have it before then was ${day(ahead.orderBefore)}.`
          : `Shut for ${ahead.closure.name} from ${day(ahead.closure.startsOn)}. Order by ${day(ahead.orderBefore)} to have it before then.`
        : null,
      aheadShort: ahead
        ? ahead.missed
          ? `Shuts ${day(ahead.closure.startsOn)}`
          : `Order by ${day(ahead.orderBefore)}, before ${ahead.closure.name}`
        : null,
      missed: ahead?.missed ?? false,
    };
  };

  return (
    <>
      <PageHeader
        title="Stock"
        description="Who you buy from, how long they take, and the smallest order they'll accept."
      />
      <StockTabs slug={tenant.slug} tenantId={tenant.id} manager={canManage(role)} />

      {suppliers.length > 0 && (
        <Card>
          <CardContent className="pt-5">
            <ul className="divide-border flex flex-col divide-y">
              {suppliers.map((s) => (
                <li key={s.id} className="py-3 first:pt-0 last:pb-0">
                  <details>
                    <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                      <span className="font-semibold">{s.name}</span>
                      {s.archived_at && <Badge>Not used any more</Badge>}
                      <span className="text-muted-foreground">
                        {itemCount(s.id)} item{itemCount(s.id) === 1 ? "" : "s"} · arrives in{" "}
                        {leadOf(s)} days{s.lead_time_days === null ? " (your usual)" : ""} · covers{" "}
                        {s.coverage_days} days
                        {s.moq > 1 &&
                          ` · smallest order ${s.moq}${s.moq_applies_to === "sku" ? " per item" : ""}`}
                      </span>
                      {closureWords(closuresOf(s.id), leadOf(s)).now ? (
                        <Badge tone="bad">{closureWords(closuresOf(s.id), leadOf(s)).now}</Badge>
                      ) : (
                        closureWords(closuresOf(s.id), leadOf(s)).aheadShort && (
                          <Badge
                            tone={
                              closureWords(closuresOf(s.id), leadOf(s)).missed ? "bad" : "waiting"
                            }
                          >
                            {closureWords(closuresOf(s.id), leadOf(s)).aheadShort}
                          </Badge>
                        )
                      )}
                      {leadTimes.has(s.id) && (
                        <Badge
                          tone={leadTimes.get(s.id)!.days > leadOf(s) + 3 ? "waiting" : "closed"}
                        >
                          Really takes about {leadTimes.get(s.id)!.days} days (
                          {leadTimes.get(s.id)!.sampleSize} order
                          {leadTimes.get(s.id)!.sampleSize === 1 ? "" : "s"})
                        </Badge>
                      )}
                      {(orderCounts.get(s.id) ?? 0) > 0 && (
                        <Link
                          href={`/w/${tenant.slug}/stock/orders?show=all&supplier=${s.id}`}
                          className="text-ochre-text text-xs font-semibold underline-offset-2 hover:underline"
                        >
                          {orderCounts.get(s.id)} order{orderCounts.get(s.id) === 1 ? "" : "s"}
                        </Link>
                      )}
                    </summary>
                    {canEdit &&
                      leadTimes.has(s.id) &&
                      leadTimes.get(s.id)!.days !== s.lead_time_days && (
                        <div className="pt-3">
                          <AdoptLeadTimeButton
                            slug={tenant.slug}
                            supplierId={s.id}
                            days={leadTimes.get(s.id)!.days}
                          />
                        </div>
                      )}
                    {canEdit ? (
                      <div className="pt-4">
                        <SupplierForm
                          slug={tenant.slug}
                          supplier={{ ...s, archived: Boolean(s.archived_at) }}
                        />
                      </div>
                    ) : (
                      s.notes && <p className="font-read pt-2 text-sm">{s.notes}</p>
                    )}
                    {(canEdit || closuresOf(s.id).length > 0) && (
                      <div className="border-border mt-4 flex flex-col gap-3 border-t pt-4">
                        <div>
                          <h3 className="text-sm font-semibold">When they&apos;re shut</h3>
                          <p className="text-muted-foreground font-read text-sm">
                            {closureWords(closuresOf(s.id), leadOf(s)).ahead ??
                              closureWords(closuresOf(s.id), leadOf(s)).now ??
                              "Holidays and shutdowns, when an order would just sit. We move the order-by dates for their items earlier, so each order arrives before they shut."}
                          </p>
                        </div>
                        {closuresOf(s.id).length > 0 && (
                          <ul className="divide-border flex flex-col divide-y text-sm">
                            {closuresOf(s.id).map((c) => (
                              <li
                                key={c.id}
                                className="flex flex-wrap items-center justify-between gap-2 py-1.5"
                              >
                                <span>
                                  <span className="font-semibold">{c.name}</span>{" "}
                                  <span className="text-muted-foreground">
                                    {c.startsOn === c.endsOn
                                      ? day(c.startsOn)
                                      : `${day(c.startsOn)} to ${day(c.endsOn)}`}
                                  </span>
                                </span>
                                {canEdit && (
                                  <form
                                    action={removeSupplierClosure.bind(null, tenant.slug, c.id!)}
                                  >
                                    <Button type="submit" variant="ghost" size="sm">
                                      Take off
                                    </Button>
                                  </form>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                        {canEdit && <ClosureForm slug={tenant.slug} supplierId={s.id} />}
                      </div>
                    )}
                  </details>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {canEdit ? (
        <Card>
          <CardHeader>
            <CardTitle>Add a supplier</CardTitle>
            <CardDescription>
              &quot;Days to arrive&quot; is from placing the order to having it on the shelf; leave
              it empty to use your usual figure from Settings ({settings.default_lead_time_days}{" "}
              days). &quot;Each order covers&quot; is how long you want one order to last. Once
              orders have arrived, we show how long each supplier really took, so you can match it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SupplierForm slug={tenant.slug} />
          </CardContent>
        </Card>
      ) : (
        suppliers.length === 0 && (
          <p className="text-muted-foreground text-sm">
            An owner or admin can add the first supplier.
          </p>
        )
      )}
    </>
  );
}
