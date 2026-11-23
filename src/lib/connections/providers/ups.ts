import { randomUUID } from "node:crypto";
import { SourceError } from "../../shipping/sources/types";
import { UpsKeysRefused, checkUpsKeys, fetchUpsToken } from "../../shipping/sources/ups";
import {
  ConnectError,
  ReconnectRequiredError,
  type ConnectedAccount,
  type Fetch,
  type ProviderAdapter,
  type TokenSet,
} from "../types";

const KEYS_ONLY =
  "UPS connects with the keys from your UPS developer app. Fill in the boxes and try again.";
const plain = (value: string, max: number) => value.length <= max && /^[\x21-\x7e]+$/.test(value);

/** The token UPS just issued, with the keys that renew it. All of it lives in Vault. */
const tokenSet = (
  signedIn: { token: string; expiresIn: number },
  secrets: Record<string, string>,
  now: number,
): TokenSet => ({
  access_token: signedIn.token,
  expires_at: now + signedIn.expiresIn * 1000,
  secrets,
});

/**
 * A business's own UPS account, for buying postage at its own agreed prices.
 * The person types in the three things their UPS developer app gives them;
 * we sign in once to check them, ask for one sample price, and keep them in
 * Vault as the connection's token. UPS tokens last a few hours, so `refresh`
 * signs in again with the saved keys. Everything that talks to UPS reads
 * them through `getProviderToken`.
 */
export function createUpsAdapter(
  fetchImpl: Fetch = fetch,
  now: () => number = Date.now,
): ProviderAdapter {
  return {
    key: "ups",
    name: "UPS (your own account)",
    blurb:
      "Buy UPS labels in Shipping at your own account's prices, billed by UPS to your account",
    connectFields: [
      {
        name: "client_id",
        label: "Client ID",
        placeholder: "Paste your Client ID",
        help: "At developer.ups.com, sign in with your UPS login, open Apps and add an app for your shipper account with the Rating and Shipping products (and Address Validation, to have addresses checked). The app's page shows the Client ID and Client Secret.",
        secret: true,
      },
      {
        name: "client_secret",
        label: "Client Secret",
        placeholder: "Paste your Client Secret",
        secret: true,
      },
      {
        name: "account_number",
        label: "UPS account number",
        placeholder: "Six letters and numbers",
        help: "Your shipper number: six characters, shown on your UPS invoices and under Accounts and Payment on ups.com. It must be the account linked to the app.",
        secret: true,
      },
      {
        name: "mode",
        label: "What to buy",
        placeholder: "",
        options: [
          { value: "production", label: "Real labels, billed to my UPS account" },
          { value: "test", label: "Practice labels (UPS's test system, nothing is billed)" },
        ],
      },
    ],
    // Nothing of ours to configure: each workspace brings its own keys.
    configured: () => true,
    pollEveryHours: null,

    beginConnect() {
      throw new ConnectError(KEYS_ONLY);
    },
    async completeConnect() {
      throw new ConnectError(KEYS_ONLY);
    },

    async connectWithKey(input): Promise<ConnectedAccount> {
      const clientId = (input.client_id ?? "").trim();
      const clientSecret = (input.client_secret ?? "").trim();
      const account = (input.account_number ?? "").replace(/\s+/g, "").toUpperCase();
      const test = (input.mode ?? "").trim() === "test";
      if (!clientId || !clientSecret || !account) {
        throw new ConnectError("Fill in the Client ID, the Client Secret and your account number.");
      }
      if (!plain(clientId, 200) || !plain(clientSecret, 200)) {
        throw new ConnectError(
          "Those don't look like UPS keys. Copy the Client ID and Client Secret again from your app at developer.ups.com.",
        );
      }
      if (!/^[A-Z0-9]{6}$/.test(account)) {
        throw new ConnectError(
          "A UPS account number is six letters and numbers, like A1B2C3. Check it and try again.",
        );
      }
      let signedIn: { token: string; expiresIn: number };
      try {
        signedIn = await checkUpsKeys({ clientId, clientSecret, account, test }, fetchImpl);
      } catch (err) {
        if (err instanceof UpsKeysRefused) {
          throw new ConnectError(
            "UPS didn't accept those keys. Copy the Client ID and Client Secret again from your app at developer.ups.com, and check the account number is the one linked to it.",
          );
        }
        // Signed in, but the sample price was refused: say what UPS said.
        if (err instanceof SourceError && err.status !== null && err.status < 500) {
          throw new ConnectError(err.message);
        }
        throw new ConnectError("We couldn't reach UPS to check those keys. Try again in a moment.");
      }
      return {
        // Several workspaces may ship on one UPS account, so each connection gets its own id.
        externalAccountId: `ups-${randomUUID()}`,
        displayName: test ? "UPS (practice labels)" : "UPS",
        scopes: [],
        token: tokenSet(
          signedIn,
          {
            client_id: clientId,
            client_secret: clientSecret,
            account,
            env: test ? "test" : "production",
          },
          now(),
        ),
        metadata: { mode: test ? "test" : "production" },
      };
    },

    // UPS tokens run out after a few hours: sign in again with the saved keys.
    async refresh(token) {
      const secrets = token.secrets ?? {};
      if (!secrets.client_id || !secrets.client_secret || !secrets.account) {
        throw new ReconnectRequiredError("UPS has no keys stored");
      }
      try {
        const signedIn = await fetchUpsToken(
          {
            clientId: secrets.client_id,
            clientSecret: secrets.client_secret,
            account: secrets.account,
            test: secrets.env === "test",
          },
          fetchImpl,
        );
        return tokenSet(signedIn, secrets, now());
      } catch (err) {
        if (err instanceof UpsKeysRefused) {
          throw new ReconnectRequiredError("UPS didn't accept the saved keys");
        }
        throw err;
      }
    },

    // Nothing to revoke on UPS's side: we simply forget the keys.
    async disconnect() {},

    // Nothing is pulled from UPS; labels are bought when someone asks.
    async sync() {
      return { cursor: { checked_at: new Date().toISOString() } };
    },
  };
}
