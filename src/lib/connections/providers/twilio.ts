import { toE164 } from "../../texts/phone";
import {
  ACCOUNT_SID,
  AUTH_TOKEN,
  SERVICE_SID,
  TwilioError,
  createTwilioClient,
} from "../../texts/twilio-client";
import { ConnectError, type ConnectedAccount, type Fetch, type ProviderAdapter } from "../types";

const KEYS_ONLY =
  "Twilio connects with your Account SID and auth token. Fill in the boxes and try again.";

/**
 * A workspace's own Twilio account, for booking text reminders. The business
 * pastes its Account SID, auth token and sending number (or Messaging
 * Service id); we prove them with one harmless read of the account and keep
 * the token in Vault as the connection's token, with the sender beside it.
 * Everything that later talks to Twilio reads them through `getTwilioAccess`
 * (lib/texts/access.ts). Nothing is pulled from Twilio, ever.
 */
export function createTwilioAdapter(fetchImpl?: Fetch): ProviderAdapter {
  return {
    key: "twilio",
    name: "Twilio",
    blurb: "Text reminders to people who booked and asked for them, from your own Twilio number",
    connectFields: [
      {
        name: "account_sid",
        label: "Account SID",
        placeholder: "AC…",
        help: "On your Twilio console's home page, under Account Info. It starts with AC.",
      },
      {
        name: "auth_token",
        label: "Auth token",
        placeholder: "Paste your auth token",
        help: "Beside the Account SID; press Show to copy it. We keep it locked away and never show it again.",
        secret: true,
      },
      {
        name: "sender",
        label: "Texts come from",
        placeholder: "+12155550134 or MG…",
        help: "Your Twilio phone number, with + and the country code, or the id of a Messaging Service (it starts with MG) if you use one.",
      },
    ],
    // Nothing of ours to configure: each workspace brings its own account.
    configured: () => true,
    nothingToSync: true,
    pollEveryHours: null,
    disconnectNote:
      "We'll forget your Twilio keys and stop sending texts. Your Twilio account and number stay as they are.",

    beginConnect() {
      throw new ConnectError(KEYS_ONLY);
    },
    async completeConnect() {
      throw new ConnectError(KEYS_ONLY);
    },

    async connectWithKey(input): Promise<ConnectedAccount> {
      const accountSid = (input.account_sid ?? "").trim();
      const authToken = (input.auth_token ?? "").trim();
      const typedSender = (input.sender ?? "").trim();
      if (!ACCOUNT_SID.test(accountSid)) {
        throw new ConnectError(
          "That doesn't look like an Account SID. It starts with AC and has 32 letters and numbers after it.",
        );
      }
      if (!AUTH_TOKEN.test(authToken)) {
        throw new ConnectError(
          "That doesn't look like an auth token. Copy it again from your Twilio console: it is 32 letters and numbers.",
        );
      }
      // A number must carry its country code: we don't guess one for the sender.
      const sender = SERVICE_SID.test(typedSender) ? typedSender : toE164(typedSender, null);
      if (!sender) {
        throw new ConnectError(
          "Give the number texts come from with + and the country code (like +12155550134), or a Messaging Service id starting with MG.",
        );
      }
      let account: { name: string; status: string; trial: boolean };
      try {
        account = await createTwilioClient(
          { accountSid, authToken, sender },
          fetchImpl,
        ).checkAccount();
      } catch (err) {
        if (err instanceof TwilioError && (err.status === 401 || err.status === 403)) {
          throw new ConnectError(
            "Twilio didn't accept that Account SID and auth token together. Copy both again from the same account.",
          );
        }
        if (err instanceof TwilioError && err.status === 404) {
          throw new ConnectError("Twilio has no account with that SID. Check it and try again.");
        }
        throw new ConnectError(
          "We couldn't reach Twilio to check those keys. Try again in a moment.",
        );
      }
      if (account.status && account.status !== "active") {
        throw new ConnectError(
          `Twilio says this account is ${account.status}, so it can't send texts. Sort that out in Twilio first.`,
        );
      }
      return {
        // The Account SID isn't secret on its own; the token is, and stays in Vault.
        externalAccountId: accountSid,
        displayName: account.name || "Twilio account",
        scopes: [],
        token: { access_token: authToken, secrets: { sender } },
        // Nothing secret: who texts come from, and whether it's a trial account.
        metadata: {
          sender,
          sender_kind: SERVICE_SID.test(sender) ? "service" : "number",
          trial: account.trial,
        },
      };
    },

    statusNote(metadata) {
      if (metadata.trial === true) {
        return {
          tone: "waiting",
          text: "This is a Twilio trial account: it can only text numbers you have checked in Twilio, and adds Twilio's own words to each text.",
        };
      }
      return typeof metadata.sender === "string"
        ? { tone: "good", text: `Texts come from ${metadata.sender}.` }
        : null;
    },

    // A pasted key can't be renewed: a new one is pasted in.
    async refresh(token) {
      return token;
    },
    // Nothing to revoke on Twilio's side: we simply forget the keys.
    async disconnect() {},
    async sync() {
      return {};
    },
  };
}
