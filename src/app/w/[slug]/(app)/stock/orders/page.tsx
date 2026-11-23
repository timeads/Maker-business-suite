import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { formatMoney } from "@/lib/dashboard/format";
import { ORDER_STATUS } from "@/lib/stock/plan";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { NewOrderForm } from "../forms";
import { stockAccess } from "../gate";
import { StockTabs } from "../tabs";

export const metadata: Metadata = { title: "Stock orders" };

type Row = {
  id: string;
  number: number;
  status: string;
  expected_on: string | null;
  created_at: string;
  suppliers: { name: string } | null;
  purchase_order_lines: { qty_ordered: number; qty_received: number; unit_cost: number }[];
};

export default async function StockOrdersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await stockAccess(slug, `/w/${slug}/stock/orders`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const supabase = await createClient();
  const [{ data }, { data: suppliers }] = await Promise.all([
    supabase
      .from("purchase_orders")
      .select(
        "id, number, status, expected_on, created_at, suppliers(name), purchase_order_lines(qty_ordered, qty_received, unit_cost)",
      )
      .eq("tenant_id", tenant.id)
      .order("number", { ascending: false })
      .limit(200),
    supabase
      .from("suppliers")
      .select("id, name")
      .eq("tenant_id", tenant.id)
      .is("archived_at", null)
      .order("name"),
  ]);
  const orders = (data ?? []) as unknown as Row[];
  const open = orders.filter((o) => ["draft", "ordered", "partial"].includes(o.status));
  const past = orders.filter((o) => !["draft", "ordered", "partial"].includes(o.status));
  const day = (value: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(
      new Date(`${value.slice(0, 10)}T12:00:00Z`),
    );
  const list = (rows: Row[]) => (
    <ul className="divide-border flex flex-col divide-y">
      {rows.map((order) => {
        const units = order.purchase_order_lines.reduce((n, l) => n + l.qty_ordered, 0);
        const got = order.purchase_order_lines.reduce((n, l) => n + l.qty_received, 0);
        const cost = order.purchase_order_lines.reduce(
          (n, l) => n + l.qty_ordered * Number(l.unit_cost),
          0,
        );
        const status = ORDER_STATUS[order.status] ?? ORDER_STATUS.draft;
        return (
          <li key={order.id}>
            <Link
              href={`/w/${tenant.slug}/stock/orders/${order.number}`}
              className="hover:bg-hover -mx-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-sm px-2 py-2.5 text-sm"
            >
              <span className="text-muted-foreground w-14 tabular-nums">#{order.number}</span>
              <span className="min-w-0 flex-1 basis-40 font-semibold">{order.suppliers?.name}</span>
              <Badge tone={status.tone}>{status.label}</Badge>
              <span className="text-muted-foreground w-44 text-right tabular-nums">
                {order.status === "partial" ? `${got} of ${units}` : units} units ·{" "}
                {formatMoney(cost, tenant.currency)}
              </span>
              <span className="text-muted-foreground w-28 text-right">
                {order.expected_on && ["ordered", "partial"].includes(order.status)
                  ? `due ${day(order.expected_on)}`
                  : day(order.created_at)}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );

  return (
    <>
      <PageHeader title="Stock" description="What you've ordered, and what has arrived." />
      <StockTabs slug={tenant.slug} manager={canManage(role)} />
      <Card>
        <CardHeader>
          <CardTitle>Open orders</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {open.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing on order. Suggested orders are under &quot;To order&quot;.
            </p>
          ) : (
            list(open)
          )}
          {canManage(role) && entitlements.canWrite && (suppliers ?? []).length > 0 && (
            <div className="border-border border-t pt-4">
              <NewOrderForm
                slug={tenant.slug}
                suppliers={(suppliers ?? []) as { id: string; name: string }[]}
              />
            </div>
          )}
        </CardContent>
      </Card>
      {past.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Finished</CardTitle>
          </CardHeader>
          <CardContent>{list(past)}</CardContent>
        </Card>
      )}
    </>
  );
}
