import { getProviderToken, type StoredToken, type TokenDeps } from "./tokens";
import { ReconnectRequiredError, type ProviderKey, type TokenSet } from "./types";

/**
 * Several logins inside one connection (TikTok, LinkedIn).
 *
 * The suite keeps one connection per provider per workspace, and every
 * screen and query is built on that. A workspace that posts to two TikTok
 * accounts, or to company pages looked after by two LinkedIn people, has
 * two logins with tokens of their own. They are kept INSIDE the
 * connection's one Vault secret, each under "login:<id>" as a JSON token set
 * (as Meta keeps each Page's token under "page:<id>"). The connection's own
 * token is only the holder ("logins", never expiring), so the usual
 * `getProviderToken` returns it untouched; each login's own token is
 * refreshed here, under the connection's refresh lock, because both
 * platforms rotate refresh tokens and two refreshes at once would undo
 * each other. Nothing here is ever logged or returned to a browser.
 */

export const LOGINS_HOLDER = "logins";

/** Where one login's tokens sit among the connection's. */
export const loginKey = (loginId: string) => `login:${loginId}`;

/** Refresh when a login's token has less than this left. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** A login's token set, from the connection's, or null when it isn't there. */
export function loginToken(token: TokenSet, loginId: string): TokenSet | null {
  const raw = token.secrets?.[loginKey(loginId)];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as TokenSet;
    return typeof parsed?.access_token === "string" && parsed.access_token ? parsed : null;
  } catch {
    return null;
  }
}

/** Every login id the connection holds a token for. */
export const loginIds = (token: TokenSet): string[] =>
  Object.keys(token.secrets ?? {})
    .filter((key) => key.startsWith("login:"))
    .map((key) => key.slice("login:".length));

/** The connection's token set holding just this one login (what a fresh connect saves). */
export const singleLogin = (loginId: string, login: TokenSet): TokenSet => ({
  access_token: LOGINS_HOLDER,
  secrets: { [loginKey(loginId)]: JSON.stringify(login) },
});

/** The connection's token set with this login's tokens put in (added, or replacing its old ones). */
export function withLogin(token: TokenSet | null, loginId: string, login: TokenSet): TokenSet {
  const kept = token?.access_token === LOGINS_HOLDER ? (token.secrets ?? {}) : {};
  return {
    access_token: LOGINS_HOLDER,
    secrets: { ...kept, [loginKey(loginId)]: JSON.stringify(login) },
  };
}

/** The connection's token set without this login. */
export function withoutLogin(token: TokenSet, loginId: string): TokenSet {
  const secrets = { ...(token.secrets ?? {}) };
  delete secrets[loginKey(loginId)];
  return { access_token: LOGINS_HOLDER, secrets };
}

/**
 * Merges a fresh connect (one login, as `completeConnect` built it) into
 * what the connection already holds, so adding an account never forgets the
 * others. Connecting the same login again replaces its tokens.
 */
export function mergeLogins(existing: TokenSet | null, incoming: TokenSet): TokenSet {
  let merged: TokenSet | null = existing;
  for (const id of loginIds(incoming)) {
    const login = loginToken(incoming, id);
    if (login) merged = withLogin(merged, id, login);
  }
  return merged ?? incoming;
}

/** One login as the connection's (never secret) metadata lists it. */
export type LoginInfo = {
  id: string;
  name: string;
  /** What this login was granted. */
  scopes: string[];
  connected_at: string;
  /** When it must be connected again (LinkedIn without a refresh token); null when it renews itself. */
  reconnect_by?: string | null;
};

/** The logins on a connection's metadata. Never trusted for more than names, ids and dates. */
export function loginsOf(metadata: unknown): LoginInfo[] {
  const list = (metadata as { logins?: unknown } | null)?.logins;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const id = typeof item.id === "string" && item.id ? item.id.slice(0, 200) : null;
    if (!id) return [];
    return [
      {
        id,
        name: typeof item.name === "string" && item.name ? item.name.slice(0, 200) : "An account",
        scopes: Array.isArray(item.scopes) ? item.scopes.map(String) : [],
        connected_at: typeof item.connected_at === "string" ? item.connected_at : "",
        reconnect_by: typeof item.reconnect_by === "string" ? item.reconnect_by : null,
      },
    ];
  });
}

/** The connection's metadata with this login listed (added, or replacing its old entry). */
export function metadataWithLogin(
  metadata: Record<string, unknown> | null,
  login: LoginInfo,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const others = loginsOf(metadata).filter((each) => each.id !== login.id);
  return { ...(metadata ?? {}), ...extra, logins: [...others, login] };
}

/** Every scope any of the logins was granted, each once. */
export const allScopes = (logins: readonly LoginInfo[]) => [
  ...new Set(logins.flatMap((login) => login.scopes)),
];

export type LoginDeps = TokenDeps & {
  /** Says a login's accounts need it connected again (or no longer do). */
  markLogin?(info: {
    tenantId: string;
    provider: ProviderKey;
    loginId: string;
    needs: boolean;
  }): Promise<void>;
};

const isFresh = (token: TokenSet, now: number) =>
  token.expires_at === undefined || token.expires_at - now > REFRESH_MARGIN_MS;

/**
 * One login's tokens, good to use right now. It reads the connection through
 * `getProviderToken` (the only way to tokens, CLAUDE.md rule 3), and renews
 * this login's access under the connection's refresh lock, reading the
 * connection afresh once it holds the lock so another login's renewal is
 * never lost. A login that can't be renewed throws ReconnectRequiredError
 * and its accounts are marked; the other logins carry on.
 */
export async function getLoginToken(
  tenantId: string,
  provider: ProviderKey,
  loginId: string,
  deps: LoginDeps,
): Promise<{ stored: StoredToken; token: TokenSet }> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const stored = await getProviderToken(tenantId, provider, deps);
    const login = loginToken(stored.token, loginId);
    if (!login) {
      throw new ReconnectRequiredError(`This ${provider} account needs connecting again`);
    }
    if (isFresh(login, deps.now())) return { stored, token: login };

    if (!(await deps.store.lockRefresh(stored.connectionId))) {
      await deps.wait(1_500);
      continue;
    }
    // Under the lock: read again, in case another renewal finished meanwhile.
    const fresh = await deps.store.read(tenantId, provider);
    const current = fresh ? loginToken(fresh.token, loginId) : null;
    if (!fresh || !current) {
      throw new ReconnectRequiredError(`This ${provider} account needs connecting again`);
    }
    if (isFresh(current, deps.now())) {
      // Someone renewed it while we waited; put the lock down by saving what is there.
      await deps.store.save(fresh.connectionId, fresh.token);
      return { stored: fresh, token: current };
    }
    try {
      const renewed = await deps.adapter(provider).refresh(current, loginId);
      await deps.store.save(fresh.connectionId, withLogin(fresh.token, loginId, renewed));
      return { stored: fresh, token: renewed };
    } catch (err) {
      if (err instanceof ReconnectRequiredError) {
        // Only this login is over; the connection and its other logins stand.
        await deps.store.save(fresh.connectionId, fresh.token);
        await deps.markLogin?.({ tenantId, provider, loginId, needs: true });
      }
      throw err;
    }
  }
  throw new Error(`Timed out waiting for ${provider} tokens to refresh`);
}

/**
 * Changes the connection's logins (adds one, takes one away) under the
 * refresh lock, so a renewal running at the same moment isn't overwritten.
 * `change` gets what is stored now and returns what to store.
 */
export async function changeLogins(
  tenantId: string,
  provider: ProviderKey,
  change: (token: TokenSet) => TokenSet,
  deps: Pick<TokenDeps, "store" | "wait">,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const stored = await deps.store.read(tenantId, provider);
    if (!stored) throw new ReconnectRequiredError(`${provider} is not connected`);
    if (!(await deps.store.lockRefresh(stored.connectionId))) {
      await deps.wait(1_500);
      continue;
    }
    const fresh = (await deps.store.read(tenantId, provider)) ?? stored;
    await deps.store.save(fresh.connectionId, change(fresh.token));
    return;
  }
  throw new Error(`Timed out waiting to change ${provider} logins`);
}

/** What a connect of one login brings: its tokens, what to list, and the accounts it offers. */
export type LoginAccount = {
  externalAccountId: string;
  displayName: string;
  scopes: string[];
  token: TokenSet;
  metadata?: Record<string, unknown>;
};

/** The accounts a login offered, as `completeConnect` put them on its metadata. */
export function offeredBy(metadata: unknown): Record<string, unknown>[] {
  const list = (metadata as { offered?: unknown } | null)?.offered;
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

/**
 * The connection row after a login is connected: the one it had, with this
 * login listed among its logins (or a fresh connection of just this login).
 * The connection keeps its first login's id, so it is never "moved" to
 * another account; its name lists who is connected. Pure.
 */
export function connectionForLogin(
  existing: { external_account_id: string; metadata: unknown } | null,
  account: LoginAccount,
): {
  externalAccountId: string;
  displayName: string;
  scopes: string[];
  metadata: Record<string, unknown>;
} {
  const [login] = loginsOf(account.metadata).filter(
    (each) => each.id === account.externalAccountId,
  );
  const info: LoginInfo = login ?? {
    id: account.externalAccountId,
    name: account.displayName,
    scopes: account.scopes,
    connected_at: new Date().toISOString(),
  };
  const before = existing ? ((existing.metadata ?? {}) as Record<string, unknown>) : {};
  const { offered: _offered, ...kept } = before;
  void _offered;
  const metadata = metadataWithLogin(existing ? kept : {}, info);
  const logins = loginsOf(metadata);
  const names = logins.map((each) => each.name);
  return {
    externalAccountId: existing?.external_account_id ?? account.externalAccountId,
    displayName: names.length <= 2 ? names.join(" · ") : `${names[0]} and ${names.length - 1} more`,
    scopes: allScopes(logins),
    metadata,
  };
}
