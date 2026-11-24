import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormMessage } from "@/components/ui/form-message";
import { PageHeader } from "@/components/ui/page-header";
import { formatMoney } from "@/lib/dashboard/format";
import { trackingUrl } from "@/lib/shipping/carriers";
import { caseLabel, casePackOf, startingQty } from "@/lib/stock/engine";
import { ORDER_STATUS, explainSuggestion, isPlanned, itemName } from "@/lib/stock/plan";
import { computePoTotals, parseAdjustments } from "@/lib/stock/po/totals";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { loadStock } from "../../data";
import {
  PrintButton,
  ReceiveForm,
  RetryShopButton,
  StatusButton,
  type OrderLine,
} from "../../forms";
import { stockAccess } from "../../gate";
import { OrderForm, type AddableItem, type EditLine } from "./order-form";
import { AddShipmentForm, ShipmentList, type ShipmentRow } from "./shipments";

export const metadata: Metadata = { title: "Stock order" };

type Item = {
  id: string;
  title: string;
  variant_title: string | null;
  sku: string | null;
  case_pack: number | null;
};

const count = (value: string | undefined) => Math.max(0, Number.parseInt(value ?? "0", 10) || 0);

export default async function StockOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; number: string }>;
  searchParams: Promise<{ drafted?: string; nosupplier?: string; enough?: string; off?: string }>;
}) {
  const { slug, number } = await params;
  const access = await stockAccess(slug, `/w/${slug}/stock/orders/${number}`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  if (!/^\d{1,9}$/.test(number)) notFound();
  const flags = await searchParams;

  const supabase = await createClient();
  const { data: order } = await supabase
    .from("purchase_orders")
    .select(
      "id, number, status, notes, expected_on, ordered_at, supplier_id, shipping_cost, tax_rate_pct, adjustments, suppliers(name, email, notes), purchase_order_lines(id, stock_item_id, qty_ordered, qty_received, unit_cost, supplier_sku, note, stock_items(id, title, variant_title, sku, case_pack))",
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
      supplier_sku: string | null;
      note: string | null;
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
      supplier_sku: line.supplier_sku,
      note: line.note ?? "",
      case_pack: casePackOf(line.stock_items.case_pack),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const isDraft = order.status === "draft";
  const waiting = order.status === "ordered" || order.status === "partial";
  const manager = canManage(role) && entitlements.canWrite;
  const editable = manager && (isDraft || waiting);

  // Suggestions come from the same engine as everywhere else, worked out now.
  const stock = await loadStock(supabase, tenant);
  const [{ data: receipts }, { data: tracked }] = await Promise.all([
    supabase
      .from("stock_receipts")
      .select(
        "id, quantity, shop_status, shop_error, shop_attempts, shop_can_retry, created_at, stock_items(title, variant_title)",
      )
      .eq("tenant_id", tenant.id)
      .in(
        "po_line_id",
        lines.map((line) => line.id),
      )
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("purchase_order_shipments")
      .select("id, carrier, tracking, expected_on, arrived_on, note")
      .eq("tenant_id", tenant.id)
      .eq("po_id", order.id)
      .is("removed_at", null)
      .order("created_at"),
  ]);
  const { settings, link, rows, today } = stock;
  const rowById = new Map(rows.map((row) => [row.item.id, row]));
  const editLines: EditLine[] = lines.map((line) => {
    const row = rowById.get(line.stock_item_id);
    // Once an order has gone out its own units count as "on the way", so a
    // fresh suggestion would be for a further order: only drafts show one.
    return {
      ...line,
      suggested: row && isDraft ? row.suggestedQty : 0,
      why: row && isDraft ? explainSuggestion(row, today) : "",
    };
  });
  const onOrder = new Set(lines.map((line) => line.stock_item_id));
  const addable: AddableItem[] = editable
    ? rows
        .filter(
          (row) =>
            row.item.supplier_id === order.supplier_id &&
            isPlanned(row) &&
            !onOrder.has(row.item.id),
        )
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 800)
        .map((row) => ({
          id: row.item.id,
          name: row.name,
          cost: row.unitCost,
          start: startingQty(row.suggestedQty, row.casePack, row.minimum),
          case_pack: row.casePack,
          why: explainSuggestion(row, today),
        }))
    : [];

  const adjustments = parseAdjustments(order.adjustments);
  const shipping = String(order.shipping_cost ?? "0");
  const taxRate = String(order.tax_rate_pct ?? "0");
  const totals = computePoTotals({
    lines: lines.map((line) => ({
      qtyOrdered: line.qty_ordered,
      unitCost: line.unit_cost.toFixed(2),
    })),
    shippingCost: shipping,
    taxRatePct: taxRate,
    adjustments,
  });
  const extras = !totals.total.equals(totals.subtotal);
  const units = lines.reduce((n, line) => n + line.qty_ordered, 0);
  const status = ORDER_STATUS[order.status] ?? ORDER_STATUS.draft;
  const base = `/w/${tenant.slug}/stock`;
  const money = (value: number) => formatMoney(value, tenant.currency);
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    dateStyle: "medium",
    timeStyle: "short",
  });
  const day = (value: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "medium" }).format(
      new Date(`${value}T12:00:00Z`),
    );
  const late = waiting && order.expected_on !== null && (order.expected_on as string) < today;
  const shipments: ShipmentRow[] = (tracked ?? []).map((s) => ({
    id: s.id as string,
    carrier: s.carrier as string,
    tracking: s.tracking as string,
    expected: s.expected_on as string | null,
    expectedText: s.expected_on ? day(s.expected_on as string) : null,
    arrivedText: s.arrived_on ? day(s.arrived_on as string) : null,
    late: !s.arrived_on && Boolean(s.expected_on) && (s.expected_on as string) < today,
    note: s.note as string,
    url: trackingUrl(s.carrier as string, s.tracking as string),
  }));
  const SHOP_NOTES: Record<string, string> = {
    pending: "waiting to be added to your shop",
    sending: "being added to your shop",
    sent: "added to your shop's count",
    skipped: "not added to your shop",
    failed: "couldn't be added to your shop",
  };
  const leftOut = [
    count(flags.nosupplier) > 0 &&
      `${count(flags.nosupplier)} had no supplier (see Everything → No supplier)`,
    count(flags.enough) > 0 && `${count(flags.enough)} had enough in stock for now`,
    count(flags.off) > 0 && `${count(flags.off)} are set not to be reordered`,
  ].filter(Boolean);

  return (
    <>
      <PageHeader
        back={{ href: `${base}/orders`, label: "Orders" }}
        title={`Order #${order.number} · ${supplier.name}`}
        description={
          <>
            {tenant.name} · {units} units · {money(totals.total.toNumber())}
            {order.expected_on && ` · expected ${day(order.expected_on as string)}`}
          </>
        }
      >
        <Badge tone={status.tone}>{status.label}</Badge>
        {late && <Badge tone="bad">Late</Badge>}
        {lines.length > 0 && (
          <>
            <PrintButton />
            <Button asChild variant="outline" size="sm" className="print:hidden">
              <a href={`${base}/orders/${order.number}/sheet`}>
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

      {flags.drafted && isDraft && (
        <div className="print:hidden">
          <FormMessage kind="success">
            Drafted from your sales: every quantity below is what we&apos;d order now. Change
            anything, then save.
            {leftOut.length > 0 && ` Left off: ${leftOut.join("; ")}.`}
          </FormMessage>
        </div>
      )}

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
              pushOffered={link.canPush}
              pushDefault={settings.push_to_shop}
            />
          </CardContent>
        </Card>
      )}

      {!isDraft &&
        order.status !== "cancelled" &&
        (shipments.length > 0 || (manager && waiting)) && (
          <Card>
            <CardHeader>
              <CardTitle>On its way</CardTitle>
              <CardDescription>
                {manager && waiting
                  ? "Add the tracking number the supplier sends you. One order can come in several parcels."
                  : "The tracking numbers for this order."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <ShipmentList
                slug={tenant.slug}
                orderId={order.id}
                shipments={shipments}
                canEdit={manager && waiting}
              />
              {manager && waiting && <AddShipmentForm slug={tenant.slug} orderId={order.id} />}
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
          {editable ? (
            <OrderForm
              slug={tenant.slug}
              orderId={order.id}
              placed={!isDraft}
              lines={editLines}
              notes={order.notes}
              expected={order.expected_on}
              shipping={shipping}
              tax={taxRate}
              adjustments={adjustments}
              addable={addable}
              currency={tenant.currency}
            />
          ) : lines.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing on this order.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="text-muted-foreground text-xs">
                  <tr>
                    <th className="py-2 pr-3 font-semibold">Item</th>
                    <th className="py-2 pr-3 font-semibold">Supplier&apos;s code</th>
                    <th className="py-2 pr-3 text-right font-semibold">Ordered</th>
                    <th className="py-2 pr-3 text-right font-semibold print:hidden">Arrived</th>
                    <th className="py-2 pr-3 text-right font-semibold">Cost each</th>
                    <th className="py-2 text-right font-semibold">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {lines.map((line) => (
                    <tr key={line.id} className="align-top">
                      <td className="py-2 pr-3">
                        <span className="font-read">{line.name}</span>
                        {line.sku && (
                          <span className="text-muted-foreground block text-xs">{line.sku}</span>
                        )}
                        {line.note && <span className="font-read block text-xs">{line.note}</span>}
                      </td>
                      <td className="py-2 pr-3">{line.supplier_sku ?? "–"}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {line.qty_ordered}
                        {caseLabel(line.qty_ordered, line.case_pack) && (
                          <span className="text-muted-foreground block text-xs">
                            {caseLabel(line.qty_ordered, line.case_pack)}
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums print:hidden">
                        {line.qty_received}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{money(line.unit_cost)}</td>
                      <td className="py-2 text-right tabular-nums">
                        {money(
                          computePoTotals({
                            lines: [
                              { qtyOrdered: line.qty_ordered, unitCost: line.unit_cost.toFixed(2) },
                            ],
                            shippingCost: 0,
                            taxRatePct: 0,
                            adjustments: [],
                          }).subtotal.toNumber(),
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="tabular-nums">
                  <tr className="border-border border-t font-semibold">
                    <td className="py-2 pr-3">{extras ? "Items" : "Total"}</td>
                    <td />
                    <td className="py-2 pr-3 text-right">{units}</td>
                    <td className="print:hidden" />
                    <td />
                    <td className="py-2 text-right">{money(totals.subtotal.toNumber())}</td>
                  </tr>
                  {!totals.shipping.isZero() && (
                    <tr>
                      <td className="py-1 pr-3" colSpan={5}>
                        Shipping
                      </td>
                      <td className="py-1 text-right">{money(totals.shipping.toNumber())}</td>
                    </tr>
                  )}
                  {!totals.tax.isZero() && (
                    <tr>
                      <td className="py-1 pr-3" colSpan={5}>
                        Tax ({Number(taxRate)}%)
                      </td>
                      <td className="py-1 text-right">{money(totals.tax.toNumber())}</td>
                    </tr>
                  )}
                  {adjustments.map((adjustment, index) => (
                    <tr key={index}>
                      <td className="font-read py-1 pr-3" colSpan={5}>
                        {adjustment.label}
                      </td>
                      <td className="py-1 text-right">{money(Number(adjustment.amount))}</td>
                    </tr>
                  ))}
                  {extras && (
                    <tr className="border-border border-t font-semibold">
                      <td className="py-2 pr-3" colSpan={5}>
                        Total
                      </td>
                      <td className="py-2 text-right">{money(totals.total.toNumber())}</td>
                    </tr>
                  )}
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
                    {itemName(
                      receipt.stock_items as unknown as Pick<Item, "title" | "variant_title">,
                    )}
                  </span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {when.format(new Date(receipt.created_at as string))} ·{" "}
                    {SHOP_NOTES[receipt.shop_status as string]}
                    {receipt.shop_status === "failed" && receipt.shop_error
                      ? ` (${receipt.shop_error})`
                      : ""}
                    {(receipt.shop_attempts as number) > 1
                      ? ` · asked ${receipt.shop_attempts} times`
                      : ""}
                  </span>
                  {receipt.shop_status === "failed" &&
                    (receipt.shop_can_retry && manager && link.canPush ? (
                      <RetryShopButton slug={tenant.slug} receiptId={receipt.id as string} />
                    ) : (
                      <span className="text-muted-foreground block text-xs">
                        {receipt.shop_can_retry
                          ? manager
                            ? "Your shop isn't letting us add to its count right now, so add these there by hand."
                            : "An owner or admin can ask the shop again from here."
                          : "We won't send this one again, in case it did reach your shop. Check the count there and fix it by hand if it's short."}
                      </span>
                    ))}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {manager && (isDraft || waiting) && (
        <div className="flex flex-wrap justify-end gap-2 print:hidden">
          {isDraft && (
            <Button asChild variant="ghost" size="sm">
              <Link href={`${base}/items`}>Pick more items</Link>
            </Button>
          )}
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
