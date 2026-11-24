import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { buildPoDocument } from "@/lib/stock/po/document";
import { renderPoPdf } from "@/lib/stock/po/pdf";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { loadPoForSupplier, loadPoLogo, poFileName } from "../po-data";

/**
 * One order as a PDF, as the supplier will receive it. Owners and admins
 * only, like placing the order itself.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; number: string }> },
) {
  const { slug, number } = await params;
  const user = await requireUser(`/w/${slug}/stock/orders/${number}`);
  const ctx = await getTenantContext(slug, user.id);
  const missing = new NextResponse("Not found", { status: 404 });
  if (!ctx || !/^\d{1,9}$/.test(number) || !canManage(ctx.role)) return missing;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.stock")) return missing;

  const supabase = await createClient();
  const [order, logo] = await Promise.all([
    loadPoForSupplier(supabase, ctx.tenant, { number: Number(number) }),
    loadPoLogo(supabase, ctx.tenant.id),
  ]);
  if (!order) return missing;
  const pdf = await renderPoPdf(buildPoDocument(order.document), logo);
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${poFileName(order.reference)}"`,
      "Cache-Control": "no-store",
    },
  });
}
