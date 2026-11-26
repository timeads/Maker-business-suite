import { subscribePage, subscribedFieldsFor, unsubscribePage } from "../../helpdesk/social/graph";
import { ProviderHttpError, requestJson, requiredEnv } from "../http";
import { featuresOf, requestedFeatures, scopesFor } from "../meta-access";
import {
  ConnectError,
  ReconnectRequiredError,
  type ConnectedAccount,
  type Fetch,
  type ProviderAdapter,
} from "../types";

/**
 * One connection, several uses, each asked for only where a workspace
 * switches it on: posting (Social), messages and comments (the help desk).
 * `lib/connections/meta-access.ts` holds the permissions behind each. A
 * login asks for what the screen that started it wants plus what the
 * connection already had, and never for anything else: Facebook refuses the
 * whole login when asked for a permission the Meta app doesn't carry. What
 * Facebook really granted is recorded in the connection's `scopes`, and
 * every feature checks those.
 */
export const META_WITH_MESSAGES = "messages";
export const META_WITH_POSTING = "posting";

/** Where a login may land afterwards, by the name the starting screen gives. */
const RETURN_PATHS: Record<string, string> = {
  helpdesk_channels: "settings/helpdesk/channels",
  social: "social",
  social_accounts: "settings/social/accounts",
};

export const metaApiVersion = () => process.env.META_API_VERSION || "v23.0";
export const graphUrl = (path: string) => `https://graph.facebook.com/${metaApiVersion()}${path}`;

type Page = {
  id: string;
  name: string;
  access_token: string;
  /** What the person who logged in may do on this Page ("MANAGE", "CREATE_CONTENT", ...). */
  tasks?: string[];
  instagram_business_account?: { id: string; username?: string };
};

/** A Page the login shared, as kept on the connection's metadata. Nothing secret. */
export type SharedPage = {
  id: string;
  name: string;
  instagram_id: string | null;
  instagram_username: string | null;
  tasks: string[] | null;
};

/** Where a Page's own token sits among the connection's tokens in Vault. */
export const pageTokenKey = (pageId: string) => `page:${pageId}`;

/** Every Page shared, and the Instagram account linked to each, as accounts to offer the workspace. */
export function accountsOffered(pages: readonly SharedPage[]) {
  return pages.flatMap((page) => [
    {
      network: "facebook",
      platform_id: page.id,
      page_id: page.id,
      name: page.name,
      handle: null,
      tasks: page.tasks,
    },
    ...(page.instagram_id
      ? [
          {
            network: "instagram",
            platform_id: page.instagram_id,
            page_id: page.id,
            name: page.name,
            handle: page.instagram_username,
            tasks: page.tasks,
          },
        ]
      : []),
  ]);
}

/** The pages on a connection's metadata, or none. Never trusted for more than names and ids. */
export function sharedPages(metadata: unknown): SharedPage[] {
  const list = (metadata as { pages?: unknown } | null)?.pages;
  if (!Array.isArray(list)) return [];
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  return list.flatMap((raw) => {
    const page = raw as Record<string, unknown>;
    const id = text(page.id);
    if (!id || !/^[0-9]{1,40}$/.test(id)) return [];
    return [
      {
        id,
        name: text(page.name) ?? "Facebook Page",
        instagram_id: text(page.instagram_id),
        instagram_username: text(page.instagram_username),
        tasks: Array.isArray(page.tasks) ? page.tasks.map(String) : null,
      },
    ];
  });
}

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

const pageMetadata = (page: Pick<Page, "instagram_business_account">, all: Page[]) => ({
  instagram_id: page.instagram_business_account?.id ?? null,
  instagram_username: page.instagram_business_account?.username ?? null,
  other_pages: all.length - 1,
  // Every Page shared, so the workspace can choose which to use. Names and ids only.
  pages: all.map((each): SharedPage => ({
    id: each.id,
    name: each.name,
    instagram_id: each.instagram_business_account?.id ?? null,
    instagram_username: each.instagram_business_account?.username ?? null,
    tasks: Array.isArray(each.tasks) ? each.tasks.map(String) : null,
  })),
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
    // Neither is drawn on the Connections page: the screen that starts the connection sets them.
    connectFields: [
      { name: "access", label: "", placeholder: "", hidden: true },
      { name: "return_to", label: "", placeholder: "", hidden: true },
    ],
    // Renewing a connection asks again for what it was granted, and for nothing it wasn't.
    reconnectInput: (scopes): Record<string, string> => {
      const kept = featuresOf(scopes);
      return kept.length > 0 ? { kept: kept.join(",") } : {};
    },
    returnPath: (input) => RETURN_PATHS[input.return_to ?? ""] ?? null,
    pollEveryHours: 24,
    configured: () => Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET),

    beginConnect({ state, redirectUri, input }) {
      const url = new URL(`https://www.facebook.com/${metaApiVersion()}/dialog/oauth`);
      url.searchParams.set("client_id", requiredEnv("META_APP_ID"));
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", scopesFor(requestedFeatures(input)).join(","));
      return url.toString();
    },

    async completeConnect({ params, redirectUri, input }): Promise<ConnectedAccount> {
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
        fields: "id,name,access_token,tasks,instagram_business_account{id,username}",
        limit: "50",
      });
      const page =
        pages.data.find((p) => p.instagram_business_account) ?? (pages.data[0] as Page | undefined);
      if (!page) {
        throw new ConnectError("No Facebook Page was shared. Pick a Page when Facebook asks.");
      }
      // People can untick a permission on Facebook's screen, and an app may
      // not carry every one: record what was really granted, not what we asked.
      const asked = scopesFor(requestedFeatures(input));
      const granted = await get<{ data?: { permission?: string; status?: string }[] }>(
        "/me/permissions",
        long.access_token,
      );
      const given = new Set(
        (granted.data ?? [])
          .filter((row) => row.status === "granted" && typeof row.permission === "string")
          .map((row) => row.permission as string),
      );
      const scopes = asked.filter((scope) => given.has(scope));
      return {
        externalAccountId: page.id,
        displayName: describePage(page),
        scopes,
        // The person's own token is kept only so access can be revoked on disconnect.
        // Each Page's own token sits beside the first one's, all of it in Vault.
        token: {
          access_token: page.access_token,
          refresh_token: long.access_token,
          secrets: Object.fromEntries(
            pages.data
              .filter((each) => typeof each.access_token === "string" && each.access_token)
              .map((each) => [pageTokenKey(each.id), each.access_token]),
          ),
        },
        metadata: pageMetadata(page, pages.data),
      };
    },

    async refresh(token) {
      return token;
    },

    // Every Page the login shared (and its Instagram account) is offered to the
    // workspace; which are used, and as which brand, is a person's choice.
    async afterSaved({ tenantId, admin }, account) {
      const { error } = await admin.rpc("note_meta_accounts", {
        p_tenant_id: tenantId,
        p_accounts: accountsOffered(sharedPages(account.metadata)),
      });
      if (error) throw new Error(`could not note the shared Pages: ${error.message}`);
    },

    // With the help desk's permissions granted, ask Meta to send this Page's
    // (and its Instagram account's) messages and comments to our webhook.
    // Which of them are filed is the workspace's own switches.
    async afterConnect(account) {
      const features = featuresOf(account.scopes);
      const fields = subscribedFieldsFor({
        messages: features.includes("messages"),
        comments: features.includes("facebook_comments") || features.includes("instagram_comments"),
      });
      if (fields.length === 0 || !account.scopes.includes("pages_manage_metadata")) return;
      await subscribePage(account.externalAccountId, account.token.access_token, fetchImpl, fields);
    },

    async disconnect(token, externalAccountId) {
      // Stop every Page's messages coming our way first; they may never have been asked for.
      const pages = new Map([[externalAccountId, token.access_token]]);
      for (const [key, value] of Object.entries(token.secrets ?? {})) {
        if (key.startsWith("page:") && value) pages.set(key.slice("page:".length), value);
      }
      for (const [pageId, pageToken] of pages) {
        await unsubscribePage(pageId, pageToken, fetchImpl).catch(() => undefined);
      }
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
