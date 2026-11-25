import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { TokenDeps } from "../../connections/tokens";
import { parseInboundEmail, processInboundEmail, type IngestResult } from "../inbound";
import { outgoingFrom, outboxDetails, outboxWords, sendPayloadSchema } from "../outbox";
import { buildOutboundRequest } from "../outbound";
import { richToText } from "../rich";
import { parseChannelSettings, type ChannelSettings } from "../social/channels";
import { socialPayloadSchema } from "../social/deliver";
import { OWNED_ELSEWHERE } from "../social/graph";
import { processMetaPayload, type FileResult, type IntakeDeps } from "../social/intake";
import type { ChannelFacts } from "../social/server";
import { sendQueuedSocial } from "../social/worker";
import { autoRepliesSchema, type AutoReplies } from "./config";
import {
  considerAutoReply,
  type AutoReplyDeps,
  type AutoReplyFactsRow,
  type AutoReplyInput,
} from "./worker";

/**
 * The automatic first reply, from a filed message to Meta's Send API.
 * Everything is made up: the ids, the token, and every answer "Meta" gives.
 * Nothing is ever sent to Meta or to the mail service from a test.
 */

const token = randomBytes(24).toString("hex");
const NOW = Date.parse("2026-11-25T15:00:00Z"); // Wednesday, 10:00 in New York
const PAGE = "1000000000000001";
const IG = "1784000000000002";
const PERSON = "9000000000000003";
const WORDS =
  "Hi {{first_name}}, thanks for writing to {{business_name}}. A person will answer soon.";
const SENT = "Hi Sam, thanks for writing to A Made Up Studio. A person will answer soon.";

const settings = (over: Record<string, unknown> = {}): AutoReplies =>
  autoRepliesSchema.parse({
    version: 1,
    instagram: { on: true, message: WORDS },
    facebook: { on: true, message: WORDS },
    email: { on: true, message: WORDS },
    ...over,
  });

const row = (over: Partial<AutoReplyFactsRow> = {}): AutoReplyFactsRow => ({
  channel: "instagram",
  ticket_id: "k1",
  ticket_kind: "message",
  shelf: null,
  direction: "inbound",
  message_kind: "reply",
  removed: false,
  received_at: new Date(NOW - 1000).toISOString(),
  contact_name: "Sam Example",
  reply_to_email: null,
  last_auto_reply_at: null,
  team_answered_since: false,
  business_name: "A Made Up Studio",
  time_zone: "America/New_York",
  ...over,
});

type Claim = Parameters<AutoReplyDeps["claim"]>[0];
function fakeDeps(
  over: {
    settings?: AutoReplies;
    facts?: AutoReplyFactsRow | null;
    takeControl?: boolean;
    open?: boolean;
    answer?: string;
    ownAddresses?: string[];
  } = {},
) {
  const claims: Claim[] = [];
  const asked: string[] = [];
  const deps: AutoReplyDeps = {
    now: () => NOW,
    mailDomain: "inbound.example.test",
    moduleOpen: async () => {
      asked.push("plan");
      return over.open ?? true;
    },
    settings: async () => ({
      autoReplies: over.settings ?? settings(),
      takeControl: over.takeControl ?? false,
      ownAddresses: over.ownAddresses ?? [],
    }),
    facts: async () => {
      asked.push("facts");
      return over.facts === undefined ? row() : over.facts;
    },
    claim: async (args) => {
      claims.push(args);
      return over.answer ?? "queued";
    },
  };
  return { deps, claims, asked };
}
const input: AutoReplyInput = { tenantId: "t1", messageId: "m1" };

describe("considerAutoReply", () => {
  it("queues the saved words, filled in, through the outbox's own payload", async () => {
    const db = fakeDeps();
    expect(await considerAutoReply(input, db.deps)).toBe("queued usual");
    expect(db.claims).toHaveLength(1);
    const claim = db.claims[0];
    expect(claim).toMatchObject({
      tenantId: "t1",
      messageId: "m1",
      variant: "usual",
      quietHours: 24,
    });
    // It is a payload the outbox already knows how to send.
    const payload = socialPayloadSchema.parse(claim.payload);
    expect(richToText(payload.doc)).toBe(SENT);
    expect(payload).toMatchObject({
      channel: "instagram",
      via: "message",
      then: "keep",
      files: [],
    });
    expect(payload.add_tags).toEqual([]);
    expect(payload.assign_to).toBeNull();
    expect(claim.summary).toMatchObject({ kind: "social", to: ["Sam Example"], preview: SENT });
  });

  it("reads nothing more when every channel is off", async () => {
    const db = fakeDeps({ settings: autoRepliesSchema.parse({ version: 1 }) });
    expect(await considerAutoReply(input, db.deps)).toBe("off");
    expect(db.asked).toEqual([]);
    expect(db.claims).toEqual([]);
  });

  it("takes no claim when the rules say no", async () => {
    const cases: [Parameters<typeof fakeDeps>[0], AutoReplyInput, string][] = [
      [{ facts: null }, input, "unknown"],
      [{ facts: row({ channel: "sms" }) }, input, "unknown"],
      [{ settings: settings({ instagram: { on: false } }) }, input, "off"],
      [{ open: false }, input, "plan"],
      [{ facts: row({ ticket_kind: "comment", message_kind: "comment" }) }, input, "not_a_message"],
      [{ facts: row({ message_kind: "reaction" }) }, input, "not_a_message"],
      [{ facts: row({ direction: "outbound" }) }, input, "not_a_message"],
      [{ facts: row({ shelf: "spam" }) }, input, "shelved"],
      [{ facts: row({ shelf: "trash" }) }, input, "shelved"],
      [{}, { ...input, standby: true }, "another_tool"],
      [{ facts: row({ team_answered_since: true }) }, input, "answered"],
      [
        { facts: row({ last_auto_reply_at: new Date(NOW - 3 * 3600_000).toISOString() }) },
        input,
        "quiet",
      ],
      [{ facts: row({ received_at: new Date(NOW - 2 * 3600_000).toISOString() }) }, input, "stale"],
      // Longer than one Instagram message can hold once the name is in.
      [
        { settings: settings({ instagram: { on: true, message: "é".repeat(600) } }) },
        input,
        "too_long",
      ],
    ];
    for (const [over, what, expected] of cases) {
      const db = fakeDeps(over);
      expect(await considerAutoReply(what, db.deps), expected).toBe(expected);
      expect(db.claims, expected).toEqual([]);
    }
  });

  it("answers a standby message only for a workspace that takes conversations over", async () => {
    const db = fakeDeps({ takeControl: true });
    expect(await considerAutoReply({ ...input, standby: true }, db.deps)).toBe("queued usual");
  });

  it("passes on what the database decided under its lock", async () => {
    for (const answer of ["duplicate", "quiet", "answered", "shelved", "not_a_message"]) {
      expect(await considerAutoReply(input, fakeDeps({ answer }).deps)).toBe(answer);
    }
    expect(await considerAutoReply(input, fakeDeps({ answer: "something new" }).deps)).toBe(
      "unknown",
    );
  });

  it("answers an email only to the person who wrote, marked as sent by a machine", async () => {
    const facts = row({ channel: "email", reply_to_email: "Sam@Example.test" });
    const mail = { automated: false, fromEmail: "sam@example.test" };
    const db = fakeDeps({ facts });
    expect(await considerAutoReply({ ...input, mail }, db.deps)).toBe("queued usual");
    // What the database adds when it takes the claim.
    const payload = sendPayloadSchema.parse({ ...db.claims[0].payload, automatic: true });
    expect(payload).toMatchObject({
      kind: "reply",
      to: ["sam@example.test"],
      cc: [],
      bcc: [],
      then: "keep",
      automatic: true,
    });
    const request = buildOutboundRequest(
      outgoingFrom(payload, {
        workspaceName: "A Made Up Studio",
        slug: "studio",
        domain: "inbound.example.test",
        replyKey: "abcdef0123456789",
        subject: "Where is my order?",
        inReplyTo: "<first@mail.test>",
      }),
    );
    expect(request.To).toBe("sam@example.test");
    expect(request.TextBody).toBe(SENT);
    expect(request).not.toHaveProperty("Cc");
    expect(request.Headers).toEqual([
      { Name: "In-Reply-To", Value: "<first@mail.test>" },
      { Name: "References", Value: "<first@mail.test>" },
      { Name: "Auto-Submitted", Value: "auto-replied" },
      { Name: "X-Auto-Response-Suppress", Value: "All" },
    ]);
    // A person's own reply carries no such mark.
    const own = buildOutboundRequest(
      outgoingFrom(sendPayloadSchema.parse({ ...db.claims[0].payload }), {
        workspaceName: "S",
        slug: "studio",
        domain: "inbound.example.test",
        replyKey: "abcdef0123456789",
        subject: "x",
        inReplyTo: null,
      }),
    );
    expect(own.Headers).toEqual([]);
  });

  it("never answers a machine's email, one of our own addresses, or one it knows nothing about", async () => {
    const facts = row({ channel: "email", reply_to_email: "sam@example.test" });
    const from = (fromEmail: string, automated = false) => ({
      ...input,
      mail: { automated, fromEmail },
    });
    const check = async (what: AutoReplyInput, over: Parameters<typeof fakeDeps>[0] = {}) => {
      const db = fakeDeps({ facts, ...over });
      const outcome = await considerAutoReply(what, db.deps);
      expect(db.claims).toEqual([]);
      return outcome;
    };
    expect(await check(from("sam@example.test", true))).toBe("automated");
    expect(await check(from("support-studio@inbound.example.test"))).toBe("own_address");
    expect(await check(from("hello@studio.test"), { ownAddresses: ["hello@studio.test"] })).toBe(
      "own_address",
    );
    // No word about its headers: treated as a machine's.
    expect(await check(input)).toBe("automated");
    expect(await check(from("not an address"))).toBe("no_address");
  });
});

describe("where the worker asks", () => {
  const where = { tenantId: "t1", pageId: PAGE, channel: "instagram" as const };
  const delivery = (messaging: unknown[], list: "messaging" | "standby" = "messaging") => ({
    object: "instagram",
    entry: [{ id: IG, time: NOW, [list]: messaging }],
  });
  const message = (mid: string, extra: Record<string, unknown> = {}) => ({
    sender: { id: PERSON },
    recipient: { id: IG },
    timestamp: NOW,
    message: { mid, text: "Hello", ...extra },
  });
  function intake(result: Partial<FileResult> = {}) {
    const asked: { mid: string; standby: boolean }[] = [];
    const deps: IntakeDeps = {
      now: () => NOW,
      ourAppId: "555",
      whereFor: async () => where,
      rulesFor: async () => ({ version: 1, rules: [] }),
      file: async () => ({ result: "created", ticket_id: "k1", message_id: "m1", ...result }),
      echo: async () => ({ result: "threaded", ticket_id: "k1", message_id: "m2" }),
      remove: async () => undefined,
      react: async () => undefined,
      autoReply: async (_where, event) => {
        asked.push({ mid: event.mid, standby: event.standby === true });
      },
    };
    return { deps, asked };
  }

  it("asks once for a message a person sent, and says when it came on standby", async () => {
    const one = intake();
    await processMetaPayload(delivery([message("mid-1")]), one.deps);
    expect(one.asked).toEqual([{ mid: "mid-1", standby: false }]);
    const two = intake();
    await processMetaPayload(delivery([message("mid-2")], "standby"), two.deps);
    expect(two.asked).toEqual([{ mid: "mid-2", standby: true }]);
    // A delivery seen before asks again: the database's claim is what makes it once.
    const again = intake({ result: "duplicate" });
    await processMetaPayload(delivery([message("mid-1")]), again.deps);
    expect(again.asked).toEqual([{ mid: "mid-1", standby: false }]);
  });

  it("never asks for an echo, a reaction, an unsend or a message that wasn't filed", async () => {
    const db = intake();
    await processMetaPayload(
      delivery([
        // Our own send heard back, and one sent from the Instagram app.
        {
          ...message("mid-e1", { is_echo: true, app_id: 555 }),
          sender: { id: IG },
          recipient: { id: PERSON },
        },
        { ...message("mid-e2", { is_echo: true }), sender: { id: IG }, recipient: { id: PERSON } },
        {
          sender: { id: PERSON },
          recipient: { id: IG },
          timestamp: NOW,
          reaction: { mid: "mid-1", action: "react", emoji: "❤" },
        },
        { ...message("mid-3", { is_deleted: true }) },
      ]),
      db.deps,
    );
    expect(db.asked).toEqual([]);
    const ignored = intake({ result: "ignored", message_id: undefined });
    await processMetaPayload(delivery([message("mid-4")]), ignored.deps);
    expect(ignored.asked).toEqual([]);
  });

  it("files the message whatever becomes of the automatic reply", async () => {
    const db = intake();
    db.deps.autoReply = async () => {
      throw new Error("the database is away");
    };
    expect(await processMetaPayload(delivery([message("mid-5")]), db.deps)).toEqual(["created"]);
  });

  it("asks for a filed email, with what its headers said", async () => {
    const asked: { noAutoReply: boolean; from: string; id?: string }[] = [];
    const filed: IngestResult = {
      result: "created",
      tenant_id: "t1",
      ticket_id: "k1",
      message_id: "m9",
    };
    const run = (headers: { Name: string; Value: string }[], from = "sam@example.test") =>
      processInboundEmail(
        {
          MessageID: `pm-${asked.length}`,
          FromFull: { Email: from, Name: "Sam Example" },
          ToFull: [{ Email: "support-studio@inbound.example.test" }],
          Subject: "Hello",
          TextBody: "Is this in stock?",
          Headers: headers,
        },
        "inbound.example.test",
        {
          rulesFor: async () => ({ version: 1, rules: [] }),
          ingest: async () => filed,
          autoReply: async (email, result) => {
            asked.push({
              noAutoReply: email.noAutoReply,
              from: email.fromEmail,
              id: result.message_id,
            });
          },
        },
      );
    await run([]);
    await run([{ Name: "Precedence", Value: "bulk" }]);
    await run([{ Name: "List-Unsubscribe", Value: "<mailto:off@news.test>" }]);
    await run([{ Name: "Auto-Submitted", Value: "auto-replied" }]);
    await run([], "no-reply@shop.test");
    expect(asked.map((a) => a.noAutoReply)).toEqual([false, true, true, true, true]);
    expect(asked[0]).toMatchObject({ from: "sam@example.test", id: "m9" });
    // The older, narrower flag (which also tags the conversation) is unchanged.
    const parse = (headers: { Name: string; Value: string }[]) =>
      parseInboundEmail(
        {
          MessageID: "pm",
          FromFull: { Email: "sam@example.test" },
          ToFull: [{ Email: "support-studio@inbound.example.test" }],
          Headers: headers,
        },
        "inbound.example.test",
      );
    expect(parse([{ Name: "Precedence", Value: "bulk" }])).toMatchObject({
      automated: false,
      noAutoReply: true,
    });
    expect(parse([{ Name: "Auto-Submitted", Value: "auto-generated" }])).toMatchObject({
      automated: true,
      noAutoReply: true,
    });
  });
});

describe("sending a queued automatic reply to Meta", () => {
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
  const notOwner = () =>
    new Response(
      JSON.stringify({
        error: {
          message: "(#100) The action is invalid since it's not the thread owner.",
          code: 100,
          error_subcode: 2534037,
        },
      }),
      { status: 400 },
    );
  const path = (call: Call) => new URL(call.url).pathname.replace(/^\/v[0-9.]+/, "");
  const tokenDeps: TokenDeps = {
    store: {
      read: async () => ({
        connectionId: "conn",
        externalAccountId: PAGE,
        status: "active",
        token: { access_token: token },
      }),
      lockRefresh: async () => false,
      save: async () => undefined,
      markNeedsReconnect: async () => undefined,
    },
    adapter: () => {
      throw new Error("not needed");
    },
    now: () => NOW,
    wait: async () => undefined,
  };
  const channelFacts = (over: Partial<ChannelSettings> = {}): ChannelFacts => ({
    settings: parseChannelSettings({ version: 1, instagram: true, ...over }),
    connection: {
      status: "active",
      scopes: [
        "pages_manage_metadata",
        "pages_messaging",
        "instagram_basic",
        "instagram_manage_messages",
      ],
      pageName: "A Made Up Page",
      instagramId: IG,
      instagramUsername: "a_made_up_shop",
    },
  });
  /** A stand-in for the database: one Instagram conversation, and what was written down. */
  function fakeAdmin(lastInboundAgoMs = 5000) {
    const finished: Record<string, unknown>[] = [];
    const notes: string[] = [];
    const admin = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name === "social_reply_context") {
          return {
            data: [
              {
                channel: "instagram",
                external_id: PERSON,
                label: "@a_made_up_person",
                last_inbound_at: new Date(NOW - lastInboundAgoMs).toISOString(),
              },
            ],
            error: null,
          };
        }
        if (name === "note_thread_control") {
          notes.push(String(args.p_state));
          return { data: true, error: null };
        }
        if (name === "finish_social_outbound") {
          finished.push(args);
          return { data: "message-1", error: null };
        }
        return { data: null, error: { message: `unexpected ${name}` } };
      },
      storage: { from: () => ({}) },
    } as unknown as SupabaseClient;
    return { admin, finished, notes };
  }
  /** The payload exactly as `considerAutoReply` builds it and the claim marks it. */
  async function queued() {
    const db = fakeDeps();
    await considerAutoReply(input, db.deps);
    return {
      id: "q1",
      tenant_id: "t1",
      ticket_id: "k1",
      payload: { ...db.claims[0].payload, automatic: true },
    };
  }
  const send = async (
    db: ReturnType<typeof fakeAdmin>,
    meta: ReturnType<typeof fakeMeta>,
    over: Partial<ChannelSettings> = {},
  ) =>
    sendQueuedSocial(db.admin, await queued(), tokenDeps, {
      fetchImpl: meta.impl,
      now: () => NOW,
      facts: async () => channelFacts(over),
    });

  it("asks Meta once, as an answer to the person's message, with exactly the saved words", async () => {
    const db = fakeAdmin();
    const meta = fakeMeta([ok({ recipient_id: PERSON, message_id: "out-1" })]);
    await send(db, meta);
    expect(meta.calls.map(path)).toEqual([`/${PAGE}/messages`]);
    const body = JSON.parse(String(meta.calls[0].init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      recipient: { id: PERSON },
      messaging_type: "RESPONSE",
      message: { text: SENT },
    });
    // Inside the 24 hours a message opens: no tag is ever needed, and none is sent.
    expect(body).not.toHaveProperty("tag");
    expect(db.finished).toEqual([
      { p_id: "q1", p_mids: ["out-1"], p_body: SENT, p_attachments: [], p_error: null },
    ]);
    expect(db.notes).toEqual(["ours"]);
  });

  it("writes a thread-owner refusal down once and never asks again", async () => {
    const db = fakeAdmin();
    const meta = fakeMeta([notOwner()]);
    await send(db, meta);
    expect(meta.calls.map(path)).toEqual([`/${PAGE}/messages`]);
    expect(db.finished).toHaveLength(1);
    const error = String(db.finished[0].p_error);
    expect(db.finished[0]).not.toHaveProperty("p_mids");
    expect(db.notes).toEqual(["other"]);
    // How the conversation says it: quietly, as the automatic reply, with Meta's words under Details.
    const notice = {
      state: "failed" as const,
      error,
      summary: { kind: "social", to: ["Sam Example"], automatic: true },
    };
    expect(outboxWords(notice)).toBe(
      `The automatic reply to Sam Example wasn't sent, and isn't tried again. ${OWNED_ELSEWHERE}`,
    );
    expect(outboxDetails(notice)).toContain("not the thread owner");
  });

  it("takes a conversation over only for a workspace that chose to, and then sends once", async () => {
    const db = fakeAdmin();
    const meta = fakeMeta([notOwner(), ok({ success: true }), ok({ message_id: "out-2" })]);
    await send(db, meta, { take_control: true });
    expect(meta.calls.map(path)).toEqual([
      `/${PAGE}/messages`,
      `/${PAGE}/take_thread_control`,
      `/${PAGE}/messages`,
    ]);
    expect(db.finished[0]).toMatchObject({ p_mids: ["out-2"], p_error: null });
  });

  it("doesn't ask Meta at all once the 24 hours have passed, or the channel is off", async () => {
    const late = fakeAdmin(25 * 3600_000);
    const meta = fakeMeta([]);
    await send(late, meta);
    expect(meta.calls).toEqual([]);
    expect(late.finished).toEqual([{ p_id: "q1", p_error: "window_closed" }]);
    const off = fakeAdmin();
    await send(off, meta, { instagram: false });
    expect(meta.calls).toEqual([]);
    expect(off.finished).toEqual([{ p_id: "q1", p_error: "not_connected" }]);
  });

  it("leaves no clear answer as 'we don't know', never sent again", async () => {
    const db = fakeAdmin();
    const meta = fakeMeta([new Error("socket hang up")]);
    await send(db, meta);
    expect(meta.calls).toHaveLength(1);
    // Left claimed: the database turns that into "unsure" and nothing resends it.
    expect(db.finished).toEqual([]);
    expect(
      outboxWords({
        state: "unsure",
        error: "never_finished",
        summary: { to: ["Sam"], automatic: true },
      }),
    ).toBe("We never heard whether the automatic reply to Sam went. It isn't sent again.");
  });
});
