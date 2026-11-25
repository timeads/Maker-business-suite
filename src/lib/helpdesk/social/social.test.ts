import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { planFiles, sniffType } from "../files";
import {
  DEFAULT_CHANNEL_SETTINGS,
  channelState,
  parseChannelSettings,
  personLabel,
  profileUrl,
  scopesAllow,
  socialFilesProblem,
  textFits,
  textSize,
  tidyHandle,
} from "./channels";
import { deliverSocial, socialPayloadSchema } from "./deliver";
import { eventTime, mediaWords, parseMetaPayload, payloadAccounts, socialSubject } from "./events";
import {
  MetaRefused,
  MetaUnsure,
  readProfile,
  refusalText,
  refusalWords,
  sendImages,
  sendText,
  subscribePage,
} from "./graph";
import { RetryLater, processMetaPayload, type FileResult, type IntakeDeps } from "./intake";
import { MediaRefused, fetchMessageMedia, fetchMetaFile, mediaName, metaFileUrl } from "./media";
import { parseSignedRequest, validMetaSignature, webhookChallenge } from "./signature";
import { lastInboundAt, replyWindow, windowWords } from "./window";

// Every secret here is made up on the spot. Nothing real is ever in a test.
const secret = () => randomBytes(24).toString("hex");
const sign = (body: string, key: string) =>
  `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;

const NOW = Date.parse("2026-11-25T15:00:00Z");
const PAGE = "1000000000000001";
const IG = "1784000000000002";
const PERSON = "9000000000000003";

const delivery = (object: "page" | "instagram", account: string, messaging: unknown[]) => ({
  object,
  entry: [{ id: account, time: NOW, messaging }],
});
const from = (extra: Record<string, unknown>, account = IG) => ({
  sender: { id: PERSON },
  recipient: { id: account },
  timestamp: NOW - 5000,
  ...extra,
});

describe("proof a request came from Meta", () => {
  it("accepts the signature of the exact bytes, and nothing else", () => {
    const key = secret();
    const body = JSON.stringify({ object: "page", entry: [] });
    expect(validMetaSignature(body, sign(body, key), key)).toBe(true);
    expect(
      validMetaSignature(
        Buffer.from(body),
        sign(body, key).toUpperCase().replace("SHA256", "sha256"),
        key,
      ),
    ).toBe(true);
    expect(validMetaSignature(`${body} `, sign(body, key), key)).toBe(false);
    expect(validMetaSignature(body, sign(body, secret()), key)).toBe(false);
    expect(validMetaSignature(body, sign(body, key).slice(0, -2), key)).toBe(false);
    expect(validMetaSignature(body, sign(body, key).replace("sha256=", "sha1="), key)).toBe(false);
    expect(validMetaSignature(body, null, key)).toBe(false);
    expect(validMetaSignature(body, sign(body, key), undefined)).toBe(false);
    expect(validMetaSignature(body, sign(body, key), "")).toBe(false);
  });

  it("signs what arrived: escaped characters stay escaped", () => {
    const key = secret();
    // Meta signs its own escaped form; re-encoding the parsed JSON would not match.
    const raw = '{"object":"page","entry":[{"id":"1","text":"\\u00e4\\u00f6"}]}';
    expect(validMetaSignature(raw, sign(raw, key), key)).toBe(true);
    expect(validMetaSignature(JSON.stringify(JSON.parse(raw)), sign(raw, key), key)).toBe(false);
  });

  it("answers the address check only with the right token", () => {
    const token = secret();
    const ask = (params: Record<string, string>) =>
      webhookChallenge(new URLSearchParams(params), token);
    expect(
      ask({ "hub.mode": "subscribe", "hub.verify_token": token, "hub.challenge": "1158201444" }),
    ).toBe("1158201444");
    expect(
      ask({ "hub.mode": "subscribe", "hub.verify_token": secret(), "hub.challenge": "1" }),
    ).toBeNull();
    expect(
      ask({ "hub.mode": "unsubscribe", "hub.verify_token": token, "hub.challenge": "1" }),
    ).toBeNull();
    expect(ask({ "hub.mode": "subscribe", "hub.verify_token": token })).toBeNull();
    expect(
      webhookChallenge(
        new URLSearchParams({
          "hub.mode": "subscribe",
          "hub.verify_token": "",
          "hub.challenge": "1",
        }),
        undefined,
      ),
    ).toBeNull();
  });

  it("reads a signed deletion request, and refuses a forged or mangled one", () => {
    const key = secret();
    const make = (data: unknown, withKey = key) => {
      const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
      const signature = createHmac("sha256", withKey).update(payload).digest("base64url");
      return `${signature}.${payload}`;
    };
    const good = { algorithm: "HMAC-SHA256", issued_at: 1, user_id: "218471" };
    expect(parseSignedRequest(make(good), key)).toEqual({ userId: "218471" });
    expect(parseSignedRequest(make(good, secret()), key)).toBeNull();
    expect(parseSignedRequest(make({ ...good, algorithm: "none" }), key)).toBeNull();
    expect(parseSignedRequest(make({ algorithm: "HMAC-SHA256" }), key)).toBeNull();
    expect(parseSignedRequest(`${make(good)}.extra`, key)).toBeNull();
    expect(parseSignedRequest("nonsense", key)).toBeNull();
    expect(parseSignedRequest(make(good), undefined)).toBeNull();
    expect(parseSignedRequest(42, key)).toBeNull();
  });
});

describe("reading a delivery", () => {
  it("reads a text message", () => {
    const events = parseMetaPayload(
      delivery("instagram", IG, [from({ message: { mid: "m1", text: "Hello there" } })]),
      NOW,
    );
    expect(events).toEqual([
      {
        type: "message",
        channel: "instagram",
        accountId: IG,
        personId: PERSON,
        at: new Date(NOW - 5000).toISOString(),
        mid: "m1",
        text: "Hello there",
        kind: "reply",
        media: [],
        summary: null,
      },
    ]);
    expect(socialSubject("instagram", "Hello there", null)).toBe("Instagram message: Hello there");
  });

  it("reads a picture, and names it in our own words", () => {
    const [event] = parseMetaPayload(
      delivery("page", PAGE, [
        from(
          {
            message: {
              mid: "m2",
              attachments: [
                { type: "image", payload: { url: "https://scontent.xx.fbcdn.net/v/a.jpg?x=1" } },
              ],
            },
          },
          PAGE,
        ),
      ]),
      NOW,
    );
    expect(event).toMatchObject({
      type: "message",
      channel: "facebook",
      text: "",
      kind: "reply",
      summary: "Sent a photo",
      media: [{ kind: "image", url: "https://scontent.xx.fbcdn.net/v/a.jpg?x=1" }],
    });
    expect(socialSubject("facebook", "", "Sent a photo")).toBe("Facebook message: Sent a photo");
  });

  it("reads a story reply, a share and a story mention without fetching anything for them", () => {
    const events = parseMetaPayload(
      delivery("instagram", IG, [
        from({
          message: {
            mid: "s1",
            text: "Love this one",
            reply_to: { story: { url: "https://lookaside.fbsbx.com/story", id: "777" } },
          },
        }),
        from({
          message: {
            mid: "s2",
            attachments: [{ type: "share", payload: { url: "https://lookaside.fbsbx.com/share" } }],
          },
        }),
        from({
          message: {
            mid: "s3",
            attachments: [
              { type: "story_mention", payload: { url: "https://lookaside.fbsbx.com/mention" } },
            ],
          },
        }),
      ]),
      NOW,
    );
    expect(
      events.map((e) => (e.type === "message" ? [e.kind, e.summary, e.media.length] : null)),
    ).toEqual([
      ["story_reply", "Replied to your story", 0],
      ["share", "Shared a post", 0],
      ["story_mention", "Mentioned you in their story", 0],
    ]);
  });

  it("reads a reaction and its undoing", () => {
    const events = parseMetaPayload(
      delivery("instagram", IG, [
        from({ reaction: { mid: "m1", action: "react", reaction: "love", emoji: "❤️" } }),
        from({ reaction: { mid: "m1", action: "unreact" } }),
      ]),
      NOW,
    );
    expect(events).toEqual([
      expect.objectContaining({ type: "reaction", mid: "m1", action: "react", emoji: "❤️" }),
      expect.objectContaining({ type: "reaction", mid: "m1", action: "unreact", emoji: null }),
    ]);
  });

  it("reads a message the customer took back", () => {
    const events = parseMetaPayload(
      delivery("instagram", IG, [from({ message: { mid: "m1", is_deleted: true } })]),
      NOW,
    );
    expect(events).toEqual([
      expect.objectContaining({ type: "removed", mid: "m1", personId: PERSON }),
    ]);
  });

  it("reads an echo as ours, about the person it was sent to", () => {
    const [event] = parseMetaPayload(
      delivery("page", PAGE, [
        {
          sender: { id: PAGE },
          recipient: { id: PERSON },
          timestamp: NOW,
          message: { mid: "e1", is_echo: true, app_id: 1517776481860111, text: "On its way" },
        },
      ]),
      NOW,
    );
    expect(event).toMatchObject({
      type: "echo",
      personId: PERSON,
      mid: "e1",
      text: "On its way",
      appId: "1517776481860111",
    });
  });

  it("leaves out reads, postbacks, our own messages and anything it doesn't know", () => {
    const events = parseMetaPayload(
      delivery("instagram", IG, [
        from({ read: { mid: "m1" } }),
        from({ postback: { mid: "p1", title: "Hi", payload: "x" } }),
        from({ message: { admin_text: "handed over" } }),
        {
          sender: { id: IG },
          recipient: { id: PERSON },
          timestamp: NOW,
          message: { mid: "x", text: "ours, no echo flag" },
        },
        { sender: {}, recipient: { id: IG }, message: { mid: "y", text: "no sender" } },
        "not an object",
      ]),
      NOW,
    );
    expect(events).toEqual([]);
    expect(parseMetaPayload({ object: "user", entry: [{ id: "1", messaging: [] }] }, NOW)).toEqual(
      [],
    );
    expect(parseMetaPayload(null, NOW)).toEqual([]);
    expect(parseMetaPayload({ object: "page", entry: "nope" }, NOW)).toEqual([]);
  });

  it("doesn't fetch a sticker twice while Meta sends it under two names, or a view-once photo at all", () => {
    const [sticker, vanishing] = parseMetaPayload(
      delivery("page", PAGE, [
        from(
          {
            message: {
              mid: "st",
              attachments: [
                {
                  type: "sticker",
                  payload: { url: "https://scontent.xx.fbcdn.net/s.png", sticker_id: 1 },
                },
                { type: "image", payload: { url: "https://scontent.xx.fbcdn.net/s.png" } },
              ],
            },
          },
          PAGE,
        ),
        from({ message: { mid: "ep", attachments: [{ type: "ephemeral" }] } }, PAGE),
      ]),
      NOW,
    );
    expect(sticker).toMatchObject({ media: [] });
    expect(vanishing).toMatchObject({
      media: [],
      summary: "Sent a photo that disappears, which can't be shown here",
    });
  });

  it("finds the accounts a delivery is about, and keeps ids as text", () => {
    expect(payloadAccounts(delivery("page", PAGE, []))).toEqual([PAGE]);
    expect(payloadAccounts({ entry: [{ id: 12345 }, { id: "12345" }, { id: { no: 1 } }] })).toEqual(
      ["12345"],
    );
  });

  it("takes Meta's time for when it was sent, but never a time still to come", () => {
    expect(eventTime(NOW - 1000, NOW)).toBe(new Date(NOW - 1000).toISOString());
    expect(eventTime(Math.floor(NOW / 1000) - 60, NOW)).toBe(
      new Date((Math.floor(NOW / 1000) - 60) * 1000).toISOString(),
    );
    expect(eventTime(NOW + 86_400_000, NOW)).toBe(new Date(NOW).toISOString());
    expect(eventTime("soon", NOW)).toBe(new Date(NOW).toISOString());
  });

  it("puts a few plain words on what isn't text", () => {
    expect(mediaWords(["image", "image", "image"], {})).toBe("Sent 3 photos");
    expect(mediaWords(["video"], {})).toBe("Sent a video");
    expect(mediaWords(["audio"], {})).toBe("Sent a voice message");
    expect(mediaWords(["image", "video"], {})).toBe("Sent 2 attachments");
    expect(mediaWords(["ig_reel"], {})).toBe("Shared a reel");
    expect(mediaWords([], { unsupported: true })).toBe("Sent something that can't be shown here");
    expect(mediaWords([], {})).toBeNull();
    const long = "x".repeat(200);
    expect(socialSubject("instagram", `\n\n${long}\nsecond line`, null)).toHaveLength(
      "Instagram message: ".length + 68,
    );
  });
});

describe("a delivery becomes conversations", () => {
  const rules = {
    version: 1 as const,
    rules: [{ id: "r", where: "any" as const, contains: "refund", tag: "refunds" }],
  };
  function deps(over: Partial<IntakeDeps> = {}) {
    const calls: string[] = [];
    const base: IntakeDeps = {
      now: () => NOW,
      ourAppId: "555",
      whereFor: async (channel, account) =>
        account === IG || account === PAGE ? { tenantId: "t1", pageId: PAGE, channel } : null,
      rulesFor: async () => rules as never,
      file: async (_where, event, subject, tags) => {
        calls.push(`file ${event.mid} "${subject}" [${tags.join(",")}]`);
        return {
          result: event.mid === "seen" ? "duplicate" : "created",
          ticket_id: "k1",
          message_id: "msg1",
          contact_id: "c1",
          number: 7,
          needs_profile: true,
        } satisfies FileResult;
      },
      echo: async (_where, event) => {
        calls.push(`echo ${event.mid}`);
        return { result: event.mid === "busy" ? "retry" : "threaded" };
      },
      remove: async (_where, mid) => void calls.push(`remove ${mid}`),
      react: async (_where, event, id) => void calls.push(`${event.action} ${id}`),
      refreshProfile: async () => {
        calls.push("profile");
        return "@made.up";
      },
      fetchFiles: async (event) => {
        calls.push(`fetch ${event.media.length}`);
        return [];
      },
      keepFiles: async () => void calls.push("keep"),
      onCreated: async (_where, _event, result, outcome, who) =>
        void calls.push(`created #${result.number} ${who} [${outcome.tags.join(",")}]`),
      ...over,
    };
    return { base, calls };
  }

  it("files a message, reads who it is from, applies the rules and keeps its files", async () => {
    const { base, calls } = deps();
    const outcomes = await processMetaPayload(
      delivery("instagram", IG, [
        from({
          message: {
            mid: "m1",
            text: "Can I get a refund?",
            attachments: [
              { type: "image", payload: { url: "https://scontent.cdninstagram.com/a.jpg" } },
            ],
          },
        }),
      ]),
      base,
    );
    expect(outcomes).toEqual(["created"]);
    expect(calls).toEqual([
      'file m1 "Instagram message: Can I get a refund?" [refunds]',
      "profile",
      "created #7 @made.up [refunds]",
      "fetch 1",
      "keep",
    ]);
  });

  it("drops what belongs to no workspace, and never alerts for a message seen before", async () => {
    const { base, calls } = deps();
    const outcomes = await processMetaPayload(
      {
        object: "instagram",
        entry: [
          {
            id: "someone-elses-account",
            messaging: [from({ message: { mid: "x", text: "hi" } }, "someone-elses-account")],
          },
          { id: IG, messaging: [from({ message: { mid: "seen", text: "hi again" } })] },
        ],
      },
      base,
    );
    expect(outcomes).toEqual(["dropped", "duplicate"]);
    expect(calls.some((c) => c.startsWith("created"))).toBe(false);
  });

  it("skips the echo of what the help desk sent, files one from the app, and waits when asked to", async () => {
    const echo = (mid: string, appId?: number) => ({
      sender: { id: PAGE },
      recipient: { id: PERSON },
      timestamp: NOW,
      message: { mid, is_echo: true, text: "Hi", ...(appId ? { app_id: appId } : {}) },
    });
    const { base, calls } = deps();
    expect(
      await processMetaPayload(
        delivery("page", PAGE, [echo("ours", 555), echo("theirs", 999)]),
        base,
      ),
    ).toEqual(["ours", "echo threaded"]);
    expect(calls).toEqual(["echo theirs"]);
    await expect(
      processMetaPayload(delivery("page", PAGE, [echo("busy")]), base),
    ).rejects.toBeInstanceOf(RetryLater);
  });

  it("passes on removals and reactions", async () => {
    const { base, calls } = deps();
    await processMetaPayload(
      delivery("instagram", IG, [
        from({ message: { mid: "gone", is_deleted: true } }),
        from({ reaction: { mid: "m1", action: "react", emoji: "+" } }),
      ]),
      base,
    );
    expect(calls).toEqual(["remove gone", `react react:${PERSON}:m1`]);
  });
});

describe("the 24-hour reply window", () => {
  const at = (iso: string) => Date.parse(iso);
  it("is open for 24 hours after the customer's last message, less a minute's margin", () => {
    const last = "2026-11-24T15:00:00Z";
    expect(replyWindow(last, at("2026-11-25T14:58:59Z")).open).toBe(true);
    expect(replyWindow(last, at("2026-11-25T14:59:01Z")).open).toBe(false);
    expect(replyWindow(last, at("2026-11-25T15:00:01Z"))).toEqual({
      open: false,
      closesAt: "2026-11-25T15:00:00.000Z",
      needsHumanAgentTag: false,
    });
    expect(replyWindow(null, NOW)).toEqual({
      open: false,
      closesAt: null,
      needsHumanAgentTag: false,
    });
    expect(replyWindow("not a date", NOW).open).toBe(false);
  });

  it("is elapsed time: the clocks changing makes no difference", () => {
    // New York springs forward on 8 March 2026 (a 23-hour day) and falls back on 1 November (25 hours).
    const spring = "2026-03-07T20:00:00-05:00";
    expect(replyWindow(spring, at("2026-03-08T20:30:00-04:00")).open).toBe(true); // 23h30m on
    expect(replyWindow(spring, at("2026-03-08T21:00:00-04:00")).open).toBe(false); // 24h on
    const autumn = "2026-10-31T20:00:00-04:00";
    expect(replyWindow(autumn, at("2026-11-01T18:30:00-05:00")).open).toBe(true); // 23h30m on
    expect(replyWindow(autumn, at("2026-11-01T19:00:00-05:00")).open).toBe(false); // 24h on, though the clock says 23
  });

  it("runs from the newest thing the customer did, by Meta's time when there is one", () => {
    expect(
      lastInboundAt([
        {
          direction: "inbound",
          sent_at: "2026-11-24T10:00:00Z",
          created_at: "2026-11-24T10:05:00Z",
        },
        { direction: "outbound", sent_at: null, created_at: "2026-11-25T09:00:00Z" },
        { direction: "inbound", sent_at: null, created_at: "2026-11-24T12:00:00Z" },
      ]),
    ).toBe("2026-11-24T12:00:00Z");
    expect(
      lastInboundAt([{ direction: "outbound", created_at: "2026-11-24T12:00:00Z" }]),
    ).toBeNull();
  });

  it("stretches to seven days only where the workspace says its app has Human Agent", () => {
    const last = "2026-11-20T15:00:00Z";
    expect(replyWindow(last, NOW).open).toBe(false);
    expect(replyWindow(last, NOW, { humanAgent: true })).toMatchObject({
      open: true,
      needsHumanAgentTag: true,
      closesAt: "2026-11-27T15:00:00.000Z",
    });
    expect(replyWindow("2026-11-25T10:00:00Z", NOW, { humanAgent: true }).needsHumanAgentTag).toBe(
      false,
    );
    expect(replyWindow("2026-11-10T15:00:00Z", NOW, { humanAgent: true }).open).toBe(false);
  });

  it("explains itself", () => {
    const format = () => "Tue 3:00 PM";
    expect(windowWords("instagram", replyWindow("2026-11-25T10:00:00Z", NOW), format)).toBe(
      "You can reply until Tue 3:00 PM.",
    );
    expect(windowWords("instagram", replyWindow("2026-11-20T15:00:00Z", NOW), format)).toContain(
      "Instagram only allows replies within 24 hours of the customer's last message",
    );
    expect(windowWords("facebook", replyWindow(null, NOW), format)).toContain("Facebook only lets");
  });
});

describe("files come from Meta's hosts only", () => {
  it("knows Meta's file hosts, over https, by name", () => {
    for (const ok of [
      "https://scontent.xx.fbcdn.net/v/t1/a.jpg?oh=1",
      "https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&signature=x",
      "https://scontent-lga3-1.cdninstagram.com/v/a.mp4",
      "https://fbcdn.net/x",
    ]) {
      expect(metaFileUrl(ok), ok).not.toBeNull();
    }
    for (const bad of [
      "http://scontent.xx.fbcdn.net/a.jpg",
      "https://example.com/a.jpg",
      "https://fbcdn.net.example.com/a.jpg",
      "https://notfbcdn.net/a.jpg",
      "https://user:pass@scontent.xx.fbcdn.net/a.jpg",
      "https://scontent.xx.fbcdn.net:8443/a.jpg",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/a.jpg",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "//scontent.xx.fbcdn.net/a.jpg",
      "",
      null,
      42,
    ]) {
      expect(metaFileUrl(bad), String(bad)).toBeNull();
    }
  });

  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const answer = (bytes: Uint8Array, headers: Record<string, string> = {}) =>
    new Response(Buffer.from(bytes), {
      status: 200,
      headers: { "content-type": "image/jpeg", ...headers },
    });

  it("downloads from a Meta host without cookies or a referrer", async () => {
    const seen: [string, RequestInit][] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push([url, init]);
      return answer(jpeg);
    }) as unknown as typeof fetch;
    const got = await fetchMetaFile("https://scontent.xx.fbcdn.net/a.jpg", fake);
    expect([...got.bytes]).toEqual([...jpeg]);
    expect(got.type).toBe("image/jpeg");
    expect(seen[0][1]).toMatchObject({
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    expect(seen[0][1].headers).toBeUndefined();
  });

  it("refuses an address on any other host without asking it anything", async () => {
    let asked = 0;
    const fake = (async () => {
      asked += 1;
      return answer(jpeg);
    }) as unknown as typeof fetch;
    await expect(fetchMetaFile("https://files.example.com/a.jpg", fake)).rejects.toMatchObject({
      reason: "host",
    });
    await expect(fetchMetaFile("http://169.254.169.254/x", fake)).rejects.toBeInstanceOf(
      MediaRefused,
    );
    expect(asked).toBe(0);
  });

  it("follows a redirect to another Meta host, and refuses one that leads anywhere else", async () => {
    const hops: string[] = [];
    const fake = (to: string) =>
      (async (url: string) => {
        hops.push(url);
        return url.includes("first")
          ? new Response(null, { status: 302, headers: { location: to } })
          : answer(jpeg);
      }) as unknown as typeof fetch;
    await fetchMetaFile(
      "https://lookaside.fbsbx.com/first",
      fake("https://scontent.xx.fbcdn.net/final.jpg"),
    );
    expect(hops).toEqual([
      "https://lookaside.fbsbx.com/first",
      "https://scontent.xx.fbcdn.net/final.jpg",
    ]);
    hops.length = 0;
    await expect(
      fetchMetaFile(
        "https://lookaside.fbsbx.com/first",
        fake("https://internal.example.com/secret"),
      ),
    ).rejects.toMatchObject({ reason: "host" });
    expect(hops).toEqual(["https://lookaside.fbsbx.com/first"]);
  });

  it("stops at the size we keep, whatever the header claims", async () => {
    const big = (async () => answer(new Uint8Array(40))) as unknown as typeof fetch;
    await expect(
      fetchMetaFile("https://scontent.xx.fbcdn.net/a.jpg", big, 16),
    ).rejects.toMatchObject({
      reason: "too_big",
    });
    const claims = (async () =>
      answer(new Uint8Array(4), { "content-length": "99999999" })) as unknown as typeof fetch;
    await expect(
      fetchMetaFile("https://scontent.xx.fbcdn.net/a.jpg", claims, 16),
    ).rejects.toMatchObject({
      reason: "too_big",
    });
    const gone = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    await expect(fetchMetaFile("https://scontent.xx.fbcdn.net/a.jpg", gone)).rejects.toMatchObject({
      reason: "status",
    });
  });

  it("hands fetched files to the usual keeping rules, and lists one it couldn't fetch as not kept", async () => {
    const fake = (async (url: string) =>
      url.includes("good")
        ? answer(jpeg)
        : new Response("no", { status: 403 })) as unknown as typeof fetch;
    const files = await fetchMessageMedia(
      [
        { kind: "image", url: "https://scontent.xx.fbcdn.net/good.jpg" },
        { kind: "video", url: "https://scontent.xx.fbcdn.net/expired.mp4" },
        { kind: "image", url: "https://evil.example.com/good.jpg" },
      ],
      fake,
    );
    expect(files.map((f) => f.name)).toEqual(["photo.jpg", "video-2", "photo-3"]);
    const plan = planFiles(files, 0);
    expect(plan.map((p) => (p.keep ? p.type : p.reason))).toEqual([
      "image/jpeg",
      "failed",
      "failed",
    ]);
    // A claimed type is never believed: these bytes aren't a picture.
    const lying = (async () =>
      answer(new TextEncoder().encode("<html>hi</html>"))) as unknown as typeof fetch;
    const [fake1] = planFiles(
      await fetchMessageMedia([{ kind: "image", url: "https://scontent.xx.fbcdn.net/x" }], lying),
      0,
    );
    expect(fake1).toMatchObject({ keep: false, reason: "type" });
    // Trouble on the way is passed up so the delivery is tried again.
    const down = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    await expect(
      fetchMessageMedia([{ kind: "image", url: "https://scontent.xx.fbcdn.net/x" }], down),
    ).rejects.toThrow("socket hang up");
    expect(mediaName("audio", "audio/mp4", 0)).toBe("voice-message.m4a");
  });

  it("knows a voice message by its own first bytes", () => {
    const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
    const m4a = new Uint8Array([0, 0, 0, 0x20, ...ascii("ftypM4A "), 0, 0, 0, 0]);
    expect(sniffType(m4a)).toBe("audio/mp4");
    expect(sniffType(new Uint8Array([...ascii("OggS"), 0, 2, 0, 0]))).toBe("audio/ogg");
    expect(sniffType(new Uint8Array([...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WAVE")]))).toBe(
      "audio/wav",
    );
    expect(sniffType(new Uint8Array([...ascii("ID3"), 4, 0, 0]))).toBe("audio/mpeg");
    expect(sniffType(new Uint8Array([0xff, 0xf1, 0x50, 0x80]))).toBe("audio/aac");
    // A picture is still a picture, and a name alone proves nothing.
    expect(sniffType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(
      sniffType(new TextEncoder().encode("MZ fake program"), {
        name: "voice.m4a",
        type: "audio/mp4",
      }),
    ).toBeNull();
  });
});

describe("what a message can hold", () => {
  it("counts Instagram in bytes and Facebook in characters", () => {
    expect(textSize("instagram", "héllo")).toBe(6);
    expect(textSize("facebook", "héllo")).toBe(5);
    expect(textFits("instagram", "a".repeat(1000))).toBe(true);
    expect(textFits("instagram", "a".repeat(1001))).toBe(false);
    expect(textFits("instagram", "é".repeat(501))).toBe(false);
    expect(textFits("facebook", "é".repeat(2000))).toBe(true);
    expect(textFits("facebook", "é".repeat(2001))).toBe(false);
    // An emoji is one character, however it is stored.
    expect(textSize("facebook", "👍👍")).toBe(2);
  });

  it("takes a few JPEG or PNG pictures and nothing else", () => {
    const pic = (name: string, type = "image/jpeg", size = 1000) => ({ name, type, size });
    expect(socialFilesProblem([pic("a.jpg"), pic("b.png", "image/png")])).toBeNull();
    expect(socialFilesProblem([pic("a.jpg"), pic("b.jpg"), pic("c.jpg"), pic("d.jpg")])).toContain(
      "up to 3",
    );
    expect(socialFilesProblem([pic("doc.pdf", "application/pdf")])).toContain("JPEG or PNG");
    expect(socialFilesProblem([pic("huge.jpg", "image/jpeg", 9 * 1024 * 1024)])).toContain("8 MB");
  });

  it("only believes a username that looks like one", () => {
    expect(tidyHandle("@made.up_person")).toBe("made.up_person");
    expect(tidyHandle("bad/../handle")).toBeNull();
    expect(tidyHandle("has space")).toBeNull();
    expect(profileUrl("instagram", "made.up_person")).toBe(
      "https://www.instagram.com/made.up_person/",
    );
    expect(profileUrl("instagram", "x/../../evil")).toBeNull();
    expect(profileUrl("facebook", "made.up_person")).toBeNull();
    expect(personLabel("instagram", { handle: "made.up", name: "Made Up" })).toBe("@made.up");
    expect(personLabel("facebook", { name: null })).toBe("Facebook user");
    expect(personLabel("email", { name: null, email: "a@b.test" })).toBe("a@b.test");
  });
});

describe("where a channel stands", () => {
  const POSTING = [
    "pages_show_list",
    "pages_read_engagement",
    "pages_manage_posts",
    "instagram_basic",
  ];
  const ALL = [...POSTING, "pages_messaging", "pages_manage_metadata", "instagram_manage_messages"];
  const connection = (scopes: string[], over: Record<string, unknown> = {}) => ({
    status: "active",
    scopes,
    pageName: "A Page",
    instagramId: "1",
    instagramUsername: "a_made_up_shop",
    ...over,
  });

  it("needs the messaging permissions Facebook really granted", () => {
    expect(scopesAllow("facebook", POSTING)).toBe(false);
    expect(scopesAllow("instagram", POSTING)).toBe(false);
    expect(scopesAllow("facebook", ALL)).toBe(true);
    expect(scopesAllow("instagram", ALL)).toBe(true);
    expect(
      scopesAllow(
        "instagram",
        ALL.filter((s) => s !== "instagram_manage_messages"),
      ),
    ).toBe(false);
    expect(scopesAllow("facebook", null)).toBe(false);
  });

  it("is off until switched on, and blocked when the connection can't carry it", () => {
    const on = { ...DEFAULT_CHANNEL_SETTINGS, instagram: true, facebook: true };
    expect(channelState("instagram", DEFAULT_CHANNEL_SETTINGS, connection(ALL)).state).toBe("off");
    expect(channelState("instagram", on, connection(ALL)).state).toBe("on");
    expect(channelState("instagram", on, null).state).toBe("blocked");
    expect(channelState("instagram", on, connection(POSTING)).state).toBe("blocked");
    expect(channelState("facebook", on, connection(ALL, { status: "needs_reconnect" })).state).toBe(
      "blocked",
    );
    expect(channelState("instagram", on, connection(ALL, { instagramId: null })).state).toBe(
      "blocked",
    );
    expect(channelState("facebook", on, connection(ALL, { instagramId: null })).state).toBe("on");
    expect(parseChannelSettings({ version: 1, instagram: "yes" })).toEqual(
      DEFAULT_CHANNEL_SETTINGS,
    );
    expect(parseChannelSettings({ version: 1, instagram: true })).toEqual({
      ...DEFAULT_CHANNEL_SETTINGS,
      instagram: true,
    });
  });
});

describe("sending through Meta", () => {
  const token = secret();
  const target = { pageId: PAGE, token, recipientId: PERSON };
  type Call = { url: string; init: RequestInit };
  const fakeMeta = (answers: (Response | Error)[]) => {
    const calls: Call[] = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const next = answers.shift();
      if (!next || next instanceof Error) throw next ?? new Error("no answer set");
      return next;
    }) as unknown as typeof fetch;
    return { impl, calls };
  };
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const no = (code: number, subcode: number | undefined, message: string, status = 400) =>
    new Response(JSON.stringify({ error: { message, code, error_subcode: subcode } }), { status });

  it("sends words as a reply, with the token in the header and never in the address", async () => {
    const { impl, calls } = fakeMeta([ok({ recipient_id: PERSON, message_id: "out-1" })]);
    expect(await sendText(target, "On its way", impl)).toBe("out-1");
    expect(calls[0].url).toMatch(
      new RegExp(`^https://graph\\.facebook\\.com/v[0-9.]+/${PAGE}/messages$`),
    );
    expect(calls[0].url).not.toContain(token);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      recipient: { id: PERSON },
      messaging_type: "RESPONSE",
      message: { text: "On its way" },
    });
  });

  it("uses the Human Agent tag only when told to", async () => {
    const { impl, calls } = fakeMeta([ok({ message_id: "out-2" })]);
    await sendText({ ...target, humanAgent: true }, "Sorry for the wait", impl);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      messaging_type: "MESSAGE_TAG",
      tag: "HUMAN_AGENT",
    });
  });

  it("sends one picture or several by their links", async () => {
    const { impl, calls } = fakeMeta([ok({ message_id: "p1" }), ok({ message_id: "p2" })]);
    await sendImages(target, ["https://files.test/a"], impl);
    await sendImages(target, ["https://files.test/a", "https://files.test/b"], impl);
    expect(JSON.parse(String(calls[0].init.body)).message).toEqual({
      attachment: { type: "image", payload: { url: "https://files.test/a" } },
    });
    expect(JSON.parse(String(calls[1].init.body)).message.attachments).toHaveLength(2);
  });

  it("tells a refusal from no clear answer", async () => {
    const refused = fakeMeta([no(10, 2018278, "This message is sent outside of allowed window.")]);
    const err = await sendText(target, "Hi", refused.impl).catch((e) => e);
    expect(err).toBeInstanceOf(MetaRefused);
    expect(err).toMatchObject({ code: 10, subcode: 2018278 });
    expect(String(err.message)).not.toContain(token);

    await expect(
      sendText(target, "Hi", fakeMeta([new Error("timeout")]).impl),
    ).rejects.toBeInstanceOf(MetaUnsure);
    await expect(
      sendText(
        target,
        "Hi",
        fakeMeta([new Response("<html>bad gateway</html>", { status: 502 })]).impl,
      ),
    ).rejects.toBeInstanceOf(MetaUnsure);
    // Answered, but without an id for the message: we can't say it went.
    await expect(
      sendText(target, "Hi", fakeMeta([ok({ recipient_id: PERSON })]).impl),
    ).rejects.toBeInstanceOf(MetaUnsure);
  });

  it("writes a refusal down by Meta's numbers and sentence, and says it plainly", () => {
    const stored = refusalText(
      new MetaRefused(400, 10, 2018278, "This message is sent outside of allowed window."),
    );
    expect(stored).toBe("meta:10:2018278:none:This message is sent outside of allowed window.");
    expect(refusalWords(stored)).toContain("more than 24 hours");
    expect(refusalWords("meta:190:x:none:Invalid OAuth access token.")).toContain("Reconnect");
    expect(refusalWords("meta:551:1545041:none:This person isn't available right now.")).toContain(
      "can't receive messages",
    );
    expect(
      refusalWords("meta:613:x:none:Calls to this api have exceeded the rate limit."),
    ).toContain("limiting");
    expect(refusalWords("meta:100:2018008:partial:Failed to fetch the file from the url.")).toMatch(
      /^Your words were sent, but the pictures weren't\. .*Meta said: “Failed to fetch the file from the url\.”$/,
    );
    expect(refusalWords("meta:200:2534041:none:disabled")).toContain("Connected tools");
    expect(refusalWords("window_closed")).toContain("24 hours");
    expect(refusalWords(null)).toContain("Meta didn't take it");
  });

  it("reads a name and handle, never a picture, and takes silence for an answer", async () => {
    const { impl, calls } = fakeMeta([
      ok({ name: "Made Up Person", username: "made.up_person", id: PERSON }),
      ok({ first_name: "Made", last_name: "Up" }),
      no(100, 33, "Unsupported get request."),
      ok({ username: "../../evil" }),
    ]);
    expect(await readProfile("instagram", token, PERSON, impl)).toEqual({
      name: "Made Up Person",
      handle: "made.up_person",
    });
    expect(calls[0].url).toContain("fields=name%2Cusername");
    expect(calls[0].url).not.toContain("profile_pic");
    expect(await readProfile("facebook", token, PERSON, impl)).toEqual({
      name: "Made Up",
      handle: null,
    });
    expect(await readProfile("facebook", token, PERSON, impl)).toEqual({
      name: null,
      handle: null,
    });
    expect(await readProfile("instagram", token, PERSON, impl)).toEqual({
      name: null,
      handle: null,
    });
  });

  it("asks a Page to send its messages our way", async () => {
    const { impl, calls } = fakeMeta([ok({ success: true })]);
    await subscribePage(PAGE, token, impl);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].url).toContain(
      `/${PAGE}/subscribed_apps?subscribed_fields=messages%2Cmessage_echoes%2Cmessage_reactions`,
    );
  });

  describe("a whole reply", () => {
    const stagedDeps = () => {
      const log: string[] = [];
      return {
        log,
        deps: (impl: typeof fetch) => ({
          fetchImpl: impl,
          stage: async (file: { name: string }) => {
            log.push(`stage ${file.name}`);
            return `https://files.test/${file.name}`;
          },
          unstage: async () => void log.push("unstage"),
        }),
      };
    };
    const photo = { name: "a.jpg", type: "image/jpeg", base64: "" };

    it("sends the words, then the pictures, and clears the staged files", async () => {
      const { impl, calls } = fakeMeta([ok({ message_id: "w" }), ok({ message_id: "p" })]);
      const { log, deps } = stagedDeps();
      expect(await deliverSocial(target, "instagram", "Here you go", [photo], deps(impl))).toEqual({
        mids: ["w", "p"],
        problem: null,
      });
      expect(calls).toHaveLength(2);
      expect(log).toEqual(["stage a.jpg", "unstage"]);
    });

    it("says so when the words went and the pictures didn't", async () => {
      const { impl } = fakeMeta([
        ok({ message_id: "w" }),
        no(100, 2018008, "Failed to fetch the file from the url."),
      ]);
      const { log, deps } = stagedDeps();
      const went = await deliverSocial(target, "facebook", "Here you go", [photo], deps(impl));
      expect(went.mids).toEqual(["w"]);
      expect(went.problem).toBe("meta:100:2018008:partial:Failed to fetch the file from the url.");
      expect(log.at(-1)).toBe("unstage");
    });

    it("throws when nothing went, and never sends words that are too long", async () => {
      const refused = fakeMeta([no(10, 2018278, "outside of allowed window")]);
      await expect(
        deliverSocial(target, "instagram", "Hi", [], stagedDeps().deps(refused.impl)),
      ).rejects.toBeInstanceOf(MetaRefused);
      const untouched = fakeMeta([]);
      await expect(
        deliverSocial(target, "instagram", "a".repeat(1001), [], stagedDeps().deps(untouched.impl)),
      ).rejects.toBeInstanceOf(MetaRefused);
      expect(untouched.calls).toHaveLength(0);
      // Pictures alone: a refusal means nothing went at all.
      const pictures = fakeMeta([no(100, 2018047, "Upload attachment failure.")]);
      const { log, deps } = stagedDeps();
      await expect(
        deliverSocial(target, "instagram", "", [photo], deps(pictures.impl)),
      ).rejects.toBeInstanceOf(MetaRefused);
      expect(log.at(-1)).toBe("unstage");
    });

    it("reads a queued reply's shape, and refuses one that isn't", () => {
      const good = {
        kind: "social",
        channel: "instagram",
        doc: [{ t: "p", runs: [{ text: "Hi" }] }],
        then: "pending",
      };
      expect(socialPayloadSchema.safeParse(good).success).toBe(true);
      expect(socialPayloadSchema.safeParse({ ...good, channel: "email" }).success).toBe(false);
      expect(socialPayloadSchema.safeParse({ ...good, kind: "reply" }).success).toBe(false);
    });
  });
});
