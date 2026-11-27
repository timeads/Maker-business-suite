import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { loadDebtView } from "@/lib/dashboard/debt/data";
import { csvText, debtsTable } from "@/lib/dashboard/export";
import { dayIn } from "@/lib/dashboard/range";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

/**
 * The debts as a spreadsheet. Owners and admins only, like the debts
 * themselves: anyone else gets "not found", and the database would hand
 * them no debts anyway.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/dashboard/debts`);
  const ctx = await getTenantContext(slug, user.id);
  const missing = new NextResponse("Not found", { status: 404 });
  if (!ctx || !canManage(ctx.role)) return missing;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.dashboard")) return missing;

  const view = await loadDebtView(await createClient(), ctx.tenant);
  return new NextResponse(csvText(debtsTable(view.debts, view.payoffs)), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="debts-${dayIn(new Date(), ctx.tenant.timezone)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
