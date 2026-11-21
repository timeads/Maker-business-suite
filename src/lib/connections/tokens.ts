import type { SupabaseClient } from "@supabase/supabase-js";
import { getAdminClient } from "../supabase/admin";
import { getAdapter } from "./registry";
import {
  ReconnectRequiredError,
  type ConnectionStatus,
  type ProviderAdapter,
  type ProviderKey,
  type TokenSet,
} from "./types";

/** Refresh when a token has less than this left. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type StoredToken = {
  connectionId: string;
  externalAccountId: string;
  status: ConnectionStatus;
  token: TokenSet;
};

/** Where tokens live. The real one talks to Vault through service-role RPCs. */
export type TokenStore = {
  read(tenantId: string, provider: ProviderKey): Promise<StoredToken | null>;
  lockRefresh(connectionId: string): Promise<boolean>;
  save(connectionId: string, token: TokenSet): Promise<void>;
  markNeedsReconnect(connectionId: string, reason: string): Promise<void>;
};

export function vaultTokenStore(admin: SupabaseClient = getAdminClient()): TokenStore {
  const fail = (what: string, message: string) => new Error(`${what}: ${message}`);
  return {
    async read(tenantId, provider) {
      const { data, error } = await admin.rpc("get_provider_token", {
        p_tenant_id: tenantId,
        p_provider: provider,
      });
      if (error) throw fail("Could not read connection", error.message);
      const row = (data as Record<string, unknown>[] | null)?.[0];
      if (!row) return null;
      return {
        connectionId: row.connection_id as string,
        externalAccountId: row.external_account_id as string,
        status: row.status as ConnectionStatus,
        token: row.token as TokenSet,
      };
    },
    async lockRefresh(connectionId) {
      const { data, error } = await admin.rpc("lock_connection_refresh", {
        p_connection_id: connectionId,
      });
      if (error) throw fail("Could not lock connection", error.message);
      return data === true;
    },
    async save(connectionId, token) {
      const { error } = await admin.rpc("store_provider_token", {
        p_connection_id: connectionId,
        p_token: token,
      });
      if (error) throw fail("Could not store tokens", error.message);
    },
    async markNeedsReconnect(connectionId, reason) {
      const { error } = await admin.rpc("mark_connection", {
        p_connection_id: connectionId,
        p_status: "needs_reconnect",
        p_error: reason,
      });
      if (error) throw fail("Could not update connection", error.message);
    },
  };
}

export type TokenDeps = {
  store: TokenStore;
  adapter(provider: ProviderKey): ProviderAdapter;
  now(): number;
  wait(ms: number): Promise<void>;
  /** Called once when a connection flips to needing a reconnect. */
  onNeedsReconnect?(info: {
    tenantId: string;
    provider: ProviderKey;
    reason: string;
  }): Promise<void>;
};

const liveDeps = (): TokenDeps => ({
  store: vaultTokenStore(),
  adapter: getAdapter,
  now: Date.now,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

const isFresh = (token: TokenSet, now: number) =>
  token.expires_at === undefined || token.expires_at - now > REFRESH_MARGIN_MS;

/**
 * The only way to get a provider's tokens (CLAUDE.md rule 3). Returns a token
 * that is good to use right now, refreshing it first if needed. Never log or
 * return the result to a browser.
 *
 * Refreshing is serialised per connection: providers rotate refresh tokens,
 * so two callers refreshing at once would invalidate each other.
 */
export async function getProviderToken(
  tenantId: string,
  provider: ProviderKey,
  deps: TokenDeps = liveDeps(),
): Promise<StoredToken> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const stored = await deps.store.read(tenantId, provider);
    if (!stored) throw new ReconnectRequiredError(`${provider} is not connected`);
    if (stored.status === "needs_reconnect") {
      throw new ReconnectRequiredError(`${provider} needs to be reconnected`);
    }
    if (isFresh(stored.token, deps.now())) return stored;

    if (!(await deps.store.lockRefresh(stored.connectionId))) {
      // Someone else is refreshing; pick up their result.
      await deps.wait(1_500);
      continue;
    }

    try {
      const token = await deps.adapter(provider).refresh(stored.token, stored.externalAccountId);
      await deps.store.save(stored.connectionId, token);
      return { ...stored, token };
    } catch (err) {
      if (err instanceof ReconnectRequiredError) {
        await deps.store.markNeedsReconnect(stored.connectionId, err.message);
        await deps.onNeedsReconnect?.({ tenantId, provider, reason: err.message });
      }
      // Any other failure leaves the lock to expire on its own, which spaces out retries.
      throw err;
    }
  }
  throw new Error(`Timed out waiting for ${provider} tokens to refresh`);
}
