import { randomUUID } from "node:crypto";
import { checkRedo } from "../../shipping/sources/redo";
import { SourceError } from "../../shipping/sources/types";
import {
  ConnectError,
  ReconnectRequiredError,
  type ConnectedAccount,
  type Fetch,
  type ProviderAdapter,
} from "../types";

const KEYS_ONLY =
  "Redo connects with an API token and your store ID. Fill in the boxes and try again.";

/**
 * A workspace's own Redo account, for buying postage through the carriers
 * connected in Redo, paid from its Redo labels balance. The person pastes an
 * API token and their store ID; we ask Redo for one sample price to check
 * them, and keep both in Vault as the connection's token. Everything that
 * later talks to Redo reads them through `getProviderToken`.
 */
export function createRedoAdapter(fetchImpl: Fetch = fetch): ProviderAdapter {
  return {
    key: "redo",
    name: "Redo",
    blurb:
      "Buy postage in Shipping through the carriers in your Redo account, paid from your Redo labels balance",
    connectFields: [
      {
        name: "api_token",
        label: "Redo API token",
        placeholder: "Paste your token",
        help: "In Redo, open Settings, then Developer, and make an API token with the Shipping read and Shipping write permissions.",
        secret: true,
      },
      {
        name: "store_id",
        label: "Redo store ID",
        placeholder: "Paste your store ID",
        help: "On the same Developer page in Redo, copy “Your Store ID”: a string of letters and numbers.",
        secret: true,
      },
    ],
    // Nothing of ours to configure: each workspace brings its own token.
    configured: () => true,
    pollEveryHours: null,

    beginConnect() {
      throw new ConnectError(KEYS_ONLY);
    },
    async completeConnect() {
      throw new ConnectError(KEYS_ONLY);
    },

    async connectWithKey(input): Promise<ConnectedAccount> {
      const token = (input.api_token ?? "").trim();
      const storeId = (input.store_id ?? "").trim();
      if (!token || !storeId)
        throw new ConnectError("Paste your Redo API token and store ID first.");
      if (token.length > 400 || !/^[\x21-\x7e]+$/.test(token)) {
        throw new ConnectError(
          "That doesn't look like a Redo API token. Copy it again from Redo and paste the whole thing.",
        );
      }
      if (!/^[A-Za-z0-9_-]{4,80}$/.test(storeId)) {
        throw new ConnectError(
          "That doesn't look like a Redo store ID. It's a string of letters and numbers, with no spaces.",
        );
      }
      try {
        await checkRedo({ token, storeId }, fetchImpl);
      } catch (err) {
        if (err instanceof ReconnectRequiredError) {
          throw new ConnectError(
            "Redo didn't accept that token. Copy it again from Redo (Settings, then Developer) and check the store ID belongs to the same store.",
          );
        }
        if (err instanceof SourceError && err.status !== null && err.status < 500) {
          throw new ConnectError(err.message);
        }
        throw new ConnectError(
          "We couldn't reach Redo to check that token. Try again in a moment.",
        );
      }
      return {
        // Each connection gets its own id; the store ID stays in Vault with the token.
        externalAccountId: `redo-${randomUUID()}`,
        displayName: "Redo",
        scopes: [],
        token: { access_token: token, secrets: { store_id: storeId } },
        metadata: {},
      };
    },

    // A token doesn't expire.
    async refresh(token) {
      return token;
    },

    // Nothing to revoke on Redo's side: we simply forget the token.
    async disconnect() {},

    // Nothing is pulled from Redo; labels are bought when someone asks.
    async sync() {
      return { cursor: { checked_at: new Date().toISOString() } };
    },
  };
}
