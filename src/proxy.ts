import { NextResponse, type NextRequest } from "next/server";
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
  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except static assets, the health check and webhooks.
    "/((?!_next/static|_next/image|favicon.ico|api/health|api/webhooks|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
