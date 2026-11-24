import { getProviderToken, type TokenDeps } from "../connections/tokens";
import { isMichaelsEnv, type MichaelsAccess } from "./client";

/**
 * One workspace's way in to Michaels, read from Vault the only way tokens are
 * read (`getProviderToken`). Server-only. The result holds the key: hand it
 * to the client and nowhere else; never log it or return it to a browser.
 */
export async function getMichaelsAccess(
  tenantId: string,
  deps?: TokenDeps,
): Promise<MichaelsAccess> {
  const stored = await getProviderToken(tenantId, "michaels", deps);
  const env = stored.token.secrets?.env;
  return {
    connectionId: stored.connectionId,
    apiKey: stored.token.access_token,
    env: isMichaelsEnv(env) ? env : "production",
  };
}
