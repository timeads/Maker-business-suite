import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { canWriteShopifyStock } from "@/lib/connections/providers/shopify-stock";
import { formatMoney } from "@/lib/dashboard/format";
import { STOCK_MODULE, STOCK_SETTINGS_KEY, parseStockSettings } from "@/lib/stock/config";
import { ORDER_STATUS, itemName } from "@/lib/stock/plan";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import {
  DraftOrderForm,
  PrintButton,
  ReceiveForm,
  StatusButton,
  type OrderLine,
} from "../../forms";
import { stockAccess } from "../../gate";

export const metadata: Metadata = { title: "Stock order" };

type Item = { id: string; title: string; variant_title: string | null; sku: string | null };

export default async function StockOrderPage({
  params,
}: {
  params: Promise<{ slug: string; number: string }>;
}) {
  const { slug, number } = await params;
  const access = await stockAccess(slug, `/w/${slug}/stock/orders/${number}`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  if (!/^\d{1,9}$/.test(number)) notFound();

  const supabase = await createClient();
  const { data: order } = await supabase
    .from("purchase_orders")
    .select(
      "id, number, status, notes, expected_on, ordered_at, supplier_id, suppliers(name, email, notes), purchase_order_lines(id, stock_item_id, qty_ordered, qty_received, unit_cost, stock_items(id, title, variant_title, sku))",
    )
    .eq("tenant_id", tenant.id)
    .eq("number", Number(number))
    .maybeSingle();
  if (!order) notFound();
  const supplier = order.suppliers as unknown as { name: string; email: string | null };
  const lines: OrderLine[] = (
    order.purchase_order_lines as unknown as {
      id: string;
      stock_item_id: string;
      qty_ordered: number;
      qty_received: number;
      unit_cost: number;
      stock_items: Item;
    }[]
  )
    .filter((line) => line.qty_ordered > 0 || line.qty_received > 0)
    .map((line) => ({
      id: line.id,
      stock_item_id: line.stock_item_id,
      name: itemName(line.stock_items),
      sku: line.stock_items.sku,
      qty_ordered: line.qty_ordered,
      qty_received: line.qty_received,
      unit_cost: Number(line.unit_cost),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const isDraft = order.status === "draft";
  const waiting = order.status === "ordered" || order.status === "partial";
  const manager = canManage(role) && entitlements.canWrite;
  const [{ data: theirs }, { data: config }, { data: shop }, { data: receipts }] =
    await Promise.all([
      isDraft && manager
        ? supabase
            .from("stock_items")
            .select("id, title, variant_title, sku, unit_cost")
            .eq("tenant_id", tenant.id)
            .eq("supplier_id", order.supplier_id)
            .eq("hidden", false)
            .order("title")
            .limit(500)
        : Promise.resolve({ data: [] }),
      supabase
        .from("configs")
        .select("body")
        .eq("tenant_id", tenant.id)
        .eq("module", STOCK_MODULE)
        .eq("key", STOCK_SETTINGS_KEY)
        .maybeSingle(),
      supabase
        .from("connections")
        .select("status, metadata")
        .eq("tenant_id", tenant.id)
        .eq("provider", "shopify")
        .maybeSingle(),
      supabase
        .from("stock_receipts")
        .select(
          "id, quantity, shop_status, shop_error, created_at, stock_items(title, variant_title)",
        )
        .eq("tenant_id", tenant.id)
        .in(
          "po_line_id",
          lines.map((line) => line.id),
        )
        .order("created_at", { ascending: false })
        .limit(50),
    ]);
  const settings = parseStockSettings(config?.body);
  const canPush =
    shop?.status === "active" &&
    canWriteShopifyStock((shop.metadata as { scopes?: unknown } | null)?.scopes);
  const onOrder = new Set(lines.map((line) => line.stock_item_id));
  const addable = ((theirs ?? []) as (Item & { unit_cost: number | null })[])
    .filter((item) => !onOrder.has(item.id))
    .map((item) => ({ id: item.id, name: itemName(item), cost: Number(item.unit_cost ?? 0) }));
  const total = lines.reduce((sum, line) => sum + line.qty_ordered * line.unit_cost, 0);
  const units = lines.reduce((n, line) => n + line.qty_ordered, 0);
  const status = ORDER_STATUS[order.status] ?? ORDER_STATUS.draft;
  const base = `/w/${tenant.slug}/stock/orders`;
  const money = (value: number) => formatMoney(value, tenant.currency);
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    dateStyle: "medium",
    timeStyle: "short",
  });
  const SHOP_NOTES: Record<string, string> = {
    pending: "waiting to be added to your shop",
    sending: "being added to your shop",
    sent: "added to your shop's count",
    skipped: "not added to your shop",
    failed: "couldn't be added to your shop",
  };

  return (
    <>
      <PageHeader
        back={{ href: base, label: "Orders" }}
        title={`Order #${order.number} · ${supplier.name}`}
        description={
          <>
            {tenant.name} · {units} units · {money(total)}
            {order.expected_on &&
              ` · expected ${new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium" }).format(new Date(`${order.expected_on}T12:00:00Z`))}`}
          </>
        }
      >
        <Badge tone={status.tone}>{status.label}</Badge>
        {lines.length > 0 && (
          <>
            <PrintButton />
            <Button asChild variant="outline" size="sm" className="print:hidden">
              <a href={`${base}/${order.number}/sheet`}>
                <Download /> Spreadsheet
              </a>
            </Button>
          </>
        )}
        {manager && isDraft && (
          <StatusButton
            slug={tenant.slug}
            orderId={order.id}
            to="ordered"
            label="I've sent this order"
            pending="Saving…"
            variant="default"
          />
        )}
      </PageHeader>

      {waiting && entitlements.canWrite && (
        <Card className="print:hidden">
          <CardHeader>
            <CardTitle>Check in a delivery</CardTitle>
            <CardDescription>
              Type what arrived. If it&apos;s only part of the order, the rest stays open.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ReceiveForm
              slug={tenant.slug}
              orderId={order.id}
              lines={lines}
              pushOffered={canPush}
              pushDefault={settings.push_to_shop}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{isDraft ? "What's on it" : "The order"}</CardTitle>
          {isDraft && (
            <CardDescription>
              Change anything, save, then print or download it to send to {supplier.name}
              {supplier.email ? ` (${supplier.email})` : ""}.
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {isDraft && manager ? (
            <DraftOrderForm
              slug={tenant.slug}
              orderId={order.id}
              lines={lines}
              notes={order.notes}
              expected={order.expected_on}
              addable={addable}
              currency={tenant.currency}
            />
          ) : lines.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing on this order.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead className="text-muted-foreground text-xs">
                  <tr>
                    <th className="py-2 pr-3 font-semibold">Item</th>
                    <th className="py-2 pr-3 text-right font-semibold">Ordered</th>
                    <th className="py-2 pr-3 text-right font-semibold print:hidden">Arrived</th>
                    <th className="py-2 pr-3 text-right font-semibold">Cost each</th>
                    <th className="py-2 text-right font-semibold">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {lines.map((line) => (
                    <tr key={line.id}>
                      <td className="py-2 pr-3">
                        <span className="font-read">{line.name}</span>
                        {line.sku && (
                          <span className="text-muted-foreground block text-xs">{line.sku}</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{line.qty_ordered}</td>
                      <td className="py-2 pr-3 text-right tabular-nums print:hidden">
                        {line.qty_received}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{money(line.unit_cost)}</td>
                      <td className="py-2 text-right tabular-nums">
                        {money(line.qty_ordered * line.unit_cost)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-border border-t font-semibold">
                    <td className="py-2 pr-3">Total</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{units}</td>
                    <td className="print:hidden" />
                    <td />
                    <td className="py-2 text-right tabular-nums">{money(total)}</td>
                  </tr>
                </tfoot>
              </table>
              {order.notes && <p className="font-read mt-3 text-sm">{order.notes}</p>}
            </div>
          )}
        </CardContent>
      </Card>

      {(receipts ?? []).length > 0 && (
        <Card className="print:hidden">
          <CardHeader>
            <CardTitle>What&apos;s been checked in</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1.5 text-sm">
              {(receipts ?? []).map((receipt) => (
                <li key={receipt.id}>
                  <span className="tabular-nums">{receipt.quantity}</span> ×{" "}
                  <span className="font-read">
                    {itemName(receipt.stock_items as unknown as Item)}
                  </span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {when.format(new Date(receipt.created_at as string))} ·{" "}
                    {SHOP_NOTES[receipt.shop_status as string]}
                    {receipt.shop_status === "failed" && receipt.shop_error
                      ? ` (${receipt.shop_error})`
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {manager && (isDraft || waiting) && (
        <div className="flex flex-wrap justify-end gap-2 print:hidden">
          {order.status === "ordered" && (
            <StatusButton
              slug={tenant.slug}
              orderId={order.id}
              to="draft"
              label="Back to draft"
              pending="Saving…"
              variant="ghost"
            />
          )}
          {waiting && (
            <StatusButton
              slug={tenant.slug}
              orderId={order.id}
              to="closed"
              label="Close it: the rest isn't coming"
              pending="Closing…"
              variant="ghost"
            />
          )}
          {(isDraft || order.status === "ordered") && (
            <StatusButton
              slug={tenant.slug}
              orderId={order.id}
              to="cancelled"
              label="Cancel this order"
              pending="Cancelling…"
              variant="danger"
            />
          )}
        </div>
      )}
    </>
  );
}
