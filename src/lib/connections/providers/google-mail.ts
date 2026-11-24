import { randomUUID } from "node:crypto";
import { ProviderHttpError, requestJson, requiredEnv } from "../http";
import {
  ConnectError,
  ReconnectRequiredError,
  type ConnectedAccount,
  type Fetch,
  type ProviderAdapter,
  type TokenSet,
} from "../types";

/**
 * A business's own Gmail, for one thing only: sending a purchase order to a
 * supplier when a person presses Send. The permission asked for is
 * `gmail.send`, which can send and cannot read a single message; `openid`
 * and `email` are there so we can show which mailbox is connected. (A
 * workspace can choose to add read-only access as well: see
 * `GMAIL_READ_SCOPE`.)
 *
 * Google gives a short-lived access token and a long-lived refresh token.
 * Both live in Vault as the connection's token and are read only through
 * `getProviderToken`, which renews the access token under the per-connection
 * lock. Neither is logged or returned to a browser.
 */
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
/**
 * The optional extra: read-only access to the mailbox, asked for only when a
 * person chooses "…and read emails from the senders you list" while
 * connecting. Without it nothing is ever read. With it, Stock looks only at
 * mail matching the workspace's own sources (lib/stock/mail). What Google
 * granted is recorded in the connection's `scopes`, and every read checks it.
 */
export const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
/** The connect form's choice that asks for it. */
export const GMAIL_WITH_READING = "read";
const SCOPES = ["openid", "email", GMAIL_SEND_SCOPE];
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const SEND_TIMEOUT_MS = 30_000;

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

export const googleMailConfigured = () =>
  Boolean(process.env.GOOGLE_MAIL_CLIENT_ID && process.env.GOOGLE_MAIL_CLIENT_SECRET);

export function createGoogleMailAdapter(
  fetchImpl: Fetch = fetch,
  now: () => number = Date.now,
): ProviderAdapter {
  const tokenRequest = (body: Record<string, string>) =>
    requestJson<TokenResponse>(fetchImpl, "Google", TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: requiredEnv("GOOGLE_MAIL_CLIENT_ID"),
        client_secret: requiredEnv("GOOGLE_MAIL_CLIENT_SECRET"),
        ...body,
      }).toString(),
    });

  return {
    key: "google_mail",
    name: "Gmail (to email orders)",
    blurb:
      "Email purchase orders to your suppliers from your own Gmail, with the PDF attached. It can send; it can't read your mail unless you choose to let Stock read your suppliers' bills.",
    connectFields: [
      {
        name: "access",
        label: "What it may do",
        placeholder: "",
        help: "Reading is only for supplier balances: Stock looks at mail from the senders you list there and nothing else. You can also forward bills to your bills address instead, which needs no reading at all.",
        options: [
          { value: "send", label: "Send purchase orders only" },
          {
            value: GMAIL_WITH_READING,
            label: "Send orders, and read emails from the suppliers I list",
          },
        ],
      },
    ],
    // Only offered where this deployment has a Google app of its own.
    optional: true,
    // Nothing is ever pulled from Gmail.
    nothingToSync: true,
    pollEveryHours: null,
    configured: googleMailConfigured,

    beginConnect({ state, redirectUri, input }) {
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set("client_id", requiredEnv("GOOGLE_MAIL_CLIENT_ID"));
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set(
        "scope",
        (input.access === GMAIL_WITH_READING ? [...SCOPES, GMAIL_READ_SCOPE] : SCOPES).join(" "),
      );
      // "offline" is what makes Google hand over a refresh token; "consent"
      // makes it do so every time, not only the first.
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      url.searchParams.set("state", state);
      return url.toString();
    },

    async completeConnect({ params, redirectUri }): Promise<ConnectedAccount> {
      const code = params.get("code");
      if (!code) throw new ConnectError("Google didn't finish connecting. Try again.");
      const started = now();
      let response: TokenResponse;
      try {
        response = await tokenRequest({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        });
      } catch (err) {
        if (err instanceof ProviderHttpError && err.status < 500) {
          throw new ConnectError("Google didn't finish connecting. Try again.");
        }
        throw err;
      }
      // Google lets people untick a permission on its own screen.
      const granted = (response.scope ?? "").split(/\s+/);
      if (!response.access_token || !granted.includes(GMAIL_SEND_SCOPE)) {
        throw new ConnectError(
          "Google didn't give permission to send email. Connect again and leave “Send email on your behalf” ticked.",
        );
      }
      if (!response.refresh_token) {
        throw new ConnectError(
          "Google didn't give lasting permission. Remove this app under your Google account's third-party access, then connect again.",
        );
      }
      const who = await requestJson<{ email?: string; email_verified?: boolean }>(
        fetchImpl,
        "Google",
        USERINFO_URL,
        {
          headers: { Authorization: `Bearer ${response.access_token}`, Accept: "application/json" },
        },
      );
      const email = (who?.email ?? "").trim().toLowerCase();
      if (!/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(email) || email.length > 200) {
        throw new ConnectError("Google didn't say which mailbox this is. Try connecting again.");
      }
      return {
        // The same mailbox may serve more than one workspace, each with its own permission.
        externalAccountId: `gmail-${randomUUID()}`,
        displayName: email,
        // What Google really granted: reading only if it was asked for and left ticked.
        scopes: granted.includes(GMAIL_READ_SCOPE) ? [...SCOPES, GMAIL_READ_SCOPE] : SCOPES,
        token: {
          access_token: response.access_token,
          refresh_token: response.refresh_token,
          expires_at: started + (response.expires_in ?? 3600) * 1000,
        },
        metadata: { email },
      };
    },

    async refresh(token): Promise<TokenSet> {
      if (!token.refresh_token) {
        throw new ReconnectRequiredError("Gmail has no lasting permission stored");
      }
      const started = now();
      try {
        const response = await tokenRequest({
          grant_type: "refresh_token",
          refresh_token: token.refresh_token,
        });
        if (!response.access_token) throw new ProviderHttpError("Google", 502, "No access token");
        return {
          access_token: response.access_token,
          // Google keeps the same refresh token unless it sends a new one.
          refresh_token: response.refresh_token ?? token.refresh_token,
          expires_at: started + (response.expires_in ?? 3600) * 1000,
        };
      } catch (err) {
        // 400 invalid_grant: the permission was taken back, or ran out.
        if (err instanceof ProviderHttpError && (err.status === 400 || err.status === 401)) {
          throw new ReconnectRequiredError("Google no longer accepts the saved Gmail permission");
        }
        throw err;
      }
    },

    async disconnect(token) {
      await requestJson(fetchImpl, "Google", REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: token.refresh_token ?? token.access_token }).toString(),
      });
    },

    async sync() {
      return { cursor: { checked_at: new Date(now()).toISOString() } };
    },
  };
}

/**
 * Why a send didn't go. `sent` says what we know: "no" when Gmail certainly
 * took nothing (so trying again is safe), "unsure" when we never heard back
 * and it may have gone (so nothing is sent again without a person).
 */
export class GmailSendError extends Error {
  constructor(
    message: string,
    public sent: "no" | "unsure",
    /** `stale`: a fresh sign-in may work. `thread`: the conversation is gone; send it on its own. */
    public fix: "stale" | "thread" | "reconnect" | null = null,
  ) {
    super(message);
    this.name = "GmailSendError";
  }
}

/**
 * Sends one raw (base64url) message from the mailbox the token belongs to.
 * `threadId` keeps a resend in the first send's conversation. The token goes
 * in the Authorization header and nowhere else.
 */
export async function sendGmail(
  accessToken: string,
  raw: string,
  threadId: string | null = null,
  fetchImpl: Fetch = fetch,
): Promise<{ id: string; threadId: string }> {
  let response: Response;
  let data: { id?: unknown; threadId?: unknown; error?: { message?: unknown } } = {};
  try {
    response = await fetchImpl(SEND_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    data = (await response.json().catch(() => ({}))) as typeof data;
  } catch {
    // Deliberately not passing the cause along: it can carry the request.
    throw new GmailSendError(
      "We didn't hear back from Gmail, so we can't tell whether it went. Check your Sent folder before sending again.",
      "unsure",
    );
  }
  if (response.ok && typeof data.id === "string" && data.id) {
    return { id: data.id, threadId: typeof data.threadId === "string" ? data.threadId : data.id };
  }
  const said =
    typeof data.error?.message === "string"
      ? data.error.message.replace(/\s+/g, " ").trim().slice(0, 200)
      : "";
  if (response.ok || response.status >= 500) {
    throw new GmailSendError(
      "Gmail had trouble and didn't say whether it went. Check your Sent folder before sending again.",
      "unsure",
    );
  }
  if (response.status === 401) {
    throw new GmailSendError("Gmail didn't accept the saved permission.", "no", "stale");
  }
  if (response.status === 404 && threadId) {
    throw new GmailSendError("The earlier conversation can't be found in Gmail.", "no", "thread");
  }
  if (response.status === 403 && /has not been used|is disabled|not enabled/i.test(said)) {
    throw new GmailSendError(
      "Sending from Gmail isn't switched on for this app yet (the Gmail API is off in its Google Cloud project). Nothing was sent.",
      "no",
    );
  }
  if (response.status === 403) {
    throw new GmailSendError(
      "Gmail refused to send: the permission to send was taken away. Reconnect Gmail under Connections. Nothing was sent.",
      "no",
      "reconnect",
    );
  }
  if (response.status === 429) {
    throw new GmailSendError(
      "Gmail says this mailbox has sent too much for now. Nothing was sent; try again later.",
      "no",
    );
  }
  throw new GmailSendError(
    said
      ? `Gmail wouldn't send it: ${said}. Nothing was sent.`
      : "Gmail wouldn't send it. Nothing was sent.",
    "no",
  );
}
