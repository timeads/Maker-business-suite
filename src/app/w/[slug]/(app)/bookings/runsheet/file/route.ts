import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { buildRunsheet, runsheetCsv, runsheetRange } from "@/lib/bookings/runsheet";
import { loadRunsheet } from "@/lib/bookings/runsheet-data";
import { renderRunsheetPdf } from "@/lib/bookings/runsheet-pdf";
import { localDay } from "@/lib/bookings/slots";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";

/**
 * The runsheet for a stretch of days as a PDF (`?format=pdf`) or a
 * spreadsheet. Open to the whole team, like a date's own list.
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/bookings/runsheet`);
  const ctx = await getTenantContext(slug, user.id);
  const missing = new NextResponse("Not found", { status: 404 });
  if (!ctx) return missing;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.bookings")) return missing;

  const url = new URL(request.url);
  const { from, to } = runsheetRange(
    { from: url.searchParams.get("from"), to: url.searchParams.get("to") },
    localDay(new Date(), ctx.tenant.timezone),
  );
  const sessions = await loadRunsheet(await createClient(), ctx.tenant, { from, to });
  if (!sessions)
    return new NextResponse("The runsheet couldn't be read just now.", { status: 503 });
  const doc = buildRunsheet({
    business: ctx.tenant.name,
    timezone: ctx.tenant.timezone,
    from,
    to,
    sessions,
  });
  const name = `runsheet-${from}-to-${to}`;
  if (url.searchParams.get("format") === "pdf") {
    return new NextResponse(new Uint8Array(await renderRunsheetPdf(doc)), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${name}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return new NextResponse(runsheetCsv(doc, sessions, ctx.tenant.timezone), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
