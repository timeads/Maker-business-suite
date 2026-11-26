import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { localDay } from "@/lib/bookings/slots";
import { loadSupplies, type SupplyFigures } from "@/lib/bookings/studio-data";
import { daysWords } from "@/lib/bookings/supplies";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { bookingsAccess } from "../gate";

export const metadata: Metadata = { title: "Classroom supplies" };

const amount = (qty: number, unit: string) =>
  `${Number.isInteger(qty) ? qty : qty.toFixed(2).replace(/\.?0+$/, "")}${unit ? ` ${unit}` : ""}`;

/**
 * Classroom supplies: what's on hand, what each person uses, when it runs
 * out with the classes booked, and what to order. Every figure is worked out
 * as the page is drawn; only what a person said is stored.
 */
export default async function SuppliesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await bookingsAccess(slug, `/w/${slug}/bookings/supplies`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const manager = canManage(role) && entitlements.canWrite;
  const supabase = await createClient();
  const now = new Date();
  const [{ figures, vendors, error }, { data: services }] = await Promise.all([
    loadSupplies(supabase, tenant.id, tenant.timezone, now),
    supabase
      .from("services")
      .select("id, name, active")
      .eq("tenant_id", tenant.id)
      .eq("kind", "workshop"),
  ]);
  const workshops = (services ?? []) as { id: string; name: string; active: boolean }[];
  const vendorName = new Map(vendors.map((v) => [v.id, v.name]));
  const day = (instant: Date) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: tenant.timezone,
      month: "short",
      day: "numeric",
    }).format(instant);
  const shortDay = (ymd: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(
      new Date(`${ymd}T12:00:00Z`),
    );
  const usedIn = (f: SupplyFigures) => {
    if (f.linked.size === 0) return "No classes, so it isn't used up";
    const live = workshops.filter((w) => w.active);
    if (live.length > 0 && live.every((w) => f.linked.has(w.id))) return "Every class";
    return workshops
      .filter((w) => f.linked.has(w.id))
      .map((w) => w.name)
      .join(", ");
  };
  const status = (f: SupplyFigures) => {
    const p = f.projection;
    if (f.incoming > 0 && f.arriving) {
      return (
        <div className="flex flex-col items-start gap-1">
          <Badge tone={p.status === "ok" ? "open" : "bad"}>Arriving {shortDay(f.arriving)}</Badge>
          {p.status !== "ok" && (
            <span className="text-brick text-xs">
              Dips {Math.ceil(p.shortBy)} into the buffer around {day(p.dipOn)}
            </span>
          )}
        </div>
      );
    }
    if (p.status === "order_now") return <Badge tone="bad">Order now</Badge>;
    if (p.status === "order_by") return <Badge tone="waiting">Order by {day(p.orderBy)}</Badge>;
    return <Badge tone="good">Enough</Badge>;
  };
  const nextOrder = (f: SupplyFigures) => {
    if (f.projection.status !== "ok") {
      return daysWords(Math.ceil((f.projection.orderBy.getTime() - now.getTime()) / 86_400_000));
    }
    if (f.estimateDays === null) return "—";
    return `about ${daysWords(f.estimateDays)}`;
  };
  const suggestions = figures.filter((f) => f.suggested > 0);
  const active = figures.filter((f) => f.supply.active);
  const resting = figures.filter((f) => !f.supply.active);

  return (
    <>
      <PageHeader
        title="Classroom supplies"
        description="What your classes use up, how much is left after the classes booked, and when to order more."
      >
        {manager && (
          <Button asChild>
            <Link href={`/w/${tenant.slug}/bookings/supplies/new`}>Add a supply</Link>
          </Button>
        )}
      </PageHeader>

      {suggestions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Worth ordering</CardTitle>
            <CardDescription>
              Enough to see you through the lead time and the weeks each order should last, at the
              number of people your classes have had lately, plus your buffer.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-border flex flex-col divide-y text-sm">
              {suggestions.map((f) => (
                <li key={f.supply.id} className="flex flex-wrap items-center gap-3 py-2">
                  <Link
                    href={`/w/${tenant.slug}/bookings/supplies/${f.supply.id}`}
                    className="font-semibold hover:underline"
                  >
                    {f.supply.name}
                  </Link>
                  <span>{amount(f.suggested, f.supply.unit)}</span>
                  {f.supply.vendor_id && (
                    <span className="text-muted-foreground">
                      from {vendorName.get(f.supply.vendor_id)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="pt-5">
          {error ? (
            <p className="text-muted-foreground text-sm">
              The list couldn&apos;t be read just now. Try again in a minute.
            </p>
          ) : figures.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing here yet. Add what your classes use up (backing cloth, yarn, glue) and how
              much one person uses, and the list tells you when to order.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="text-muted-foreground text-xs">
                  <tr>
                    <th className="py-2 pr-4 font-semibold">Supply</th>
                    <th className="py-2 pr-4 font-semibold">On hand</th>
                    <th className="py-2 pr-4 font-semibold">Each person</th>
                    <th className="py-2 pr-4 font-semibold">Lead time</th>
                    <th className="py-2 pr-4 font-semibold">How it looks</th>
                    <th className="py-2 font-semibold">Next order</th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {[...active, ...resting].map((f) => (
                    <tr key={f.supply.id} className="align-top">
                      <td className="py-2.5 pr-4">
                        <Link
                          href={`/w/${tenant.slug}/bookings/supplies/${f.supply.id}`}
                          className="font-semibold hover:underline"
                        >
                          {f.supply.name}
                        </Link>
                        <span className="text-muted-foreground block text-xs">
                          {f.supply.vendor_id ? `${vendorName.get(f.supply.vendor_id)} · ` : ""}
                          {usedIn(f)}
                        </span>
                      </td>
                      <td className="py-2.5 pr-4 tabular-nums">
                        {amount(f.stock.qty, f.supply.unit)}
                        {f.incoming > 0 && (
                          <span className="text-muted-foreground block text-xs">
                            {amount(f.incoming, f.supply.unit)} on its way
                          </span>
                        )}
                        {f.stock.short > 0 && (
                          <span className="text-brick block text-xs">
                            Classes needed {amount(f.stock.short, f.supply.unit)} more than there
                            was
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 tabular-nums">
                        {amount(f.supply.per_student, f.supply.unit)}
                      </td>
                      <td className="py-2.5 pr-4">
                        {f.supply.lead_time_days} day{f.supply.lead_time_days === 1 ? "" : "s"}
                      </td>
                      <td className="py-2.5 pr-4">
                        {f.supply.active ? status(f) : <Badge tone="closed">Not used now</Badge>}
                      </td>
                      <td className="py-2.5">{f.supply.active ? nextOrder(f) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-muted-foreground mt-4 text-xs">
            On hand is your last count, plus what arrived since, less what each class used (its
            places × what one person uses) once it started, worked out as of today (
            {localDay(now, tenant.timezone)}). “About” dates come from the number of people your
            classes have had over the last eight weeks.
          </p>
        </CardContent>
      </Card>
    </>
  );
}
