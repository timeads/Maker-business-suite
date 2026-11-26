import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loginToken } from "../logins";
import { ConnectError, ReconnectRequiredError, type Fetch } from "../types";
import { createLinkedInAdapter, linkedinCanPost, linkedinScopes } from "./linkedin";
import { createTikTokAdapter } from "./tiktok";

const NOW = 1_800_000_000_000;

function fakeFetch(routes: [match: string, answers: Response[]][]) {
  const calls: { url: string; body: string }[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, body: typeof init.body === "string" ? init.body : "" });
    const next = routes.find(([match]) => url.includes(match))?.[1].shift();
    return next ?? new Response("no route", { status: 599 });
  }) as Fetch;
  return { impl, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  // Made up for the test; nothing here is a real credential.
  process.env.TIKTOK_CLIENT_KEY = "made-up-key";
  process.env.TIKTOK_CLIENT_SECRET = "made-up-secret";
  process.env.LINKEDIN_CLIENT_ID = "made-up-id";
  process.env.LINKEDIN_CLIENT_SECRET = "made-up-secret";
});
afterEach(() => {
  for (const name of [
    "TIKTOK_CLIENT_KEY",
    "TIKTOK_CLIENT_SECRET",
    "LINKEDIN_CLIENT_ID",
    "LINKEDIN_CLIENT_SECRET",
    "LINKEDIN_COMPANY_PAGES",
  ]) {
    delete process.env[name];
  }
});

describe("the TikTok connection", () => {
  it("is offered only where its app is set up, and holds several accounts", () => {
    expect(createTikTokAdapter().configured()).toBe(true);
    delete process.env.TIKTOK_CLIENT_KEY;
    const adapter = createTikTokAdapter();
    expect(adapter.configured()).toBe(false);
    expect(adapter).toMatchObject({ optional: true, multiLogin: true, pkce: true });
  });

  it("connects one account as one login, and offers it", async () => {
    const { impl, calls } = fakeFetch([
      [
        "/oauth/token/",
        [
          json({
            access_token: "made-up-access",
            refresh_token: "made-up-refresh",
            expires_in: 86400,
            refresh_expires_in: 31536000,
            open_id: "open-1",
            scope: "user.info.basic,video.publish",
          }),
        ],
      ],
      [
        "/user/info/",
        [
          json({
            data: { user: { open_id: "open-1", display_name: "Studio", username: "studio.makes" } },
          }),
        ],
      ],
    ]);
    const account = await createTikTokAdapter(impl, () => NOW).completeConnect({
      params: new URLSearchParams({ code: "c" }),
      redirectUri: "https://example.test/cb",
      input: { pkce_verifier: "v".repeat(64) },
    });
    expect(account).toMatchObject({
      externalAccountId: "open-1",
      displayName: "@studio.makes",
      scopes: ["user.info.basic", "video.publish"],
      metadata: {
        offered: [{ network: "tiktok", platform_id: "open-1", handle: "studio.makes" }],
      },
    });
    expect(loginToken(account.token, "open-1")).toMatchObject({
      access_token: "made-up-access",
      expires_at: NOW + 86_400_000,
    });
    // Nothing secret on the metadata.
    expect(JSON.stringify(account.metadata)).not.toContain("made-up");
    expect(new URLSearchParams(calls[0].body).get("code_verifier")).toBe("v".repeat(64));
  });

  it("says so when posting wasn't allowed on TikTok's screen", async () => {
    const { impl } = fakeFetch([
      [
        "/oauth/token/",
        [json({ access_token: "a", refresh_token: "r", open_id: "o", scope: "user.info.basic" })],
      ],
    ]);
    await expect(
      createTikTokAdapter(impl).completeConnect({
        params: new URLSearchParams({ code: "c" }),
        redirectUri: "https://example.test/cb",
        input: { pkce_verifier: "v".repeat(64) },
      }),
    ).rejects.toBeInstanceOf(ConnectError);
  });

  it("renews a login, keeping its refresh token when TikTok sends none, and gives up when it ran out", async () => {
    const { impl } = fakeFetch([
      ["/oauth/token/", [json({ access_token: "new", open_id: "o", expires_in: 86400 })]],
    ]);
    const adapter = createTikTokAdapter(impl, () => NOW);
    expect(
      await adapter.refresh(
        {
          access_token: "old",
          refresh_token: "keep",
          expires_at: NOW,
          refresh_expires_at: NOW + 1000,
        },
        "o",
      ),
    ).toMatchObject({ access_token: "new", refresh_token: "keep", refresh_expires_at: NOW + 1000 });
    await expect(
      adapter.refresh({ access_token: "a", refresh_token: "r", refresh_expires_at: NOW - 1 }, "o"),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
  });
});

describe("the LinkedIn connection", () => {
  it("asks for company pages only where the app may", () => {
    expect(linkedinScopes()).toEqual(["openid", "profile", "w_member_social"]);
    process.env.LINKEDIN_COMPANY_PAGES = "true";
    expect(linkedinScopes()).toContain("w_organization_social");
    expect(linkedinCanPost("urn:li:organization:1", ["w_member_social"])).toBe(false);
    expect(linkedinCanPost("urn:li:person:a", ["w_member_social"])).toBe(true);
  });

  it("offers the pages a person looks after, and the person, from one sign-in", async () => {
    const { impl } = fakeFetch([
      [
        "/accessToken",
        [
          json({
            access_token: "made-up-access",
            expires_in: 5184000,
            scope: "openid,profile,w_member_social,w_organization_social,rw_organization_admin",
          }),
        ],
      ],
      ["/v2/userinfo", [json({ sub: "abc123", name: "Sam Maker" })]],
      [
        "/rest/organizationAcls",
        [json({ elements: [{ organization: "urn:li:organization:9", role: "ADMINISTRATOR" }] })],
      ],
      ["/rest/organizations/9", [json({ localizedName: "Studio Ltd" })]],
    ]);
    const account = await createLinkedInAdapter(impl, () => NOW).completeConnect({
      params: new URLSearchParams({ code: "c" }),
      redirectUri: "https://example.test/cb",
      input: {},
    });
    expect(account.externalAccountId).toBe("abc123");
    expect((account.metadata as { offered: unknown[] }).offered).toEqual([
      {
        network: "linkedin",
        platform_id: "urn:li:organization:9",
        name: "Studio Ltd",
        tasks: ["ADMINISTRATOR"],
      },
      { network: "linkedin", platform_id: "urn:li:person:abc123", name: "Sam Maker" },
    ]);
    // No refresh token: it must be connected again when the access runs out, and says when.
    const [login] = (account.metadata as { logins: { reconnect_by: string }[] }).logins;
    expect(login.reconnect_by).toBe(new Date(NOW + 5184000 * 1000).toISOString());
    await expect(
      createLinkedInAdapter(impl, () => NOW).refresh({ access_token: "a" }, "abc123"),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
  });

  it("warns on the Connections page a fortnight before a login must be connected again", () => {
    const adapter = createLinkedInAdapter();
    const metadata = { logins: [{ id: "a", name: "Sam", reconnect_by: "2027-02-10T00:00:00Z" }] };
    expect(adapter.statusNote?.(metadata, "2027-01-01")).toBeNull();
    expect(adapter.statusNote?.(metadata, "2027-02-01")?.tone).toBe("waiting");
    expect(adapter.statusNote?.(metadata, "2027-02-11")?.tone).toBe("bad");
  });
});
