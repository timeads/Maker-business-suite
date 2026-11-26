import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { publishPost } from "./publish";
import { placeImages, postTargets, publishDuePosts, targetLabel } from "./worker";

describe("each place's photos", () => {
  const copies = new Map([
    ["c1", { storage_path: "w/c1.jpg", fitted_from: "a", fitted_for: "instagram" }],
    ["c2", { storage_path: "w/c2.jpg", fitted_from: "b", fitted_for: "instagram_story" }],
  ]);

  it("uses a place's copies in the post's order, and the photo itself where it fits", () => {
    expect(
      placeImages(["a", "b"], ["w/a.jpg", "w/b.jpg"], { instagram: ["c1", "b"] }, copies),
    ).toEqual({ instagram: ["w/c1.jpg", "w/b.jpg"] });
  });

  it("ignores copies that aren't that photo's, for that place, or out of step", () => {
    expect(
      placeImages(["a", "b"], ["w/a.jpg", "w/b.jpg"], { instagram: ["c2", "b"] }, copies),
    ).toEqual({});
    expect(placeImages(["a", "b"], ["w/a.jpg", "w/b.jpg"], { instagram: ["c1"] }, copies)).toEqual(
      {},
    );
    expect(
      placeImages(["a", "b"], ["w/a.jpg", "w/b.jpg"], { instagram_story: ["c1", "b"] }, copies),
    ).toEqual({});
    expect(placeImages(["a", "b"], ["w/a.jpg"], { instagram: ["c1", "b"] }, copies)).toEqual({});
  });
});

describe("posting to several accounts", () => {
  const TENANT = "11111111-1111-4111-8111-111111111111";
  const FIRST_PAGE = "1001";
  const SECOND_PAGE = "1002";
  const accounts = {
    page2: {
      id: "a-page-2",
      network: "facebook",
      platform_id: SECOND_PAGE,
      page_id: SECOND_PAGE,
      name: "Second Page",
      handle: null,
      tasks: ["MANAGE"],
      active: true,
    },
    ig1: {
      id: "a-ig-1",
      network: "instagram",
      platform_id: "2001",
      page_id: FIRST_PAGE,
      name: "First Page",
      handle: "first_made_up",
      tasks: null,
      active: true,
    },
    ig2: {
      id: "a-ig-2",
      network: "instagram",
      platform_id: "2002",
      page_id: SECOND_PAGE,
      name: "Second Page",
      handle: "second_made_up",
      tasks: null,
      active: false,
    },
  };
  const rows: Record<string, unknown[]> = {
    connections: [{ metadata: {}, scopes: null }],
    social_assets: [
      {
        id: "p1",
        storage_path: `${TENANT}/p1.jpg`,
        mime_type: "image/jpeg",
        fitted_from: null,
        fitted_for: null,
      },
    ],
    social_accounts: Object.values(accounts),
  };
  // Just enough of a Supabase client for the worker's reads and its two calls.
  function fakeAdmin(post: Record<string, unknown>) {
    const finished: Record<string, unknown>[] = [];
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
        if (name === "claim_due_social_posts") return { data: [post], error: null };
        if (name === "finish_social_post") {
          finished.push(args);
          return { data: "published", error: null };
        }
        return { data: null, error: { message: `unexpected ${name}` } };
      },
    };
    return { admin: admin as unknown as SupabaseClient, finished };
  }

  it("sends each account through its own Page, never one that already went, and keeps answers apart", async () => {
    const calls: Parameters<typeof publishPost>[0][] = [];
    const { admin, finished } = fakeAdmin({
      id: "post-1",
      tenant_id: TENANT,
      caption: "Words",
      asset_id: null,
      asset_ids: ["p1"],
      captions: { "a-ig-1": "Instagram's own words" },
      channel_media: {},
      channels: ["facebook", "instagram", "instagram_story"],
      account_ids: ["a-page-2", "a-ig-1", "a-ig-2"],
      results: { "a-page-2:facebook": { id: "fb-went" } },
    });
    await publishDuePosts({
      admin,
      moduleOpen: async () => true,
      getToken: async () => ({
        connectionId: "c",
        externalAccountId: FIRST_PAGE,
        status: "active",
        token: {
          access_token: "first-token",
          secrets: { [`page:${SECOND_PAGE}`]: "second-token" },
        },
      }),
      async publish(input) {
        calls.push(input);
        return {
          retry: true,
          results: Object.fromEntries(input.channels.map((c) => [c, { id: `${c}-new` }])),
        };
      },
      notifyFailed: async () => undefined,
    });
    // Facebook on the second Page already went; the first Instagram account goes now, as itself.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      pageId: FIRST_PAGE,
      pageToken: "first-token",
      instagramId: "2001",
      channels: ["instagram", "instagram_story"],
      captions: { instagram: "Instagram's own words" },
    });
    expect(finished[0].p_results).toEqual({
      "a-ig-1:instagram": { id: "instagram-new" },
      "a-ig-1:instagram_story": { id: "instagram_story-new" },
      // An account out of use is said so, and nothing is sent to it.
      "a-ig-2:instagram": { error: expect.stringMatching(/isn't in use/) },
      "a-ig-2:instagram_story": { error: expect.stringMatching(/isn't in use/) },
    });
  });

  it("names targets for people", () => {
    expect(postTargets({ channels: ["facebook"], account_ids: [] }, [])).toEqual([
      { account: null, places: [{ place: "facebook", key: "facebook" }] },
    ]);
    expect(targetLabel("a-ig-1:instagram_story", [accounts.ig1])).toBe(
      "Instagram Story (@first_made_up)",
    );
    expect(targetLabel(`a-page-2:facebook`, [accounts.page2])).toBe("Facebook (Second Page)");
    expect(targetLabel("facebook", [])).toBe("Facebook");
  });
});
