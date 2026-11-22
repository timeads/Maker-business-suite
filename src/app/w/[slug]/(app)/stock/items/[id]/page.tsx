import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { formatMoney } from "@/lib/dashboard/format";
import { HEALTH_LABELS, relativeDay } from "@/lib/stock/plan";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { loadStock } from "../../data";
import { ItemPlanForm } from "../../forms";
import { stockAccess } from "../../gate";

export const metadata: Metadata = { title: "Stock item" };

export default async function StockItemPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const access = await stockAccess(slug, `/w/${slug}/stock/items/${id}`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const { rows, suppliers, settings, today } = await loadStock(await createClient(), tenant);
  const row = rows.find((r) => r.item.id === id);
  if (!row) notFound();
  const { plan, health, item } = row;
  const facts = [
    ["On the shelf", String(item.on_hand)],
    ["On its way", String(row.onOrder)],
    ["Sold in 30 days", String(plan.sales30d)],
    ["Sold in 90 days", String(plan.sales90d)],
    [
      "Sells about",
      plan.isDeadStock ? "nothing lately" : `${plan.velocityPerMonth.toFixed(1)} a month`,
    ],
    ["Runs out", relativeDay(plan.stockOutDate, today)],
    ["Order by", relativeDay(plan.reorderDate, today)],
    [
      "Costs you",
      item.unit_cost == null ? "not set in your shop" : formatMoney(row.unitCost, tenant.currency),
    ],
  ];

  return (
    <>
      <PageHeader
        back={{ href: `/w/${tenant.slug}/stock/items`, label: "Everything" }}
        title={row.name}
        description={[item.sku, row.supplier?.name ?? "No supplier yet"]
          .filter(Boolean)
          .join(" · ")}
      >
        <Badge
          tone={
            health.health === "out"
              ? "bad"
              : health.health === "under"
                ? "waiting"
                : health.health === "healthy"
                  ? "good"
                  : "closed"
          }
        >
          {HEALTH_LABELS[health.health]}
        </Badge>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>
            {plan.suggestedQty > 0 ? `Order ${plan.suggestedQty}` : "Nothing to order"}
          </CardTitle>
          <CardDescription>{health.reason}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted-foreground text-xs font-semibold">{label}</dt>
                <dd className="text-sm tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="bg-panel font-read rounded-md px-3 py-2 text-sm">
            <span className="text-muted-foreground">How we got there: </span>
            {plan.explain}
          </p>
        </CardContent>
      </Card>

      {canManage(role) && entitlements.canWrite && (
        <Card>
          <CardHeader>
            <CardTitle>Planning for this item</CardTitle>
          </CardHeader>
          <CardContent>
            <ItemPlanForm
              slug={tenant.slug}
              itemId={item.id}
              suppliers={suppliers
                .filter((s) => !s.archived_at || s.id === item.supplier_id)
                .map((s) => ({ id: s.id, name: s.name }))}
              values={item}
              fallback={{
                lead: row.supplier?.lead_time_days ?? settings.default_lead_time_days,
                cover: row.supplier?.coverage_days ?? settings.default_coverage_days,
              }}
            />
          </CardContent>
        </Card>
      )}
    </>
  );
}
