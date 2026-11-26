import {
  TIKTOK_SCOPES,
  TikTokError,
  createTikTokClient,
  createTikTokOAuth,
  tiktokAuthorizeUrl,
  type TikTokClientOptions,
} from "../../tiktok/client";
import { tiktokAudited } from "../../social/tiktok-options";
import { loginIds, loginToken, offeredBy, singleLogin, type LoginInfo } from "../logins";
import { requiredEnv } from "../http";
import {
  ConnectError,
  ReconnectRequiredError,
  type ConnectedAccount,
  type Fetch,
  type ProviderAdapter,
  type TokenSet,
} from "../types";

/** Where a connection started from Settings → Social accounts goes back to. */
const RETURN_PATHS: Record<string, string> = {
  social_accounts: "settings/social/accounts",
};

export const tiktokConfigured = () =>
  Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET);

const app = () => ({
  clientKey: requiredEnv("TIKTOK_CLIENT_KEY"),
  clientSecret: requiredEnv("TIKTOK_CLIENT_SECRET"),
});

/**
 * TikTok, for posting videos straight to one or more TikTok accounts
 * (Login Kit with PKCE, and the Content Posting API's direct post). Each
 * account is its own login, kept inside the one `tiktok` connection
 * (`lib/connections/logins.ts`): connecting again adds another account.
 * Access tokens last about a day and are renewed with the login's refresh
 * token (which TikTok may replace each time); a refresh token that has run
 * out means that account must be connected again. Nothing is ever pulled.
 */
export function createTikTokAdapter(
  fetchImpl: Fetch = fetch,
  now: () => number = Date.now,
): ProviderAdapter {
  const opts: TikTokClientOptions = { fetchImpl };
  return {
    key: "tiktok",
    name: "TikTok",
    blurb:
      "Post your videos straight to TikTok. Connect one account, then add more from Settings → Social accounts.",
    connectFields: [{ name: "return_to", label: "", placeholder: "", hidden: true }],
    optional: true,
    nothingToSync: true,
    multiLogin: true,
    pkce: true,
    pollEveryHours: null,
    configured: tiktokConfigured,
    returnPath: (input) => RETURN_PATHS[input.return_to ?? ""] ?? null,
    disconnectNote:
      "Every TikTok account connected here stops posting. What already went to TikTok stays there.",
    statusNote: () =>
      tiktokAudited()
        ? null
        : {
            tone: "waiting",
            text: "TikTok hasn't reviewed this app yet, so for now every video goes up as “Only you”. You can change who sees each one in the TikTok app.",
          },

    beginConnect({ state, redirectUri, input }) {
      if (!input.pkce_verifier) throw new Error("TikTok needs a PKCE verifier");
      return tiktokAuthorizeUrl({
        clientKey: app().clientKey,
        redirectUri,
        state,
        codeVerifier: input.pkce_verifier,
      });
    },

    async completeConnect({ params, redirectUri, input }): Promise<ConnectedAccount> {
      const code = params.get("code");
      if (!code || !input.pkce_verifier) {
        throw new ConnectError("TikTok didn't finish connecting. Try again.");
      }
      const started = now();
      let tokens;
      try {
        tokens = await createTikTokOAuth(app(), opts).exchangeCode(
          code,
          redirectUri,
          input.pkce_verifier,
        );
      } catch (err) {
        if (err instanceof TikTokError && err.applied === "no") {
          throw new ConnectError("TikTok didn't finish connecting. Try again.");
        }
        throw err;
      }
      // People can untick a permission on TikTok's screen.
      const granted = tokens.scope.split(/[,\s]+/).filter(Boolean);
      if (!granted.includes("video.publish")) {
        throw new ConnectError(
          "TikTok didn't give permission to post. Connect again and leave “Post content to TikTok” ticked.",
        );
      }
      const user = await createTikTokClient(tokens.access_token, opts).userInfo();
      const openId = user.openId || tokens.open_id;
      const login: TokenSet = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: started + tokens.expires_in * 1000,
        ...(tokens.refresh_expires_in
          ? { refresh_expires_at: started + tokens.refresh_expires_in * 1000 }
          : {}),
      };
      const scopes = TIKTOK_SCOPES.filter((scope) => granted.includes(scope));
      const name = user.username ? `@${user.username}` : user.displayName;
      const info: LoginInfo = {
        id: openId,
        name,
        scopes,
        connected_at: new Date(started).toISOString(),
        reconnect_by: login.refresh_expires_at
          ? new Date(login.refresh_expires_at).toISOString()
          : null,
      };
      return {
        externalAccountId: openId,
        displayName: name,
        scopes,
        token: singleLogin(openId, login),
        metadata: {
          logins: [info],
          offered: [
            {
              network: "tiktok",
              platform_id: openId,
              name: user.displayName,
              handle: user.username,
            },
          ],
        },
      };
    },

    /** Renews one login (TikTok may hand over a new refresh token as well). */
    async refresh(token): Promise<TokenSet> {
      if (!token.refresh_token) throw new ReconnectRequiredError("TikTok gave no lasting access");
      if (token.refresh_expires_at !== undefined && token.refresh_expires_at <= now()) {
        throw new ReconnectRequiredError("TikTok's access for this account ran out");
      }
      const started = now();
      try {
        const tokens = await createTikTokOAuth(app(), opts).refresh(token.refresh_token);
        return {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token || token.refresh_token,
          expires_at: started + tokens.expires_in * 1000,
          ...(tokens.refresh_expires_in
            ? { refresh_expires_at: started + tokens.refresh_expires_in * 1000 }
            : token.refresh_expires_at !== undefined
              ? { refresh_expires_at: token.refresh_expires_at }
              : {}),
        };
      } catch (err) {
        if (err instanceof TikTokError && (err.isAuthError || err.status === 400)) {
          throw new ReconnectRequiredError("TikTok no longer accepts this account's access");
        }
        throw err;
      }
    },

    // The account this login is, offered to the workspace like a Facebook Page.
    async afterSaved({ tenantId, admin }, account) {
      const { error } = await admin.rpc("note_login_accounts", {
        p_tenant_id: tenantId,
        p_provider: "tiktok",
        p_login_id: account.externalAccountId,
        p_accounts: offeredBy(account.metadata),
      });
      if (error) throw new Error(`could not note the TikTok account: ${error.message}`);
    },

    async disconnectLogin(login) {
      await createTikTokOAuth(app(), opts).revoke(login.access_token);
    },

    async disconnect(token) {
      const oauth = createTikTokOAuth(app(), opts);
      for (const id of loginIds(token)) {
        const login = loginToken(token, id);
        if (login) await oauth.revoke(login.access_token).catch(() => undefined);
      }
    },

    async sync() {
      return { cursor: { checked_at: new Date(now()).toISOString() } };
    },
  };
}
