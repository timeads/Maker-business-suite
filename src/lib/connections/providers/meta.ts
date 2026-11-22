import { ProviderHttpError, requestJson, requiredEnv } from "../http";
import {
  ConnectError,
  ReconnectRequiredError,
  type ConnectedAccount,
  type Fetch,
  type ProviderAdapter,
} from "../types";

const SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
];

export const metaApiVersion = () => process.env.META_API_VERSION || "v23.0";
export const graphUrl = (path: string) => `https://graph.facebook.com/${metaApiVersion()}${path}`;

type Page = {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: { id: string; username?: string };
};

/** Meta says the token is no longer good (expired, revoked, password changed). */
export function isMetaAuthError(err: unknown): boolean {
  if (!(err instanceof ProviderHttpError)) return false;
  if (err.status === 401) return true;
  return /"code":\s*190\b/.test(err.body) || /OAuthException/.test(err.body);
}

/** The message Meta gave, for showing to the person who wrote the post. */
export function metaErrorMessage(err: unknown): string {
  if (err instanceof ProviderHttpError) {
    try {
      const parsed = JSON.parse(err.body) as { error?: { message?: string } };
      if (parsed.error?.message) return parsed.error.message.slice(0, 200);
    } catch {
      // Not JSON: fall through.
    }
    return `Meta answered ${err.status}`;
  }
  return err instanceof Error ? err.message.slice(0, 200) : "Something went wrong";
}

const describePage = (page: Page) =>
  page.instagram_business_account?.username
    ? `${page.name} · @${page.instagram_business_account.username}`
    : page.name;

const pageMetadata = (page: Pick<Page, "instagram_business_account">, otherPages = 0) => ({
  instagram_id: page.instagram_business_account?.id ?? null,
  instagram_username: page.instagram_business_account?.username ?? null,
  other_pages: otherPages,
});

/**
 * A Facebook Page and the Instagram business account linked to it. What we
 * keep is the Page's own token, which is what posting needs and which doesn't
 * expire while the person's access stands.
 */
export function createMetaAdapter(fetchImpl: Fetch = fetch): ProviderAdapter {
  const get = <T>(path: string, token: string, params: Record<string, string> = {}) =>
    requestJson<T>(fetchImpl, "Meta", `${graphUrl(path)}?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

  return {
    key: "meta",
    name: "Facebook & Instagram",
    blurb: "Schedule posts to your Facebook Page and Instagram",
    connectFields: [],
    pollEveryHours: 24,
    configured: () => Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET),

    beginConnect({ state, redirectUri }) {
      const url = new URL(`https://www.facebook.com/${metaApiVersion()}/dialog/oauth`);
      url.searchParams.set("client_id", requiredEnv("META_APP_ID"));
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", SCOPES.join(","));
      return url.toString();
    },

    async completeConnect({ params, redirectUri }): Promise<ConnectedAccount> {
      const code = params.get("code");
      if (!code) throw new ConnectError("Facebook didn't finish connecting. Try again.");
      const exchange = (query: Record<string, string>) =>
        requestJson<{ access_token: string }>(
          fetchImpl,
          "Meta",
          `${graphUrl("/oauth/access_token")}?${new URLSearchParams({
            client_id: requiredEnv("META_APP_ID"),
            client_secret: requiredEnv("META_APP_SECRET"),
            ...query,
          })}`,
        );
      const short = await exchange({ redirect_uri: redirectUri, code });
      // Page tokens made from a long-lived token don't run out after an hour.
      const long = await exchange({
        grant_type: "fb_exchange_token",
        fb_exchange_token: short.access_token,
      });
      const pages = await get<{ data: Page[] }>("/me/accounts", long.access_token, {
        fields: "id,name,access_token,instagram_business_account{id,username}",
        limit: "50",
      });
      const page =
        pages.data.find((p) => p.instagram_business_account) ?? (pages.data[0] as Page | undefined);
      if (!page) {
        throw new ConnectError("No Facebook Page was shared. Pick a Page when Facebook asks.");
      }
      return {
        externalAccountId: page.id,
        displayName: describePage(page),
        scopes: SCOPES,
        // The person's own token is kept only so access can be revoked on disconnect.
        token: { access_token: page.access_token, refresh_token: long.access_token },
        metadata: pageMetadata(page, pages.data.length - 1),
      };
    },

    async refresh(token) {
      return token;
    },

    async disconnect(token) {
      if (!token.refresh_token) return;
      await requestJson(fetchImpl, "Meta", graphUrl("/me/permissions"), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token.refresh_token}` },
      });
    },

    async sync({ externalAccountId, token }) {
      try {
        const page = await get<Omit<Page, "access_token">>(
          `/${encodeURIComponent(externalAccountId)}`,
          token.access_token,
          { fields: "id,name,instagram_business_account{id,username}" },
        );
        return {
          account: {
            displayName: describePage(page as Page),
            metadata: {
              instagram_id: page.instagram_business_account?.id ?? null,
              instagram_username: page.instagram_business_account?.username ?? null,
            },
          },
          cursor: { checked_at: new Date().toISOString() },
        };
      } catch (err) {
        if (isMetaAuthError(err)) {
          throw new ReconnectRequiredError("Facebook no longer accepts this Page's access");
        }
        throw err;
      }
    },
  };
}
