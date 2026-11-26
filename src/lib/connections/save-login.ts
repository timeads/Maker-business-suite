import { getAdminClient } from "../supabase/admin";
import { connectionForLogin, mergeLogins } from "./logins";
import { vaultTokenStore } from "./tokens";
import type { ConnectedAccount, ProviderKey } from "./types";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Saves a login of a provider that holds several (TikTok, LinkedIn). A
 * workspace whose connection is live gets this login ADDED to it, or that
 * login's tokens renewed: the connection's tokens are read and written back
 * under its refresh lock (`save_connection` puts the lock down), so another
 * login being renewed at the same moment is never lost. A workspace with no
 * live connection starts one with just this login. Service role only; the
 * caller has already checked who is connecting.
 */
export async function saveLogin(
  tenantId: string,
  provider: ProviderKey,
  account: ConnectedAccount,
  connectedBy: string,
): Promise<{ error: { code?: string; message: string } | null }> {
  const admin = getAdminClient();
  const store = vaultTokenStore(admin);
  for (let attempt = 0; attempt < 20; attempt++) {
    const { data: existing, error: readError } = await admin
      .from("connections")
      .select("id, status, external_account_id, metadata")
      .eq("tenant_id", tenantId)
      .eq("provider", provider)
      .maybeSingle();
    if (readError) return { error: { message: readError.message } };
    const live = existing && existing.status !== "disconnected";
    if (live && !(await store.lockRefresh(existing.id as string))) {
      await sleep(1_500);
      continue;
    }
    const stored = live ? await store.read(tenantId, provider) : null;
    const row = connectionForLogin(
      live
        ? {
            external_account_id: existing.external_account_id as string,
            metadata: existing.metadata,
          }
        : null,
      account,
    );
    const { error } = await admin.rpc("save_connection", {
      p_tenant_id: tenantId,
      p_provider: provider,
      p_external_account_id: row.externalAccountId,
      p_display_name: row.displayName,
      p_scopes: row.scopes,
      p_token: stored ? mergeLogins(stored.token, account.token) : account.token,
      p_connected_by: connectedBy,
      p_metadata: row.metadata,
    });
    return { error: error ? { code: error.code, message: error.message } : null };
  }
  return { error: { message: `Timed out waiting to add a ${provider} login` } };
}
