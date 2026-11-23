import { getProviderToken, vaultTokenStore } from "../connections/tokens";
import { ReconnectRequiredError } from "../connections/types";

/**
 * The one place the EasyPost API key comes from. Today that is the
 * workspace's own connection, read from Vault through `getProviderToken`
 * (CLAUDE.md rule 3). If the suite ever buys postage on its own account,
 * this is the function that would decide which key a workspace uses;
 * nothing that talks to EasyPost would change.
 *
 * Server-only. Never log the result or send it to a browser.
 */
export async function getLabelKey(
  tenantId: string,
): Promise<{ key: string; connectionId: string }> {
  const stored = await getProviderToken(tenantId, "easypost");
  const key = stored.token.access_token;
  if (!key) throw new ReconnectRequiredError("easypost has no key stored");
  return { key, connectionId: stored.connectionId };
}

/** EasyPost turned the key down: show the connection as needing a new one. */
export async function flagLabelKey(connectionId: string): Promise<void> {
  try {
    await vaultTokenStore().markNeedsReconnect(connectionId, "EasyPost didn't accept the API key");
  } catch (err) {
    console.error("could not flag easypost connection", err instanceof Error ? err.message : err);
  }
}
