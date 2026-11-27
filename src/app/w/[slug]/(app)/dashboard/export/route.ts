import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { loadDashboardConfig, loadDashboardData, loadRevenueSettings } from "@/lib/dashboard/data";
import { csvText, figuresTable, fileSlug, profitTable } from "@/lib/dashboard/export";
import { pageRange } from "@/lib/dashboard/range";
import { dashboardSchema } from "@/lib/dashboard/schema";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";
import { TITLES } from "../widget";

/**
 * Money's figures for the range on screen as a spreadsheet, built from the
 * same loader the page uses, as the member (row-level security applies, so
 * nobody gets a figure the page wouldn't show them). `what=profit` is profit
 * by line with each step of the sum in its own column.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/dashboard`);
  const ctx = await getTenantContext(slug, user.id);
  const missing = new NextResponse("Not found", { status: 404 });
  if (!ctx) return missing;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.dashboard")) return missing;

  const query = new URL(request.url).searchParams;
  const supabase = await createClient();
  const revenue = await loadRevenueSettings(supabase, ctx.tenant.id);
  const { config } = await loadDashboardConfig(supabase, ctx.tenant.id, revenue);
  const shown = pageRange(query.get("range"), config.range, new Date(), ctx.tenant.timezone);
  const profitOnly = query.get("what") === "profit";
  const layout = profitOnly
    ? dashboardSchema.parse({
        version: 1,
        name: "Profit by line",
        widgets: [{ id: "profit", type: "profit_by_line" }],
      })
    : config;
  const data = await loadDashboardData(supabase, ctx.tenant, layout, shown.range, revenue);
  const profit = data.profit;
  const rows =
    profitOnly && profit?.type === "profit_by_line"
      ? profitTable(profit)
      : figuresTable(layout.widgets, data, (w) => w.title ?? TITLES[w.type]);
  const name = `${profitOnly ? "profit-by-line" : "money"}-${fileSlug(shown.label)}`;
  return new NextResponse(csvText(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
