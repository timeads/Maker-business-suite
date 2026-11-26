import { getProviderToken, type TokenDeps } from "../connections/tokens";
import { SERVICE_SID, SENDER_NUMBER, type TwilioAccess } from "./twilio-client";

/**
 * One workspace's way in to Twilio, read from Vault the only way tokens are
 * read (`getProviderToken`). Server-only. The result holds the auth token:
 * hand it to the Twilio client or the signature check and nowhere else;
 * never log it or return it to a browser.
 */
export async function getTwilioAccess(tenantId: string, deps?: TokenDeps): Promise<TwilioAccess> {
  const stored = await getProviderToken(tenantId, "twilio", deps);
  const sender = stored.token.secrets?.sender ?? "";
  return {
    accountSid: stored.externalAccountId,
    authToken: stored.token.access_token,
    sender: SERVICE_SID.test(sender) || SENDER_NUMBER.test(sender) ? sender : "",
  };
}
