import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LinkedInError, type LinkedInClient } from "../../linkedin/client";
import { TikTokError, type TikTokClient } from "../../tiktok/client";
import type { Fetch } from "../../connections/types";
import type { PostAccount } from "../targets";
import { publishDuePosts } from "../worker";
import { createLinkedInSender } from "./linkedin";
import { createTikTokSender } from "./tiktok";
import { fetchOwnMedia, type SendJob } from "./types";

const TENANT = "11111111-1111-4111-8111-111111111111";
const STORAGE = "https://made-up-project.supabase.test";
const NOW = Date.parse("2027-01-15T12:00:00Z");
const own = (name: string) => `${STORAGE}/storage/v1/object/public/social/t1/${name}`;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = STORAGE;
});
afterEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
});

/** Our own storage, answering with a few bytes for any file. */
const storage = (async (input: RequestInfo | URL) => {
  if (!String(input).startsWith(STORAGE)) return new Response("not ours", { status: 599 });
  return new Response(new Uint8Array([1, 2, 3, 4]));
}) as Fetch;

const tiktokAccount: PostAccount = {
  id: "acct-tt",
  network: "tiktok",
  platform_id: "open-1",
  page_id: null,
  login_id: "open-1",
  name: "Studio",
  handle: "studio.makes",
  tasks: null,
  active: true,
};
const linkedinPage: PostAccount = {
  ...tiktokAccount,
  id: "acct-li",
  network: "linkedin",
  platform_id: "urn:li:organization:9",
  login_id: "sub-1",
  handle: null,
};

function job(account: PostAccount, extra: Partial<SendJob> = {}) {
  const begun: string[] = [];
  return {
    begun,
    job: {
      tenantId: "t1",
      account,
      words: "Words",
      photos: [],
      video: { url: own("clip.mp4"), mimeType: "video/mp4" },
      options: { privacy_level: "SELF_ONLY" },
      previous: null,
      begin: async () => {
        begun.push(account.id);
        return true;
      },
      ...extra,
    } satisfies SendJob,
  };
}

describe("our own media", () => {
  it("only ever fetches from our own storage", async () => {
    expect(await fetchOwnMedia(own("a.jpg"), storage)).toHaveLength(4);
    await expect(fetchOwnMedia("https://evil.test/a.jpg", storage)).rejects.toThrow(/our own/);
    await expect(fetchOwnMedia(own("../../x"), storage)).rejects.toThrow(/our own/);
  });
});

describe("sending to TikTok", () => {
  type Script = Partial<Record<keyof TikTokClient, unknown>>;
  const fakeClient = (script: Script, calls: string[]) =>
    new Proxy({} as TikTokClient, {
      get: (_t, name: string) => async () => {
        calls.push(name);
        const answer = script[name as keyof TikTokClient];
        const next = Array.isArray(answer) ? answer.shift() : answer;
        if (next instanceof Error) throw next;
        return next;
      },
    });
  const sender = (script: Script, calls: string[], audited = false) =>
    createTikTokSender({
      accessToken: async () => "made-up-access",
      client: () => fakeClient(script, calls),
      audited: () => audited,
      fetchImpl: storage,
      sleep: async () => undefined,
      now: () => NOW,
      checks: 2,
    });

  it("asks creator info first, marks the one write, sends the file, and waits for it", async () => {
    const calls: string[] = [];
    const { job: j, begun } = job(tiktokAccount);
    const answer = await sender(
      {
        creatorInfo: { privacy_level_options: ["SELF_ONLY"] },
        initVideo: { publishId: "p-1", uploadUrl: "https://open-upload.tiktokapis.com/u" },
        uploadVideo: undefined,
        publishStatus: [
          { status: "PROCESSING_UPLOAD", failReason: "", postId: null },
          { status: "PUBLISH_COMPLETE", failReason: "", postId: "730" },
        ],
      },
      calls,
    )(j);
    expect(answer).toEqual({ id: "730" });
    expect(calls).toEqual([
      "creatorInfo",
      "initVideo",
      "uploadVideo",
      "publishStatus",
      "publishStatus",
    ]);
    expect(begun).toEqual(["acct-tt"]);
  });

  it("a video TikTok is still preparing is pending, and only asked about next time", async () => {
    const calls: string[] = [];
    const first = await sender(
      {
        creatorInfo: {},
        initVideo: { publishId: "p-1", uploadUrl: "https://open-upload.tiktokapis.com/u" },
        publishStatus: { status: "PROCESSING_DOWNLOAD", failReason: "", postId: null },
      },
      calls,
    )(job(tiktokAccount).job);
    expect(first).toEqual({ pending: "p-1", since: new Date(NOW).toISOString() });
    const later: string[] = [];
    const { job: again, begun } = job(tiktokAccount, {
      previous: first as Record<string, unknown>,
    });
    expect(
      await sender({ publishStatus: { status: "PUBLISH_COMPLETE", postId: null } }, later)(again),
    ).toEqual({ id: "p-1" });
    expect(later).toEqual(["publishStatus"]);
    expect(begun).toEqual([]);
  });

  it("after six hours without an answer it can't tell, and says so", async () => {
    const calls: string[] = [];
    const answer = await sender(
      { publishStatus: { status: "PROCESSING_UPLOAD" } },
      calls,
    )(job(tiktokAccount, { previous: { pending: "p-1", since: "2027-01-15T05:00:00Z" } }).job);
    expect(answer).toHaveProperty("unsure");
  });

  it("refuses in plain words before sending anything an unreviewed app can't post", async () => {
    const calls: string[] = [];
    const answer = await sender(
      { creatorInfo: {} },
      calls,
    )(job(tiktokAccount, { options: { privacy_level: "PUBLIC_TO_EVERYONE" } }).job);
    expect(answer).toMatchObject({ retry: false, error: expect.stringMatching(/reviewed it/) });
    expect(calls).toEqual(["creatorInfo"]);
  });

  it("a refusal before the file arrived leaves nothing behind, and TikTok's codes read plainly", async () => {
    const calls: string[] = [];
    const answer = await sender(
      {
        creatorInfo: {},
        initVideo: new TikTokError("x", 403, "spam_risk_too_many_posts", "", "no"),
      },
      calls,
    )(job(tiktokAccount).job);
    expect(answer).toMatchObject({ retry: false, error: expect.stringMatching(/for today/) });
  });

  it("a lost answer to the last of the file is asked about, never sent again", async () => {
    const answer = await sender(
      {
        creatorInfo: {},
        initVideo: { publishId: "p-9", uploadUrl: "https://open-upload.tiktokapis.com/u" },
        uploadVideo: new TikTokError("x", 0, "", "", "unknown"),
      },
      [],
    )(job(tiktokAccount).job);
    expect(answer).toEqual({ pending: "p-9", since: new Date(NOW).toISOString() });
  });
});

describe("sending to LinkedIn", () => {
  type Script = Partial<Record<keyof LinkedInClient, unknown>>;
  const fakeClient = (script: Script, calls: string[]) =>
    new Proxy({} as LinkedInClient, {
      get: (_t, name: string) => async () => {
        calls.push(name);
        const answer = script[name as keyof LinkedInClient];
        const next = Array.isArray(answer) ? answer.shift() : answer;
        if (next instanceof Error) throw next;
        return next;
      },
    });
  const sender = (script: Script, calls: string[]) =>
    createLinkedInSender({
      accessToken: async () => "made-up-access",
      client: () => fakeClient(script, calls),
      fetchImpl: storage,
      sleep: async () => undefined,
      now: () => NOW,
      checks: 1,
    });

  it("uploads the photos, then makes the post once", async () => {
    const calls: string[] = [];
    const { job: j, begun } = job(linkedinPage, {
      video: null,
      photos: [
        { url: own("a.jpg"), mimeType: "image/jpeg" },
        { url: own("b.jpg"), mimeType: "image/jpeg" },
      ],
    });
    expect(
      await sender(
        { uploadImage: ["urn:li:image:1", "urn:li:image:2"], createPost: "urn:li:share:1" },
        calls,
      )(j),
    ).toEqual({ id: "urn:li:share:1" });
    expect(calls).toEqual(["uploadImage", "uploadImage", "createPost"]);
    expect(begun).toEqual(["acct-li"]);
  });

  it("a lost answer to the post itself is unsure, never sent again by itself", async () => {
    const answer = await sender(
      { createPost: new LinkedInError("x", 0, "", "", "unknown") },
      [],
    )(job(linkedinPage, { video: null }).job);
    expect(answer).toHaveProperty("unsure");
  });

  it("a video still being prepared waits, and is posted once it's ready", async () => {
    const calls: string[] = [];
    const first = await sender(
      { uploadVideo: "urn:li:video:V1", videoStatus: "PROCESSING" },
      calls,
    )(job(linkedinPage).job);
    expect(first).toEqual({ pending: "video:urn:li:video:V1", since: new Date(NOW).toISOString() });
    const later: string[] = [];
    expect(
      await sender(
        { videoStatus: "AVAILABLE", createPost: "urn:li:ugcPost:2" },
        later,
      )(job(linkedinPage, { previous: first as Record<string, unknown> }).job),
    ).toEqual({ id: "urn:li:ugcPost:2" });
    expect(later).toEqual(["videoStatus", "createPost"]);
  });

  it("a login without permission for a company page is told plainly", async () => {
    expect(
      await sender(
        { createPost: new LinkedInError("x", 403, "", "", "no") },
        [],
      )(job(linkedinPage, { video: null }).job),
    ).toMatchObject({ retry: false, error: expect.stringMatching(/admins/) });
  });
});

describe("the worker with TikTok and LinkedIn", () => {
  function fakeAdmin(post: Record<string, unknown>, accounts: PostAccount[]) {
    const finished: Record<string, unknown>[] = [];
    const begun: string[] = [];
    const rows: Record<string, unknown[]> = {
      connections: [],
      social_assets: [
        {
          id: "v1",
          storage_path: `${TENANT}/clip.mp4`,
          mime_type: "video/mp4",
          fitted_from: null,
          fitted_for: null,
        },
      ],
      social_accounts: accounts,
    };
    const query = (table: string) => {
      const result = { data: rows[table] ?? [], error: null };
      const chain = {
        eq: () => chain,
        in: () => chain,
        maybeSingle: async () => ({ data: (rows[table] ?? [])[0] ?? null, error: null }),
        then: (resolve: (value: typeof result) => unknown) => resolve(result),
      };
      return chain;
    };
    const admin = {
      from: (table: string) => ({ select: () => query(table) }),
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name === "claim_due_social_posts_for") return { data: [post], error: null };
        if (name === "begin_social_target") {
          begun.push(String(args.p_target));
          return { data: true, error: null };
        }
        if (name === "finish_social_post") {
          finished.push(args);
          return { data: "scheduled", error: null };
        }
        return { data: null, error: { message: `unexpected ${name}` } };
      },
    };
    return { admin: admin as unknown as SupabaseClient, finished, begun };
  }

  it("never asks Facebook for a token for a post with no Facebook or Instagram in it", async () => {
    const { admin, finished } = fakeAdmin(
      {
        id: "post-1",
        tenant_id: TENANT,
        caption: "Words",
        asset_id: null,
        asset_ids: ["v1"],
        captions: { "acct-li": "LinkedIn's own words" },
        channel_media: {},
        channels: ["tiktok", "linkedin"],
        account_ids: ["acct-tt", "acct-li"],
        target_options: { "acct-tt": { privacy_level: "SELF_ONLY" } },
        results: { "acct-tt:tiktok": { pending: "p-1", since: "2027-01-15T11:50:00Z" } },
      },
      [tiktokAccount, { ...linkedinPage, needs_login: true }],
    );
    const seen: SendJob[] = [];
    await publishDuePosts({
      admin,
      moduleOpen: async () => true,
      getToken: async () => {
        throw new Error("the Meta token must not be read");
      },
      publish: async () => {
        throw new Error("Meta must not be asked");
      },
      senders: {
        tiktok: async (j) => {
          seen.push(j);
          return { id: "730" };
        },
        linkedin: async () => {
          throw new Error("a login that needs connecting is not tried");
        },
      },
      notifyFailed: async () => undefined,
    });
    expect(seen[0]).toMatchObject({
      words: "Words",
      options: { privacy_level: "SELF_ONLY" },
      previous: { pending: "p-1" },
      video: {
        url: `${STORAGE}/storage/v1/object/public/social/${TENANT}/clip.mp4`,
        mimeType: "video/mp4",
      },
    });
    expect(finished[0].p_results).toEqual({
      "acct-tt:tiktok": { id: "730" },
      "acct-li:linkedin": { error: expect.stringMatching(/connecting again/), stop: true },
    });
  });

  it("a target left marked by a worker that stopped is never sent again", async () => {
    const { admin, finished } = fakeAdmin(
      {
        id: "post-2",
        tenant_id: TENANT,
        caption: "Words",
        asset_id: null,
        asset_ids: ["v1"],
        channels: ["tiktok"],
        account_ids: ["acct-tt"],
        results: { "acct-tt:tiktok": { sending: "2027-01-15T11:00:00Z" } },
      },
      [tiktokAccount],
    );
    await publishDuePosts({
      admin,
      moduleOpen: async () => true,
      getToken: async () => {
        throw new Error("no");
      },
      publish: async () => {
        throw new Error("no");
      },
      senders: {
        tiktok: async () => {
          throw new Error("must not be sent again");
        },
      },
      notifyFailed: async () => undefined,
    });
    expect(finished[0].p_results).toEqual({
      "acct-tt:tiktok": { unsure: expect.stringMatching(/Look on TikTok/) },
    });
  });
});
