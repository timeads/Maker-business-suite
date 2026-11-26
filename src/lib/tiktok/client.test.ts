import { afterEach, describe, expect, it } from "vitest";
import type { Fetch } from "../connections/types";
import {
  TikTokError,
  chunkPlan,
  createTikTokClient,
  createTikTokOAuth,
  isTikTokUploadUrl,
  pkceChallenge,
  tiktokAuthorizeUrl,
} from "./client";

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

/** A scripted stand-in for the network: each call takes the next answer for its address. */
function fakeFetch(routes: Record<string, (Response | "lost")[]>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? init.body : "",
    });
    const key = Object.keys(routes).find((match) => url.includes(match));
    const next = key ? routes[key].shift() : undefined;
    if (!next) return new Response("no route", { status: 599 });
    if (next === "lost") throw new Error("socket hang up");
    return next;
  }) as Fetch;
  return { impl, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ok = (data: unknown) => json({ data, error: { code: "ok", message: "" } });
const noSleep = async () => undefined;

describe("signing in to TikTok", () => {
  afterEach(() => {
    delete process.env.TIKTOK_PKCE_ENCODING;
  });

  it("asks for posting with a PKCE challenge, never the verifier itself", () => {
    const url = new URL(
      tiktokAuthorizeUrl({
        clientKey: "made-up-key",
        redirectUri: "https://example.test/api/connections/tiktok/callback",
        state: "s".repeat(24),
        codeVerifier: "v".repeat(64),
      }),
    );
    expect(url.origin + url.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(url.searchParams.get("scope")).toBe("user.info.basic,video.publish");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(pkceChallenge("v".repeat(64)));
    expect(url.toString()).not.toContain("v".repeat(64));
  });

  it("makes the challenge in hex unless told base64url", () => {
    expect(pkceChallenge("abc")).toMatch(/^[0-9a-f]{64}$/);
    process.env.TIKTOK_PKCE_ENCODING = "base64url";
    expect(pkceChallenge("abc")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("trades the code once, with the verifier, and reads TikTok's refusal", async () => {
    const { impl, calls } = fakeFetch({
      "/oauth/token/": [
        json({
          access_token: "made-up-access",
          refresh_token: "made-up-refresh",
          expires_in: 86400,
          refresh_expires_in: 31536000,
          open_id: "open-1",
          scope: "user.info.basic,video.publish",
        }),
        json({ error: "invalid_grant", error_description: "Code expired" }, 400),
      ],
    });
    const oauth = createTikTokOAuth(
      { clientKey: "k", clientSecret: "made-up-secret" },
      { fetchImpl: impl },
    );
    const tokens = await oauth.exchangeCode("code-1", "https://example.test/cb", "verifier-1");
    expect(tokens).toMatchObject({ open_id: "open-1", expires_in: 86400 });
    expect(new URLSearchParams(calls[0].body).get("code_verifier")).toBe("verifier-1");
    const refused = await oauth.refresh("old").catch((err) => err);
    expect(refused).toBeInstanceOf(TikTokError);
    expect(refused.isAuthError).toBe(true);
    // A write is asked once, whatever the answer.
    expect(calls).toHaveLength(2);
    expect(refused.message).not.toContain("made-up-secret");
  });
});

describe("posting to TikTok", () => {
  it("only sends a video to TikTok's own upload hosts", () => {
    expect(isTikTokUploadUrl("https://open-upload.tiktokapis.com/video/?upload_id=1")).toBe(true);
    expect(isTikTokUploadUrl("http://open-upload.tiktokapis.com/x")).toBe(false);
    expect(isTikTokUploadUrl("https://tiktokapis.com.evil.test/x")).toBe(false);
    expect(isTikTokUploadUrl("not a url")).toBe(false);
  });

  it("sends a video of up to 64 MB in one go, bigger ones in 10 MB parts", () => {
    expect(chunkPlan(3_000_000)).toEqual({ chunkSize: 3_000_000, count: 1 });
    expect(chunkPlan(64 * 1024 * 1024)).toEqual({ chunkSize: 64 * 1024 * 1024, count: 1 });
    expect(chunkPlan(105 * 1024 * 1024)).toEqual({ chunkSize: 10 * 1024 * 1024, count: 10 });
  });

  it("asks again after a busy answer when reading, never when writing", async () => {
    const { impl, calls } = fakeFetch({
      "/creator_info/query/": [
        "lost",
        json({ error: { code: "internal_error" } }, 500),
        ok({ privacy_level_options: ["SELF_ONLY"] }),
      ],
      "/video/init/": [json({ error: { code: "internal_error" } }, 500)],
    });
    const client = createTikTokClient("made-up-access", { fetchImpl: impl, sleep: noSleep });
    expect(await client.creatorInfo()).toEqual({ privacy_level_options: ["SELF_ONLY"] });
    const refused = await client.initVideo({ title: "x" }, 1000).catch((err) => err);
    expect(refused).toBeInstanceOf(TikTokError);
    expect(refused.applied).toBe("unknown");
    expect(calls.filter((c) => c.url.includes("/video/init/"))).toHaveLength(1);
    expect(calls[0].headers.authorization).toBe("Bearer made-up-access");
  });

  it("starts a file upload, sends the file, and reads the status", async () => {
    const { impl, calls } = fakeFetch({
      "/video/init/": [
        ok({ publish_id: "p-1", upload_url: "https://open-upload.tiktokapis.com/u?1" }),
      ],
      "open-upload.tiktokapis.com": [new Response(null, { status: 201 })],
      // Written out as TikTok sends it: a number too long for JavaScript.
      "/status/fetch/": [
        new Response(
          '{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7300000000000000001]},"error":{"code":"ok"}}',
        ),
      ],
    });
    const client = createTikTokClient("t", { fetchImpl: impl, sleep: noSleep });
    const started = await client.initVideo({ title: "Words", privacy_level: "SELF_ONLY" }, 4);
    expect(JSON.parse(calls[0].body)).toMatchObject({
      post_info: { title: "Words" },
      source_info: { source: "FILE_UPLOAD", video_size: 4, chunk_size: 4, total_chunk_count: 1 },
    });
    await client.uploadVideo(started.uploadUrl, new Uint8Array([1, 2, 3, 4]), "video/mp4");
    expect(calls[1]).toMatchObject({ method: "PUT" });
    expect(calls[1].headers["content-range"]).toBe("bytes 0-3/4");
    expect(await client.publishStatus("p-1")).toEqual({
      status: "PUBLISH_COMPLETE",
      failReason: "",
      postId: "7300000000000000001",
    });
  });

  it("refuses an upload address that isn't TikTok's", async () => {
    const { impl } = fakeFetch({
      "/video/init/": [ok({ publish_id: "p-1", upload_url: "https://evil.test/u" })],
    });
    await expect(
      createTikTokClient("t", { fetchImpl: impl }).initVideo({}, 4),
    ).rejects.toBeInstanceOf(TikTokError);
  });
});
