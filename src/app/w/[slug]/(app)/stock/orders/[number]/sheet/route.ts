import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { csvCell } from "@/lib/bookings/emails";
import { getEntitlements } from "@/lib/entitlements";
import { itemName } from "@/lib/stock/plan";
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
  if (!entitlements.can("module.stock")) return missing;

  const supabase = await createClient();
  const { data: order } = await supabase
    .from("purchase_orders")
    .select(
      "number, purchase_order_lines(qty_ordered, unit_cost, stock_items(title, variant_title, sku))",
    )
    .eq("tenant_id", ctx.tenant.id)
    .eq("number", Number(number))
    .maybeSingle();
  if (!order) return missing;
  const lines = (
    order.purchase_order_lines as unknown as {
      qty_ordered: number;
      unit_cost: number;
      stock_items: { title: string; variant_title: string | null; sku: string | null };
    }[]
  ).filter((line) => line.qty_ordered > 0);
  const rows = [
    ["SKU", "Item", "Quantity", "Cost each", "Total"],
    ...lines.map((line) => [
      line.stock_items.sku ?? "",
      itemName(line.stock_items),
      line.qty_ordered,
      Number(line.unit_cost).toFixed(2),
      (line.qty_ordered * Number(line.unit_cost)).toFixed(2),
    ]),
  ];
  return new NextResponse(rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="order-${order.number}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
