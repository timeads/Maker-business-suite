import { randomUUID } from "node:crypto";
import { checkKey } from "../../michaels/api";
import { MichaelsApiError, createMichaelsClient, isMichaelsEnv } from "../../michaels/client";
import { keyExpiry } from "../../michaels/mapping";
import { ConnectError, type ConnectedAccount, type Fetch, type ProviderAdapter } from "../types";

const KEYS_ONLY =
  "Michaels connects with an API key from your seller account. Fill in the boxes and try again.";

/** What the Connections page says about the key's age. Michaels has no call for it. */
export function michaelsKeyNote(
  metadata: Record<string, unknown>,
  today: string,
): { tone: "good" | "waiting" | "bad"; text: string } | null {
  const created = typeof metadata.key_created_on === "string" ? metadata.key_created_on : null;
  const key = keyExpiry(created, today);
  if (key.level === "unknown" || key.daysToReplace === null || key.daysLeft === null) return null;
  const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
  if (key.level === "expired") {
    return {
      tone: "bad",
      text: `This API key ran out on ${key.expiresOn}. Connect again with a new one.`,
    };
  }
  if (key.daysToReplace <= 0) {
    return {
      tone: "bad",
      text: `Replace this API key now: it is past 60 days old, when Michaels keys start misbehaving. Michaels ends it on ${key.expiresOn}.`,
    };
  }
  return {
    tone: key.level === "ok" ? "good" : key.level === "warn" ? "waiting" : "bad",
    text: `Replace this API key in ${days(key.daysToReplace)}, by ${key.replaceOn}. Michaels ends it on ${key.expiresOn}.`,
  };
}

/**
 * A workspace's own Michaels Marketplace seller account. The person pastes an
 * API key from the Michaels Developer Account Center; we prove it with one
 * small read of their listings and keep it in Vault as the connection's
 * token. Everything that later talks to Michaels reads it through
 * `getProviderToken` (lib/michaels/access.ts).
 *
 * In this stage the connection is only ever read from: see
 * lib/michaels/client.ts, which refuses anything but a GET.
 */
export function createMichaelsAdapter(fetchImpl?: Fetch): ProviderAdapter {
  return {
    key: "michaels",
    name: "Michaels Marketplace",
    blurb:
      "Match your Michaels listings to your stock and see what would be sent there. For now it only watches: nothing is changed on Michaels or in your shop",
    connectFields: [
      {
        name: "api_key",
        label: "Michaels API key",
        placeholder: "Paste your key",
        help: "In the Michaels Developer Account Center, make an API key. Read Only access to Listing, Inventory, Price and Order is all this needs for now.",
        secret: true,
      },
      {
        name: "key_created",
        label: "The day the key was made",
        placeholder: "2026-11-24",
        help: "Year, month, day. Michaels ends every key 90 days after it was made and has no way to tell us when, so we count from this date and remind you in good time.",
      },
      {
        name: "environment",
        label: "Which Michaels",
        placeholder: "",
        options: [
          { value: "production", label: "The real marketplace" },
          { value: "sandbox", label: "The sandbox, for testing" },
        ],
      },
    ],
    // Nothing of ours to configure: each workspace brings its own key.
    configured: () => true,
    pollEveryHours: null,
    disconnectNote:
      "We'll forget the key and stop looking at Michaels. Your listings on Michaels and the pairings you made here stay as they are.",

    beginConnect() {
      throw new ConnectError(KEYS_ONLY);
    },
    async completeConnect() {
      throw new ConnectError(KEYS_ONLY);
    },

    async connectWithKey(input): Promise<ConnectedAccount> {
      const apiKey = (input.api_key ?? "").trim();
      const created = (input.key_created ?? "").trim();
      const env = (input.environment ?? "").trim() || "production";
      if (!apiKey) throw new ConnectError("Paste your Michaels API key first.");
      if (apiKey.length < 8 || apiKey.length > 400 || !/^[\x21-\x7e]+$/.test(apiKey)) {
        throw new ConnectError(
          "That doesn't look like a Michaels API key. Copy it again from the Developer Account Center and paste the whole thing.",
        );
      }
      if (!isMichaelsEnv(env))
        throw new ConnectError("Choose the real marketplace or the sandbox.");
      const day = /^\d{4}-\d{2}-\d{2}$/.test(created) ? Date.parse(`${created}T00:00:00Z`) : NaN;
      if (
        !Number.isFinite(day) ||
        new Date(day).toISOString().slice(0, 10) !== created ||
        day > Date.now() + 86_400_000 ||
        day < Date.now() - 120 * 86_400_000
      ) {
        throw new ConnectError(
          "Give the day the key was made as year-month-day, like 2026-11-24. It can't be in the future or more than 90 days ago.",
        );
      }
      const connectionId = `michaels-${randomUUID()}`;
      try {
        // One harmless read: the first listing, nothing more.
        await checkKey(
          createMichaelsClient({ connectionId, apiKey, env }, { fetchImpl, maxRetries: 0 }),
        );
      } catch (err) {
        if (err instanceof MichaelsApiError && err.isPermissionError) {
          throw new ConnectError(
            "Michaels says this key isn't allowed to read your listings. Give it at least Read Only access to Listing in the Developer Account Center.",
          );
        }
        if (err instanceof MichaelsApiError && err.isAuthError) {
          throw new ConnectError(
            env === "sandbox"
              ? "Michaels didn't accept that key for the sandbox. Check it was made for the sandbox, and copy it again."
              : "Michaels didn't accept that key. Check it was made for the real marketplace (not the sandbox), and copy it again.",
          );
        }
        if (err instanceof MichaelsApiError && err.code === "BAD_RESPONSE") {
          throw new ConnectError(
            "Michaels answered in a way we didn't expect. Check whether the key is for the sandbox or the real marketplace, and try again.",
          );
        }
        throw new ConnectError(
          "We couldn't reach Michaels to check that key. Try again in a moment.",
        );
      }
      return {
        // Each connection gets its own id; the key stays in Vault.
        externalAccountId: connectionId,
        displayName: env === "sandbox" ? "Michaels sandbox" : "Michaels seller account",
        scopes: [],
        token: { access_token: apiKey, secrets: { env } },
        // Nothing secret: which Michaels, and the day the key was made.
        metadata: { environment: env, key_created_on: created },
      };
    },

    statusNote: michaelsKeyNote,

    // A key can't be renewed: a new one is pasted in.
    async refresh(token) {
      return token;
    },

    // Nothing to revoke on Michaels' side: we simply forget the key.
    async disconnect() {},

    // The hourly look has its own queue (michaels_runs); nothing happens here.
    async sync() {
      return { cursor: { checked_at: new Date().toISOString() } };
    },
  };
}
