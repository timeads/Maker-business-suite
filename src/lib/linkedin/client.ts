import type { Fetch } from "../connections/types";

/**
 * The one way the suite talks to LinkedIn: plain `fetch`, no SDK. Signing in
 * (OAuth 2.0), who is signed in, the company pages they look after, and the
 * Posts API with its image and video uploads all go through here, with the
 * login's own token in the Authorization header and nowhere else.
 *
 * The versioned ("/rest") calls carry `LinkedIn-Version` (YYYYMM; LinkedIn
 * retires each version about a year after it ships, so it is a setting,
 * `LINKEDIN_API_VERSION`) and `X-Restli-Protocol-Version: 2.0.0`. Calls,
 * all written from memory and listed in docs/tiktok-linkedin.md to check
 * before going live:
 *   GET  https://www.linkedin.com/oauth/v2/authorization       (the person's browser)
 *   POST https://www.linkedin.com/oauth/v2/accessToken        (code → token; renew)
 *   POST https://www.linkedin.com/oauth/v2/revoke
 *   GET  https://api.linkedin.com/v2/userinfo                 (OpenID Connect)
 *   GET  https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&state=APPROVED
 *   GET  https://api.linkedin.com/rest/organizations/{id}
 *   POST https://api.linkedin.com/rest/images?action=initializeUpload
 *   GET  https://api.linkedin.com/rest/images/{urn}
 *   POST https://api.linkedin.com/rest/videos?action=initializeUpload
 *   POST https://api.linkedin.com/rest/videos?action=finalizeUpload
 *   GET  https://api.linkedin.com/rest/videos/{urn}
 *   PUT  <uploadUrl LinkedIn gave, on its own hosts>
 *   POST https://api.linkedin.com/rest/posts
 *
 * Reads are tried again after a busy answer or a lost connection; writes
 * never are. Only creating the post publishes anything; an upload that goes
 * wrong leaves nothing anyone can see.
 */

export const LINKEDIN_AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
const OAUTH = "https://www.linkedin.com/oauth/v2";
const API = "https://api.linkedin.com";
/** Posting as the person who signs in. */
export const LINKEDIN_MEMBER_SCOPES = ["openid", "profile", "w_member_social"] as const;
/**
 * Posting as the company pages they look after, and finding those pages.
 * Only an app LinkedIn approved for its Community Management API has these;
 * asking for them otherwise fails the whole sign-in, so they are asked for
 * only where `LINKEDIN_COMPANY_PAGES=true`.
 */
export const LINKEDIN_ORG_SCOPES = ["w_organization_social", "rw_organization_admin"] as const;
/** Roles on a company page that may post as it. */
export const POSTING_ROLES = ["ADMINISTRATOR", "CONTENT_ADMINISTRATOR"] as const;

export const linkedinVersion = () => process.env.LINKEDIN_API_VERSION || "202610";
export const linkedinCompanyPages = () => process.env.LINKEDIN_COMPANY_PAGES === "true";

export type Applied = "no" | "unknown";

export class LinkedInError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** LinkedIn's own short code, when it gave one. */
    readonly code: string,
    /** LinkedIn's words, cut short; never anything of ours that is secret. */
    readonly words: string,
    readonly applied: Applied,
  ) {
    super(message);
    this.name = "LinkedInError";
  }

  get isAuthError(): boolean {
    return (
      this.status === 401 || this.code === "invalid_grant" || this.code === "REVOKED_ACCESS_TOKEN"
    );
  }
}

export type LinkedInTokens = {
  access_token: string;
  /** Seconds. */
  expires_in: number;
  /** Only apps LinkedIn has approved for it get these. */
  refresh_token: string | null;
  refresh_token_expires_in: number | null;
  scope: string;
};

export type LinkedInMember = { sub: string; name: string };
export type LinkedInOrganization = { urn: string; name: string; role: string };
export type MediaStatus = "AVAILABLE" | "PROCESSING" | "WAITING_UPLOAD" | "FAILED" | string;

export interface LinkedInClientOptions {
  fetchImpl?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxRetries?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const text = (value: unknown, max = 200) =>
  (typeof value === "string" ? value : "").replace(/\s+/g, " ").trim().slice(0, max);

/** A person or company page, as LinkedIn names them in an author field. */
export const LINKEDIN_URN = /^urn:li:(person|organization):[A-Za-z0-9_-]{1,100}$/;
const MEDIA_URN = /^urn:li:(image|video|digitalmediaAsset):[A-Za-z0-9_-]{1,200}$/;

/** Only LinkedIn's own hosts get a file. */
export function isLinkedInUploadUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname;
    return (
      url.protocol === "https:" &&
      (host === "linkedin.com" ||
        host.endsWith(".linkedin.com") ||
        host === "licdn.com" ||
        host.endsWith(".licdn.com"))
    );
  } catch {
    return false;
  }
}

/**
 * Words as LinkedIn's posts take them ("little text"): characters it reads
 * as markup are escaped with a backslash, or it cuts the post short or
 * refuses it. Hashtags therefore go as plain words, not links.
 */
export function littleText(words: string): string {
  return words.replace(/[\\|{}@[\]()<>#*_~]/g, (ch) => `\\${ch}`);
}

function wordsOf(body: unknown): { code: string; words: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  return {
    code: text(b.serviceErrorCode, 40) || text(b.code, 80) || text(b.error, 80),
    words: text(b.message) || text(b.error_description) || text(b.error, 80),
  };
}

type Once =
  | { ok: true; body: unknown; headers: Headers }
  | { ok: false; error: LinkedInError; busy: boolean };

function caller(opts: LinkedInClientOptions) {
  const doFetch: Fetch = (input, init) => (opts.fetchImpl ?? globalThis.fetch)(input, init);
  const sleep = opts.sleep ?? defaultSleep;
  const maxRetries = opts.maxRetries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 20_000;

  async function once(url: string, init: RequestInit, timeout = timeoutMs): Promise<Once> {
    let response: Response;
    try {
      response = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
    } catch {
      return {
        ok: false,
        busy: true,
        error: new LinkedInError("We didn't hear back from LinkedIn", 0, "", "", "unknown"),
      };
    }
    const raw = await response.text().catch(() => "");
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    if (response.ok) return { ok: true, body, headers: response.headers };
    const { code, words } = wordsOf(body);
    return {
      ok: false,
      busy: response.status === 429 || response.status >= 500,
      error: new LinkedInError(
        `LinkedIn answered ${response.status}`,
        response.status,
        code,
        words,
        response.status >= 500 ? "unknown" : "no",
      ),
    };
  }

  async function read(url: string, init: RequestInit) {
    for (let attempt = 0; ; attempt++) {
      const result = await once(url, init);
      if (result.ok) return result;
      if (!result.busy || attempt >= maxRetries) throw result.error;
      await sleep(1_000 * 2 ** attempt);
    }
  }

  async function write(url: string, init: RequestInit, timeout?: number) {
    const result = await once(url, init, timeout);
    if (result.ok) return result;
    throw result.error;
  }

  return { read, write };
}

/** Signing in, renewing and revoking with the app's own id and secret. */
export function createLinkedInOAuth(
  app: { clientId: string; clientSecret: string },
  opts: LinkedInClientOptions = {},
) {
  const { write } = caller(opts);
  const form = (body: Record<string, string>): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      ...body,
    }).toString(),
  });
  const tokens = (body: unknown): LinkedInTokens => {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.access_token !== "string" || !b.access_token) {
      throw new LinkedInError("LinkedIn didn't send a token", 502, "", "", "no");
    }
    return {
      access_token: b.access_token,
      expires_in: Number(b.expires_in) || 0,
      refresh_token:
        typeof b.refresh_token === "string" && b.refresh_token ? b.refresh_token : null,
      refresh_token_expires_in: Number(b.refresh_token_expires_in) || null,
      scope: typeof b.scope === "string" ? b.scope : "",
    };
  };
  return {
    authorizeUrl(input: { redirectUri: string; state: string; scopes: readonly string[] }) {
      const url = new URL(LINKEDIN_AUTHORIZE_URL);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", app.clientId);
      url.searchParams.set("redirect_uri", input.redirectUri);
      url.searchParams.set("state", input.state);
      url.searchParams.set("scope", input.scopes.join(" "));
      return url.toString();
    },
    async exchangeCode(code: string, redirectUri: string) {
      return tokens(
        (
          await write(
            `${OAUTH}/accessToken`,
            form({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
          )
        ).body,
      );
    },
    async refresh(refreshToken: string) {
      return tokens(
        (
          await write(
            `${OAUTH}/accessToken`,
            form({ grant_type: "refresh_token", refresh_token: refreshToken }),
          )
        ).body,
      );
    },
    async revoke(token: string) {
      await write(`${OAUTH}/revoke`, form({ token }));
    },
  };
}

export type LinkedInClient = ReturnType<typeof createLinkedInClient>;

/** Everything done as one signed-in person, with their own access token. */
export function createLinkedInClient(accessToken: string, opts: LinkedInClientOptions = {}) {
  const { read, write } = caller(opts);
  const rest = (extra: Record<string, string> = {}): Record<string, string> => ({
    Authorization: `Bearer ${accessToken}`,
    "LinkedIn-Version": linkedinVersion(),
    "X-Restli-Protocol-Version": "2.0.0",
    ...extra,
  });
  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: rest({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  const urnPath = (urn: string) => encodeURIComponent(urn);
  const value = (body: unknown) =>
    ((body ?? {}) as { value?: Record<string, unknown> }).value ?? {};

  async function put(uploadUrl: string, bytes: Uint8Array, mimeType: string): Promise<string> {
    if (!isLinkedInUploadUrl(uploadUrl)) {
      throw new LinkedInError("That isn't LinkedIn's upload address", 400, "", "", "no");
    }
    const answer = await write(
      uploadUrl,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": mimeType || "application/octet-stream",
        },
        body: bytes as unknown as BodyInit,
      },
      120_000,
    );
    return (answer.headers.get("etag") ?? "").replace(/"/g, "");
  }

  return {
    async member(): Promise<LinkedInMember> {
      const { body } = await read(`${API}/v2/userinfo`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const b = (body ?? {}) as Record<string, unknown>;
      const sub = text(b.sub, 100);
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(sub)) {
        throw new LinkedInError("LinkedIn didn't say who signed in", 502, "", "", "no");
      }
      return { sub, name: text(b.name, 100) || "LinkedIn member" };
    },

    /** The company pages this person may post as. */
    async organizations(): Promise<LinkedInOrganization[]> {
      const { body } = await read(
        `${API}/rest/organizationAcls?q=roleAssignee&state=APPROVED&count=100`,
        { headers: rest() },
      );
      const elements = ((body ?? {}) as { elements?: unknown[] }).elements ?? [];
      const found = new Map<string, string>();
      for (const raw of elements) {
        const e = (raw ?? {}) as Record<string, unknown>;
        const urn = text(e.organization ?? e.organizationTarget, 120);
        const role = text(e.role, 60);
        if (LINKEDIN_URN.test(urn) && urn.startsWith("urn:li:organization:")) {
          if ((POSTING_ROLES as readonly string[]).includes(role)) found.set(urn, role);
        }
      }
      const orgs: LinkedInOrganization[] = [];
      for (const [urn, role] of [...found].slice(0, 50)) {
        const id = urn.split(":").pop()!;
        let name = "LinkedIn page";
        try {
          const { body: org } = await read(`${API}/rest/organizations/${encodeURIComponent(id)}`, {
            headers: rest(),
          });
          name = text((org as Record<string, unknown>)?.localizedName, 100) || name;
        } catch {
          // The page is still offered, under a plain name.
        }
        orgs.push({ urn, name, role });
      }
      return orgs;
    },

    /** Sends one picture; LinkedIn gives back its id for the post. Nothing is seen yet. */
    async uploadImage(owner: string, bytes: Uint8Array, mimeType: string): Promise<string> {
      const { body } = await write(
        `${API}/rest/images?action=initializeUpload`,
        json({ initializeUploadRequest: { owner } }),
      );
      const v = value(body);
      const urn = text(v.image, 220);
      const uploadUrl = typeof v.uploadUrl === "string" ? v.uploadUrl : "";
      if (!MEDIA_URN.test(urn))
        throw new LinkedInError("LinkedIn didn't name the picture", 502, "", "", "no");
      await put(uploadUrl, bytes, mimeType);
      return urn;
    },

    async imageStatus(urn: string): Promise<MediaStatus> {
      const { body } = await read(`${API}/rest/images/${urnPath(urn)}`, { headers: rest() });
      return text((body as Record<string, unknown>)?.status, 40);
    },

    /** Sends one video, in the parts LinkedIn asks for, and says it's complete. Nothing is seen yet. */
    async uploadVideo(owner: string, bytes: Uint8Array, mimeType: string): Promise<string> {
      const { body } = await write(
        `${API}/rest/videos?action=initializeUpload`,
        json({
          initializeUploadRequest: {
            owner,
            fileSizeBytes: bytes.byteLength,
            uploadCaptions: false,
            uploadThumbnail: false,
          },
        }),
      );
      const v = value(body);
      const urn = text(v.video, 220);
      if (!MEDIA_URN.test(urn))
        throw new LinkedInError("LinkedIn didn't name the video", 502, "", "", "no");
      const parts = Array.isArray(v.uploadInstructions) ? v.uploadInstructions : [];
      const etags: string[] = [];
      for (const raw of parts) {
        const part = (raw ?? {}) as Record<string, unknown>;
        const first = Number(part.firstByte);
        const last = Number(part.lastByte);
        if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first) {
          throw new LinkedInError("LinkedIn's upload plan didn't read", 502, "", "", "no");
        }
        etags.push(await put(String(part.uploadUrl ?? ""), bytes.slice(first, last + 1), mimeType));
      }
      await write(
        `${API}/rest/videos?action=finalizeUpload`,
        json({
          finalizeUploadRequest: {
            video: urn,
            uploadToken: typeof v.uploadToken === "string" ? v.uploadToken : "",
            uploadedPartIds: etags,
          },
        }),
      );
      return urn;
    },

    async videoStatus(urn: string): Promise<MediaStatus> {
      const { body } = await read(`${API}/rest/videos/${urnPath(urn)}`, { headers: rest() });
      return text((body as Record<string, unknown>)?.status, 40);
    },

    /**
     * Publishes the post: the one write that anyone sees. Asked once; a lost
     * or unclear answer is reported as such (`applied: "unknown"`).
     */
    async createPost(post: {
      author: string;
      words: string;
      images?: string[];
      video?: string | null;
    }): Promise<string> {
      if (!LINKEDIN_URN.test(post.author)) {
        throw new LinkedInError("That isn't a LinkedIn page or person", 400, "", "", "no");
      }
      const images = post.images ?? [];
      const content = post.video
        ? { media: { id: post.video } }
        : images.length === 1
          ? { media: { id: images[0] } }
          : images.length > 1
            ? { multiImage: { images: images.map((id) => ({ id })) } }
            : null;
      const answer = await write(
        `${API}/rest/posts`,
        json({
          author: post.author,
          commentary: littleText(post.words),
          visibility: "PUBLIC",
          distribution: {
            feedDistribution: "MAIN_FEED",
            targetEntities: [],
            thirdPartyDistributionChannels: [],
          },
          lifecycleState: "PUBLISHED",
          isReshareDisabledByAuthor: false,
          ...(content ? { content } : {}),
        }),
      );
      const id = answer.headers.get("x-restli-id") ?? answer.headers.get("x-linkedin-id") ?? "";
      if (!id) {
        // It said yes without naming the post: it is up, we just can't link to it.
        return "posted";
      }
      return id.slice(0, 200);
    },
  };
}
