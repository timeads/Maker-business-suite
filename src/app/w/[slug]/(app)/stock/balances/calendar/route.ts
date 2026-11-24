import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { formatMoney } from "@/lib/dashboard/format";
import { getEntitlements } from "@/lib/entitlements";
import { billEvents, toIcs } from "@/lib/stock/balance/calendar";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { loadBalances } from "../data";

/**
 * Every open bill as a calendar file: one all-day entry per supplier per pay
 * day. Owners and admins only, like the balances themselves. It is a file a
 * person adds to their own calendar; we never reach into anyone's calendar.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/stock/balances`);
  const ctx = await getTenantContext(slug, user.id);
  const missing = new NextResponse("Not found", { status: 404 });
  if (!ctx || !canManage(ctx.role)) return missing;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.stock")) return missing;

  const { accounts, today } = await loadBalances(await createClient(), ctx.tenant);
  const events = billEvents(
    accounts
      .filter((account) => account.ledger.length > 0)
      .map((account) => ({
        supplierId: account.supplierId,
        supplierName: account.name,
        aging: account.aging,
      })),
    today,
    (amount) => formatMoney(Number(amount), ctx.tenant.currency),
  );
  const file = toIcs(events, {
    name: `${ctx.tenant.name}: bills to pay`,
    stamp: new Date(),
    host: "bills.maker-suite",
  });
  return new NextResponse(file, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="bills-${today}.ics"`,
      "Cache-Control": "no-store",
    },
  });
}
