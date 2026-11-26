import { getProviderToken, type TokenDeps } from "../connections/tokens";
import { EVENTBRITE_ID, type EventbriteAccess } from "./client";

/**
 * One workspace's way in to Eventbrite, read from Vault the only way tokens
 * are read (`getProviderToken`). Server-only. The result holds the private
 * token: hand it to the Eventbrite client and nowhere else; never log it or
 * return it to a browser.
 */
export async function getEventbriteAccess(
  tenantId: string,
  deps?: TokenDeps,
): Promise<EventbriteAccess> {
  const stored = await getProviderToken(tenantId, "eventbrite", deps);
  return {
    connectionId: stored.connectionId,
    token: stored.token.access_token,
    organizationId: EVENTBRITE_ID.test(stored.externalAccountId) ? stored.externalAccountId : "",
  };
}
