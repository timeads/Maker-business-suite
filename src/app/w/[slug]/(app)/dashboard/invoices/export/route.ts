import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { loadRevenueSettings } from "@/lib/dashboard/data";
import { csvText } from "@/lib/dashboard/export";
import { invoicesTable, parseInvoiceQuery } from "@/lib/dashboard/invoices";
import { dayIn } from "@/lib/dashboard/range";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";
import { loadInvoiceList } from "../data";

/** The invoice list on screen as a spreadsheet: the same view, search and line, every row. */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/dashboard/invoices`);
  const ctx = await getTenantContext(slug, user.id);
  const missing = new NextResponse("Not found", { status: 404 });
  if (!ctx) return missing;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.dashboard")) return missing;

  const query = parseInvoiceQuery(Object.fromEntries(new URL(request.url).searchParams));
  const today = dayIn(new Date(), ctx.tenant.timezone);
  const supabase = await createClient();
  const revenue = await loadRevenueSettings(supabase, ctx.tenant.id);
  const { rows } = await loadInvoiceList(supabase, ctx.tenant.id, revenue, query, today, {
    limit: 5000,
    offset: 0,
  });
  return new NextResponse(csvText(invoicesTable(rows)), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="invoices-${query.view}-${today}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
