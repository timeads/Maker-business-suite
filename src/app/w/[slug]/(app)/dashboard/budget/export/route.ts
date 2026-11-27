import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { PERIODS, isMonth, type BudgetSubject, type Period } from "@/lib/dashboard/budget";
import { loadBudgetView } from "@/lib/dashboard/budget-data";
import { budgetTable, csvText } from "@/lib/dashboard/export";
import { currentMonth } from "@/lib/dashboard/range";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";

/**
 * The budget on screen as a spreadsheet: the same month, period and view,
 * from the same loader, as the member. Debt rows are there only for the
 * owners and admins the database hands debts to.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/dashboard/budget`);
  const ctx = await getTenantContext(slug, user.id);
  const missing = new NextResponse("Not found", { status: 404 });
  if (!ctx) return missing;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.dashboard")) return missing;

  const query = new URL(request.url).searchParams;
  const now = new Date();
  const asked = query.get("month");
  const month = isMonth(asked) ? asked : currentMonth(now, ctx.tenant.timezone);
  const period = (PERIODS as readonly string[]).includes(query.get("period") ?? "")
    ? (query.get("period") as Period)
    : "month";
  const subject: BudgetSubject = query.get("by") === "line" ? "line" : "account";
  const view = await loadBudgetView(
    await createClient(),
    ctx.tenant,
    { month, period, subject },
    now,
  );
  return new NextResponse(csvText(budgetTable(view.rows, view.subject)), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="budget-${period}-${month}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
