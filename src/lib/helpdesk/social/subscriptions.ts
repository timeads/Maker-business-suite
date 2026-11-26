import type { SupabaseClient } from "@supabase/supabase-js";
import { pageTokenOf } from "../../connections/meta-token";
import { getProviderToken, type TokenDeps } from "../../connections/tokens";
import { withTenant } from "../../supabase/admin";
import { commentScopesAllow, scopesAllow, type ChannelSettings } from "./channels";
import { subscribePage, subscribedFieldsFor, unsubscribePage } from "./graph";

/**
 * What each of the workspace's Pages should send to our webhook: messages
 * and comments each only where they are switched on and granted, and only
 * for a Page with an account in use. A Page with none in use (or with
 * nothing switched on) is asked to stop. Pure, so it can be tested.
 */
export function pageSubscriptions(
  settings: ChannelSettings,
  scopes: readonly string[],
  accounts: readonly { page_id: string | null; active: boolean }[],
): { pageId: string; fields: string[] }[] {
  const fields = subscribedFieldsFor({
    messages:
      (settings.facebook && scopesAllow("facebook", scopes)) ||
      (settings.instagram && scopesAllow("instagram", scopes)),
    comments:
      (settings.facebook_comments && commentScopesAllow("facebook", scopes)) ||
      (settings.instagram_comments && commentScopesAllow("instagram", scopes)),
  });
  const pages = new Map<string, boolean>();
  for (const account of accounts) {
    if (!account.page_id) continue;
    pages.set(account.page_id, (pages.get(account.page_id) ?? false) || account.active);
  }
  return [...pages].map(([pageId, used]) => ({ pageId, fields: used ? fields : [] }));
}

/**
 * Keeps every Page's webhook subscription in step with the workspace's
 * switches and accounts. Each Page is asked with its own token. Throws when
 * Meta refused or didn't answer for any Page; the others are still asked.
 */
export async function syncPageSubscriptions(
  admin: SupabaseClient,
  tenantId: string,
  settings: ChannelSettings,
  scopes: readonly string[],
  deps: { tokenDeps?: TokenDeps; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  if (!scopes.includes("pages_manage_metadata")) return;
  const accounts = await withTenant(
    tenantId,
    async (scope) => {
      const { data } = await scope
        .select("social_accounts", "page_id, active")
        .in("network", ["facebook", "instagram"]);
      return (data ?? []) as unknown as { page_id: string | null; active: boolean }[];
    },
    admin,
  );
  const stored = await getProviderToken(tenantId, "meta", deps.tokenDeps);
  // A connection from before accounts knows only its own Page.
  const wanted = pageSubscriptions(
    settings,
    scopes,
    accounts.length ? accounts : [{ page_id: stored.externalAccountId, active: true }],
  );
  let trouble: unknown = null;
  for (const { pageId, fields } of wanted) {
    const token = pageTokenOf(stored, pageId);
    if (!token) continue;
    try {
      if (fields.length > 0) await subscribePage(pageId, token, deps.fetchImpl ?? fetch, fields);
      else await unsubscribePage(pageId, token, deps.fetchImpl ?? fetch);
    } catch (err) {
      trouble = err;
    }
  }
  if (trouble) throw trouble;
}
