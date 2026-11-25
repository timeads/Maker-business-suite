import { NextResponse, type NextRequest } from "next/server";
import {
  NOT_FOUND_HEADERS,
  NOT_FOUND_PAGE,
  helpCentreGate,
  helpCentreRoute,
} from "@/lib/helpdesk/help-centre-gate";
import { movedSettingsPath } from "@/lib/settings/redirects";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  // Tools' settings moved under workspace Settings; old addresses follow them for good,
  // query string and all. (A "#…" never reaches a server: the page it lands on reads it.)
  const moved = movedSettingsPath(request.nextUrl.pathname);
  if (moved) {
    const url = request.nextUrl.clone();
    url.pathname = moved;
    return NextResponse.redirect(url, 308);
  }
  // A public help centre page is checked before it is drawn, so one that isn't there is a
  // real 404 and an article's old address a real redirect. These pages are for visitors:
  // no session is read or refreshed for them, and no cookie set.
  const help = helpCentreRoute(request.nextUrl.pathname);
  if (help) {
    const answer = await helpCentreGate(help.workspace, help.article);
    if (answer.kind === "missing") {
      return new NextResponse(NOT_FOUND_PAGE, { status: 404, headers: NOT_FOUND_HEADERS });
    }
    if (answer.kind === "moved") {
      const url = request.nextUrl.clone();
      url.pathname = `/help-centre/${help.workspace}/${answer.slug}`;
      url.search = "";
      return NextResponse.redirect(url, 308);
    }
    return NextResponse.next({ request });
  }
  if (request.nextUrl.pathname.startsWith("/help-centre/")) return NextResponse.next({ request });
  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except static assets, the health check and webhooks.
    "/((?!_next/static|_next/image|favicon.ico|api/health|api/webhooks|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
