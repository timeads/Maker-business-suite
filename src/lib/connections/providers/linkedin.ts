import {
  LINKEDIN_MEMBER_SCOPES,
  LINKEDIN_ORG_SCOPES,
  LinkedInError,
  createLinkedInClient,
  createLinkedInOAuth,
  linkedinCompanyPages,
  type LinkedInClientOptions,
} from "../../linkedin/client";
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

const RETURN_PATHS: Record<string, string> = {
  social_accounts: "settings/social/accounts",
};

export const linkedinConfigured = () =>
  Boolean(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET);

const app = () => ({
  clientId: requiredEnv("LINKEDIN_CLIENT_ID"),
  clientSecret: requiredEnv("LINKEDIN_CLIENT_SECRET"),
});

/** What a sign-in asks for: posting as the person, and as their company pages where the app may. */
export const linkedinScopes = () =>
  linkedinCompanyPages()
    ? [...LINKEDIN_MEMBER_SCOPES, ...LINKEDIN_ORG_SCOPES]
    : [...LINKEDIN_MEMBER_SCOPES];

/** Whether a login's granted scopes let it post as a person, or as a company page. */
export function linkedinCanPost(platformId: string, scopes: readonly string[]): boolean {
  return platformId.startsWith("urn:li:organization:")
    ? scopes.includes("w_organization_social")
    : scopes.includes("w_member_social");
}

const DAY = 86_400_000;

/**
 * LinkedIn, for posting as a company page the person looks after, or as the
 * person themself. Each person who signs in is a login inside the one
 * `linkedin` connection (`lib/connections/logins.ts`), offering their
 * company pages and their own profile as accounts. LinkedIn's access lasts
 * about sixty days; only apps it has approved get a refresh token, so for
 * most a login must be connected again when its access runs out (the
 * Connections page says when). Nothing is ever pulled.
 */
export function createLinkedInAdapter(
  fetchImpl: Fetch = fetch,
  now: () => number = Date.now,
): ProviderAdapter {
  const opts: LinkedInClientOptions = { fetchImpl };
  return {
    key: "linkedin",
    name: "LinkedIn",
    blurb:
      "Post to your company page on LinkedIn, or to your own profile. Connect one person, then add more from Settings → Social accounts.",
    connectFields: [{ name: "return_to", label: "", placeholder: "", hidden: true }],
    optional: true,
    nothingToSync: true,
    multiLogin: true,
    pollEveryHours: null,
    configured: linkedinConfigured,
    returnPath: (input) => RETURN_PATHS[input.return_to ?? ""] ?? null,
    disconnectNote:
      "Every LinkedIn page and profile connected here stops posting. What already went to LinkedIn stays there.",
    statusNote(metadata, today) {
      const logins = Array.isArray(metadata.logins) ? (metadata.logins as LoginInfo[]) : [];
      const soonest = logins
        .map((login) => ({ name: login.name, by: login.reconnect_by?.slice(0, 10) ?? null }))
        .filter((login): login is { name: string; by: string } => Boolean(login.by))
        .sort((a, b) => a.by.localeCompare(b.by))[0];
      if (!soonest) return null;
      const days = Math.round((Date.parse(soonest.by) - Date.parse(today)) / DAY);
      if (days > 14) return null;
      return {
        tone: days < 0 ? "bad" : "waiting",
        text:
          days < 0
            ? `LinkedIn's access for ${soonest.name} has run out. Connect it again from Settings → Social accounts.`
            : `LinkedIn asks for ${soonest.name} to be connected again by ${soonest.by}. Do it from Settings → Social accounts.`,
      };
    },

    beginConnect({ state, redirectUri }) {
      return createLinkedInOAuth(app(), opts).authorizeUrl({
        redirectUri,
        state,
        scopes: linkedinScopes(),
      });
    },

    async completeConnect({ params, redirectUri }): Promise<ConnectedAccount> {
      const code = params.get("code");
      if (!code) throw new ConnectError("LinkedIn didn't finish connecting. Try again.");
      const started = now();
      let tokens;
      try {
        tokens = await createLinkedInOAuth(app(), opts).exchangeCode(code, redirectUri);
      } catch (err) {
        if (err instanceof LinkedInError && err.applied === "no") {
          throw new ConnectError("LinkedIn didn't finish connecting. Try again.");
        }
        throw err;
      }
      const granted = tokens.scope.split(/[,\s]+/).filter(Boolean);
      const client = createLinkedInClient(tokens.access_token, opts);
      const member = await client.member();
      const orgs = granted.includes("w_organization_social")
        ? await client.organizations().catch(() => [])
        : [];
      if (!granted.includes("w_member_social") && orgs.length === 0) {
        throw new ConnectError(
          "LinkedIn didn't give permission to post. Connect again and allow posting when LinkedIn asks.",
        );
      }
      const login: TokenSet = {
        access_token: tokens.access_token,
        expires_at: started + (tokens.expires_in || 60 * 86_400) * 1000,
        ...(tokens.refresh_token
          ? {
              refresh_token: tokens.refresh_token,
              ...(tokens.refresh_token_expires_in
                ? { refresh_expires_at: started + tokens.refresh_token_expires_in * 1000 }
                : {}),
            }
          : {}),
      };
      const lastsUntil = login.refresh_token ? login.refresh_expires_at : login.expires_at;
      const info: LoginInfo = {
        id: member.sub,
        name: member.name,
        scopes: granted,
        connected_at: new Date(started).toISOString(),
        reconnect_by: lastsUntil ? new Date(lastsUntil).toISOString() : null,
      };
      return {
        externalAccountId: member.sub,
        displayName: member.name,
        scopes: granted,
        token: singleLogin(member.sub, login),
        metadata: {
          logins: [info],
          offered: [
            ...orgs.map((org) => ({
              network: "linkedin",
              platform_id: org.urn,
              name: org.name,
              tasks: [org.role],
            })),
            ...(granted.includes("w_member_social")
              ? [
                  {
                    network: "linkedin",
                    platform_id: `urn:li:person:${member.sub}`,
                    name: member.name,
                  },
                ]
              : []),
          ],
        },
      };
    },

    /** Renews one login where LinkedIn gave a refresh token; otherwise it must be connected again. */
    async refresh(token): Promise<TokenSet> {
      if (!token.refresh_token) {
        throw new ReconnectRequiredError("LinkedIn's access ran out; connect it again");
      }
      if (token.refresh_expires_at !== undefined && token.refresh_expires_at <= now()) {
        throw new ReconnectRequiredError("LinkedIn's access ran out; connect it again");
      }
      const started = now();
      try {
        const tokens = await createLinkedInOAuth(app(), opts).refresh(token.refresh_token);
        return {
          access_token: tokens.access_token,
          expires_at: started + (tokens.expires_in || 60 * 86_400) * 1000,
          refresh_token: tokens.refresh_token ?? token.refresh_token,
          ...(tokens.refresh_token_expires_in
            ? { refresh_expires_at: started + tokens.refresh_token_expires_in * 1000 }
            : token.refresh_expires_at !== undefined
              ? { refresh_expires_at: token.refresh_expires_at }
              : {}),
        };
      } catch (err) {
        if (err instanceof LinkedInError && (err.isAuthError || err.status === 400)) {
          throw new ReconnectRequiredError("LinkedIn no longer accepts this login");
        }
        throw err;
      }
    },

    async afterSaved({ tenantId, admin }, account) {
      const { error } = await admin.rpc("note_login_accounts", {
        p_tenant_id: tenantId,
        p_provider: "linkedin",
        p_login_id: account.externalAccountId,
        p_accounts: offeredBy(account.metadata),
      });
      if (error) throw new Error(`could not note the LinkedIn pages: ${error.message}`);
    },

    async disconnectLogin(login) {
      await createLinkedInOAuth(app(), opts).revoke(login.access_token);
    },

    async disconnect(token) {
      const oauth = createLinkedInOAuth(app(), opts);
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
