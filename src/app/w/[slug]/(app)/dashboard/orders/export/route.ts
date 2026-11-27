import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { loadDashboardConfig, loadRevenueSettings } from "@/lib/dashboard/data";
import { csvText, fileSlug } from "@/lib/dashboard/export";
import { ORDER_LINE_CAP, ordersTable, parseOrderQuery } from "@/lib/dashboard/orders";
import { pageRange } from "@/lib/dashboard/range";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";
import { loadOrderList } from "../data";

/** The order list on screen as a spreadsheet: the same range and filters, up to 2,000 orders. */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/dashboard/orders`);
  const ctx = await getTenantContext(slug, user.id);
  const missing = new NextResponse("Not found", { status: 404 });
  if (!ctx) return missing;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.dashboard")) return missing;

  const search = Object.fromEntries(new URL(request.url).searchParams);
  const query = parseOrderQuery(search);
  const supabase = await createClient();
  const revenue = await loadRevenueSettings(supabase, ctx.tenant.id);
  const { config } = await loadDashboardConfig(supabase, ctx.tenant.id, revenue);
  const shown = pageRange(search.range, config.range, new Date(), ctx.tenant.timezone);
  const { rows } = await loadOrderList(supabase, ctx.tenant.id, revenue, shown.range, query, {
    limit: ORDER_LINE_CAP,
    offset: 0,
  });
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: ctx.tenant.timezone });
  return new NextResponse(csvText(ordersTable(revenue, rows, (iso) => day.format(new Date(iso)))), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="orders-${fileSlug(shown.label)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
