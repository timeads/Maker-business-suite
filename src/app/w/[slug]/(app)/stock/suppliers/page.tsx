import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { loadStock } from "../data";
import { SupplierForm } from "../forms";
import { stockAccess } from "../gate";
import { StockTabs } from "../tabs";

export const metadata: Metadata = { title: "Suppliers" };

export default async function SuppliersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await stockAccess(slug, `/w/${slug}/stock/suppliers`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const canEdit = canManage(role) && entitlements.canWrite;
  const { suppliers, rows } = await loadStock(await createClient(), tenant);
  const itemCount = (id: string) => rows.filter((row) => row.item.supplier_id === id).length;

  return (
    <>
      <PageHeader
        title="Stock"
        description="Who you buy from, how long they take, and the smallest order they'll accept."
      />
      <StockTabs slug={tenant.slug} />

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
                        {s.lead_time_days} days · covers {s.coverage_days} days
                        {s.moq > 1 &&
                          ` · smallest order ${s.moq}${s.moq_applies_to === "sku" ? " per item" : ""}`}
                      </span>
                    </summary>
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
              &quot;Days to arrive&quot; is from placing the order to having it on the shelf.
              &quot;Each order covers&quot; is how long you want one order to last.
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
