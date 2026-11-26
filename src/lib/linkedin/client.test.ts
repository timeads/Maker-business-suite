import { afterEach, describe, expect, it } from "vitest";
import type { Fetch } from "../connections/types";
import {
  LinkedInError,
  createLinkedInClient,
  createLinkedInOAuth,
  isLinkedInUploadUrl,
  littleText,
} from "./client";

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

function fakeFetch(routes: [match: string, answers: (Response | "lost")[]][]) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? init.body : "",
    });
    const route = routes.find(([match]) => url.includes(match));
    const next = route?.[1].shift();
    if (!next) return new Response("no route", { status: 599 });
    if (next === "lost") throw new Error("socket hang up");
    return next;
  }) as Fetch;
  return { impl, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const noSleep = async () => undefined;

afterEach(() => {
  delete process.env.LINKEDIN_API_VERSION;
});

describe("LinkedIn's words", () => {
  it("escapes what LinkedIn would read as markup", () => {
    expect(littleText("New rugs (today) #tufting @studio_one")).toBe(
      "New rugs \\(today\\) \\#tufting \\@studio\\_one",
    );
    expect(littleText("plain words, 50% off!")).toBe("plain words, 50% off!");
  });

  it("only sends files to LinkedIn's own hosts", () => {
    expect(isLinkedInUploadUrl("https://www.linkedin.com/dms-uploads/abc")).toBe(true);
    expect(isLinkedInUploadUrl("https://media.licdn.com/x")).toBe(true);
    expect(isLinkedInUploadUrl("https://linkedin.com.evil.test/x")).toBe(false);
    expect(isLinkedInUploadUrl("http://www.linkedin.com/x")).toBe(false);
  });
});

describe("signing in to LinkedIn", () => {
  it("asks for the scopes it's given, space separated", () => {
    const url = new URL(
      createLinkedInOAuth({ clientId: "made-up-id", clientSecret: "made-up-secret" }).authorizeUrl({
        redirectUri: "https://example.test/cb",
        state: "s".repeat(24),
        scopes: ["openid", "profile", "w_member_social"],
      }),
    );
    expect(url.searchParams.get("scope")).toBe("openid profile w_member_social");
    expect(url.toString()).not.toContain("made-up-secret");
  });

  it("reads a token with or without a refresh token", async () => {
    const { impl } = fakeFetch([
      [
        "/accessToken",
        [
          json({ access_token: "a", expires_in: 5184000, scope: "openid,profile,w_member_social" }),
          json({ error: "invalid_grant", error_description: "expired" }, 400),
        ],
      ],
    ]);
    const oauth = createLinkedInOAuth({ clientId: "i", clientSecret: "s" }, { fetchImpl: impl });
    expect(await oauth.exchangeCode("c", "https://example.test/cb")).toMatchObject({
      access_token: "a",
      refresh_token: null,
    });
    const refused = await oauth.refresh("r").catch((err) => err);
    expect(refused).toBeInstanceOf(LinkedInError);
    expect(refused.isAuthError).toBe(true);
  });
});

describe("posting to LinkedIn", () => {
  it("carries the version and protocol headers, and finds only pages they may post as", async () => {
    process.env.LINKEDIN_API_VERSION = "202611";
    const { impl, calls } = fakeFetch([
      [
        "/rest/organizationAcls",
        [
          json({
            elements: [
              { organization: "urn:li:organization:1", role: "ADMINISTRATOR", state: "APPROVED" },
              { organization: "urn:li:organization:2", role: "ANALYST", state: "APPROVED" },
              { organization: "not-a-urn", role: "ADMINISTRATOR" },
            ],
          }),
        ],
      ],
      ["/rest/organizations/1", ["lost", json({ localizedName: "Studio Ltd" })]],
    ]);
    const client = createLinkedInClient("made-up-access", { fetchImpl: impl, sleep: noSleep });
    expect(await client.organizations()).toEqual([
      { urn: "urn:li:organization:1", name: "Studio Ltd", role: "ADMINISTRATOR" },
    ]);
    expect(calls[0].headers).toMatchObject({
      "linkedin-version": "202611",
      "x-restli-protocol-version": "2.0.0",
      authorization: "Bearer made-up-access",
    });
  });

  it("uploads a picture, then makes the post once, reading its id", async () => {
    const { impl, calls } = fakeFetch([
      [
        "/rest/images?action=initializeUpload",
        [
          json({
            value: {
              uploadUrl: "https://www.linkedin.com/dms-uploads/one",
              image: "urn:li:image:C4E10AQ",
            },
          }),
        ],
      ],
      ["dms-uploads", [new Response(null, { status: 201 })]],
      [
        "/rest/posts",
        [new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:700" } })],
      ],
    ]);
    const client = createLinkedInClient("t", { fetchImpl: impl, sleep: noSleep });
    const image = await client.uploadImage(
      "urn:li:organization:1",
      new Uint8Array([1]),
      "image/jpeg",
    );
    const id = await client.createPost({
      author: "urn:li:organization:1",
      words: "Hello (world)",
      images: [image],
    });
    expect(id).toBe("urn:li:share:700");
    const body = JSON.parse(calls[2].body);
    expect(body).toMatchObject({
      author: "urn:li:organization:1",
      commentary: "Hello \\(world\\)",
      visibility: "PUBLIC",
      lifecycleState: "PUBLISHED",
      content: { media: { id: "urn:li:image:C4E10AQ" } },
    });
  });

  it("several pictures go as one post; a lost answer to the post is reported as unknown", async () => {
    const { impl, calls } = fakeFetch([["/rest/posts", ["lost"]]]);
    const client = createLinkedInClient("t", { fetchImpl: impl, sleep: noSleep });
    const lost = await client
      .createPost({
        author: "urn:li:person:abc",
        words: "x",
        images: ["urn:li:image:1", "urn:li:image:2"],
      })
      .catch((err) => err);
    expect(lost).toBeInstanceOf(LinkedInError);
    expect(lost.applied).toBe("unknown");
    // Asked once.
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].body).content).toEqual({
      multiImage: { images: [{ id: "urn:li:image:1" }, { id: "urn:li:image:2" }] },
    });
  });

  it("sends a video in LinkedIn's parts and finishes it with their receipts", async () => {
    const { impl, calls } = fakeFetch([
      [
        "action=initializeUpload",
        [
          json({
            value: {
              video: "urn:li:video:V1",
              uploadToken: "tok",
              uploadInstructions: [
                { uploadUrl: "https://www.linkedin.com/dms-uploads/p1", firstByte: 0, lastByte: 1 },
                { uploadUrl: "https://www.linkedin.com/dms-uploads/p2", firstByte: 2, lastByte: 3 },
              ],
            },
          }),
        ],
      ],
      ["dms-uploads/p1", [new Response(null, { status: 200, headers: { etag: '"e1"' } })]],
      ["dms-uploads/p2", [new Response(null, { status: 200, headers: { etag: "e2" } })]],
      ["action=finalizeUpload", [new Response(null, { status: 200 })]],
    ]);
    const client = createLinkedInClient("t", { fetchImpl: impl, sleep: noSleep });
    expect(
      await client.uploadVideo("urn:li:person:abc", new Uint8Array([1, 2, 3, 4]), "video/mp4"),
    ).toBe("urn:li:video:V1");
    expect(JSON.parse(calls[3].body)).toEqual({
      finalizeUploadRequest: {
        video: "urn:li:video:V1",
        uploadToken: "tok",
        uploadedPartIds: ["e1", "e2"],
      },
    });
  });

  it("refuses an author that isn't a LinkedIn page or person", async () => {
    await expect(
      createLinkedInClient("t").createPost({ author: "https://evil.test", words: "x" }),
    ).rejects.toBeInstanceOf(LinkedInError);
  });
});
