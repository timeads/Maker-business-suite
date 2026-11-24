import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAdapter, isProviderKey, PROVIDER_ORDER } from "../registry";
import { ConnectError, ReconnectRequiredError, type Fetch } from "../types";
import {
  GMAIL_SEND_SCOPE,
  GmailSendError,
  createGoogleMailAdapter,
  googleMailConfigured,
  sendGmail,
} from "./google-mail";

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
type Reply = { status?: number; body?: unknown; text?: string } | Error;

/** A fetch that answers from a script, in order, and remembers what it was asked. */
function scripted(replies: Reply[]) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => (headers[key] = value));
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? init.body : "",
    });
    const reply = replies[calls.length - 1];
    if (!reply) throw new Error(`unexpected call ${calls.length}: ${String(input)}`);
    if (reply instanceof Error) throw reply;
    return new Response(reply.text ?? JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
    });
  }) as Fetch;
  return { impl, calls };
}

const REDIRECT = "https://suite.example/api/connections/google_mail/callback";
const NOW = 1_800_000_000_000;
const saved = { ...process.env };

beforeEach(() => {
  // Obviously not real.
  process.env.GOOGLE_MAIL_CLIENT_ID = "fake-client-id.apps.example";
  process.env.GOOGLE_MAIL_CLIENT_SECRET = "fake-client-secret";
});
afterEach(() => {
  process.env = { ...saved };
});

describe("the Gmail connection", () => {
  it("is registered like every other provider, and only offered where it is set up", () => {
    expect(isProviderKey("google_mail")).toBe(true);
    expect(PROVIDER_ORDER).toContain("google_mail");
    const adapter = getAdapter("google_mail");
    expect(adapter.optional).toBe(true);
    expect(adapter.nothingToSync).toBe(true);
    expect(adapter.pollEveryHours).toBeNull();
    expect(adapter.connectWithKey).toBeUndefined();
    expect(googleMailConfigured()).toBe(true);
    delete process.env.GOOGLE_MAIL_CLIENT_SECRET;
    expect(adapter.configured()).toBe(false);
  });

  it("asks Google for permission to send, and nothing more", () => {
    const url = new URL(
      createGoogleMailAdapter().beginConnect({
        state: "state-123",
        redirectUri: REDIRECT,
        input: {},
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe(`openid email ${GMAIL_SEND_SCOPE}`);
    expect(url.searchParams.get("scope")).not.toMatch(/readonly|modify|mail\.google\.com|compose/);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("client_id")).toBe("fake-client-id.apps.example");
    expect(url.toString()).not.toContain("fake-client-secret");
  });

  it("trades the code for tokens and finds out which mailbox it is", async () => {
    const { impl, calls } = scripted([
      {
        body: {
          access_token: "fake-access",
          refresh_token: "fake-refresh",
          expires_in: 3599,
          scope: `openid https://www.googleapis.com/auth/userinfo.email ${GMAIL_SEND_SCOPE}`,
        },
      },
      { body: { sub: "1234567890", email: "Dana@WildThread.example", email_verified: true } },
    ]);
    const account = await createGoogleMailAdapter(impl, () => NOW).completeConnect({
      params: new URLSearchParams({ code: "the-code", state: "state-123" }),
      redirectUri: REDIRECT,
      input: {},
    });
    expect(account.displayName).toBe("dana@wildthread.example");
    expect(account.metadata).toEqual({ email: "dana@wildthread.example" });
    expect(account.externalAccountId).toMatch(/^gmail-[0-9a-f-]{36}$/);
    expect(account.scopes).toEqual(["openid", "email", GMAIL_SEND_SCOPE]);
    expect(account.token).toEqual({
      access_token: "fake-access",
      refresh_token: "fake-refresh",
      expires_at: NOW + 3_599_000,
    });
    // Nothing secret outside the token.
    expect(JSON.stringify({ ...account, token: null })).not.toMatch(
      /fake-(access|refresh|client-secret)/,
    );

    expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(calls[0].method).toBe("POST");
    const sent = new URLSearchParams(calls[0].body);
    expect(Object.fromEntries(sent)).toEqual({
      client_id: "fake-client-id.apps.example",
      client_secret: "fake-client-secret",
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: REDIRECT,
    });
    expect(calls[1].url).toBe("https://openidconnect.googleapis.com/v1/userinfo");
    expect(calls[1].headers.authorization).toBe("Bearer fake-access");
  });

  it("won't connect without the permission to send, or without lasting permission", async () => {
    const connect = (token: object) =>
      createGoogleMailAdapter(scripted([{ body: token }]).impl).completeConnect({
        params: new URLSearchParams({ code: "c" }),
        redirectUri: REDIRECT,
        input: {},
      });
    // The person unticked "send email" on Google's screen.
    await expect(
      connect({ access_token: "a", refresh_token: "r", scope: "openid email" }),
    ).rejects.toThrow(/didn't give permission to send/);
    await expect(connect({ access_token: "a", scope: GMAIL_SEND_SCOPE })).rejects.toThrow(
      /lasting permission/,
    );
    await expect(
      createGoogleMailAdapter(scripted([]).impl).completeConnect({
        params: new URLSearchParams({ error: "access_denied" }),
        redirectUri: REDIRECT,
        input: {},
      }),
    ).rejects.toBeInstanceOf(ConnectError);
    await expect(
      createGoogleMailAdapter(
        scripted([{ status: 400, body: { error: "invalid_grant" } }]).impl,
      ).completeConnect({
        params: new URLSearchParams({ code: "c" }),
        redirectUri: REDIRECT,
        input: {},
      }),
    ).rejects.toBeInstanceOf(ConnectError);
    // Google names no mailbox.
    await expect(
      createGoogleMailAdapter(
        scripted([
          { body: { access_token: "a", refresh_token: "r", scope: GMAIL_SEND_SCOPE } },
          { body: {} },
        ]).impl,
      ).completeConnect({
        params: new URLSearchParams({ code: "c" }),
        redirectUri: REDIRECT,
        input: {},
      }),
    ).rejects.toThrow(/which mailbox/);
  });

  it("renews the access token and keeps the refresh token Google didn't replace", async () => {
    const { impl, calls } = scripted([
      { body: { access_token: "fresh-access", expires_in: 3600 } },
    ]);
    const next = await createGoogleMailAdapter(impl, () => NOW).refresh(
      { access_token: "old-access", refresh_token: "fake-refresh", expires_at: NOW - 1 },
      "gmail-x",
    );
    expect(next).toEqual({
      access_token: "fresh-access",
      refresh_token: "fake-refresh",
      expires_at: NOW + 3_600_000,
    });
    expect(Object.fromEntries(new URLSearchParams(calls[0].body))).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "fake-refresh",
    });
  });

  it("asks for a reconnect when Google has taken the permission back", async () => {
    const adapter = (reply: Reply) => createGoogleMailAdapter(scripted([reply]).impl);
    await expect(
      adapter({ status: 400, body: { error: "invalid_grant" } }).refresh(
        { access_token: "a", refresh_token: "r" },
        "gmail-x",
      ),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
    await expect(
      createGoogleMailAdapter(scripted([]).impl).refresh({ access_token: "a" }, "gmail-x"),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
    // Google being down is not a reason to throw the connection away.
    const down = adapter({ status: 503, text: "busy" }).refresh(
      { access_token: "a", refresh_token: "r" },
      "gmail-x",
    );
    await expect(down).rejects.not.toBeInstanceOf(ReconnectRequiredError);
    await expect(down).rejects.toThrow(/Google answered 503/);
  });

  it("asks Google to cancel the permission when disconnecting", async () => {
    const { impl, calls } = scripted([{ body: {} }]);
    await createGoogleMailAdapter(impl).disconnect(
      { access_token: "fake-access", refresh_token: "fake-refresh" },
      "gmail-x",
    );
    expect(calls[0].url).toBe("https://oauth2.googleapis.com/revoke");
    expect(new URLSearchParams(calls[0].body).get("token")).toBe("fake-refresh");
  });

  it("pulls nothing", async () => {
    const { impl, calls } = scripted([]);
    const result = await createGoogleMailAdapter(impl, () => NOW).sync({} as never);
    expect(result.cursor).toEqual({ checked_at: new Date(NOW).toISOString() });
    expect(calls).toEqual([]);
  });
});

describe("sending through Gmail", () => {
  it("posts the raw message with the token in the header only", async () => {
    const { impl, calls } = scripted([{ body: { id: "msg-1", threadId: "thr-1" } }]);
    expect(await sendGmail("fake-access", "cmF3", null, impl)).toEqual({
      id: "msg-1",
      threadId: "thr-1",
    });
    expect(calls[0].url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect(calls[0].headers.authorization).toBe("Bearer fake-access");
    expect(JSON.parse(calls[0].body)).toEqual({ raw: "cmF3" });
    expect(calls[0].url + calls[0].body).not.toContain("fake-access");
  });

  it("keeps a resend in the earlier conversation", async () => {
    const { impl, calls } = scripted([{ body: { id: "msg-2" } }]);
    expect(await sendGmail("t", "cmF3", "thr-1", impl)).toEqual({ id: "msg-2", threadId: "msg-2" });
    expect(JSON.parse(calls[0].body)).toEqual({ raw: "cmF3", threadId: "thr-1" });
  });

  const failure = async (reply: Reply, threadId: string | null = null) => {
    try {
      await sendGmail("fake-access", "cmF3", threadId, scripted([reply]).impl);
    } catch (err) {
      return err as GmailSendError;
    }
    throw new Error("expected a failure");
  };

  it("knows a clean no from not knowing", async () => {
    // Never heard back: it may have gone.
    expect(await failure(new Error("socket hang up"))).toMatchObject({ sent: "unsure", fix: null });
    expect(await failure({ status: 502, text: "bad gateway" })).toMatchObject({ sent: "unsure" });
    expect(await failure({ status: 200, body: {} })).toMatchObject({ sent: "unsure" });
    // Turned away: nothing went.
    expect(
      await failure({ status: 401, body: { error: { message: "Invalid Credentials" } } }),
    ).toMatchObject({
      sent: "no",
      fix: "stale",
    });
    expect(
      await failure(
        { status: 404, body: { error: { message: "Requested entity was not found." } } },
        "thr-gone",
      ),
    ).toMatchObject({
      sent: "no",
      fix: "thread",
    });
    expect(
      await failure({
        status: 403,
        body: { error: { message: "Request had insufficient authentication scopes." } },
      }),
    ).toMatchObject({
      sent: "no",
      fix: "reconnect",
    });
    expect(
      await failure({ status: 429, body: { error: { message: "User-rate limit exceeded." } } }),
    ).toMatchObject({
      sent: "no",
      fix: null,
    });
    const refused = await failure({
      status: 400,
      body: { error: { message: "Invalid To header" } },
    });
    expect(refused).toMatchObject({ sent: "no", fix: null });
    expect(refused.message).toBe("Gmail wouldn't send it: Invalid To header. Nothing was sent.");
  });

  it("says plainly when the Gmail API itself is switched off", async () => {
    const off = await failure({
      status: 403,
      body: {
        error: { message: "Gmail API has not been used in project 123 before or it is disabled." },
      },
    });
    expect(off.message).toMatch(/isn't switched on for this app yet/);
    expect(off).toMatchObject({ sent: "no", fix: null });
  });

  it("never puts the token or the message in an error", async () => {
    for (const reply of [
      new Error("fake-access leaked"),
      { status: 500 },
      { status: 400, body: {} },
    ] as Reply[]) {
      const err = await failure(reply);
      expect(err.message).not.toMatch(/fake-access|cmF3/);
      expect((err as { cause?: unknown }).cause).toBeUndefined();
    }
  });
});
