import { createHash } from "node:crypto";
import type { Fetch } from "../connections/types";

/**
 * The one way the suite talks to TikTok: plain `fetch`, no SDK. Login Kit
 * (sign in, renew, revoke) and the Content Posting API (creator info, a
 * direct post of a video sent as a file, its publish status) all go through
 * here, with the login's own token in the Authorization header and nowhere
 * else (never logged, never put in an error, never returned to a browser).
 *
 * Calls, all written from memory and listed in docs/tiktok-linkedin.md to
 * check before going live:
 *   GET  https://www.tiktok.com/v2/auth/authorize/            (the person's browser)
 *   POST https://open.tiktokapis.com/v2/oauth/token/          (code → tokens; renew)
 *   POST https://open.tiktokapis.com/v2/oauth/revoke/
 *   GET  https://open.tiktokapis.com/v2/user/info/?fields=…
 *   POST https://open.tiktokapis.com/v2/post/publish/creator_info/query/
 *   POST https://open.tiktokapis.com/v2/post/publish/video/init/
 *   PUT  <upload_url TikTok gave, on *.tiktokapis.com>
 *   POST https://open.tiktokapis.com/v2/post/publish/status/fetch/
 *
 * Reads (user info, creator info, publish status) are tried again after a
 * busy answer or a lost connection; writes never are: how a write went is
 * reported once (`TikTokError.applied`) and the post's once-only record
 * decides what happens next.
 */

export const TIKTOK_AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
export const TIKTOK_API = "https://open.tiktokapis.com/v2";
/** What posting needs: who the account is, and publishing straight to it. */
export const TIKTOK_SCOPES = ["user.info.basic", "video.publish"] as const;
/** One chunk can carry a whole video up to this size; bigger ones go in parts. */
const SINGLE_CHUNK_MAX = 64 * 1024 * 1024;
const CHUNK_SIZE = 10 * 1024 * 1024;

/**
 * Whether a write might have taken effect:
 *   no      TikTok answered and said no: nothing changed.
 *   unknown we never got a clear answer (5xx, timeout, lost connection).
 */
export type Applied = "no" | "unknown";

export class TikTokError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** TikTok's own short code ("access_token_invalid", "spam_risk_too_many_posts"). */
    readonly code: string,
    /** TikTok's words, cut short; never anything of ours that is secret. */
    readonly words: string,
    readonly applied: Applied,
  ) {
    super(message);
    this.name = "TikTokError";
  }

  /** The login's token is wrong, ran out, or lacks the permission. */
  get isAuthError(): boolean {
    return (
      this.status === 401 ||
      ["access_token_invalid", "scope_not_authorized", "invalid_grant", "invalid_token"].includes(
        this.code,
      )
    );
  }
}

export type TikTokTokens = {
  access_token: string;
  refresh_token: string;
  /** Seconds. */
  expires_in: number;
  refresh_expires_in: number;
  open_id: string;
  scope: string;
};

export type TikTokUser = {
  openId: string;
  displayName: string;
  /** Without the "@", when TikTok gives it (it needs a further permission). */
  username: string | null;
};

export type PublishStatus = {
  status:
    | "PROCESSING_UPLOAD"
    | "PROCESSING_DOWNLOAD"
    | "SEND_TO_USER_INBOX"
    | "PUBLISH_COMPLETE"
    | "FAILED"
    | string;
  failReason: string;
  /** The post's id on TikTok, once it is up and public (TikTok spells the field "publicaly"). */
  postId: string | null;
};

export interface TikTokClientOptions {
  fetchImpl?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  /** How many more times a read is tried after a busy answer (default 2). */
  maxRetries?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const text = (value: unknown, max = 200) =>
  (typeof value === "string" ? value : "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * The PKCE challenge for a verifier. TikTok's own pages have described it as
 * the SHA-256 of the verifier in hex, unlike the base64url most providers
 * use; `TIKTOK_PKCE_ENCODING=base64url` switches if that turns out wrong
 * (docs/tiktok-linkedin.md).
 */
export function pkceChallenge(verifier: string, encoding = process.env.TIKTOK_PKCE_ENCODING) {
  const digest = createHash("sha256").update(verifier);
  return encoding === "base64url" ? digest.digest("base64url") : digest.digest("hex");
}

export function tiktokAuthorizeUrl(input: {
  clientKey: string;
  redirectUri: string;
  state: string;
  codeVerifier: string;
}): string {
  const url = new URL(TIKTOK_AUTHORIZE_URL);
  url.searchParams.set("client_key", input.clientKey);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", TIKTOK_SCOPES.join(","));
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", pkceChallenge(input.codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** Only TikTok's own upload hosts get a video. */
export function isTikTokUploadUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      (url.hostname === "tiktokapis.com" || url.hostname.endsWith(".tiktokapis.com"))
    );
  } catch {
    return false;
  }
}

/** How a file of this size is sent: one chunk, or 10 MB chunks with the rest in the last. */
export function chunkPlan(size: number): { chunkSize: number; count: number } {
  if (size <= SINGLE_CHUNK_MAX) return { chunkSize: size, count: 1 };
  return { chunkSize: CHUNK_SIZE, count: Math.floor(size / CHUNK_SIZE) };
}

/** TikTok's error envelope ({error: {code, message}}) or the OAuth one ({error, error_description}). */
function wordsOf(body: unknown): { code: string; words: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (b.error && typeof b.error === "object") {
    const e = b.error as Record<string, unknown>;
    return { code: text(e.code, 80), words: text(e.message) };
  }
  return { code: text(b.error, 80), words: text(b.error_description) || text(b.error, 80) };
}

type Once = { ok: true; body: unknown } | { ok: false; error: TikTokError; busy: boolean };

function caller(opts: TikTokClientOptions) {
  const doFetch: Fetch = (input, init) => (opts.fetchImpl ?? globalThis.fetch)(input, init);
  const sleep = opts.sleep ?? defaultSleep;
  const maxRetries = opts.maxRetries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 20_000;

  async function once(url: string, init: RequestInit): Promise<Once> {
    let response: Response;
    try {
      response = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      // Deliberately not passing the cause along: it can carry the request.
      return {
        ok: false,
        busy: true,
        error: new TikTokError("We didn't hear back from TikTok", 0, "", "", "unknown"),
      };
    }
    const raw = await response.text().catch(() => "");
    let body: unknown = null;
    try {
      // TikTok's post ids are bigger than a JavaScript number holds: keep long ones as text.
      body = raw ? JSON.parse(raw.replace(/([:[,]\s*)(\d{16,})(?=\s*[,\]}])/g, '$1"$2"')) : null;
    } catch {
      body = null;
    }
    const { code, words } = wordsOf(body);
    // A 200 can still carry an error ("ok" means none).
    if (response.ok && (!code || code === "ok")) return { ok: true, body };
    const status = response.ok ? 400 : response.status;
    const busy = status === 429 || status >= 500 || code === "rate_limit_exceeded";
    return {
      ok: false,
      busy,
      error: new TikTokError(
        `TikTok answered ${status}${code ? ` (${code})` : ""}`,
        status,
        code,
        words,
        status >= 500 ? "unknown" : "no",
      ),
    };
  }

  /** A read: tried again after a busy answer. */
  async function read(url: string, init: RequestInit): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const result = await once(url, init);
      if (result.ok) return result.body;
      if (!result.busy || attempt >= maxRetries) throw result.error;
      await sleep(1_000 * 2 ** attempt);
    }
  }

  /** A write: asked once. */
  async function write(url: string, init: RequestInit): Promise<unknown> {
    const result = await once(url, init);
    if (result.ok) return result.body;
    throw result.error;
  }

  return { read, write, doFetch, timeoutMs };
}

const form = (body: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
  body: new URLSearchParams(body).toString(),
});

/** Signing in, renewing and revoking with the app's own key and secret. */
export function createTikTokOAuth(
  app: { clientKey: string; clientSecret: string },
  opts: TikTokClientOptions = {},
) {
  const { write } = caller(opts);
  const tokens = (body: unknown): TikTokTokens => {
    const b = (body ?? {}) as Record<string, unknown>;
    // Some answers wrap the tokens in `data`.
    const t = (b.data && typeof b.data === "object" ? b.data : b) as Record<string, unknown>;
    if (typeof t.access_token !== "string" || !t.access_token || typeof t.open_id !== "string") {
      throw new TikTokError("TikTok didn't send tokens", 502, "", "", "no");
    }
    return {
      access_token: t.access_token,
      refresh_token: typeof t.refresh_token === "string" ? t.refresh_token : "",
      expires_in: Number(t.expires_in) || 86_400,
      refresh_expires_in: Number(t.refresh_expires_in) || 0,
      open_id: t.open_id,
      scope: typeof t.scope === "string" ? t.scope : "",
    };
  };
  return {
    async exchangeCode(code: string, redirectUri: string, codeVerifier: string) {
      return tokens(
        await write(
          `${TIKTOK_API}/oauth/token/`,
          form({
            client_key: app.clientKey,
            client_secret: app.clientSecret,
            code,
            grant_type: "authorization_code",
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
          }),
        ),
      );
    },
    async refresh(refreshToken: string) {
      return tokens(
        await write(
          `${TIKTOK_API}/oauth/token/`,
          form({
            client_key: app.clientKey,
            client_secret: app.clientSecret,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
          }),
        ),
      );
    },
    async revoke(token: string) {
      await write(
        `${TIKTOK_API}/oauth/revoke/`,
        form({ client_key: app.clientKey, client_secret: app.clientSecret, token }),
      );
    },
  };
}

export type TikTokClient = ReturnType<typeof createTikTokClient>;

/** Everything done as one login, with its own access token. */
export function createTikTokClient(accessToken: string, opts: TikTokClientOptions = {}) {
  const { read, write, doFetch, timeoutMs } = caller(opts);
  const auth = { Authorization: `Bearer ${accessToken}` };
  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(body),
  });
  const dataOf = (body: unknown) => ((body ?? {}) as { data?: Record<string, unknown> }).data ?? {};

  return {
    async userInfo(): Promise<TikTokUser> {
      const data = dataOf(
        await read(`${TIKTOK_API}/user/info/?fields=open_id,display_name,username`, {
          headers: auth,
        }),
      );
      const user = (data.user ?? {}) as Record<string, unknown>;
      return {
        openId: text(user.open_id, 200),
        displayName: text(user.display_name, 100) || "TikTok account",
        username: /^[A-Za-z0-9._]{1,30}$/.test(String(user.username ?? ""))
          ? String(user.username)
          : null,
      };
    },

    /** What this creator may choose for a post right now. A read, though TikTok wants a POST. */
    async creatorInfo(): Promise<Record<string, unknown>> {
      return dataOf(await read(`${TIKTOK_API}/post/publish/creator_info/query/`, json({})));
    },

    /**
     * Starts a direct post of a video we send as a file. Nothing is posted
     * until the file has arrived in full, so a refusal here, or a lost
     * answer, leaves nothing on TikTok.
     */
    async initVideo(postInfo: Record<string, unknown>, size: number) {
      const plan = chunkPlan(size);
      const data = dataOf(
        await write(
          `${TIKTOK_API}/post/publish/video/init/`,
          json({
            post_info: postInfo,
            source_info: {
              source: "FILE_UPLOAD",
              video_size: size,
              chunk_size: plan.chunkSize,
              total_chunk_count: plan.count,
            },
          }),
        ),
      );
      const publishId = text(data.publish_id, 200);
      const uploadUrl = typeof data.upload_url === "string" ? data.upload_url : "";
      if (!publishId || !isTikTokUploadUrl(uploadUrl)) {
        throw new TikTokError("TikTok didn't say where to send the video", 502, "", "", "no");
      }
      return { publishId, uploadUrl, plan };
    },

    /**
     * Sends the video, chunk by chunk, to the address TikTok gave. Asked once
     * per chunk; the publish status says afterwards what TikTok made of it.
     */
    async uploadVideo(uploadUrl: string, video: Uint8Array, mimeType: string) {
      if (!isTikTokUploadUrl(uploadUrl)) {
        throw new TikTokError("That isn't TikTok's upload address", 400, "", "", "no");
      }
      const { chunkSize, count } = chunkPlan(video.byteLength);
      for (let index = 0; index < count; index++) {
        const start = index * chunkSize;
        const end = index === count - 1 ? video.byteLength : start + chunkSize;
        let response: Response;
        try {
          response = await doFetch(uploadUrl, {
            method: "PUT",
            headers: {
              "Content-Type": mimeType,
              "Content-Range": `bytes ${start}-${end - 1}/${video.byteLength}`,
            },
            body: video.slice(start, end),
            signal: AbortSignal.timeout(Math.max(timeoutMs, 120_000)),
          });
        } catch {
          throw new TikTokError(
            "We didn't hear back from TikTok while sending the video",
            0,
            "",
            "",
            index === count - 1 ? "unknown" : "no",
          );
        }
        if (!response.ok) {
          throw new TikTokError(
            `TikTok answered ${response.status} to the video`,
            response.status,
            "",
            "",
            response.status >= 500 && index === count - 1 ? "unknown" : "no",
          );
        }
      }
    },

    async publishStatus(publishId: string): Promise<PublishStatus> {
      const data = dataOf(
        await read(`${TIKTOK_API}/post/publish/status/fetch/`, json({ publish_id: publishId })),
      );
      const ids = data.publicaly_available_post_id ?? data.publicly_available_post_id;
      const first = Array.isArray(ids) ? ids[0] : null;
      return {
        status: text(data.status, 60),
        failReason: text(data.fail_reason, 200),
        postId: first === null || first === undefined ? null : String(first).slice(0, 100),
      };
    },
  };
}
