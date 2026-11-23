import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { formatMoney } from "@/lib/dashboard/format";
import { caseLabel } from "@/lib/stock/engine";
import {
  HEALTH_LABELS,
  NOT_PLANNED_LABELS,
  explainSuggestion,
  notPlannedReason,
  relativeDay,
} from "@/lib/stock/plan";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { loadStock } from "../../data";
import { ItemPlanForm, ReorderSwitch } from "../../forms";
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
  const left = notPlannedReason(row);
  const cases = caseLabel(row.suggestedQty, row.casePack);
  const manager = canManage(role) && entitlements.canWrite;
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
    ["Sells for", row.price == null ? "–" : formatMoney(row.price, tenant.currency)],
    ["Comes in", row.casePack ? `cases of ${row.casePack}` : "single units"],
    ["Smallest order", row.minimum > 1 ? String(row.minimum) : "no minimum"],
    ["Supplier's code", item.supplier_sku ?? "–"],
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
        {left && <Badge tone="closed">Not reordered</Badge>}
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>
            {left
              ? "Left out of reordering"
              : row.suggestedQty > 0
                ? `Order ${row.suggestedQty}${cases ? ` (${cases})` : ""}`
                : "Nothing to order"}
          </CardTitle>
          <CardDescription>
            {left ? `${NOT_PLANNED_LABELS[left]}. ` : ""}
            {health.reason}
          </CardDescription>
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
          <div className="bg-panel font-read rounded-md px-3 py-2 text-sm">
            <p>
              <span className="text-muted-foreground">How we got there: </span>
              {explainSuggestion(row, today)}
            </p>
            <p className="text-muted-foreground mt-1 text-xs">The sum: {plan.explain}</p>
          </div>
        </CardContent>
      </Card>

      {manager && (left === null || left === "hidden") && (
        <Card>
          <CardHeader>
            <CardTitle>Reordering</CardTitle>
          </CardHeader>
          <CardContent>
            <ReorderSwitch slug={tenant.slug} itemId={item.id} hidden={item.hidden} />
          </CardContent>
        </Card>
      )}
      {manager && left === "rule" && (
        <Card>
          <CardHeader className="pb-5">
            <CardTitle>Reordering</CardTitle>
            <CardDescription>
              This one is left out because its name matches a word under Stock → Settings
              (&quot;Never reorder anything with these words&quot;). Take the word off there to
              bring it back.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {manager && (
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
                moq: row.supplier?.moq_applies_to === "sku" ? row.supplier.moq : 1,
              }}
            />
          </CardContent>
        </Card>
      )}
    </>
  );
}
