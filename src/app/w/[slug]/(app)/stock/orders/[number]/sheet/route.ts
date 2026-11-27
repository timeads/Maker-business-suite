import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { csvCell } from "@/lib/bookings/emails";
import { getEntitlements } from "@/lib/entitlements";
import { caseLabel } from "@/lib/stock/engine";
import { itemName } from "@/lib/stock/plan";
import { computePoTotals, parseAdjustments } from "@/lib/stock/po/totals";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";

/** One order as a spreadsheet file, to send to the supplier. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; number: string }> },
) {
  const { slug, number } = await params;
  const user = await requireUser(`/w/${slug}/stock/orders/${number}`);
  const ctx = await getTenantContext(slug, user.id);
  const missing = new NextResponse("Not found", { status: 404 });
  if (!ctx || !/^\d{1,9}$/.test(number)) return missing;
  const entitlements = await getEntitlements(ctx.tenant.id);
  // An order's sheet is what the business pays: kept from members once the
  // workspace chooses tools per person (docs/roles.md).
  if (!entitlements.can("module.stock") || !entitlements.seesCosts) return missing;

  const supabase = await createClient();
  const { data: order } = await supabase
    .from("purchase_orders")
    .select(
      "number, reference, shipping_cost, tax_rate_pct, adjustments, purchase_order_lines(qty_ordered, unit_cost, supplier_sku, note, stock_items(title, variant_title, sku, case_pack))",
    )
    .eq("tenant_id", ctx.tenant.id)
    .eq("number", Number(number))
    .maybeSingle();
  if (!order) return missing;
  const lines = (
    order.purchase_order_lines as unknown as {
      qty_ordered: number;
      unit_cost: number;
      supplier_sku: string | null;
      note: string | null;
      stock_items: {
        title: string;
        variant_title: string | null;
        sku: string | null;
        case_pack: number | null;
      };
    }[]
  ).filter((line) => line.qty_ordered > 0);
  const priced = lines.map((line) => ({
    qtyOrdered: line.qty_ordered,
    unitCost: Number(line.unit_cost).toFixed(2),
  }));
  const adjustments = parseAdjustments(order.adjustments);
  const totals = computePoTotals({
    lines: priced,
    shippingCost: String(order.shipping_cost ?? "0"),
    taxRatePct: String(order.tax_rate_pct ?? "0"),
    adjustments,
  });
  const lineTotal = (index: number) =>
    computePoTotals({
      lines: [priced[index]],
      shippingCost: 0,
      taxRatePct: 0,
      adjustments: [],
    }).subtotal.toFixed(2);
  const footer = (label: string, value: string) => ["", "", label, "", "", "", value, ""];
  const rows: (string | number)[][] = [
    ["Purchase order", order.reference as string, "", "", "", "", "", ""],
    ["SKU", "Your code", "Item", "Quantity", "Cases", "Cost each", "Total", "Note"],
    ...lines.map((line, index) => [
      line.stock_items.sku ?? "",
      line.supplier_sku ?? "",
      itemName(line.stock_items),
      line.qty_ordered,
      caseLabel(line.qty_ordered, line.stock_items.case_pack) ?? "",
      priced[index].unitCost,
      lineTotal(index),
      line.note ?? "",
    ]),
    ...(totals.total.equals(totals.subtotal)
      ? []
      : [
          footer("Items", totals.subtotal.toFixed(2)),
          ...(totals.shipping.isZero() ? [] : [footer("Shipping", totals.shipping.toFixed(2))]),
          ...(totals.tax.isZero()
            ? []
            : [footer(`Tax (${Number(order.tax_rate_pct)}%)`, totals.tax.toFixed(2))]),
          ...adjustments.map((a) => footer(a.label, a.amount)),
          footer("Total", totals.total.toFixed(2)),
        ]),
  ];
  return new NextResponse(rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${(order.reference as string).replace(/[^A-Za-z0-9._-]+/g, "-")}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
