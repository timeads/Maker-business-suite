import { EventbriteError, createEventbriteClient } from "../../eventbrite/client";
import { ConnectError, type ConnectedAccount, type Fetch, type ProviderAdapter } from "../types";

const KEYS_ONLY = "Eventbrite connects with your private token. Paste it in the box and try again.";

/**
 * A workspace's own Eventbrite account, for selling workshop dates there as
 * well. The business pastes its private token (Eventbrite → Account
 * settings → Developer links → API keys), the way the earlier booking app
 * was set up; we prove it with one read of the token's organizations and
 * keep it in Vault as the connection's token. The organization's id is the
 * account id (not secret). Everything that later talks to Eventbrite reads
 * the token through `getEventbriteAccess` (lib/eventbrite/access.ts).
 *
 * Signing in with Eventbrite (OAuth) would need an Eventbrite app of ours
 * with its own keys in the environment; that is for later.
 */
export function createEventbriteAdapter(fetchImpl?: Fetch): ProviderAdapter {
  return {
    key: "eventbrite",
    name: "Eventbrite",
    blurb:
      "Sell workshop dates on Eventbrite too, with places kept in step and orders arriving as bookings",
    connectFields: [
      {
        name: "private_token",
        label: "Private token",
        placeholder: "Paste your private token",
        help: "In Eventbrite, open Account settings → Developer links → API keys. Copy the private token (not the API key or the client secret). We keep it locked away and never show it again.",
        secret: true,
      },
    ],
    // Nothing of ours to configure: each workspace brings its own account.
    configured: () => true,
    // Orders arrive by webhook and places are pushed by the worker; there is
    // no sync to run from the Connections page.
    nothingToSync: true,
    pollEveryHours: null,
    disconnectNote:
      "We'll forget your Eventbrite token: places stop being kept in step and new orders stop arriving here. Your events on Eventbrite stay as they are, and bookings already made stay here.",

    beginConnect() {
      throw new ConnectError(KEYS_ONLY);
    },
    async completeConnect() {
      throw new ConnectError(KEYS_ONLY);
    },

    async connectWithKey(input): Promise<ConnectedAccount> {
      const token = (input.private_token ?? "").trim();
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(token)) {
        throw new ConnectError(
          "That doesn't look like an Eventbrite private token. Copy it again from Account settings → Developer links → API keys.",
        );
      }
      let organizations: { id: string; name: string }[];
      try {
        organizations = await createEventbriteClient({ token }, { fetchImpl }).organizations();
      } catch (err) {
        if (err instanceof EventbriteError && err.isAuthError) {
          throw new ConnectError(
            "Eventbrite didn't accept that token. Check you copied the private token, all of it.",
          );
        }
        throw new ConnectError(
          "We couldn't reach Eventbrite to check that token. Try again in a moment.",
        );
      }
      const organization = organizations[0];
      if (!organization) {
        throw new ConnectError(
          "That token works, but Eventbrite shows no organization on it. Make one in Eventbrite first.",
        );
      }
      return {
        externalAccountId: organization.id,
        displayName: organization.name,
        scopes: [],
        token: { access_token: token },
        // Nothing secret: which of the token's organizations we use, and how many it has.
        metadata: { organizations: organizations.length },
      };
    },

    statusNote(metadata) {
      return typeof metadata.organizations === "number" && metadata.organizations > 1
        ? {
            tone: "waiting",
            text: "This token has more than one Eventbrite organization; we use the first one Eventbrite lists.",
          }
        : null;
    },

    // A pasted token doesn't run out: a new one is pasted in.
    async refresh(token) {
      return token;
    },
    // Nothing to revoke on Eventbrite's side: we simply forget the token.
    async disconnect() {},
    async sync() {
      return {};
    },
  };
}
