import { createHash, randomBytes } from "node:crypto";
import { getAdapter } from "../connections/registry";
import { getProviderToken, vaultTokenStore } from "../connections/tokens";
import { ReconnectRequiredError } from "../connections/types";
import { getLabelKey } from "./label-key";
import type { SourceAccess } from "./sources";
import {
  SourceError,
  StaleTokenError,
  type LabelRequest,
  type LabelSourceKey,
} from "./sources/types";
import { UPS_AUTH_HELP } from "./sources/ups";

/**
 * Where each label source's sign-in comes from: the workspace's own
 * connection, read from Vault through `getProviderToken` (CLAUDE.md rule 3).
 * Nothing that talks to a carrier reads a key any other way.
 *
 * Server-only. Never log a result or send it to a browser.
 */
export type Held<K extends LabelSourceKey> = { access: SourceAccess[K]; connectionId: string };

async function upsAccess(tenantId: string, fresh: boolean): Promise<Held<"ups">> {
  const stored = await getProviderToken(tenantId, "ups");
  let token = stored.token;
  if (fresh) {
    // UPS turned a token down before its time: sign in again with the saved keys.
    token = await getAdapter("ups").refresh(stored.token, stored.externalAccountId);
    await vaultTokenStore().save(stored.connectionId, token);
  }
  const account = token.secrets?.account;
  if (!token.access_token || !account) throw new ReconnectRequiredError("ups has no keys stored");
  return {
    access: { token: token.access_token, account, test: token.secrets?.env === "test" },
    connectionId: stored.connectionId,
  };
}

export async function getLabelAccess<K extends LabelSourceKey>(
  tenantId: string,
  source: K,
  fresh = false,
): Promise<Held<K>> {
  if (source === "easypost") {
    const held = await getLabelKey(tenantId);
    return { access: { key: held.key }, connectionId: held.connectionId } as Held<K>;
  }
  if (source === "ups") return (await upsAccess(tenantId, fresh)) as Held<K>;
  const stored = await getProviderToken(tenantId, "redo");
  const storeId = stored.token.secrets?.store_id;
  if (!stored.token.access_token || !storeId) {
    throw new ReconnectRequiredError("redo has no token stored");
  }
  return {
    access: { token: stored.token.access_token, storeId },
    connectionId: stored.connectionId,
  } as Held<K>;
}

/**
 * Runs one call against a source with the workspace's sign-in. A token the
 * source says is out of date is renewed once and the call made again: a
 * request turned away at the door did nothing, so asking again is safe even
 * for a purchase.
 */
export async function withLabelSource<K extends LabelSourceKey, T>(
  tenantId: string,
  source: K,
  run: (access: SourceAccess[K]) => Promise<T>,
  held?: Held<K>,
): Promise<T> {
  const first = held ?? (await getLabelAccess(tenantId, source));
  try {
    return await run(first.access);
  } catch (err) {
    if (!(err instanceof StaleTokenError)) throw err;
  }
  const again = await getLabelAccess(tenantId, source, true);
  try {
    return await run(again.access);
  } catch (err) {
    // A token issued a moment ago and still refused: the app isn't set up for this request.
    if (err instanceof StaleTokenError) throw new SourceError(UPS_AUTH_HELP, 401, false);
    throw err;
  }
}

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .filter(([, item]) => item !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;

const digest = (salt: string, request: LabelRequest) =>
  createHash("sha256")
    .update(`${salt}\n${JSON.stringify(canonical(request))}`)
    .digest("hex");

/**
 * A fingerprint of what was quoted: both addresses, every box, the signature
 * and the reference. The quote keeps this instead of the address itself, and
 * a purchase is only made when the request the server rebuilds matches it.
 */
export function requestFingerprint(request: LabelRequest): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${digest(salt, request)}`;
}

export function matchesFingerprint(fingerprint: unknown, request: LabelRequest): boolean {
  if (typeof fingerprint !== "string") return false;
  const [salt, hash] = fingerprint.split(":");
  return Boolean(salt && hash) && digest(salt, request) === hash;
}
