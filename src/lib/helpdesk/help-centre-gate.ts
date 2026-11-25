import type { SupabaseClient } from "@supabase/supabase-js";
import { moduleOpen } from "../module-access";
import { getAdminClient } from "../supabase/admin";

/**
 * The check made in front of every public help centre page, before anything
 * is drawn, so a page that isn't there answers a real 404 and an article's
 * old address a real redirect (a page that has begun to stream can do
 * neither). One small question to the database, naming the workspace by the
 * address it was asked for, and the plan check every public page makes.
 */

export type GateAnswer =
  | { kind: "ok" }
  /** The article lives at another address now. */
  | { kind: "moved"; slug: string }
  | { kind: "missing" };

const SLUG = /^[a-z0-9-]{1,80}$/;

/** `/help-centre/<workspace>` or `/help-centre/<workspace>/<article>`, or null for any other path. */
export function helpCentreRoute(
  pathname: string,
): { workspace: string; article: string | null } | null {
  const match = /^\/help-centre\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return null;
  // The sitemap answers for itself.
  if (match[2] === "sitemap.xml") return null;
  return { workspace: match[1], article: match[2] ?? null };
}

export async function helpCentreGate(
  workspace: string,
  article: string | null,
  admin?: SupabaseClient,
): Promise<GateAnswer> {
  if (!SLUG.test(workspace) || (article !== null && !SLUG.test(article))) {
    return { kind: "missing" };
  }
  if (!process.env.SUPABASE_SECRET_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return { kind: "missing" };
  }
  try {
    const client = admin ?? getAdminClient();
    const { data, error } = await client.rpc("help_centre_where", {
      p_workspace: workspace,
      p_article: article,
    });
    const found = data as { tenant_id: string; slug: string | null } | null;
    if (error || !found?.tenant_id) return { kind: "missing" };
    if (!(await moduleOpen(found.tenant_id, "helpdesk", client))) return { kind: "missing" };
    if (article !== null && found.slug && found.slug !== article) {
      return { kind: "moved", slug: found.slug };
    }
    return { kind: "ok" };
  } catch {
    // If we can't tell, nothing is shown.
    return { kind: "missing" };
  }
}

/** A plain "not found" page: nothing loaded, nothing about any workspace. */
export const NOT_FOUND_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Page not found</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f3ee;color:#1f2a2c;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:24rem;padding:3rem 1rem}
h1{font-size:1.5rem;line-height:1.2;margin:0 0 .75rem}
p{margin:0;line-height:1.5;color:#55605f}
</style>
</head>
<body>
<main>
<h1>We couldn’t find that page</h1>
<p>It may have moved or been taken down. Check the address, or go back to where you found the link.</p>
</main>
</body>
</html>
`;

export const NOT_FOUND_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex",
  "referrer-policy": "strict-origin-when-cross-origin",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
