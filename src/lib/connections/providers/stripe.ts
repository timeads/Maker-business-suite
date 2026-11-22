import type Stripe from "stripe";
import { getStripe } from "../../billing/stripe";
import { requiredEnv } from "../http";
import {
  ConnectError,
  ReconnectRequiredError,
  type ConnectedAccount,
  type ProviderAdapter,
} from "../types";

/** The parts of the Stripe SDK this adapter uses, so tests can stand in for it. */
export type StripeConnectClient = {
  oauth: Pick<Stripe["oauth"], "authorizeUrl" | "token" | "deauthorize">;
  accounts: Pick<Stripe["accounts"], "retrieve">;
};

type AccountLike = {
  id: string;
  charges_enabled?: boolean;
  email?: string | null;
  business_profile?: { name?: string | null } | null;
  settings?: { dashboard?: { display_name?: string | null } | null } | null;
};

const nameOf = (account: AccountLike) =>
  account.business_profile?.name ||
  account.settings?.dashboard?.display_name ||
  account.email ||
  "Stripe account";

const isGone = (err: unknown) => {
  const code = (err as { code?: string; statusCode?: number } | null) ?? {};
  return code.statusCode === 401 || code.statusCode === 403 || code.code === "account_invalid";
};

/**
 * A business's own Stripe account (Connect, Standard), so booking payments
 * land with them directly. We keep their account id and act for it with our
 * platform key; the token Stripe hands back is stored in Vault like any other.
 */
export function createStripeAdapter(
  client: () => StripeConnectClient = getStripe,
): ProviderAdapter {
  return {
    key: "stripe",
    name: "Stripe payouts",
    blurb: "Take payment for bookings straight into your own Stripe account",
    connectFields: [],
    pollEveryHours: 24,
    configured: () =>
      Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_CONNECT_CLIENT_ID),

    beginConnect({ state, redirectUri }) {
      return client().oauth.authorizeUrl({
        client_id: requiredEnv("STRIPE_CONNECT_CLIENT_ID"),
        response_type: "code",
        scope: "read_write",
        redirect_uri: redirectUri,
        state,
      });
    },

    async completeConnect({ params }): Promise<ConnectedAccount> {
      const code = params.get("code");
      if (!code) throw new ConnectError("Stripe didn't finish connecting. Try again.");
      const response = await client().oauth.token({ grant_type: "authorization_code", code });
      if (!response.stripe_user_id || !response.access_token) {
        throw new ConnectError("Stripe didn't finish connecting. Try again.");
      }
      const account = (await client().accounts.retrieve(response.stripe_user_id)) as AccountLike;
      return {
        externalAccountId: response.stripe_user_id,
        displayName: nameOf(account),
        scopes: [response.scope ?? "read_write"],
        token: {
          access_token: response.access_token,
          ...(response.refresh_token ? { refresh_token: response.refresh_token } : {}),
        },
        metadata: { charges_enabled: Boolean(account.charges_enabled) },
      };
    },

    // Stripe's Connect tokens don't expire.
    async refresh(token) {
      return token;
    },

    async disconnect(_token, externalAccountId) {
      await client().oauth.deauthorize({
        client_id: requiredEnv("STRIPE_CONNECT_CLIENT_ID"),
        stripe_user_id: externalAccountId,
      });
    },

    async sync({ externalAccountId, job }) {
      if (job.topic === "account.application.deauthorized") {
        return { disconnected: "Access was removed in Stripe" };
      }
      try {
        const account = (await client().accounts.retrieve(externalAccountId)) as AccountLike;
        return {
          account: {
            displayName: nameOf(account),
            metadata: { charges_enabled: Boolean(account.charges_enabled) },
          },
          cursor: { checked_at: new Date().toISOString() },
        };
      } catch (err) {
        if (isGone(err)) {
          throw new ReconnectRequiredError("Stripe no longer lets us act for this account");
        }
        throw err;
      }
    },
    tokenlessTopics: ["account.application.deauthorized"],
  };
}
