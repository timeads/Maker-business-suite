import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { type Closure } from "@/lib/stock/engine/closures";
import { orderCountsBySupplier } from "@/lib/stock/po/list";
import { joinEmails } from "@/lib/stock/suppliers/table";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { removeSupplierClosure } from "../../actions";
import { TermsForm } from "../../balances/forms";
import { loadIncoming, loadStock } from "../../data";
import { ClosureForm, SupplierForm } from "../../forms";
import { stockAccess } from "../../gate";
import { closureDay, closureWords } from "../closure-words";

export const metadata: Metadata = { title: "Supplier" };

/**
 * Everything about one supplier that the table has no column for: how long
 * an order should last, when they're shut, days to pay, notes, and the ways
 * to their orders, their account and bills by email.
 */
export default async function SupplierPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const access = await stockAccess(slug, `/w/${slug}/stock/suppliers/${id}`);
  if (!access.ok) return access.upsell;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { tenant, role, entitlements } = access;
  const manager = canManage(role);
  const canEdit = manager && entitlements.canWrite;
  const supabase = await createClient();
  const [
    { suppliers, rows, closures, today, settings },
    { leadTimes },
    { data: orderRows },
    terms,
  ] = await Promise.all([
    loadStock(supabase, tenant),
    loadIncoming(supabase, tenant),
    supabase
      .from("purchase_orders")
      .select("supplier_id, status")
      .eq("tenant_id", tenant.id)
      .eq("supplier_id", id)
      .limit(5000),
    // Days to pay belongs with Balances, which is for owners and admins.
    manager
      ? supabase
          .from("suppliers")
          .select("payment_terms_days")
          .eq("tenant_id", tenant.id)
          .eq("id", id)
          .maybeSingle()
      : null,
  ]);
  const s = suppliers.find((supplier) => supplier.id === id.toLowerCase());
  if (!s) notFound();
  const base = `/w/${tenant.slug}/stock`;
  const usual = settings.default_lead_time_days;
  const lead = s.lead_time_days ?? usual;
  const shut: Closure[] = closures
    .filter((c) => c.supplier_id === s.id)
    .map((c) => ({ id: c.id, name: c.name, startsOn: c.starts_on, endsOn: c.ends_on }));
  const words = closureWords(shut, lead, today);
  const observed = leadTimes.get(s.id);
  const orders =
    orderCountsBySupplier(
      (orderRows ?? []).map((order) => ({
        supplierId: order.supplier_id as string,
        status: order.status as string,
      })),
    ).get(s.id) ?? 0;
  const items = rows.filter((row) => row.item.supplier_id === s.id).length;
  const emails = joinEmails(s.email, s.more_emails);
  const termsDays = (terms?.data as { payment_terms_days: number } | null)?.payment_terms_days;
  const fact = "flex flex-col gap-0.5";
  const term = "text-muted-foreground text-xs font-semibold";

  return (
    <>
      <PageHeader
        back={{
          href: `${base}/suppliers${s.archived_at ? "?show=archived" : ""}`,
          label: "Suppliers",
        }}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {s.name}
            {s.archived_at && <Badge>Archived</Badge>}
            {words.now ? (
              <Badge tone="bad">{words.now}</Badge>
            ) : (
              words.aheadShort && (
                <Badge tone={words.missed ? "bad" : "waiting"}>{words.aheadShort}</Badge>
              )
            )}
          </span>
        }
        description={`${items} item${items === 1 ? "" : "s"} · arrives in ${lead} days${s.lead_time_days === null ? " (your usual)" : ""} · each order covers ${s.coverage_days} days`}
      >
        <Button asChild variant="outline" size="sm">
          <Link href={`${base}/orders?show=all&supplier=${s.id}`}>
            {orders === 0 ? "No orders yet" : `${orders} order${orders === 1 ? "" : "s"}`}
          </Link>
        </Button>
        {manager && (
          <Button asChild variant="outline" size="sm">
            <Link href={`${base}/balances/${s.id}`}>Their balance</Link>
          </Button>
        )}
      </PageHeader>

      {s.archived_at && (
        <p className="text-muted-foreground font-read text-sm">
          Archived: we don&apos;t suggest orders for their items. Their orders and account are kept,
          and “Bring back” on the Suppliers page undoes it.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
          {observed && (
            <CardDescription>
              Their orders have really taken about {observed.days} days to arrive (worked out from{" "}
              {observed.sampleSize} order{observed.sampleSize === 1 ? "" : "s"}). “Use” in the
              Suppliers table sets the lead time to that.
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {canEdit ? (
            <SupplierForm
              slug={tenant.slug}
              usualLeadDays={usual}
              supplier={{ ...s, archived: Boolean(s.archived_at) }}
            />
          ) : (
            <dl className="grid gap-4 text-sm sm:grid-cols-3">
              <div className={fact}>
                <dt className={term}>Contact</dt>
                <dd className="font-read">{s.contact_name || "–"}</dd>
              </div>
              <div className={`${fact} sm:col-span-2`}>
                <dt className={term}>Email</dt>
                <dd className="font-read break-words">{emails || "–"}</dd>
              </div>
              <div className={fact}>
                <dt className={term}>Lead time (days)</dt>
                <dd>
                  {lead}
                  {s.lead_time_days === null && (
                    <span className="text-muted-foreground"> (your usual)</span>
                  )}
                </dd>
              </div>
              <div className={fact}>
                <dt className={term}>MOQ</dt>
                <dd>
                  {s.moq} · {s.moq_applies_to === "sku" ? "Each SKU" : "Per order"}
                </dd>
              </div>
              <div className={fact}>
                <dt className={term}>Each order covers (days)</dt>
                <dd>{s.coverage_days}</dd>
              </div>
              {s.notes && (
                <div className={`${fact} sm:col-span-3`}>
                  <dt className={term}>Notes</dt>
                  <dd className="font-read whitespace-pre-wrap">{s.notes}</dd>
                </div>
              )}
            </dl>
          )}
        </CardContent>
      </Card>

      {(canEdit || shut.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>When they&apos;re shut</CardTitle>
            <CardDescription>
              {words.ahead ??
                words.now ??
                "Holidays and shutdowns, when an order would just sit. We move the order-by dates for their items earlier, so each order arrives before they shut."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {shut.length > 0 && (
              <ul className="divide-border flex flex-col divide-y text-sm">
                {shut.map((c) => (
                  <li
                    key={c.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-1.5"
                  >
                    <span>
                      <span className="font-semibold">{c.name}</span>{" "}
                      <span className="text-muted-foreground">
                        {c.startsOn === c.endsOn
                          ? closureDay(c.startsOn, today)
                          : `${closureDay(c.startsOn, today)} to ${closureDay(c.endsOn, today)}`}
                      </span>
                    </span>
                    {canEdit && (
                      <form action={removeSupplierClosure.bind(null, tenant.slug, c.id!)}>
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
          </CardContent>
        </Card>
      )}

      {manager && (
        <Card>
          <CardHeader>
            <CardTitle>Paying them</CardTitle>
            <CardDescription>
              Used to work out when each of their bills is due.{" "}
              <Link
                href={`${base}/balances/${s.id}`}
                className="text-ochre-text underline-offset-2 hover:underline"
              >
                See what you owe them
              </Link>
              , or{" "}
              <Link
                href={`${base}/balances/email`}
                className="text-ochre-text underline-offset-2 hover:underline"
              >
                have their bills read from email
              </Link>
              .
            </CardDescription>
          </CardHeader>
          <CardContent>
            {canEdit && termsDays !== undefined ? (
              <TermsForm slug={tenant.slug} supplierId={s.id} days={termsDays} />
            ) : (
              termsDays !== undefined && (
                <p className="text-sm">{termsDays} days to pay after the invoice date.</p>
              )
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
