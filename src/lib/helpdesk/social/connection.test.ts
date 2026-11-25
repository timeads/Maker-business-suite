import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FEATURE_SCOPES,
  canPost,
  featuresOf,
  parseFeatures,
  requestedFeatures,
  scopesFor,
} from "../../connections/meta-access";
import { META_WITH_MESSAGES, createMetaAdapter } from "../../connections/providers/meta";
import { MESSAGING_SCOPES } from "./channels";

/** A stand-in for Meta: answers by what the address contains, and remembers what it was asked. */
function fakeMeta(routes: [string, unknown][]) {
  const calls: { url: string; method: string; auth: string | null }[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    calls.push({ url, method: init.method ?? "GET", auth: headers.get("authorization") });
    const hit = routes.find(([part]) => url.includes(part));
    return new Response(
      JSON.stringify(hit ? hit[1] : { error: { message: "no route", code: 1 } }),
      {
        status: hit ? 200 : 400,
      },
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const PAGE = { id: "p1", name: "A Made Up Page", access_token: "made-up-page-token" };
const POSTING = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
];

describe("the Meta connection and messages", () => {
  const saved = { id: process.env.META_APP_ID, secret: process.env.META_APP_SECRET };
  beforeEach(() => {
    // Made up on the spot: nothing real is ever in a test.
    process.env.META_APP_ID = "1234567890";
    process.env.META_APP_SECRET = randomBytes(16).toString("hex");
  });
  afterEach(() => {
    process.env.META_APP_ID = saved.id;
    process.env.META_APP_SECRET = saved.secret;
  });

  const scopeOf = (input: Record<string, string>) =>
    new URL(
      createMetaAdapter().beginConnect({ state: "s", redirectUri: "https://app/cb", input }),
    ).searchParams
      .get("scope")!
      .split(",");

  it("asks only for what the workspace is switching on, plus what it already had", () => {
    // The Connections page's own button connects for posting, as it always has.
    expect(scopeOf({})).toEqual(POSTING);
    expect(scopeOf({ access: "" })).toEqual(POSTING);
    // A workspace connecting for the help desk alone is never asked for posting:
    // an app with only Meta's Messenger use case doesn't carry those permissions,
    // and Facebook refuses the whole login ("Invalid Scopes") if they are asked for.
    const messagesOnly = scopeOf({ access: META_WITH_MESSAGES });
    expect(messagesOnly).toEqual([...MESSAGING_SCOPES]);
    expect(messagesOnly).not.toContain("pages_manage_posts");
    expect(messagesOnly).not.toContain("instagram_content_publish");
    // Adding messages to a connection that posts keeps posting.
    expect(scopeOf({ access: META_WITH_MESSAGES, kept: "posting" })).toEqual(
      scopesFor(["posting", "messages"]),
    );
    // Comments, one platform at a time.
    expect(scopeOf({ access: "facebook_comments", kept: "messages" })).toEqual(
      scopesFor(["messages", "facebook_comments"]),
    );
    expect(scopeOf({ access: "instagram_comments" })).toEqual([
      ...FEATURE_SCOPES.instagram_comments,
    ]);
    expect(scopeOf({ access: "instagram_comments" })).not.toContain("pages_manage_engagement");
    // Anything unknown is ignored, never passed on to Facebook.
    expect(scopeOf({ access: "ads_management,messages" })).toEqual([...MESSAGING_SCOPES]);
  });

  it("knows the permissions behind each use, and tells a connection's uses from its scopes", () => {
    expect(FEATURE_SCOPES.facebook_comments).toEqual([
      "pages_show_list",
      "pages_manage_metadata",
      "pages_read_engagement",
      "pages_read_user_content",
      "pages_manage_engagement",
    ]);
    expect(FEATURE_SCOPES.instagram_comments).toEqual([
      "pages_show_list",
      "pages_manage_metadata",
      "pages_read_engagement",
      "instagram_basic",
      "instagram_manage_comments",
    ]);
    for (const scopes of Object.values(FEATURE_SCOPES)) {
      expect(scopes).toContain("pages_show_list");
      expect(new Set(scopes).size).toBe(scopes.length);
    }
    expect(scopesFor(["posting", "messages"]).filter((s) => s === "pages_show_list")).toHaveLength(
      1,
    );
    expect(parseFeatures("messages, posting ,nonsense")).toEqual(["posting", "messages"]);
    expect(parseFeatures(undefined)).toEqual([]);
    expect(requestedFeatures({})).toEqual(["posting"]);
    expect(requestedFeatures({ kept: "messages" })).toEqual(["messages"]);

    expect(featuresOf(POSTING)).toEqual(["posting"]);
    expect(featuresOf([...MESSAGING_SCOPES])).toEqual(["messages"]);
    // Shared permissions (reading the Page, its Instagram account) never imply a use.
    expect(featuresOf(["pages_show_list", "pages_read_engagement", "instagram_basic"])).toEqual([]);
    expect(featuresOf(scopesFor(["messages", "facebook_comments", "instagram_comments"]))).toEqual([
      "messages",
      "facebook_comments",
      "instagram_comments",
    ]);
    expect(featuresOf(null)).toEqual([]);

    expect(canPost("facebook", POSTING)).toBe(true);
    expect(canPost("instagram", POSTING)).toBe(true);
    expect(canPost("facebook", [...MESSAGING_SCOPES])).toBe(false);
    expect(canPost("instagram", [...MESSAGING_SCOPES])).toBe(false);
    expect(canPost("instagram", ["instagram_content_publish"])).toBe(false);
  });

  const exchange: [string, unknown][] = [
    ["fb_exchange_token", { access_token: "made-up-long-token" }],
    ["/oauth/access_token", { access_token: "made-up-short-token" }],
    ["/me/accounts", { data: [PAGE] }],
  ];
  const finish = (impl: typeof fetch, input: Record<string, string>) =>
    createMetaAdapter(impl).completeConnect({
      params: new URLSearchParams({ code: "abc" }),
      redirectUri: "https://app/cb",
      input,
    });
  const granted = (names: readonly string[], declined: string[] = []) => ({
    data: [
      ...names.map((permission) => ({ permission, status: "granted" })),
      ...declined.map((permission) => ({ permission, status: "declined" })),
    ],
  });

  it("records what Facebook really granted, not what was asked", async () => {
    const posting = fakeMeta([...exchange, ["/me/permissions", granted(POSTING)]]);
    expect((await finish(posting.impl, {})).scopes).toEqual(POSTING);

    const all = fakeMeta([
      ...exchange,
      ["/me/permissions", granted([...POSTING, ...MESSAGING_SCOPES, "public_profile"])],
    ]);
    expect(
      (await finish(all.impl, { access: META_WITH_MESSAGES, kept: "posting" })).scopes,
    ).toEqual(scopesFor(["posting", "messages"]));
    expect(all.calls.at(-1)).toMatchObject({ auth: "Bearer made-up-long-token" });

    const some = fakeMeta([
      ...exchange,
      [
        "/me/permissions",
        granted(
          ["pages_show_list", "pages_manage_metadata", "pages_messaging"],
          ["instagram_manage_messages"],
        ),
      ],
    ]);
    const account = await finish(some.impl, { access: META_WITH_MESSAGES });
    expect(account.scopes).toEqual(["pages_show_list", "pages_messaging", "pages_manage_metadata"]);

    // Granted but never asked for (left over from another use of the app): not recorded.
    const extra = fakeMeta([
      ...exchange,
      ["/me/permissions", granted([...MESSAGING_SCOPES, "pages_manage_posts"])],
    ]);
    expect((await finish(extra.impl, { access: META_WITH_MESSAGES })).scopes).not.toContain(
      "pages_manage_posts",
    );
  });

  it("subscribes the Page after connecting only for what was granted", async () => {
    const account = {
      externalAccountId: "p1",
      displayName: "A Made Up Page",
      token: { access_token: "made-up-page-token" },
    };
    const quiet = fakeMeta([["subscribed_apps", { success: true }]]);
    await createMetaAdapter(quiet.impl).afterConnect!(
      { ...account, scopes: POSTING },
      "https://app",
    );
    expect(quiet.calls).toHaveLength(0);

    const live = fakeMeta([["subscribed_apps", { success: true }]]);
    await createMetaAdapter(live.impl).afterConnect!(
      { ...account, scopes: [...POSTING, ...MESSAGING_SCOPES] },
      "https://app",
    );
    expect(live.calls).toEqual([
      expect.objectContaining({ method: "POST", auth: "Bearer made-up-page-token" }),
    ]);
    expect(new URL(live.calls[0].url).searchParams.get("subscribed_fields")).toBe(
      "messages,message_echoes,message_reactions,standby,messaging_handovers",
    );

    // Comments granted as well: the Page's feed is asked for too.
    const both = fakeMeta([["subscribed_apps", { success: true }]]);
    await createMetaAdapter(both.impl).afterConnect!(
      { ...account, scopes: scopesFor(["messages", "instagram_comments"]) },
      "https://app",
    );
    expect(new URL(both.calls[0].url).searchParams.get("subscribed_fields")).toBe(
      "messages,message_echoes,message_reactions,standby,messaging_handovers,feed",
    );
    const commentsOnly = fakeMeta([["subscribed_apps", { success: true }]]);
    await createMetaAdapter(commentsOnly.impl).afterConnect!(
      { ...account, scopes: [...FEATURE_SCOPES.facebook_comments] },
      "https://app",
    );
    expect(new URL(commentsOnly.calls[0].url).searchParams.get("subscribed_fields")).toBe("feed");
    // The token rides in the header, never in the address.
    expect(live.calls[0].url).not.toContain("made-up-page-token");
  });

  it("unsubscribes the Page on disconnect, and still revokes when that fails", async () => {
    const { impl, calls } = fakeMeta([["/me/permissions", { success: true }]]);
    await createMetaAdapter(impl).disconnect(
      { access_token: "made-up-page-token", refresh_token: "made-up-long-token" },
      "p1",
    );
    expect(calls.map((call) => [call.method, call.url.replace(/^.*\/v[\d.]+/, "")])).toEqual([
      ["DELETE", "/p1/subscribed_apps"],
      ["DELETE", "/me/permissions"],
    ]);
  });

  it("keeps messages when a connection is renewed, and knows where to go back to", () => {
    const adapter = createMetaAdapter();
    expect(adapter.reconnectInput!([])).toEqual({});
    expect(adapter.reconnectInput!(POSTING)).toEqual({ kept: "posting" });
    expect(adapter.reconnectInput!([...POSTING, "pages_messaging"])).toEqual({
      kept: "posting,messages",
    });
    // A help-desk-only connection renewed from the Connections page stays help-desk-only.
    expect(adapter.reconnectInput!([...MESSAGING_SCOPES])).toEqual({ kept: "messages" });
    expect(adapter.returnPath!({ return_to: "social" })).toBe("social");
    // What was kept is worked out by the server; no form field can set it.
    expect(adapter.connectFields.map((field) => field.name)).not.toContain("kept");
    expect(adapter.returnPath!({ return_to: "helpdesk_channels" })).toBe(
      "settings/helpdesk/channels",
    );
    expect(adapter.returnPath!({ return_to: "https://evil.example.com" })).toBeNull();
    expect(adapter.connectFields.every((field) => field.hidden)).toBe(true);
  });
});
