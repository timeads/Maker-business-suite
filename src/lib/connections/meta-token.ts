import { pageTokenKey } from "./providers/meta";
import { getProviderToken, type StoredToken, type TokenDeps } from "./tokens";
import { ReconnectRequiredError } from "./types";

/**
 * A Facebook Page's own token, from the workspace's Meta connection. Every
 * Page a login shared keeps its token in Vault beside the first one's, so
 * this is still the one way to them (CLAUDE.md rule 3): it goes through
 * `getProviderToken` and names the Page. Never log or return the result.
 */
export function pageTokenOf(stored: StoredToken, pageId: string): string | null {
  const own = stored.token.secrets?.[pageTokenKey(pageId)];
  if (own) return own;
  // A connection made before several Pages were kept holds only its one Page's token.
  return pageId === stored.externalAccountId ? stored.token.access_token : null;
}

export type PageAccess = { pageId: string; token: string };

export async function getMetaPageToken(
  tenantId: string,
  pageId: string,
  deps?: TokenDeps,
): Promise<PageAccess> {
  const stored = await getProviderToken(tenantId, "meta", deps);
  const token = pageTokenOf(stored, pageId);
  if (!token) {
    // The login that shared this Page no longer holds it.
    throw new ReconnectRequiredError("This Facebook Page needs connecting again");
  }
  return { pageId, token };
}
