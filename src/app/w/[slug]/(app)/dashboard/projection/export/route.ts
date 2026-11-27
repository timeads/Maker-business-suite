import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { csvText } from "@/lib/dashboard/export";
import { OTHER, projectionTable } from "@/lib/dashboard/projection";
import { loadProjection } from "@/lib/dashboard/projection-data";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";

/** The projection on screen as a spreadsheet. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/dashboard/projection`);
  const ctx = await getTenantContext(slug, user.id);
  const missing = new NextResponse("Not found", { status: 404 });
  if (!ctx) return missing;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.dashboard")) return missing;
  const view = await loadProjection(await createClient(), ctx.tenant);
  if (!view.years) return missing;
  const name = (id: string) =>
    id === OTHER ? "Other" : (view.lines.find((l) => l.id === id)?.name ?? id);
  return new NextResponse(csvText(projectionTable(view.years, name)), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="projection.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
