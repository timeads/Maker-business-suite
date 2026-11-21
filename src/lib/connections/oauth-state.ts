import type { ProviderKey } from "./types";

/**
 * What we remember between sending someone to a provider and their return.
 * Kept in an httpOnly cookie scoped to the callback path; the random `state`
 * must come back unchanged in the provider's redirect.
 */
export type OAuthState = {
  state: string;
  slug: string;
  provider: ProviderKey;
  userId: string;
  input: Record<string, string>;
};

export const OAUTH_COOKIE = "mbs_oauth";
export const OAUTH_COOKIE_PATH = "/api/connections";
export const OAUTH_COOKIE_MAX_AGE = 10 * 60;

export function encodeOAuthState(value: OAuthState): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeOAuthState(raw: string | undefined): OAuthState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as OAuthState;
    if (
      typeof value.state !== "string" ||
      value.state.length < 16 ||
      typeof value.slug !== "string" ||
      typeof value.provider !== "string" ||
      typeof value.userId !== "string" ||
      typeof value.input !== "object" ||
      value.input === null
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}
