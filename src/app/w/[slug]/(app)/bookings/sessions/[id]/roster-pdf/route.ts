import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { buildRunsheet } from "@/lib/bookings/runsheet";
import { loadRunsheet } from "@/lib/bookings/runsheet-data";
import { renderRunsheetPdf } from "@/lib/bookings/runsheet-pdf";
import { localDay } from "@/lib/bookings/slots";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";

/** One date's list of who's coming, as a PDF. Open to the whole team, like the spreadsheet. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const user = await requireUser(`/w/${slug}/bookings/sessions/${id}`);
  const ctx = await getTenantContext(slug, user.id);
  const missing = new NextResponse("Not found", { status: 404 });
  if (!ctx || !/^[0-9a-f-]{36}$/i.test(id)) return missing;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.bookings")) return missing;

  const sessions = await loadRunsheet(await createClient(), ctx.tenant, { sessionId: id });
  if (!sessions) return new NextResponse("The list couldn't be read just now.", { status: 503 });
  if (sessions.length === 0) return missing;
  const day = localDay(new Date(sessions[0].starts_at), ctx.tenant.timezone);
  const doc = buildRunsheet({
    business: ctx.tenant.name,
    timezone: ctx.tenant.timezone,
    from: day,
    to: day,
    sessions,
    single: true,
  });
  const name = sessions[0].service
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return new NextResponse(new Uint8Array(await renderRunsheetPdf(doc)), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${name || "bookings"}-${day}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
