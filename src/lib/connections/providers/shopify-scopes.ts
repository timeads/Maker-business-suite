import type { TokenSet } from "../types";

/**
 * What a store has really granted the app, as Shopify itself says it.
 *
 * Our Shopify app uses Shopify-managed installation, and then Shopify ignores
 * the `scope` we put on the authorize link: the store gets the scopes listed
 * in the app's released version, once the merchant approves them. So what we
 * asked for, and even the token response, can differ from what the store
 * allows. The connection's `scopes` is therefore always this answer, read
 * after connecting, on each scheduled shop read and on "Check again"
 * (docs/shopify-permissions.md).
 */
export const ACCESS_SCOPES_QUERY = "{ currentAppInstallation { accessScopes { handle } } }";

export type AccessScopesAnswer = {
  currentAppInstallation?: { accessScopes?: { handle?: unknown }[] | null } | null;
};

type Graphql = <T>(shop: string, token: TokenSet, query: string, variables?: object) => Promise<T>;

/** The handles in Shopify's answer; anything that isn't a plain scope name is left out. */
export function grantedHandles(answer: AccessScopesAnswer | null | undefined): string[] {
  const list = answer?.currentAppInstallation?.accessScopes;
  if (!Array.isArray(list)) return [];
  const handles = list
    .map((scope) => scope?.handle)
    .filter((handle): handle is string => typeof handle === "string")
    .map((handle) => handle.trim())
    .filter((handle) => /^[a-z0-9_]{1,80}$/.test(handle));
  return [...new Set(handles)].sort();
}

/**
 * The scopes we record, and so the ones every gate may lean on. A watch-only
 * connection keeps only the reading half: under managed installation the
 * store may well have granted writes, but watch only is our promise that
 * nothing in it is changed from here, so no gate may ever see one.
 */
export function usableShopifyScopes(granted: string[], watchOnly: boolean): string[] {
  return watchOnly ? granted.filter((scope) => scope.startsWith("read_")) : granted;
}

/** Asks the store what the installation has. Throws when Shopify can't say. */
export async function readShopifyGrantedScopes(
  graphql: Graphql,
  shop: string,
  token: TokenSet,
): Promise<string[]> {
  const answer = await graphql<AccessScopesAnswer>(shop, token, ACCESS_SCOPES_QUERY);
  if (!Array.isArray(answer?.currentAppInstallation?.accessScopes)) {
    throw new Error("Shopify didn't say which permissions the store has granted");
  }
  return grantedHandles(answer);
}
