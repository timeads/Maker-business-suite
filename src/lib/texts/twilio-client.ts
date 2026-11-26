import type { Fetch } from "../connections/types";

/**
 * The one way the suite talks to Twilio: plain `fetch` to api.twilio.com,
 * form-encoded, with the business's own Account SID and auth token (read
 * from Vault through `getTwilioAccess`, never logged, never returned to a
 * browser). No SDK. Two calls only:
 *
 *   - look at the account, to prove the keys when connecting;
 *   - send one text.
 *
 * Twilio's status callback is not asked for: a text counts as sent once
 * Twilio has accepted it.
 */

const API = "https://api.twilio.com/2010-04-01";
const TIMEOUT_MS = 20_000;

export type TwilioAccess = {
  accountSid: string;
  authToken: string;
  /** Who the texts come from: a number in E.164, or a Messaging Service id (MG…). */
  sender: string;
};

export const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;
export const AUTH_TOKEN = /^[0-9a-f]{32}$/;
export const SERVICE_SID = /^MG[0-9a-f]{32}$/;
export const SENDER_NUMBER = /^\+[1-9]\d{7,14}$/;

/** How one try went, in the words the once-only record takes. */
export type TextDelivery =
  | { outcome: "sent"; sid: string; detail: "" }
  /** Twilio said no, and might say yes later (a busy moment, keys being fixed). */
  | { outcome: "refused"; detail: string; code: number | null }
  /** Twilio said no for good: a number that can't take texts, or someone who replied STOP. */
  | { outcome: "rejected"; detail: string; code: number | null }
  /** We asked and never got a clear answer: it may have gone, so it is never sent again. */
  | { outcome: "unsure"; detail: string; code: null };

/**
 * Twilio's error codes that no later try will change (from Twilio's error
 * dictionary): 21211 not a valid number, 21610 the person replied STOP,
 * 21612 / 21408 not a number or place this sender can reach, 21614 not a
 * mobile number.
 */
const FOR_GOOD = new Set([21211, 21408, 21610, 21612, 21614]);
/** The person replied STOP to this sender. */
export const UNSUBSCRIBED = 21610;

export class TwilioError extends Error {
  constructor(
    public status: number,
    public code: number | null,
    message: string,
  ) {
    super(message);
    this.name = "TwilioError";
  }
}

const basic = (access: Pick<TwilioAccess, "accountSid" | "authToken">) =>
  `Basic ${Buffer.from(`${access.accountSid}:${access.authToken}`).toString("base64")}`;

/** Twilio's own words from an error answer, short, and never anything of ours. */
function twilioWords(
  text: string,
  access: Pick<TwilioAccess, "authToken">,
): {
  code: number | null;
  message: string;
} {
  let code: number | null = null;
  let message = "";
  try {
    const body = JSON.parse(text) as { code?: unknown; message?: unknown };
    if (typeof body.code === "number") code = body.code;
    if (typeof body.message === "string") message = body.message;
  } catch {
    message = "";
  }
  const clean = message.split(access.authToken).join("…").replace(/\s+/g, " ").trim();
  return { code, message: clean.slice(0, 240) };
}

export function createTwilioClient(access: TwilioAccess, fetchImpl: Fetch = fetch) {
  if (!ACCOUNT_SID.test(access.accountSid)) throw new Error("Not a Twilio Account SID");
  const account = `${API}/Accounts/${access.accountSid}`;

  return {
    /** One harmless read: the account itself. Throws a TwilioError when Twilio says no. */
    async checkAccount(): Promise<{ name: string; status: string; trial: boolean }> {
      const response = await fetchImpl(`${account}.json`, {
        method: "GET",
        headers: { Authorization: basic(access), Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await response.text();
      if (!response.ok) {
        const said = twilioWords(text, access);
        throw new TwilioError(response.status, said.code, said.message);
      }
      const body = JSON.parse(text) as {
        friendly_name?: unknown;
        status?: unknown;
        type?: unknown;
      };
      return {
        name: typeof body.friendly_name === "string" ? body.friendly_name.slice(0, 120) : "",
        status: typeof body.status === "string" ? body.status : "",
        trial: body.type === "Trial",
      };
    },

    /** Sends one text, once. Never throws: every way it can go is an outcome. */
    async sendText(to: string, body: string): Promise<TextDelivery> {
      if (!SENDER_NUMBER.test(to)) {
        return { outcome: "rejected", detail: "That isn't a number we can text.", code: null };
      }
      const form = new URLSearchParams({ To: to, Body: body });
      if (SERVICE_SID.test(access.sender)) form.set("MessagingServiceSid", access.sender);
      else if (SENDER_NUMBER.test(access.sender)) form.set("From", access.sender);
      else return { outcome: "refused", detail: "No sending number is set up.", code: null };

      let response: Response;
      try {
        response = await fetchImpl(`${account}/Messages.json`, {
          method: "POST",
          headers: {
            Authorization: basic(access),
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: form.toString(),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        // Gone with no answer, or no answer in time: it may have been sent.
        return {
          outcome: "unsure",
          detail: "We didn't hear back from Twilio, so we can't tell whether it went.",
          code: null,
        };
      }
      let text = "";
      try {
        text = await response.text();
      } catch {
        text = "";
      }
      if (response.ok) {
        let sid = "";
        try {
          const parsed = JSON.parse(text) as { sid?: unknown };
          if (typeof parsed.sid === "string" && /^(SM|MM)[0-9a-f]{32}$/.test(parsed.sid)) {
            sid = parsed.sid;
          }
        } catch {
          sid = "";
        }
        if (sid) return { outcome: "sent", sid, detail: "" };
        return {
          outcome: "unsure",
          detail: "Twilio answered, but not in a way that says the text was taken.",
          code: null,
        };
      }
      // Twilio's own trouble: the text may or may not have been taken.
      if (response.status >= 500) {
        return {
          outcome: "unsure",
          detail: `Twilio had a problem (${response.status}), so we can't tell whether it went.`,
          code: null,
        };
      }
      const said = twilioWords(text, access);
      const detail = said.message
        ? `Twilio said: ${said.message}${said.code ? ` (error ${said.code})` : ""}`
        : `Twilio said no (${response.status}).`;
      if (said.code !== null && FOR_GOOD.has(said.code)) {
        return { outcome: "rejected", detail, code: said.code };
      }
      return { outcome: "refused", detail, code: said.code };
    },
  };
}
