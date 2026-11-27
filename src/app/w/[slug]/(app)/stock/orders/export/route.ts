import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { csvCell } from "@/lib/bookings/emails";
import { getEntitlements } from "@/lib/entitlements";
import { isOrderView, orderViewRows, ordersCsv, searchOrders } from "@/lib/stock/po/list";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";
import { loadOrderList, stockToday } from "../../data";

/**
 * The order list on screen as a spreadsheet file: the same view, search and
 * supplier, and every row of it (not just the page showing).
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/stock/orders`);
  const ctx = await getTenantContext(slug, user.id);
  const missing = new NextResponse("Not found", { status: 404 });
  if (!ctx) return missing;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.stock")) return missing;

  const query = new URL(request.url).searchParams;
  const show = query.get("show");
  const view = isOrderView(show) ? show : "all";
  const supplier = query.get("supplier");
  const orders = await loadOrderList(await createClient(), ctx.tenant, {
    costs: entitlements.seesCosts,
  });
  const shown = searchOrders(
    orderViewRows(orders)[view],
    (query.get("q") ?? "").slice(0, 80),
    supplier && /^[0-9a-f-]{36}$/i.test(supplier) ? supplier : null,
  );
  const table = ordersCsv(shown);
  return new NextResponse(table.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="orders-${view}-${stockToday(ctx.tenant.timezone)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
