import { randomUUID } from "node:crypto";
import { checkKey } from "../../shipping/easypost";
import {
  ConnectError,
  ReconnectRequiredError,
  type ConnectedAccount,
  type Fetch,
  type ProviderAdapter,
} from "../types";

const KEY_ONLY = "EasyPost connects with an API key. Paste yours into the box and try again.";

/**
 * A workspace's own EasyPost account, for buying postage labels. There is no
 * approval page to send anyone to: the person pastes an API key, we check it
 * once, and it is kept in Vault as the connection's token. Everything that
 * later talks to EasyPost reads it through `getProviderToken`.
 */
export function createEasyPostAdapter(fetchImpl: Fetch = fetch): ProviderAdapter {
  return {
    key: "easypost",
    name: "EasyPost",
    blurb: "Buy and print postage labels in Shipping, paid from your own EasyPost account",
    connectFields: [
      {
        name: "api_key",
        label: "EasyPost API key",
        placeholder: "Paste your key",
        help: "In EasyPost, open Account Settings, then API Keys, and copy a key. A production key buys real postage; a test key buys pretend labels you can practise with.",
        secret: true,
      },
    ],
    // Nothing of ours to configure: each workspace brings its own key.
    configured: () => true,
    pollEveryHours: null,

    beginConnect() {
      throw new ConnectError(KEY_ONLY);
    },
    async completeConnect() {
      throw new ConnectError(KEY_ONLY);
    },

    async connectWithKey(input): Promise<ConnectedAccount> {
      const key = (input.api_key ?? "").trim();
      if (!key) throw new ConnectError("Paste your EasyPost API key first.");
      if (key.length > 200 || !/^[\x21-\x7e]+$/.test(key)) {
        throw new ConnectError(
          "That doesn't look like an EasyPost API key. Copy it again from EasyPost and paste it here.",
        );
      }
      let mode: "test" | "production" | null;
      try {
        ({ mode } = await checkKey(key, fetchImpl));
      } catch (err) {
        if (err instanceof ReconnectRequiredError) {
          throw new ConnectError(
            "EasyPost didn't accept that key. Copy it again from EasyPost (Account Settings, API Keys) and paste the whole thing.",
          );
        }
        throw new ConnectError(
          "We couldn't reach EasyPost to check that key. Try again in a moment.",
        );
      }
      return {
        // EasyPost has no account id a test key can read, and several
        // workspaces may share one account, so each connection gets its own.
        externalAccountId: `easypost-${randomUUID()}`,
        displayName: mode === "test" ? "EasyPost (test key)" : "EasyPost",
        scopes: [],
        token: { access_token: key },
        metadata: { mode },
      };
    },

    // A key doesn't expire.
    async refresh(token) {
      return token;
    },

    // Nothing to revoke on EasyPost's side: we simply forget the key.
    async disconnect() {},

    // Nothing is pulled from EasyPost; labels are bought when someone asks.
    async sync() {
      return { cursor: { checked_at: new Date().toISOString() } };
    },
  };
}
