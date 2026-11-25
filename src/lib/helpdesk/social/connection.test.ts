import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("asks for the messaging permissions only when messages were asked for", () => {
    expect(scopeOf({})).toEqual(POSTING);
    expect(scopeOf({ access: "" })).toEqual(POSTING);
    expect(scopeOf({ access: META_WITH_MESSAGES })).toEqual([...POSTING, ...MESSAGING_SCOPES]);
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

  it("a posting-only connect is exactly as it was: no extra question to Meta", async () => {
    const { impl, calls } = fakeMeta(exchange);
    const account = await finish(impl, {});
    expect(account.scopes).toEqual(POSTING);
    expect(calls.some((call) => call.url.includes("/me/permissions"))).toBe(false);
  });

  it("records what Facebook really granted, not what was asked", async () => {
    const granted = (names: string[], declined: string[] = []) => ({
      data: [
        ...names.map((permission) => ({ permission, status: "granted" })),
        ...declined.map((permission) => ({ permission, status: "declined" })),
      ],
    });
    const all = fakeMeta([
      ...exchange,
      ["/me/permissions", granted([...POSTING, ...MESSAGING_SCOPES, "public_profile"])],
    ]);
    expect((await finish(all.impl, { access: META_WITH_MESSAGES })).scopes).toEqual([
      ...POSTING,
      ...MESSAGING_SCOPES,
    ]);
    expect(all.calls.at(-1)).toMatchObject({ auth: "Bearer made-up-long-token" });

    const some = fakeMeta([
      ...exchange,
      [
        "/me/permissions",
        granted(
          [...POSTING, "pages_manage_metadata", "pages_messaging"],
          ["instagram_manage_messages"],
        ),
      ],
    ]);
    const account = await finish(some.impl, { access: META_WITH_MESSAGES });
    expect(account.scopes).toContain("pages_messaging");
    expect(account.scopes).not.toContain("instagram_manage_messages");
  });

  it("subscribes the Page after connecting only when messages were granted", async () => {
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
    expect(live.calls[0].url).toContain("/p1/subscribed_apps?subscribed_fields=messages");
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
    expect(adapter.reconnectInput!(POSTING)).toEqual({});
    expect(adapter.reconnectInput!([...POSTING, "pages_messaging"])).toEqual({
      access: META_WITH_MESSAGES,
    });
    expect(adapter.returnPath!({ return_to: "helpdesk_channels" })).toBe(
      "settings/helpdesk/channels",
    );
    expect(adapter.returnPath!({ return_to: "https://evil.example.com" })).toBeNull();
    expect(adapter.connectFields.every((field) => field.hidden)).toBe(true);
  });
});
