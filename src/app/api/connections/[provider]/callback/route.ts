import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "@/lib/auth";
import { OAUTH_COOKIE, OAUTH_COOKIE_PATH, decodeOAuthState } from "@/lib/connections/oauth-state";
import { getAdapter, isProviderKey } from "@/lib/connections/registry";
import { ConnectError } from "@/lib/connections/types";
import { getEntitlements } from "@/lib/entitlements";
import { getSiteUrl } from "@/lib/site-url";
import { getAdminClient } from "@/lib/supabase/admin";
import { canManage, getTenantContext } from "@/lib/tenants";

const sameState = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Where Shopify, QuickBooks, ... send people back after they approve (or
 * decline) a connection.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const site = await getSiteUrl();
  const cookieStore = await cookies();
  const saved = decodeOAuthState(cookieStore.get(OAUTH_COOKIE)?.value);
  cookieStore.delete({ name: OAUTH_COOKIE, path: OAUTH_COOKIE_PATH });

  const params = request.nextUrl.searchParams;
  // Some connections are started from another screen and go back to it.
  const returnPath =
    saved && isProviderKey(provider) && saved.provider === provider
      ? (getAdapter(provider).returnPath?.(saved.input) ?? "connections")
      : "connections";
  const back = (slug: string | null, query: Record<string, string>) => {
    const url = new URL(slug ? `${site}/w/${slug}/${returnPath}` : `${site}/app`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return NextResponse.redirect(url);
  };

  // Everything below trusts `saved`, so it has to match this exact round trip.
  const returnedState = params.get("state") ?? "";
  if (
    !isProviderKey(provider) ||
    !saved ||
    saved.provider !== provider ||
    !sameState(saved.state, returnedState)
  ) {
    return back(saved?.slug ?? null, { error: "expired" });
  }

  const user = await getUser();
  if (!user || user.id !== saved.userId) return back(saved.slug, { error: "expired" });
  const tenantCtx = await getTenantContext(saved.slug, user.id);
  if (!tenantCtx || !canManage(tenantCtx.role)) return back(saved.slug, { error: "not_allowed" });
  if (!(await getEntitlements(tenantCtx.tenant.id)).canWrite) {
    return back(saved.slug, { error: "read_only" });
  }
  if (params.get("error")) return back(saved.slug, { error: "declined", provider });

  const adapter = getAdapter(provider);
  try {
    const account = await adapter.completeConnect({
      params,
      redirectUri: `${site}/api/connections/${provider}/callback`,
      input: saved.input,
    });

    const { error } = await getAdminClient().rpc("save_connection", {
      p_tenant_id: tenantCtx.tenant.id,
      p_provider: provider,
      p_external_account_id: account.externalAccountId,
      p_display_name: account.displayName,
      p_scopes: account.scopes,
      p_token: account.token,
      p_connected_by: user.id,
      p_metadata: account.metadata ?? {},
    });
    if (error) {
      if (error.code === "23505") return back(saved.slug, { error: "in_use", provider });
      throw new Error(error.message);
    }

    try {
      await adapter.afterConnect?.(account, site);
    } catch (err) {
      console.error(
        `${provider} post-connect setup failed`,
        err instanceof Error ? err.message : err,
      );
      return back(saved.slug, { connected: provider, warning: "updates" });
    }
    return back(saved.slug, { connected: provider });
  } catch (err) {
    if (err instanceof ConnectError) return back(saved.slug, { error: "rejected", provider });
    console.error(`${provider} connect failed`, err instanceof Error ? err.message : err);
    return back(saved.slug, { error: "failed", provider });
  }
}
