import { parseMichaelsJson } from "./json";
import type { MichaelsEnvelope } from "./types";

/**
 * The single client for the Michaels Marketplace API. Everything that talks to
 * Michaels goes through here. It handles:
 *  - the `{ code, message, data }` envelope: anything but code "200" is a
 *    failure, even on HTTP 200
 *  - long numeric IDs (kept as strings, see json.ts)
 *  - throttling: rate limits are undocumented, so calls are serialised with a
 *    minimum gap between them
 *  - retries with backoff on 429/5xx, only for calls marked safe to repeat
 *    (reads)
 * The API key is sent as a header and never logged or put in an error message.
 *
 * THIS STAGE CANNOT WRITE. Anything but a GET is refused here, before a
 * request is built, while MICHAELS_WRITES_ENABLED is false, and nothing in the
 * codebase sets it. A later stage that sends stock, prices or orders changes
 * that constant on purpose, with its own review.
 */

/** Stays false in this stage. There is deliberately no setting, flag or env var behind it. */
export const MICHAELS_WRITES_ENABLED: boolean = false;

export const MICHAELS_BASE_URL = {
  production: "https://www.michaels.com/api/mkp/v1",
  sandbox: "https://www.michaels.com/api/mkp/v1/uat",
} as const;

export type MichaelsEnvName = keyof typeof MICHAELS_BASE_URL;

export const isMichaelsEnv = (value: unknown): value is MichaelsEnvName =>
  value === "production" || value === "sandbox";

/**
 * One workspace's way in to Michaels: read from Vault through
 * getProviderToken, handed to every call, kept nowhere else.
 */
export type MichaelsAccess = {
  /** Our id for the connection; the throttle is kept per connection. */
  connectionId: string;
  apiKey: string;
  env: MichaelsEnvName;
};

/** Codes that mean the key itself is bad or expired. */
const KEY_CODES = new Set(["MCU_API_INVALID_API_KEY"]);
/** The key works but isn't allowed this part of the API. */
const PERMISSION_CODES = new Set(["MCU_DEVELOPER_API_DO_NOT_HAVE_PERMISSION"]);

export class MichaelsApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number,
    readonly path: string,
  ) {
    super(message);
    this.name = "MichaelsApiError";
  }

  /** The key is bad, expired or not allowed: stop the run. */
  get isAuthError(): boolean {
    return KEY_CODES.has(this.code) || PERMISSION_CODES.has(this.code) || this.httpStatus === 401;
  }

  /** The key works but lacks a permission (a new key would not help by itself). */
  get isPermissionError(): boolean {
    return PERMISSION_CODES.has(this.code);
  }
}

/** A write was asked for in a stage that only watches. Nothing was sent. */
export class MichaelsWriteRefusedError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
  ) {
    super(`Michaels ${method} ${path} was refused: this stage only reads, nothing is sent.`);
    this.name = "MichaelsWriteRefusedError";
  }
}

export interface MichaelsRequest {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Safe to repeat on a 429/5xx? Defaults to true for GET, false otherwise. */
  retry?: boolean;
}

export interface MichaelsClientOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Minimum gap between calls (default 250ms, about 4 a second). */
  minIntervalMs?: number;
  /** Give up on one call after this long (default 30s), so a stalled request can't hang a run. */
  timeoutMs?: number;
  maxRetries?: number;
}

export type MichaelsMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface MichaelsClient {
  request<T>(method: MichaelsMethod, path: string, req?: MichaelsRequest): Promise<T>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createMichaelsClient(
  access: MichaelsAccess,
  opts: MichaelsClientOptions = {},
): MichaelsClient {
  const base = MICHAELS_BASE_URL[access.env];
  const doFetch: typeof fetch = (input, init) => (opts.fetchImpl ?? globalThis.fetch)(input, init);
  const sleep = opts.sleep ?? defaultSleep;
  const minInterval = opts.minIntervalMs ?? 250;
  const maxRetries = opts.maxRetries ?? 4;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  // Serialise every call through one chain so concurrent jobs can't burst.
  let queue: Promise<unknown> = Promise.resolve();
  let lastCallAt = 0;

  async function once<T>(
    method: string,
    path: string,
    req: MichaelsRequest,
  ): Promise<{ ok: true; data: T } | { ok: false; error: MichaelsApiError; retryable: boolean }> {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const wait = lastCallAt + minInterval - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();

    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers: {
          "Api-Key": access.apiKey,
          accept: "application/json",
          ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      // Only our own words: a network error's message is not ours to trust.
      const msg = timedOut ? `no reply after ${Math.round(timeoutMs / 1000)}s` : "network error";
      return {
        ok: false,
        error: new MichaelsApiError(`Michaels ${method} ${path}: ${msg}`, "NETWORK", 0, path),
        retryable: true,
      };
    }

    const text = await res.text();
    let envelope: MichaelsEnvelope<T> | null = null;
    try {
      const parsed = parseMichaelsJson(text) as MichaelsEnvelope<T>;
      if (parsed && typeof parsed === "object" && "code" in parsed) envelope = parsed;
    } catch {
      /* not JSON: handled below */
    }

    if (!envelope) {
      // Per the docs, a reply that isn't wrapped usually means a wrong domain or route.
      return {
        ok: false,
        error: new MichaelsApiError(
          `Michaels ${method} ${path}: unexpected response (HTTP ${res.status}). Check the route and whether the key is for the sandbox or the real marketplace.`,
          "BAD_RESPONSE",
          res.status,
          path,
        ),
        retryable: res.status === 429 || res.status >= 500,
      };
    }

    const code = String(envelope.code);
    if (code === "200") return { ok: true, data: envelope.data as T };

    return {
      ok: false,
      error: new MichaelsApiError(
        `Michaels ${method} ${path}: ${code}${envelope.message ? ` (${String(envelope.message).slice(0, 200)})` : ""}`,
        code,
        res.status,
        path,
      ),
      retryable:
        res.status === 429 || res.status >= 500 || code === "MCU_API_INTERNAL_SERVER_ERROR",
    };
  }

  async function run<T>(method: string, path: string, req: MichaelsRequest): Promise<T> {
    const canRetry = req.retry ?? method === "GET";
    for (let attempt = 1; ; attempt++) {
      const result = await once<T>(method, path, req);
      if (result.ok) return result.data;
      if (!canRetry || !result.retryable || attempt > maxRetries) throw result.error;
      await sleep(Math.min(16_000, 1000 * 2 ** (attempt - 1)));
    }
  }

  return {
    request<T>(method: MichaelsMethod, path: string, req: MichaelsRequest = {}) {
      // The guard: refused before anything is queued, built or fetched.
      if (method !== "GET" && !MICHAELS_WRITES_ENABLED) {
        return Promise.reject(new MichaelsWriteRefusedError(method, path));
      }
      const p = queue.then(() => run<T>(method, path, req));
      queue = p.catch(() => undefined);
      return p;
    },
  };
}

const clients = new Map<string, { apiKey: string; env: MichaelsEnvName; client: MichaelsClient }>();

/**
 * The client for one workspace's connection, reused while its key stays the
 * same (it holds that connection's throttle). A new key gets a new client.
 */
export function michaelsClientFor(access: MichaelsAccess): MichaelsClient {
  const held = clients.get(access.connectionId);
  if (held && held.apiKey === access.apiKey && held.env === access.env) return held.client;
  const client = createMichaelsClient(access);
  clients.set(access.connectionId, { apiKey: access.apiKey, env: access.env, client });
  return client;
}
